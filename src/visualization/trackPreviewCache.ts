import type { StftPreviewResult } from '../audio/analysis'
import {
  buildTrackOverviewRange,
  buildTrackResamplerOverviewRange,
  buildTrackSpectrogramPixels,
  type TrackOverview,
  type TrackResamplerPreviewConfig,
  type TrackSpectrogramPixels,
} from './trackPreview'

const MAX_WAVEFORM_ENTRIES_PER_SOURCE = 12
const MAX_FILTERED_SPECTROGRAMS_PER_ANALYSIS = 6
const MAX_RESPONSES_PER_ANALYSIS = 6

interface SpectrogramCacheEntry {
  source?: TrackSpectrogramPixels | null
  readonly filtered: Map<string, TrackSpectrogramPixels | null>
}

const waveformOverviewCache = new WeakMap<object, Map<string, TrackOverview>>()
const spectrogramPixelCache = new WeakMap<object, SpectrogramCacheEntry>()
const frequencyResponseCache = new WeakMap<object, Map<string, Float32Array>>()

function readLru<TKey, TValue>(cache: Map<TKey, TValue>, key: TKey): TValue | undefined {
  if (!cache.has(key)) return undefined
  const value = cache.get(key) as TValue
  cache.delete(key)
  cache.set(key, value)
  return value
}

function writeLru<TKey, TValue>(
  cache: Map<TKey, TValue>,
  key: TKey,
  value: TValue,
  maximumEntries: number,
): TValue {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maximumEntries) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
  return value
}

function waveformCacheFor(sourceIdentity: object): Map<string, TrackOverview> {
  let cache = waveformOverviewCache.get(sourceIdentity)
  if (!cache) {
    cache = new Map()
    waveformOverviewCache.set(sourceIdentity, cache)
  }
  return cache
}

function waveformRangeKey(
  prefix: string,
  channelCount: number,
  columns: number,
  range: { readonly start: number; readonly end: number },
  samplesPerColumn: number,
): string {
  return [
    prefix,
    channelCount,
    columns,
    range.start,
    range.end,
    samplesPerColumn,
  ].join(':')
}

/**
 * Caches immutable source-PCM overviews by source identity and visible range.
 * A small per-source LRU bounds repeated zoom levels while the WeakMap lets a
 * closed AudioBuffer and all of its derived arrays be reclaimed together.
 */
export function getCachedTrackOverviewRange(
  sourceIdentity: object,
  channels: readonly Float32Array[],
  columns: number,
  range: { readonly start: number; readonly end: number },
  samplesPerColumn: number,
): TrackOverview {
  const cache = waveformCacheFor(sourceIdentity)
  const key = waveformRangeKey(
    'source',
    channels.length,
    columns,
    range,
    samplesPerColumn,
  )
  const cached = readLru(cache, key)
  if (cached) return cached
  return writeLru(
    cache,
    key,
    buildTrackOverviewRange(channels, columns, range, samplesPerColumn),
    MAX_WAVEFORM_ENTRIES_PER_SOURCE,
  )
}

/** Caches the bounded sampler approximation separately from the source lane. */
export function getCachedTrackResamplerOverviewRange(
  sourceIdentity: object,
  channels: readonly Float32Array[],
  columns: number,
  range: { readonly start: number; readonly end: number },
  config: TrackResamplerPreviewConfig,
  samplesPerColumn: number,
): TrackOverview {
  const cache = waveformCacheFor(sourceIdentity)
  const prefix = [
    'resampler',
    config.sourceSampleRateHz,
    config.contextSampleRateHz,
    config.targetSampleRateHz,
    config.algorithm,
  ].join(':')
  const key = waveformRangeKey(
    prefix,
    channels.length,
    columns,
    range,
    samplesPerColumn,
  )
  const cached = readLru(cache, key)
  if (cached) return cached
  return writeLru(
    cache,
    key,
    buildTrackResamplerOverviewRange(channels, columns, range, config, samplesPerColumn),
    MAX_WAVEFORM_ENTRIES_PER_SOURCE,
  )
}

type TrackSpectrogramSource = Pick<
  StftPreviewResult,
  'frameCount' | 'binCount' | 'minDb' | 'maxDb' | 'valuesDbfs'
>

/**
 * Shares the source raster between A/B and keeps filtered rasters by the
 * serialized filter revision. The STFT result identity owns the cache.
 */
export function getCachedTrackSpectrogramPixels(
  result: TrackSpectrogramSource,
  responseDb: Float32Array | null,
  responseRevision: string | null,
): TrackSpectrogramPixels | null {
  let entry = spectrogramPixelCache.get(result)
  if (!entry) {
    entry = { filtered: new Map() }
    spectrogramPixelCache.set(result, entry)
  }

  if (!responseDb) {
    if ('source' in entry) return entry.source ?? null
    entry.source = buildTrackSpectrogramPixels(result)
    return entry.source
  }
  if (!responseRevision) {
    throw new RangeError('Filtered track spectrogram cache requires a response revision')
  }

  const cached = readLru(entry.filtered, responseRevision)
  if (cached !== undefined) return cached
  return writeLru(
    entry.filtered,
    responseRevision,
    buildTrackSpectrogramPixels(result, responseDb),
    MAX_FILTERED_SPECTROGRAMS_PER_ANALYSIS,
  )
}

/** Caches a compiled frequency response without retaining its STFT owner. */
export function getCachedTrackFrequencyResponse(
  analysisIdentity: object,
  responseRevision: string,
  createResponse: () => Float32Array | null,
): Float32Array | null {
  if (responseRevision.length === 0) {
    throw new RangeError('Track frequency response revision must not be empty')
  }
  let cache = frequencyResponseCache.get(analysisIdentity)
  if (!cache) {
    cache = new Map()
    frequencyResponseCache.set(analysisIdentity, cache)
  }
  const cached = readLru(cache, responseRevision)
  if (cached) return cached
  const response = createResponse()
  if (!response) return null
  return writeLru(cache, responseRevision, response, MAX_RESPONSES_PER_ANALYSIS)
}
