const MAX_PREVIEW_CHANNELS = 2
const DEFAULT_SAMPLES_PER_COLUMN = 24
const TRACK_PREVIEW_VIEWPORT_RATIO = 0.6
const TRACK_PREVIEW_CHROME_HEIGHT = 72

export const MIN_TRACK_LANE_HEIGHT = 56

export function maximumTrackLaneHeight(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return MIN_TRACK_LANE_HEIGHT
  }
  return Math.max(
    MIN_TRACK_LANE_HEIGHT,
    Math.floor(
      (viewportHeight * TRACK_PREVIEW_VIEWPORT_RATIO - TRACK_PREVIEW_CHROME_HEIGHT) / 2,
    ),
  )
}

export interface TrackOverview {
  readonly mins: Float32Array
  readonly maxs: Float32Array
}

/**
 * Builds a bounded-cost visual overview without copying source PCM. Each
 * column samples a fixed number of frames from at most two source channels.
 */
export function buildTrackOverview(
  channels: readonly Float32Array[],
  columns: number,
  samplesPerColumn = DEFAULT_SAMPLES_PER_COLUMN,
): TrackOverview {
  if (!Number.isSafeInteger(columns) || columns <= 0 || columns > 4_096) {
    throw new RangeError('Track preview columns must be within [1, 4096]')
  }
  if (!Number.isSafeInteger(samplesPerColumn) || samplesPerColumn <= 0 || samplesPerColumn > 256) {
    throw new RangeError('Track preview samples per column must be within [1, 256]')
  }

  const mins = new Float32Array(columns)
  const maxs = new Float32Array(columns)
  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  const length = sourceChannels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  )
  if (sourceChannels.length === 0 || !Number.isFinite(length) || length <= 0) {
    return { mins, maxs }
  }

  for (let column = 0; column < columns; column += 1) {
    const start = Math.floor((column / columns) * length)
    const end = Math.max(start + 1, Math.floor(((column + 1) / columns) * length))
    const span = Math.max(1, end - start)
    const sampleCount = Math.min(samplesPerColumn, span)
    let minimum = 1
    let maximum = -1

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const ratio = sampleCount <= 1 ? 0 : sample / (sampleCount - 1)
      const index = Math.min(length - 1, start + Math.floor(ratio * (span - 1)))
      for (const channel of sourceChannels) {
        const value = channel[index] ?? 0
        if (!Number.isFinite(value)) continue
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
    }

    mins[column] = minimum <= maximum ? minimum : 0
    maxs[column] = minimum <= maximum ? maximum : 0
  }

  return { mins, maxs }
}
