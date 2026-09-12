# Agent Note: Client file-download seam

Status: implemented

English | [中文](2026-09-06-client-file-download-seam.zh.md)

## Problem

Saving a Host file to the user's machine was private to one feature. `dsh-session-log-export` built the URL, issued a `HEAD` pre-probe with page `fetch`, and handed an `<a download>` to the browser download manager. Every step assumes the page is the served web app.

A shell that embeds the Client on its own app origin and routes every wire byte through its own carrier has none of them: no download manager exists in its WebView, a page-origin request carries an `Origin` the `/api` trust fence refuses, and the browser-session cookie is held natively rather than by the page. Such a shell could only disable the shipped row and mirror the controller, button, and dialog against its own save command — re-implementing localization and the `/export` path, and drifting at every version bump.

Nothing else in the repository downloads a file, so there was no second consumer to generalize from. The precedent was one package away: `dsh-client-file-upload` already solves the same class of problem for the opposite direction.

## Decision

`dsh-client-file-download` owns saving a Host file locally, mirroring `dsh-client-file-upload`. `FileDownloadRuntime` provides `ctx.fileDownload`, reads its own page global `__DSH_FILE_DOWNLOAD__` once during construction, and fixes its carrier for the page lifetime. With no hook it uses `savePageDownload`, the download-manager anchor; with one it delegates.

`save({ path, suggestedFilename })` takes a Host-relative `/api/…` path, never an absolute URL, so a shell validates the path and runs the transfer over its own authenticated connection. It answers `'saved'` or `'cancelled'`, where `'cancelled'` reports a dismissed save dialog — neither success nor failure. `shellOwned` reports whether the page still performs the transfer.

`SessionLogDownloadController` takes that service and delegates every save. It skips the `HEAD` pre-probe when `shellOwned`, because the page performs neither the transfer nor the credential exchange, so a page-origin request about the same path proves nothing and the carrier reports its own failures. `'cancelled'` deletes the session's dialog entry so the modal closes silently; a rejection publishes the existing error state. The package no longer owns a save implementation of its own: `downloadUrl` is deleted, and the browser anchor has one home.

Selection is by carrier presence, never by page authority. `isLoopback` and `ownsHost` gate the privileged surface — host settings persistence, the settings document controller, native path opening — so they are an authorization claim, not a transport fact. A plain browser pointed at a remote deployment is non-loopback and its download manager works normally, while an embedding shell is broken regardless of loopback-ness.

## Alternatives considered

**A `saveDownload` member on `ClientTransportHooks`, republished on `ConnectionHandle`.** Built first, then reverted. `ClientTransportHooks` carries wire carriers — `fetch`, `openStream`, `loadBundle` — and a disk write is not one; putting it there also spread one capability across a transport interface, a connection handle, and a consumer. It edited `packages/client/connection`, whose `ConnectionHandle` is reproduced in a generated inspection catalog, so the diff reached a high-churn generated artifact for no gain. `dsh-client-file-upload` had already established the per-capability plugin with its own global as this repository's answer.

**Reuse `ownsHost`.** It feeds exactly one expression, `isLoopback`. A shell that connects to a stock server does not own its Host, so the claim would be false; it would misgrant host-side privilege against a remote server; and it would still leave no way to write a file.

**Switch on remote or non-loopback mode.** Network topology does not answer the question. A normal browser on a proxied remote deployment saves correctly through its download manager, and a WebView fails whatever the authority. Carrier presence answers it directly.

**Probe through the shell's transport `fetch` instead of skipping the probe.** `RpcFetch` is fetch-shaped, but its contract is generic unary RPC channels and its only in-tree caller posts JSON to `/api` channels. Probing a feature route through it would extend an implicit contract and let one consumer redefine the transport, while adding a round trip that tells the caller nothing the carrier will not.

**Keep the save inside `dsh-session-log-export`.** The capability is not session-specific: it addresses any Host path. Leaving it there forces the next download feature to re-implement the anchor, the null-origin stand-in, and the hook lookup.

## Consequences

Any client feature can now save a Host file by injecting `fileDownload`, and an embedding shell supplies one hook to serve all of them. The export plugin injects `fileDownload` rather than constructing its own saver, so it activates after that service; `dsh-web-app` mounts the row directly after `file-upload`.

The seam is deliberately narrow. It reports no destination, no progress, and no cancellation, because the browser download manager exposes none of them and a shared contract cannot promise what one carrier cannot deliver. `'cancelled'` is therefore carrier-dependent, and its absence is not proof that a file landed.

Uploads already have their own seam and are untouched here. `dsh-client-file-upload` reads `__DSH_FILE_UPLOAD__` and, when a shell supplies it, replaces its Blob Worker with a direct carrier call, so an embedding shell can upload without this package. Its worker parameters remain test seams rather than host seams — the worker body is stringified and invoked with no arguments — so the shell path trades the Worker's XHR byte-progress for the carrier's plain response.

## Testing

`packages/client/file-download/tests/file-download.client.spec.ts` covers carrier selection from the page global, the anchor path including the null-origin stand-in, delegation to a shell hook with its outcome, and service withdrawal on fiber disposal. `packages/session-query/session-log-export/tests/controller.client.spec.ts` covers the delegated save request, a shell-owned carrier skipping the preflight, `'cancelled'` clearing the entry, and a rejecting carrier publishing the error state; `tests/client-apply.client.spec.tsx` covers the wiring from `ctx.fileDownload`. The pre-existing page-path specs are unchanged apart from their constructor, which is what pins the served web app's behavior.
