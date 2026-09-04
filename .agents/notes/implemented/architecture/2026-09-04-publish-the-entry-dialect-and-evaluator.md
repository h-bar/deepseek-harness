# Agent Note: Publish the entry-list dialect and the expression evaluator

Status: implemented

English | [中文](2026-09-04-publish-the-entry-dialect-and-evaluator.zh.md)

## Problem

An out-of-repo browser host composes its own client tree from the same bundle patch layers `dsh web` composes on the server. It could already apply the patch algorithm, which `@deepseek-ai/cordis-plugin-include/patch` publishes, but two pieces of the same composition were unreachable.

The `!!js` YAML dialect was reachable only through `@deepseek-ai/cordis-plugin-include`, whose Include class is file-backed. A consumer that could not import it hand-wrote a tag for whichever YAML library it already had. Two tag definitions that agree today are two that can disagree later, and a lookalike dialect accepts and rejects different documents than the one the Loader mounts.

The evaluator behind a `!!js` `disabled` expression was reachable only through the loader's package barrel, which re-exports the Node module-loader compatibility layer. `Entry.disabledOf` resolves such an expression with `Boolean(evaluate(...))`; a consumer without the evaluator either rejects every expression or reimplements the coercion.

## Decision

`@deepseek-ai/dsh-app-boot` re-exports `entryListSchema`. Profile composition already lives there — `composeEntries`, `loadOverlayPatches`, `renderConfigDump` — and every one of them parses or prints in that dialect. A caller that composes through this package now parses and dumps through it too, so a staged document round-trips `!!js` as a tag rather than as a bare `__jsExpr` mapping.

The loader publishes its `./config/utils` export, mapping to the built `evaluate` / `interpolate` / `isJsExpr` module. That module imports only `@deepseek-ai/cosmokit` and no `node:` builtin, so it was already browser-safe; it simply had no specifier that reached it without the barrel.

In-repo callers keep importing `src/config/utils.ts`. The tsconfig `paths` mapping carries no subpath wildcard, so a built specifier would resolve a source-plane program to `lib/` and mix the two planes.

## Consequences

A browser consumer resolves a `disabled` expression by the same rule the host applies, against a scope standing in for the loader Context. `packages/boot/app-boot/tests/js-expression.spec.ts` pins every shipped layer's expression against the `{ process: { platform: 'browser' } }` scope the served web boot installs, so a layer that starts reaching further fails in this repository rather than at a consumer's boot.

Neither export changes an existing specifier or any behavior on the Node path.

## Known gap

The include package's built output imports `@deepseek-ai/cordis-plugin-loader/src/config/utils.ts` — a raw `.ts` specifier that survives both the tsc emit and the tsdown bundle, and that a bundling consumer resolves to a second copy of the module. Tree-shaking reduces the duplicate to the `isJsExpr` predicate, which holds no state, so the cost is size rather than correctness. Rewriting published specifiers to the built export needs build machinery this change does not add.

## Alternatives considered

**Re-export `isJsExpr` and `evaluate` from `@deepseek-ai/cordis-plugin-include/patch`.** One package for the consumer to depend on, but the include package would own a surface the loader declares, and the evaluator has nothing to do with patch application.

**Relax the consumer's compiler settings and import the vendored source.** The vendored loader deliberately sets `noImplicitAny: false`; importing its source pulls that relaxation into a program that had chosen strictness.
