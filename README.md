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
```

> **Pre-release.** The engine is covered by 127 tests against a mock WebGL2
> context that parses each shader's real declarations — but it has not yet run
> on physical hardware. Shader compilation on actual iOS and Android drivers is
> unverified. Treat `0.x` accordingly.
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
ref.current?.start()                 // restart the simulation
ref.current?.pause()
ref.current?.getPointPositions()     // current layout, read back from the GPU
ref.current?.findPointOnScreen(x, y)
ref.current?.findPointsInRect([[x0, y0], [x1, y1]])
ref.current?.findPointsInPolygon(path)   // lasso selection
ref.current?.getClusterPositions()
ref.current?.getGraph()              // the underlying engine
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
| `simulationCluster` | `0.1` | Pull toward a point's cluster centroid. |
| `simulationCollision` | `0` | Overlap avoidance. `0` skips the grid entirely. |
| `rescalePositions` | auto | Fits incoming coordinates to the space. |

Callbacks (`onPointClick`, `onZoom`, `onSimulationTick`, …) receive a
`CosmosPointerEvent` rather than a DOM event, produced identically from touch,
pen and mouse.

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
