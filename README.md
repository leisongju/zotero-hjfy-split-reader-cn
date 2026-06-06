# HJFY Split Reader CN

[![Zotero 8/9](https://img.shields.io/badge/Zotero-8%2F9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue?style=flat-square)](LICENSE)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

HJFY Split Reader CN 是一个 Zotero 8 / 9 插件，用来获取 arXiv 论文在 `hjfy.top` 上的中文翻译 PDF，并在 Zotero 里进行原文/译文分屏阅读。

## 主要功能

- 单篇获取 HJFY 中文译文 PDF，并自动与原文分屏打开。
- 多选论文后批量获取中文译文 PDF，只保存附件，不自动打开阅读器。
- 自动识别 arXiv ID，支持 DOI、URL、Extra、PDF 附件信息和标题搜索。
- 条目没有本地 PDF 时，手动和批量流程可先下载 arXiv 原文 PDF。
- 支持在设置中填写 HJFY Cookie，用于需要登录态的翻译任务。
- 可选监听新增论文并自动尝试获取译文，默认关闭；自动流程会等 Zotero 自己的 PDF 附件出现，避免重复下载原文 PDF。
- 复用本地已有译文附件，避免重复下载。

## 界面预览

### 右键菜单入口

<p align="center">
  <img src="doc/images/context-menu-zh.png" alt="条目右键菜单中的获取幻觉翻译并分屏打开入口" width="320" />
</p>

### 分屏阅读效果

<p align="center">
  <img src="doc/images/split-view-zh.png" alt="原文与译文在 Zotero 中分屏打开的效果" width="1100" />
</p>

## 安装

推荐安装 Release 里的 `.xpi`：

1. 打开本仓库的 Releases 页面。
2. 下载最新的 `hjfy-split-reader-cn.xpi`。
3. 在 Zotero 中打开 `工具` -> `插件`。
4. 点击右上角齿轮 -> `Install Plugin From File...`。
5. 选择下载的 `.xpi` 文件。

用户只需要安装 `.xpi`。插件自动更新所需的 `update.json` 托管在 GitHub Pages，不需要手动下载或安装。

如果仓库还没有发布 Release，也可以本地构建：

```bash
npm ci
npm run build
```

构建产物位于：

```text
.scaffold/build/hjfy-split-reader-cn.xpi
```

## 使用方式

1. 在 Zotero 中选中一篇论文条目，或选中这篇论文下的 PDF 附件。
2. 右键点击“获取幻觉翻译并分屏打开”。
3. 插件会依次执行：
   - 查找当前条目下是否已有中文译文附件。
   - 解析或按标题查询 arXiv ID。
   - 如果当前条目没有原文 PDF，会尝试下载 arXiv 原文 PDF 并挂回条目。
   - 查询 `hjfy.top` 是否已有可下载译文。
   - 如果译文已生成，则下载 PDF 并挂到当前 Zotero 条目下。
   - 自动打开原文和译文的分屏阅读器。

如果 HJFY 还没有现成译文，插件会打开对应的 HJFY 页面，方便你在网页上继续处理。

### 配置 HJFY Cookie

如果 HJFY 创建翻译任务时提示需要登录，可以在 Zotero 插件设置中填写 HJFY Cookie。获取和填写方法见 [获取 HJFY Cookie](docs/hjfy-cookie.md)。

### 批量获取译文 PDF

1. 在 Zotero 中同时选中多篇论文条目，或这些论文下的 PDF 附件。
2. 右键点击“批量获取幻觉翻译 PDF（不打开）”。
3. 插件会批量查询、下载并把中文译文 PDF 保存为各自论文条目的附件，不会自动打开分屏阅读器。

批量任务会按论文父条目去重，已存在本地 HJFY 译文附件的论文会在本地预检查阶段立即跳过，不占用 5 秒启动间隔。为了降低触发 HJFY 限制的概率，真正需要访问 HJFY 的任务默认最多 10 篇保持活跃，并保证每个新任务至少间隔 5 秒启动。

如果批量论文条目没有本地 PDF，插件会先尝试从 Zotero 元数据和标题中确认 arXiv ID，并下载 arXiv 原文 PDF。若 HJFY 没有 LaTeX 源码导致无法生成译文，批量结果会显示“已存原文”，表示原文 PDF 已作为附件保存，但译文 PDF 尚未保存。

### 新增论文自动获取

“新增论文后自动尝试获取 HJFY 译文”默认关闭。开启后，插件会监听新加入 Zotero 的论文主条目和 PDF 附件，等待约 30 秒让元数据和附件保存完成，然后在已有原文 PDF 附件时自动尝试获取译文 PDF。自动流程只保存译文附件，不打开分屏阅读器，也不会主动下载 arXiv 原文 PDF，避免和 Zotero 自己稍后下载的 PDF 重复；如果主条目刚加入时还没有 PDF，本轮会先跳过，等 Zotero 后续新增 PDF 附件时再触发。关闭后不会注册新增条目监听，也会清空尚未启动的自动队列。

## 支持范围与限制

- 最适合处理已经发布到 arXiv 的论文。
- HJFY 的翻译能力、登录状态和接口可用性由 `hjfy.top` 决定，插件只做查询、下载和 Zotero 内部附件管理。
- 目前没有做“本地 PDF 上传到 HJFY”的自动化流程。
- 标题查询采用保守匹配：如果标题匹配不够明确，插件会失败并提示原因，而不是强行绑定到可能错误的 arXiv 论文。
- 如果论文没有 arXiv 版本，插件会给出失败反馈，不会自动去其他站点下载或上传 PDF。

## 开发

安装依赖：

```bash
npm ci
```

本地构建：

```bash
npm run build
```

开发模式启动 Zotero 插件脚手架：

```bash
npm start
```

常用检查命令：

```bash
npm run lint:check
npm run release:check
```

核心逻辑主要在：

```text
src/modules/hjfySplit.ts
```

分屏阅读器相关逻辑主要在：

```text
src/modules/splitView.ts
```

## 隐私说明

- 插件会读取当前 Zotero 条目的题名、DOI、URL、Extra 和附件元数据，用于识别 arXiv ID。
- 在需要自动识别 arXiv ID 时，插件可能会把论文标题发送给 arXiv 或 OpenAlex 查询。
- 插件会访问 `hjfy.top` 查询译文状态并下载译文 PDF。
- 仓库不应包含个人 Cookie、`.env`、Zotero 数据库、论文 PDF、项目管理记录或任何私有研究材料。

## 上游来源与致谢

本项目是以下开源项目和公开 translator 代码的衍生改版：

- [Infinity4B/zotero-hjfy-split-reader](https://github.com/Infinity4B/zotero-hjfy-split-reader)：本改版的直接上游。
- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)：提供 Zotero 插件项目结构、构建工具链和脚手架。
- [zerolfl/zotero-split-view-reader](https://github.com/zerolfl/zotero-split-view-reader)：提供分屏阅读器核心实现和 UI 资源。
- [ANGJustinl/zotero-plugin-hjfy](https://github.com/ANGJustinl/zotero-plugin-hjfy)：提供 HJFY 接口接入思路与附件导入流程。
- [zotero/translators](https://github.com/zotero/translators) 中的 `arXiv.org.js`、`OpenAlex.js`、`OpenAlex JSON.js`：本改版的标题查询和元数据解析策略参考了这些官方 translator 的实现。
- [AllanChain/zotero-arxiv-workflow](https://github.com/AllanChain/zotero-arxiv-workflow)：调研 arXiv 识别工作流时的参考项目。

各上游项目的版权声明与许可证条款，请同时参见 [LICENSE](LICENSE) 与对应上游仓库。

## 许可证

本项目遵循 `AGPL-3.0-or-later`。公开发布、修改或网络服务形式使用时，请遵守 AGPL 条款，并保留上游版权与许可证说明。
