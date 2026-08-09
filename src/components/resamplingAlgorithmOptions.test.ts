import { describe, expect, it } from 'vitest'

import { RESAMPLING_ALGORITHMS } from '../audio/filterGraph'
import {
  RESAMPLING_ALGORITHM_OPTIONS,
  resolveResamplingMode,
  resamplingAlgorithmLabel,
} from './resamplingAlgorithmOptions'

describe('resampling algorithm options', () => {
  it('documents every supported algorithm exactly once', () => {
    const optionValues = RESAMPLING_ALGORITHM_OPTIONS.map(({ value }) => value)

    expect(optionValues).toEqual(RESAMPLING_ALGORITHMS)
    expect(new Set(optionValues).size).toBe(optionValues.length)
    for (const option of RESAMPLING_ALGORITHM_OPTIONS) {
      expect(option.algorithm.length).toBeGreaterThan(10)
      expect(option.listeningCharacter.length).toBeGreaterThan(20)
      expect(option.recommendation.length).toBeGreaterThan(15)
      expect(resamplingAlgorithmLabel(option.value)).toBe(option.label)
    }
  })

  it('treats targets at or above the fixed output rate as transparent', () => {
    expect(resolveResamplingMode(24_000, 48_000)).toEqual({
      active: true,
      label: '下采样与重建',
    })
    expect(resolveResamplingMode(48_000, 48_000)).toEqual({
      active: false,
      label: '透明直通',
    })
    expect(resolveResamplingMode(96_000, 48_000)).toEqual({
      active: false,
      label: '透明直通',
    })
  })
})
