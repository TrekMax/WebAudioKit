import {
  FILTER_DEFINITIONS,
  type FilterKind,
} from '../audio/filterGraph'

export const FILTER_GUIDE_CHART = {
  width: 320,
  height: 142,
  left: 34,
  right: 10,
  top: 9,
  bottom: 24,
  minimumDb: -80,
  maximumDb: -10,
  minimumFrequencyHz: 20,
  maximumFrequencyHz: 20_000,
} as const

export const FILTER_GUIDE_WAVEFORM_CHART = {
  width: 320,
  height: 142,
  left: 34,
  right: 10,
  top: 9,
  bottom: 24,
  minimumValue: -1,
  maximumValue: 1,
} as const

export interface FilterNodeGuideCopy {
  readonly visualKind: 'spectrum' | 'waveform'
  readonly introduction: string
  readonly parameterSummary: string
  readonly visualSummary: string
}

export interface FilterGuideSpectrumPoint {
  readonly frequencyHz: number
  readonly beforeDb: number
  readonly afterDb: number
}

export interface FilterGuideWaveformPoint {
  readonly unit: number
  readonly before: number
  readonly after: number
}

export const FILTER_NODE_GUIDES: Readonly<Record<FilterKind, FilterNodeGuideCopy>> = {
  lowpass: {
    visualKind: 'spectrum',
    introduction: '让截止频率以下的主体通过，并逐渐压低更高频率。适合削弱嘶声、毛刺或过亮的高频。',
    parameterSummary: '截止频率决定转折位置，Q 控制转折附近的共振强度。',
    visualSummary: '示例在约 5 kHz 后逐渐衰减，高频谐波明显降低。',
  },
  highpass: {
    visualKind: 'spectrum',
    introduction: '衰减截止频率以下的低频，同时保留更高频率。常用于清理低频隆隆声、直流偏移或近讲效应。',
    parameterSummary: '截止频率决定低频清理范围，Q 控制转折处的峰值。',
    visualSummary: '示例压低约 120 Hz 以下的能量，中高频基本保持。',
  },
  bandpass: {
    visualKind: 'spectrum',
    introduction: '只突出中心频率附近的一段频带，并同时衰减更低与更高频率。适合频段侦听和特殊音色。',
    parameterSummary: '中心频率确定通带位置，Q 越高，保留的频带越窄。',
    visualSummary: '示例保留约 1 kHz 周围的频带，两侧能量逐步下降。',
  },
  notch: {
    visualKind: 'spectrum',
    introduction: '针对很窄的目标频率形成深度衰减，对相邻内容影响较小。适合抑制工频嗡声或固定啸叫。',
    parameterSummary: '中心频率瞄准干扰，Q 越高，陷波范围越窄。',
    visualSummary: '示例只在目标频率附近形成窄而深的缺口。',
  },
  peaking: {
    visualKind: 'spectrum',
    introduction: '围绕中心频率提升或削减一段频带，用于强调存在感、减少箱体感或修饰特定音色。',
    parameterSummary: '增益决定提升或削减量，频率与 Q 决定位置和宽度。',
    visualSummary: '示例在约 3 kHz 附近形成宽峰，其余频段变化较小。',
  },
  lowshelf: {
    visualKind: 'spectrum',
    introduction: '从设定频率向下整体提升或削减低频，形成平缓的架式响应。适合调整厚度、温暖度与低频重量。',
    parameterSummary: '频率确定架式转折位置，增益决定低频整体变化量。',
    visualSummary: '示例整体抬高低频，并在转折后平滑回到原频谱。',
  },
  highshelf: {
    visualKind: 'spectrum',
    introduction: '从设定频率向上整体提升或削减高频，形成平缓的架式响应。适合调整空气感、明亮度与高频细节。',
    parameterSummary: '频率确定架式转折位置，增益决定高频整体变化量。',
    visualSummary: '示例在约 6 kHz 后逐步抬高高频能量。',
  },
  allpass: {
    visualKind: 'waveform',
    introduction: '保持各频率的幅度基本不变，只改变不同频率的相位关系。适合相位校正或构建相位类效果。',
    parameterSummary: '频率与 Q 决定相位旋转最集中的区域。',
    visualSummary: '示例波形的峰值范围保持相近，但不同频率分量产生相位偏移。',
  },
  equalizer: {
    visualKind: 'spectrum',
    introduction: '用固定中心频段共同塑造整体音色，可在 7、10 与 15 段精度间切换，并组合低频、中频和高频的提升或削减。',
    parameterSummary: '默认使用 10 段；各模式覆盖约 25 Hz 至 16 kHz，每段可调 ±24 dB。',
    visualSummary: '示例组合多个宽峰与凹陷，展示多段曲线对整体频谱的塑形。',
  },
  resampler: {
    visualKind: 'waveform',
    introduction: '在固定采样率的监听链中模拟较低目标采样率，再以保持、线性、三次或带限方式重建。目标采样率不低于输出上下文时透明直通，不会生成新的 PCM 帧或高频信息。',
    parameterSummary: '复古保持成本最低且阶梯感明显；线性平滑减少跳变；三次平滑用四点 Catmull–Rom 改善连续性；带限重建用 128 相位 16 抽头窗化 sinc 提供最平直的通带，但实时成本与因果延迟最高。四种模式均先经过一阶抗混叠。',
    visualSummary: '示例按较低目标采样率重建波形，高频细节被抗混叠处理抑制。',
  },
}

const FILTER_KINDS = Object.keys(FILTER_DEFINITIONS) as FilterKind[]

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function gaussian(unit: number, center: number, width: number): number {
  const distance = (unit - center) / width
  return Math.exp(-0.5 * distance * distance)
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0
  const unit = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return unit * unit * (3 - 2 * unit)
}

function frequencyAtUnit(unit: number): number {
  const { minimumFrequencyHz, maximumFrequencyHz } = FILTER_GUIDE_CHART
  return minimumFrequencyHz * (
    maximumFrequencyHz / minimumFrequencyHz
  ) ** clamp(unit, 0, 1)
}

function frequencyToUnit(frequencyHz: number): number {
  const { minimumFrequencyHz, maximumFrequencyHz } = FILTER_GUIDE_CHART
  const safeFrequency = clamp(frequencyHz, minimumFrequencyHz, maximumFrequencyHz)
  return (
    Math.log10(safeFrequency) - Math.log10(minimumFrequencyHz)
  ) / (
    Math.log10(maximumFrequencyHz) - Math.log10(minimumFrequencyHz)
  )
}

function exampleSourceSpectrumDb(unit: number): number {
  return -35
    - unit * 11
    + gaussian(unit, 0.2, 0.055) * 10
    + gaussian(unit, 0.43, 0.075) * 7
    + gaussian(unit, 0.67, 0.065) * 9
    + gaussian(unit, 0.86, 0.05) * 5
    + Math.sin(unit * Math.PI * 12) * 1.4
}

function exampleResponseDb(type: FilterKind, unit: number): number {
  switch (type) {
    case 'lowpass': {
      const cutoff = frequencyToUnit(5_000)
      return -44 * smoothStep(cutoff - 0.03, 1, unit)
    }
    case 'highpass': {
      const cutoff = frequencyToUnit(120)
      return -44 * (1 - smoothStep(0, cutoff + 0.05, unit))
    }
    case 'bandpass': {
      const center = frequencyToUnit(1_000)
      return -38 * Math.min(1, (Math.abs(unit - center) / 0.45) ** 1.35)
    }
    case 'notch':
      return -38 * gaussian(unit, frequencyToUnit(50), 0.032)
    case 'peaking':
      return 10 * gaussian(unit, frequencyToUnit(3_000), 0.095)
    case 'lowshelf':
      return 9 * (1 - smoothStep(
        frequencyToUnit(90),
        frequencyToUnit(420),
        unit,
      ))
    case 'highshelf':
      return 9 * smoothStep(
        frequencyToUnit(2_800),
        frequencyToUnit(9_000),
        unit,
      )
    case 'allpass':
      return 0
    case 'equalizer':
      return 8 * gaussian(unit, frequencyToUnit(63), 0.065)
        - 6 * gaussian(unit, frequencyToUnit(500), 0.08)
        + 9 * gaussian(unit, frequencyToUnit(2_000), 0.09)
        - 7 * gaussian(unit, frequencyToUnit(16_000), 0.07)
    case 'resampler':
      return -52 * smoothStep(
        frequencyToUnit(7_500),
        frequencyToUnit(12_000),
        unit,
      )
  }
}

export function buildFilterGuideSpectrum(
  type: FilterKind,
  pointCount = 72,
): readonly FilterGuideSpectrumPoint[] {
  if (!FILTER_KINDS.includes(type)) {
    throw new RangeError(`Unsupported filter guide type: ${String(type)}`)
  }
  if (!Number.isSafeInteger(pointCount) || pointCount < 8 || pointCount > 256) {
    throw new RangeError('Filter guide point count must be within [8, 256]')
  }

  return Array.from({ length: pointCount }, (_, index) => {
    const unit = index / (pointCount - 1)
    const beforeDb = clamp(
      exampleSourceSpectrumDb(unit),
      FILTER_GUIDE_CHART.minimumDb,
      FILTER_GUIDE_CHART.maximumDb,
    )
    return {
      frequencyHz: frequencyAtUnit(unit),
      beforeDb,
      afterDb: clamp(
        beforeDb + exampleResponseDb(type, unit),
        FILTER_GUIDE_CHART.minimumDb,
        FILTER_GUIDE_CHART.maximumDb,
      ),
    }
  })
}

export function filterGuideFrequencyToX(frequencyHz: number): number {
  const plotWidth = FILTER_GUIDE_CHART.width
    - FILTER_GUIDE_CHART.left
    - FILTER_GUIDE_CHART.right
  return FILTER_GUIDE_CHART.left + frequencyToUnit(frequencyHz) * plotWidth
}

export function filterGuideDbToY(valueDb: number): number {
  const plotHeight = FILTER_GUIDE_CHART.height
    - FILTER_GUIDE_CHART.top
    - FILTER_GUIDE_CHART.bottom
  const unit = (
    clamp(valueDb, FILTER_GUIDE_CHART.minimumDb, FILTER_GUIDE_CHART.maximumDb)
    - FILTER_GUIDE_CHART.minimumDb
  ) / (FILTER_GUIDE_CHART.maximumDb - FILTER_GUIDE_CHART.minimumDb)
  return FILTER_GUIDE_CHART.top + (1 - unit) * plotHeight
}

export function buildFilterGuideSpectrumPath(
  points: readonly FilterGuideSpectrumPoint[],
  series: 'beforeDb' | 'afterDb',
): string {
  return points.map((point, index) => {
    const x = filterGuideFrequencyToX(point.frequencyHz)
    const y = filterGuideDbToY(point[series])
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
}

export function buildFilterGuideWaveform(
  type: Extract<FilterKind, 'allpass' | 'resampler'>,
  pointCount = 96,
): readonly FilterGuideWaveformPoint[] {
  if (type !== 'allpass' && type !== 'resampler') {
    throw new RangeError(`Filter guide has no waveform example: ${String(type)}`)
  }
  if (!Number.isSafeInteger(pointCount) || pointCount < 16 || pointCount > 256) {
    throw new RangeError('Filter guide waveform point count must be within [16, 256]')
  }

  return Array.from({ length: pointCount }, (_, index) => {
    const unit = index / (pointCount - 1)
    const before = 0.58 * Math.sin(unit * Math.PI * 6)
      + 0.24 * Math.sin(unit * Math.PI * 26)
    if (type === 'allpass') {
      return {
        unit,
        before,
        after: 0.58 * Math.sin(unit * Math.PI * 6 - 0.72)
          + 0.24 * Math.sin(unit * Math.PI * 26 - 1.64),
      }
    }

    const heldUnit = Math.floor(unit * 24) / 24
    return {
      unit,
      before,
      after: 0.62 * Math.sin(heldUnit * Math.PI * 6),
    }
  })
}

export function filterGuideWaveformUnitToX(unit: number): number {
  const plotWidth = FILTER_GUIDE_WAVEFORM_CHART.width
    - FILTER_GUIDE_WAVEFORM_CHART.left
    - FILTER_GUIDE_WAVEFORM_CHART.right
  return FILTER_GUIDE_WAVEFORM_CHART.left + clamp(unit, 0, 1) * plotWidth
}

export function filterGuideWaveformValueToY(value: number): number {
  const plotHeight = FILTER_GUIDE_WAVEFORM_CHART.height
    - FILTER_GUIDE_WAVEFORM_CHART.top
    - FILTER_GUIDE_WAVEFORM_CHART.bottom
  const unit = (
    clamp(
      value,
      FILTER_GUIDE_WAVEFORM_CHART.minimumValue,
      FILTER_GUIDE_WAVEFORM_CHART.maximumValue,
    ) - FILTER_GUIDE_WAVEFORM_CHART.minimumValue
  ) / (
    FILTER_GUIDE_WAVEFORM_CHART.maximumValue
    - FILTER_GUIDE_WAVEFORM_CHART.minimumValue
  )
  return FILTER_GUIDE_WAVEFORM_CHART.top + (1 - unit) * plotHeight
}

export function buildFilterGuideWaveformPath(
  points: readonly FilterGuideWaveformPoint[],
  series: 'before' | 'after',
  stepped = false,
): string {
  let path = ''
  for (const [index, point] of points.entries()) {
    const x = filterGuideWaveformUnitToX(point.unit)
    const y = filterGuideWaveformValueToY(point[series])
    if (index === 0) {
      path = `M ${x.toFixed(2)} ${y.toFixed(2)}`
      continue
    }
    if (stepped) {
      const previous = points[index - 1]
      if (previous) {
        path += ` L ${x.toFixed(2)} ${filterGuideWaveformValueToY(previous[series]).toFixed(2)}`
      }
    }
    path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`
  }
  return path
}
