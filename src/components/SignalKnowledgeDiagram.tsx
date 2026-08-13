import type { SignalKnowledgeTopic } from '../domain/signal-knowledge/catalog'
import {
  createDftTeachingModel,
  createPhasorTeachingModel,
  createStftTeachingModel,
} from '../domain/signal-knowledge/models'
import {
  createSingleSidedMagnitudeSpectrum,
  createTeachingWindow,
  generateTeachingSignal,
} from '../domain/signal-knowledge/transforms'

interface SignalKnowledgeDiagramProps {
  readonly topic: SignalKnowledgeTopic
}

const WIDTH = 440
const HEIGHT = 220
const PHASOR_DIAGRAM_MODEL = createPhasorTeachingModel(1.5, Math.PI / 6, 72)
const DFT_DIAGRAM_MODEL = createDftTeachingModel()
const MAGNITUDE_DIAGRAM_SPECTRUM = createSingleSidedMagnitudeSpectrum(
  generateTeachingSignal({
    kind: 'two-tone',
    sampleCount: 32,
    cycles: 3,
  }),
)
const WINDOW_DIAGRAM_COEFFICIENTS = createTeachingWindow('hann', 64)
const STFT_DIAGRAM_MODEL = createStftTeachingModel()

function curvePath(
  pointCount: number,
  valueAt: (progress: number) => number,
  startX: number,
  endX: number,
  centerY: number,
  amplitude: number,
): string {
  return Array.from({ length: pointCount }, (_, index) => {
    const progress = index / Math.max(1, pointCount - 1)
    const x = startX + (endX - startX) * progress
    const y = centerY - valueAt(progress) * amplitude
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
}

function Grid() {
  return (
    <g className="signal-diagram-grid" aria-hidden="true">
      {[55, 110, 165].map((y) => <line key={`y-${y}`} x1="20" y1={y} x2="420" y2={y} />)}
      {[80, 160, 240, 320, 400].map((x) => <line key={`x-${x}`} x1={x} y1="20" x2={x} y2="200" />)}
    </g>
  )
}

function ComplexPlaneDiagram() {
  const angle = Math.PI / 5
  const endX = 220 + Math.cos(angle) * 108
  const endY = 112 - Math.sin(angle) * 82
  return (
    <>
      <Grid />
      <g className="signal-diagram-axis">
        <line x1="45" y1="112" x2="395" y2="112" />
        <line x1="220" y1="188" x2="220" y2="28" />
      </g>
      <path className="signal-diagram-angle" d="M258 112 A38 38 0 0 0 251 90" />
      <line className="signal-diagram-projection" x1={endX} y1={endY} x2={endX} y2="112" />
      <line className="signal-diagram-projection" x1="220" y1={endY} x2={endX} y2={endY} />
      <line className="signal-diagram-vector" x1="220" y1="112" x2={endX} y2={endY} />
      <circle className="signal-diagram-point" cx={endX} cy={endY} r="5" />
      <text className="signal-diagram-label" x="398" y="106">Re</text>
      <text className="signal-diagram-label" x="228" y="31">Im</text>
      <text className="signal-diagram-value" x={endX + 9} y={endY - 7}>z = a + jb</text>
      <text className="signal-diagram-label" x="260" y="103">φ</text>
    </>
  )
}

function EulerDiagram() {
  const centerX = 164
  const centerY = 112
  const radius = 72
  const angle = Math.PI / 4
  const endX = centerX + Math.cos(angle) * radius
  const endY = centerY - Math.sin(angle) * radius
  return (
    <>
      <Grid />
      <circle className="signal-diagram-orbit" cx={centerX} cy={centerY} r={radius} />
      <g className="signal-diagram-axis">
        <line x1="72" y1={centerY} x2="256" y2={centerY} />
        <line x1={centerX} y1="24" x2={centerX} y2="200" />
      </g>
      <line className="signal-diagram-vector" x1={centerX} y1={centerY} x2={endX} y2={endY} />
      <line className="signal-diagram-projection" x1={endX} y1={endY} x2={endX} y2={centerY} />
      <line className="signal-diagram-projection secondary" x1={centerX} y1={endY} x2={endX} y2={endY} />
      <circle className="signal-diagram-point" cx={endX} cy={endY} r="5" />
      <text className="signal-diagram-value" x="282" y="86">cos θ</text>
      <text className="signal-diagram-value amber" x="282" y="111">j sin θ</text>
      <text className="signal-diagram-equals" x="282" y="142">旋转 = 两个投影</text>
      <text className="signal-diagram-label" x={endX - 13} y={centerY + 17}>cos θ</text>
      <text className="signal-diagram-label" x={centerX + 7} y={endY - 6}>sin θ</text>
    </>
  )
}

function PhasorWaveDiagram() {
  const wavePath = PHASOR_DIAGRAM_MODEL.points.map((point, index) => {
    const x = 205 + point.progress * 210
    const y = 112 - point.imaginary * 62
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const angle = Math.PI / 6
  const endX = 112 + Math.cos(angle) * 62
  const endY = 112 - Math.sin(angle) * 62
  return (
    <>
      <Grid />
      <circle className="signal-diagram-orbit" cx="112" cy="112" r="62" />
      <line className="signal-diagram-vector" x1="112" y1="112" x2={endX} y2={endY} />
      <line className="signal-diagram-projection" x1={endX} y1={endY} x2="205" y2={endY} />
      <circle className="signal-diagram-point" cx={endX} cy={endY} r="4.5" />
      <path className="signal-diagram-trace" d={wavePath} />
      <line className="signal-diagram-axis" x1="205" y1="112" x2="420" y2="112" />
      <text className="signal-diagram-label" x="78" y="199">复平面旋转</text>
      <text className="signal-diagram-label" x="331" y="199">虚部随时间</text>
    </>
  )
}

function SamplingDiagram() {
  const sampleCount = 16
  const valueAt = (progress: number) => Math.sin(2 * Math.PI * 2.35 * progress + 0.25)
  const path = curvePath(120, valueAt, 30, 410, 110, 70)
  return (
    <>
      <Grid />
      <line className="signal-diagram-axis" x1="25" y1="110" x2="420" y2="110" />
      <path className="signal-diagram-reference" d={path} />
      {Array.from({ length: sampleCount }, (_, index) => {
        const progress = index / (sampleCount - 1)
        const x = 30 + progress * 380
        const y = 110 - valueAt(progress) * 70
        return (
          <g key={index}>
            <line className="signal-diagram-stem" x1={x} y1="110" x2={x} y2={y} />
            <circle className="signal-diagram-sample" cx={x} cy={y} r="3.5" />
          </g>
        )
      })}
      <text className="signal-diagram-label" x="31" y="31">连续参考曲线</text>
      <text className="signal-diagram-value" x="302" y="193">N = 16 samples</text>
    </>
  )
}

function DftBinDiagram() {
  const points = [
    { real: 0, imaginary: 0 },
    ...DFT_DIAGRAM_MODEL.contributions.map(({ partialSum }) => partialSum),
  ]
  const maxValue = Math.max(
    1,
    ...points.map((point) => Math.hypot(point.real, point.imaginary)),
  )
  const scale = 72 / maxValue
  const path = points.map((point, index) => {
    const x = 150 + point.real * scale
    const y = 112 - point.imaginary * scale
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const result = points.at(-1) ?? { real: 0, imaginary: 0 }
  return (
    <>
      <Grid />
      <g className="signal-diagram-axis">
        <line x1="38" y1="112" x2="275" y2="112" />
        <line x1="150" y1="26" x2="150" y2="198" />
      </g>
      <path className="signal-diagram-vector-chain" d={path} />
      {points.slice(1).map((point, index) => (
        <circle
          className="signal-diagram-chain-point"
          cx={150 + point.real * scale}
          cy={112 - point.imaginary * scale}
          key={index}
          r="2.2"
        />
      ))}
      <line
        className="signal-diagram-result"
        x1="150"
        y1="112"
        x2={150 + result.real * scale}
        y2={112 - result.imaginary * scale}
      />
      <text className="signal-diagram-value" x="301" y="78">signal bin = 3</text>
      <text className="signal-diagram-value amber" x="301" y="105">inspect k = 3</text>
      <text className="signal-diagram-equals" x="301" y="138">同向累加</text>
      <text className="signal-diagram-label" x="301" y="160">|X[3]| = 8</text>
    </>
  )
}

function MagnitudePhaseDiagram() {
  const barWidth = 180 / MAGNITUDE_DIAGRAM_SPECTRUM.length
  return (
    <>
      <Grid />
      <line className="signal-diagram-axis" x1="30" y1="175" x2="225" y2="175" />
      {MAGNITUDE_DIAGRAM_SPECTRUM.map((bin) => {
        const height = Math.min(1, bin.magnitude) * 105
        return (
          <rect
            className="signal-diagram-bar"
            height={height}
            key={bin.bin}
            width={Math.max(3, barWidth - 3)}
            x={35 + bin.bin * barWidth}
            y={175 - height}
          />
        )
      })}
      <circle className="signal-diagram-orbit" cx="329" cy="111" r="61" />
      {[3, 8, 12].map((bin, index) => {
        const phase = MAGNITUDE_DIAGRAM_SPECTRUM[bin]?.phaseRadians ?? 0
        const radius = 26 + index * 15
        return (
          <line
            className={index === 0 ? 'signal-diagram-vector' : 'signal-diagram-phase-vector'}
            key={bin}
            x1="329"
            y1="111"
            x2={329 + Math.cos(phase) * radius}
            y2={111 - Math.sin(phase) * radius}
          />
        )
      })}
      <text className="signal-diagram-label" x="83" y="200">幅度谱 |X[k]|</text>
      <text className="signal-diagram-label" x="286" y="200">相位谱 ∠X[k]</text>
    </>
  )
}

function FftDiagram() {
  const columns = [50, 160, 270, 390]
  const rows = Array.from({ length: 8 }, (_, index) => 38 + index * 21)
  return (
    <>
      <Grid />
      {columns.slice(0, -1).map((x, stage) => (
        <g className="signal-diagram-butterfly" key={x}>
          {rows.flatMap((y, index) => {
            const partner = index ^ (1 << stage)
            return [
              <line key={`${index}-straight`} x1={x} y1={y} x2={columns[stage + 1]} y2={y} />,
              <line key={`${index}-cross`} x1={x} y1={y} x2={columns[stage + 1]} y2={rows[partner]} />,
            ]
          })}
        </g>
      ))}
      {columns.map((x, column) => rows.map((y, row) => (
        <circle className="signal-diagram-fft-node" cx={x} cy={y} key={`${column}-${row}`} r="3" />
      )))}
      <text className="signal-diagram-label" x="31" y="20">x[n]</text>
      <text className="signal-diagram-label" x="369" y="20">X[k]</text>
      <rect className="signal-diagram-callout" x="150" y="184" width="140" height="25" rx="5" />
      <text className="signal-diagram-value" x="166" y="201">相同 DFT · 更少运算</text>
    </>
  )
}

function WindowingDiagram() {
  const raw = curvePath(
    64,
    (progress) => Math.cos(2 * Math.PI * 3.35 * progress),
    30,
    410,
    73,
    42,
  )
  const windowed = Array.from(WINDOW_DIAGRAM_COEFFICIENTS, (coefficient, index) => {
    const progress = index / (WINDOW_DIAGRAM_COEFFICIENTS.length - 1)
    const x = 30 + progress * 380
    const value = Math.cos(2 * Math.PI * 3.35 * progress) * coefficient
    const y = 158 - value * 42
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const windowPath = curvePath(
    WINDOW_DIAGRAM_COEFFICIENTS.length,
    (progress) => WINDOW_DIAGRAM_COEFFICIENTS[Math.min(WINDOW_DIAGRAM_COEFFICIENTS.length - 1, Math.round(progress * (WINDOW_DIAGRAM_COEFFICIENTS.length - 1)))] ?? 0,
    30,
    410,
    199,
    34,
  )
  return (
    <>
      <Grid />
      <path className="signal-diagram-reference" d={raw} />
      <path className="signal-diagram-trace" d={windowed} />
      <path className="signal-diagram-window" d={windowPath} />
      <text className="signal-diagram-label" x="31" y="22">矩形截帧：首尾跳变</text>
      <text className="signal-diagram-label" x="31" y="126">Hann 加窗：边界归零</text>
      <text className="signal-diagram-value" x="328" y="202">w[n]</text>
    </>
  )
}

function StftDiagram() {
  const shownBins = Math.min(15, STFT_DIAGRAM_MODEL.binCount)
  const maxMagnitude = STFT_DIAGRAM_MODEL.maxMagnitude || 1
  return (
    <>
      <Grid />
      <path
        className="signal-diagram-reference"
        d={curvePath(100, (progress) => Math.cos(2 * Math.PI * (1.4 * progress + 6.8 * progress * progress)), 25, 414, 54, 25)}
      />
      {[45, 104, 163, 222, 281].map((x, index) => (
        <rect className="signal-diagram-frame" height="58" key={x} width="92" x={x} y="24" style={{ opacity: 0.18 + index * 0.08 }} />
      ))}
      {Array.from({ length: STFT_DIAGRAM_MODEL.frameCount }, (_, frame) => (
        Array.from({ length: shownBins }, (_, bin) => {
          const magnitude = STFT_DIAGRAM_MODEL.magnitudes[
            frame * STFT_DIAGRAM_MODEL.binCount + bin
          ] ?? 0
          const intensity = Math.min(1, magnitude / maxMagnitude)
          return (
            <rect
              className="signal-diagram-heat-cell"
              height="6"
              key={`${frame}-${bin}`}
              width="13"
              x={122 + frame * 15}
              y={192 - bin * 7}
              style={{ opacity: 0.12 + intensity * 0.88 }}
            />
          )
        })
      ))}
      <path className="signal-diagram-flow" d="M68 89 C86 110 94 132 112 146" />
      <text className="signal-diagram-label" x="25" y="18">滑动窗</text>
      <text className="signal-diagram-label" x="22" y="205">频率 ↑</text>
      <text className="signal-diagram-label" x="328" y="211">时间 →</text>
    </>
  )
}

function DiagramContent({ topic }: SignalKnowledgeDiagramProps) {
  switch (topic.diagram) {
    case 'complex-plane': return <ComplexPlaneDiagram />
    case 'euler': return <EulerDiagram />
    case 'phasor-wave': return <PhasorWaveDiagram />
    case 'sampling': return <SamplingDiagram />
    case 'dft-bin': return <DftBinDiagram />
    case 'magnitude-phase': return <MagnitudePhaseDiagram />
    case 'fft': return <FftDiagram />
    case 'windowing': return <WindowingDiagram />
    case 'stft': return <StftDiagram />
    default: {
      const unsupportedDiagram: never = topic.diagram
      throw new Error(`Unsupported signal diagram: ${String(unsupportedDiagram)}`)
    }
  }
}

export function SignalKnowledgeDiagram({ topic }: SignalKnowledgeDiagramProps) {
  const titleId = `signal-diagram-${topic.id}-title`
  const descriptionId = `signal-diagram-${topic.id}-description`
  return (
    <figure className="signal-knowledge-figure">
      <svg
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      >
        <title id={titleId}>{topic.title}图解</title>
        <desc id={descriptionId}>{topic.summary}</desc>
        <DiagramContent topic={topic} />
      </svg>
      <figcaption>{topic.insight}</figcaption>
    </figure>
  )
}
