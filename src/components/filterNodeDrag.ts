export function reorderNodeIds(
  order: readonly string[],
  draggedId: string,
  insertionIndex: number,
): string[] {
  const currentIndex = order.indexOf(draggedId)
  if (currentIndex < 0) {
    return [...order]
  }

  const remaining = order.filter((id) => id !== draggedId)
  const targetIndex = Math.min(remaining.length, Math.max(0, Math.trunc(insertionIndex)))
  remaining.splice(targetIndex, 0, draggedId)
  return remaining
}

export function nodeOrdersEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

export interface DragGhostPoint {
  readonly x: number
  readonly y: number
}

export interface DragGhostViewport {
  readonly width: number
  readonly height: number
  readonly scrollLeft: number
  readonly scrollTop: number
}

export interface DragGhostSize {
  readonly width: number
  readonly height: number
}

export function calculateConstrainedDragGhostPosition(
  pointer: DragGhostPoint,
  viewport: DragGhostViewport,
  ghost: DragGhostSize,
): DragGhostPoint {
  const halfWidth = ghost.width / 2
  const halfHeight = ghost.height / 2
  const maximumCenterX = Math.max(halfWidth, viewport.width - halfWidth)
  const maximumCenterY = Math.max(halfHeight, viewport.height - halfHeight)
  const centerX = Math.min(maximumCenterX, Math.max(halfWidth, pointer.x))
  const centerY = Math.min(maximumCenterY, Math.max(halfHeight, pointer.y))
  return {
    x: viewport.scrollLeft + centerX - halfWidth,
    y: viewport.scrollTop + centerY - halfHeight,
  }
}
