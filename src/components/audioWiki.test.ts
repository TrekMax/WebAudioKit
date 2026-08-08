import { describe, expect, it } from 'vitest'

import { FILTER_DEFINITIONS, type FilterKind } from '../audio/filterGraph'
import { AUDIO_WIKI_SECTIONS } from './audioWiki'

describe('audio wiki catalog', () => {
  it('includes every supported node type exactly once', () => {
    const supportedTypes = Object.keys(FILTER_DEFINITIONS).sort() as FilterKind[]
    const wikiTypes = AUDIO_WIKI_SECTIONS.flatMap((section) => section.types).sort()

    expect(wikiTypes).toEqual(supportedTypes)
    expect(new Set(wikiTypes).size).toBe(wikiTypes.length)
  })

  it('provides unique anchors and readable section copy', () => {
    const anchors = AUDIO_WIKI_SECTIONS.map((section) => section.id)

    expect(new Set(anchors).size).toBe(anchors.length)
    for (const section of AUDIO_WIKI_SECTIONS) {
      expect(section.id).toMatch(/^[a-z][a-z-]+$/)
      expect(section.title.length).toBeGreaterThan(4)
      expect(section.description.length).toBeGreaterThan(15)
      expect(section.types.length).toBeGreaterThan(0)
    }
  })
})
