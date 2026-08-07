import { describe, expect, it } from 'vitest'

import {
  calculateConstrainedDragGhostPosition,
  nodeOrdersEqual,
  reorderNodeIds,
} from './filterNodeDrag'

describe('filter node drag ordering', () => {
  it('inserts the dragged node at the requested preview position', () => {
    const order = ['a', 'b', 'c', 'd']

    expect(reorderNodeIds(order, 'b', 0)).toEqual(['b', 'a', 'c', 'd'])
    expect(reorderNodeIds(order, 'b', 2)).toEqual(['a', 'c', 'b', 'd'])
    expect(reorderNodeIds(order, 'b', 3)).toEqual(['a', 'c', 'd', 'b'])
    expect(order).toEqual(['a', 'b', 'c', 'd'])
  })

  it('clamps endpoints and leaves missing nodes unchanged', () => {
    expect(reorderNodeIds(['a', 'b', 'c'], 'b', -5)).toEqual(['b', 'a', 'c'])
    expect(reorderNodeIds(['a', 'b', 'c'], 'b', 99)).toEqual(['a', 'c', 'b'])
    expect(reorderNodeIds(['a', 'b', 'c'], 'missing', 0)).toEqual(['a', 'b', 'c'])
  })

  it('compares node order without treating new arrays as changes', () => {
    expect(nodeOrdersEqual(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(nodeOrdersEqual(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(nodeOrdersEqual(['a'], ['a', 'b'])).toBe(false)
  })

  it('keeps the floating drag preview inside the scrolled canvas viewport', () => {
    const viewport = { width: 500, height: 260, scrollLeft: 120, scrollTop: 0 }
    const ghost = { width: 94, height: 96 }

    expect(calculateConstrainedDragGhostPosition(
      { x: 250, y: 130 },
      viewport,
      ghost,
    )).toEqual({ x: 323, y: 82 })
    expect(calculateConstrainedDragGhostPosition(
      { x: -100, y: -100 },
      viewport,
      ghost,
    )).toEqual({ x: 120, y: 0 })
    expect(calculateConstrainedDragGhostPosition(
      { x: 900, y: 900 },
      viewport,
      ghost,
    )).toEqual({ x: 526, y: 164 })
  })
})
