# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.x`, a minor bump may carry a breaking change. The
release that stabilizes the API will say so here.

## [Unreleased]

## [0.1.1] - 2026-09-01

### Changed

- `<CosmosGraph />` touch input now uses composed native pan, pinch, long-press
  and tap recognisers. It requires `react-native-gesture-handler >= 2.32` and a
  `GestureHandlerRootView` above the graph.

### Fixed

- Pan, pinch and every sequence containing multiple pointers are resolved
  before point, link or background press callbacks can fire.
- Pan and pinch transitions end each controller gesture once and reset the pan
  translation baseline before panning resumes.
- Android terminal pinch samples with fewer than two pointers are discarded,
  preventing the focal-point change at release from shifting the camera.

## [0.1.0] - 2026-08-31

Initial release. A port of [cosmos.gl](https://github.com/cosmosgl/graph) to
iOS, Android and the web: the force simulation and the rendering both run in
GLSL, and point positions stay in floating-point textures rather than crossing
the bridge to be drawn.

### Added

- **Simulation** — gravity, centering, many-body repulsion, link springs,
  clustering and collision, all on the GPU.
- **Rendering** — points, links, curved links, transitions, and a draw path
  that never reads positions back into JavaScript.
- **Interaction** — touch-first gestures, picking with a larger pick radius,
  long-press context menus, rect and polygon selection, and link hit-testing
  (`onLinkClick`, `onLinkMouseOver`, `onLinkContextMenu`).
- **`<CosmosGraph />`** — owns the surface, frame loop and input, and takes
  data as props.
- **`Graph`** — the engine on its own, for driving from your own surface,
  animation loop or worklet.
- **Data layer** (`src/data/`) — a records-in `DataFrame` with column-driven
  encodings, `Selection`, and ranked point search. Original work, clean-room,
  not a port.
- **Overlays** — `<CosmosLabels />`, `<CosmosLegend />`, `<CosmosSearch />`,
  `<CosmosHistogram />`, `<CosmosTimeline />` and `<CosmosClusterLabels />`,
  plus `useCosmosGraph()` for building your own.
- **Inline labels** — drawn from one atlas in physical pixels, with the camera
  off the JS thread. Optional Skia rasterizer behind the
  `react-native-cosmos-gl/skia` subpath.
- **On-demand frames** — the engine draws when there is something to draw
  rather than on every tick.
- **`probeDevice(gl)`** — reports whether a device can run the engine and why
  not, before you write code against it. `formatDeviceReport()` renders it as
  a shareable string.
- **Graceful degradation** — missing `EXT_float_blend` falls back to exact
  all-pairs repulsion; missing `EXT_color_buffer_float` falls back to 16-bit
  float targets. Losing both, or getting an ES 2.0 context, throws with a
  diagnostic naming the cause.
- **Cosmograph-compatible encodings** and the `pointIndexBy` /
  `linkSourceIndexBy` index fast path.

### Notes

- **No runtime dependencies.** d3-color, d3-ease, d3-scale, d3-zoom and
  gl-matrix are replaced by the narrow slices the engine uses; luma.gl is
  replaced by a purpose-built WebGL2 layer in `src/gl/` that caches GL and
  uniform state, because every call crosses a bridge here.
- **`isnan()` is not used** — several mobile drivers fold it to `false` under
  relaxed floating-point assumptions, and the engine treats NaN as data. The
  shaders use a bit-exact test instead.
- **Shaders ship as generated TypeScript**, since Metro has no equivalent of
  Vite's `?raw`. The GLSL in `shaders/` stays diffable against upstream.
- Requires React 19, React Native 0.86, Expo SDK 57 and Node 20 or newer.
- **iOS is unverified.** The engine runs on physical Android hardware and is
  covered by 275 tests plus a gate that compiles all 40 shaders through the
  Khronos reference compiler, but Metal-backed shader compilation and the Skia
  label path on iOS have not been exercised.

### Not yet implemented

- Point image atlas drawing.

[Unreleased]: https://github.com/plurilore/react-native-cosmos-gl/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/plurilore/react-native-cosmos-gl/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/plurilore/react-native-cosmos-gl/releases/tag/v0.1.0
