# Agent Note: Let a host supply the Remote stream carrier

Status: implemented

English | [中文](2026-09-04-remote-stream-carrier-seam.zh.md)

## Problem

`RemoteStreamMuxClient` owns everything hard about the Gateway's Remote stream transport: multiplexing independently cancellable logical streams over one socket, the candidate-connection handshake, revision-guarded retry, cancel-on-abandon, and failing every stream when the carrier drops. One line of it is not portable:

```ts
const socket = new WebSocket(remoteStreamUrl())
```

A host that must control the request `Origin`, or whose socket is a native bridge rather than a page API, cannot use that line and could not reach the rest. The desktop app reimplemented the class — 219 lines duplicating the stream inbox, the frame union, the mux path constant, and a stream-id generator, and reaching past the package for `randomUUID`. The copy was also behind: it had no equivalent of `start`, `reconnect`, `waitForSocket`, `lost`, or `maintain`, so a dropped socket failed every live stream and waited for the next `open()` instead of re-establishing.

## Decision

The client takes its carrier from a factory:

```ts
new RemoteStreamMuxClient({ openSocket: () => mySocket })
```

`openSocket` is called for every connection attempt, so a reconnect gets a fresh socket. The default — a browser `WebSocket` on the page origin — is resolved once in the constructor rather than at each attempt, so the branch is not re-decided inside the connection path.

`RemoteStreamSocket` names the surface the client drives: `readyState`, `addEventListener`/`removeEventListener` over a four-event map, `send`, and `close`. A browser `WebSocket` satisfies it structurally, so the default needs no adapter and the type is checked against a real one at compile time. `REMOTE_STREAM_SOCKET_OPEN` is exported because an implementer needs the value the client compares `readyState` against, and the interface does not require the constructor statics a `WebSocket` carries.

`RemoteStreamMuxClient`, the socket types, and `REMOTE_STREAM_MUX_PATH` are exported from `./client`. `./client/stream` is a narrower entry carrying only this module, so a host embedding the carrier does not also bundle the Gateway client it is bypassing.

## Consequences

A supplying host still owns its socket's shape, and its failures. `normalizeConnectionStream` recovers `RemoteError` and `RemoteStreamCarrierError` across a separately bundled transport by reading a `dshRemoteStreamFailure` marker rather than `instanceof`, because the two halves hold different copies of the classes. A host that embeds this carrier throws from its own copy, so it must re-mark what leaves its bundle; `remote-stream.ts` distinguishes a retryable carrier drop from a terminal failure with exactly that check.

## Alternatives considered

**Take a socket URL instead of a factory.** It covers an `Origin` a host wants to change but not a socket that is not a `WebSocket` at all, which is the case that forced the duplicate.

**Accept a full `WebSocket`.** It would make every host build a complete `WebSocket` shim — `readyState` constants, close codes, `MessageEvent` — where the client uses six members. Naming the six is what lets a native bridge satisfy it in about twenty lines.
