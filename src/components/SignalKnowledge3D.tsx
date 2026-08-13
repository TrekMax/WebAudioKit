import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import type {
  DftTeachingModel,
  PhasorTeachingModel,
} from '../domain/signal-knowledge/models'
import type { TeachingStftModel } from '../domain/signal-knowledge/transforms'

export type SignalKnowledgeDemoKind = 'phasor' | 'dft' | 'stft'

export interface SignalKnowledge3DProps {
  readonly demo: SignalKnowledgeDemoKind
  readonly phasorModel: PhasorTeachingModel
  readonly dftModel: DftTeachingModel
  readonly stftModel: TeachingStftModel
  readonly phaseRadians: number
  readonly revealCount: number
  readonly stftFrameIndex: number
  readonly onContextLost?: () => void
}

type RuntimeStatus = 'starting' | 'ready' | 'unavailable' | 'context-lost'

interface PhasorObjects {
  readonly helix: THREE.Line
  readonly projection: THREE.Line
  readonly vector: THREE.Line
  readonly point: THREE.Mesh
  readonly helixPositions: Float32Array
  readonly projectionPositions: Float32Array
  readonly vectorPositions: Float32Array
}

interface DftObjects {
  readonly path: THREE.Line
  readonly point: THREE.Mesh
  readonly positions: Float32Array
}

interface StftObjects {
  readonly slice: THREE.Line
  readonly slicePositions: Float32Array
  readonly model: TeachingStftModel
  readonly magnitudeScale: number
}

interface SceneRuntime {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly content: THREE.Group
  readonly requestRender: () => void
  phasor: PhasorObjects | null
  dft: DftObjects | null
  stft: StftObjects | null
}

function createLine(
  color: THREE.ColorRepresentation,
  opacity = 1,
): THREE.Line {
  const geometry = new THREE.BufferGeometry()
  const material = new THREE.LineBasicMaterial({
    color,
    opacity,
    transparent: opacity < 1,
  })
  return new THREE.Line(geometry, material)
}

function createAxisLine(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  color: THREE.ColorRepresentation,
): THREE.Line {
  const line = createLine(color, 0.58)
  line.geometry.setFromPoints([
    new THREE.Vector3(...from),
    new THREE.Vector3(...to),
  ])
  return line
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      child.geometry.dispose()
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]
      for (const material of materials) material.dispose()
    }
  })
}

function clearContent(runtime: SceneRuntime): void {
  disposeObject(runtime.content)
  runtime.content.clear()
  runtime.phasor = null
  runtime.dft = null
  runtime.stft = null
}

function addCoordinateFrame(content: THREE.Group): void {
  content.add(
    createAxisLine([-2.55, 0, 0], [2.55, 0, 0], 0x58748a),
    createAxisLine([0, -1.65, 0], [0, 1.65, 0], 0x4f6c80),
    createAxisLine([0, 0, -1.65], [0, 0, 1.65], 0x4f6c80),
  )
  const grid = new THREE.GridHelper(5, 10, 0x284359, 0x172b3b)
  grid.material.opacity = 0.48
  grid.material.transparent = true
  content.add(grid)
}

function updatePhasorObjects(
  runtime: SceneRuntime,
  model: PhasorTeachingModel,
  phaseRadians: number,
): void {
  if (!runtime.phasor) return
  const { helixPositions, projectionPositions, vectorPositions } = runtime.phasor
  for (let index = 0; index < model.points.length; index += 1) {
    const point = model.points[index]
    if (!point) continue
    const angle = 2 * Math.PI * model.cycles * point.progress + phaseRadians
    const x = -2.3 + point.progress * 4.6
    const real = Math.cos(angle) * 1.15
    const imaginary = Math.sin(angle) * 1.15
    const offset = index * 3
    helixPositions[offset] = x
    helixPositions[offset + 1] = real
    helixPositions[offset + 2] = imaginary
    projectionPositions[offset] = x
    projectionPositions[offset + 1] = real
    projectionPositions[offset + 2] = 0
  }
  runtime.phasor.helix.geometry.getAttribute('position').needsUpdate = true
  runtime.phasor.projection.geometry.getAttribute('position').needsUpdate = true

  const currentAngle = phaseRadians
  const real = Math.cos(currentAngle) * 1.15
  const imaginary = Math.sin(currentAngle) * 1.15
  vectorPositions[0] = -2.3
  vectorPositions[1] = 0
  vectorPositions[2] = 0
  vectorPositions[3] = -2.3
  vectorPositions[4] = real
  vectorPositions[5] = imaginary
  runtime.phasor.vector.geometry.getAttribute('position').needsUpdate = true
  runtime.phasor.point.position.set(-2.3, real, imaginary)
  runtime.requestRender()
}

function buildPhasorScene(
  runtime: SceneRuntime,
  model: PhasorTeachingModel,
  phaseRadians: number,
): void {
  addCoordinateFrame(runtime.content)
  const helix = createLine(0x1fdfb2)
  const projection = createLine(0x64a9ff, 0.82)
  const vector = createLine(0xffb35c)
  const helixPositions = new Float32Array(model.points.length * 3)
  const projectionPositions = new Float32Array(model.points.length * 3)
  const vectorPositions = new Float32Array(6)
  helix.geometry.setAttribute('position', new THREE.BufferAttribute(helixPositions, 3))
  projection.geometry.setAttribute('position', new THREE.BufferAttribute(projectionPositions, 3))
  vector.geometry.setAttribute('position', new THREE.BufferAttribute(vectorPositions, 3))
  const point = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  runtime.content.add(helix, projection, vector, point)
  runtime.phasor = {
    helix,
    projection,
    vector,
    point,
    helixPositions,
    projectionPositions,
    vectorPositions,
  }
  updatePhasorObjects(runtime, model, phaseRadians)
}

function buildDftScene(
  runtime: SceneRuntime,
  model: DftTeachingModel,
  revealCount: number,
): void {
  addCoordinateFrame(runtime.content)
  const maxSum = Math.max(
    1,
    ...model.contributions.map(({ partialSum }) => (
      Math.hypot(partialSum.real, partialSum.imaginary)
    )),
  )
  const sumScale = 1.35 / maxSum
  const positions = new Float32Array((model.contributions.length + 1) * 3)
  positions[0] = -2.3
  for (let index = 0; index < model.contributions.length; index += 1) {
    const contribution = model.contributions[index]
    if (!contribution) continue
    const offset = (index + 1) * 3
    positions[offset] = -2.3 + ((index + 1) / model.sampleCount) * 4.6
    positions[offset + 1] = contribution.partialSum.real * sumScale
    positions[offset + 2] = contribution.partialSum.imaginary * sumScale
  }
  const path = createLine(0x1fdfb2)
  path.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const point = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffb35c }),
  )

  const samplePositions = new Float32Array(model.sampleCount * 6)
  for (let index = 0; index < model.sampleCount; index += 1) {
    const x = -2.3 + ((index + 0.5) / model.sampleCount) * 4.6
    const sample = model.samples[index] ?? 0
    const offset = index * 6
    samplePositions[offset] = x
    samplePositions[offset + 1] = 0
    samplePositions[offset + 2] = 0
    samplePositions[offset + 3] = x
    samplePositions[offset + 4] = sample * 0.72
    samplePositions[offset + 5] = 0
  }
  const stems = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(samplePositions, 3),
    ),
    new THREE.LineBasicMaterial({ color: 0x64a9ff, opacity: 0.34, transparent: true }),
  )
  runtime.content.add(stems, path, point)
  runtime.dft = { path, point, positions }
  updateDftReveal(runtime, revealCount)
}

function updateDftReveal(runtime: SceneRuntime, revealCount: number): void {
  if (!runtime.dft) return
  const positionAttribute = runtime.dft.path.geometry.getAttribute('position')
  const pointCount = positionAttribute.count
  const visiblePointCount = Math.max(1, Math.min(pointCount, revealCount + 1))
  runtime.dft.path.geometry.setDrawRange(0, visiblePointCount)
  const offset = (visiblePointCount - 1) * 3
  runtime.dft.point.position.set(
    runtime.dft.positions[offset] ?? 0,
    runtime.dft.positions[offset + 1] ?? 0,
    runtime.dft.positions[offset + 2] ?? 0,
  )
  runtime.requestRender()
}

function updateStftSlice(runtime: SceneRuntime, frameIndex: number): void {
  const objects = runtime.stft
  if (!objects || objects.model.frameCount === 0) return
  const frame = Math.max(0, Math.min(objects.model.frameCount - 1, frameIndex))
  const x = objects.model.frameCount === 1
    ? 0
    : -2.25 + (frame / (objects.model.frameCount - 1)) * 4.5
  for (let bin = 0; bin < objects.model.binCount; bin += 1) {
    const offset = bin * 3
    const magnitude = objects.model.magnitudes[
      frame * objects.model.binCount + bin
    ] ?? 0
    objects.slicePositions[offset] = x
    objects.slicePositions[offset + 1] = magnitude * objects.magnitudeScale + 0.025
    objects.slicePositions[offset + 2] = objects.model.binCount === 1
      ? 0
      : -1.5 + (bin / (objects.model.binCount - 1)) * 3
  }
  objects.slice.geometry.getAttribute('position').needsUpdate = true
  runtime.requestRender()
}

function buildStftScene(
  runtime: SceneRuntime,
  model: TeachingStftModel,
  frameIndex: number,
): void {
  addCoordinateFrame(runtime.content)
  const vertexCount = model.frameCount * model.binCount
  const positions = new Float32Array(vertexCount * 3)
  const colors = new Float32Array(vertexCount * 3)
  const magnitudeScale = model.maxMagnitude > 0 ? 1.55 / model.maxMagnitude : 0
  const color = new THREE.Color()
  for (let frame = 0; frame < model.frameCount; frame += 1) {
    for (let bin = 0; bin < model.binCount; bin += 1) {
      const vertex = frame * model.binCount + bin
      const offset = vertex * 3
      const magnitude = model.magnitudes[vertex] ?? 0
      const normalized = model.maxMagnitude > 0 ? magnitude / model.maxMagnitude : 0
      positions[offset] = model.frameCount === 1
        ? 0
        : -2.25 + (frame / (model.frameCount - 1)) * 4.5
      positions[offset + 1] = magnitude * magnitudeScale
      positions[offset + 2] = model.binCount === 1
        ? 0
        : -1.5 + (bin / (model.binCount - 1)) * 3
      color.setHSL(0.56 - normalized * 0.12, 0.78, 0.34 + normalized * 0.32)
      colors[offset] = color.r
      colors[offset + 1] = color.g
      colors[offset + 2] = color.b
    }
  }
  const indices: number[] = []
  for (let frame = 0; frame < model.frameCount - 1; frame += 1) {
    for (let bin = 0; bin < model.binCount - 1; bin += 1) {
      const current = frame * model.binCount + bin
      const nextFrame = current + model.binCount
      indices.push(
        current,
        nextFrame,
        current + 1,
        current + 1,
        nextFrame,
        nextFrame + 1,
      )
    }
  }
  const surfaceGeometry = new THREE.BufferGeometry()
  surfaceGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  surfaceGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  surfaceGeometry.setIndex(indices)
  const surface = new THREE.Mesh(
    surfaceGeometry,
    new THREE.MeshBasicMaterial({
      opacity: 0.76,
      side: THREE.DoubleSide,
      transparent: true,
      vertexColors: true,
    }),
  )

  const wireframe = new THREE.LineSegments(
    new THREE.WireframeGeometry(surfaceGeometry),
    new THREE.LineBasicMaterial({
      color: 0x8ecbff,
      opacity: 0.2,
      transparent: true,
    }),
  )
  const slicePositions = new Float32Array(model.binCount * 3)
  const slice = createLine(0xffb35c)
  slice.geometry.setAttribute('position', new THREE.BufferAttribute(slicePositions, 3))
  runtime.content.add(surface, wireframe, slice)
  runtime.stft = { slice, slicePositions, model, magnitudeScale }
  updateStftSlice(runtime, frameIndex)
}

function buildScene(
  runtime: SceneRuntime,
  props: SignalKnowledge3DProps,
): void {
  clearContent(runtime)
  if (props.demo === 'phasor') {
    buildPhasorScene(runtime, props.phasorModel, props.phaseRadians)
  } else if (props.demo === 'dft') {
    buildDftScene(runtime, props.dftModel, props.revealCount)
  } else {
    buildStftScene(runtime, props.stftModel, props.stftFrameIndex)
  }
  runtime.requestRender()
}

export function SignalKnowledge3D(props: SignalKnowledge3DProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const runtimeRef = useRef<SceneRuntime | null>(null)
  const propsRef = useRef(props)
  const [status, setStatus] = useState<RuntimeStatus>('starting')

  useEffect(() => {
    propsRef.current = props
  }, [props])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-label', '信号处理三维教学场景，可拖动旋转并滚轮缩放')
    const context = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    })
    if (!context) {
      const statusTimer = window.setTimeout(() => setStatus('unavailable'), 0)
      return () => window.clearTimeout(statusTimer)
    }

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        context,
        antialias: true,
      })
    } catch {
      const statusTimer = window.setTimeout(() => setStatus('unavailable'), 0)
      return () => window.clearTimeout(statusTimer)
    }
    renderer.setClearColor(0x070c12, 1)
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    container.append(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x070c12, 0.055)
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    camera.position.set(5.1, 3.2, 5.2)
    camera.lookAt(0, 0, 0)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = false
    controls.enablePan = false
    controls.minDistance = 3.5
    controls.maxDistance = 10

    const content = new THREE.Group()
    scene.add(content)
    let renderFrame: number | null = null
    const requestRender = () => {
      if (renderFrame !== null) return
      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null
        renderer.render(scene, camera)
      })
    }
    const runtime: SceneRuntime = {
      renderer,
      scene,
      camera,
      controls,
      content,
      requestRender,
      phasor: null,
      dft: null,
      stft: null,
    }
    runtimeRef.current = runtime

    const resize = () => {
      const width = Math.max(1, container.clientWidth)
      const height = Math.max(1, container.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      requestRender()
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)
    controls.addEventListener('change', requestRender)

    const handleContextLost = (event: Event) => {
      event.preventDefault()
      if (renderFrame !== null) {
        window.cancelAnimationFrame(renderFrame)
        renderFrame = null
      }
      setStatus('context-lost')
      propsRef.current.onContextLost?.()
    }
    const handleContextRestored = () => {
      setStatus('ready')
      buildScene(runtime, propsRef.current)
    }
    canvas.addEventListener('webglcontextlost', handleContextLost)
    canvas.addEventListener('webglcontextrestored', handleContextRestored)

    buildScene(runtime, propsRef.current)
    resize()
    const statusTimer = window.setTimeout(() => setStatus('ready'), 0)

    return () => {
      window.clearTimeout(statusTimer)
      resizeObserver.disconnect()
      controls.removeEventListener('change', requestRender)
      controls.dispose()
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      if (renderFrame !== null) window.cancelAnimationFrame(renderFrame)
      clearContent(runtime)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (runtime) buildScene(runtime, propsRef.current)
  }, [props.demo, props.dftModel, props.phasorModel, props.stftModel])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (props.demo === 'phasor' && runtime) {
      updatePhasorObjects(runtime, props.phasorModel, props.phaseRadians)
    }
  }, [props.demo, props.phaseRadians, props.phasorModel])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (props.demo === 'dft' && runtime) updateDftReveal(runtime, props.revealCount)
  }, [props.demo, props.revealCount])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (props.demo === 'stft' && runtime) {
      updateStftSlice(runtime, props.stftFrameIndex)
    }
  }, [props.demo, props.stftFrameIndex])

  return (
    <div className="signal-knowledge-3d-shell">
      <div className="signal-knowledge-3d-canvas" ref={containerRef} />
      {status === 'starting' && <div className="signal-knowledge-3d-state"><span className="spinner" /> 正在创建 WebGL2 场景…</div>}
      {status === 'unavailable' && <div className="signal-knowledge-3d-state warning"><strong>当前环境不支持 WebGL2</strong><span>旁侧二维投影与参数读数仍可完整使用。</span></div>}
      {status === 'context-lost' && <div className="signal-knowledge-3d-state warning"><strong>WebGL 上下文已丢失</strong><span>动画已暂停，恢复后会从教学模型重建。</span></div>}
      {status === 'ready' && (
        <div className="signal-knowledge-3d-axis" aria-hidden="true">
          <span><i className="x" /> X · {props.demo === 'phasor' ? '时间' : props.demo === 'dft' ? '样本 n' : '帧 / 时间'}</span>
          <span><i className="y" /> Y · {props.demo === 'stft' ? '幅度' : '实部'}</span>
          <span><i className="z" /> Z · {props.demo === 'stft' ? '频率 bin' : '虚部'}</span>
        </div>
      )}
    </div>
  )
}
