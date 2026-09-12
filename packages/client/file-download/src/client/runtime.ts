/** Browser artifact-save service and its page download-manager carrier. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  FileDownloadHooks, FileDownloadOutcome, FileDownloadRequest, FileDownloadService,
} from './contract.ts'

/** Resolve the browser's Host base with the null-origin fallback, as each page-origin caller does locally. */
function pageHostBase(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

interface FileDownloadGlobal {
  __DSH_FILE_DOWNLOAD__?: FileDownloadHooks
}

/**
 * Hand one Host artifact to the browser download manager.
 *
 * The browser chooses the destination and reports no dismissal, so this
 * settles `saved` once the anchor is activated rather than when bytes land.
 * @param request - Host-relative path and filename suggestion.
 * @returns `saved`, the only outcome the download manager exposes.
 */
export function savePageDownload(
  request: FileDownloadRequest,
): Promise<FileDownloadOutcome> {
  const anchor = document.createElement('a')
  anchor.href = new URL(request.path, pageHostBase()).toString()
  anchor.download = request.suggestedFilename
  anchor.click()
  return Promise.resolve('saved')
}

/** Cordis service selecting the shell's save carrier or the page's. */
export class FileDownloadRuntime extends Service implements FileDownloadService {
  readonly shellOwned: boolean
  private readonly carrier: (request: FileDownloadRequest) => Promise<FileDownloadOutcome>

  /** @param ctx - providing Client context. */
  constructor(ctx: Context) {
    super(ctx, 'fileDownload')
    // The shell installs its hook before plugin boot, so the carrier is fixed
    // for the page lifetime exactly as the transport carrier is.
    const hook = (globalThis as FileDownloadGlobal).__DSH_FILE_DOWNLOAD__
    this.shellOwned = hook !== undefined
    this.carrier = hook === undefined ? savePageDownload : request => hook.save(request)
  }

  /**
   * Save one Host artifact through the carrier selected at construction.
   * @param request - Host-relative path and filename suggestion.
   * @returns whether the artifact was saved or the human dismissed the save.
   */
  save(request: FileDownloadRequest): Promise<FileDownloadOutcome> {
    return this.carrier(request)
  }
}
