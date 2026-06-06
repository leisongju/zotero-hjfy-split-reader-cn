# 获取 HJFY Cookie

HJFY 在创建部分翻译任务时需要登录态。插件不会内置或公开任何个人 Cookie，需要你在本机登录 `hjfy.top` 后，把自己的 Cookie 填入 Zotero 插件设置。

## 从浏览器复制 Cookie

推荐用浏览器开发者工具的 Network 面板复制请求头，因为有些登录 Cookie 是 HttpOnly，不能通过 `document.cookie` 直接读到。

1. 在浏览器打开 [https://hjfy.top](https://hjfy.top)，确认已经登录。
2. 打开开发者工具。
   - Chrome / Edge：按 `F12`，或右键页面后选择 `检查`。
   - macOS Chrome 也可以按 `Option + Command + I`。
3. 切到 `Network` 面板。
4. 刷新 `hjfy.top` 页面，或打开任意一篇 `https://hjfy.top/arxiv/...` 页面。
5. 在 Network 请求列表里选中一个发往 `hjfy.top` 的请求。
6. 在右侧 `Headers` 里找到 `Request Headers`。
7. 复制里面的 `Cookie` 请求头。

只需要复制 `Cookie` 这一项右侧的值；`Accept`、`Host`、`User-Agent`、`Sec-*` 等其他请求头不需要复制。

你可以复制完整的这一行：

```text
Cookie: xxx=...; yyy=...
```

也可以只复制冒号后面的值：

```text
xxx=...; yyy=...
```

插件设置里两种格式都能识别。

## 填入 Zotero 插件设置

1. 打开 Zotero。
2. 进入 `工具` -> `插件`。
3. 找到 `HJFY Split Reader CN`。
4. 打开插件偏好设置。
5. 在 `HJFY Cookie` 输入框粘贴刚才复制的 Cookie。
6. 重新执行“获取幻觉翻译”或“批量获取幻觉翻译 PDF（不打开）”。

## 注意事项

- Cookie 等同于登录凭证，不要发到公开 issue、README、截图或提交记录里。
- Cookie 可能会过期；如果再次提示需要登录，重新登录 `hjfy.top` 后复制新的 Cookie。
- 插件只会把这个 Cookie 附加到 `hjfy.top` 请求，不会发送到 arXiv 或 OpenAlex。
- 不建议把 Cookie 硬编码进源码或打包进 XPI。
