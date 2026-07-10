import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import WebGL from 'three/addons/capabilities/WebGL.js'
import type { StftPreviewResult } from '../audio/analysis'
import { useElementSize } from '../hooks/useElementSize'
import { normalizeDb, spectrumColor } from '../visualization/colorMap'

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
      const z = -3 + (column / (columns - 1)) * 6
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
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    dataObject: THREE.Object3D | null
    cursor: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>
    render: () => void
  } | null>(null)
  const [webGlAvailable] = useState(() => WebGL.isWebGL2Available())
  const [contextLost, setContextLost] = useState(false)
  const geometryData = useMemo(
    () => result
      ? buildGeometryData(result, QUALITY_SIZE[quality], minDb, maxDb, frequencyScale)
      : null,
    [frequencyScale, maxDb, minDb, quality, result],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host || !webGlAvailable) return

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setClearColor(0x080d14, 1)
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)

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
    const render = () => renderer.render(scene, camera)
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
    runtimeRef.current = { renderer, scene, camera, controls, dataObject: null, cursor, render }
    requestRender()

    return () => {
      cancelAnimationFrame(animationFrame)
      controls.removeEventListener('change', requestRender)
      controls.removeEventListener('start', requestRender)
      controls.dispose()
      renderer.domElement.removeEventListener('webglcontextlost', handleLost)
      renderer.domElement.removeEventListener('webglcontextrestored', handleRestored)
      runtimeRef.current?.dataObject?.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose()
          const material = object.material
          if (Array.isArray(material)) material.forEach((item) => item.dispose())
          else material.dispose()
        }
      })
      cursor.geometry.dispose()
      cursor.material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      runtimeRef.current = null
    }
  }, [onResetReady, webGlAvailable])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime || size.width <= 0 || size.height <= 0) return
    runtime.renderer.setSize(size.width, size.height, false)
    runtime.camera.aspect = size.width / size.height
    runtime.camera.updateProjectionMatrix()
    runtime.render()
  }, [size])

  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    if (runtime.dataObject) {
      runtime.scene.remove(runtime.dataObject)
      runtime.dataObject.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose()
          const material = object.material
          if (Array.isArray(material)) material.forEach((item) => item.dispose())
          else material.dispose()
        }
      })
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
    <div ref={hostRef} className="fft-3d-host" aria-label="FFT 三维预览">
      {!result && (
        <div className="fft-3d-empty">
          <span className="axis-glyph">3D</span>
          <strong>等待频谱数据</strong>
          <span>完成 FFT 分析后可旋转查看时间、频率与幅度。</span>
        </div>
      )}
      {contextLost && <div className="canvas-alert">WebGL 上下文已丢失，正在等待恢复…</div>}
      <div className="axis-label axis-label-y">幅度 / dBFS</div>
      <div className="axis-label axis-label-x">时间</div>
      <div className="axis-label axis-label-z">频率 · {frequencyScale === 'log' ? 'LOG' : 'LINEAR'}</div>
    </div>
  )
}
