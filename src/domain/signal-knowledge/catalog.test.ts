import { describe, expect, it } from 'vitest'

import {
  SIGNAL_KNOWLEDGE_SECTIONS,
  SIGNAL_KNOWLEDGE_TOPICS,
} from './catalog'

describe('signal knowledge catalog', () => {
  it('keeps a stable complete learning sequence', () => {
    expect(SIGNAL_KNOWLEDGE_SECTIONS.map((section) => section.id)).toEqual([
      'complex-foundations',
      'discrete-fourier',
      'time-frequency',
    ])
    expect(SIGNAL_KNOWLEDGE_TOPICS.map((topic) => topic.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    expect(new Set(SIGNAL_KNOWLEDGE_TOPICS.map((topic) => topic.id)).size).toBe(9)
  })

  it('states the DFT and FFT relationship without defining two transforms', () => {
    const fft = SIGNAL_KNOWLEDGE_TOPICS.find((topic) => topic.id === 'fft')

    expect(fft?.title).toContain('FFT 是 DFT')
    expect(fft?.insight).toContain('相同结果')
  })
})
