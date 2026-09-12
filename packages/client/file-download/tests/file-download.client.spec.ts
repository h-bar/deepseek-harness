// @vitest-environment jsdom
/**
 * File-download service: carrier selection off the page global, the page
 * download-manager fallback, and shell-owned save outcomes.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileDownloadHooks, FileDownloadService } from '../src/client/contract.ts'
import { apply, inject } from '../src/client/index.ts'
import { savePageDownload } from '../src/client/runtime.ts'

type Win = {
  location?: { origin?: string }
  __DSH_FILE_DOWNLOAD__?: FileDownloadHooks
}

const REQUEST = { path: '/api/session.export?sessionId=s1', suggestedFilename: 'archive.zip' }

afterEach(() => {
  delete (globalThis as Win).__DSH_FILE_DOWNLOAD__
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(): Promise<{ service: FileDownloadService; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const service = ctx.get('fileDownload')
  if (service === undefined) throw new Error('ctx.fileDownload not provided')
  return { service, dispose: async () => { await fiber.dispose() } }
}

describe('artifact download service', () => {
  it('saves through the browser download manager when no shell owns downloads', async () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:4820' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const mounted = await mount()

    expect(mounted.service.shellOwned).toBe(false)
    await expect(mounted.service.save(REQUEST)).resolves.toBe('saved')

    const anchor = click.mock.instances[0] as HTMLAnchorElement
    expect(anchor.href).toBe('http://127.0.0.1:4820/api/session.export?sessionId=s1')
    expect(anchor.download).toBe('archive.zip')
    await mounted.dispose()
  })

  it('resolves the path against the null-origin stand-in', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await expect(savePageDownload(REQUEST)).resolves.toBe('saved')

    expect((click.mock.instances[0] as HTMLAnchorElement).href)
      .toBe('http://dsh.internal/api/session.export?sessionId=s1')
  })

  it('delegates to the shell hook installed before boot and reports its outcome', async () => {
    const save = vi.fn(async () => 'cancelled' as const)
    ;(globalThis as Win).__DSH_FILE_DOWNLOAD__ = { save }
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const mounted = await mount()

    expect(mounted.service.shellOwned).toBe(true)
    await expect(mounted.service.save(REQUEST)).resolves.toBe('cancelled')

    expect(save).toHaveBeenCalledWith(REQUEST)
    expect(click).not.toHaveBeenCalled()
    await mounted.dispose()
  })

  it('withdraws the service when its fiber disposes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('fileDownload')).toBeDefined()

    await fiber.dispose()

    expect(ctx.get('fileDownload')).toBeUndefined()
  })
})
