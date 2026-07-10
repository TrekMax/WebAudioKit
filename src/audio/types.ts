export type AssetId = string

/**
 * An integer frame index into decoded PCM. Audio ranges are always half-open:
 * `[start, end)`.
 */
export type SampleIndex = number

export interface SampleRange {
  readonly start: SampleIndex
  readonly end: SampleIndex
}

export type PlaybackKind =
  | 'empty'
  | 'locked'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'

export interface PlaybackSnapshot {
  readonly kind: PlaybackKind
  readonly assetId: AssetId | null
  readonly positionSample: SampleIndex
  readonly durationSamples: SampleIndex
  readonly positionSeconds: number
  readonly durationSeconds: number
  readonly sampleRate: number | null
  readonly numberOfChannels: number
  readonly selection: SampleRange | null
  readonly loop: boolean
  readonly volume: number
  readonly muted: boolean
  readonly playbackRate: number
  readonly contextState: AudioContextState
  readonly sessionId: string | null
  readonly errorMessage: string | null
}

export interface LoadAudioOptions {
  readonly assetId?: AssetId
  readonly positionSample?: SampleIndex
  readonly selection?: SampleRange | null
}

export interface AudioEngineOptions {
  /** Supply a context for application ownership or deterministic tests. */
  readonly context?: AudioContext
  /** Used only when `context` is not supplied. */
  readonly contextFactory?: () => AudioContext
  /** Gain transition duration used to avoid clicks. Defaults to 5 ms. */
  readonly gainRampSeconds?: number
}

export type PlaybackListener = (snapshot: PlaybackSnapshot) => void

export function isSampleIndex(value: number): value is SampleIndex {
  return Number.isSafeInteger(value) && value >= 0
}

export function assertSampleRange(
  range: SampleRange,
  length: SampleIndex,
  options: { allowEmpty?: boolean } = {},
): void {
  if (!isSampleIndex(length)) {
    throw new RangeError('PCM length must be a non-negative safe integer')
  }

  if (!isSampleIndex(range.start) || !isSampleIndex(range.end)) {
    throw new RangeError('Sample range boundaries must be non-negative safe integers')
  }

  if (range.start > range.end || range.end > length) {
    throw new RangeError(`Sample range [${range.start}, ${range.end}) exceeds PCM length ${length}`)
  }

  if (!options.allowEmpty && range.start === range.end) {
    throw new RangeError('Sample range must contain at least one frame')
  }
}

export function sampleIndexToSeconds(sample: SampleIndex, sampleRate: number): number {
  if (!isSampleIndex(sample)) {
    throw new RangeError('Sample index must be a non-negative safe integer')
  }
  assertSampleRate(sampleRate)
  return sample / sampleRate
}

export function secondsToSampleIndex(
  seconds: number,
  sampleRate: number,
  length: SampleIndex,
): SampleIndex {
  if (!Number.isFinite(seconds)) {
    throw new RangeError('Time must be finite')
  }
  assertSampleRate(sampleRate)
  if (!isSampleIndex(length)) {
    throw new RangeError('PCM length must be a non-negative safe integer')
  }

  return Math.min(length, Math.max(0, Math.round(seconds * sampleRate)))
}

export function assertSampleRate(sampleRate: number): void {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError('Sample rate must be a positive safe integer')
  }
}
