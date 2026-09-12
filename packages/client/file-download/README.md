---
description: "Saves a Host file to the user's machine, through the browser download manager or an embedding shell's own save carrier."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-file-download

English | [中文](README.zh.md)

## Summary

This package gives browser features one way to put a Host file on the user's machine. A served page hands the file to the browser download manager; a page whose Host is reached through an embedding shell hands it to that shell's save carrier, supplied before Cordis boots. Callers address the file by Host-relative path and learn only whether it was saved or the human dismissed the save, because the destination belongs to whichever carrier performs the transfer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Inject `fileDownload` and call `save({ path, suggestedFilename })`. `path` is a Host-relative `/api/…` path, never an absolute URL, so a shell carrier validates it and routes the transfer through its own authenticated connection. `suggestedFilename` is the browser download name, or the prefill for a shell's save dialog.

The result is `'saved'` or `'cancelled'`. `'cancelled'` reports that a human dismissed a save dialog; it is neither success nor failure, so a caller that shows progress closes it without announcing an outcome. Only a carrier that can observe a dismissal produces it — the browser download manager reports none, so the page path always settles `'saved'` once the transfer is handed over.

`shellOwned` tells a caller whether the page still performs the transfer. When it is true the page holds neither the bytes nor the Host credential, so a same-origin preflight of the same path proves nothing and the caller skips it; the carrier reports its own failures by rejecting.

An embedding shell installs its carrier on `globalThis.__DSH_FILE_DOWNLOAD__` before plugin boot, the same way it installs the transport carrier:

```ts
globalThis.__DSH_FILE_DOWNLOAD__ = {
  async save({ path, suggestedFilename }) {
    return (await hostSaveDialog(path, suggestedFilename)) ? 'saved' : 'cancelled'
  },
}
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`FileDownloadRuntime` reads the page global once during construction and fixes its carrier for the page lifetime, exactly as the transport carrier is fixed. With no hook it uses `savePageDownload`, which resolves the Host-relative path against the page origin — falling back to the connection carrier's `http://dsh.internal` stand-in for a null origin — sets the anchor's `download` attribute, and activates it.

The node half is an empty `apply`. It exists so the plugin appears in the host `cordis.yml` and Loader; the browser half ships through `exports["./client"]`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-client-file-upload](../file-upload/README.md) — the symmetric capability, which selects its carrier the same way.
- [dsh-client-connection](../connection/README.md) — the authenticated carrier a Host download path is served by.
- [dsh-session-log-export](../../session-query/session-log-export/README.md) — the current consumer, which saves a Session archive.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package saves a Host file locally and contributes no model input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The destination is never reported** — the carrier owns it, so a caller cannot show, open, or reveal the saved file.
- **No progress and no cancellation** — `save` settles once, with no byte observer and no `AbortSignal`. The browser download manager exposes neither, so a shared contract could only report them for shell carriers.
- **`'cancelled'` is carrier-dependent** — a page-owned save cannot distinguish a dismissed browser prompt from a completed one, so callers cannot treat the absence of `'cancelled'` as proof the file landed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The carrier is chosen once from a page global and exercised directly by behavior specs; there is no owned relation whose independent observations could diverge.
