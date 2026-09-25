import { defineConfig } from 'tsdown'

/**
 * The Loader ships two entries: the Node Loader (index) and the browser Loader (browser),
 * selected by package.json `exports` conditions. Each is a single-entry pass so the shared
 * implementation is inlined into both rather than split into a hash-named chunk.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  outputOptions: { codeSplitting: false },
  dts: false,
  clean: false,
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/browser.js'] },
])
