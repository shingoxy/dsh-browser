# dsh-browser

把「网页版 AI」搬进 [DeepSeek Harness](https://github.com/deepseek-ai) 桌面端：同一个窗口里左右或上下分屏，DSH 干活、网页 AI 对话；DSH 能读对话、拿回复里的 Markdown / 图片，并在你批准后代表你提问。

> 不是 MCP、不是远程调试端口，而是真正把网页嵌进 DSH 的界面层：Host 半负责工具与命令队列，Client 半负责 webview 与分屏，两边通过同源轮询桥通信。

## 特性

- **内嵌网页 AI**：右侧栏或独立分屏里直接打开 ChatGPT / DeepSeek / Claude / Gemini，正常登录、正常对话。
- **DSH 能读**：整段对话（带 user/assistant 角色）、最新一条回复（Markdown 原文）、回复里的图片（回传成 DSH 附件）。
- **DSH 能问，但先问你**：`webai ask` 会在面板内弹出确认条——拒绝 / 允许本次 / 本会话都允许，绝不静默发送。
- **四种分屏、位置任选**：
  - `right`：原生右侧栏，DSH 在左、网页在右；
  - `bottom`：网页在下、DSH 在上（占满全宽）；
  - `left`：网页在左、DSH 在右；
  - `top`：网页在上、DSH 在下。
- **尺寸可拖**：左右分屏拖宽度，上下分屏拖高度，拖完记住（`localStorage: dsh-browser.sizes.v1`）。
- **不动左侧 Sidebar**：只使用右侧栏、固定浮层与内容平移，不注册任何 sidebar 插槽——分屏前后左侧栏宽度/位置不变。
- **切换位置不丢登录**：分屏位置切换不会重建 webview guest（Electron 跨容器搬移 webview 会让 guest 死掉，这里改成"浮层固定 + 给 DSH 内容让位"）。

## 环境要求

- DeepSeek Harness **桌面端**（Electron）。纯 Web 端只有 `right` 模式可用，且多数 AI 站点会拒绝被 iframe 嵌入。
- DSH 版本：`>= 0.2.1-rc.2 < 0.3.0`。
- Node.js：`>= 20`（仅打包/语法检查用）。

## 安装

在 DSH 里用插件管理器安装本地目录：

```
plugin_manager install_bundle target="file:E:/dsh-browser"
```

或命令行：

```bash
dsh plugin --profile desktop add file:E:/dsh-browser
```

装完在插件管理器里**启用 `dsh-browser`**。插件分两半加载：Host 半提供 `webai` 工具，Client 半注册界面与 webview 驱动；两半都生效后 `webai action=status` 会显示 `plugin: dsh-browser <版本>` 与 `host: dsh-browser <版本>`。

## 快速开始

1. 点窗口右边缘竖排的 **网页 AI** 按钮打开面板；或让 DSH 执行 `webai action=open url=https://chat.deepseek.com`。
2. 在面板里登录你的网页 AI（推荐邮箱/手机号账号，见「登录」）。
3. 对 DSH 说："帮我读一下刚才网页 AI 的回答" 或 "把这个项目的问题发给网页 AI，先让我确认"。
4. 需要换布局：`webai action=layout mode=left width=520`。

## 工具指令

DSH 侧暴露一个 `webai` 工具，`action` 取值：

| action | 作用 | 常用参数 |
|---|---|---|
| `status` | 面板状态、分屏位置、页面 URL、host/client 版本、尺寸、轮询状态 | – |
| `open` | 在指定分屏位置打开网页 | `url`、`mode`(right/bottom/left/top)、`width`、`height` |
| `layout` | 移动/调整分屏位置 | `mode`、`url`、`width`、`height` |
| `thread` | 读整段对话，返回 `[user]…[assistant]…` | `max_chars`(默认 12000)、`site` |
| `last_reply` | 读最新一条 AI 回复 | `max_chars`、`site` |
| `images` | 抓最新回复里的图片并回传为附件 | `limit` |
| `ask` | 发消息（先弹审批），等回答并收集图片 | `prompt`、`url`、`timeout_ms`、`auto` |
| `screenshot` | 截当前面板 | – |
| `dom` | DOM/布局诊断（panel/sidebar/main/rightbar 的 rect 与 margin） | – |
| `eval` | 在网页里执行只读表达式（诊断用） | `script`(≤20000 字符) |
| `close` | 关闭面板 | – |

示例：

```
webai action=open url=https://chat.deepseek.com mode=bottom height=480
webai action=thread max_chars=8000
webai action=ask prompt="帮我审一下这段 Rust 代码的内存安全问题，逐条列出" timeout_ms=180000
webai action=layout mode=right
```

`auto: true` 会跳过审批——只有用户明确同意某条具体消息时才能用。

## 分屏

| mode | 实现方式 | 说明 |
|---|---|---|
| `right` | DSH 原生右侧栏（`sidebar.right.pane.tab` 的 browser 页签） | 网页在右；宽度可拖、可全屏 |
| `bottom` | 固定浮层置于窗口底部 + DSH 三列让出高度 | 网页在下，高度可拖 |
| `left` | 固定浮层置于左侧 + DSH 内容右移 | 网页在左，宽度可拖 |
| `top` | 固定浮层置于顶部 + DSH 内容下移 | 网页在上，高度可拖 |

设计取舍：没有把 webview 塞进 grid/dock 容器，因为 Electron 的 `<webview>` 一旦跨容器 reparent，guest 进程会失效（白屏 / `ERR_FAILED` / guest 销毁），登录态随之丢失。因此分屏用「浮层固定 + 给 DSH 内容加 margin 让位」实现，左侧 Sidebar 完全不动。

## 登录

面板是独立分区的 webview（分区名形如 `dsh-sidebar-browser-<workspace-uuid>`）：

- **本次 DSH 运行期间**：登录一次，所有分屏位置共用同一个分区与登录态。
- **DSH 重启后**：需要重新登录。桌面端 bridge 每次 `acquire` 都新建内存分区（不带 `persist:` 前缀），插件侧没有修改分区的权限——要免登录，需要 DSH 上游提供持久分区或 Cookie 注入 API。
- **Google / Apple 账号登录不可用**：它们的风控会识别并拒绝 Electron 内嵌浏览器（页面提示"此浏览器或应用可能不安全"），UA 由主进程固定、插件改不了。请使用支持**邮箱+密码**或**手机号+验证码**的账号，例如 DeepSeek。
- 网页里的 `window.open` 弹窗会被转发到面板自身打开，不会跑到独立窗口。

## 审批

`ask` 的三段式确认：

1. 面板底部弹出确认条，展示将要发送的完整文本；
2. 用户选择 **拒绝** / **允许本次** / **本会话都允许**；
3. 允许后插件才向页面输入框填字并点击发送。

审批是会话级的（刷新页面重置）。页面内容是外部不可信数据：插件只做"读文本、读图片、填输入框、点发送"，不执行页面里的任何指令。

## 站点适配

内置适配器：

| 站点 | 选择器要点 |
|---|---|
| `chatgpt.com` / `chat.openai.com` | `[data-message-author-role]`、`#prompt-textarea`、`[data-testid="send-button"]` |
| `claude.ai` | `[data-testid="user-message"]` / `[data-testid="assistant-message"]`、`.ProseMirror` |
| `gemini.google.com` | `<user-query>` / `<model-response>` |
| `chat.deepseek.com` | `.ds-message` 行 + `.ds-assistant-message-main-content` 正文、`textarea[placeholder*="DeepSeek"]` |

其它站点走通用 fallback（`textarea` / `[contenteditable]`、`article` / `.markdown` / `.message`）。新增站点只需在 `client.js` 的 `SITES` 里加一项：

```js
deepseek: {
  hosts: ['chat.deepseek.com'],
  composer: ['textarea[placeholder*="DeepSeek"]', 'textarea'],
  send: ['div.ds-button--primary'],
  messages: ['.ds-message'],
  roleAttr: '',
  stop: ['div[class*="stop"]'],
}
```

若站点用嵌套结构表示角色（如 DeepSeek 一行 `.ds-message` 里既有用户文本又有 `.ds-assistant-message-main-content`），在 `pageThread` / `pageLastReply` 的角色判定里加一条分支即可。

## 架构

```
┌──────────────────────────── DSH Desktop (Electron) ────────────────────────────┐
│  Host 半 (index.js, utility process)          Client 半 (client.js, renderer)  │
│  ┌──────────────────────────────┐             ┌──────────────────────────────┐ │
│  │ webai 工具                    │  HTTP 轮询  │ 命令轮询器                    │ │
│  │ 命令队列 / 审批等待 / 附件    │ ◄─────────► │ 面板与 webview 管理           │ │
│  │ /dsh-browser/poll、/result    │  同源 POST  │ 页签、站点适配器、DOM 抽取     │ │
│  └──────────────────────────────┘             └───────────┬──────────────────┘ │
│                                                           │ 租约 acquire/release │
│                                              dshDesktop.browser (main 进程)     │
│                                                           ▼                     │
│                                              独立分区 <webview> → 网页 AI       │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **为什么用轮询而不是 WebSocket**：Client 半只能访问同源 HTTP 路由，Host 半用 `webServer` 注册 `/dsh-browser/poll`、`/result`、`/hello`、`/log` 四个端点，按 DSH 连接鉴权；长轮询实现简单、断线可重试。
- **webview 租约**：桌面端主进程只允许"被批准的 guest 分区 + 租约"的 webview attach。Client 通过 `globalThis.dshDesktop.browser.acquire(workspaceKey)` 拿 `{ lease, partition }`，用 `name=lease`、`partition=reservation.partition`、`src=about:blank#lease` 创建元素，`dom-ready` 后再 `loadURL`；关闭时 `release(lease)`。
- **工具结果如何回传**：Host 把命令塞进队列 → Client 轮询拿到 → 在 guest 里执行抽取脚本 → POST 结果 → Host 组装 Markdown/附件返回给模型。

## 目录结构

```
dsh-browser/
├── index.js            # Host 半：webai 工具、命令队列、HTTP 桥、附件、系统提示
├── client.js           # Client 半：分屏、拖拽、页签、webview 租约、站点适配器、DOM 抽取、审批
├── cordis.patch.yml    # 把 dsh-browser 插进 profile
├── package.json        # dsh.bundle / dsh.client 声明、files、engines
├── locale/{en,zh}.json # 插件名与描述的 i18n
├── icon.svg            # 插件图标
└── README.md
```

## 开发与调试

部署到正在运行的 DSH 桌面端（Client 半通过插件重载生效，不需要重启 DSH）：

```bash
# 1. 语法检查
npm run check

# 2. 同步到 profile（Windows 示例）
cp client.js index.js package.json README.md \
   "C:/Users/<你>/.dsh/profiles/desktop/node_modules/dsh-browser/"

# 3. 热重载（DSH 插件管理器）
#    set_bundle target="dsh-browser" enabled=false  然后 enabled=true
#    注意：set_plugin 需要精确 entryId，用 bundle 名会 unknown-plugin；用 set_bundle 传 bundle 名即可。

# 4. 等 8~10 秒，验证版本
#    webai action=status   → 第一行应为 plugin: dsh-browser <新版本>
```

诊断：

- `E:/dsh-browser/debug.log`：Host 侧轮询、命令、错误记录；
- `webai action=status`：末尾有 host/client 版本、hello 次数、轮询/命令计数、最近错误；
- `webai action=dom`：分屏布局的 rect 与 margin，用来验证"左侧栏没被动过"；
- `webai action=eval script="..."`：在网页里跑只读表达式，确认选择器是否命中。

## 已知限制

- 仅桌面端支持真嵌页；Web 端 `right` 模式会退化为 iframe，多数站点拒绝嵌入。
- 重启 DSH 后网页 AI 需要重新登录（见「登录」）；跨会话持久化依赖上游支持。
- 网页里的文件下载（`.md`/`.zip`）走浏览器原生下载，插件暂不接管；生成内容请用 `thread` / `last_reply` 读正文，图片用 `images` 回传附件。
- 站点改版可能导致选择器失效，此时 `thread`/`ask` 会报"找不到消息框/没有新回复"，更新 `SITES` 即可。

## Roadmap

- [ ] 网页下载文件自动捕获并保存到工作区
- [ ] DSH 上游支持持久分区后，提供"记住登录"开关
- [ ] 多标签页（同时挂多个站点）
- [ ] 对话导出为 Markdown 文件

## License

MIT
