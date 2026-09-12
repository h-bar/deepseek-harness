# Agent Note: Client file-download seam

Status: implemented

[English](2026-09-06-client-file-download-seam.md) | 中文

## Problem

把 Host 文件保存到用户机器这件事，此前是单个功能的私有实现。`dsh-session-log-export` 自行构造 URL、用页面 `fetch` 发出 `HEAD` 预检，并把 `<a download>` 交给浏览器下载管理器。每一步都假定页面就是所服务的 web app。

在自有 app origin 上嵌入 Client、并把每一个 wire 字节都经由自有载体转发的 shell，这三者皆无：其 WebView 中不存在下载管理器；页面源请求携带的 `Origin` 会被 `/api` 信任围栏拒绝；浏览器会话 cookie 由原生侧而非页面持有。这样的 shell 只能禁用随包发布的行，并针对自己的保存命令镜像出一套控制器、按钮与弹窗——重新实现本地化与 `/export` 路径，并在每次版本变更时发生漂移。

仓库中没有其他功能下载文件，因此不存在可供归纳的第二个消费方。而先例就在一个包之外：`dsh-client-file-upload` 已经为相反方向解决了同一类问题。

## Decision

`dsh-client-file-download` 拥有把 Host 文件保存到本地这件事，镜像 `dsh-client-file-upload`。`FileDownloadRuntime` 提供 `ctx.fileDownload`，在构造期间读取一次自有页面全局对象 `__DSH_FILE_DOWNLOAD__`，并在页面生命周期内固定其载体。没有 hook 时使用 `savePageDownload`，即下载管理器锚点；有 hook 时委托给它。

`save({ path, suggestedFilename })` 接收 Host 相对的 `/api/…` 路径，绝不是绝对 URL，因此 shell 会校验该路径并通过自己的已认证连接执行传输。它回答 `'saved'` 或 `'cancelled'`，其中 `'cancelled'` 表示保存对话框被关闭——既不是成功也不是失败。`shellOwned` 报告页面是否仍在执行传输。

`SessionLogDownloadController` 接收该服务并委托每一次保存。当 `shellOwned` 为真时它跳过 `HEAD` 预检，因为页面既不执行传输也不执行凭据交换，所以针对同一路径的页面源请求毫无意义，且载体会报告自身失败。`'cancelled'` 删除该会话的弹窗条目，使弹窗静默关闭；拒绝则发布既有的错误状态。本包不再拥有自己的保存实现：`downloadUrl` 已删除，浏览器锚点只有一个归属。

选择依据是载体是否存在，绝不是页面授权。`isLoopback` 与 `ownsHost` 把守特权面——host 设置持久化、设置文档控制器、原生路径打开——因此它们是授权声明，而非传输事实。指向远程部署的普通浏览器是 non-loopback，其下载管理器工作正常；而嵌入 shell 无论 loopback 与否都是坏的。

## Alternatives considered

**在 `ClientTransportHooks` 上加 `saveDownload` 成员，并由 `ConnectionHandle` 重新发布。** 先实现后回退。`ClientTransportHooks` 承载的是 wire 载体——`fetch`、`openStream`、`loadBundle`——磁盘写入不属于其中；放在那里还会把一个能力摊到 transport 接口、connection handle 与消费方三处。它需要修改 `packages/client/connection`，而其 `ConnectionHandle` 会被复制进一份生成的检视目录，因此 diff 触及一个高频变动的生成产物却无所得。`dsh-client-file-upload` 早已确立“每能力一个插件、各自拥有全局对象”作为本仓库的答案。

**复用 `ownsHost`。** 它只喂给一个表达式 `isLoopback`。连接到 stock 服务器的 shell 并不拥有其 Host，因此该声明会是假的；它会对远程服务器错误授予 host 侧特权；而且仍然不提供任何写文件的手段。

**按远程或 non-loopback 模式切换。** 网络拓扑无法回答这个问题。指向被代理的远程部署的普通浏览器可以正常通过下载管理器保存，而 WebView 无论 authority 如何都会失败。载体是否存在能直接回答。

**通过 shell 的 transport `fetch` 执行预检，而不是跳过预检。** `RpcFetch` 具有 fetch 形状，但其约定是通用一元 RPC 通道，且唯一的在库内调用方只向 `/api` 通道 POST JSON。通过它预检某条功能路由会扩展一项隐式约定，并让单个消费方重新定义该 transport，同时增加一次往返，却不能告诉调用方任何载体不会告诉它的信息。

**把保存留在 `dsh-session-log-export` 内。** 该能力并非会话专用：它可寻址任意 Host 路径。留在那里会迫使下一个下载功能重新实现锚点、null-origin 替身与 hook 查找。

## Consequences

任何客户端功能现在都可以通过注入 `fileDownload` 保存 Host 文件，嵌入 shell 只需提供一个 hook 即可服务全部功能。导出插件注入 `fileDownload` 而不再构造自己的 saver，因此它在该服务之后激活；`dsh-web-app` 把该行直接挂在 `file-upload` 之后。

该 seam 刻意保持狭窄。它不报告目标位置、进度与取消，因为浏览器下载管理器一样都不暴露，而共享约定不能承诺某个载体无法交付的东西。因此 `'cancelled'` 取决于载体，其缺席并不能证明文件已落盘。

上传已有自己的 seam，本次未触及。`dsh-client-file-upload` 读取 `__DSH_FILE_UPLOAD__`，当 shell 提供它时会用直接的载体调用替换其 Blob Worker，因此嵌入 shell 无需本包即可上传。它的 worker 参数仍是测试 seam 而非 host seam——worker 主体被字符串化后以无参数方式调用——因此 shell 路径以 Worker 的 XHR 字节进度换取载体的普通响应。

## Testing

`packages/client/file-download/tests/file-download.client.spec.ts` 覆盖从页面全局对象选择载体、包含 null-origin 替身的锚点路径、委托给 shell hook 及其结果，以及 fiber 释放时服务被撤回。`packages/session-query/session-log-export/tests/controller.client.spec.ts` 覆盖被委托的保存请求、shell 拥有的载体跳过预检、`'cancelled'` 清除条目，以及拒绝的载体发布错误状态；`tests/client-apply.client.spec.tsx` 覆盖来自 `ctx.fileDownload` 的接线。既有的页面路径规格除构造函数外保持不变，这正是钉住所服务 web app 行为的依据。
