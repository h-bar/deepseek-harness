/**
 * Parse the Cordis entry-list YAML dialect (`!!js` scalars become opaque
 * `{ __jsExpr: string }` expression nodes) in the browser. This mirrors the
 * parse direction of the host's `entryListSchema` (vendor/include) without
 * importing the Loader, so the client can read a shipped `cordis.patch.yml`.
 * @module @deepseek-ai/dsh-client-modules/client/cordis-yaml
 */
import * as yaml from 'js-yaml'

/** A `!!js` scalar parsed into an opaque expression node (never evaluated here). */
export interface JsExpr {
  __jsExpr: string
}

/** Whether a value is a `!!js` expression node. */
export function isJsExpr(value: unknown): value is JsExpr {
  return value instanceof Object && '__jsExpr' in value
}

// The `!!js` YAML type, parse-only. The host's entryListSchema also carries
// predicate/represent for round-tripping; the client only reads, so those are
// omitted.
const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
})

const schema = yaml.JSON_SCHEMA.extend(JsExprType)

/**
 * Parse one entry-list YAML document (`cordis.patch.yml`) into plain data,
 * with `!!js` scalars as {@link JsExpr} nodes.
 * @param text - the YAML document text.
 * @returns the parsed data (an entry array, for a patch file).
 */
export function parseEntryList(text: string): unknown {
  return yaml.load(text, { schema })
}
