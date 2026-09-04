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

interface UplinkPump {
  /** Settles once the pump has stopped sending. */
  readonly done: Promise<void>
  /** Interrupt the pump, including a read blocked on the caller's iterator, and release the iterator. */
  stop(): void
}

/** One open logical stream: its downlink frames and, once the `open` frame is out, its uplink pump. */
interface LogicalStream {
  readonly inbox: StreamInbox
  pump: UplinkPump | undefined
}

const UPLINK_DONE: IteratorReturnResult<undefined> = { value: undefined, done: true }

/**
 * Keep one physical WebSocket and share it among independently cancellable
 * Remote streams. A carrier that supplies an in-process stream opener never
 * starts one.
 */
export class RemoteStreamMuxClient {
  private readonly openSocket: () => RemoteStreamSocket
  private socket: RemoteStreamSocket | undefined
  private cancelCandidate: ((error: Error) => void) | undefined
  private keepAlive: Promise<void> | undefined
  private revision = 0
  private readonly streams = new Map<string, LogicalStream>()
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
   * @param uplink - the Client's items: each is sent as an `item` frame, its end as `end`; its `return()`
   * runs when the stream finishes, and its failure cancels the stream and fails the downlink.
   * @returns Host items until completion, cancellation, or failure.
   */
  async *open(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncGenerator {
    signal.throwIfAborted()
    const streamId = randomUUID()
    const inbox = new StreamInbox()
    const stream: LogicalStream = { inbox, pump: undefined }
    let carrier: RemoteStreamSocket | undefined
    let opened = false
    let terminal = false
    const abort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const socket = await this.waitForSocket(signal)
      signal.throwIfAborted()
      carrier = socket
      this.streams.set(streamId, stream)
      this.send(socket, { type: 'open', streamId, endpoint, payload })
      opened = true
      if (uplink !== undefined) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox)
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
      stream.pump?.stop()
      if (opened && !terminal && carrier?.readyState === REMOTE_STREAM_SOCKET_OPEN) {
        this.send(carrier, { type: 'cancel', streamId })
      }
      // The old generation's pump has stopped before a supervisor reopens the next one.
      if (stream.pump !== undefined) await stream.pump.done
    }
  }

  /**
   * Send the caller's uplink items on this generation's socket. `stop()`
   * interrupts a pump blocked on `uplink.next()` and releases the iterator: a
   * handle's queue closes at once, so `send()` throws from then on, and any
   * other iterator's `return()` is invoked without being awaited because a
   * generator blocked in `next()` only completes it once it yields.
   */
  private pumpUplink(
    socket: RemoteStreamSocket,
    streamId: string,
    uplink: AsyncIterable<unknown>,
    signal: AbortSignal,
    inbox: StreamInbox,
  ): UplinkPump {
    let stopped: PromiseWithResolvers<IteratorReturnResult<undefined>> | undefined
    const interruption: IteratorReturnResult<undefined> = { value: undefined, done: true }
    const uplinkIterator = uplink[Symbol.asyncIterator]()
    const state = { stopping: false, exhausted: false, released: false }
    const release = (): void => {
      if (state.released || state.exhausted) return
      state.released = true
      if (uplink instanceof ClientUplinkQueue) uplink.close()
      void Promise.resolve().then(() => uplinkIterator.return?.()).catch(() => undefined)
    }
    const done = (async (): Promise<void> => {
      try {
        while (true) {
          const stoppingBeforeRead = state.stopping
          if (stoppingBeforeRead) return
          // A stop promise belongs to one read, not the whole uplink history.
          stopped = Promise.withResolvers<IteratorReturnResult<undefined>>()
          const next = await Promise.race([uplinkIterator.next(), stopped.promise])
          stopped = undefined
          if (state.stopping || next === interruption || signal.aborted || this.socket !== socket) return
          if (next.done === true) {
            state.exhausted = true
            break
          }
          this.send(socket, { type: 'item', streamId, value: next.value })
        }
        this.send(socket, { type: 'end', streamId })
      } catch (error) {
        inbox.fail(error)
      } finally {
        stopped = undefined
        release()
      }
    })()
    return {
      done,
      stop: () => {
        if (state.stopping) return
        state.stopping = true
        stopped?.resolve(interruption)
        release()
      },
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
      const stream = this.streams.get(frame.streamId)
      if (stream === undefined) return
      stream.inbox.push(frame)
      // A terminal frame ends the uplink now, not on the consumer's next read.
      if (frame.type !== 'item') stream.pump?.stop()
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
    for (const stream of this.streams.values()) {
      stream.inbox.fail(error)
      stream.pump?.stop()
    }
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

/**
 * Uplink items a stream handle queues for its carrier: the mux pump or the
 * in-process Host decoder iterates it as the stream's uplink. `end()` is the
 * Client half-close; `close()` marks the stream terminated, after which
 * `push()` throws. One consumer reads it, one read at a time.
 */
export class ClientUplinkQueue implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  private readonly items = new Deque<unknown>()
  private ended = false
  private closed = false
  private wake: (() => void) | undefined

  /** @param endpoint - canonical Remote endpoint named by failures. */
  constructor(private readonly endpoint: string) {}

  /**
   * Queue one item for the carrier.
   * @param item - item the Host validates against the method's uplink codec.
   * @throws {Error} after `end()` or once the stream has terminated.
   */
  push(item: unknown): void {
    if (this.closed) throw new Error(`client api: ${this.endpoint} stream has terminated`)
    if (this.ended) throw new Error(`client api: ${this.endpoint} uplink was ended`)
    this.items.pushBack(item)
    this.signal()
  }

  /** Half-close: the carrier reads the queued items, then `end`. Idempotent; ignored after termination. */
  end(): void {
    if (this.ended || this.closed) return
    this.ended = true
    this.signal()
  }

  /** The carrier stopped reading: the logical stream terminated or was disposed. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.items.clear()
    this.signal()
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this
  }

  /**
   * Take the next queued item, waiting for one; ends after `end()` or `close()`.
   * @returns the next item, or the end of the uplink.
   * @throws {Error} when a read is already pending.
   */
  async next(): Promise<IteratorResult<unknown>> {
    while (true) {
      if (this.closed) return UPLINK_DONE
      if (this.items.size > 0) return { value: this.items.popFront(), done: false }
      if (this.ended) return UPLINK_DONE
      if (this.wake !== undefined) throw new Error(`client api: ${this.endpoint} uplink has one pending read`)
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }

  /**
   * The carrier is done with the uplink: close it.
   * @returns the end of the uplink.
   */
  return(): Promise<IteratorResult<unknown>> {
    this.close()
    return Promise.resolve(UPLINK_DONE)
  }

  private signal(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

function remoteStreamUrl(): string {
  // The mux route is registered absolute; a page resolves its document-relative
  // form against its own document base. A shell-owned Host on another origin
  // supplies that base through the transport.
  const globals = globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }
  const url = new URL(REMOTE_STREAM_MUX_PATH.slice(1), globals.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
