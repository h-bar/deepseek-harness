/** Build only the library artifacts, bound to the *official* public client environment.
 *
 *  `build:lib` on its own carries no `DSH_CLIENT_*` values, so a bundle built through it
 *  inlines `undefined` for the version and ships a client half that throws at runtime
 *  ("this client build carries no DSH_CLIENT_VERSION"). The full `build` also builds the
 *  web frontend and the native system, which vendoring does not need.
 *
 *  This entry composes the upstream helpers — it does not re-derive anything — and then
 *  runs the same `build:lib` the repository already uses. The vendoring switches
 *  (`DSH_VENDOR_SELF_CONTAINED`, `DSH_VENDOR_TARGET`) are not `DSH_CLIENT_*`, so they pass
 *  through `clientBuildProcessEnvironment` untouched.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
} from './client-build-environment.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'

const root = resolve(import.meta.dirname, '..')
const repositoryEnvironment = repositoryClientBuildEnvironment(root, process.env)
const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, 'official')
const buildEnvironment = clientBuildProcessEnvironment(process.env, clientEnvironment)
console.log(`vendor-build: client environment ${JSON.stringify(clientEnvironment)}`)
const invocation = pnpmInvocation(['run', 'build:lib'], buildEnvironment)
const result = spawnSync(invocation.command, invocation.args, {
  cwd: root,
  env: buildEnvironment,
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  throw new Error(`vendor-build: build:lib exited with ${String(result.status ?? result.signal)}`)
}
