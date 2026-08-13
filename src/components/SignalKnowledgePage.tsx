import {
  Atom,
  Binary,
  Boxes,
  Info,
  Layers3,
  Sigma,
  Waves,
} from 'lucide-react'

import {
  SIGNAL_KNOWLEDGE_SECTIONS,
  SIGNAL_KNOWLEDGE_TOPICS,
} from '../domain/signal-knowledge/catalog'
import { SignalKnowledgeDiagram } from './SignalKnowledgeDiagram'

const SECTION_ICONS = [Atom, Binary, Layers3] as const

export function SignalKnowledgePage() {
  return (
    <main className="signal-knowledge-page" aria-labelledby="signal-knowledge-title">
      <header className="signal-knowledge-hero panel-surface">
        <div className="signal-knowledge-hero-copy">
          <span className="eyebrow">SIGNAL PROCESSING VISUAL GUIDE</span>
          <h1 id="signal-knowledge-title"><Atom size={22} /> 信号处理知识图解</h1>
          <p>从复平面上的一次旋转出发，沿着采样、DFT、FFT 与滑动窗，逐步看懂声音如何从时域变成可分析的时频结构。</p>
        </div>
        <div className="signal-knowledge-stats" aria-label="信号处理图解内容概览">
          <span><strong>{SIGNAL_KNOWLEDGE_TOPICS.length}</strong><small>连续图解</small></span>
          <span><strong>3</strong><small>数学阶段</small></span>
          <span><strong>DFT</strong><small>统一模型</small></span>
        </div>
      </header>

      <div className="signal-knowledge-scroll">
        <div className="signal-knowledge-layout">
          <aside className="signal-knowledge-index panel-surface">
            <div className="signal-knowledge-index-heading">
              <Boxes size={16} />
              <span><strong>学习路径</strong><small>FROM z TO STFT</small></span>
            </div>
            <nav aria-label="信号处理知识图解章节">
              {SIGNAL_KNOWLEDGE_SECTIONS.map((section, index) => (
                <a href={`#signal-knowledge-${section.id}`} key={section.id}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{section.title}</strong>
                  <small>{section.topics.length} 步</small>
                </a>
              ))}
            </nav>
            <p className="signal-knowledge-index-note"><Info size={14} /> 所有曲线由确定性的微型数学模型生成，不读取音频、不启动 FFT Worker，也不改变当前工程。</p>
          </aside>

          <div className="signal-knowledge-sections">
            <section className="signal-knowledge-overview panel-surface" aria-label="阅读提示">
              <Sigma size={18} />
              <div>
                <strong>先看几何，再看公式</strong>
                <p>每一步都用同一组数据连接图形、公式和工程含义。FFT 只是更快计算 DFT，幅度与相位的定义不会改变。</p>
              </div>
              <span><Waves size={14} /> 无需导入音频</span>
            </section>

            {SIGNAL_KNOWLEDGE_SECTIONS.map((section, sectionIndex) => {
              const SectionIcon = SECTION_ICONS[sectionIndex] ?? Layers3
              return (
                <section
                  className="signal-knowledge-section"
                  id={`signal-knowledge-${section.id}`}
                  key={section.id}
                  aria-labelledby={`signal-knowledge-${section.id}-title`}
                >
                  <header className="signal-knowledge-section-heading">
                    <div>
                      <span className="eyebrow">STAGE {String(sectionIndex + 1).padStart(2, '0')}</span>
                      <h2 id={`signal-knowledge-${section.id}-title`}><SectionIcon size={18} /> {section.title}</h2>
                      <p>{section.description}</p>
                    </div>
                    <span>{section.topics.length} STEPS</span>
                  </header>

                  <div className="signal-knowledge-topic-list">
                    {section.topics.map((topic) => (
                      <article className="signal-knowledge-topic panel-surface" id={`signal-topic-${topic.id}`} key={topic.id}>
                        <div className="signal-knowledge-topic-copy">
                          <div className="signal-knowledge-topic-step">
                            <span>{String(topic.order).padStart(2, '0')}</span>
                            <small>{topic.eyebrow}</small>
                          </div>
                          <h3>{topic.title}</h3>
                          <p>{topic.summary}</p>
                          <code>{topic.formula}</code>
                        </div>
                        <SignalKnowledgeDiagram topic={topic} />
                      </article>
                    ))}
                  </div>
                </section>
              )
            })}

            <p className="signal-knowledge-disclaimer"><Info size={15} /> 图解使用受限规模的教学信号，帮助理解数学结构；工作台中的真实音频分析仍由离线 Worker 与统一 dBFS 标定完成。</p>
          </div>
        </div>
      </div>
    </main>
  )
}
