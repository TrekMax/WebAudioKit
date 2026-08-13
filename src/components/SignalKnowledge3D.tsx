import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import type {
  DftTeachingModel,
  PhasorTeachingModel,
} from '../domain/signal-knowledge/models'

export type SignalKnowledgeDemoKind = 'phasor' | 'dft'

export interface SignalKnowledge3DProps {
  readonly demo: SignalKnowledgeDemoKind
  readonly phasorModel: PhasorTeachingModel
  readonly dftModel: DftTeachingModel
  readonly phaseRadians: number
  readonly revealCount: number
}

type RuntimeStatus = 'starting' | 'ready' | 'unavailable' | 'context-lost'

interface PhasorObjects {
  readonly helix: THREE.Line
  readonly projection: THREE.Line
  readonly vector: THREE.Line
  readonly point: THREE.Mesh
}

interface DftObjects {
  readonly path: THREE.Line
  readonly point: THREE.Mesh
  readonly positions: Float32Array
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
  const helixPositions = new Float32Array(model.points.length * 3)
  const projectionPositions = new Float32Array(model.points.length * 3)
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
  runtime.phasor.helix.geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(helixPositions, 3),
  )
  runtime.phasor.projection.geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(projectionPositions, 3),
  )

  const currentAngle = phaseRadians
  const real = Math.cos(currentAngle) * 1.15
  const imaginary = Math.sin(currentAngle) * 1.15
  runtime.phasor.vector.geometry.setFromPoints([
    new THREE.Vector3(-2.3, 0, 0),
    new THREE.Vector3(-2.3, real, imaginary),
  ])
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
  const point = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  runtime.content.add(helix, projection, vector, point)
  runtime.phasor = { helix, projection, vector, point }
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

function buildScene(
  runtime: SceneRuntime,
  props: SignalKnowledge3DProps,
): void {
  clearContent(runtime)
  if (props.demo === 'phasor') {
    buildPhasorScene(runtime, props.phasorModel, props.phaseRadians)
  } else {
    buildDftScene(runtime, props.dftModel, props.revealCount)
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
  }, [props.demo, props.dftModel, props.phasorModel])

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

  return (
    <div className="signal-knowledge-3d-shell">
      <div className="signal-knowledge-3d-canvas" ref={containerRef} />
      {status === 'starting' && <div className="signal-knowledge-3d-state"><span className="spinner" /> 正在创建 WebGL2 场景…</div>}
      {status === 'unavailable' && <div className="signal-knowledge-3d-state warning"><strong>当前环境不支持 WebGL2</strong><span>右侧二维投影与参数读数仍可完整使用。</span></div>}
      {status === 'context-lost' && <div className="signal-knowledge-3d-state warning"><strong>WebGL 上下文已丢失</strong><span>动画已暂停，恢复后会从教学模型重建。</span></div>}
      {status === 'ready' && (
        <div className="signal-knowledge-3d-axis" aria-hidden="true">
          <span><i className="x" /> X · {props.demo === 'phasor' ? '时间' : '样本 n'}</span>
          <span><i className="y" /> Y · 实部</span>
          <span><i className="z" /> Z · 虚部</span>
        </div>
      )}
    </div>
  )
}
