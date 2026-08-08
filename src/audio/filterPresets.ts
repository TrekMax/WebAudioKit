import {
  createFilterNodeConfig,
  type FilterKind,
  type FilterNodeConfig,
} from './filterGraph'

interface FilterPresetNodeDefinition {
  readonly type: FilterKind
  readonly parameters?: Partial<Omit<FilterNodeConfig, 'id' | 'type'>>
}

export interface FilterPresetDefinition {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly nodes: readonly FilterPresetNodeDefinition[]
}

export const FILTER_PRESETS = [
  {
    id: 'low-cut-80',
    label: '低频清理 · 80 Hz',
    description: '削弱环境震动、脚步和近讲时的低频隆隆声。',
    nodes: [
      { type: 'highpass', parameters: { frequencyHz: 80, q: Math.SQRT1_2 } },
    ],
  },
  {
    id: 'high-cut-16k',
    label: '高频柔化 · 16 kHz',
    description: '轻柔收窄极高频，降低尖锐感与高频噪声。',
    nodes: [
      { type: 'lowpass', parameters: { frequencyHz: 16_000, q: Math.SQRT1_2 } },
    ],
  },
  {
    id: 'hum-50',
    label: '50 Hz 嗡声抑制',
    description: '窄带削弱 50 Hz 市电基频，适合常见交流电嗡声。',
    nodes: [
      { type: 'notch', parameters: { frequencyHz: 50, q: 12 } },
    ],
  },
  {
    id: 'hum-60',
    label: '60 Hz 嗡声抑制',
    description: '窄带削弱 60 Hz 市电基频，适合对应地区的交流电嗡声。',
    nodes: [
      { type: 'notch', parameters: { frequencyHz: 60, q: 12 } },
    ],
  },
  {
    id: 'voice-cleanup',
    label: '人声清理',
    description: '切除低频隆隆声、削减浑浊感，并适度提升人声存在感。',
    nodes: [
      { type: 'highpass', parameters: { frequencyHz: 80, q: Math.SQRT1_2 } },
      { type: 'peaking', parameters: { frequencyHz: 300, q: 1.1, gainDb: -3 } },
      { type: 'peaking', parameters: { frequencyHz: 3_000, q: 1, gainDb: 3 } },
    ],
  },
  {
    id: 'podcast-clarity',
    label: '播客清晰',
    description: '清理低频与箱体感，增强清晰度，并轻微增加空气感。',
    nodes: [
      { type: 'highpass', parameters: { frequencyHz: 75, q: Math.SQRT1_2 } },
      { type: 'peaking', parameters: { frequencyHz: 280, q: 1.1, gainDb: -2.5 } },
      { type: 'peaking', parameters: { frequencyHz: 3_500, q: 1, gainDb: 3 } },
      { type: 'highshelf', parameters: { frequencyHz: 10_000, gainDb: 2 } },
    ],
  },
  {
    id: 'telephone',
    label: '电话音效',
    description: '仅保留约 300 Hz–3.4 kHz 的中频，模拟电话带宽。',
    nodes: [
      { type: 'highpass', parameters: { frequencyHz: 300, q: Math.SQRT1_2 } },
      { type: 'lowpass', parameters: { frequencyHz: 3_400, q: Math.SQRT1_2 } },
    ],
  },
] as const satisfies readonly FilterPresetDefinition[]

export type FilterPresetId = typeof FILTER_PRESETS[number]['id']

export function getFilterPresetDefinition(id: FilterPresetId): FilterPresetDefinition {
  const preset = FILTER_PRESETS.find((candidate) => candidate.id === id)
  if (!preset) throw new RangeError(`Unsupported filter preset: ${id}`)
  return preset
}

export function createFilterPresetNodes(
  presetId: FilterPresetId,
  createId: () => string,
): readonly FilterNodeConfig[] {
  return getFilterPresetDefinition(presetId).nodes.map(({ type, parameters }) => ({
    ...createFilterNodeConfig(type, createId()),
    ...parameters,
  }))
}
