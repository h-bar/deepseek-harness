# Agent Note: Let a host supply the Remote stream carrier

Status: implemented

[English](2026-09-04-remote-stream-carrier-seam.md) | 中文

## Problem

`RemoteStreamMuxClient` 拥有 Gateway Remote 流传输中所有困难的部分：在单个 socket 上多路复用可独立取消的逻辑流、候选连接握手、按修订版本守护的重试、放弃即取消，以及载体断开时让每条流失败。其中只有一行不可移植：

```ts
const socket = new WebSocket(remoteStreamUrl())
```

必须控制请求 `Origin` 的宿主，或其 socket 是原生桥接而非页面 API 的宿主，无法使用该行，也就够不到其余部分。桌面应用重新实现了这个类——219 行，重复了流收件箱、帧联合类型、mux 路径常量与流 id 生成器，并越过包边界去取 `randomUUID`。该副本还是落后的：它没有 `start`、`reconnect`、`waitForSocket`、`lost` 或 `maintain` 的等价物，因此 socket 断开会让每条活动流失败，并等待下一次 `open()` 而不是重新建立连接。

## Decision

客户端从工厂获取其载体：

```ts
new RemoteStreamMuxClient({ openSocket: () => mySocket })
```

每次连接尝试都会调用 `openSocket`，因此重连会拿到新的 socket。默认值——页面 origin 上的浏览器 `WebSocket`——在构造函数中解析一次，而不是在每次尝试时解析，因此该分支不会在连接路径内被重新判定。

`RemoteStreamSocket` 命名客户端驱动的那组成员：`readyState`、覆盖四个事件的 `addEventListener`/`removeEventListener`、`send` 与 `close`。浏览器 `WebSocket` 在结构上满足它，因此默认实现不需要适配器，且该类型在编译期对照真实 `WebSocket` 校验。导出 `REMOTE_STREAM_SOCKET_OPEN` 是因为实现方需要客户端用来比较 `readyState` 的那个值，而该接口并不要求 `WebSocket` 携带的构造函数静态成员。

`RemoteStreamMuxClient`、socket 类型与 `REMOTE_STREAM_MUX_PATH` 从 `./client` 导出。`./client/stream` 是更窄的入口，只携带该模块，因此嵌入该载体的宿主不会连带打包它正在绕开的 Gateway 客户端。

## Consequences

提供载体的宿主仍然拥有自己 socket 的形态，以及它的失败。`normalizeConnectionStream` 通过读取 `dshRemoteStreamFailure` 标记而非 `instanceof`，跨独立打包的 transport 恢复 `RemoteError` 与 `RemoteStreamCarrierError`，因为两半持有这些类的不同副本。嵌入该载体的宿主从自己的副本抛出，因此它必须为离开其 bundle 的错误重新打标；`remote-stream.ts` 正是用这个检查来区分可重试的载体断开与终态失败。

## Alternatives considered

**接收 socket URL 而不是工厂。** 它能覆盖宿主想改变的 `Origin`，但覆盖不了根本不是 `WebSocket` 的 socket，而后者正是催生那份重复实现的场景。

**接收完整的 `WebSocket`。** 那会迫使每个宿主构建完整的 `WebSocket` 垫片——`readyState` 常量、关闭码、`MessageEvent`——而客户端只用到六个成员。正是命名这六个成员，才让原生桥接能用大约二十行满足它。
