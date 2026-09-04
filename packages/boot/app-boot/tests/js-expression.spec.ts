/**
 * That every `disabled` expression the shipped bundle layers carry still
 * resolves in a browser scope, for the out-of-tree composer this package
 * publishes the patch algorithm and the evaluator for.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include/patch'
import { interpolate, isJsExpr } from '@deepseek-ai/cordis-plugin-loader'

/** Every `disabled` expression in one shipped patch layer, with its row for diagnostics. */
function disabledExpressions(bundle: string): Array<{ row: string; expr: string }> {
  const path = fileURLToPath(new URL(`../../../bundle/${bundle}/cordis.patch.yml`, import.meta.url))
  const found: Array<{ row: string; expr: string }> = []
  const walk = (rows: unknown): void => {
    if (!Array.isArray(rows)) return
    for (const row of rows as Array<Record<string, unknown>>) {
      if (row === null || typeof row !== 'object') continue
      if (isJsExpr(row.disabled)) found.push({ row: String(row.name ?? row.id), expr: row.disabled.__jsExpr })
      walk(row.insert)
      walk(row.config)
    }
  }
  walk(yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema }))
  return found
}

describe('shipped `disabled` expressions under a browser scope', () => {
  // `disabled` is the one field evaluated before a row activates, so an
  // out-of-tree composer evaluates every one of them whether or not the row
  // could run there, against a scope that can carry only what a browser knows:
  // a platform tag, an empty environment, and no resolvable services (the
  // evaluator's `with (ctx)` makes the scope object itself the `ctx` an
  // expression names, so `get` here is `ctx.get`). An expression reaching past
  // that is host-side, and fails here rather than at that composer's boot.
  // Config-level expressions are exempt: those resolve per row, after its
  // injections are active, so a host row in a browser never reaches them.
  const browserScope = { process: { platform: 'browser', env: {} }, get: () => undefined }

  // Derived from the shipped bundle directories so a new bundle cannot escape
  // the guard; the base-layer case below is the sentinel that the walk finds
  // expressions at all.
  const bundleRoot = fileURLToPath(new URL('../../../bundle', import.meta.url))
  const bundles = readdirSync(bundleRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(bundleRoot, entry.name, 'cordis.patch.yml')))
    .map(entry => entry.name)

  for (const bundle of bundles) {
    it(`evaluates every one in ${bundle}`, () => {
      for (const { row, expr } of disabledExpressions(bundle)) {
        expect(() => interpolate(browserScope, { disabled: { __jsExpr: expr } }) as unknown, `${row}: ${expr}`).not.toThrow()
      }
    })
  }

  it('covers the platform-selected shell rows the base layer ships', () => {
    const exprs = disabledExpressions('base').map(entry => entry.expr)
    expect(exprs).toContain("process.platform === 'win32'")
    expect(exprs.length).toBeGreaterThanOrEqual(4)
  })
})
