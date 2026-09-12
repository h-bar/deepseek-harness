/** Browser contract for saving one Host artifact to the user's machine. */

/** One Host artifact to save locally. */
export interface FileDownloadRequest {
  /**
   * Host-relative `/api/…` path, never an absolute URL, so an embedding shell
   * validates it and routes the transfer through its own authenticated carrier.
   */
  readonly path: string
  /** Filename suggestion: the browser download name, or the shell's save-dialog prefill. */
  readonly suggestedFilename: string
}

/**
 * Result of one save. `cancelled` is reachable only where the client observes a
 * dismissal; the browser download manager reports none, so the page path always
 * settles `saved` once the transfer is handed over.
 */
export type FileDownloadOutcome = 'saved' | 'cancelled'

/** Save operation an embedding shell installs before plugin boot. */
export interface FileDownloadHooks {
  /**
   * Save one Host artifact through the shell's own authenticated carrier.
   * @param request - Host-relative path and filename suggestion.
   * @returns whether the artifact was saved or the human dismissed the save.
   */
  save(request: FileDownloadRequest): Promise<FileDownloadOutcome>
}

/** Browser service that saves Host artifacts to the user's machine. */
export interface FileDownloadService {
  /**
   * Whether an embedding shell performs the transfer instead of the page. When
   * true, the page holds neither the transfer nor the Host credential, so a
   * page-origin request about this artifact proves nothing and consumers skip
   * any same-origin preflight of their own.
   */
  readonly shellOwned: boolean
  /**
   * Save one Host artifact, through the shell when it owns downloads and
   * through the browser download manager otherwise.
   * @param request - Host-relative path and filename suggestion.
   * @returns whether the artifact was saved or the human dismissed the save.
   */
  save(request: FileDownloadRequest): Promise<FileDownloadOutcome>
}
