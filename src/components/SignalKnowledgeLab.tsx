import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Box,
  CirclePause,
  CirclePlay,
  Orbit,
  RotateCcw,
  Sigma,
} from 'lucide-react'

import { complexMagnitude, complexPhase } from '../domain/signal-knowledge/complex'
import {
  createDftTeachingModel,
  createPhasorTeachingModel,
  type DftTeachingModel,
  type PhasorTeachingModel,
} from '../domain/signal-knowledge/models'
import type { SignalKnowledgeDemoKind } from './SignalKnowledge3D'
import {
  computeTeachingStft,
  createTeachingWindow,
  generateTeachingSignal,
  type TeachingSignalKind,
  type TeachingStftModel,
  type TeachingWindowName,
} from '../domain/signal-knowledge/transforms'

const LazySignalKnowledge3D = lazy(async () => {
  const module = await import('./SignalKnowledge3D')
  return { default: module.SignalKnowledge3D }
})

const TWO_PI = 2 * Math.PI
const SIGNAL_LABELS: Readonly<Record<TeachingSignalKind, string>> = {
  sine: '单音正弦',
  'two-tone': '双音信号',
  chirp: '扫频信号',
  impulse: '单位脉冲',
  silence: '静音',
}

function normalizeRadians(value: number): number {
  return ((value % TWO_PI) + TWO_PI) % TWO_PI
}

function PhasorProjection({
  model,
  phaseRadians,
}: {
  readonly model: PhasorTeachingModel
  readonly phaseRadians: number
}) {
  const centerX = 100
  const centerY = 124
  const radius = 62
  const vectorX = centerX + Math.cos(phaseRadians) * radius
  const vectorY = centerY - Math.sin(phaseRadians) * radius
  const wavePath = Array.from({ length: 72 }, (_, index) => {
    const progress = index / 71
    const x = 195 + progress * 205
    const angle = phaseRadians + TWO_PI * model.cycles * progress
    const y = centerY - Math.sin(angle) * 51
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return (
    <svg aria-label="旋转复数和正弦投影的同步二维视图" role="img" viewBox="0 0 420 250">
      <g className="signal-lab-grid" aria-hidden="true">
        {[62, 124, 186].map((y) => <line key={y} x1="18" y1={y} x2="405" y2={y} />)}
      </g>
      <circle className="signal-lab-orbit" cx={centerX} cy={centerY} r={radius} />
      <line className="signal-lab-axis-line" x1="25" y1={centerY} x2="173" y2={centerY} />
      <line className="signal-lab-axis-line" x1={centerX} y1="43" x2={centerX} y2="205" />
      <line className="signal-lab-vector" x1={centerX} y1={centerY} x2={vectorX} y2={vectorY} />
      <line className="signal-lab-projection" x1={vectorX} y1={vectorY} x2="195" y2={vectorY} />
      <circle className="signal-lab-point" cx={vectorX} cy={vectorY} r="4.5" />
      <line className="signal-lab-axis-line" x1="195" y1={centerY} x2="405" y2={centerY} />
      <path className="signal-lab-wave" d={wavePath} />
      <text className="signal-lab-label" x="58" y="225">复平面</text>
      <text className="signal-lab-label" x="309" y="225">Im{`{z(t)}`}</text>
    </svg>
  )
}

function dftPath(
  model: DftTeachingModel,
  visibleCount: number,
): { readonly full: string; readonly visible: string } {
  const points = [
    { real: 0, imaginary: 0 },
    ...model.contributions.map(({ partialSum }) => partialSum),
  ]
  const maxValue = Math.max(
    1,
    ...points.map((point) => Math.hypot(point.real, point.imaginary)),
  )
  const scale = 68 / maxValue
  const pathFor = (items: typeof points) => items.map((point, index) => {
    const x = 290 + point.real * scale
    const y = 128 - point.imaginary * scale
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return {
    full: pathFor(points),
    visible: pathFor(points.slice(0, Math.max(1, visibleCount + 1))),
  }
}

function DftProjection({
  model,
  revealCount,
}: {
  readonly model: DftTeachingModel
  readonly revealCount: number
}) {
  const paths = dftPath(model, revealCount)
  return (
    <svg aria-label="离散样本与 DFT 复向量累加的同步二维视图" role="img" viewBox="0 0 420 250">
      <g className="signal-lab-grid" aria-hidden="true">
        {[62, 124, 186].map((y) => <line key={y} x1="18" y1={y} x2="405" y2={y} />)}
      </g>
      <line className="signal-lab-axis-line" x1="22" y1="128" x2="190" y2="128" />
      {Array.from(model.samples, (sample, index) => {
        const x = 28 + (index / Math.max(1, model.sampleCount - 1)) * 154
        const y = 128 - sample * 61
        return (
          <g key={index}>
            <line className="signal-lab-sample-stem" x1={x} y1="128" x2={x} y2={y} />
            <circle className={index < revealCount ? 'signal-lab-sample active' : 'signal-lab-sample'} cx={x} cy={y} r="2.7" />
          </g>
        )
      })}
      <g className="signal-lab-complex-axis">
        <line x1="207" y1="128" x2="405" y2="128" />
        <line x1="290" y1="38" x2="290" y2="218" />
      </g>
      <path className="signal-lab-dft-full" d={paths.full} />
      <path className="signal-lab-dft-visible" d={paths.visible} />
      <text className="signal-lab-label" x="66" y="225">x[n]</text>
      <text className="signal-lab-label" x="314" y="225">Σ x[n]e⁻ʲ²ᵖⁱᵏⁿ／ᴺ</text>
    </svg>
  )
}

function StftProjection({
  model,
  samples,
  frameIndex,
  windowCoefficients,
}: {
  readonly model: TeachingStftModel
  readonly samples: Float64Array
  readonly frameIndex: number
  readonly windowCoefficients: Float64Array
}) {
  const normalizedFrame = Math.max(0, Math.min(model.frameCount - 1, frameIndex))
  const frameStart = normalizedFrame * model.hopSize
  const sourcePath = Array.from(samples, (sample, index) => {
    const x = 22 + (index / Math.max(1, samples.length - 1)) * 376
    const y = 66 - sample * 33
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const windowedPath = Array.from(windowCoefficients, (coefficient, index) => {
    const sourceIndex = frameStart + index
    const sample = samples[sourceIndex] ?? 0
    const x = 22 + (sourceIndex / Math.max(1, samples.length - 1)) * 376
    const y = 66 - sample * coefficient * 33
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const frameX = 22 + (frameStart / Math.max(1, samples.length - 1)) * 376
  const frameWidth = (model.windowSize / Math.max(1, samples.length - 1)) * 376
  const currentMagnitudes = Array.from({ length: model.binCount }, (_, bin) => (
    model.magnitudes[normalizedFrame * model.binCount + bin] ?? 0
  ))
  const maxMagnitude = model.maxMagnitude || 1

  return (
    <svg aria-label="滑动窗、当前频谱与 STFT 帧位置的同步二维视图" role="img" viewBox="0 0 420 250">
      <g className="signal-lab-grid" aria-hidden="true">
        {[66, 136, 216].map((y) => <line key={y} x1="18" y1={y} x2="405" y2={y} />)}
      </g>
      <path className="signal-lab-source-wave" d={sourcePath} />
      <rect className="signal-lab-window-frame" height="74" width={frameWidth} x={frameX} y="25" />
      <path className="signal-lab-windowed-wave" d={windowedPath} />
      <line className="signal-lab-axis-line" x1="22" y1="216" x2="400" y2="216" />
      {currentMagnitudes.map((magnitude, bin) => {
        const barWidth = 340 / Math.max(1, currentMagnitudes.length)
        const height = Math.min(1, magnitude / maxMagnitude) * 68
        return (
          <rect
            className="signal-lab-spectrum-bar"
            height={height}
            key={bin}
            width={Math.max(3, barWidth - 3)}
            x={50 + bin * barWidth}
            y={216 - height}
          />
        )
      })}
      <text className="signal-lab-label" x="23" y="18">x[n] + 当前窗</text>
      <text className="signal-lab-label" x="22" y="125">frame {normalizedFrame + 1} / {model.frameCount}</text>
      <text className="signal-lab-label" x="300" y="238">当前帧频谱 Xₘ[k]</text>
    </svg>
  )
}

function readReducedMotionPreference(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function SignalKnowledgeLab() {
  const [demo, setDemo] = useState<SignalKnowledgeDemoKind>('phasor')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [frequency, setFrequency] = useState(3)
  const [phaseDegrees, setPhaseDegrees] = useState(0)
  const [sampleCount, setSampleCount] = useState(16)
  const [inspectedBin, setInspectedBin] = useState(3)
  const [dftSignalKind, setDftSignalKind] = useState<TeachingSignalKind>('sine')
  const [stftSignalKind, setStftSignalKind] = useState<TeachingSignalKind>('chirp')
  const [windowName, setWindowName] = useState<TeachingWindowName>('hann')
  const [animationRadians, setAnimationRadians] = useState(0)
  const [reducedMotion] = useState(readReducedMotionPreference)
  const [labVisible, setLabVisible] = useState(true)
  const sectionRef = useRef<HTMLElement>(null)
  const previousFrameRef = useRef<number | null>(null)

  const phasorModel = useMemo(
    () => createPhasorTeachingModel(frequency / 2, 0, 96),
    [frequency],
  )
  const basePhaseRadians = phaseDegrees * Math.PI / 180
  const displayedPhaseRadians = normalizeRadians(basePhaseRadians + animationRadians)
  const dftSignalBin = Math.min(frequency, Math.floor(sampleCount / 2) - 1)
  const dftModel = useMemo(
    () => createDftTeachingModel(
      sampleCount,
      dftSignalBin,
      Math.min(inspectedBin, sampleCount - 1),
      basePhaseRadians,
      dftSignalKind,
    ),
    [basePhaseRadians, dftSignalBin, dftSignalKind, inspectedBin, sampleCount],
  )
  const stftSamples = useMemo(() => generateTeachingSignal({
    kind: stftSignalKind,
    sampleCount: 128,
    cycles: frequency,
    phaseRadians: basePhaseRadians,
  }), [basePhaseRadians, frequency, stftSignalKind])
  const stftModel = useMemo(
    () => computeTeachingStft(stftSamples, 32, 8, windowName),
    [stftSamples, windowName],
  )
  const stftWindow = useMemo(
    () => createTeachingWindow(windowName, stftModel.windowSize),
    [stftModel.windowSize, windowName],
  )
  const revealCount = demo === 'dft'
    ? Math.min(sampleCount, Math.max(1, Math.floor((animationRadians / TWO_PI) * sampleCount) + 1))
    : sampleCount
  const stftFrameIndex = Math.min(
    Math.max(0, stftModel.frameCount - 1),
    Math.floor((animationRadians / TWO_PI) * stftModel.frameCount),
  )

  useEffect(() => {
    const section = sectionRef.current
    if (!section || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setLabVisible(entry?.isIntersecting ?? false),
      { threshold: 0.05 },
    )
    observer.observe(section)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!playing || !labVisible) {
      previousFrameRef.current = null
      return
    }
    let frameId = 0
    const tick = (time: number) => {
      const previous = previousFrameRef.current ?? time
      previousFrameRef.current = time
      const elapsedSeconds = Math.min(0.05, Math.max(0, time - previous) / 1_000)
      setAnimationRadians((current) => normalizeRadians(
        current + elapsedSeconds * speed * TWO_PI * 0.28,
      ))
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frameId)
      previousFrameRef.current = null
    }
  }, [labVisible, playing, speed])

  const reset = () => {
    setPlaying(false)
    setAnimationRadians(0)
    setPhaseDegrees(0)
  }
  const finalDft = dftModel.contributions.at(-1)?.partialSum
    ?? { real: 0, imaginary: 0 }
  const currentReal = Math.cos(displayedPhaseRadians)
  const currentImaginary = Math.sin(displayedPhaseRadians)
  let stftPeakBin = 0
  let stftPeakMagnitude = 0
  for (let bin = 0; bin < stftModel.binCount; bin += 1) {
    const magnitude = stftModel.magnitudes[
      stftFrameIndex * stftModel.binCount + bin
    ] ?? 0
    if (magnitude > stftPeakMagnitude) {
      stftPeakMagnitude = magnitude
      stftPeakBin = bin
    }
  }

  const selectDemo = (nextDemo: SignalKnowledgeDemoKind) => {
    setDemo(nextDemo)
    setAnimationRadians(0)
  }

  return (
    <section className="signal-knowledge-lab panel-surface" id="signal-knowledge-lab" ref={sectionRef} aria-labelledby="signal-knowledge-lab-title">
      <header className="signal-knowledge-lab-heading">
        <div>
          <span className="eyebrow">INTERACTIVE THREE.JS LAB</span>
          <h2 id="signal-knowledge-lab-title"><Orbit size={19} /> 交互式数学实验</h2>
          <p>二维投影与三维场景共享同一组纯数据模型；拖动三维坐标可换角度观察，滚轮可缩放。</p>
        </div>
        <span><Box size={14} /> THREE.JS LAZY CHUNK</span>
      </header>

      <nav className="signal-knowledge-demo-tabs" aria-label="三维教学场景">
        <button type="button" className={demo === 'phasor' ? 'active' : ''} aria-pressed={demo === 'phasor'} onClick={() => selectDemo('phasor')}><Orbit size={14} /> 旋转复数 → 正弦投影</button>
        <button type="button" className={demo === 'dft' ? 'active' : ''} aria-pressed={demo === 'dft'} onClick={() => selectDemo('dft')}><Sigma size={14} /> DFT bin 向量累加</button>
        <button type="button" className={demo === 'stft' ? 'active' : ''} aria-pressed={demo === 'stft'} onClick={() => selectDemo('stft')}><Box size={14} /> 滑动窗 → STFT 结构</button>
      </nav>

      <div className="signal-knowledge-lab-stage">
        <article className="signal-knowledge-lab-view">
          <header><span>2D PROJECTION</span><strong>同步二维投影</strong></header>
          {demo === 'phasor'
            ? <PhasorProjection model={phasorModel} phaseRadians={displayedPhaseRadians} />
            : demo === 'dft'
              ? <DftProjection model={dftModel} revealCount={revealCount} />
              : <StftProjection model={stftModel} samples={stftSamples} frameIndex={stftFrameIndex} windowCoefficients={stftWindow} />}
        </article>
        <article className="signal-knowledge-lab-view three-d">
          <header><span>3D MODEL</span><strong>{demo === 'phasor' ? '时间 / 实部 / 虚部' : demo === 'dft' ? '样本 / 累加实部 / 累加虚部' : '时间 / 幅度 / 频率'}</strong></header>
          <Suspense fallback={<div className="signal-knowledge-3d-loading"><span className="spinner" /> 正在懒加载 Three.js…</div>}>
            <LazySignalKnowledge3D
              demo={demo}
              dftModel={dftModel}
              phaseRadians={displayedPhaseRadians}
              phasorModel={phasorModel}
              revealCount={revealCount}
              stftFrameIndex={stftFrameIndex}
              stftModel={stftModel}
              onContextLost={() => setPlaying(false)}
            />
          </Suspense>
        </article>
      </div>

      <div className="signal-knowledge-lab-controls">
        <div className="signal-knowledge-playback-controls">
          <button type="button" className="signal-knowledge-play-button" aria-keyshortcuts="Space" aria-label={playing ? '暂停教学动画' : '播放教学动画'} onClick={() => setPlaying((current) => !current)}>
            {playing ? <CirclePause size={18} /> : <CirclePlay size={18} />}
            {playing ? '暂停' : '播放'}
          </button>
          <button type="button" className="mini-button" onClick={reset}><RotateCcw size={12} /> 重置</button>
          {reducedMotion && <span className="signal-knowledge-motion-note">已遵循“减少动态效果”，默认暂停</span>}
          {playing && !labVisible && <span className="signal-knowledge-motion-note">实验离开视口，动画时钟已暂停</span>}
        </div>

        <label className="signal-knowledge-control-field">
          <span>速度 <output>{speed.toFixed(1)}×</output></span>
          <input type="range" min="0.25" max="2" step="0.25" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
        </label>
        <label className="signal-knowledge-control-field">
          <span>{demo === 'phasor' ? '旋转频率' : demo === 'dft' ? '信号 bin' : '教学频率'} <output>{demo === 'phasor' ? `${(frequency / 2).toFixed(1)} 圈` : demo === 'dft' ? dftSignalBin : frequency}</output></span>
          <input type="range" min="1" max={demo === 'dft' ? Math.max(1, Math.floor(sampleCount / 2) - 1) : 8} step="1" value={demo === 'dft' ? Math.min(frequency, Math.floor(sampleCount / 2) - 1) : frequency} disabled={(demo === 'dft' && (dftSignalKind === 'impulse' || dftSignalKind === 'silence')) || (demo === 'stft' && (stftSignalKind === 'impulse' || stftSignalKind === 'silence'))} onChange={(event) => setFrequency(Number(event.target.value))} />
        </label>
        <label className="signal-knowledge-control-field">
          <span>初相位 <output>{phaseDegrees}°</output></span>
          <input type="range" min="-180" max="180" step="15" value={phaseDegrees} onChange={(event) => setPhaseDegrees(Number(event.target.value))} />
        </label>
        {demo === 'dft' && (
          <>
            <label className="signal-knowledge-control-field compact">
              <span>DFT 点数 N</span>
              <select value={sampleCount} onChange={(event) => { const next = Number(event.target.value); setSampleCount(next); setInspectedBin((current) => Math.min(current, next - 1)); setFrequency((current) => Math.min(current, Math.floor(next / 2) - 1)) }}>
                <option value="8">8</option>
                <option value="16">16</option>
                <option value="32">32</option>
              </select>
            </label>
            <label className="signal-knowledge-control-field">
              <span>检测 bin k <output>{Math.min(inspectedBin, sampleCount - 1)}</output></span>
              <input type="range" min="0" max={sampleCount - 1} step="1" value={Math.min(inspectedBin, sampleCount - 1)} onChange={(event) => setInspectedBin(Number(event.target.value))} />
            </label>
          </>
        )}
        {demo !== 'phasor' && (
          <label className="signal-knowledge-control-field compact">
            <span>教学信号</span>
            <select value={demo === 'dft' ? dftSignalKind : stftSignalKind} onChange={(event) => { const next = event.target.value as TeachingSignalKind; if (demo === 'dft') setDftSignalKind(next); else setStftSignalKind(next) }}>
              {Object.entries(SIGNAL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
        {demo === 'stft' && (
          <label className="signal-knowledge-control-field compact">
            <span>窗函数</span>
            <select value={windowName} onChange={(event) => setWindowName(event.target.value as TeachingWindowName)}>
              <option value="rectangular">Rectangular</option>
              <option value="hann">Hann</option>
              <option value="hamming">Hamming</option>
              <option value="blackman">Blackman</option>
            </select>
          </label>
        )}
      </div>

      <div className="signal-knowledge-readouts" role="status" aria-live={playing ? 'off' : 'polite'}>
        {demo === 'phasor' ? (
          <>
            <span><small>当前角度</small><strong>{Math.round(displayedPhaseRadians * 180 / Math.PI)}°</strong></span>
            <span><small>实部 cos θ</small><strong>{currentReal.toFixed(3)}</strong></span>
            <span><small>虚部 sin θ</small><strong>{currentImaginary.toFixed(3)}</strong></span>
            <p>同一个相位同时决定复平面向量、三维螺旋端点和二维正弦投影。</p>
          </>
        ) : demo === 'dft' ? (
          <>
            <span><small>累加进度</small><strong>{revealCount} / {sampleCount}</strong></span>
            <span><small>|X[{Math.min(inspectedBin, sampleCount - 1)}]|</small><strong>{complexMagnitude(finalDft).toFixed(3)}</strong></span>
            <span><small>∠X[k]</small><strong>{(complexPhase(finalDft) * 180 / Math.PI).toFixed(1)}°</strong></span>
            <p>{dftSignalKind === 'sine' && Math.min(inspectedBin, sampleCount - 1) === dftSignalBin ? '检测频率与信号匹配，复向量趋向同向累加。' : `${SIGNAL_LABELS[dftSignalKind]}在 k=${Math.min(inspectedBin, sampleCount - 1)} 的复向量和如图所示。`}</p>
          </>
        ) : (
          <>
            <span><small>当前帧</small><strong>{stftFrameIndex + 1} / {stftModel.frameCount}</strong></span>
            <span><small>主峰 bin</small><strong>{stftPeakBin}</strong></span>
            <span><small>主峰幅度</small><strong>{stftPeakMagnitude.toFixed(3)}</strong></span>
            <p>窗口 N={stftModel.windowSize}、hop={stftModel.hopSize}；当前二维频谱与三维橙色时间切片共享 frame {stftFrameIndex + 1}。</p>
          </>
        )}
      </div>
    </section>
  )
}
