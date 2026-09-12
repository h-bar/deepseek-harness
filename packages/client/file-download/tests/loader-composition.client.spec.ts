/**
 * Real Loader composition for the node half: the row `dsh-web-app` mounts must
 * activate from a `cordis.yml` through the Loader, and must keep the
 * named-export form the Loader reads a plugin's namespace from.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as FileDownload from '@deepseek-ai/dsh-client-file-download'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('file-download real Loader composition', () => {
  it('activates the node half from a cordis.yml row', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-file-download-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, "- name: '@deepseek-ai/dsh-client-file-download'\n")

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const imported: string[] = []
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        imported.push(specifier)
        if (specifier !== '@deepseek-ai/dsh-client-file-download') {
          throw new Error(`unexpected Loader import: ${specifier}`)
        }
        return FileDownload
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    // The node half contributes nothing, so the Loader reaching and activating
    // the row is the assertion: a resolution or export-form failure surfaces
    // here rather than at boot.
    expect(imported).toEqual(['@deepseek-ai/dsh-client-file-download'])
    const mounted = [...context.loader.entries()]
      .filter(entry => entry.options.name === '@deepseek-ai/dsh-client-file-download')
    expect(mounted).toHaveLength(1)
    expect(mounted[0]?.fiber?.state).toBe(FiberState.ACTIVE)
  })

  it('keeps the named-export form the Loader reads a namespace from', () => {
    // The node half declares no `inject`, so a default export would make the
    // Loader discard its namespace while the composition smoke above stayed
    // green. docs/postmortem/0001-acp-default-export-drops-inject.md owns it.
    expect('default' in FileDownload).toBe(false)
    expect(typeof FileDownload.apply).toBe('function')
  })
})
