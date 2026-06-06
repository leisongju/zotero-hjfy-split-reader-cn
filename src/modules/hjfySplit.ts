import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { SplitViewFactory } from "./splitView";

interface ResolvedSelection {
  parentItem: Zotero.Item;
  sourcePDF: Zotero.Item;
}

interface ResolvedTranslationTarget {
  parentItem: Zotero.Item;
  sourcePDF?: Zotero.Item;
}

interface BatchJob {
  index: number;
  total: number;
  title: string;
  selection: ResolvedTranslationTarget;
  lineIndex: number;
}

type BatchJobStatus =
  | "downloaded"
  | "source-downloaded"
  | "existing"
  | "skipped"
  | "failed";

interface BatchJobResult {
  status: BatchJobStatus;
  title: string;
  message?: string;
}

interface BatchState {
  total: number;
  started: number;
  running: number;
  completed: number;
  downloaded: number;
  sourceDownloaded: number;
  existing: number;
  skipped: number;
  failed: number;
}

interface SourcePDFFallbackResult {
  status: "downloaded" | "existing" | "failed";
  attachment: Zotero.Item | null;
  message: string;
}

interface HJFYArxivInfo {
  hasSrc: boolean;
}

interface HJFYArxivStatus {
  status: "finished" | "failed" | "error" | "fault" | "start";
  info?: string;
}

interface HJFYFileInfo {
  id: string;
  title: string;
  origin: string;
  zhCN?: string;
  zhCNTar?: string;
  isDeepSeek: boolean;
}

interface ResolvedArxivID {
  id: string;
  source: "metadata" | "attachment" | "doi-search" | "title-search";
  title?: string;
}

interface ArxivSearchResult {
  id: string;
  title: string;
  url: string;
}

interface ArxivTitleSearchCacheEntry {
  expiresAt: number;
  result: ArxivSearchResult | null;
}

interface OpenAlexWork {
  title?: string;
  display_name?: string;
  doi?: string;
  ids?: Record<string, string | undefined>;
  primary_location?: OpenAlexLocation | null;
  best_oa_location?: OpenAlexLocation | null;
  locations?: OpenAlexLocation[];
  open_access?: {
    oa_url?: string | null;
  };
}

interface OpenAlexLocation {
  id?: string | null;
  landing_page_url?: string | null;
  pdf_url?: string | null;
}

type ProgressReporter = (
  text: string,
  progress?: number,
  type?: "default" | "warning" | "error" | "success",
) => void;

interface AutoTranslateAttemptRecord {
  key: string;
  attemptedAt: number;
}

class HJFYLoginRequiredError extends Error {
  constructor(public readonly arxivId: string) {
    super("幻觉翻译要求登录后才能为这篇论文创建翻译任务");
  }
}

class HJFYNoLatexSourceError extends Error {
  constructor(public readonly sourcePDFResult: SourcePDFFallbackResult) {
    super(
      `这篇论文没有可用的 LaTeX 源码，hjfy.top 不能直接生成翻译 PDF；${sourcePDFResult.message}`,
    );
  }
}

export class HJFYSplitFactory {
  private static readonly menuID = "zotero-itemmenu-hjfy-split-reader";
  private static readonly batchMenuID =
    "zotero-itemmenu-hjfy-batch-translation";
  private static readonly batchMaxConcurrency = 10;
  private static readonly batchStartIntervalMS = 5000;
  private static readonly batchTitleMaxLength = 72;
  private static readonly autoTranslateSettleDelayMS = 30000;
  private static readonly autoTranslateAttemptHistoryLimit = 10000;
  private static readonly requestUserAgent =
    "zotero-hjfy-split-reader-cn (Zotero Plugin; +https://github.com/leisongju/zotero-hjfy-split-reader-cn)";
  private static readonly autoTranslatePendingParentIDs = new Set<number>();
  private static readonly autoTranslateQueuedParentIDs = new Set<number>();
  private static readonly autoTranslateQueue: number[] = [];
  private static autoTranslateFlushTimer:
    | ReturnType<typeof setTimeout>
    | undefined;
  private static autoTranslateNotifierID: string | undefined;
  private static autoTranslateActiveCount = 0;
  private static autoTranslateNextStartAt = 0;
  private static readonly titleSearchCache = new Map<
    string,
    ArxivTitleSearchCacheEntry
  >();
  private static readonly titleSearchCacheMS = 10 * 60 * 1000;

  static registerItemMenu() {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) return;

    const appendMenuItem = (
      id: string,
      label: string,
      image: string,
      listener: () => Promise<void>,
    ) => {
      if (doc.getElementById(id)) return;

      const elem = ztoolkit.UI.appendElement(
        {
          tag: "menuitem",
          id,
          namespace: "xul",
          attributes: {
            label,
            image,
          },
          classList: ["menuitem-iconic"],
          listeners: [
            {
              type: "command",
              listener: () => {
                void listener();
              },
            },
          ],
        },
        itemMenu,
      ) as XULElement;

      (elem as any).style.setProperty("-moz-context-properties", "fill");
      (elem as any).style.setProperty("fill", "currentColor");
    };

    appendMenuItem(
      this.menuID,
      getString("hjfy-menu-label"),
      `chrome://${addon.data.config.addonRef}/content/icons/svreader.svg`,
      () => this.handleMenuCommand(),
    );
    appendMenuItem(
      this.batchMenuID,
      getString("hjfy-batch-menu-label"),
      `chrome://${addon.data.config.addonRef}/content/icons/sync_24dp.svg`,
      () => this.handleBatchMenuCommand(),
    );
  }

  static registerAutoTranslateNotifier() {
    if (!this.isAutoTranslateEnabled()) return;
    if (this.autoTranslateNotifierID) return;

    const callback = {
      notify: async (
        event: _ZoteroTypes.Notifier.Event,
        type: _ZoteroTypes.Notifier.Type,
        ids: number[] | string[],
      ) => {
        if (!addon?.data.alive) {
          this.unregisterAutoTranslateNotifier();
          return;
        }
        if (event !== "add") return;
        if (type !== "item") return;

        await this.handleAutoTranslateItemEvents(ids);
      },
    };

    this.autoTranslateNotifierID = Zotero.Notifier.registerObserver(
      callback,
      ["item"],
      `${addon.data.config.addonID}-auto-translate`,
    );
  }

  static unregisterAll() {
    this.unregisterAutoTranslateNotifier();
    this.clearAutoTranslateQueue();
  }

  static handleAutoTranslatePreferenceChange(enabled: boolean) {
    if (enabled) {
      this.registerAutoTranslateNotifier();
      return;
    }

    this.unregisterAutoTranslateNotifier();
    this.clearAutoTranslateQueue();
  }

  private static unregisterAutoTranslateNotifier() {
    if (!this.autoTranslateNotifierID) return;
    Zotero.Notifier.unregisterObserver(this.autoTranslateNotifierID);
    this.autoTranslateNotifierID = undefined;
  }

  private static async handleMenuCommand() {
    const items = ztoolkit.getGlobal("ZoteroPane").getSelectedItems();
    if (items.length !== 1) {
      this.showMessage("请选择单篇论文或其 PDF 附件后再执行此操作", "warning");
      return;
    }

    const popup = new ztoolkit.ProgressWindow(getString("hjfy-window-title"), {
      closeOnClick: true,
      closeTime: -1,
    });
    popup.createLine({
      text: `正在处理: ${items[0].getDisplayTitle()}`,
      type: "default",
      progress: 10,
    });
    popup.show();

    try {
      const report: ProgressReporter = (
        text,
        progress = 35,
        type = "default",
      ) => {
        popup.createLine({ text, type, progress });
      };
      const { parentItem, sourcePDF } =
        await this.resolveSelectionWithSourceFallback(items[0], report);
      let translatedPDF = this.findExistingTranslation(parentItem, sourcePDF);

      if (translatedPDF) {
        popup.createLine({
          text: "已找到已有的幻觉翻译附件，准备分屏打开",
          type: "success",
          progress: 40,
        });
      } else {
        report("未找到现成翻译，正在向 hjfy.top 查询", 35);
        translatedPDF = await this.fetchAndAttachTranslation(
          parentItem,
          report,
        );
        popup.createLine({
          text: "已保存新的幻觉翻译附件",
          type: "success",
          progress: 75,
        });
      }

      popup.createLine({
        text: "正在打开分屏阅读器",
        type: "default",
        progress: 90,
      });
      await SplitViewFactory.openItemsInSplitView(sourcePDF, translatedPDF, {
        primarySide: "right",
        activeSide: "right",
      });
      popup.createLine({
        text: "已在分屏阅读器中打开原文与幻觉翻译",
        type: "success",
        progress: 100,
      });
      popup.startCloseTimer(4000);
    } catch (error) {
      if (error instanceof HJFYLoginRequiredError) {
        Zotero.launchURL(
          `https://hjfy.top/arxiv/${this.encodeArxivIdForPath(error.arxivId)}`,
        );
      }
      const message =
        error instanceof Error ? error.message : "未知错误，未能获取幻觉翻译";
      popup.createLine({
        text: `失败: ${message}`,
        type: "error",
        progress: 100,
      });
      popup.startCloseTimer(7000);
    }
  }

  private static async handleBatchMenuCommand() {
    const items = ztoolkit.getGlobal("ZoteroPane").getSelectedItems();
    if (!items.length) {
      this.showMessage("请选择需要获取中文翻译 PDF 的论文条目", "warning");
      return;
    }

    const popup = new ztoolkit.ProgressWindow(getString("hjfy-window-title"), {
      closeOnClick: true,
      closeTime: -1,
    });
    const { jobs, precheckedResults } = this.prepareBatchJobs(items);
    const state: BatchState = {
      total: jobs.length + precheckedResults.length,
      started: 0,
      running: 0,
      completed: 0,
      downloaded: 0,
      sourceDownloaded: 0,
      existing: 0,
      skipped: 0,
      failed: 0,
    };

    for (const result of precheckedResults) {
      this.applyBatchResult(state, result);
      state.completed += 1;
    }

    popup.createLine({
      text: this.formatBatchSummary(state),
      type: "default",
      progress: this.getBatchSummaryProgress(state),
    });

    for (const result of precheckedResults) {
      popup.createLine({
        text: this.formatBatchResultLine(result),
        type: this.getBatchResultLineType(result.status),
        progress: 100,
      });
    }

    jobs.forEach((job, index) => {
      job.lineIndex = precheckedResults.length + index + 1;
      popup.createLine({
        text: `[${job.index}/${job.total}] 等待: ${this.truncateTitle(
          job.title,
        )}`,
        type: "default",
        progress: 0,
      });
    });
    popup.show();

    if (!jobs.length) {
      this.updateBatchSummaryLine(popup, state);
      popup.startCloseTimer(state.failed ? 8000 : 5000);
      return;
    }

    await this.runBatchJobs(jobs, async (job) => {
      state.started += 1;
      state.running += 1;
      this.updateBatchSummaryLine(popup, state);
      const result = await this.processBatchJob(job, popup);
      this.applyBatchResult(state, result);
      state.running = Math.max(0, state.running - 1);
      state.completed += 1;
      this.updateBatchSummaryLine(popup, state);
      return result;
    });

    popup.createLine({
      text:
        state.failed > 0
          ? "批量获取已结束，部分论文未能保存译文 PDF"
          : "批量获取已完成",
      type: state.failed > 0 ? "warning" : "success",
      progress: 100,
    });
    popup.startCloseTimer(state.failed ? 10000 : 6000);
  }

  private static prepareBatchJobs(items: Zotero.Item[]) {
    const jobs: BatchJob[] = [];
    const precheckedResults: BatchJobResult[] = [];
    const seenParentIDs = new Set<number>();

    for (const item of items) {
      const fallbackTitle = this.getItemDisplayTitle(item);
      try {
        const selection = this.resolveTranslationTarget(item);
        const parentID = selection.parentItem.id;
        const title = this.getItemDisplayTitle(selection.parentItem);

        if (seenParentIDs.has(parentID)) {
          precheckedResults.push({
            status: "skipped",
            title,
            message: "同一论文已经在本次批量任务中",
          });
          continue;
        }

        seenParentIDs.add(parentID);
        const existing = this.findExistingTranslation(
          selection.parentItem,
          selection.sourcePDF,
        );
        if (existing) {
          precheckedResults.push({
            status: "existing",
            title,
            message: "已存在本地译文附件",
          });
          continue;
        }

        jobs.push({
          index: jobs.length + 1,
          total: 0,
          title,
          selection,
          lineIndex: -1,
        });
      } catch (error) {
        precheckedResults.push({
          status: "failed",
          title: fallbackTitle,
          message: this.getErrorMessage(error),
        });
      }
    }

    for (const job of jobs) {
      job.total = jobs.length;
    }

    return { jobs, precheckedResults };
  }

  private static async runBatchJobs(
    jobs: BatchJob[],
    worker: (job: BatchJob) => Promise<BatchJobResult>,
  ) {
    const results = new Array<BatchJobResult>(jobs.length);
    let nextIndex = 0;
    let nextStartAt = Date.now();

    const claimNextJob = async () => {
      if (nextIndex >= jobs.length) {
        return null;
      }

      const index = nextIndex++;
      const now = Date.now();
      const startAt = Math.max(now, nextStartAt);
      nextStartAt = startAt + this.batchStartIntervalMS;
      const waitMS = startAt - now;
      if (waitMS > 0) {
        await Zotero.Promise.delay(waitMS);
      }

      return { index, job: jobs[index] };
    };

    await Promise.all(
      Array.from(
        { length: Math.min(this.batchMaxConcurrency, jobs.length) },
        async () => {
          while (true) {
            const claimed = await claimNextJob();
            if (!claimed) return;
            results[claimed.index] = await worker(claimed.job);
          }
        },
      ),
    );

    return results;
  }

  private static async processBatchJob(
    job: BatchJob,
    popup: InstanceType<ZToolkit["ProgressWindow"]>,
  ): Promise<BatchJobResult> {
    this.changeBatchJobLine(popup, job, "正在检查本地译文附件", 8);

    try {
      const { parentItem } = job.selection;
      const sourcePDF =
        job.selection.sourcePDF ||
        (await this.ensureArxivSourcePDFByResolvingID(
          parentItem,
          (text, progress = 35, type = "default") => {
            this.changeBatchJobLine(popup, job, text, progress, type);
          },
        )) ||
        undefined;
      const existing = this.findExistingTranslation(parentItem, sourcePDF);
      if (existing) {
        this.changeBatchJobLine(
          popup,
          job,
          "已存在本地幻觉翻译附件，跳过下载",
          100,
          "success",
        );
        return {
          status: "existing",
          title: job.title,
          message: "已存在本地译文附件",
        };
      }

      const report: ProgressReporter = (
        text,
        progress = 35,
        type = "default",
      ) => {
        this.changeBatchJobLine(popup, job, text, progress, type);
      };

      await this.fetchAndAttachTranslation(parentItem, report);
      this.changeBatchJobLine(
        popup,
        job,
        "已下载并保存中文译文 PDF",
        100,
        "success",
      );
      return {
        status: "downloaded",
        title: job.title,
        message: "已保存中文译文 PDF",
      };
    } catch (error) {
      if (
        error instanceof HJFYNoLatexSourceError &&
        error.sourcePDFResult.status !== "failed"
      ) {
        this.changeBatchJobLine(popup, job, error.message, 100, "warning");
        return {
          status: "source-downloaded",
          title: job.title,
          message: error.sourcePDFResult.message,
        };
      }

      const message =
        error instanceof HJFYLoginRequiredError
          ? `${error.message}，请先在 hjfy.top 登录或手动创建任务`
          : this.getErrorMessage(error);
      this.changeBatchJobLine(popup, job, `失败: ${message}`, 100, "error");
      ztoolkit.log("HJFY batch translation failed", job.title, error);
      return {
        status: "failed",
        title: job.title,
        message,
      };
    }
  }

  private static applyBatchResult(state: BatchState, result: BatchJobResult) {
    switch (result.status) {
      case "downloaded":
        state.downloaded += 1;
        break;
      case "source-downloaded":
        state.sourceDownloaded += 1;
        break;
      case "existing":
        state.existing += 1;
        break;
      case "skipped":
        state.skipped += 1;
        break;
      case "failed":
        state.failed += 1;
        break;
    }
  }

  private static updateBatchSummaryLine(
    popup: InstanceType<ZToolkit["ProgressWindow"]>,
    state: BatchState,
  ) {
    popup.changeLine({
      idx: 0,
      text: this.formatBatchSummary(state),
      type: state.failed ? "warning" : "default",
      progress: this.getBatchSummaryProgress(state),
    });
  }

  private static formatBatchSummary(state: BatchState) {
    return (
      `批量获取: 完成 ${state.completed}/${state.total}` +
      `，运行 ${state.running}` +
      `，新下载 ${state.downloaded}` +
      `，原文 ${state.sourceDownloaded}` +
      `，已存在 ${state.existing}` +
      `，跳过 ${state.skipped}` +
      `，失败 ${state.failed}` +
      `；最多 ${this.batchMaxConcurrency} 并行，启动间隔 ${Math.round(
        this.batchStartIntervalMS / 1000,
      )} 秒`
    );
  }

  private static getBatchSummaryProgress(state: BatchState) {
    if (!state.total) return 100;
    return Math.round((state.completed / state.total) * 100);
  }

  private static changeBatchJobLine(
    popup: InstanceType<ZToolkit["ProgressWindow"]>,
    job: BatchJob,
    text: string,
    progress: number,
    type: "default" | "warning" | "error" | "success" = "default",
  ) {
    popup.changeLine({
      idx: job.lineIndex,
      text: `[${job.index}/${job.total}] ${this.truncateTitle(
        job.title,
      )}: ${text}`,
      type,
      progress,
    });
  }

  private static formatBatchResultLine(result: BatchJobResult) {
    const prefix =
      result.status === "skipped"
        ? "跳过"
        : result.status === "failed"
          ? "失败"
          : result.status === "source-downloaded"
            ? "已存原文"
            : result.status === "existing"
              ? "已存在"
              : "已下载";
    const message = result.message ? ` - ${result.message}` : "";
    return `${prefix}: ${this.truncateTitle(result.title)}${message}`;
  }

  private static getBatchResultLineType(status: BatchJobStatus) {
    if (status === "downloaded" || status === "existing") {
      return "success";
    }
    if (status === "source-downloaded") {
      return "warning";
    }
    if (status === "skipped") {
      return "warning";
    }
    return "error";
  }

  private static truncateTitle(title: string) {
    const trimmed = title.replace(/\s+/g, " ").trim();
    if (trimmed.length <= this.batchTitleMaxLength) return trimmed;
    return `${trimmed.slice(0, this.batchTitleMaxLength - 3)}...`;
  }

  private static getItemDisplayTitle(item: Zotero.Item) {
    return (
      String(item.getDisplayTitle?.() || item.getField("title") || "").trim() ||
      "未命名条目"
    );
  }

  private static getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : "未知错误";
  }

  private static async handleAutoTranslateItemEvents(
    ids: Array<number | string>,
  ) {
    if (!this.isAutoTranslateEnabled()) return;

    for (const id of ids) {
      const itemID = typeof id === "number" ? id : Number(id);
      if (!Number.isFinite(itemID)) continue;

      const item = Zotero.Items.get(itemID);
      if (!item) continue;

      if (this.isAutoTranslateCandidateItem(item)) {
        this.queueAutoTranslateParent(item.id);
        continue;
      }

      if (
        item.isFileAttachment() &&
        item.attachmentContentType === "application/pdf" &&
        item.parentItemID &&
        !this.isTranslationAttachment(item)
      ) {
        this.queueAutoTranslateParent(item.parentItemID);
      }
    }
  }

  private static isAutoTranslateEnabled() {
    return Boolean(getPref("autoFetchOnNewItems"));
  }

  private static isAutoTranslateCandidateItem(item: Zotero.Item) {
    return item.isRegularItem() && !(item as any).isFeedItem;
  }

  private static queueAutoTranslateParent(parentItemID: number) {
    if (!this.isAutoTranslateEnabled()) return;
    if (this.autoTranslatePendingParentIDs.has(parentItemID)) return;
    if (this.autoTranslateQueuedParentIDs.has(parentItemID)) return;

    this.autoTranslatePendingParentIDs.add(parentItemID);
    this.scheduleAutoTranslateFlush();
  }

  private static scheduleAutoTranslateFlush() {
    if (this.autoTranslateFlushTimer) {
      clearTimeout(this.autoTranslateFlushTimer);
    }

    this.autoTranslateFlushTimer = setTimeout(() => {
      this.autoTranslateFlushTimer = undefined;
      this.flushAutoTranslatePendingItems();
    }, this.autoTranslateSettleDelayMS);
  }

  private static flushAutoTranslatePendingItems() {
    if (!this.isAutoTranslateEnabled()) {
      this.clearAutoTranslateQueue();
      return;
    }

    const parentItemIDs = Array.from(this.autoTranslatePendingParentIDs);
    this.autoTranslatePendingParentIDs.clear();

    for (const parentItemID of parentItemIDs) {
      if (this.autoTranslateQueuedParentIDs.has(parentItemID)) continue;
      this.autoTranslateQueuedParentIDs.add(parentItemID);
      this.autoTranslateQueue.push(parentItemID);
    }

    this.pumpAutoTranslateQueue();
  }

  private static pumpAutoTranslateQueue() {
    if (!this.isAutoTranslateEnabled()) {
      this.clearAutoTranslateQueue();
      return;
    }

    while (
      this.autoTranslateActiveCount < this.batchMaxConcurrency &&
      this.autoTranslateQueue.length
    ) {
      const parentItemID = this.autoTranslateQueue.shift();
      if (!parentItemID) continue;

      const now = Date.now();
      const startAt = Math.max(now, this.autoTranslateNextStartAt);
      this.autoTranslateNextStartAt = startAt + this.batchStartIntervalMS;
      this.autoTranslateActiveCount += 1;

      void this.runAutoTranslateJob(parentItemID, Math.max(0, startAt - now));
    }
  }

  private static async runAutoTranslateJob(
    parentItemID: number,
    delayMS: number,
  ) {
    try {
      if (delayMS > 0) {
        await Zotero.Promise.delay(delayMS);
      }
      await this.processAutoTranslateParent(parentItemID);
    } finally {
      this.autoTranslateQueuedParentIDs.delete(parentItemID);
      this.autoTranslateActiveCount = Math.max(
        0,
        this.autoTranslateActiveCount - 1,
      );
      this.pumpAutoTranslateQueue();
    }
  }

  private static async processAutoTranslateParent(parentItemID: number) {
    if (!this.isAutoTranslateEnabled()) return;

    const parentItem = Zotero.Items.get(parentItemID);
    if (!parentItem || !this.isAutoTranslateCandidateItem(parentItem)) return;
    if (this.hasAutoTranslateAttempted(parentItem)) return;

    const sourcePDF = this.findSourcePDF(parentItem);
    if (!sourcePDF) {
      ztoolkit.log(
        "Auto HJFY translation waits for Zotero source PDF attachment",
        parentItemID,
      );
      return;
    }

    const title = this.getItemDisplayTitle(parentItem);
    const existing = this.findExistingTranslation(parentItem, sourcePDF);
    if (existing) {
      this.markAutoTranslateAttempted(parentItem);
      ztoolkit.log("Auto HJFY translation skipped; translation exists", title);
      return;
    }

    const report: ProgressReporter = (
      text,
      progress = 35,
      type = "default",
    ) => {
      ztoolkit.log("Auto HJFY translation", {
        title,
        text,
        progress,
        type,
      });
    };

    this.markAutoTranslateAttempted(parentItem);
    try {
      await this.fetchAndAttachTranslation(parentItem, report);
      ztoolkit.log("Auto HJFY translation saved", title);
    } catch (error) {
      ztoolkit.log("Auto HJFY translation failed", title, error);
    }
  }

  private static hasAutoTranslateAttempted(item: Zotero.Item) {
    const itemKey = this.getAutoTranslateAttemptKey(item);
    return this.getAutoTranslateAttemptRecords().some(
      (record) => record.key === itemKey,
    );
  }

  private static markAutoTranslateAttempted(item: Zotero.Item) {
    const itemKey = this.getAutoTranslateAttemptKey(item);
    const records = this.getAutoTranslateAttemptRecords().filter(
      (record) => record.key !== itemKey,
    );
    records.push({
      key: itemKey,
      attemptedAt: Date.now(),
    });

    const trimmedRecords = records.slice(
      -this.autoTranslateAttemptHistoryLimit,
    );
    setPref("autoTranslateAttemptedKeys", JSON.stringify(trimmedRecords));
  }

  private static getAutoTranslateAttemptKey(item: Zotero.Item) {
    return `${item.libraryID}:${item.key}`;
  }

  private static getAutoTranslateAttemptRecords(): AutoTranslateAttemptRecord[] {
    try {
      const records = JSON.parse(
        String(getPref("autoTranslateAttemptedKeys") || "[]"),
      ) as AutoTranslateAttemptRecord[];
      return Array.isArray(records)
        ? records.filter(
            (record) =>
              typeof record?.key === "string" &&
              typeof record?.attemptedAt === "number",
          )
        : [];
    } catch {
      return [];
    }
  }

  private static clearAutoTranslateQueue() {
    if (this.autoTranslateFlushTimer) {
      clearTimeout(this.autoTranslateFlushTimer);
      this.autoTranslateFlushTimer = undefined;
    }
    this.autoTranslatePendingParentIDs.clear();
    this.autoTranslateQueuedParentIDs.clear();
    this.autoTranslateQueue.length = 0;
    this.autoTranslateActiveCount = 0;
  }

  private static resolveSelection(item: Zotero.Item): ResolvedSelection {
    if (item.isRegularItem()) {
      const sourcePDF = this.findSourcePDF(item);
      if (!sourcePDF) {
        throw new Error("该条目下没有可用于分屏的原始 PDF 附件");
      }
      return { parentItem: item, sourcePDF };
    }

    if (
      item.isFileAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      if (!item.parentItemID) {
        throw new Error("暂不支持独立 PDF 条目，请先选中文章主条目");
      }
      const parentItem = Zotero.Items.get(item.parentItemID);
      if (!parentItem) {
        throw new Error("无法找到这篇论文的父条目");
      }

      if (this.isTranslationAttachment(item)) {
        const sourcePDF = this.findSourcePDF(parentItem, item);
        if (!sourcePDF) {
          throw new Error("找到了幻觉翻译附件，但没有找到对应的原始 PDF");
        }
        return { parentItem, sourcePDF };
      }

      return { parentItem, sourcePDF: item };
    }

    throw new Error("请选择论文主条目，或选择其下的 PDF 附件");
  }

  private static resolveTranslationTarget(
    item: Zotero.Item,
  ): ResolvedTranslationTarget {
    if (item.isRegularItem()) {
      return {
        parentItem: item,
        sourcePDF: this.findSourcePDF(item) || undefined,
      };
    }

    if (
      item.isFileAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      if (!item.parentItemID) {
        throw new Error("暂不支持独立 PDF 条目，请先选中文章主条目");
      }
      const parentItem = Zotero.Items.get(item.parentItemID);
      if (!parentItem) {
        throw new Error("无法找到这篇论文的父条目");
      }

      if (this.isTranslationAttachment(item)) {
        return {
          parentItem,
          sourcePDF: this.findSourcePDF(parentItem, item) || undefined,
        };
      }

      return { parentItem, sourcePDF: item };
    }

    throw new Error("请选择论文主条目，或选择其下的 PDF 附件");
  }

  private static async resolveSelectionWithSourceFallback(
    item: Zotero.Item,
    report: ProgressReporter,
  ): Promise<ResolvedSelection> {
    const target = this.resolveTranslationTarget(item);
    if (target.sourcePDF) {
      return {
        parentItem: target.parentItem,
        sourcePDF: target.sourcePDF,
      };
    }

    const sourcePDF = await this.ensureArxivSourcePDFByResolvingID(
      target.parentItem,
      report,
    );
    if (!sourcePDF) {
      throw new Error("该条目下没有可用于分屏的原始 PDF 附件");
    }

    return {
      parentItem: target.parentItem,
      sourcePDF,
    };
  }

  private static findSourcePDF(
    parentItem: Zotero.Item,
    excludedAttachment?: Zotero.Item,
  ) {
    const pdfs = this.getPDFAttachments(parentItem);
    return (
      pdfs.find(
        (attachment) =>
          attachment.id !== excludedAttachment?.id &&
          !this.isTranslationAttachment(attachment),
      ) || pdfs.find((attachment) => attachment.id !== excludedAttachment?.id)
    );
  }

  private static getPDFAttachments(parentItem: Zotero.Item) {
    return parentItem
      .getAttachments()
      .map((attachmentID) => Zotero.Items.get(attachmentID))
      .filter(
        (attachment): attachment is Zotero.Item =>
          !!attachment &&
          attachment.isFileAttachment() &&
          attachment.attachmentContentType === "application/pdf",
      );
  }

  private static isTranslationAttachment(attachment: Zotero.Item) {
    const title = String(attachment.getField("title") || "").toLowerCase();
    const filename = String(
      (attachment as any).attachmentFilename || "",
    ).toLowerCase();
    return (
      title.includes("幻觉翻译") ||
      title.includes("hjfy") ||
      filename.includes("_hjfy_") ||
      filename.includes("-hjfy-")
    );
  }

  private static findExistingTranslation(
    parentItem: Zotero.Item,
    sourcePDF?: Zotero.Item,
  ) {
    const arxivId = this.extractArxivId(parentItem);
    const sourceKey = sourcePDF
      ? String(sourcePDF.getField("title") || "").trim()
      : "";
    const candidates = this.getPDFAttachments(parentItem).filter(
      (attachment) => attachment.id !== sourcePDF?.id,
    );

    return candidates.find((attachment) => {
      if (!this.isTranslationAttachment(attachment)) return false;
      if (arxivId) {
        const filename = String(
          (attachment as any).attachmentFilename || "",
        ).toLowerCase();
        if (filename.includes(arxivId.toLowerCase())) {
          return true;
        }
      }
      const title = String(attachment.getField("title") || "");
      return sourceKey ? title.includes(sourceKey) : true;
    });
  }

  private static async fetchAndAttachTranslation(
    parentItem: Zotero.Item,
    report: ProgressReporter,
  ) {
    const resolvedArxiv = await this.resolveArxivId(parentItem, report);
    if (!resolvedArxiv) {
      throw new Error(
        "未能从条目元数据、附件或标题搜索中确认 arXiv ID；如果这篇论文没有发布在 arXiv，HJFY 的 arXiv 通道无法直接翻译",
      );
    }
    const arxivId = resolvedArxiv.id;
    await this.persistArxivMetadata(parentItem, resolvedArxiv, report);

    let arxivInfo: HJFYArxivInfo | null = null;
    try {
      arxivInfo = await this.withTimeout(
        this.fetchArxivInfo(arxivId),
        15000,
        "fetchArxivInfo",
      );
    } catch (error) {
      ztoolkit.log(
        "fetchArxivInfo failed; continuing with HJFY status/files",
        error,
      );
      report("arxivInfo 无响应，继续查询译文文件和任务状态", 42, "warning");
    }
    if (arxivInfo && !arxivInfo.hasSrc) {
      const sourcePDFResult = await this.ensureArxivSourcePDF(
        parentItem,
        arxivId,
        report,
      );
      throw new HJFYNoLatexSourceError(sourcePDFResult);
    }

    report("正在查询是否已有 HJFY 译文文件", 45);
    const existing = await this.tryFetchArxivFileInfo(arxivId);
    if (existing?.zhCN) {
      report("已找到 HJFY 译文文件，正在下载", 58);
      return this.savePdfAsAttachment(
        parentItem,
        await this.downloadBinary(existing.zhCN),
        arxivId,
      );
    }

    report("未找到已完成译文，正在刷新 HJFY 翻译任务", 50);
    await this.primeArxivTask(arxivId);
    await this.waitForTranslation(arxivId, report);

    report("翻译任务完成，正在读取文件信息", 68);
    const fileInfo = await this.fetchArxivFileInfo(arxivId);
    if (!fileInfo.zhCN) {
      throw new Error("幻觉翻译任务已完成，但没有拿到可下载的中文 PDF");
    }

    report("正在下载 HJFY 中文 PDF", 72);
    const pdfBuffer = await this.downloadBinary(fileInfo.zhCN);
    return this.savePdfAsAttachment(parentItem, pdfBuffer, arxivId);
  }

  private static async ensureArxivSourcePDFByResolvingID(
    parentItem: Zotero.Item,
    report: ProgressReporter,
  ) {
    const existing = this.findSourcePDF(parentItem);
    if (existing) return existing;

    const resolvedArxiv = await this.resolveArxivId(parentItem, report);
    if (!resolvedArxiv) {
      report("未能确认 arXiv ID，无法自动下载原文 PDF", 36, "warning");
      return null;
    }

    await this.persistArxivMetadata(parentItem, resolvedArxiv, report);
    const result = await this.ensureArxivSourcePDF(
      parentItem,
      resolvedArxiv.id,
      report,
    );
    return result.attachment;
  }

  private static async ensureArxivSourcePDF(
    parentItem: Zotero.Item,
    arxivId: string,
    report: ProgressReporter,
  ): Promise<SourcePDFFallbackResult> {
    const existing = this.findSourcePDF(parentItem);
    if (existing) {
      return {
        status: "existing",
        attachment: existing,
        message: "本地已有原文 PDF 附件",
      };
    }

    try {
      report(`正在从 arXiv 下载原文 PDF: ${arxivId}`, 44, "warning");
      const pdfBuffer = await this.downloadArxivPDF(arxivId);
      const attachment = await this.saveArxivSourcePdfAsAttachment(
        parentItem,
        pdfBuffer,
        arxivId,
      );
      report("已保存 arXiv 原文 PDF 附件", 48, "success");
      return {
        status: "downloaded",
        attachment,
        message: "已保存 arXiv 原文 PDF 附件",
      };
    } catch (error) {
      const message = `未能下载 arXiv 原文 PDF: ${this.getErrorMessage(error)}`;
      report(message, 48, "warning");
      return {
        status: "failed",
        attachment: null,
        message,
      };
    }
  }

  private static extractArxivId(item: Zotero.Item) {
    return this.extractArxivIdFromStrings([
      item.getField("DOI") as string,
      item.getField("url") as string,
      item.getField("extra") as string,
    ]);
  }

  private static extractArxivIdFromAttachments(parentItem: Zotero.Item) {
    const rawCandidates = [
      ...this.getPDFAttachments(parentItem).flatMap((attachment) => [
        attachment.getField("title") as string,
        attachment.getField("url") as string,
        (attachment as any).attachmentFilename as string,
      ]),
    ]
      .filter(Boolean)
      .map((value) => value.trim());

    return this.extractArxivIdFromStrings(rawCandidates);
  }

  private static extractArxivIdFromStrings(rawCandidates: string[]) {
    const arxivIDPattern =
      "((?:\\d{4}\\.\\d{4,5})|(?:[a-z-]+(?:\\.[a-z]+)?/\\d{7}))";
    for (const candidate of rawCandidates) {
      const doiMatch = candidate.match(
        new RegExp(`10\\.48550/arxiv\\.${arxivIDPattern}(v\\d+)?`, "i"),
      );
      if (doiMatch) {
        return this.normalizeArxivId(doiMatch[1]);
      }

      const arxivTextMatch = candidate.match(
        new RegExp(`\\barxiv(?:\\s+id)?[:\\s]+${arxivIDPattern}(v\\d+)?`, "i"),
      );
      if (arxivTextMatch) {
        return this.normalizeArxivId(arxivTextMatch[1]);
      }

      const urlMatch = candidate.match(
        new RegExp(
          `arxiv\\.org/(?:abs|pdf)/${arxivIDPattern}(v\\d+)?(?:\\.pdf)?(?:[?#].*)?$`,
          "i",
        ),
      );
      if (urlMatch) {
        return this.normalizeArxivId(urlMatch[1]);
      }
    }

    return null;
  }

  private static async resolveArxivId(
    parentItem: Zotero.Item,
    report: ProgressReporter,
  ): Promise<ResolvedArxivID | null> {
    const metadataId = this.extractArxivId(parentItem);
    if (metadataId) {
      report(`已从 Zotero 元数据识别 arXiv ID: ${metadataId}`, 38);
      return { id: metadataId, source: "metadata" };
    }

    const attachmentId = this.extractArxivIdFromAttachments(parentItem);
    if (attachmentId) {
      report(`已从附件信息识别 arXiv ID: ${attachmentId}`, 38);
      return { id: attachmentId, source: "attachment" };
    }

    const doi = this.normalizeDOI(String(parentItem.getField("DOI") || ""));
    if (doi) {
      report("正在根据 DOI 查询是否有关联 arXiv 版本", 38);
      const doiMatch = await this.trySearchOpenAlexByDOI(
        doi,
        parentItem.getDisplayTitle().trim(),
        report,
      );
      if (doiMatch) {
        report(`已从 DOI 关联信息匹配 arXiv ID: ${doiMatch.id}`, 40, "success");
        return {
          id: doiMatch.id,
          source: "doi-search",
          title: doiMatch.title,
        };
      }
    }

    const title = parentItem.getDisplayTitle().trim();
    if (!title) return null;

    report("条目没有 arXiv 标识，正在按标题查询 arXiv", 38);
    const match = await this.searchArxivByTitle(title, report);
    if (!match) {
      report("未能在 arXiv 中确认同名论文", 40, "warning");
      return null;
    }

    report(`已按标题匹配 arXiv ID: ${match.id}`, 40, "success");
    return { id: match.id, source: "title-search", title: match.title };
  }

  private static async searchArxivByTitle(
    title: string,
    report: ProgressReporter,
  ): Promise<ArxivSearchResult | null> {
    const cacheKey = this.normalizeTitle(title);
    const cached = this.titleSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const result =
      (await this.trySearchArxivWebByTitle(title, report)) ||
      (await this.trySearchOpenAlexByTitle(title, report));
    this.titleSearchCache.set(cacheKey, {
      expiresAt: Date.now() + this.titleSearchCacheMS,
      result,
    });
    return result;
  }

  private static async trySearchOpenAlexByDOI(
    doi: string,
    title: string,
    report: ProgressReporter,
  ) {
    const params = new URLSearchParams({
      filter: `doi:${doi}`,
      "per-page": "1",
    });
    const url = `https://api.openalex.org/works?${params.toString()}`;
    try {
      const response = await this.withTimeout(
        fetch(url, {
          headers: this.getRequestHeaders(),
        }),
        30000,
        "searchOpenAlexByDOI request",
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { results?: OpenAlexWork[] };
      return this.findOpenAlexArxivMatchByDOI(title, payload.results || []);
    } catch (error) {
      ztoolkit.log("OpenAlex DOI search failed", error);
      report("DOI 关联查询暂不可用，继续按标题查询 arXiv", 39, "warning");
      return null;
    }
  }

  private static async trySearchArxivWebByTitle(
    title: string,
    report: ProgressReporter,
  ) {
    const queryTitle = title.replace(/["“”]/g, " ").replace(/\s+/g, " ").trim();
    const query = encodeURIComponent(queryTitle);
    const url =
      `https://arxiv.org/search/?query=${query}` +
      "&searchtype=title&abstracts=show&order=-announced_date_first&size=25";

    try {
      const response = await this.withTimeout(
        fetch(url, {
          headers: this.getRequestHeaders(),
        }),
        30000,
        "searchArxivWebByTitle request",
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      const entries = this.parseArxivWebSearchResults(html);
      return (
        entries.find((entry) => this.matchTitle(title, entry.title)) || null
      );
    } catch (error) {
      ztoolkit.log("arXiv web title search failed; trying OpenAlex", error);
      report(
        "arXiv 网页搜索暂不可用，改用 OpenAlex 查询 arXiv 标识",
        39,
        "warning",
      );
      return null;
    }
  }

  private static parseArxivWebSearchResults(html: string): ArxivSearchResult[] {
    const document = new DOMParser().parseFromString(html, "text/html");
    const rows = Array.from(
      document.querySelectorAll(".arxiv-result"),
    ) as Element[];
    return rows
      .map((row) => {
        const rawID = this.getElementText(row, ".list-title a")
          .replace(/^arxiv:\s*/i, "")
          .replace(/\s+.*$/, "");
        const title = this.getElementText(row, "p.title").replace(/\s+/g, " ");
        const id = this.extractArxivIdFromStrings([`arXiv: ${rawID}`]);
        return id && title
          ? {
              id,
              title,
              url: this.makeArxivAbsURL(id),
            }
          : null;
      })
      .filter((entry): entry is ArxivSearchResult => !!entry);
  }

  private static async trySearchOpenAlexByTitle(
    title: string,
    report: ProgressReporter,
  ) {
    const url =
      `https://api.openalex.org/works?search=${encodeURIComponent(title)}` +
      "&per-page=5&sort=relevance_score:desc";
    try {
      const response = await this.withTimeout(
        fetch(url, {
          headers: this.getRequestHeaders(),
        }),
        30000,
        "searchOpenAlexByTitle request",
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { results?: OpenAlexWork[] };
      const result = this.findOpenAlexArxivMatch(title, payload.results || []);
      if (result) {
        report(`OpenAlex 匹配到 arXiv ID: ${result.id}`, 40, "success");
      }
      return result;
    } catch (error) {
      ztoolkit.log("OpenAlex title search failed", error);
      return null;
    }
  }

  private static findOpenAlexArxivMatch(
    title: string,
    works: OpenAlexWork[],
  ): ArxivSearchResult | null {
    for (const work of works) {
      const workTitle = work.display_name || work.title || "";
      if (!this.matchTitle(title, workTitle)) continue;

      const id = this.extractArxivIdFromStrings(
        this.getOpenAlexArxivCandidateStrings(work),
      );
      if (!id) continue;
      return {
        id,
        title: workTitle,
        url: this.makeArxivAbsURL(id),
      };
    }

    return null;
  }

  private static findOpenAlexArxivMatchByDOI(
    title: string,
    works: OpenAlexWork[],
  ): ArxivSearchResult | null {
    for (const work of works) {
      const id = this.extractArxivIdFromStrings(
        this.getOpenAlexArxivCandidateStrings(work),
      );
      if (!id) continue;

      const workTitle = work.display_name || work.title || title;
      return {
        id,
        title: workTitle,
        url: this.makeArxivAbsURL(id),
      };
    }

    return null;
  }

  private static getOpenAlexArxivCandidateStrings(work: OpenAlexWork) {
    const locations = [
      work.primary_location,
      work.best_oa_location,
      ...(work.locations || []),
    ].filter(Boolean) as OpenAlexLocation[];
    return [
      work.doi,
      work.ids?.doi,
      work.open_access?.oa_url,
      ...locations.flatMap((location) => [
        location.id,
        location.landing_page_url,
        location.pdf_url,
      ]),
    ].filter((value): value is string => !!value);
  }

  private static getElementText(parent: Element, selector: string) {
    return parent.querySelector(selector)?.textContent?.trim() || "";
  }

  private static matchTitle(base: string, candidate: string) {
    const normalizedBase = this.normalizeTitle(base);
    const normalizedCandidate = this.normalizeTitle(candidate);
    if (!normalizedBase || !normalizedCandidate) return false;
    if (normalizedBase === normalizedCandidate) return true;

    const compactBase = normalizedBase.replace(/\s+/g, "");
    const compactCandidate = normalizedCandidate.replace(/\s+/g, "");
    if (compactBase === compactCandidate) return true;

    const maxLength = Math.max(compactBase.length, compactCandidate.length);
    if (maxLength < 30) return false;
    const distance = this.levenshtein(compactBase, compactCandidate);
    return distance / maxLength <= 0.04;
  }

  private static normalizeTitle(title: string) {
    return title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  private static normalizeDOI(doi: string) {
    const normalized = doi
      .trim()
      .replace(/^doi:\s*/i, "")
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
      .trim();
    return this.extractArxivIdFromStrings([normalized]) ? "" : normalized;
  }

  private static levenshtein(a: string, b: string) {
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = Array.from({ length: b.length + 1 }, () => 0);

    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + cost,
        );
      }
      for (let j = 0; j <= b.length; j++) {
        previous[j] = current[j];
      }
    }

    return previous[b.length];
  }

  private static async persistArxivMetadata(
    item: Zotero.Item,
    resolved: ResolvedArxivID,
    report: ProgressReporter,
  ) {
    let changed = false;
    const arxivLine = `arXiv: ${resolved.id}`;
    const doi = this.makeArxivDOI(resolved.id);
    const url = this.makeArxivAbsURL(resolved.id);
    const existingDOI = String(item.getField("DOI") || "").trim();
    const existingURL = String(item.getField("url") || "").trim();
    const existingExtra = String(item.getField("extra") || "").trim();

    if (!existingDOI && this.safeSetField(item, "DOI", doi)) {
      changed = true;
    }
    if (!existingURL && this.safeSetField(item, "url", url)) {
      changed = true;
    }
    if (!this.extractArxivIdFromStrings([existingExtra])) {
      const nextExtra = existingExtra
        ? `${existingExtra}\n${arxivLine}`
        : arxivLine;
      if (this.safeSetField(item, "extra", nextExtra)) {
        changed = true;
      }
    }

    if (!changed) return;

    await item.saveTx();
    const source =
      resolved.source === "title-search"
        ? "标题匹配"
        : resolved.source === "doi-search"
          ? "DOI 关联"
          : resolved.source === "attachment"
            ? "附件信息"
            : "已有元数据";
    report(`已写入 arXiv 标识（${source}）`, 43, "success");
  }

  private static safeSetField(item: Zotero.Item, field: string, value: string) {
    try {
      item.setField(field, value);
      return true;
    } catch (error) {
      ztoolkit.log(`Failed to set Zotero field ${field}`, error);
      return false;
    }
  }

  private static normalizeArxivId(id: string) {
    return id
      .replace(/\.pdf$/i, "")
      .replace(/v\d+$/i, "")
      .trim();
  }

  private static makeArxivDOI(arxivId: string) {
    return `10.48550/arXiv.${arxivId}`;
  }

  private static makeArxivAbsURL(arxivId: string) {
    return `https://arxiv.org/abs/${arxivId}`;
  }

  private static makeArxivPDFURL(arxivId: string) {
    return `https://arxiv.org/pdf/${arxivId}.pdf`;
  }

  private static encodeArxivIdForPath(arxivId: string) {
    return encodeURIComponent(arxivId);
  }

  private static makeArxivFilenameID(arxivId: string) {
    return arxivId.replace(/[/:]/g, "_");
  }

  private static async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> {
    let timeoutID: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutID = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
          );
        }),
      ]);
    } finally {
      if (timeoutID) {
        clearTimeout(timeoutID);
      }
    }
  }

  private static getRequestHeaders(): Record<string, string> {
    return {
      "User-Agent": this.requestUserAgent,
    };
  }

  private static getHJFYRequestHeaders(): Record<string, string> {
    const cookie = this.getHJFYCookie();
    return cookie
      ? {
          ...this.getRequestHeaders(),
          Cookie: cookie,
        }
      : this.getRequestHeaders();
  }

  private static getHJFYCookie() {
    const raw = String(getPref("hjfyCookie") || "").trim();
    if (!raw) return "";

    const lines = raw
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const cookieLineIndex = lines.findIndex((line) =>
      /^cookie(?:\s*:|\s*$)/i.test(line),
    );
    if (cookieLineIndex >= 0) {
      const firstLineValue = lines[cookieLineIndex]
        .replace(/^cookie\s*:?\s*/i, "")
        .trim();
      const continuationLines = [];
      for (let i = cookieLineIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^[a-z][a-z0-9-]*\s*:/i.test(line)) break;
        continuationLines.push(line);
      }
      return [firstLineValue, ...continuationLines]
        .filter(Boolean)
        .join(" ")
        .replace(/\s*;\s*/g, "; ")
        .trim();
    }

    return lines
      .join(" ")
      .trim()
      .replace(/^cookie\s+/i, "")
      .replace(/\s*;\s*/g, "; ")
      .trim();
  }

  private static isHJFYURL(url: string) {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname === "hjfy.top" || parsed.hostname.endsWith(".hjfy.top")
      );
    } catch {
      return false;
    }
  }

  private static async requestHJFY(
    url: string,
    label: string,
    timeout: number,
    responseType?: XMLHttpRequestResponseType,
  ) {
    return this.withTimeout(
      Zotero.HTTP.request("GET", url, {
        errorDelayMax: 0,
        headers: this.getHJFYRequestHeaders(),
        responseType,
        successCodes: false,
        timeout,
      }),
      timeout + 1000,
      label,
    );
  }

  private static async fetchArxivInfo(arxivId: string): Promise<HJFYArxivInfo> {
    const encodedArxivId = this.encodeArxivIdForPath(arxivId);
    const xhr = await this.requestHJFY(
      `https://hjfy.top/api/arxivInfo/${encodedArxivId}`,
      "fetchArxivInfo request",
      15000,
    );
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`无法读取 hjfy.top 的 arXiv 信息: HTTP ${xhr.status}`);
    }

    const payload = JSON.parse(xhr.responseText || "{}") as unknown as {
      status: number;
      data?: HJFYArxivInfo;
      msg?: string;
    };
    if (payload.status !== 0 || !payload.data) {
      throw new Error(payload.msg || "hjfy.top 返回了无效的 arXiv 信息");
    }

    return payload.data;
  }

  private static async fetchArxivStatus(
    arxivId: string,
  ): Promise<HJFYArxivStatus | "login-required"> {
    const encodedArxivId = this.encodeArxivIdForPath(arxivId);
    const xhr = await this.requestHJFY(
      `https://hjfy.top/api/arxivStatus/${encodedArxivId}`,
      "fetchArxivStatus request",
      15000,
    );
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`无法查询翻译状态: HTTP ${xhr.status}`);
    }

    const payload = JSON.parse(xhr.responseText || "{}") as unknown as {
      status: number;
      data?: HJFYArxivStatus;
      msg?: string;
    };
    if (payload.status === 101) {
      return "login-required";
    }
    if (payload.status !== 0 || !payload.data) {
      throw new Error(payload.msg || "hjfy.top 返回了无效的状态数据");
    }

    return payload.data;
  }

  private static async fetchArxivFileInfo(
    arxivId: string,
  ): Promise<HJFYFileInfo> {
    const encodedArxivId = this.encodeArxivIdForPath(arxivId);
    const xhr = await this.requestHJFY(
      `https://hjfy.top/api/arxivFiles/${encodedArxivId}`,
      "fetchArxivFileInfo request",
      15000,
    );
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error(`无法读取翻译文件信息: HTTP ${xhr.status}`);
    }

    const payload = JSON.parse(xhr.responseText || "{}") as unknown as {
      status: number;
      data?: HJFYFileInfo;
      msg?: string;
    };
    if (payload.status !== 0 || !payload.data) {
      throw new Error(payload.msg || "hjfy.top 返回了无效的文件信息");
    }

    return payload.data;
  }

  private static async tryFetchArxivFileInfo(arxivId: string) {
    try {
      return await this.fetchArxivFileInfo(arxivId);
    } catch {
      return null;
    }
  }

  private static async primeArxivTask(arxivId: string) {
    const encodedArxivId = this.encodeArxivIdForPath(arxivId);
    try {
      const xhr = await this.requestHJFY(
        `https://hjfy.top/arxiv/${encodedArxivId}`,
        "primeArxivTask request",
        15000,
      );
      if ((xhr.responseText || "").includes("需要先登录")) {
        throw new HJFYLoginRequiredError(arxivId);
      }
    } catch (error) {
      if (error instanceof HJFYLoginRequiredError) {
        throw error;
      }
      ztoolkit.log("primeArxivTask failed", error);
    }
  }

  private static async waitForTranslation(
    arxivId: string,
    report: ProgressReporter,
  ) {
    for (let attempt = 0; attempt < 36; attempt++) {
      const status = await this.fetchArxivStatus(arxivId);
      if (status === "login-required") {
        throw new HJFYLoginRequiredError(arxivId);
      }

      report(
        `正在等待 HJFY 翻译完成：${status.status}${status.info ? ` - ${status.info}` : ""} (${attempt + 1}/36)`,
        Math.min(66, 52 + attempt),
      );

      if (status.status === "finished") {
        return;
      }
      if (status.status === "failed" || status.status === "error") {
        throw new Error(status.info || "幻觉翻译任务失败");
      }
      if (status.status === "fault") {
        throw new Error(status.info || "hjfy.top 返回了故障状态");
      }

      await Zotero.Promise.delay(10000);
    }

    throw new Error("等待幻觉翻译完成超时，请稍后重试");
  }

  private static async downloadBinary(url: string) {
    const downloadURL = new URL(url, "https://hjfy.top/").toString();
    const isHJFYURL = this.isHJFYURL(downloadURL);
    if (isHJFYURL) {
      const xhr = await this.requestHJFY(
        downloadURL,
        "downloadBinary request",
        120000,
        "arraybuffer",
      );
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`下载翻译 PDF 失败: HTTP ${xhr.status}`);
      }
      return xhr.response as ArrayBuffer;
    }

    const response = await this.withTimeout(
      fetch(downloadURL, {
        headers: this.getRequestHeaders(),
      }),
      120000,
      "downloadBinary request",
    );
    if (!response.ok) {
      throw new Error(`下载翻译 PDF 失败: HTTP ${response.status}`);
    }

    return response.arrayBuffer();
  }

  private static async downloadArxivPDF(arxivId: string) {
    const response = await this.withTimeout(
      fetch(this.makeArxivPDFURL(arxivId), {
        headers: this.getRequestHeaders(),
      }),
      120000,
      "downloadArxivPDF request",
    );
    if (!response.ok) {
      throw new Error(`下载 arXiv 原文 PDF 失败: HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    if (!this.isPDFBuffer(buffer)) {
      throw new Error("arXiv 返回的内容不是有效 PDF");
    }
    return buffer;
  }

  private static isPDFBuffer(buffer: ArrayBuffer) {
    const bytes = new Uint8Array(buffer);
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46
    );
  }

  private static async savePdfAsAttachment(
    parentItem: Zotero.Item,
    pdfBuffer: ArrayBuffer,
    arxivId: string,
  ) {
    const title = this.makeAttachmentTitle(parentItem.getDisplayTitle());
    const filename = `${title}_hjfy_arxiv_${this.makeArxivFilenameID(arxivId)}.pdf`;
    const tempDir = Zotero.getTempDirectory();
    tempDir.append("hjfy-split-reader");
    if (!tempDir.exists()) {
      tempDir.create(1, 0o755);
    }

    const tempFile = tempDir.clone();
    tempFile.append(filename);

    try {
      await this.writeFile(tempFile, pdfBuffer);
      const attachment = await Zotero.Attachments.importFromFile({
        file: tempFile,
        parentItemID: parentItem.id,
      });
      attachment.setField(
        "title",
        `幻觉翻译 - ${parentItem.getDisplayTitle()}`,
      );
      await attachment.saveTx();
      return attachment;
    } finally {
      try {
        if (tempFile.exists()) {
          tempFile.remove(false);
        }
      } catch (error) {
        ztoolkit.log("Failed to clean temp translation file", error);
      }
    }
  }

  private static async saveArxivSourcePdfAsAttachment(
    parentItem: Zotero.Item,
    pdfBuffer: ArrayBuffer,
    arxivId: string,
  ) {
    const title = this.makeAttachmentTitle(parentItem.getDisplayTitle());
    const filename = `${title}_arxiv_${this.makeArxivFilenameID(arxivId)}.pdf`;
    const tempDir = Zotero.getTempDirectory();
    tempDir.append("hjfy-split-reader");
    if (!tempDir.exists()) {
      tempDir.create(1, 0o755);
    }

    const tempFile = tempDir.clone();
    tempFile.append(filename);

    try {
      await this.writeFile(tempFile, pdfBuffer);
      const attachment = await Zotero.Attachments.importFromFile({
        file: tempFile,
        parentItemID: parentItem.id,
      });
      attachment.setField(
        "title",
        `arXiv PDF - ${parentItem.getDisplayTitle()}`,
      );
      this.safeSetField(attachment, "url", this.makeArxivPDFURL(arxivId));
      await attachment.saveTx();
      return attachment;
    } finally {
      try {
        if (tempFile.exists()) {
          tempFile.remove(false);
        }
      } catch (error) {
        ztoolkit.log("Failed to clean temp arXiv source PDF file", error);
      }
    }
  }

  private static makeAttachmentTitle(title: string) {
    return (
      title
        .replace(/[^\w\s.-]/g, "")
        .trim()
        .slice(0, 60) || "paper"
    );
  }

  private static async writeFile(file: any, data: ArrayBuffer) {
    return new Promise<void>((resolve, reject) => {
      const outputStream = (Components.classes as any)[
        "@mozilla.org/network/file-output-stream;1"
      ].createInstance(Components.interfaces.nsIFileOutputStream);
      outputStream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);

      try {
        const binaryStream = (Components.classes as any)[
          "@mozilla.org/binaryoutputstream;1"
        ].createInstance(Components.interfaces.nsIBinaryOutputStream);
        binaryStream.setOutputStream(outputStream);
        const bytes = new Uint8Array(data);
        binaryStream.writeByteArray(bytes, bytes.length);
        binaryStream.close();
        outputStream.close();
        resolve();
      } catch (error) {
        outputStream.close();
        reject(error);
      }
    });
  }

  private static showMessage(
    text: string,
    type: "default" | "warning" | "error" | "success" = "default",
  ) {
    const popup = new ztoolkit.ProgressWindow(getString("hjfy-window-title"));
    popup.createLine({
      text,
      type,
    });
    popup.show();
    popup.startCloseTimer(4000);
  }
}
