import { getString } from "../utils/locale";
import { SplitViewFactory } from "./splitView";

interface ResolvedSelection {
  parentItem: Zotero.Item;
  sourcePDF: Zotero.Item;
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
  source: "metadata" | "attachment" | "title-search";
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

class HJFYLoginRequiredError extends Error {
  constructor(public readonly arxivId: string) {
    super("幻觉翻译要求登录后才能为这篇论文创建翻译任务");
  }
}

export class HJFYSplitFactory {
  private static readonly menuID = "zotero-itemmenu-hjfy-split-reader";
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

    const elem = ztoolkit.UI.appendElement(
      {
        tag: "menuitem",
        id: this.menuID,
        namespace: "xul",
        attributes: {
          label: getString("hjfy-menu-label"),
          image: `chrome://${addon.data.config.addonRef}/content/icons/svreader.svg`,
        },
        classList: ["menuitem-iconic"],
        listeners: [
          {
            type: "command",
            listener: () => {
              void this.handleMenuCommand();
            },
          },
        ],
      },
      itemMenu,
    ) as XULElement;

    (elem as any).style.setProperty("-moz-context-properties", "fill");
    (elem as any).style.setProperty("fill", "currentColor");
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
      const { parentItem, sourcePDF } = this.resolveSelection(items[0]);
      let translatedPDF = this.findExistingTranslation(parentItem, sourcePDF);

      if (translatedPDF) {
        popup.createLine({
          text: "已找到已有的幻觉翻译附件，准备分屏打开",
          type: "success",
          progress: 40,
        });
      } else {
        const report: ProgressReporter = (
          text,
          progress = 35,
          type = "default",
        ) => {
          popup.createLine({ text, type, progress });
        };
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
    sourcePDF: Zotero.Item,
  ) {
    const arxivId = this.extractArxivId(parentItem);
    const sourceKey = String(sourcePDF.getField("title") || "").trim();
    const candidates = this.getPDFAttachments(parentItem).filter(
      (attachment) => attachment.id !== sourcePDF.id,
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
      throw new Error(
        "这篇论文没有可用的 LaTeX 源码，hjfy.top 不能直接生成翻译 PDF",
      );
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

  private static getRequestHeaders(): HeadersInit {
    return {
      "User-Agent":
        "zotero-hjfy-split-reader-cn (Zotero Plugin; +https://github.com/leisongju/zotero-hjfy-split-reader-cn)",
    };
  }

  private static async fetchArxivInfo(arxivId: string): Promise<HJFYArxivInfo> {
    const encodedArxivId = this.encodeArxivIdForPath(arxivId);
    const response = await this.withTimeout(
      fetch(`https://hjfy.top/api/arxivInfo/${encodedArxivId}`, {
        headers: this.getRequestHeaders(),
      }),
      15000,
      "fetchArxivInfo request",
    );
    if (!response.ok) {
      throw new Error(
        `无法读取 hjfy.top 的 arXiv 信息: HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as unknown as {
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
    const response = await this.withTimeout(
      fetch(`https://hjfy.top/api/arxivStatus/${encodedArxivId}`, {
        headers: this.getRequestHeaders(),
      }),
      15000,
      "fetchArxivStatus request",
    );
    if (!response.ok) {
      throw new Error(`无法查询翻译状态: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown as {
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
    const response = await this.withTimeout(
      fetch(`https://hjfy.top/api/arxivFiles/${encodedArxivId}`, {
        headers: this.getRequestHeaders(),
      }),
      15000,
      "fetchArxivFileInfo request",
    );
    if (!response.ok) {
      throw new Error(`无法读取翻译文件信息: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown as {
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
      const response = await this.withTimeout(
        fetch(`https://hjfy.top/arxiv/${encodedArxivId}`, {
          headers: this.getRequestHeaders(),
        }),
        15000,
        "primeArxivTask request",
      );
      const text = await response.text();
      if (text.includes("需要先登录")) {
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
