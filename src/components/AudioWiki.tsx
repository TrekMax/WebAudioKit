import { BookOpen, Info, Layers3, Waves } from 'lucide-react'

import { FILTER_DEFINITIONS } from '../audio/filterGraph'
import { AUDIO_WIKI_SECTIONS } from './audioWiki'
import { FilterNodeGuideContent } from './FilterNodeGuidePopover'

export function AudioWiki() {
  const nodeCount = AUDIO_WIKI_SECTIONS.reduce(
    (total, section) => total + section.types.length,
    0,
  )

  return (
    <main className="audio-wiki-page" aria-labelledby="audio-wiki-title">
      <header className="audio-wiki-hero panel-surface">
        <div className="audio-wiki-hero-copy">
          <span className="eyebrow">AUDIO KNOWLEDGE BASE</span>
          <h1 id="audio-wiki-title"><BookOpen size={21} /> 音频 WIKI</h1>
          <p>从频率、幅度、相位与采样方式理解每一种处理节点，并用前后对比图建立直观听觉预期。</p>
        </div>
        <div className="audio-wiki-stats" aria-label="知识库内容概览">
          <span><strong>{nodeCount}</strong><small>处理节点</small></span>
          <span><strong>8</strong><small>基础滤波器</small></span>
          <span><strong>2</strong><small>采样算法</small></span>
        </div>
      </header>

      <div className="audio-wiki-scroll">
        <div className="audio-wiki-layout">
          <aside className="audio-wiki-index panel-surface">
            <div className="audio-wiki-index-heading">
              <Layers3 size={15} />
              <span><strong>知识目录</strong><small>KNOWLEDGE INDEX</small></span>
            </div>
            <nav aria-label="音频 WIKI 分类">
              {AUDIO_WIKI_SECTIONS.map((section, index) => (
                <a key={section.id} href={`#audio-wiki-${section.id}`}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{section.title}</strong>
                  <small>{section.types.length} 项</small>
                </a>
              ))}
            </nav>
            <p className="audio-wiki-index-note"><Info size={14} /> 所有图例都是确定性的教学示意，不读取当前音频，也不会触发 FFT 或改变监听链。</p>
          </aside>

          <div className="audio-wiki-sections">
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

            <p className="audio-wiki-disclaimer"><Info size={15} /> 图中曲线与波形用于解释典型效果，实际结果仍取决于源音频、采样率、节点参数和处理顺序。</p>
          </div>
        </div>
      </div>
    </main>
  )
}
