export interface FloatingInspectorAnchor {
  readonly left: number
  readonly right: number
  readonly top: number
}

export interface FloatingInspectorBounds {
  readonly width: number
  readonly height: number
}

export interface FloatingInspectorSize {
  readonly width: number
  readonly height: number
}

export interface FloatingInspectorPosition {
  readonly left: number
  readonly top: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function calculateFloatingInspectorPosition(
  anchor: FloatingInspectorAnchor,
  bounds: FloatingInspectorBounds,
  panel: FloatingInspectorSize,
  gap = 12,
  minimumTop = 66,
): FloatingInspectorPosition {
  const maximumLeft = Math.max(gap, bounds.width - panel.width - gap)
  let left = anchor.right + gap
  if (left + panel.width > bounds.width - gap) {
    left = anchor.left - panel.width - gap
  }
  const maximumTop = Math.max(minimumTop, bounds.height - panel.height - gap)
  return {
    left: clamp(left, gap, maximumLeft),
    top: clamp(anchor.top, minimumTop, maximumTop),
  }
}
