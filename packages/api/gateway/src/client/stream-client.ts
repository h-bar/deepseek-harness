import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
/** Browser owner for the Gateway multiplexed Remote stream socket. */

import {
  parseRemoteStreamServerMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
  type RemoteStreamServerMessage,
} from '../stream-protocol.ts'
import { Deque } from '@deepseek-ai/dsh-deque'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export { REMOTE_STREAM_MUX_PATH } from '../stream-protocol.ts'

const INTERNAL_BASE = 'http://dsh.internal'

/** Physical Remote stream socket failure that may be retried by a domain transport. */
export class RemoteStreamCarrierError extends Error {
  /**
   * @param message - physical carrier failure description.
   * @param options - optional causal error.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteStreamCarrierError'
  }
}

/**
 * `readyState` of an open socket, fixed by the WebSocket protocol. Exported
 * because {@link RemoteStreamSocket} is not required to expose the constructor
 * statics a browser `WebSocket` carries, so an implementer needs the value this
 * client compares against.
 */
export const REMOTE_STREAM_SOCKET_OPEN = 1

/**
 * The physical carrier this client drives. A browser `WebSocket` satisfies it,
 * and so does any `EventTarget` that dispatches the four events below, because
 * listeners are typed against `Event` exactly as the DOM types them. A host
 * that cannot use a page `WebSocket` — because it must control the request
 * `Origin`, or because its socket is a native bridge — supplies its own through
 * {@link RemoteStreamMuxOptions.openSocket} instead of reimplementing the
 * multiplexing, retry, and cancellation this class owns.
 *
 * Events read: `open` and `error` settle a connection attempt, `close` ends
 * every stream on the carrier, and `message` must carry the server frame as a
 * string on `data`.
 */
export interface RemoteStreamSocket {
  /** Connection state; {@link REMOTE_STREAM_SOCKET_OPEN} means writable. */
  readonly readyState: number
  /**
   * Subscribe to one carrier event.
   * @param type - event name.
   * @param listener - receives the dispatched event.
   * @param options - `once` removes the listener after it fires.
   */
  addEventListener(
    type: 'open' | 'error' | 'close' | 'message',
    listener: (event: Event) => void,
    options?: { once?: boolean },
  ): void
  /**
   * Remove a previously subscribed listener.
   * @param type - event name.
   * @param listener - the same reference passed to `addEventListener`.
   */
  removeEventListener(
    type: 'open' | 'error' | 'close' | 'message',
    listener: (event: Event) => void,
  ): void
  /**
   * Send one text frame.
   * @param data - the encoded client message.
   */
  send(data: string): void
  /**
   * Close the carrier.
   * @param code - optional close code.
   * @param reason - optional close reason.
   */
  close(code?: number, reason?: string): void
}

/** Construction options for {@link RemoteStreamMuxClient}. */
export interface RemoteStreamMuxOptions {
  /**
   * Open one physical carrier. Called for every connection attempt, so a
   * reconnect gets a fresh socket. Defaults to a browser `WebSocket` on the
   * page origin. It is called synchronously and its listeners are attached
   * before control returns, so a carrier that opens immediately is not missed.
   *
   * Refuse by throwing. A refusal is not a carrier drop — no carrier was
   * created, and only the host can say whether the reason is transient — so it
   * reaches the waiting streams unchanged rather than as a
   * {@link RemoteStreamCarrierError}, and a consumer that retries carrier drops
   * ends the stream instead.
   * @returns the carrier to drive.
   */
  openSocket?: () => RemoteStreamSocket
}

interface SocketWaiter {
  readonly revision: number
  resolve(socket: RemoteStreamSocket): void
  reject(error: unknown): void
}

/** Keep one physical WebSocket and share it among independently cancellable Remote streams. */
export class RemoteStreamMuxClient {
  private readonly openSocket: () => RemoteStreamSocket
  private socket: RemoteStreamSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private revision = 0
  private readonly streams = new Map<string, StreamInbox>()
  private readonly waiters = new Set<SocketWaiter>()
  private running = false
  private disposed = false

  /**
   * @param options - carrier construction; the default browser `WebSocket`
   * factory is resolved here rather than at each connection attempt.
   */
  constructor(options: RemoteStreamMuxOptions = {}) {
    this.openSocket = options.openSocket ?? ((): RemoteStreamSocket => new WebSocket(remoteStreamUrl()))
  }

  /** Ensure a physical attempt exists, following the current attempt once if needed. */
  start(): void {
    if (this.disposed) return
    this.running = true
    if (this.socket?.readyState === REMOTE_STREAM_SOCKET_OPEN) return
    const pending = this.keepAlive
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /** Cancel the current socket or retry wait and start a fresh attempt immediately. */
  reconnect(): void {
    if (!this.running || this.disposed) return
    const failure = new RemoteStreamCarrierError('api gateway: Remote stream reconnect requested')
    const pending = this.keepAlive
    this.revision++
    this.cancelCandidate?.(failure)
    const socket = this.socket
    if (socket !== undefined) {
      this.socket = undefined
      this.failAll(failure)
      socket.close(4000, 'reconnect requested')
    }
    if (pending === undefined) this.maintain()
    else void pending.then(() => { this.maintain() })
  }

  /**
   * Open one logical stream on the persistent physical connection.
   * If no physical attempt is active, opening waits for Connection to request
   * one or for the signal to abort.
   * @param endpoint - Typert Remote stream endpoint.
   * @param payload - endpoint request encoded on the wire.
   * @param signal - cancellation for this logical stream.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator {
    signal.throwIfAborted()
    const streamId = randomUUID()
    const inbox = new StreamInbox()
    let carrier: RemoteStreamSocket | undefined
    let opened = false
    let terminal = false
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      carrier = socket
      this.streams.set(streamId, inbox)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      while (true) {
        const frame = await inbox.next()
        signal.throwIfAborted()
        if (frame.type === 'item') {
          yield frame.value
          continue
        }
        terminal = true
        if (frame.type === 'error') {
          throw new RemoteError(frame.error.code as never, frame.error.message, frame.error.details as never)
        }
        return
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.streams.delete(streamId)
      if (opened && !terminal && carrier?.readyState === REMOTE_STREAM_SOCKET_OPEN) {
        this.send(carrier, { type: 'cancel', streamId })
      }
    }
  }

  /**
   * Permanently stop the carrier, close the physical socket, and fail every
   * active logical stream.
   * @returns once the active connection attempt has stopped.
   */
  async close(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      this.running = false
      const error = new Error('api gateway: Remote stream client disposed')
      this.failAll(error)
      for (const waiter of [...this.waiters]) waiter.reject(error)
      this.cancelCandidate?.(error)
      const socket = this.socket
      this.socket = undefined
      socket?.close(1000, 'disposed')
    }
    await this.keepAlive
  }

  private connect(): Promise<RemoteStreamSocket> {
    let socket: RemoteStreamSocket
    try {
      socket = this.openSocket()
    } catch (error) {
      // A refusal settles this attempt. Returning a rejection rather than
      // letting the throw escape keeps it inside the retry machinery, which
      // `maintain()` relies on to reject the waiting streams.
      // The carrier's refusal reason belongs to the caller and may be a non-Error.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      return Promise.reject(error)
    }
    const connecting = new Promise<RemoteStreamSocket>((resolve, reject) => {
      let settled = false
      const rejectCandidate = (error: Error): void => {
        settled = true
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('message', received)
        socket.removeEventListener('close', closed)
        this.cancelCandidate = undefined
        socket.close()
        reject(error)
      }
      const opened = (): void => {
        settled = true
        this.cancelCandidate = undefined
        this.socket = socket
        for (const waiter of [...this.waiters]) waiter.resolve(socket)
        resolve(socket)
      }
      const failed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket failed to open',
          ))
          return
        }
        const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed')
        this.lost(socket, error)
        socket.close()
      }
      const closed = (): void => {
        if (!settled) {
          rejectCandidate(new RemoteStreamCarrierError(
            'api gateway: Remote stream WebSocket closed before opening',
          ))
          return
        }
        this.lost(socket)
      }
      // Only a `message` reaches this listener, and the carrier contract requires
      // it to carry the frame on `data`.
      const received = (event: Event): void => { this.receive(socket, (event as MessageEvent).data) }
      this.cancelCandidate = rejectCandidate
      socket.addEventListener('open', opened, { once: true })
      socket.addEventListener('error', failed, { once: true })
      socket.addEventListener('message', received)
      socket.addEventListener('close', closed, { once: true })
    })
    return connecting
  }

  private waitForSocket(signal: AbortSignal): Promise<RemoteStreamSocket> {
    signal.throwIfAborted()
    if (this.socket?.readyState === REMOTE_STREAM_SOCKET_OPEN) return Promise.resolve(this.socket)
    if (this.disposed) return Promise.reject(new Error('api gateway: Remote stream client disposed'))
    if (!this.running) return Promise.reject(new Error('api gateway: Remote stream client not started'))
    return new Promise((resolve, reject) => {
      const aborted = (): void => { waiter.reject(signal.reason) }
      const cleanup = (): void => {
        this.waiters.delete(waiter)
        signal.removeEventListener('abort', aborted)
      }
      const waiter: SocketWaiter = {
        revision: this.revision,
        resolve: (socket) => {
          cleanup()
          resolve(socket)
        },
        reject: (error) => {
          cleanup()
          // AbortSignal.reason belongs to the caller and may intentionally be a non-Error sentinel.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        },
      }
      this.waiters.add(waiter)
      signal.addEventListener('abort', aborted, { once: true })
    })
  }

  private receive(socket: RemoteStreamSocket, data: unknown): void {
    if (socket !== this.socket) return
    try {
      if (typeof data !== 'string') throw new Error('api gateway: Remote stream WebSocket requires text messages')
      const frame = parseRemoteStreamServerMessage(data)
      this.streams.get(frame.streamId)?.push(frame)
    } catch (error) {
      const failure = new RemoteStreamCarrierError('api gateway: invalid Remote stream frame', { cause: error })
      this.failAll(failure)
      this.lost(socket, failure)
      socket.close(4002, 'invalid Remote stream frame')
    }
  }

  private lost(
    socket: RemoteStreamSocket,
    error: RemoteStreamCarrierError = new RemoteStreamCarrierError(
      'api gateway: Remote stream WebSocket closed',
    ),
  ): void {
    if (this.socket !== socket) return
    this.socket = undefined
    this.failAll(error)
  }

  private maintain(): void {
    if (!this.running || this.disposed) return
    if (this.socket?.readyState === REMOTE_STREAM_SOCKET_OPEN || this.keepAlive !== undefined) return
    const revision = this.revision
    const task = this.connect().then(
      () => undefined,
      (error: unknown) => {
        if (!this.running) return
        for (const waiter of [...this.waiters]) {
          if (waiter.revision <= revision) waiter.reject(error)
        }
      },
    )
    this.keepAlive = task
    void task.then(() => {
      this.keepAlive = undefined
    })
  }

  private failAll(error: unknown): void {
    for (const stream of this.streams.values()) stream.fail(error)
  }

  private send(socket: RemoteStreamSocket, message: RemoteStreamClientMessage): void {
    socket.send(JSON.stringify(message))
  }
}

class StreamInbox {
  private readonly frames = new Deque<RemoteStreamServerMessage>()
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(frame: RemoteStreamServerMessage): void {
    if (this.failure !== undefined) return
    this.frames.pushBack(frame)
    this.wake?.()
    this.wake = undefined
  }

  fail(error: unknown): void {
    if (this.failure !== undefined) return
    this.failure = error instanceof Error ? error : new Error(String(error), { cause: error })
    this.frames.clear()
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<RemoteStreamServerMessage> {
    while (this.frames.size === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
    return this.frames.popFront() as RemoteStreamServerMessage
  }
}

function remoteStreamUrl(): string {
  const location = (globalThis as { location?: { origin?: string } }).location
  const base = location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
  const url = new URL(REMOTE_STREAM_MUX_PATH, base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
