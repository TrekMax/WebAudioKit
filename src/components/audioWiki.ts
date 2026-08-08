import type { FilterKind } from '../audio/filterGraph'

export interface AudioWikiSection {
  readonly id: string
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly types: readonly FilterKind[]
}

export const AUDIO_WIKI_SECTIONS: readonly AudioWikiSection[] = [
  {
    id: 'frequency-boundaries',
    eyebrow: 'FREQUENCY CONTROL',
    title: '频段边界与清理',
    description: '用截止频率或中心频率决定哪些声音通过、被突出或被移除。',
    types: ['lowpass', 'highpass', 'bandpass', 'notch'],
  },
  {
    id: 'tone-shaping',
    eyebrow: 'TONE SHAPING',
    title: '音色塑形与均衡',
    description: '围绕目标频段提升或削减能量，从局部修饰延伸到整条 EQ 曲线。',
    types: ['peaking', 'lowshelf', 'highshelf', 'equalizer'],
  },
  {
    id: 'phase-and-sampling',
    eyebrow: 'PHASE & SAMPLING',
    title: '相位与采样',
    description: '理解幅度之外的相位变化，以及目标采样率和重建算法对波形的影响。',
    types: ['allpass', 'resampler'],
  },
]
