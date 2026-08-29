/** Parse the entry-list YAML dialect in the browser half. */

import { describe, expect, it } from 'vitest'
import { isJsExpr, parseEntryList } from '../src/client/cordis-yaml.ts'

interface Row { id: string; name: string; disabled?: unknown; config?: { host?: unknown } }

describe('cordis-yaml', () => {
  it('parses !!js scalars into opaque expression nodes', () => {
    const rows = parseEntryList([
      '- id: a',
      "  name: '@fixture/a'",
      '  config:',
      '    host: !!js ctx.webStartup.host',
    ].join('\n')) as Row[]
    expect(rows[0]!.id).toBe('a')
    const host = rows[0]!.config!.host
    expect(isJsExpr(host)).toBe(true)
    expect((host as { __jsExpr: string }).__jsExpr).toBe('ctx.webStartup.host')
  })

  it('parses a static boolean disabled as a literal', () => {
    const rows = parseEntryList([
      '- id: a',
      "  name: '@fixture/a'",
      '  disabled: true',
    ].join('\n')) as Row[]
    expect(rows[0]!.disabled).toBe(true)
  })
})
