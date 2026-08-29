/**
 * The default bundle transport: load one classic `<script src>` and await its
 * execution. Browser-safe (zero node imports); shared by the module system's
 * `ClientModuleSystem` and the desktop shell's modules-bundle preload.
 * @module @deepseek-ai/dsh-client-modules/client/load-bundle
 */

/**
 * Load one classic script and await its execution. The script is a
 * self-registering bundle, so execution registers its factory; no result is read.
 * @param url - the script URL (same-origin, or the desktop app's `dsh-resource://`).
 * @returns a promise resolving after the script executes, rejecting on load error.
 */
export function loadBundleScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.async = true
    el.src = url
    el.addEventListener('load', () => {
      el.remove()
      resolve()
    }, { once: true })
    el.addEventListener('error', () => {
      el.remove()
      reject(new Error(`client-modules: bundle script ${url} failed to load`))
    }, { once: true })
    document.head.append(el)
  })
}
