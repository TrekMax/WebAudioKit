import { AudioLines } from 'lucide-react'

import type {
  AudioConceptVisualKind,
  AudioKnowledgeConcept,
} from './audioWiki'

function IirDiagram() {
  return (
    <svg viewBox="0 0 360 150" role="img" aria-label="IIR 前向计算与输出反馈结构示意图">
      <defs>
        <marker id="concept-iir-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path className="audio-concept-arrow-head" d="M 0 0 L 7 3.5 L 0 7 Z" />
        </marker>
      </defs>
      <text className="audio-concept-axis-text" x="13" y="70">输入 x[n]</text>
      <line className="audio-concept-signal-line" x1="72" x2="106" y1="66" y2="66" markerEnd="url(#concept-iir-arrow)" />
      <circle className="audio-concept-node" cx="121" cy="66" r="15" />
      <text className="audio-concept-node-text" x="121" y="70">Σ</text>
      <line className="audio-concept-signal-line" x1="136" x2="163" y1="66" y2="66" markerEnd="url(#concept-iir-arrow)" />
      <rect className="audio-concept-block" x="172" y="43" width="91" height="46" rx="6" />
      <text className="audio-concept-block-title" x="217.5" y="62">BIQUAD</text>
      <text className="audio-concept-axis-text center" x="217.5" y="77">前向系数 b</text>
      <line className="audio-concept-signal-line" x1="263" x2="303" y1="66" y2="66" markerEnd="url(#concept-iir-arrow)" />
      <text className="audio-concept-axis-text" x="307" y="70">输出 y[n]</text>
      <path className="audio-concept-feedback-line" d="M 286 66 L 286 115 L 246 115" />
      <rect className="audio-concept-block feedback" x="168" y="99" width="78" height="32" rx="5" />
      <text className="audio-concept-axis-text center" x="207" y="119">延迟 z⁻¹ · 系数 a</text>
      <path className="audio-concept-feedback-line" d="M 168 115 L 121 115 L 121 82" markerEnd="url(#concept-iir-arrow)" />
      <text className="audio-concept-feedback-label" x="270" y="108">反馈</text>
    </svg>
  )
}

function NyquistDiagram() {
  return (
    <svg viewBox="0 0 360 150" role="img" aria-label="奈奎斯特频率与越界频率混叠折返示意图">
      <defs>
        <marker id="concept-nyquist-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path className="audio-concept-arrow-head warning" d="M 0 0 L 7 3.5 L 0 7 Z" />
        </marker>
      </defs>
      <rect className="audio-concept-safe-zone" x="27" y="21" width="155" height="99" rx="4" />
      <rect className="audio-concept-risk-zone" x="182" y="21" width="151" height="99" rx="4" />
      <text className="audio-concept-zone-label safe" x="39" y="38">可表示频带</text>
      <text className="audio-concept-zone-label risk" x="321" y="38">混叠区域</text>
      <line className="audio-concept-axis-line" x1="27" x2="333" y1="120" y2="120" />
      <line className="audio-concept-nyquist-line" x1="182" x2="182" y1="16" y2="126" />
      <text className="audio-concept-axis-text center" x="27" y="139">0</text>
      <text className="audio-concept-axis-text center strong" x="182" y="139">fs / 2</text>
      <text className="audio-concept-axis-text center" x="333" y="139">fs</text>
      <path className="audio-concept-spectrum-safe" d="M 42 120 C 70 120 72 60 101 60 C 130 60 132 120 160 120" />
      <path className="audio-concept-spectrum-risk" d="M 223 120 C 248 120 250 49 275 49 C 300 49 303 120 324 120" />
      <path className="audio-concept-alias-arrow" d="M 273 47 C 245 12 153 14 108 55" markerEnd="url(#concept-nyquist-arrow)" />
      <text className="audio-concept-feedback-label warning" x="186" y="18">频率折返 / Alias</text>
    </svg>
  )
}

function EnvelopeDiagram() {
  return (
    <svg viewBox="0 0 360 150" role="img" aria-label="ADSR 振幅包络四阶段示意图">
      <defs>
        <linearGradient id="concept-envelope-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1fdfb2" stopOpacity="0.28" />
          <stop offset="1" stopColor="#1fdfb2" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line className="audio-concept-axis-line" x1="25" x2="337" y1="124" y2="124" />
      <line className="audio-concept-axis-line" x1="25" x2="25" y1="18" y2="124" />
      <path className="audio-concept-envelope-area" d="M 25 124 L 84 25 L 133 61 L 259 70 L 331 124 Z" fill="url(#concept-envelope-fill)" />
      <path className="audio-concept-envelope-line" d="M 25 124 L 84 25 L 133 61 L 259 70 L 331 124" />
      {[84, 133, 259].map((x) => <line className="audio-concept-stage-line" key={x} x1={x} x2={x} y1="20" y2="128" />)}
      <text className="audio-concept-axis-text center" x="54" y="142">A 攻击</text>
      <text className="audio-concept-axis-text center" x="108" y="142">D 衰减</text>
      <text className="audio-concept-axis-text center" x="196" y="142">S 保持</text>
      <text className="audio-concept-axis-text center" x="295" y="142">R 释放</text>
      <text className="audio-concept-axis-text" x="29" y="19">振幅</text>
    </svg>
  )
}

function QBandwidthDiagram() {
  return (
    <svg viewBox="0 0 360 150" role="img" aria-label="低中高 Q 值对应不同频率带宽示意图">
      <line className="audio-concept-axis-line" x1="23" x2="337" y1="124" y2="124" />
      <line className="audio-concept-center-line" x1="180" x2="180" y1="18" y2="128" />
      <path className="audio-concept-q-line low" d="M 24 123 C 59 122 93 72 180 70 C 267 72 301 122 336 123" />
      <path className="audio-concept-q-line medium" d="M 54 124 C 113 123 128 45 180 43 C 232 45 247 123 306 124" />
      <path className="audio-concept-q-line high" d="M 112 124 C 157 122 158 23 180 20 C 202 23 203 122 248 124" />
      <text className="audio-concept-zone-label q-low" x="40" y="78">低 Q · 宽</text>
      <text className="audio-concept-zone-label q-medium" x="235" y="56">中 Q</text>
      <text className="audio-concept-zone-label safe" x="189" y="23">高 Q · 窄</text>
      <text className="audio-concept-axis-text center strong" x="180" y="142">中心频率 f0</text>
    </svg>
  )
}

function DbfsDiagram() {
  const ticks = [
    { x: 69, label: '−60' },
    { x: 157, label: '−24' },
    { x: 226, label: '−12' },
    { x: 274, label: '−6' },
    { x: 329, label: '0' },
  ] as const
  return (
    <svg viewBox="0 0 360 150" role="img" aria-label="负 dBFS 电平接近零时数字余量减少示意图">
      {ticks.map((tick) => (
        <g key={tick.label}>
          <line className="audio-concept-level-grid" x1={tick.x} x2={tick.x} y1="22" y2="124" />
          <text className="audio-concept-axis-text center" x={tick.x} y="141">{tick.label}</text>
        </g>
      ))}
      <text className="audio-concept-axis-text" x="12" y="45">环境</text>
      <text className="audio-concept-axis-text" x="12" y="79">常规</text>
      <text className="audio-concept-axis-text" x="12" y="113">峰值</text>
      <rect className="audio-concept-level-track" x="69" y="32" width="260" height="14" rx="7" />
      <rect className="audio-concept-level-fill quiet" x="69" y="32" width="72" height="14" rx="7" />
      <rect className="audio-concept-level-track" x="69" y="66" width="260" height="14" rx="7" />
      <rect className="audio-concept-level-fill nominal" x="69" y="66" width="190" height="14" rx="7" />
      <rect className="audio-concept-level-track" x="69" y="100" width="260" height="14" rx="7" />
      <rect className="audio-concept-level-fill peak" x="69" y="100" width="250" height="14" rx="7" />
      <line className="audio-concept-clipping-line" x1="329" x2="329" y1="18" y2="124" />
      <text className="audio-concept-zone-label risk" x="323" y="17">满幅 / 削波边界</text>
    </svg>
  )
}

function FftStftDiagram() {
  const heatmap = [
    [0, 1, 2, 1, 0, 1],
    [1, 2, 3, 2, 1, 0],
    [0, 1, 2, 3, 2, 1],
  ] as const
  return (
    <svg viewBox="0 0 360 150" role="img" aria-label="FFT 单帧频谱与 STFT 多帧时频矩阵示意图">
      <defs>
        <marker id="concept-analysis-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
          <path className="audio-concept-arrow-head" d="M 0 0 L 7 3.5 L 0 7 Z" />
        </marker>
      </defs>
      <text className="audio-concept-zone-label safe" x="20" y="19">时间窗</text>
      <path className="audio-concept-wave-line" d="M 20 55 C 30 20 40 88 50 55 C 60 22 70 88 80 55 C 90 24 100 86 110 55 C 120 28 130 82 140 55 C 150 34 158 72 166 55" />
      <rect className="audio-concept-window-box" x="52" y="25" width="78" height="58" rx="4" />
      <path className="audio-concept-analysis-arrow" d="M 174 55 L 205 55" />
      <text className="audio-concept-zone-label safe" x="220" y="19">FFT 频率 bin</text>
      {[26, 42, 31, 62, 47, 76, 58, 36].map((height, index) => (
        <rect className="audio-concept-fft-bar" key={index} x={218 + index * 14} y={84 - height} width="8" height={height} rx="2" />
      ))}
      <text className="audio-concept-zone-label q-medium" x="20" y="105">STFT · 窗口沿时间滑动</text>
      {heatmap.flatMap((row, rowIndex) => row.map((level, columnIndex) => (
        <rect
          className={`audio-concept-heat-cell level-${level}`}
          key={`${rowIndex}-${columnIndex}`}
          x={174 + columnIndex * 27}
          y={100 + rowIndex * 15}
          width="24"
          height="12"
          rx="2"
        />
      )))}
      <path className="audio-concept-analysis-arrow" d="M 129 119 L 160 119" />
    </svg>
  )
}

function AudioConceptDiagram({ visualKind }: { readonly visualKind: AudioConceptVisualKind }) {
  if (visualKind === 'iir-flow') return <IirDiagram />
  if (visualKind === 'nyquist') return <NyquistDiagram />
  if (visualKind === 'envelope') return <EnvelopeDiagram />
  if (visualKind === 'q-bandwidth') return <QBandwidthDiagram />
  if (visualKind === 'dbfs') return <DbfsDiagram />
  return <FftStftDiagram />
}

export function AudioConceptCard({ concept }: { readonly concept: AudioKnowledgeConcept }) {
  return (
    <article
      id={`audio-wiki-concept-${concept.id}`}
      className="audio-concept-card panel-surface"
      aria-label={`${concept.title}知识卡片`}
    >
      <header className="audio-concept-header">
        <span className="audio-concept-icon"><AudioLines size={17} /></span>
        <span><strong>{concept.title}</strong><small>{concept.englishTitle}</small></span>
        <span className="audio-concept-badge">核心原理</span>
      </header>

      <p className="audio-concept-introduction">{concept.introduction}</p>

      <figure className="audio-concept-figure">
        <div className="audio-concept-figure-heading"><strong>概念图例</strong><span>确定性教学示意</span></div>
        <AudioConceptDiagram visualKind={concept.visualKind} />
        <figcaption>{concept.visualSummary}</figcaption>
      </figure>

      <p className="audio-concept-key-point"><strong>关键结论</strong>{concept.keyPoint}</p>
      <div className="audio-concept-relations"><strong>关联</strong>{concept.relatedTopics.map((topic) => <span key={topic}>{topic}</span>)}</div>
    </article>
  )
}
