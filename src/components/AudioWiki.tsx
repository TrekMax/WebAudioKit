import { BookOpen, Info, Layers3, Waves } from 'lucide-react'

import { FILTER_DEFINITIONS } from '../audio/filterGraph'
import { AudioConceptCard } from './AudioConceptCard'
import {
  AUDIO_KNOWLEDGE_CONCEPTS,
  AUDIO_WIKI_SECTIONS,
} from './audioWiki'
import { FilterNodeGuideContent } from './FilterNodeGuidePopover'

export function AudioWiki() {
  const nodeCount = AUDIO_WIKI_SECTIONS.reduce(
    (total, section) => total + section.types.length,
    0,
  )
  const topicCount = nodeCount + AUDIO_KNOWLEDGE_CONCEPTS.length

  return (
    <main className="audio-wiki-page" aria-labelledby="audio-wiki-title">
      <header className="audio-wiki-hero panel-surface">
        <div className="audio-wiki-hero-copy">
          <span className="eyebrow">AUDIO KNOWLEDGE GRAPH</span>
          <h1 id="audio-wiki-title"><BookOpen size={21} /> 音频知识图谱</h1>
          <p>从基础原理出发，连接频率、幅度、相位、采样与处理节点，用可视图例建立完整的音频知识脉络。</p>
        </div>
        <div className="audio-wiki-stats" aria-label="知识图谱内容概览">
          <span><strong>{AUDIO_KNOWLEDGE_CONCEPTS.length}</strong><small>核心原理</small></span>
          <span><strong>{nodeCount}</strong><small>处理节点</small></span>
          <span><strong>{topicCount}</strong><small>图解主题</small></span>
        </div>
      </header>

      <div className="audio-wiki-scroll">
        <div className="audio-wiki-layout">
          <aside className="audio-wiki-index panel-surface">
            <div className="audio-wiki-index-heading">
              <Layers3 size={15} />
              <span><strong>知识目录</strong><small>KNOWLEDGE INDEX</small></span>
            </div>
            <nav aria-label="音频知识图谱分类">
              <a href="#audio-wiki-core-principles">
                <span>01</span>
                <strong>核心音频原理</strong>
                <small>{AUDIO_KNOWLEDGE_CONCEPTS.length} 项</small>
              </a>
              {AUDIO_WIKI_SECTIONS.map((section, index) => (
                <a key={section.id} href={`#audio-wiki-${section.id}`}>
                  <span>{String(index + 2).padStart(2, '0')}</span>
                  <strong>{section.title}</strong>
                  <small>{section.types.length} 项</small>
                </a>
              ))}
            </nav>
            <p className="audio-wiki-index-note"><Info size={14} /> 所有图例都是确定性的教学示意，不读取当前音频，也不会触发 FFT 或改变监听链。</p>
          </aside>

          <div className="audio-wiki-sections">
            <section
              id="audio-wiki-core-principles"
              className="audio-wiki-section"
              aria-labelledby="audio-wiki-core-principles-title"
            >
              <header className="audio-wiki-section-heading">
                <div>
                  <span className="eyebrow">CORE AUDIO PRINCIPLES</span>
                  <h2 id="audio-wiki-core-principles-title"><Layers3 size={17} /> 核心音频原理</h2>
                  <p>先理解采样、数字电平、滤波、包络与时频分析，再把概念映射到具体处理节点。</p>
                </div>
                <span>{AUDIO_KNOWLEDGE_CONCEPTS.length} TOPICS</span>
              </header>
              <div className="audio-concept-grid">
                {AUDIO_KNOWLEDGE_CONCEPTS.map((concept) => <AudioConceptCard concept={concept} key={concept.id} />)}
              </div>
            </section>

            {AUDIO_WIKI_SECTIONS.map((section) => (
              <section
                id={`audio-wiki-${section.id}`}
                className="audio-wiki-section"
                key={section.id}
                aria-labelledby={`audio-wiki-${section.id}-title`}
              >
                <header className="audio-wiki-section-heading">
                  <div>
                    <span className="eyebrow">{section.eyebrow}</span>
                    <h2 id={`audio-wiki-${section.id}-title`}><Waves size={17} /> {section.title}</h2>
                    <p>{section.description}</p>
                  </div>
                  <span>{section.types.length} TOPICS</span>
                </header>

                <div className="audio-wiki-grid">
                  {section.types.map((type) => (
                    <article
                      className="audio-wiki-card panel-surface"
                      key={type}
                      aria-label={`${FILTER_DEFINITIONS[type].label}知识卡片`}
                    >
                      <FilterNodeGuideContent type={type} badgeLabel="知识卡片" />
                    </article>
                  ))}
                </div>
              </section>
            ))}

            <p className="audio-wiki-disclaimer"><Info size={15} /> 图中结构、曲线与波形用于解释典型概念和效果；实际结果仍取决于源音频、采样率、节点参数和处理顺序。</p>
          </div>
        </div>
      </div>
    </main>
  )
}
