import { describe, expect, it } from 'vitest'

import {
  channelLayoutOptions,
  defaultChannelLayout,
  describeChannelLayout,
  normalizeChannelLayout,
} from './channelLayout'

describe('channel layout semantics', () => {
  it.each([
    [1, 'mono'],
    [2, 'stereo'],
    [4, 'quad'],
    [6, '5.1'],
    [8, '7.1'],
    [3, 'discrete'],
  ] as const)('chooses %s-channel default layout %s', (count, expected) => {
    expect(defaultChannelLayout(count)).toBe(expected)
  })

  it('uses Web Audio speaker order for 5.1 and explicit order for 7.1', () => {
    expect(describeChannelLayout('5.1', 6).map((channel) => channel.shortLabel))
      .toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'])
    expect(describeChannelLayout('7.1', 8).map((channel) => channel.shortLabel))
      .toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
  })

  it('falls back from an incompatible preset and offers a discrete override', () => {
    expect(normalizeChannelLayout('5.1', 2)).toBe('stereo')
    expect(channelLayoutOptions(6)).toEqual([
      { value: '5.1', label: 'Surround 5.1' },
      { value: 'discrete', label: '离散声道' },
    ])
  })

  it('labels arbitrary layouts without changing source-to-output order', () => {
    expect(describeChannelLayout('discrete', 3)).toEqual([
      { sourceIndex: 0, outputIndex: 0, shortLabel: 'CH 1', label: '声道 1' },
      { sourceIndex: 1, outputIndex: 1, shortLabel: 'CH 2', label: '声道 2' },
      { sourceIndex: 2, outputIndex: 2, shortLabel: 'CH 3', label: '声道 3' },
    ])
  })
})
