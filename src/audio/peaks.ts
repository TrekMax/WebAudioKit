export const DEFAULT_PEAK_BLOCK_SIZE = 256

export interface PeakChannel {
  readonly mins: Float32Array
  readonly maxs: Float32Array
}

export interface PeakLevel {
  readonly samplesPerBlock: number
  readonly channels: readonly PeakChannel[]
}

export interface WaveformPyramid {
  readonly assetId: string
  readonly sourceLength: number
  readonly baseBlockSize: number
  readonly levels: readonly PeakLevel[]
}

export interface PeakBuildProgress {
  readonly completed: number
  readonly total: number
}

export interface BuildPeakPyramidOptions {
  readonly assetId: string
  readonly baseBlockSize?: number
  /** Number of produced channel blocks between cooperative event-loop yields. */
  readonly yieldEveryBlocks?: number
}

export interface PeakBuildControl {
  readonly shouldCancel?: () => boolean
  readonly onProgress?: (progress: PeakBuildProgress) => void
  /** Injectable for deterministic tests. The default yields with setTimeout(0). */
  readonly yieldToEventLoop?: () => Promise<void>
}

export class PeakBuildCancelledError extends Error {
  constructor() {
    super('Peak pyramid build was cancelled')
    this.name = 'PeakBuildCancelledError'
  }
}

function assertChannels(channels: readonly Float32Array[]): number {
  if (channels.length === 0) {
    throw new RangeError('At least one PCM channel is required')
  }

  const sourceLength = channels[0]?.length ?? 0
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const channel = channels[channelIndex]
    if (!(channel instanceof Float32Array)) {
      throw new TypeError(`channels[${channelIndex}] must be a Float32Array`)
    }
    if (channel.length !== sourceLength) {
      throw new RangeError(
        `All PCM channels must have the same length; channel 0 has ${sourceLength} samples and channel ${channelIndex} has ${channel.length}`,
      )
    }
  }

  return sourceLength
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function countPyramidBlocks(baseBlockCount: number): number {
  let total = 0
  let blockCount = baseBlockCount

  while (blockCount > 0) {
    total += blockCount
    if (blockCount === 1) {
      break
    }
    blockCount = Math.ceil(blockCount / 2)
  }

  return total
}

function finiteSampleOrZero(value: number | undefined): number {
  return Number.isFinite(value) ? (value ?? 0) : 0
}

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * Builds a min/max waveform pyramid without modifying or copying the source
 * PCM. A partial final block contains only real source samples; it is never
 * padded with zero, which prevents a false edge crossing on one-sided audio.
 */
export async function buildPeakPyramid(
  channels: readonly Float32Array[],
  options: BuildPeakPyramidOptions,
  control: PeakBuildControl = {},
): Promise<WaveformPyramid> {
  const sourceLength = assertChannels(channels)
  const baseBlockSize = options.baseBlockSize ?? DEFAULT_PEAK_BLOCK_SIZE
  const yieldEveryBlocks = options.yieldEveryBlocks ?? 512
  assertPositiveSafeInteger(baseBlockSize, 'Peak base block size')
  assertPositiveSafeInteger(yieldEveryBlocks, 'yieldEveryBlocks')

  if (typeof options.assetId !== 'string' || options.assetId.length === 0) {
    throw new RangeError('assetId must not be empty')
  }

  const baseBlockCount = Math.ceil(sourceLength / baseBlockSize)
  const total = countPyramidBlocks(baseBlockCount) * channels.length
  let completed = 0
  let completedSinceYield = 0
  const levels: PeakLevel[] = []
  const yieldToEventLoop = control.yieldToEventLoop ?? defaultYieldToEventLoop

  const checkCancelled = (): void => {
    if (control.shouldCancel?.()) {
      throw new PeakBuildCancelledError()
    }
  }

  const reportAndMaybeYield = (force = false): Promise<void> | undefined => {
    if (!force && completedSinceYield < yieldEveryBlocks) {
      return undefined
    }

    control.onProgress?.({ completed, total })
    completedSinceYield = 0
    if (completed < total) {
      return yieldToEventLoop().then(checkCancelled)
    }
    return undefined
  }

  checkCancelled()
  control.onProgress?.({ completed: 0, total })

  if (sourceLength === 0) {
    return {
      assetId: options.assetId,
      sourceLength,
      baseBlockSize,
      levels,
    }
  }

  const baseChannels: PeakChannel[] = []
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const source = channels[channelIndex]
    if (source === undefined) {
      throw new RangeError(`Missing PCM channel ${channelIndex}`)
    }

    const mins = new Float32Array(baseBlockCount)
    const maxs = new Float32Array(baseBlockCount)

    for (let blockIndex = 0; blockIndex < baseBlockCount; blockIndex += 1) {
      checkCancelled()
      const start = blockIndex * baseBlockSize
      const end = Math.min(sourceLength, start + baseBlockSize)
      let min = Number.POSITIVE_INFINITY
      let max = Number.NEGATIVE_INFINITY

      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const sample = finiteSampleOrZero(source[sampleIndex])
        min = Math.min(min, sample)
        max = Math.max(max, sample)
      }

      mins[blockIndex] = min
      maxs[blockIndex] = max
      completed += 1
      completedSinceYield += 1
      const pause = reportAndMaybeYield()
      if (pause !== undefined) {
        await pause
      }
    }

    baseChannels.push({ mins, maxs })
  }

  const baseLevel: PeakLevel = {
    samplesPerBlock: baseBlockSize,
    channels: baseChannels,
  }
  levels.push(baseLevel)

  let previousLevel = baseLevel
  while ((previousLevel.channels[0]?.mins.length ?? 0) > 1) {
    checkCancelled()
    const previousBlockCount = previousLevel.channels[0]?.mins.length ?? 0
    const nextBlockCount = Math.ceil(previousBlockCount / 2)
    const nextChannels: PeakChannel[] = []

    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const previousChannel = previousLevel.channels[channelIndex]
      if (previousChannel === undefined) {
        throw new RangeError(`Peak level is missing channel ${channelIndex}`)
      }

      const mins = new Float32Array(nextBlockCount)
      const maxs = new Float32Array(nextBlockCount)

      for (let blockIndex = 0; blockIndex < nextBlockCount; blockIndex += 1) {
        checkCancelled()
        const firstIndex = blockIndex * 2
        const secondIndex = firstIndex + 1
        const firstMin = previousChannel.mins[firstIndex]
        const firstMax = previousChannel.maxs[firstIndex]
        if (firstMin === undefined || firstMax === undefined) {
          throw new RangeError(`Peak level is missing block ${firstIndex}`)
        }

        const secondMin = previousChannel.mins[secondIndex]
        const secondMax = previousChannel.maxs[secondIndex]
        mins[blockIndex] = secondMin === undefined
          ? firstMin
          : Math.min(firstMin, secondMin)
        maxs[blockIndex] = secondMax === undefined
          ? firstMax
          : Math.max(firstMax, secondMax)
        completed += 1
        completedSinceYield += 1
        const pause = reportAndMaybeYield()
        if (pause !== undefined) {
          await pause
        }
      }

      nextChannels.push({ mins, maxs })
    }

    const nextLevel: PeakLevel = {
      samplesPerBlock: previousLevel.samplesPerBlock * 2,
      channels: nextChannels,
    }
    levels.push(nextLevel)
    previousLevel = nextLevel
  }

  const finalPause = reportAndMaybeYield(true)
  if (finalPause !== undefined) {
    await finalPause
  }

  return {
    assetId: options.assetId,
    sourceLength,
    baseBlockSize,
    levels,
  }
}

/** Combines independently built channel pyramids without copying peak arrays. */
export function mergeWaveformPyramids(
  pyramids: readonly WaveformPyramid[],
): WaveformPyramid {
  const first = pyramids[0]
  if (!first) throw new RangeError('At least one waveform pyramid is required')

  for (const pyramid of pyramids) {
    if (
      pyramid.assetId !== first.assetId
      || pyramid.sourceLength !== first.sourceLength
      || pyramid.baseBlockSize !== first.baseBlockSize
      || pyramid.levels.length !== first.levels.length
    ) throw new RangeError('Waveform pyramid layouts must match')
  }

  return {
    assetId: first.assetId,
    sourceLength: first.sourceLength,
    baseBlockSize: first.baseBlockSize,
    levels: first.levels.map((firstLevel, levelIndex) => ({
      samplesPerBlock: firstLevel.samplesPerBlock,
      channels: pyramids.flatMap((pyramid) => {
        const level = pyramid.levels[levelIndex]
        if (!level || level.samplesPerBlock !== firstLevel.samplesPerBlock) {
          throw new RangeError('Waveform pyramid levels must match')
        }
        return level.channels
      }),
    })),
  }
}
