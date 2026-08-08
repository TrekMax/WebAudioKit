import { describe, expect, it } from 'vitest'

import { validateFilterChain } from './filterGraph'
import {
  FILTER_PRESETS,
  createFilterPresetNodes,
  getFilterPresetDefinition,
} from './filterPresets'

describe('filter presets', () => {
  it('keeps preset ids unique', () => {
    const ids = FILTER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('expands every preset into a valid editable filter chain', () => {
    for (const preset of FILTER_PRESETS) {
      let sequence = 0
      const nodes = createFilterPresetNodes(preset.id, () => `${preset.id}-${sequence++}`)

      expect(nodes).toHaveLength(preset.nodes.length)
      expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length)
      expect(validateFilterChain(nodes)).toBe(nodes)
    }
  })

  it('uses the intended cleanup and telephone filter shapes', () => {
    const cleanup = createFilterPresetNodes('voice-cleanup', () => crypto.randomUUID())
    expect(cleanup).toMatchObject([
      { type: 'highpass', frequencyHz: 80 },
      { type: 'peaking', frequencyHz: 300, gainDb: -3 },
      { type: 'peaking', frequencyHz: 3_000, gainDb: 3 },
    ])

    const telephone = createFilterPresetNodes('telephone', () => crypto.randomUUID())
    expect(telephone).toMatchObject([
      { type: 'highpass', frequencyHz: 300 },
      { type: 'lowpass', frequencyHz: 3_400 },
    ])
  })

  it('exposes narrow 50 Hz hum suppression', () => {
    const hum = getFilterPresetDefinition('hum-50')
    expect(hum.nodes).toMatchObject([
      { type: 'notch', parameters: { frequencyHz: 50, q: 12 } },
    ])
  })
})
