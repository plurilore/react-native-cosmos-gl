import { describe, it, expect } from 'vitest'
import { ZoomTransform, zoomIdentity } from '../core/zoom-transform'
import { Zoom } from '../core/zoom'
import { Store } from '../core/store'
import { createDefaultConfig } from '../core/variables'

describe('ZoomTransform', () => {
  it('applies and inverts', () => {
    const t = new ZoomTransform(2, 30, -10)
    expect(t.apply([5, 5])).toEqual([40, 0])
    expect(t.invert([40, 0])).toEqual([5, 5])
  })

  it('keeps the focal point fixed when scaling about it', () => {
    // This is the whole contract of pinch-to-zoom: whatever is under the
    // fingers must stay under the fingers.
    const t = new ZoomTransform(1, 0, 0)
    const scaled = t.scaleAbout(3, 200, 150)
    expect(scaled.k).toBe(3)
    const [x, y] = scaled.apply(t.invert([200, 150]))
    expect(x).toBeCloseTo(200, 6)
    expect(y).toBeCloseTo(150, 6)
  })

  it('composes repeated scaling about the same point without drift', () => {
    let t = zoomIdentity
    for (let i = 0; i < 20; i++) t = t.scaleAbout(1.1, 100, 100)
    const [x, y] = t.apply(zoomIdentity.invert([100, 100]))
    expect(x).toBeCloseTo(100, 4)
    expect(y).toBeCloseTo(100, 4)
    expect(t.k).toBeCloseTo(Math.pow(1.1, 20), 6)
  })

  it('translates in its own scaled space', () => {
    const t = new ZoomTransform(2, 0, 0).translate(10, 5)
    expect([t.x, t.y]).toEqual([20, 10])
  })
})

describe('Zoom', () => {
  function makeZoom (width = 800, height = 600): Zoom {
    const store = new Store()
    const config = createDefaultConfig()
    store.adjustSpaceSize(4096, 8192)
    store.updateScreenSize(width, height)
    return new Zoom(store, config)
  }

  it('fits a set of points into the viewport', () => {
    const zoom = makeZoom()
    const positions = new Float32Array([1000, 1000, 3000, 3000])
    const transform = zoom.getTransform(positions, undefined, 0.1)
    expect(Number.isFinite(transform.k)).toBe(true)
    expect(transform.k).toBeGreaterThan(0)
  })

  it('keeps the current view when every position is absent', () => {
    // Fitting to NaN would produce a NaN transform, which blanks the screen.
    const zoom = makeZoom()
    zoom.setTransform(new ZoomTransform(3, 10, 20))
    const transform = zoom.getTransform(new Float32Array([NaN, NaN, NaN, NaN]))
    expect(transform.k).toBe(3)
    expect(transform.x).toBe(10)
  })

  it('produces a finite scale for a single point', () => {
    // A single point has zero extent on both axes; without widening it, the
    // fitted scale is a division by zero.
    const zoom = makeZoom()
    const transform = zoom.getTransform(new Float32Array([2048, 2048]))
    expect(Number.isFinite(transform.k)).toBe(true)
  })

  it('clamps the scale to the allowed extent', () => {
    const zoom = makeZoom()
    zoom.setTransform(new ZoomTransform(1e9, 0, 0))
    expect(zoom.eventTransform.k).toBeLessThanOrEqual(zoom.scaleExtent[1])
    zoom.setTransform(new ZoomTransform(1e-9, 0, 0))
    expect(zoom.eventTransform.k).toBeGreaterThanOrEqual(zoom.scaleExtent[0])
  })

  it('round-trips screen and space coordinates', () => {
    const zoom = makeZoom()
    zoom.setTransform(new ZoomTransform(2.5, -120, 60))
    const screen: [number, number] = [400, 300]
    const space = zoom.convertScreenToSpacePosition(screen)
    const back = zoom.convertSpaceToScreenPosition(space)
    expect(back[0]).toBeCloseTo(screen[0], 4)
    expect(back[1]).toBeCloseTo(screen[1], 4)
  })

  it('animates to a target and reports completion', () => {
    const zoom = makeZoom()
    const target = new ZoomTransform(4, 100, 50)
    // Drive `animateTo` and `step` from one clock so the pacing is exact.
    const now = 1000
    zoom.animateTo(target, 200, undefined, now)
    expect(zoom.isAnimating).toBe(true)

    expect(zoom.step(now + 100)).toBe(true)
    expect(zoom.eventTransform.k).toBeGreaterThan(1)
    expect(zoom.eventTransform.k).toBeLessThan(4)

    expect(zoom.step(now + 200)).toBe(false)
    expect(zoom.eventTransform.k).toBeCloseTo(4, 4)
    expect(zoom.isAnimating).toBe(false)
  })
})
