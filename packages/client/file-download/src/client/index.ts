/** Browser Cordis service saving Host artifacts to the user's machine. */

import type { Context } from '@deepseek-ai/cordis'
import type { FileDownloadService } from './contract.ts'
import { FileDownloadRuntime } from './runtime.ts'

export type {
  FileDownloadHooks, FileDownloadOutcome, FileDownloadRequest, FileDownloadService,
} from './contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser service saving one Host artifact to the user's machine. */
    fileDownload: FileDownloadService
  }
}

/** Required services (none — the save carrier is chosen from the page global). */
export const inject: string[] = []

/**
 * Provide the browser artifact-save service.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FileDownloadRuntime)
}
