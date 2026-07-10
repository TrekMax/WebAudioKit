import { describe, expect, it } from 'vitest'

import type { ImportedAudioMetadata } from '../audio/importAudio'
import { DEFAULT_ANALYSIS_CONFIG } from '../workspaceTypes'
import {
  PROJECT_STORE_SCHEMA_VERSION,
  createProjectStore,
} from './projectStore'

const ACTIVE_ASSET: ImportedAudioMetadata = {
  name: 'tone.wav',
  extension: 'wav',
  mimeType: 'audio/wav',
  sizeBytes: 512,
  lastModified: 123,
  fingerprint: 'a'.repeat(64),
  durationSeconds: 0.25,
  sampleRate: 48_000,
  numberOfChannels: 2,
  lengthSamples: 12_000,
  pcmBytes: 96_000,
}

const EIGHT_CHANNEL_ASSET: ImportedAudioMetadata = {
  ...ACTIVE_ASSET,
  numberOfChannels: 8,
  pcmBytes: 384_000,
}

describe('ProjectStore', () => {
  it('saves a schema-v3 serializable snapshot in memory when IndexedDB is unavailable', async () => {
    const store = createProjectStore({
      indexedDB: null,
      now: () => 1_000,
    })

    const saved = await store.save({
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      activeAsset: ACTIVE_ASSET,
      selection: { start: 100, end: 200 },
      playheadSample: 150,
      visibleChannels: [1, 0, 1],
      mutedChannels: [1],
      soloChannels: [0],
      channelLayout: 'stereo',
      spectrumComparison: true,
    })

    expect(store.persistenceMode).toBe('memory')
    expect(saved).toEqual({
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      updatedAt: 1_000,
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      activeAsset: ACTIVE_ASSET,
      selection: { start: 100, end: 200 },
      playheadSample: 150,
      visibleChannels: [0, 1],
      mutedChannels: [1],
      soloChannels: [0],
      channelLayout: 'stereo',
      spectrumComparison: true,
    })
    await expect(store.load()).resolves.toEqual(saved)
  })

  it('whitelists metadata fields and never persists File or AudioBuffer values', async () => {
    const runtimeAsset = {
      ...ACTIVE_ASSET,
      file: new File([Uint8Array.of(1)], 'tone.wav'),
      audioBuffer: { length: 12_000 } as AudioBuffer,
    }
    const runtimeConfig: typeof DEFAULT_ANALYSIS_CONFIG & {
      readonly runtimeWorker: { readonly terminate: () => void }
    } = {
      ...DEFAULT_ANALYSIS_CONFIG,
      runtimeWorker: { terminate: () => undefined },
    }
    const store = createProjectStore({ indexedDB: null, now: () => 2_000 })

    const saved = await store.save({
      analysisConfig: runtimeConfig,
      activeAsset: runtimeAsset,
    })

    expect(saved.analysisConfig).toEqual(DEFAULT_ANALYSIS_CONFIG)
    expect(saved.activeAsset).toEqual(ACTIVE_ASSET)
    expect(saved.activeAsset).not.toHaveProperty('file')
    expect(saved.activeAsset).not.toHaveProperty('audioBuffer')
  })

  it('returns isolated copies and validates sample boundaries before saving', async () => {
    const store = createProjectStore({ indexedDB: null, now: () => 3_000 })
    const saved = await store.save({
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      activeAsset: ACTIVE_ASSET,
      selection: { start: 20, end: 40 },
      visibleChannels: [1, 0],
      mutedChannels: [1],
    })

    ;(saved.analysisConfig as { fftSize: number }).fftSize = 512
    ;(saved.selection as { start: number }).start = 0
    saved.visibleChannels?.push(7)
    saved.mutedChannels?.push(0)

    await expect(store.load()).resolves.toMatchObject({
      analysisConfig: { fftSize: 2048 },
      selection: { start: 20, end: 40 },
      visibleChannels: [0, 1],
      mutedChannels: [1],
    })
    await expect(
      store.save({
        analysisConfig: DEFAULT_ANALYSIS_CONFIG,
        activeAsset: ACTIVE_ASSET,
        selection: { start: 20, end: 12_001 },
      }),
    ).rejects.toThrow('sample position exceeds active asset length')
  })

  it('accepts an eighth-channel analysis index', async () => {
    const store = createProjectStore({ indexedDB: null, now: () => 3_500 })

    const saved = await store.save({
      analysisConfig: { ...DEFAULT_ANALYSIS_CONFIG, channel: 7 },
      activeAsset: EIGHT_CHANNEL_ASSET,
      visibleChannels: [7],
      mutedChannels: [6],
      soloChannels: [7],
      channelLayout: '7.1',
    })

    expect(saved.analysisConfig.channel).toBe(7)
    expect(saved.visibleChannels).toEqual([7])
    expect(saved).toMatchObject({
      mutedChannels: [6],
      soloChannels: [7],
      channelLayout: '7.1',
    })
  })

  it('normalizes duplicate visible channels and rejects invalid indexes', async () => {
    const store = createProjectStore({ indexedDB: null, now: () => 3_600 })

    const saved = await store.save({
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      visibleChannels: [7, 2, 7, 0, 2],
    })
    expect(saved.visibleChannels).toEqual([0, 2, 7])
    await expect(store.save({
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      visibleChannels: [],
    })).resolves.toMatchObject({ visibleChannels: [] })

    for (const visibleChannels of [
      [-1],
      [1.5],
      [Number.MAX_SAFE_INTEGER + 1],
    ]) {
      await expect(
        store.save({
          analysisConfig: DEFAULT_ANALYSIS_CONFIG,
          visibleChannels,
        }),
      ).rejects.toThrow(
        'visibleChannels must contain only non-negative safe integers',
      )
    }
  })

  it('rejects invalid channel and routing data stored with schema v3', async () => {
    const invalidChannelFactory = new FakeIndexedDbFactory()
    invalidChannelFactory.hasProjectsStore = true
    invalidChannelFactory.records.set('recent-workspace', {
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      updatedAt: 3_700,
      analysisConfig: { ...DEFAULT_ANALYSIS_CONFIG, channel: -1 },
    })
    const invalidChannelStore = createProjectStore({
      indexedDB: invalidChannelFactory.asFactory(),
      databaseName: 'invalid-analysis-channel-test',
    })
    await expect(invalidChannelStore.load()).resolves.toBeNull()

    const invalidVisibleFactory = new FakeIndexedDbFactory()
    invalidVisibleFactory.hasProjectsStore = true
    invalidVisibleFactory.records.set('recent-workspace', {
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      updatedAt: 3_800,
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      visibleChannels: [0, 1.5],
    })
    const invalidVisibleStore = createProjectStore({
      indexedDB: invalidVisibleFactory.asFactory(),
      databaseName: 'invalid-visible-channels-test',
    })
    await expect(invalidVisibleStore.load()).resolves.toBeNull()

    const invalidRoutingFactory = new FakeIndexedDbFactory()
    invalidRoutingFactory.hasProjectsStore = true
    invalidRoutingFactory.records.set('recent-workspace', {
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      updatedAt: 3_850,
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      activeAsset: ACTIVE_ASSET,
      mutedChannels: [2],
      channelLayout: '5.1',
    })
    const invalidRoutingStore = createProjectStore({
      indexedDB: invalidRoutingFactory.asFactory(),
      databaseName: 'invalid-routing-test',
    })
    await expect(invalidRoutingStore.load()).resolves.toBeNull()
  })

  it.each([
    ['mix', 'mix'],
    ['left', 0],
    ['right', 1],
  ] as const)(
    'migrates schema-v1 channel %s to schema v3',
    async (legacyChannel, expectedChannel) => {
      const indexedDB = new FakeIndexedDbFactory()
      indexedDB.hasProjectsStore = true
      indexedDB.records.set('recent-workspace', {
        schemaVersion: 1,
        updatedAt: 3_900,
        analysisConfig: {
          ...DEFAULT_ANALYSIS_CONFIG,
          channel: legacyChannel,
        },
      })
      const store = createProjectStore({
        indexedDB: indexedDB.asFactory(),
        databaseName: `schema-v1-${legacyChannel}-migration-test`,
      })

      await expect(store.load()).resolves.toMatchObject({
        schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
        analysisConfig: { channel: expectedChannel },
      })
      expect(indexedDB.records.get('recent-workspace')).toMatchObject({
        schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
        analysisConfig: { channel: expectedChannel },
      })
      expect(indexedDB.openVersions).toEqual([PROJECT_STORE_SCHEMA_VERSION])
    },
  )

  it('migrates schema-v2 visible channels and writes schema v3', async () => {
    const indexedDB = new FakeIndexedDbFactory()
    indexedDB.hasProjectsStore = true
    indexedDB.records.set('recent-workspace', {
      schemaVersion: 2,
      updatedAt: 3_950,
      analysisConfig: { ...DEFAULT_ANALYSIS_CONFIG, channel: 1 },
      activeAsset: ACTIVE_ASSET,
      visibleChannels: [1],
    })
    const store = createProjectStore({
      indexedDB: indexedDB.asFactory(),
      databaseName: 'schema-v2-migration-test',
    })

    await expect(store.load()).resolves.toMatchObject({
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      analysisConfig: { channel: 1 },
      visibleChannels: [1],
    })
    expect(indexedDB.records.get('recent-workspace')).toMatchObject({
      schemaVersion: PROJECT_STORE_SCHEMA_VERSION,
      visibleChannels: [1],
    })
  })

  it('round-trips and clears multichannel preferences through IndexedDB schema v3', async () => {
    const indexedDB = new FakeIndexedDbFactory()
    const firstStore = createProjectStore({
      indexedDB: indexedDB.asFactory(),
      databaseName: 'project-store-test',
      now: () => 4_000,
    })
    const expected = await firstStore.save({
      analysisConfig: { ...DEFAULT_ANALYSIS_CONFIG, channel: 7 },
      activeAsset: EIGHT_CHANNEL_ASSET,
      selection: null,
      playheadSample: 64,
      visibleChannels: [7, 0, 3, 7],
      mutedChannels: [4, 1],
      soloChannels: [7],
      channelLayout: '7.1',
      spectrumComparison: true,
    })
    firstStore.close()

    const secondStore = createProjectStore({
      indexedDB: indexedDB.asFactory(),
      databaseName: 'project-store-test',
    })
    await expect(secondStore.load()).resolves.toEqual(expected)
    expect(expected.visibleChannels).toEqual([0, 3, 7])
    expect(expected.mutedChannels).toEqual([1, 4])
    expect(indexedDB.openVersions).toEqual([3, 3])

    await secondStore.clear()
    secondStore.close()
    const thirdStore = createProjectStore({
      indexedDB: indexedDB.asFactory(),
      databaseName: 'project-store-test',
    })
    await expect(thirdStore.load()).resolves.toBeNull()
  })

  it('keeps the current-session snapshot when IndexedDB throws', async () => {
    const failingFactory = {
      open(): IDBOpenDBRequest {
        throw new DOMException('denied', 'SecurityError')
      },
    } as unknown as IDBFactory
    const store = createProjectStore({
      indexedDB: failingFactory,
      now: () => 5_000,
    })

    const saved = await store.save({
      analysisConfig: DEFAULT_ANALYSIS_CONFIG,
      playheadSample: 25,
    })

    expect(store.persistenceMode).toBe('memory')
    await expect(store.load()).resolves.toEqual(saved)
  })
})

class FakeRequest<T> {
  result!: T
  error: DOMException | null = null
  onsuccess: (() => unknown) | null = null
  onerror: (() => unknown) | null = null

  succeed(result: T): void {
    this.result = result
    this.onsuccess?.()
  }
}

class FakeOpenRequest extends FakeRequest<IDBDatabase> {
  onupgradeneeded: (() => unknown) | null = null
  onblocked: (() => unknown) | null = null
}

class FakeTransaction {
  error: DOMException | null = null
  oncomplete: (() => unknown) | null = null
  onerror: (() => unknown) | null = null
  onabort: (() => unknown) | null = null

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    const put = (value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> =>
      this.schedule<IDBValidKey>(() => {
        const normalizedKey = normalizeKey(key)
        this.records.set(normalizedKey, structuredClone(value))
        return normalizedKey
      })
    const get = (key: IDBValidKey | IDBKeyRange): IDBRequest<unknown> =>
      this.schedule(() => structuredClone(this.records.get(normalizeKey(key))))
    const deleteValue = (key: IDBValidKey | IDBKeyRange): IDBRequest<undefined> =>
      this.schedule(() => {
        this.records.delete(normalizeKey(key))
        return undefined
      })

    return {
      put,
      get,
      delete: deleteValue,
    } as unknown as IDBObjectStore
  }

  private schedule<T>(operation: () => T): IDBRequest<T> {
    const request = new FakeRequest<T>()
    queueMicrotask(() => {
      request.succeed(operation())
      queueMicrotask(() => this.oncomplete?.())
    })
    return request as unknown as IDBRequest<T>
  }
}

class FakeDatabase {
  onversionchange: (() => unknown) | null = null

  constructor(private readonly owner: FakeIndexedDbFactory) {}

  get objectStoreNames(): DOMStringList {
    return {
      contains: (name: string) =>
        name === 'projects' && this.owner.hasProjectsStore,
    } as unknown as DOMStringList
  }

  createObjectStore(name: string): IDBObjectStore {
    if (name === 'projects') {
      this.owner.hasProjectsStore = true
    }
    return {} as IDBObjectStore
  }

  transaction(): IDBTransaction {
    if (!this.owner.hasProjectsStore) {
      throw new DOMException('missing store', 'NotFoundError')
    }
    return new FakeTransaction(this.owner.records) as unknown as IDBTransaction
  }

  close(): void {}
}

class FakeIndexedDbFactory {
  readonly records = new Map<string, unknown>()
  readonly openVersions: number[] = []
  hasProjectsStore = false

  asFactory(): IDBFactory {
    return this as unknown as IDBFactory
  }

  open(_name: string, version?: number): IDBOpenDBRequest {
    this.openVersions.push(version ?? 1)
    const request = new FakeOpenRequest()
    queueMicrotask(() => {
      const needsUpgrade = !this.hasProjectsStore
      request.result = new FakeDatabase(this) as unknown as IDBDatabase
      if (needsUpgrade) {
        request.onupgradeneeded?.()
      }
      request.onsuccess?.()
    })
    return request as unknown as IDBOpenDBRequest
  }
}

function normalizeKey(key: IDBValidKey | IDBKeyRange | undefined): string {
  if (typeof key !== 'string') {
    throw new TypeError('Fake IndexedDB only accepts string keys')
  }
  return key
}
