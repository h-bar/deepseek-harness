import { ModuleLoader } from './internal.ts'
import { Loader as Base } from './shared.ts'

/** Re-export entry node APIs. */
export * from './config/entry.ts'
/** Re-export nested entry group APIs. */
export * from './config/group.ts'
/** Re-export service isolation helpers. */
export * from './config/isolate.ts'
/** Re-export entry tree persistence APIs. */
export * from './config/tree.ts'
/** Re-export loader config expression helpers. */
export * from './config/utils.ts'
/** Re-export Node internal module loader compatibility types. */
export * from './internal.ts'

/** Node Loader: shared data from `CORDIS_SHARED` and Node's internal module loader. */
export class Loader extends Base {
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public internal = ModuleLoader.fromInternal()
}

/** Loader config and dependency intercept namespace. */
export namespace Loader {
  /** Root loader configuration. */
  export type Config = Base.Config
  /** Intercept config used when other plugins depend on `loader`. */
  export type Intercept = Base.Intercept
}

export default Loader
