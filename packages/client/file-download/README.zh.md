---
description: "把 Host 文件保存到用户机器：经浏览器下载管理器，或经嵌入 shell 自己的保存载体。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-file-download

[English](README.md) | 中文

## 概述

本包为浏览器功能提供把 Host 文件放到用户机器上的统一方式。所服务的页面把文件交给浏览器下载管理器；通过嵌入 shell 访问 Host 的页面则交给该 shell 在 Cordis 启动前提供的保存载体。调用方以 Host 相对路径寻址文件，且只知道文件已保存还是人已取消保存，因为目标位置属于执行传输的那个载体。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

注入 `fileDownload` 并调用 `save({ path, suggestedFilename })`。`path` 是 Host 相对的 `/api/…` 路径，绝不是绝对 URL，因此 shell 载体会校验它并通过自己的已认证连接执行传输。`suggestedFilename` 是浏览器下载名，或 shell 保存对话框的预填名。

结果为 `'saved'` 或 `'cancelled'`。`'cancelled'` 表示人关闭了保存对话框；它既不是成功也不是失败，因此展示进度的调用方会关闭进度而不宣告结果。只有能观察到关闭动作的载体才会产生它——浏览器下载管理器不报告关闭，因此页面路径在移交传输后总是落到 `'saved'`。

`shellOwned` 告诉调用方页面是否仍在执行传输。当它为 true 时，页面既不持有字节也不持有 Host 凭据，因此对同一路径的同源预检毫无意义，调用方会跳过它；载体通过 reject 报告自身失败。

嵌入 shell 在插件启动前把载体安装到 `globalThis.__DSH_FILE_DOWNLOAD__`，方式与安装 transport 载体相同：

```ts
globalThis.__DSH_FILE_DOWNLOAD__ = {
  async save({ path, suggestedFilename }) {
    return (await hostSaveDialog(path, suggestedFilename)) ? 'saved' : 'cancelled'
  },
}
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`FileDownloadRuntime` 在构造期间读取一次页面全局对象，并在页面生命周期内固定其载体，与 transport 载体的固定方式完全一致。没有 hook 时它使用 `savePageDownload`：把 Host 相对路径相对页面 origin 解析——null origin 时回退到 connection 载体的 `http://dsh.internal` 替身——设置锚点的 `download` 属性并激活它。

node half 是一个空 `apply`。它存在是为了让插件出现在宿主 `cordis.yml` 与 Loader 中；浏览器 half 通过 `exports["./client"]` 发布。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-client-file-upload](../file-upload/README.zh.md)——对称能力，以相同方式选择载体。
- [dsh-client-connection](../connection/README.zh.md)——提供 Host 下载路径的已认证载体。
- [dsh-session-log-export](../../session-query/session-log-export/README.zh.md)——当前消费方，保存 Session 归档。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只把 Host 文件保存到本地，不贡献任何模型输入。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **从不报告目标位置**——它属于载体，因此调用方无法展示、打开或定位已保存的文件。
- **没有进度，也没有取消**——`save` 只结算一次，没有字节观察者，也没有 `AbortSignal`。浏览器下载管理器两者都不暴露，因此共享约定只能为 shell 载体报告它们。
- **`'cancelled'` 取决于载体**——页面拥有的保存无法区分被关闭的浏览器提示与已完成的提示，因此调用方不能把没有 `'cancelled'` 当作文件已落盘的证据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。载体只从页面全局对象选择一次，并由行为测试直接覆盖；不存在独立观察可能分叉的自有关系。
