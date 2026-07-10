export type ChannelLayoutPreset =
  | 'discrete'
  | 'mono'
  | 'stereo'
  | 'quad'
  | '5.1'
  | '7.1'

export interface ChannelLayoutDescriptor {
  readonly sourceIndex: number
  readonly outputIndex: number
  readonly shortLabel: string
  readonly label: string
}

export interface ChannelLayoutOption {
  readonly value: ChannelLayoutPreset
  readonly label: string
}

const PRESET_LABELS: Readonly<Record<ChannelLayoutPreset, string>> = {
  discrete: '离散声道',
  mono: 'Mono',
  stereo: 'Stereo',
  quad: 'Quad 4.0',
  '5.1': 'Surround 5.1',
  '7.1': 'Surround 7.1',
}

const SEMANTIC_CHANNELS: Readonly<Record<Exclude<ChannelLayoutPreset, 'discrete'>, readonly (readonly [string, string])[]>> = {
  mono: [['M', '单声道']],
  stereo: [['L', '左声道'], ['R', '右声道']],
  quad: [
    ['FL', '前置左'],
    ['FR', '前置右'],
    ['BL', '后置左'],
    ['BR', '后置右'],
  ],
  '5.1': [
    ['FL', '前置左'],
    ['FR', '前置右'],
    ['FC', '前置中'],
    ['LFE', '低频效果'],
    ['BL', '后置左'],
    ['BR', '后置右'],
  ],
  // Web Audio standardizes speaker interpretation through 5.1. The 7.1
  // preset is an explicit, identity-ordered extension for capable devices.
  '7.1': [
    ['FL', '前置左'],
    ['FR', '前置右'],
    ['FC', '前置中'],
    ['LFE', '低频效果'],
    ['BL', '后置左'],
    ['BR', '后置右'],
    ['SL', '侧置左'],
    ['SR', '侧置右'],
  ],
}

export function channelCountForLayout(layout: ChannelLayoutPreset): number | null {
  if (layout === 'discrete') return null
  return SEMANTIC_CHANNELS[layout].length
}

export function isChannelLayoutCompatible(
  layout: ChannelLayoutPreset,
  channelCount: number,
): boolean {
  return layout === 'discrete' || channelCountForLayout(layout) === channelCount
}

export function defaultChannelLayout(channelCount: number): ChannelLayoutPreset {
  switch (channelCount) {
    case 1: return 'mono'
    case 2: return 'stereo'
    case 4: return 'quad'
    case 6: return '5.1'
    case 8: return '7.1'
    default: return 'discrete'
  }
}

export function normalizeChannelLayout(
  layout: ChannelLayoutPreset | undefined,
  channelCount: number,
): ChannelLayoutPreset {
  return layout && isChannelLayoutCompatible(layout, channelCount)
    ? layout
    : defaultChannelLayout(channelCount)
}

export function channelLayoutOptions(channelCount: number): ChannelLayoutOption[] {
  const semantic = defaultChannelLayout(channelCount)
  const options: ChannelLayoutPreset[] = semantic === 'discrete'
    ? ['discrete']
    : [semantic, 'discrete']
  return options.map((value) => ({ value, label: PRESET_LABELS[value] }))
}

export function describeChannelLayout(
  layout: ChannelLayoutPreset,
  channelCount: number,
): ChannelLayoutDescriptor[] {
  const normalized = normalizeChannelLayout(layout, channelCount)
  if (normalized === 'discrete') {
    return Array.from({ length: Math.max(0, channelCount) }, (_, sourceIndex) => ({
      sourceIndex,
      outputIndex: sourceIndex,
      shortLabel: `CH ${sourceIndex + 1}`,
      label: `声道 ${sourceIndex + 1}`,
    }))
  }

  return SEMANTIC_CHANNELS[normalized].map(([shortLabel, label], sourceIndex) => ({
    sourceIndex,
    outputIndex: sourceIndex,
    shortLabel,
    label,
  }))
}
