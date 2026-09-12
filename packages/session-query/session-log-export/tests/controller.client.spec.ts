// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionLogDownloadController, sessionLogZipFilename } from '../src/client/controller.ts'

/** Page-owned save: the served browser's carrier. */
function pageDownloads(save = vi.fn(async () => 'saved' as const)) {
  return { shellOwned: false, save }
}

/** Shell-owned save: an embedding shell's carrier. */
function shellDownloads(save: () => Promise<'saved' | 'cancelled'>) {
  return { shellOwned: true, save: vi.fn(save) }
}

const SID = 'session-export-controller' as SessionId

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SessionLogDownloadController', () => {
  it('downloads the host ZIP and publishes one shared success state', async () => {
    const fetcher = vi.fn(async () => new Response('zip', { status: 200 }))
    const save = vi.fn()
    const controller = new SessionLogDownloadController(pageDownloads(save), fetcher)

    await controller.download(SID)

    expect(fetcher).toHaveBeenCalledOnce()
    const [route, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(route).toBe(`api/session.export?sessionId=${SID}&includeDescendants=true`)
    expect(init.method).toBe('HEAD')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(save).toHaveBeenCalledWith({
      path: `/${route}`,
      suggestedFilename: 'dsh-session-session-export-controller.zip',
    })
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'success', error: null,
    })
  })

  it('collapses concurrent gestures and preserves a dismissed dialog', async () => {
    const response = Promise.withResolvers<Response>()
    const fetcher = vi.fn(() => response.promise)
    const controller = new SessionLogDownloadController(pageDownloads(), fetcher)

    const first = controller.download(SID)
    const second = controller.download(SID)
    expect(first).toBe(second)
    controller.dismiss(SID)
    response.resolve(new Response('zip', { status: 200 }))
    await first

    expect(fetcher).toHaveBeenCalledOnce()
    expect(controller.store.getSnapshot().bySession[SID]?.open).toBe(false)
    controller.dismiss(SID)
  })

  it('publishes HTTP and transport failures without leaking rejections', async () => {
    const http = new SessionLogDownloadController(
      pageDownloads(), async () => new Response('backend unavailable', { status: 500 }),
    )
    await http.download(SID)
    expect(http.store.getSnapshot().bySession[SID]).toEqual({
      open: true,
      status: 'error',
      error: 'Export failed: HTTP 500 backend unavailable',
    })

    const transport = new SessionLogDownloadController(pageDownloads(), async () => { throw 'offline' })
    await transport.download(SID)
    expect(transport.store.getSnapshot().bySession[SID]?.error).toBe('offline')

    transport.dismiss('absent' as SessionId)

    const emptyDetail = new SessionLogDownloadController(
      pageDownloads(),
      async () => ({
        ok: false, status: 503, text: async () => { throw new Error('body unavailable') },
      }) as unknown as Response,
    )
    await emptyDetail.download(SID)
    expect(emptyDetail.store.getSnapshot().bySession[SID]?.error).toBe('Export failed: HTTP 503')
  })

  it('aborts active fetches on disposal and rejects later requests', async () => {
    let signal: AbortSignal | undefined
    const fetcher = vi.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined
      signal?.addEventListener('abort', () => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }, { once: true })
    }))
    const controller = new SessionLogDownloadController(pageDownloads(), fetcher)
    const pending = controller.download(SID)

    await controller.dispose()

    await expect(pending).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    await expect(controller.download(SID)).resolves.toBeUndefined()
    await controller.dispose()
  })

  it('requests the document-relative route through the default carrier', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('zip'))
    vi.stubGlobal('fetch', fetcher)
    const controller = new SessionLogDownloadController(pageDownloads())

    await controller.download(SID)

    expect(fetcher.mock.calls[0]?.[0]).toBe(`api/session.export?sessionId=${SID}&includeDescendants=true`)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'HEAD' })
  })

  it('lets a shell-owned carrier skip the page preflight', async () => {
    const fetcher = vi.fn(async () => new Response('zip', { status: 200 }))
    const downloads = shellDownloads(async () => 'saved')
    const controller = new SessionLogDownloadController(downloads, fetcher)

    await controller.download(SID)

    expect(downloads.save).toHaveBeenCalledWith({
      path: `/api/session.export?sessionId=${SID}&includeDescendants=true`,
      suggestedFilename: 'dsh-session-session-export-controller.zip',
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'success', error: null,
    })
  })

  it('clears the entry when the save is cancelled', async () => {
    const controller = new SessionLogDownloadController(shellDownloads(async () => 'cancelled'))

    await controller.download(SID)

    expect(controller.store.getSnapshot().bySession[SID]).toBeUndefined()
  })

  it('publishes the error state when the save rejects', async () => {
    const controller = new SessionLogDownloadController(
      shellDownloads(async () => { throw new Error('save dialog unavailable') }),
    )

    await controller.download(SID)

    expect(controller.store.getSnapshot().bySession[SID]).toEqual({
      open: true, status: 'error', error: 'save dialog unavailable',
    })
  })

  it('defaults dialog openness when state is externally cleared before settlement', async () => {
    const success = Promise.withResolvers<Response>()
    const successful = new SessionLogDownloadController(pageDownloads(), () => success.promise)
    const successRun = successful.download(SID)
    successful.store.set({ bySession: {} })
    success.resolve(new Response('zip'))
    await successRun
    expect(successful.store.getSnapshot().bySession[SID]?.open).toBe(true)

    const failure = Promise.withResolvers<Response>()
    const failing = new SessionLogDownloadController(pageDownloads(), () => failure.promise)
    const failureRun = failing.download(SID)
    failing.store.set({ bySession: {} })
    failure.reject(new Error('failed after clear'))
    await failureRun
    expect(failing.store.getSnapshot().bySession[SID]?.open).toBe(true)
  })
})

describe('archive filename', () => {
  it('collapses an untrusted Session id into one safe download name', () => {
    expect(sessionLogZipFilename('a/b' as SessionId)).toBe('dsh-session-a_b.zip')
  })
})
