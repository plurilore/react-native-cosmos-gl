# react-native-cosmos-gl

**GPU-accelerated force graph for React Native.** A port of
[cosmos.gl](https://github.com/cosmosgl/graph) — the engine behind
[Cosmograph](https://cosmograph.app) — to iOS, Android and the web.

The force simulation and the rendering both run in GLSL. Point positions live in
floating-point textures and are never read back into JavaScript to be drawn, so
the cost of a frame is set by the GPU rather than by the bridge. Graphs of
hundreds of thousands of points stay interactive on a phone.

```bash
npm install react-native-cosmos-gl
npx expo install expo-gl
# Optional, for the Skia label renderer:
npx expo install @shopify/react-native-skia react-native-reanimated
```

Requires React 19, React Native 0.86, Expo SDK 57 and Node 20 or newer. This is
a new package with no installed base to carry, so the floors are what the code
needs rather than the oldest thing that might work.

> **Pre-release.** The engine is covered by 215 tests against a mock WebGL2
> context that parses each shader's real declarations, plus a shader gate that
> compiles all 38 through the Khronos reference compiler. It now runs on
> physical Android hardware; **iOS has not been exercised**, so Metal-backed
> shader compilation and the Skia label path there are unverified. Treat `0.x`
> accordingly.
>
> **Check your device first.** `probeDevice(gl)` reports whether a device can
> run the engine and why not, before you write anything against it:
>
> ```tsx
> import { GLView } from 'expo-gl'
> import { probeDevice, formatDeviceReport } from 'react-native-cosmos-gl'
>
> <GLView
>   style={{ width: 1, height: 1 }}
>   onContextCreate={(gl) => console.log(formatDeviceReport(probeDevice(gl)))}
> />
> ```
>
> The example app's **Device** tab does this with a shareable report — useful
> for issues.

## Quick start

```tsx
import { CosmosGraph } from 'react-native-cosmos-gl'

// Points: [x0, y0, x1, y1, …]. This array sets the index space
// every other per-point array aligns to.
const pointPositions = new Float32Array([
  0, 0,
  100, 0,
  50, 100,
])

// Links: [source, target, …] as point indices.
const links = new Float32Array([
  0, 1,
  1, 2,
  2, 0,
])

export default function App() {
  return (
    <CosmosGraph
      style={{ flex: 1 }}
      pointPositions={pointPositions}
      links={links}
      simulationRepulsion={1.2}
      simulationGravity={0.15}
      curvedLinks
      enableDrag
      onPointClick={(index) => console.log('tapped', index)}
    />
  )
}
```

Pan, pinch-to-zoom, tap, long-press and point dragging work out of the box — no
gesture library required.

## Data model

The engine ingests **flat typed arrays**, not objects. This is the single most
important thing to know about the API: it is what lets data reach the GPU
without a per-element transformation on every update.

| Setter | Layout | Notes |
| --- | --- | --- |
| `pointPositions` | `[x, y, …]` | Point count is `length / 2`. Establishes the index space. |
| `links` | `[source, target, …]` | Point **indices**, not ids. |
| `pointColors` | `[r, g, b, a, …]` | Normalized `0..1`, not `0..255`. |
| `pointSizes` | `[size, …]` | One per point. |
| `pointShapes` | `[shape, …]` | `PointShape` enum values. |
| `linkColors` / `linkWidths` | parallel to `links` | |

Two conventions carry real meaning:

- **`NaN` in a color or size channel means "use the configured default"**, and is
  resolved on the GPU at read time. Your arrays are never mutated.
- **`NaN` in a position means the point is absent.** It is excluded from
  physics, drawing and hit-testing, and fades out rather than vanishing. This is
  how you remove a point without renumbering every index after it.

## Two ways to give it data

Typed arrays are the fast path. But data usually arrives as records, so the same
component also accepts those plus column mappings, and derives every array
itself:

```tsx
<CosmosGraph
  style={{ flex: 1 }}
  pointData={people}          // [{ id, name, team, commits }, …]
  linkData={reviews}          // [{ from, to, weight }, …]
  pointIdBy="id"
  linkSourceBy="from"
  linkTargetBy="to"
  pointColorBy="team"         // categorical, inferred from the column's type
  pointSizeBy="commits"       // continuous, clamped to the 5th–95th percentile
  pointLabelBy="name"
  selectPointOnClick
>
  <CosmosSearch />
  <CosmosLegend title="Team" />
  <CosmosLabels limit={40} />
  <CosmosHistogram column="commits" />
</CosmosGraph>
```

Pass both forms and the explicit typed array wins, so you can let the mapping
handle most channels and hand-supply one it doesn't cover.

`resolveGraphData()` is the pure function behind this — records in, typed arrays
out, no React and no GPU — if you'd rather drive `Graph` yourself.

### Encoding strategies

`pointColorStrategy` is inferred from the column's type and can be set
explicitly: `categorical`, `continuous`, `diverging`, `degree` (colour by link
count), `direct` (the column already holds colours), or `map` (an explicit
lookup). Sizes take `continuous`, `degree` or `direct`.

Two defaults worth knowing, because both change what you see:

- **Continuous scales clamp to the 5th–95th percentile**, not the raw extent.
  One outlier three orders of magnitude out would otherwise compress every other
  value into the first step of the ramp.
- **Sizes scale by area, not radius.** A point drawn twice as wide covers four
  times the screen, so mapping magnitude to radius overstates large values
  fourfold.

### A limit on categorical colour

The default palette is validated for *all-pairs* comparison, which is the honest
test for a graph: every category is on screen at once and any two can end up
adjacent. Under that test **only three categories stay reliably distinguishable
by colour alone** — at eight, magenta against aqua is ΔE 1.6 for a deuteranope,
and red against orange is ΔE 7.1 even with full colour vision.

This is a property of colour perception, not of this palette: no ordering of
eight hues passes all-pairs.

So past three categories, pair colour with **shape**, which a node-link graph
can carry and a bar chart cannot:

```tsx
pointColorBy="team"
pointShapeBy="team"   // same column — the two channels reinforce each other
```

`CosmosLegend` says so on screen when an encoding crosses that line.

## Overlays

Rendered as children of the graph, which passes itself down by context:

| Component | What it does |
| --- | --- |
| `<CosmosLabels />` | Text that follows its points. Positions come from the engine's tracking pipeline, so cost scales with the label count, not the graph size. |
| `<CosmosLegend />` | Names the colours. A graph has no axis, so an unlabelled colour is unreadable. |
| `<CosmosSearch />` | Ranked find-a-point. A large graph has no addressable structure — without search the only way to reach a known point is to pan and squint. |
| `<CosmosHistogram />` | A column's distribution, with drag-to-filter. |
| `<CosmosTimeline />` | The same over a temporal column, with playback sweeping a window. |
| `<CosmosClusterLabels />` | Names each cluster at its centroid, sized by membership. |

`useCosmosGraph()` gives you the same context if you'd rather build your own.

## Two ways to use it

**`<CosmosGraph />`** owns the drawing surface, the frame loop and touch input,
and takes data as props. This is what you want.

**`Graph`** is the engine on its own. It has no canvas, no clock and no input
handling: you hand it a WebGL2 context and call `render()` when you want a
frame. Use it to drive the engine from your own surface, your own animation
loop, or a worklet.

```ts
import { Graph } from 'react-native-cosmos-gl'

const graph = new Graph(gl, { spaceSize: 4096 })
graph.setSize(width, height)
graph.setPointPositions(positions)
graph.start()

function frame() {
  graph.render([0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight])
  gl.endFrameEXP()
  requestAnimationFrame(frame)
}
```

## Imperative control

```tsx
const ref = useRef<CosmosGraphRef>(null)

ref.current?.fitView()               // frame every point
ref.current?.fitViewByPointIndices(ids)
ref.current?.setZoomLevel(4, 300)    // zoom to 4×, animated over 300 ms
ref.current?.centerOnPointIndex(i)   // centre a point, keeping the zoom level
ref.current?.start()                 // restart the simulation
ref.current?.pause()
ref.current?.getPointPositions()     // current layout, read back from the GPU
ref.current?.findPointOnScreen(x, y)
ref.current?.findPointsInRect([[x0, y0], [x1, y1]])
ref.current?.findPointsInPolygon(path)   // lasso selection
ref.current?.getClusterPositions()
ref.current?.getGraph()              // the underlying engine
```

Two things about framing a small set of points are worth knowing before you hit
them.

**A fit of a single point zooms to a scale you do not want.** One point has zero
extent, which is widened to one space unit, so the fitted scale lands in the
hundreds. Pass bounds:

```tsx
ref.current?.fitViewByPointIndices([i], 250, 0.3, { maxScale: zoom * 2.5 })
```

Or set `scaleExtent` once as a prop and have every path — pinch, `setZoomLevel`,
every fit — respect it.

**A fit returns `false` when none of its points exist yet.** Positions are read
from a texture that is resized on the next data update, so a fit issued in the
same tick as the data has nothing to read and does not move the camera. Retry on
the following frame rather than assuming it moved:

```tsx
if (!ref.current?.fitViewByPointIndices(ids)) {
  requestAnimationFrame(() => ref.current?.fitViewByPointIndices(ids))
}
```

## Configuration

Every property of `GraphConfigInterface` is accepted as a prop. The ones worth
knowing first:

| Prop | Default | What it does |
| --- | --- | --- |
| `enableSimulation` | `true` | `false` renders a precomputed layout with no physics. |
| `simulationRepulsion` | `1.0` | Point-to-point repulsion strength. |
| `simulationGravity` | `0.25` | Pull toward the centre of the space. |
| `simulationLinkSpring` | `1` | Link attraction strength. |
| `simulationLinkDistance` | `10` | Rest length of a link. |
| `simulationDecay` | `5000` | Higher settles more slowly. |
| `spaceSize` | `4096` | Simulation extent. Larger values crash on iOS. |
| `curvedLinks` | `false` | Rational-Bézier links instead of straight ones. |
| `linkBlending` | `true` | `false` is markedly faster on dense graphs. |
| `pointOcclusionCulling` | `true` | Depth-rejects hidden points before shading. |
| `enableDrag` | `false` | A pan starting on a point moves that point. |
| `scaleExtent` | `[0.001, Infinity]` | Hard `[min, max]` zoom range. Every path into the view respects it. |
| `pointSizeStrategy` | inferred | `auto` for the Cosmograph-compatible curve; `continuous` (the default when a column is given) is a square root over a percentile band. |
| `linkWidthStrategy` | `direct` | `sum` totals the width column per ordered source→target pair before encoding. |
| `simulationRestartAlpha` | `1` | Energy a position update restarts the layout with. Low values grow a graph without re-annealing it. |
| `simulationCluster` | `0.1` | Pull toward a point's cluster centroid. |
| `simulationCollision` | `0` | Overlap avoidance. `0` skips the grid entirely. |
| `rescalePositions` | auto | Fits incoming coordinates to the space. |

Callbacks (`onPointClick`, `onZoom`, `onSimulationTick`, …) receive a
`CosmosPointerEvent` rather than a DOM event, produced identically from touch,
pen and mouse.

## Matching a graph drawn by Cosmograph

Cosmograph is a product built on cosmos.gl, and it makes choices cosmos.gl
does not. This package ports cosmos.gl, so its defaults are cosmos.gl's — to
match a Cosmograph canvas you opt in:

```tsx
<CosmosGraph
  pointSizeBy="displaySize"  pointSizeStrategy="auto"  pointSizeRange={[8, 30]}
  linkWidthBy="displayWidth" linkWidthStrategy="sum"   linkWidthRange={[0.8, 4]}
  linkStrengthBy="strength"                            linkStrengthRange={[0.2, 1]}
  // Cosmograph's own overrides on top of cosmos.gl's defaults.
  simulationLinkSpring={0.4}
  hoveredLinkWidthIncrease={0}
  pointSamplingDistance={125}
/>
```

Three things are easy to get wrong, because none of them is linear:

- **Point size** under `auto` is a symmetric-log scale over the column's 5th
  to 95th percentile, clamped. A value halfway along the domain lands well
  above halfway along the range.
- **Link width** under `sum` is aggregated *before* encoding, by **ordered**
  pair — `A→B` and `B→A` are different connections — and the total is then
  symlog-scaled. An authored width is not a pixel width.
- **Link strength** is symlog-scaled over the column's full extent into
  `linkStrengthRange`. Authored `0.22` and `0.68` reach the simulation as
  `0.2` and `1.0`.

## Labels

`src/labels/` decides *what* should be drawn — candidates, priority bands,
collision — and knows nothing about drawing. Two renderers consume it:

```tsx
import { CosmosSkiaLabels } from 'react-native-cosmos-gl/skia'

<CosmosGraph …>
  <CosmosSkiaLabels font={require('./Inter.ttf')} showTopLabels showDynamicLabels />
</CosmosGraph>
```

`CosmosSkiaLabels` needs `@shopify/react-native-skia` — an optional peer
dependency, so the GL engine still requires nothing but expo-gl. Prefer it:
`<CosmosLabels>` renders one React Native view per label, and on device the
compositing cost of that is real. Measured on a mid-range Android phone with
the simulation and links switched off, fifty labels took a graph from 90fps to
40. Views are composited every frame, so throttling the updates does not reach
it; one canvas does.

Two rules the label layer follows that are worth knowing:

- **Cluster labels and point labels are alternatives.** With nothing selected
  the clusters name the regions; the moment anything is selected they give way
  to the points. Forced (`showLabelsFor`) and custom labels survive both.
- **Anchors and text move on different clocks.** Positions come from the GPU
  only while the simulation runs; the camera moves the anchors at display rate
  through `onViewTransform`, and never scales the glyphs.

## Drawing only when there is something to draw

`needsFrame`, `invalidate()` and `onInvalidate()` let a host stop its frame
loop. A settled graph with a stationary camera renders an identical frame
forever otherwise, which on a phone is battery and heat for no picture — and
time taken from anything else sharing the surface. `<CosmosGraph>` does this
for you; a custom host should too:

```ts
const frame = () => {
  graph.render(viewport)
  gl.endFrameEXP()
  if (graph.needsFrame) requestAnimationFrame(frame)
}
graph.onInvalidate(() => requestAnimationFrame(frame))
```

## Performance notes

- **Pixel ratio is capped at 2.** Fragment cost scales with its square, and on a
  graph of small points a phone's native ratio of 3 buys no visible detail for
  2.25× the work.
- **Picking is buffer-based.** A tap fills a reduced-resolution index buffer
  only if the scene changed, then reads a small window around the finger. Cost
  is independent of the graph size.
- **Links draw in one instanced call**, with endpoints uploaded as *texels*
  rather than coordinates — so links follow the simulation with no per-frame CPU
  work at all.
- **Repulsion has two paths.** At or below 4,096 points the force is exact
  (one all-pairs pass, no sampling noise). Above that it uses a Barnes-Hut grid
  pyramid closed by a depth-peeled Monte-Carlo near field.
- **Avoid reading back.** `getPointPositions()` stalls the GPU pipeline. It is
  fine on a tap; it is not fine per frame.
- **The frame loop is on the JS thread**, so anything else on it is paid in
  frames. That is what makes label overlays the usual cost on a busy screen —
  use `CosmosSkiaLabels` rather than `CosmosLabels` where you can, and keep the
  graph's parent from re-rendering per frame.
- **Adding points should not re-anneal the layout.** A position update restarts
  the simulation at `simulationRestartAlpha`; leave it at `1` when the data is
  replaced, and drop it to ~0.25 when the graph merely grew, so the nodes
  already on screen stay where the reader left them.

## Device requirements

WebGL2 with `EXT_color_buffer_float`, which covers essentially every device
running a current iOS or Android.

`expo-gl` requests an OpenGL ES 3.0 context and falls back to ES 2.0 if the
device cannot provide one; only the former gives WebGL2. Extensions map onto the
driver's real list, so `EXT_color_buffer_float` resolves wherever the GPU
actually supports it.

The engine probes what it has and degrades where it can:

| Missing | Consequence |
| --- | --- |
| `EXT_float_blend` | Repulsion falls back to the exact all-pairs path at every size — correct, but O(n²). |
| `EXT_color_buffer_float` | Falls back to 16-bit float targets, which visibly quantizes positions. |
| Both float target extensions | Construction throws with a diagnostic. |
| WebGL2 itself (an ES 2.0 fallback) | Construction throws naming that as the cause. |

Probe before mounting if you need to:

```ts
import { Device } from 'react-native-cosmos-gl'
const features = new Device(gl).features
```

## Differences from cosmos.gl

This is a port, not a wrapper. What changed, and why:

- **No luma.gl.** It assumes a DOM canvas. `src/gl/` is a purpose-built WebGL2
  layer instead — `Device`, `Texture`, `Framebuffer`, `Program`, `Model` — which
  caches GL and uniform state aggressively, because on React Native every call
  crosses a bridge.
- **No runtime dependencies at all.** d3-color, d3-ease, d3-scale, d3-zoom and
  gl-matrix are replaced by the narrow slices the engine actually uses.
- **The engine does not own the frame loop or input.** d3-zoom and d3-drag bind
  to DOM listeners; here the view transform is plain state that gestures drive.
- **`isnan()` is not used.** Several mobile drivers compile under relaxed
  floating-point assumptions and fold it to `false`. Since the engine treats NaN
  as *data*, the shaders use a bit-exact test instead — see
  [`scripts/build-shaders.mjs`](scripts/build-shaders.mjs).
- **Shaders ship as generated TypeScript**, since Metro has no equivalent of
  Vite's `?raw`. The GLSL sources in [`shaders/`](shaders/) stay diffable against
  upstream.
- **Touch-first interaction.** A larger pick radius, long-press for context
  menus, and hover detection that only runs when a hover callback exists.

Why not WebGPU, given that luma.gl ships an adapter for it? Because that adapter
refuses GLSL outright and cosmos.gl has no WGSL — see
[ADR 0001](docs/adr/0001-gpu-backend.md).

## Example app

```bash
cd example
npm install
npx expo run:ios     # or run:android
```

Four datasets from 1.5k to 50k points, with selection, highlighting and live
simulation controls.

## Status

Complete and tested: the simulation (gravity, centering, many-body repulsion,
link springs, clustering, collision), rendering, transitions, gestures, picking,
rect/polygon selection, the records-in data layer with column-driven encodings,
and the overlay components.

Link hit-testing (`onLinkClick`, `onLinkMouseOver`, `onLinkContextMenu`), the
hovered/focused point rings, cluster labels, and the `pointIndexBy` /
`linkSourceIndexBy` index fast path are all implemented.

Not yet ported: point image atlases, and point/link sampling for label
placement. The shaders for both are in [`shaders/`](shaders/) and need only
their module and wiring — see [CONTRIBUTING.md](CONTRIBUTING.md).

**On the data layer.** `src/data/` and the overlay components are original work,
not a port. Their *feature set* is inspired by Cosmograph — column-driven
encodings, labels, search, histograms — but the implementation is clean-room,
built from public API documentation, because
[`@cosmograph/cosmograph`](https://www.npmjs.com/package/@cosmograph/cosmograph)
is CC-BY-NC-4.0 with no public source repository — its code could not go into an
MIT project even if it were available. Where the web library reaches for DuckDB
and DOM widgets, this computes what it needs directly and renders native views,
which is the right trade for a phone holding data already in memory.

## License

MIT. Derived from [cosmos.gl](https://github.com/cosmosgl/graph), also MIT —
the GLSL shaders and the force algorithms are theirs.
