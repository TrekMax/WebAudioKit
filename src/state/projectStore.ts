import type { ImportedAudioMetadata } from '../audio/importAudio'
import type {
  SampleSelection,
  WorkspaceAnalysisConfig,
} from '../workspaceTypes'

export const PROJECT_STORE_SCHEMA_VERSION = 2 as const
export const PROJECT_STORE_DATABASE_NAME = 'webaudio-kit'

const PROJECTS_OBJECT_STORE = 'projects'
const RECENT_WORKSPACE_KEY = 'recent-workspace'

export interface RecentWorkspacePreferences {
  readonly analysisConfig: WorkspaceAnalysisConfig
  readonly activeAsset?: ImportedAudioMetadata | null
  readonly selection?: SampleSelection | null
  readonly playheadSample?: number
  readonly visibleChannels?: number[]
}

export interface StoredRecentWorkspace extends RecentWorkspacePreferences {
  readonly schemaVersion: typeof PROJECT_STORE_SCHEMA_VERSION
  readonly updatedAt: number
}

export type ProjectPersistenceMode = 'indexeddb' | 'memory'

export interface ProjectStoreOptions {
  /** `null` explicitly selects the in-memory fallback. */
  readonly indexedDB?: IDBFactory | null
  readonly databaseName?: string
  readonly now?: () => number
}

/**
 * Stores only a whitelisted, serializable recent-workspace snapshot. File,
 * AudioBuffer, nodes and other runtime values are never copied into IndexedDB.
 */
export class ProjectStore {
  private readonly indexedDbFactory: IDBFactory | null
  private readonly databaseName: string
  private readonly now: () => number

  private databasePromise: Promise<IDBDatabase> | null = null
  private persistenceEnabled: boolean
  private memorySnapshot: StoredRecentWorkspace | null = null

  constructor(options: ProjectStoreOptions = {}) {
    this.indexedDbFactory =
      options.indexedDB === undefined
        ? readGlobalIndexedDb()
        : options.indexedDB
    this.databaseName = options.databaseName ?? PROJECT_STORE_DATABASE_NAME
    this.now = options.now ?? Date.now
    this.persistenceEnabled = this.indexedDbFactory !== null

    if (this.databaseName.trim().length === 0) {
      throw new RangeError('databaseName must not be empty')
    }
  }

  get persistenceMode(): ProjectPersistenceMode {
    return this.persistenceEnabled ? 'indexeddb' : 'memory'
  }

  async save(
    preferences: RecentWorkspacePreferences,
  ): Promise<StoredRecentWorkspace> {
    const snapshot = createStoredSnapshot(preferences, this.now())
    this.memorySnapshot = cloneStoredSnapshot(snapshot)

    const database = await this.getDatabase()
    if (database) {
      try {
        await putValue(database, snapshot)
      } catch {
        this.disablePersistence()
      }
    }

    return cloneStoredSnapshot(snapshot)
  }

  async load(): Promise<StoredRecentWorkspace | null> {
    if (this.memorySnapshot) {
      return cloneStoredSnapshot(this.memorySnapshot)
    }

    const database = await this.getDatabase()
    if (!database) {
      return null
    }

    try {
      const storedValue = await getValue(database)
      if (storedValue === undefined) {
        return null
      }

      const snapshot = parseStoredSnapshot(storedValue)
      if (!snapshot) {
        return null
      }

      this.memorySnapshot = cloneStoredSnapshot(snapshot)
      if (isRecord(storedValue) && storedValue.schemaVersion === 1) {
        await putValue(database, snapshot)
      }
      return cloneStoredSnapshot(snapshot)
    } catch {
      this.disablePersistence()
      return this.memorySnapshot
        ? cloneStoredSnapshot(this.memorySnapshot)
        : null
    }
  }

  async clear(): Promise<void> {
    this.memorySnapshot = null

    const database = await this.getDatabase()
    if (!database) {
      return
    }

    try {
      await deleteValue(database)
    } catch {
      this.disablePersistence()
    }
  }

  close(): void {
    const databasePromise = this.databasePromise
    this.databasePromise = null
    databasePromise?.then(
      (database) => database.close(),
      () => undefined,
    )
  }

  private async getDatabase(): Promise<IDBDatabase | null> {
    if (!this.persistenceEnabled || !this.indexedDbFactory) {
      return null
    }

    try {
      this.databasePromise ??= openDatabase(
        this.indexedDbFactory,
        this.databaseName,
      )
      return await this.databasePromise
    } catch {
      this.disablePersistence()
      return null
    }
  }

  private disablePersistence(): void {
    this.persistenceEnabled = false
    this.close()
  }
}

export function createProjectStore(
  options: ProjectStoreOptions = {},
): ProjectStore {
  return new ProjectStore(options)
}

function createStoredSnapshot(
  preferences: RecentWorkspacePreferences,
  updatedAt: number,
): StoredRecentWorkspace {
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new RangeError('updatedAt must be a non-negative safe integer')
  }

  const analysisConfig = parseAnalysisConfig(preferences.analysisConfig)
  if (!analysisConfig) {
    throw new RangeError('analysisConfig is invalid')
  }

  const snapshot: StoredRecentWorkspace = {
    schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
    updatedAt,
    analysisConfig,
  }

  if (preferences.activeAsset !== undefined) {
    if (preferences.activeAsset === null) {
      Object.assign(snapshot, { activeAsset: null })
    } else {
      const activeAsset = parseActiveAsset(preferences.activeAsset)
      if (!activeAsset) {
        throw new RangeError('activeAsset metadata is invalid')
      }
      Object.assign(snapshot, { activeAsset })
    }
  }

  if (preferences.selection !== undefined) {
    if (preferences.selection === null) {
      Object.assign(snapshot, { selection: null })
    } else {
      const selection = parseSelection(preferences.selection)
      if (!selection) {
        throw new RangeError('selection must use a valid half-open sample range')
      }
      assertWithinActiveAsset(selection.end, snapshot.activeAsset)
      Object.assign(snapshot, { selection })
    }
  }

  if (preferences.playheadSample !== undefined) {
    const playheadSample = parseSampleIndex(preferences.playheadSample)
    if (playheadSample === null) {
      throw new RangeError('playheadSample must be a non-negative safe integer')
    }
    assertWithinActiveAsset(playheadSample, snapshot.activeAsset)
    Object.assign(snapshot, { playheadSample })
  }

  if (preferences.visibleChannels !== undefined) {
    const visibleChannels = parseVisibleChannels(preferences.visibleChannels)
    if (!visibleChannels) {
      throw new RangeError(
        'visibleChannels must contain only non-negative safe integers',
      )
    }
    Object.assign(snapshot, { visibleChannels })
  }

  return snapshot
}

function parseStoredSnapshot(value: unknown): StoredRecentWorkspace | null {
  if (!isRecord(value)) {
    return null
  }
  if (
    !(value.schemaVersion === 1 ||
      value.schemaVersion === PROJECT_STORE_SCHEMA_VERSION) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0
  ) {
    return null
  }

  const analysisConfig =
    value.schemaVersion === 1
      ? parseLegacyAnalysisConfig(value.analysisConfig)
      : parseAnalysisConfig(value.analysisConfig)
  if (!analysisConfig) {
    return null
  }

  const snapshot: StoredRecentWorkspace = {
    schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
    updatedAt: value.updatedAt as number,
    analysisConfig,
  }

  if ('activeAsset' in value) {
    if (value.activeAsset === null) {
      Object.assign(snapshot, { activeAsset: null })
    } else {
      const activeAsset = parseActiveAsset(value.activeAsset)
      if (!activeAsset) {
        return null
      }
      Object.assign(snapshot, { activeAsset })
    }
  }

  if ('selection' in value) {
    if (value.selection === null) {
      Object.assign(snapshot, { selection: null })
    } else {
      const selection = parseSelection(value.selection)
      if (!selection || !isWithinActiveAsset(selection.end, snapshot.activeAsset)) {
        return null
      }
      Object.assign(snapshot, { selection })
    }
  }

  if ('playheadSample' in value) {
    const playheadSample = parseSampleIndex(value.playheadSample)
    if (
      playheadSample === null ||
      !isWithinActiveAsset(playheadSample, snapshot.activeAsset)
    ) {
      return null
    }
    Object.assign(snapshot, { playheadSample })
  }

  if (
    value.schemaVersion === PROJECT_STORE_SCHEMA_VERSION &&
    'visibleChannels' in value
  ) {
    const visibleChannels = parseVisibleChannels(value.visibleChannels)
    if (!visibleChannels) {
      return null
    }
    Object.assign(snapshot, { visibleChannels })
  }

  return snapshot
}

function parseAnalysisConfig(value: unknown): WorkspaceAnalysisConfig | null {
  if (!isRecord(value)) {
    return null
  }

  const fftSizes = [512, 1024, 2048, 4096, 8192, 16384, 32768] as const
  const overlaps = [0, 0.5, 0.75, 0.875] as const
  const windows = ['hann', 'hamming', 'blackman'] as const
  const frequencyScales = ['linear', 'log'] as const
  const channel = parseAnalysisChannel(value.channel)

  if (
    !includesValue(fftSizes, value.fftSize) ||
    !includesValue(windows, value.window) ||
    !includesValue(overlaps, value.overlap) ||
    channel === null ||
    !includesValue(frequencyScales, value.frequencyScale) ||
    !Number.isFinite(value.minDb) ||
    !Number.isFinite(value.maxDb) ||
    (value.minDb as number) >= (value.maxDb as number) ||
    (value.maxDb as number) > 0
  ) {
    return null
  }

  return {
    fftSize: value.fftSize,
    window: value.window,
    overlap: value.overlap,
    channel,
    frequencyScale: value.frequencyScale,
    minDb: value.minDb as number,
    maxDb: value.maxDb as number,
  }
}

function parseLegacyAnalysisConfig(
  value: unknown,
): WorkspaceAnalysisConfig | null {
  if (!isRecord(value)) {
    return null
  }

  const legacyChannel = value.channel
  if (!includesValue(['mix', 'left', 'right'] as const, legacyChannel)) {
    return null
  }

  return parseAnalysisConfig({
    ...value,
    channel:
      legacyChannel === 'left'
        ? 0
        : legacyChannel === 'right'
          ? 1
          : 'mix',
  })
}

function parseAnalysisChannel(value: unknown): 'mix' | number | null {
  if (value === 'mix') {
    return value
  }
  return isNonNegativeSafeInteger(value) ? value : null
}

function parseVisibleChannels(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const channels: number[] = []
  for (const channel of value) {
    if (!isNonNegativeSafeInteger(channel)) {
      return null
    }
    channels.push(channel)
  }

  return [...new Set(channels)].sort((left, right) => left - right)
}

function parseActiveAsset(value: unknown): ImportedAudioMetadata | null {
  if (!isRecord(value)) {
    return null
  }

  if (
    typeof value.name !== 'string' ||
    value.name.trim().length === 0 ||
    !(value.extension === null || typeof value.extension === 'string') ||
    typeof value.mimeType !== 'string' ||
    !isPositiveSafeInteger(value.sizeBytes) ||
    !isNonNegativeSafeInteger(value.lastModified) ||
    typeof value.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !Number.isFinite(value.durationSeconds) ||
    (value.durationSeconds as number) <= 0 ||
    !Number.isFinite(value.sampleRate) ||
    (value.sampleRate as number) <= 0 ||
    !isPositiveSafeInteger(value.numberOfChannels) ||
    !isPositiveSafeInteger(value.lengthSamples) ||
    !isPositiveSafeInteger(value.pcmBytes)
  ) {
    return null
  }

  return {
    name: value.name,
    extension: value.extension,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    lastModified: value.lastModified,
    fingerprint: value.fingerprint,
    durationSeconds: value.durationSeconds as number,
    sampleRate: value.sampleRate as number,
    numberOfChannels: value.numberOfChannels,
    lengthSamples: value.lengthSamples,
    pcmBytes: value.pcmBytes,
  }
}

function parseSelection(value: unknown): SampleSelection | null {
  if (!isRecord(value)) {
    return null
  }

  const start = parseSampleIndex(value.start)
  const end = parseSampleIndex(value.end)
  if (start === null || end === null || start > end) {
    return null
  }
  return { start, end }
}

function parseSampleIndex(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null
}

function assertWithinActiveAsset(
  sample: number,
  activeAsset: ImportedAudioMetadata | null | undefined,
): void {
  if (!isWithinActiveAsset(sample, activeAsset)) {
    throw new RangeError('sample position exceeds active asset length')
  }
}

function isWithinActiveAsset(
  sample: number,
  activeAsset: ImportedAudioMetadata | null | undefined,
): boolean {
  return !activeAsset || sample <= activeAsset.lengthSamples
}

function cloneStoredSnapshot(
  snapshot: StoredRecentWorkspace,
): StoredRecentWorkspace {
  return {
    schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
    updatedAt: snapshot.updatedAt,
    analysisConfig: { ...snapshot.analysisConfig },
    ...('activeAsset' in snapshot
      ? {
          activeAsset: snapshot.activeAsset
            ? { ...snapshot.activeAsset }
            : null,
        }
      : {}),
    ...('selection' in snapshot
      ? {
          selection: snapshot.selection
            ? { ...snapshot.selection }
            : null,
        }
      : {}),
    ...('playheadSample' in snapshot
      ? { playheadSample: snapshot.playheadSample }
      : {}),
    ...('visibleChannels' in snapshot
      ? { visibleChannels: [...(snapshot.visibleChannels ?? [])] }
      : {}),
  }
}

function readGlobalIndexedDb(): IDBFactory | null {
  try {
    return typeof globalThis.indexedDB === 'undefined'
      ? null
      : globalThis.indexedDB
  } catch {
    return null
  }
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false
    let request: IDBOpenDBRequest
    try {
      request = factory.open(databaseName, PROJECT_STORE_SCHEMA_VERSION)
    } catch (error) {
      reject(error)
      return
    }

    request.onupgradeneeded = () => {
      try {
        const database = request.result
        if (!database.objectStoreNames.contains(PROJECTS_OBJECT_STORE)) {
          database.createObjectStore(PROJECTS_OBJECT_STORE)
        }
      } catch (error) {
        try {
          request.transaction?.abort()
        } catch {
          // The upgrade transaction may already be aborting.
        }
        settled = true
        reject(error)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      settled = true
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => {
      if (!settled) {
        settled = true
        reject(request.error ?? new Error('IndexedDB open failed'))
      }
    }
    request.onblocked = () => {
      if (!settled) {
        settled = true
        reject(new Error('IndexedDB open was blocked'))
      }
    }
  })
}

async function putValue(
  database: IDBDatabase,
  snapshot: StoredRecentWorkspace,
): Promise<void> {
  const transaction = database.transaction(PROJECTS_OBJECT_STORE, 'readwrite')
  const request = transaction
    .objectStore(PROJECTS_OBJECT_STORE)
    .put(snapshot, RECENT_WORKSPACE_KEY)
  await Promise.all([requestResult(request), transactionComplete(transaction)])
}

async function getValue(database: IDBDatabase): Promise<unknown> {
  const transaction = database.transaction(PROJECTS_OBJECT_STORE, 'readonly')
  const request = transaction
    .objectStore(PROJECTS_OBJECT_STORE)
    .get(RECENT_WORKSPACE_KEY)
  const [value] = await Promise.all([
    requestResult(request),
    transactionComplete(transaction),
  ])
  return value
}

async function deleteValue(database: IDBDatabase): Promise<void> {
  const transaction = database.transaction(PROJECTS_OBJECT_STORE, 'readwrite')
  const request = transaction
    .objectStore(PROJECTS_OBJECT_STORE)
    .delete(RECENT_WORKSPACE_KEY)
  await Promise.all([requestResult(request), transactionComplete(transaction)])
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function includesValue<T>(values: readonly T[], value: unknown): value is T {
  return values.some((candidate) => candidate === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
