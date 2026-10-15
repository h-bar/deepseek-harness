/**
 * Stylesheets enter client bundles through virtual modules, so the loader must
 * register their physical files as watch dependencies — and the id it hands
 * Rolldown must be independent of where the checkout lives, because that id
 * reaches the artifact (`lib/client.js` region comments and the CSS Modules hash
 * derived from it), not just this process.
 *
 * The fixtures are real files under `scripts/fixtures/`: the id is relative to
 * the repository, so a stylesheet in a temporary directory could not be named by
 * it at all.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface CssPlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

const fixtureRoot = new URL('../scripts/fixtures/tsdown-client-css/src/client/', import.meta.url)
const importer = new URL('index.ts', fixtureRoot)
const modulesFixture = new URL('Fixture.module.css', fixtureRoot)
const globalFixture = new URL('global.css', fixtureRoot)
const inlineFixture = new URL('inline.css', fixtureRoot)

function cssPlugin(name: 'dsh-css-modules-inline' | 'dsh-css-global-inline' | 'dsh-css-text-inline'): CssPlugin {
  const configs = clientBundle(
    '@deepseek-ai/dsh-client-test',
    ['lib/types/index.js', 'lib/types/invariant.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: CssPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === name)
  if (plugin === undefined) throw new Error(`${name} missing from client config`)
  return plugin
}
/** Resolve a fixture import, requiring the plugin to have answered with an id. */
function resolveFixture(
  plugin: CssPlugin,
  source: string,
): string {
  const virtualId = plugin.resolveId?.(source, importer.pathname)
  if (typeof virtualId !== 'string') throw new Error(`${plugin.name} did not resolve ${source}`)
  return virtualId
}
/** Load a virtual id, collecting the watch dependencies the loader registers. */
async function loadVirtual(plugin: CssPlugin, virtualId: string): Promise<{ readonly watched: string[]; readonly output: string }> {
  if (plugin.load === undefined) throw new Error(`${plugin.name} has no load hook`)
  const watched: string[] = []
  const output = await plugin.load.call({ addWatchFile: id => watched.push(id) }, virtualId)
  if (typeof output !== 'string') throw new Error(`${plugin.name} did not load ${virtualId}`)
  return { watched, output }
}
describe('client bundle stylesheet ids', () => {
  it('names a stylesheet relative to the repository, never by its checkout path', () => {
    const plugin = cssPlugin('dsh-css-modules-inline')
    const virtualId = resolveFixture(plugin, './Fixture.module.css')
    const repository = new URL('..', import.meta.url).pathname
    expect(virtualId).not.toContain(repository)
    expect(virtualId).toBe('\u0000dsh-css:scripts/fixtures/tsdown-client-css/src/client/Fixture.module.css.mjs')
    expect(virtualId).toBe(resolveFixture(plugin, './Fixture.module.css'))
  })
})
describe('client bundle CSS Modules', () => {
  it('registers the source stylesheet as a watch dependency', async () => {
    const plugin = cssPlugin('dsh-css-modules-inline')
    const { watched, output } = await loadVirtual(plugin, resolveFixture(plugin, './Fixture.module.css'))
    const stylesheet = await readFile(modulesFixture, 'utf8')
    expect(stylesheet).toContain('.root')
    expect(watched).toEqual([modulesFixture.pathname])
    expect(output).toContain('data-plugin-css')
  })
})
describe('client bundle global CSS', () => {
  it('compiles a side-effect stylesheet into a watched style injector', async () => {
    const plugin = cssPlugin('dsh-css-global-inline')
    const { watched, output } = await loadVirtual(plugin, resolveFixture(plugin, './global.css'))
    expect(watched).toEqual([globalFixture.pathname])
    expect(output).toContain('data-plugin-css')
    expect(output).toContain('body{color:red}')
  })
  it('compiles inline stylesheets as watched text without a module side effect', async () => {
    const plugin = cssPlugin('dsh-css-text-inline')
    const { watched, output } = await loadVirtual(plugin, resolveFixture(plugin, './inline.css?inline'))
    expect(watched).toEqual([inlineFixture.pathname])
    expect(output).toContain('export default "body{color:red}"')
    expect(output).not.toContain('data-plugin-css')
  })
})
