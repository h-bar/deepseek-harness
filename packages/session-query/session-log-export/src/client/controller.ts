/** Browser download state shared by the Session Header button and `/export`. */

import type { FileDownloadService } from '@deepseek-ai/dsh-client-file-download/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SESSION_LOG_EXPORT_PATH, SESSION_LOG_EXPORT_ROUTE } from '../routes.ts'

/** Download phases presented by the shared modal. */
export type SessionLogDownloadStatus = 'downloading' | 'success' | 'error'

/** One Session's current download-dialog state. */
export interface SessionLogDownloadEntry {
  readonly open: boolean
  readonly status: SessionLogDownloadStatus
  readonly error: string | null
}

/** Download states keyed by the Session whose Header owns the dialog. */
export interface SessionLogDownloadState {
  bySession: Record<string, SessionLogDownloadEntry | undefined>
}

/** HTTP carrier for the export route. */
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

const INITIAL: SessionLogDownloadState = { bySession: {} }

/**
 * Collapse an untrusted Session id into the filename convention owned by the host endpoint.
 * @param sessionId - Session whose archive is downloaded.
 * @returns one safe browser download filename.
 */
export function sessionLogZipFilename(sessionId: SessionId): string {
  return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}.zip`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Owns one in-flight browser download per Session and publishes modal state. */
export class SessionLogDownloadController {
  /** uSES-safe state source shared by every Session-scoped modal contribution. */
  readonly store: SnapshotStore<SessionLogDownloadState> = createSnapshotStore(INITIAL)

  private readonly active = new Map<SessionId, { readonly abort: AbortController; readonly done: Promise<void> }>()
  private disposed = false

  /**
   * @param downloads - file-download service that owns the local destination.
   * @param fetcher - HTTP carrier used to pre-probe the host-streamed ZIP.
   */
  constructor(
    private readonly downloads: FileDownloadService,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {}

  /**
   * Download one Session tree; concurrent gestures for the same Session share one operation.
   * @param sessionId - root Session whose ZIP includes descendants and attachments.
   * @returns after the save settles as taken or cancelled, an error state is
   * published, or a late post-disposal request is ignored. A page save settles
   * when the download manager accepts the transfer; a shell save settles when
   * the human answers.
   */
  download(sessionId: SessionId): Promise<void> {
    const existing = this.active.get(sessionId)
    if (existing !== undefined) return existing.done
    if (this.disposed) return Promise.resolve()
    const abort = new AbortController()
    const done = this.run(sessionId, abort.signal).finally(() => {
      this.active.delete(sessionId)
    })
    this.active.set(sessionId, { abort, done })
    return done
  }

  /**
   * Close one Session's dialog without cancelling an in-flight browser download.
   * @param sessionId - Session whose modal closes.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot().bySession[String(sessionId)]
    if (current === undefined || !current.open) return
    this.publish(sessionId, { ...current, open: false })
  }

  /**
   * Abort active preflights and reach quiescence. A shell-owned save takes no
   * cancellation, so an open save dialog is waited out rather than aborted.
   * @returns after every active operation settles.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.active.values()]
    for (const operation of active) operation.abort.abort()
    await Promise.allSettled(active.map(operation => operation.done))
  }

  private async run(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.publish(sessionId, { open: true, status: 'downloading', error: null })
    try {
      const query = new URLSearchParams({ sessionId, includeDescendants: 'true' })
      const route = `${SESSION_LOG_EXPORT_ROUTE}?${query.toString()}`
      // The preflight is a page-origin request: meaningful only while the page
      // also performs the transfer. A shell-owned carrier holds the Host
      // credential and reports its own failures.
      if (!this.downloads.shellOwned) {
        const response = await this.fetcher(route, { method: 'HEAD', signal })
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new Error(`Export failed: HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
        }
      }
      const outcome = await this.downloads.save({
        path: `${SESSION_LOG_EXPORT_PATH}?${query.toString()}`,
        suggestedFilename: sessionLogZipFilename(sessionId),
      })
      // A dismissed save dialog is neither success nor error: drop the entry so
      // the modal closes without announcing an outcome.
      if (outcome === 'cancelled') {
        this.clear(sessionId)
        return
      }
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'success', error: null })
    } catch (error: unknown) {
      if (signal.aborted) return
      const open = this.store.getSnapshot().bySession[String(sessionId)]?.open ?? true
      this.publish(sessionId, { open, status: 'error', error: messageOf(error) })
    }
  }

  private clear(sessionId: SessionId): void {
    this.store.update((state) => {
      const dropped = String(sessionId)
      state.bySession = Object.fromEntries(
        Object.entries(state.bySession).filter(([id]) => id !== dropped),
      )
    })
  }

  private publish(sessionId: SessionId, entry: SessionLogDownloadEntry): void {
    this.store.update((state) => {
      state.bySession = { ...state.bySession, [String(sessionId)]: entry }
    })
  }
}
