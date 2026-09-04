import { EntryGroup, EntryTree, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { Context, Service } from '@deepseek-ai/cordis'
import { extname } from 'node:path'
import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from './patch.ts'
import type { PatchOptions } from './patch.ts'

export { applyEntryPatches, entryListSchema } from './patch.ts'
export type { PatchOptions } from './patch.ts'

const schema = entryListSchema

const writable: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
}

const supported = new Set(Object.keys(writable))

const WRITE_RETRY_LIMIT = 10
const WRITE_RETRY_DELAY_MS = 50

function retryableWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

type ConfigUpdateStage = 'read' | 'parse' | 'validate'

interface ReadCandidate {
  content: string
  data: EntryOptions[]
}

class ConfigFileError extends Error {
  constructor(public readonly stage: ConfigUpdateStage, path: string, cause: unknown) {
    super(`failed to ${stage} config file ${path}`, { cause })
    this.name = 'ConfigFileError'
  }
}

/** Config namespace for the file-backed include loader. */
export namespace Include {
  /** Config for a file-backed loader subtree. */
  export interface Config {
    /** YAML or JSON path resolved from `ctx.baseUrl`. */
    path: string
    /** Entry list written when the file does not already exist. */
    initial?: any[]
    /** Runtime patches applied after reading the file. */
    patches?: PatchOptions[]
    /** Enables loader apply/reload/unload logs for this subtree. */
    enableLogs?: boolean
  }
}

/** Loader entry tree backed by a YAML or JSON file. */
export class Include extends EntryTree {
  static inject = ['loader']

  // Tree-carrier marker (the Group plugin declares the same): this config is
  // entry and patch lists, so the Loader's `internal/config` interpolation
  // keeps it literal — a `!!js` expression inside a nested row's config
  // belongs to that row's fiber, resolving lazily in the row's own context.
  // Include's own fields (`path`, `enableLogs`) therefore stay literal too.
  static readonly [EntryGroup.key] = true

  public filename: string
  private type?: string
  private readonly: boolean
  private content?: string
  private data?: EntryOptions[]
  private writeTask?: NodeJS.Timeout | undefined
  private pendingWrite?: EntryOptions[]
  private writeQueue: Promise<void> = Promise.resolve()
  private applyQueue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, public config: Include.Config) {
    super(ctx)
    this.enableLogs = config.enableLogs ?? ctx.fiber.entry?.parent.tree.enableLogs ?? false
    this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
    const ext = extname(this.filename)
    if (!supported.has(ext)) {
      throw new Error(`extension "${ext}" not supported`)
    }
    this.type = writable[ext]
    this.readonly = !this.type
    this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href

    ctx.on('internal/update', async (config, _, next) => {
      if (config.path !== this.config.path) return next()
      await this.enqueue(async () => {
        const data = this.applyPatches(this.data!, config.patches)
        await this.root.update(data)
        this.config = config
      })
    })
  }

  /**
   * Serialize one child-tree mutation behind every earlier one. The group's
   * transactional `update` is not reentrant: two concurrent applies (the init
   * apply racing an HMR-triggered refresh from the watcher's initial scan)
   * interleave create and rollback on the same entries and strand the include
   * fiber without settling, so every apply path funnels through this queue.
   * A predecessor's failure is its own caller's outcome and never gates the
   * next task.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.applyQueue.then(task, task)
    this.applyQueue = run.then(() => {}, () => {})
    return run
  }

  private async checkAccess() {
    if (!this.type) return
    try {
      await access(this.filename, constants.W_OK)
    } catch {
      this.readonly = true
    }
  }

  private async read(forced = false): Promise<ReadCandidate | undefined> {
    let content: string
    try {
      content = await readFile(this.filename, 'utf8')
    } catch (error) {
      throw new ConfigFileError('read', this.filename, error)
    }
    if (!forced && this.content === content) return
    let data: any
    try {
      if (this.type === 'application/yaml') {
        data = yaml.load(content, { schema })
      } else if (this.type === 'application/json') {
        data = JSON.parse(content)
      } else {
        const module = await import(/* @vite-ignore */ this.filename)
        data = module.default || module
      }
    } catch (error) {
      throw new ConfigFileError('parse', this.filename, error)
    }
    if (!Array.isArray(data)) {
      throw new ConfigFileError('validate', this.filename, new TypeError('config file must be a top-level array'))
    }
    return { content, data }
  }

  private applyPatches(data: EntryOptions[], patches?: PatchOptions[]): EntryOptions[] {
    return applyEntryPatches(data, patches, (message, ...args) => {
      this.ctx.root.logger?.('loader').warn(message, ...args)
    })
  }

  async* [Service.init]() {
    let candidate: ReadCandidate
    try {
      candidate = (await this.read(true))!
    } catch (error) {
      if (!(error instanceof ConfigFileError) || error.stage !== 'read' || (error.cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      if (this.config.initial) {
        await this._writeFile(this.config.initial as any)
        candidate = (await this.read(true))!
      } else {
        throw new Error(`config file not found: ${this.filename}`)
      }
    }

    yield () => this.stop()
    await this.apply(candidate)
  }

  async stop() {
    await this.root.stop()
    await this.flushWrite()
  }

  /**
   * Re-read the file and transactionally refresh child entries when content changed.
   * @returns a promise resolving after the new tree commits, or immediately when unchanged.
   * @throws when reading, parsing, validation, application, or rollback fails; the last good tree remains active when rollback succeeds.
   */
  async refresh() {
    // Read inside the queue so the changed-content check compares against the
    // predecessor's committed state, not a mid-apply snapshot.
    await this.enqueue(async () => {
      const candidate = await this.read()
      if (!candidate) return
      await this._apply(candidate)
    })
  }

  private apply(candidate: ReadCandidate) {
    return this.enqueue(() => this._apply(candidate))
  }

  private async _apply(candidate: ReadCandidate) {
    const data = this.applyPatches(candidate.data, this.config.patches)
    await this.root.update(data)
    this.content = candidate.content
    this.data = candidate.data
    await this.checkAccess()
  }

  private async _writeFile(config: EntryOptions[]) {
    if (this.readonly) {
      throw new Error(`cannot overwrite readonly config`)
    }
    if (this.type === 'application/yaml') {
      this.content = yaml.dump(config, { schema })
    } else if (this.type === 'application/json') {
      this.content = JSON.stringify(config, null, 2)
    }
    await writeFile(this.filename + '.tmp', this.content!)
    for (let retry = 0; ; retry++) {
      try {
        await rename(this.filename + '.tmp', this.filename)
        return
      } catch (error) {
        if (!retryableWriteError(error) || retry >= WRITE_RETRY_LIMIT) throw error
        await delay((retry + 1) * WRITE_RETRY_DELAY_MS)
      }
    }
  }

  private writeFile(config: EntryOptions[]) {
    clearTimeout(this.writeTask)
    this.pendingWrite = config
    this.writeTask = setTimeout(() => {
      void this.flushWrite()
    }, 0)
  }

  private flushWrite(): Promise<void> {
    clearTimeout(this.writeTask)
    this.writeTask = undefined
    const config = this.pendingWrite
    this.pendingWrite = undefined
    if (config === undefined) return this.writeQueue
    const run = this.writeQueue.then(
      () => this._writeFile(config),
      () => this._writeFile(config),
    )
    this.writeQueue = run
    void run.catch((error) => {
      this.ctx.root.logger?.('loader').warn('failed to write config file %C', this.filename)
      this.ctx.root.logger?.('loader').warn(error)
    })
    return run
  }

  /** Schedule a write of the current root entry data. */
  write() {
    this.context.emit('loader/config-update')
    return this.writeFile(this.root.data)
  }
}

export default Include
