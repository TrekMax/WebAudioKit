import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import WebGL from 'three/addons/capabilities/WebGL.js'
import {
  CSS2DObject,
  CSS2DRenderer,
} from 'three/addons/renderers/CSS2DRenderer.js'
import type { StftPreviewResult } from '../audio/analysis'
import { useElementSize } from '../hooks/useElementSize'
import { normalizeDb, spectrumColor } from '../visualization/colorMap'
import {
  buildFft3DAxisTicks,
  mapFrequencyUnitFromOrigin,
  type AxisTick,
  type Fft3DAxisTicks,
} from '../visualization/fft3dAxes'

export type Fft3DMode = 'surface' | 'wireframe' | 'waterfall'
export type Fft3DQuality = 'low' | 'medium' | 'high'

interface Fft3DViewProps {
  result: StftPreviewResult | null
  currentTime: number
  minDb: number
  maxDb: number
  frequencyScale: 'linear' | 'log'
  mode: Fft3DMode
  quality: Fft3DQuality
  onResetReady?: (reset: () => void) => void
}

const QUALITY_SIZE: Record<Fft3DQuality, number> = {
  low: 72,
  medium: 112,
  high: 160,
}

const TIME_AXIS_MIN = -5
const TIME_AXIS_MAX = 5
const FREQUENCY_AXIS_ORIGIN_Z = 3
const FREQUENCY_AXIS_FAR_Z = -3
const AMPLITUDE_AXIS_HEIGHT = 2.6
const AXIS_X = 5.35
const AXIS_Z = 3.35

type AxisKind = 'time' | 'frequency' | 'amplitude'

const AXIS_COLORS: Record<AxisKind, number> = {
  time: 0x1fdfb2,
  frequency: 0x64a9ff,
  amplitude: 0xffb35c,
}

interface GeometryData {
  positions: Float32Array
  colors: Float32Array
  indices: Uint32Array
  rows: number
  columns: number
}

function sampleIndex(index: number, count: number, sourceCount: number): number {
  if (count <= 1 || sourceCount <= 1) return 0
  return Math.min(sourceCount - 1, Math.round((index / (count - 1)) * (sourceCount - 1)))
}

function buildGeometryData(
  result: StftPreviewResult,
  maxSize: number,
  minDb: number,
  maxDb: number,
  frequencyScale: 'linear' | 'log',
): GeometryData {
  const rows = Math.max(2, Math.min(maxSize, result.frameCount))
  const columns = Math.max(2, Math.min(maxSize, result.binCount))
  const positions = new Float32Array(rows * columns * 3)
  const colors = new Float32Array(rows * columns * 3)
  let vertex = 0
  for (let row = 0; row < rows; row += 1) {
    const frame = sampleIndex(row, rows, result.frameCount)
    const x = -5 + (row / (rows - 1)) * 10
    for (let column = 0; column < columns; column += 1) {
      const frequencyUnit = column / (columns - 1)
      const maxFrequency = result.frequenciesHz.at(-1) ?? result.sampleRate / 2
      const frequency = frequencyScale === 'log' && maxFrequency > 20
        ? 20 * (maxFrequency / 20) ** frequencyUnit
        : maxFrequency * frequencyUnit
      const bin = Math.max(0, Math.min(
        result.binCount - 1,
        Math.round(frequency * result.fftSize / result.sampleRate),
      ))
      const db = result.valuesDbfs[frame * result.binCount + bin] ?? minDb
      const normalized = normalizeDb(db, minDb, maxDb)
      const z = mapFrequencyUnitFromOrigin(
        frequencyUnit,
        FREQUENCY_AXIS_ORIGIN_Z,
        FREQUENCY_AXIS_FAR_Z,
      )
      positions[vertex * 3] = x
      positions[vertex * 3 + 1] = normalized * 2.6
      positions[vertex * 3 + 2] = z
      const [red, green, blue] = spectrumColor(normalized)
      colors[vertex * 3] = red / 255
      colors[vertex * 3 + 1] = green / 255
      colors[vertex * 3 + 2] = blue / 255
      vertex += 1
    }
  }

  const indices = new Uint32Array((rows - 1) * (columns - 1) * 6)
  let offset = 0
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = row * columns + column
      const topRight = topLeft + 1
      const bottomLeft = (row + 1) * columns + column
      const bottomRight = bottomLeft + 1
      indices[offset] = topLeft
      indices[offset + 1] = bottomLeft
      indices[offset + 2] = topRight
      indices[offset + 3] = topRight
      indices[offset + 4] = bottomLeft
      indices[offset + 5] = bottomRight
      offset += 6
    }
  }
  return { positions, colors, indices, rows, columns }
}

function createWaterfall(
  data: GeometryData,
): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const linePositions: number[] = []
  const lineColors: number[] = []
  for (let row = 0; row < data.rows; row += 1) {
    for (let column = 0; column < data.columns - 1; column += 1) {
      for (const vertex of [row * data.columns + column, row * data.columns + column + 1]) {
        linePositions.push(
          data.positions[vertex * 3] ?? 0,
          data.positions[vertex * 3 + 1] ?? 0,
          data.positions[vertex * 3 + 2] ?? 0,
        )
        lineColors.push(
          data.colors[vertex * 3] ?? 0,
          data.colors[vertex * 3 + 1] ?? 0,
          data.colors[vertex * 3 + 2] ?? 0,
        )
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3))
  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })
  return new THREE.LineSegments(geometry, material)
}

function createAxisLines(
  positions: readonly number[],
  color: number,
): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  const lines = new THREE.LineSegments(geometry, material)
  lines.renderOrder = 20
  return lines
}

function createTickLabel(
  tick: AxisTick,
  axis: AxisKind,
  position: THREE.Vector3,
  hideInCompact: boolean,
): CSS2DObject {
  const element = document.createElement('span')
  element.className = [
    'fft-axis-tick',
    `fft-axis-tick-${axis}`,
    hideInCompact ? 'fft-axis-tick-compact' : '',
  ].filter(Boolean).join(' ')
  element.textContent = tick.label
  const label = new CSS2DObject(element)
  label.position.copy(position)
  label.center.set(0.5, 0.5)
  return label
}

function createAxisScaleGroup(ticks: Fft3DAxisTicks): THREE.Group {
  const group = new THREE.Group()
  group.name = 'fft-coordinate-scales'

  const timeLines: number[] = [
    TIME_AXIS_MIN, 0, AXIS_Z,
    TIME_AXIS_MAX, 0, AXIS_Z,
  ]
  ticks.time.forEach((tick, index) => {
    const x = TIME_AXIS_MIN + tick.unit * (TIME_AXIS_MAX - TIME_AXIS_MIN)
    timeLines.push(x, 0, AXIS_Z - 0.1, x, 0, AXIS_Z + 0.1)
    group.add(createTickLabel(
      tick,
      'time',
      new THREE.Vector3(x, -0.16, AXIS_Z + 0.2),
      index > 0 && index < ticks.time.length - 1 && index % 2 === 1,
    ))
  })
  group.add(createAxisLines(timeLines, AXIS_COLORS.time))

  const frequencyLines: number[] = [
    AXIS_X, 0, FREQUENCY_AXIS_ORIGIN_Z,
    AXIS_X, 0, FREQUENCY_AXIS_FAR_Z,
  ]
  ticks.frequency.forEach((tick, index) => {
    const z = mapFrequencyUnitFromOrigin(
      tick.unit,
      FREQUENCY_AXIS_ORIGIN_Z,
      FREQUENCY_AXIS_FAR_Z,
    )
    frequencyLines.push(AXIS_X - 0.1, 0, z, AXIS_X + 0.1, 0, z)
    group.add(createTickLabel(
      tick,
      'frequency',
      new THREE.Vector3(AXIS_X + 0.23, -0.08, z),
      index > 0 && index < ticks.frequency.length - 1 && index % 2 === 1,
    ))
  })
  group.add(createAxisLines(frequencyLines, AXIS_COLORS.frequency))

  const amplitudeLines: number[] = [
    AXIS_X, 0, AXIS_Z,
    AXIS_X, AMPLITUDE_AXIS_HEIGHT, AXIS_Z,
  ]
  ticks.amplitude.forEach((tick, index) => {
    const y = tick.unit * AMPLITUDE_AXIS_HEIGHT
    amplitudeLines.push(AXIS_X - 0.1, y, AXIS_Z, AXIS_X + 0.1, y, AXIS_Z)
    group.add(createTickLabel(
      tick,
      'amplitude',
      new THREE.Vector3(AXIS_X + 0.3, y, AXIS_Z + 0.08),
      index > 0 && index < ticks.amplitude.length - 1 && index % 2 === 1,
    ))
  })
  group.add(createAxisLines(amplitudeLines, AXIS_COLORS.amplitude))

  return group
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose()
      const material = child.material
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material.dispose()
    }
    if (child instanceof CSS2DObject) child.element.remove()
  })
}

export function Fft3DView({
  result,
  currentTime,
  minDb,
  maxDb,
  frequencyScale,
  mode,
  quality,
  onResetReady,
}: Fft3DViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(hostRef)
  const runtimeRef = useRef<{
    renderer: THREE.WebGLRenderer
    labelRenderer: CSS2DRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    dataObject: THREE.Object3D | null
    axesObject: THREE.Group | null
    cursor: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
    render: () => void
  } | null>(null)
  const [webGlAvailable] = useState(() => WebGL.isWebGL2Available())
  const [contextLost, setContextLost] = useState(false)
  const effectiveFrequencyScale = frequencyScale === 'log' &&
    (result?.frequenciesHz.at(-1) ?? 0) > 20
    ? 'log'
    : 'linear'
  const geometryData = useMemo(
    () => result
      ? buildGeometryData(result, QUALITY_SIZE[quality], minDb, maxDb, effectiveFrequencyScale)
      : null,
    [effectiveFrequencyScale, maxDb, minDb, quality, result],
  )
  const axisTicks = useMemo(
    () => result
      ? buildFft3DAxisTicks(result, minDb, maxDb, effectiveFrequencyScale)
      : null,
    [effectiveFrequencyScale, maxDb, minDb, result],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host || !webGlAvailable) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setClearColor(0x080d14, 1)
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)
    const labelRenderer = new CSS2DRenderer()
    labelRenderer.domElement.className = 'fft-3d-label-layer'
    host.appendChild(labelRenderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x080d14, 8, 22)
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    camera.position.set(7.5, 6.3, 8.5)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.target.set(0, 0.8, 0)
    controls.minDistance = 4
    controls.maxDistance = 24
    controls.maxPolarAngle = Math.PI * 0.49

    scene.add(new THREE.AmbientLight(0x9cc7ff, 1.6))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
    keyLight.position.set(-4, 8, 5)
    scene.add(keyLight)
    const grid = new THREE.GridHelper(10, 10, 0x29465b, 0x172534)
    grid.scale.z = 0.6
    scene.add(grid)

    const cursorGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, -3.1),
      new THREE.Vector3(0, 3, -3.1),
      new THREE.Vector3(0, 3, 3.1),
    ])
    const cursor = new THREE.Line(cursorGeometry, new THREE.LineBasicMaterial({ color: 0xffb35c }))
    scene.add(cursor)

    let animationFrame = 0
    let settleFrames = 0
    const render = () => {
      renderer.render(scene, camera)
      labelRenderer.render(scene, camera)
    }
    const animate = () => {
      if (settleFrames <= 0) return
      settleFrames -= 1
      controls.update()
      render()
      animationFrame = requestAnimationFrame(animate)
    }
    const requestRender = () => {
      settleFrames = 12
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(animate)
    }
    controls.addEventListener('change', requestRender)
    controls.addEventListener('start', requestRender)
    const handleLost = (event: Event) => {
      event.preventDefault()
      setContextLost(true)
    }
    const handleRestored = () => {
      setContextLost(false)
      requestRender()
    }
    renderer.domElement.addEventListener('webglcontextlost', handleLost)
    renderer.domElement.addEventListener('webglcontextrestored', handleRestored)

    const reset = () => {
      camera.position.set(7.5, 6.3, 8.5)
      controls.target.set(0, 0.8, 0)
      controls.update()
      requestRender()
    }
    onResetReady?.(reset)
    runtimeRef.current = {
      renderer,
      labelRenderer,
      scene,
      camera,
      controls,
      dataObject: null,
      axesObject: null,
      cursor,
      render,
    }
    requestRender()

    return () => {
      cancelAnimationFrame(animationFrame)
      controls.removeEventListener('change', requestRender)
      controls.removeEventListener('start', requestRender)
      controls.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', handleLost)
      renderer.domElement.removeEventListener('webglcontextrestored', handleRestored)
      if (runtimeRef.current?.dataObject) disposeObject(runtimeRef.current.dataObject)
      if (runtimeRef.current?.axesObject) disposeObject(runtimeRef.current.axesObject)
      grid.geometry.dispose()
      if (Array.isArray(grid.material)) grid.material.forEach((material) => material.dispose())
      else grid.material.dispose()
      cursor.geometry.dispose()
      cursor.material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      labelRenderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [onResetReady, webGlAvailable])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || size.width <= 0 || size.height <= 0) return
    runtime.renderer.setSize(size.width, size.height, false)
    runtime.labelRenderer.setSize(size.width, size.height)
    runtime.camera.aspect = size.width / size.height
    runtime.camera.updateProjectionMatrix()
    runtime.render()
  }, [size])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    if (runtime.dataObject) {
      runtime.scene.remove(runtime.dataObject)
      disposeObject(runtime.dataObject)
      runtime.dataObject = null
    }
    if (!geometryData) {
      runtime.render()
      return
    }

    let object: THREE.Object3D
    if (mode === 'waterfall') {
      object = createWaterfall(geometryData)
    } else {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(geometryData.positions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(geometryData.colors, 3))
      geometry.setIndex(new THREE.BufferAttribute(geometryData.indices, 1))
      geometry.computeVertexNormals()
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        wireframe: mode === 'wireframe',
        roughness: 0.54,
        metalness: 0.08,
        side: THREE.DoubleSide,
      })
      object = new THREE.Mesh(geometry, material)
    }
    runtime.scene.add(object)
    runtime.dataObject = object
    runtime.render()
  }, [geometryData, mode])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    if (runtime.axesObject) {
      runtime.scene.remove(runtime.axesObject)
      disposeObject(runtime.axesObject)
      runtime.axesObject = null
    }
    if (axisTicks) {
      const axes = createAxisScaleGroup(axisTicks)
      runtime.scene.add(axes)
      runtime.axesObject = axes
    }
    runtime.render()
  }, [axisTicks])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || !result) return
    const firstTime = result.timesSeconds[0] ?? 0
    const lastTime = result.timesSeconds.at(-1) ?? Math.max(1, firstTime)
    const unit = Math.max(0, Math.min(1, (currentTime - firstTime) / Math.max(0.001, lastTime - firstTime)))
    runtime.cursor.position.x = -5 + unit * 10
    runtime.render()
  }, [currentTime, result])

  if (!webGlAvailable) {
    return (
      <div ref={hostRef} className="fft-3d-host fft-3d-fallback">
        <strong>当前环境不支持 WebGL2</strong>
        <span>3D 视图已关闭，二维声谱图仍可使用。</span>
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      className={`fft-3d-host ${size.width < 640 || size.height < 280 ? 'fft-3d-compact' : ''}`}
      aria-label={result
        ? `FFT 三维预览；时间 ${axisTicks?.time[0]?.label ?? ''} 至 ${axisTicks?.time.at(-1)?.label ?? ''}；频率 ${axisTicks?.frequency[0]?.label ?? ''} 至 ${axisTicks?.frequency.at(-1)?.label ?? ''}；幅度 ${minDb} 至 ${maxDb} dBFS`
        : 'FFT 三维预览'}
    >
      {!result && (
        <div className="fft-3d-empty">
          <span className="axis-glyph">3D</span>
          <strong>等待频谱数据</strong>
          <span>完成 FFT 分析后可旋转查看时间、频率与幅度。</span>
        </div>
      )}
      {contextLost && <div className="canvas-alert">WebGL 上下文已丢失，正在等待恢复…</div>}
      {result && (
        <div className="fft-axis-legend" aria-hidden="true">
          <span className="time">时间 · s</span>
          <span className="frequency">频率 · {effectiveFrequencyScale === 'log' ? 'LOG' : 'LINEAR'}</span>
          <span className="amplitude">幅度 · dBFS</span>
        </div>
      )}
    </div>
  )
}
