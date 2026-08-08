import { describe, expect, it } from 'vitest'

import { FILTER_DEFINITIONS, type FilterKind } from '../audio/filterGraph'
import {
  AUDIO_KNOWLEDGE_CONCEPTS,
  AUDIO_WIKI_SECTIONS,
} from './audioWiki'

describe('audio knowledge graph catalog', () => {
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

  it('covers the required core concepts with complete teaching content', () => {
    const conceptIds = AUDIO_KNOWLEDGE_CONCEPTS.map((concept) => concept.id)

    expect(conceptIds).toEqual(expect.arrayContaining([
      'iir-filter',
      'nyquist-theorem',
      'amplitude-envelope',
      'q-bandwidth',
      'dbfs-level',
      'fft-stft',
    ]))
    expect(new Set(conceptIds).size).toBe(conceptIds.length)
    expect(new Set(AUDIO_KNOWLEDGE_CONCEPTS.map((concept) => concept.visualKind)).size).toBe(
      AUDIO_KNOWLEDGE_CONCEPTS.length,
    )

    for (const concept of AUDIO_KNOWLEDGE_CONCEPTS) {
      expect(concept.title.length).toBeGreaterThanOrEqual(4)
      expect(concept.introduction.length).toBeGreaterThan(30)
      expect(concept.keyPoint.length).toBeGreaterThan(20)
      expect(concept.visualSummary.length).toBeGreaterThan(15)
      expect(concept.relatedTopics.length).toBeGreaterThanOrEqual(3)
    }
  })
})
