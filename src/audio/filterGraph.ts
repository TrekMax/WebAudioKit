export const MAX_FILTER_NODES = 16
export const EQ_GAIN_MIN_DB = -24
export const EQ_GAIN_MAX_DB = 24
export const EQ_BAND_COUNTS = [7, 10, 15] as const

export type EqBandCount = typeof EQ_BAND_COUNTS[number]

interface EqBandPreset {
  readonly frequenciesHz: readonly number[]
  readonly q: number
}

export const EQ_BAND_PRESETS: Readonly<Record<EqBandCount, EqBandPreset>> = {
  7: {
    frequenciesHz: [60, 150, 400, 1_000, 2_500, 6_000, 16_000],
    q: 1.1,
  },
  10: {
    frequenciesHz: [31.5, 63, 125, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000],
    q: Math.SQRT2,
  },
  15: {
    frequenciesHz: [25, 40, 63, 100, 160, 250, 400, 630, 1_000, 1_600, 2_500, 4_000, 6_300, 10_000, 16_000],
    q: 2.15,
  },
}

export const DEFAULT_EQ_BAND_COUNT: EqBandCount = 10

export function isEqBandCount(value: unknown): value is EqBandCount {
  return EQ_BAND_COUNTS.some((bandCount) => bandCount === value)
}

export function getEqBandPreset(bandCount: EqBandCount): EqBandPreset {
  return EQ_BAND_PRESETS[bandCount]
}

export function remapEqGainsDb(
  gainsDb: readonly number[],
  sourceBandCount: EqBandCount,
  targetBandCount: EqBandCount,
): readonly number[] {
  const sourceFrequenciesHz = getEqBandPreset(sourceBandCount).frequenciesHz
  const targetFrequenciesHz = getEqBandPreset(targetBandCount).frequenciesHz
  if (gainsDb.length !== sourceFrequenciesHz.length) {
    throw new RangeError(`Equalizer must contain ${sourceFrequenciesHz.length} bands before remapping`)
  }
  if (sourceBandCount === targetBandCount) return [...gainsDb]

  return targetFrequenciesHz.map((targetFrequencyHz) => {
    if (targetFrequencyHz <= (sourceFrequenciesHz[0] ?? targetFrequencyHz)) {
      return clampEqGain(gainsDb[0] ?? 0)
    }
    const lastIndex = sourceFrequenciesHz.length - 1
    if (targetFrequencyHz >= (sourceFrequenciesHz[lastIndex] ?? targetFrequencyHz)) {
      return clampEqGain(gainsDb[lastIndex] ?? 0)
    }

    const upperIndex = sourceFrequenciesHz.findIndex((frequencyHz) => frequencyHz >= targetFrequencyHz)
    const lowerIndex = Math.max(0, upperIndex - 1)
    const lowerFrequencyHz = sourceFrequenciesHz[lowerIndex] ?? targetFrequencyHz
    const upperFrequencyHz = sourceFrequenciesHz[upperIndex] ?? targetFrequencyHz
    const lowerGainDb = gainsDb[lowerIndex] ?? 0
    const upperGainDb = gainsDb[upperIndex] ?? lowerGainDb
    const unit = (
      Math.log(targetFrequencyHz) - Math.log(lowerFrequencyHz)
    ) / (
      Math.log(upperFrequencyHz) - Math.log(lowerFrequencyHz)
    )
    return clampEqGain(lowerGainDb + (upperGainDb - lowerGainDb) * unit)
  })
}

function clampEqGain(gainDb: number): number {
  return Math.min(EQ_GAIN_MAX_DB, Math.max(EQ_GAIN_MIN_DB, gainDb))
}

export type FilterKind =
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'allpass'
  | 'equalizer'
  | 'resampler'

export type FilterAuditionMode = 'original' | 'filtered'

export interface FilterNodeConfig {
  readonly id: string
  readonly type: FilterKind
  readonly enabled: boolean
  readonly frequencyHz: number
  readonly q: number
  readonly gainDb: number
  readonly targetSampleRateHz: number
  readonly eqBandCount: EqBandCount
  readonly eqGainsDb: readonly number[]
}

export interface FilterDefinition {
  readonly label: string
  readonly description: string
  readonly defaultFrequencyHz: number
  readonly defaultQ: number
  readonly defaultGainDb: number
  readonly usesQ: boolean
  readonly usesGain: boolean
  readonly processingKind: 'biquad' | 'equalizer' | 'resampler'
}

export const FILTER_DEFINITIONS: Readonly<Record<FilterKind, FilterDefinition>> = {
  lowpass: {
    label: '低通',
    description: '保留截止频率以下的声音',
    defaultFrequencyHz: 5_000,
    defaultQ: Math.SQRT1_2,
    defaultGainDb: 0,
    usesQ: true,
    usesGain: false,
    processingKind: 'biquad',
  },
  highpass: {
    label: '高通',
    description: '衰减截止频率以下的声音',
    defaultFrequencyHz: 120,
    defaultQ: Math.SQRT1_2,
    defaultGainDb: 0,
    usesQ: true,
    usesGain: false,
    processingKind: 'biquad',
  },
  bandpass: {
    label: '带通',
    description: '突出中心频率附近的频段',
    defaultFrequencyHz: 1_000,
    defaultQ: 1,
    defaultGainDb: 0,
    usesQ: true,
    usesGain: false,
    processingKind: 'biquad',
  },
  notch: {
    label: '陷波',
    description: '移除狭窄的目标频率',
    defaultFrequencyHz: 50,
    defaultQ: 8,
    defaultGainDb: 0,
    usesQ: true,
    usesGain: false,
    processingKind: 'biquad',
  },
  peaking: {
    label: '峰值',
    description: '提升或削减中心频段',
    defaultFrequencyHz: 3_000,
    defaultQ: 1,
    defaultGainDb: 3,
    usesQ: true,
    usesGain: true,
    processingKind: 'biquad',
  },
  lowshelf: {
    label: '低架',
    description: '提升或削减低频区域',
    defaultFrequencyHz: 180,
    defaultQ: Math.SQRT1_2,
    defaultGainDb: 3,
    usesQ: false,
    usesGain: true,
    processingKind: 'biquad',
  },
  highshelf: {
    label: '高架',
    description: '提升或削减高频区域',
    defaultFrequencyHz: 6_000,
    defaultQ: Math.SQRT1_2,
    defaultGainDb: 3,
    usesQ: false,
    usesGain: true,
    processingKind: 'biquad',
  },
  allpass: {
    label: '全通',
    description: '保持幅度并调整相位响应',
    defaultFrequencyHz: 1_000,
    defaultQ: Math.SQRT1_2,
    defaultGainDb: 0,
    usesQ: true,
    usesGain: false,
    processingKind: 'biquad',
  },
  equalizer: {
    label: 'EQ 曲线',
    description: '可切换 7 / 10 / 15 段图示均衡曲线',
    defaultFrequencyHz: 1_000,
    defaultQ: EQ_BAND_PRESETS[DEFAULT_EQ_BAND_COUNT].q,
    defaultGainDb: 0,
    usesQ: false,
    usesGain: false,
    processingKind: 'equalizer',
  },
  resampler: {
    label: '采样器',
    description: '实时上采样或抗混叠下采样',
    defaultFrequencyHz: 1_000,
    defaultQ: Math.SQRT1_2,
    defaultGainDb: 0,
    usesQ: false,
    usesGain: false,
    processingKind: 'resampler',
  },
}

const FILTER_KINDS = Object.keys(FILTER_DEFINITIONS) as FilterKind[]

export function createFilterNodeConfig(type: FilterKind, id: string): FilterNodeConfig {
  const definition = FILTER_DEFINITIONS[type]
  if (!definition) {
    throw new RangeError(`Unsupported filter type: ${String(type)}`)
  }
  return {
    id,
    type,
    enabled: true,
    frequencyHz: definition.defaultFrequencyHz,
    q: definition.defaultQ,
    gainDb: definition.defaultGainDb,
    targetSampleRateHz: 24_000,
    eqBandCount: DEFAULT_EQ_BAND_COUNT,
    eqGainsDb: EQ_BAND_PRESETS[DEFAULT_EQ_BAND_COUNT].frequenciesHz.map(() => 0),
  }
}

export function cloneFilterNodeConfig(filter: FilterNodeConfig): FilterNodeConfig {
  return { ...filter, eqGainsDb: [...filter.eqGainsDb] }
}

export function validateFilterChain(
  filters: readonly FilterNodeConfig[],
): readonly FilterNodeConfig[] {
  if (filters.length > MAX_FILTER_NODES) {
    throw new RangeError(`Filter chain cannot exceed ${MAX_FILTER_NODES} nodes`)
  }

  const ids = new Set<string>()
  for (const filter of filters) {
    if (typeof filter.id !== 'string' || filter.id.trim().length === 0) {
      throw new RangeError('Filter node id must not be empty')
    }
    if (ids.has(filter.id)) {
      throw new RangeError(`Filter node id must be unique: ${filter.id}`)
    }
    ids.add(filter.id)
    if (!FILTER_KINDS.includes(filter.type)) {
      throw new RangeError(`Unsupported filter type: ${String(filter.type)}`)
    }
    if (typeof filter.enabled !== 'boolean') {
      throw new TypeError('Filter enabled state must be boolean')
    }
    if (!Number.isFinite(filter.frequencyHz) || filter.frequencyHz <= 0 || filter.frequencyHz > 96_000) {
      throw new RangeError('Filter frequency must be within (0, 96000] Hz')
    }
    if (!Number.isFinite(filter.q) || filter.q <= 0 || filter.q > 1_000) {
      throw new RangeError('Filter Q must be within (0, 1000]')
    }
    if (!Number.isFinite(filter.gainDb) || filter.gainDb < -40 || filter.gainDb > 40) {
      throw new RangeError('Filter gain must be within [-40, 40] dB')
    }
    if (!isEqBandCount(filter.eqBandCount)) {
      throw new RangeError(`Equalizer band count must be one of ${EQ_BAND_COUNTS.join(', ')}`)
    }
    if (filter.type === 'equalizer') {
      const preset = getEqBandPreset(filter.eqBandCount)
      if (!Array.isArray(filter.eqGainsDb) || filter.eqGainsDb.length !== preset.frequenciesHz.length) {
        throw new RangeError(`Equalizer must contain ${preset.frequenciesHz.length} bands`)
      }
      for (const gainDb of filter.eqGainsDb) {
        if (!Number.isFinite(gainDb) || gainDb < EQ_GAIN_MIN_DB || gainDb > EQ_GAIN_MAX_DB) {
          throw new RangeError(`Equalizer gain must be within [${EQ_GAIN_MIN_DB}, ${EQ_GAIN_MAX_DB}] dB`)
        }
      }
    }
    if (
      filter.type === 'resampler'
      && (
        !Number.isFinite(filter.targetSampleRateHz)
        || filter.targetSampleRateHz < 3_000
        || filter.targetSampleRateHz > 192_000
      )
    ) {
      throw new RangeError('Resampler target sample rate must be within [3000, 192000] Hz')
    }
  }

  return filters
}

/**
 * Compiles the enabled declarative nodes into a disconnected Web Audio chain.
 * The caller owns connection order and must disconnect every returned node.
 */
export function compileFilterChain(
  context: Pick<BaseAudioContext, 'createBiquadFilter' | 'currentTime'>,
  filters: readonly FilterNodeConfig[],
  createResamplerNode?: (filter: FilterNodeConfig) => AudioNode,
): AudioNode[] {
  validateFilterChain(filters)
  const compiled: AudioNode[] = []

  try {
    for (const filter of filters) {
      if (!filter.enabled) continue
      const nodes: AudioNode[] = []
      if (filter.type === 'equalizer') {
        const preset = getEqBandPreset(filter.eqBandCount)
        for (let index = 0; index < preset.frequenciesHz.length; index += 1) {
          const node = context.createBiquadFilter()
          nodes.push(node)
          compiled.push(node)
        }
      } else {
        const node = filter.type === 'resampler'
          ? createResamplerNode?.(filter)
          : context.createBiquadFilter()
        if (!node) {
          throw new Error('Resampler node factory is unavailable')
        }
        nodes.push(node)
        compiled.push(node)
      }
      applyFilterNodeConfig(nodes, filter, context.currentTime)
    }
    return compiled
  } catch (error) {
    for (const node of compiled) {
      try {
        node.disconnect()
      } catch {
        // A partially compiled graph has no consumers and is safe to release.
      }
    }
    throw error
  }
}

export function applyFilterNodeConfig(
  nodes: readonly AudioNode[],
  filter: FilterNodeConfig,
  time: number,
): void {
  if (filter.type === 'equalizer') {
    const preset = getEqBandPreset(filter.eqBandCount)
    if (nodes.length !== preset.frequenciesHz.length) {
      throw new Error('Equalizer runtime node count does not match its band count')
    }
    nodes.forEach((node, index) => {
      const biquad = node as BiquadFilterNode
      biquad.type = 'peaking'
      biquad.frequency.setValueAtTime(preset.frequenciesHz[index] ?? 1_000, time)
      biquad.Q.setValueAtTime(preset.q, time)
      biquad.gain.setValueAtTime(filter.eqGainsDb[index] ?? 0, time)
    })
    return
  }
  const node = nodes[0]
  if (!node || nodes.length !== 1) {
    throw new Error('Filter runtime node count must be one')
  }
  if (filter.type === 'resampler') {
    const parameter = (node as AudioWorkletNode).parameters?.get('targetSampleRateHz')
    parameter?.setValueAtTime(filter.targetSampleRateHz, time)
    return
  }
  const biquad = node as BiquadFilterNode
  biquad.type = filter.type
  biquad.frequency.setValueAtTime(filter.frequencyHz, time)
  biquad.Q.setValueAtTime(filter.q, time)
  biquad.gain.setValueAtTime(filter.gainDb, time)
}

export function compiledFilterNodeCount(filter: FilterNodeConfig): number {
  return filter.type === 'equalizer'
    ? getEqBandPreset(filter.eqBandCount).frequenciesHz.length
    : 1
}
