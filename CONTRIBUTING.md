# Contributing

## Setup

```bash
npm install
npm test
```

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest
npm run build       # react-native-builder-bob
```

CI runs all four, plus a check that the generated shaders are in sync.

## Shaders

GLSL lives in [`shaders/`](shaders/) as real `.vert` / `.frag` files, kept as
close to upstream cosmos.gl as possible so changes there port across as diffs.
Metro cannot import them, so `scripts/build-shaders.mjs` generates
`src/core/shaders/generated/` — which is committed, so consumers never run the
generator.

After editing anything in `shaders/`:

```bash
npm run shaders
```

The generator applies one deliberate transformation: it rewrites `isnan()` to a
bit-exact helper. Several mobile drivers compile under relaxed floating-point
assumptions and fold the built-in to `false`, and this engine treats NaN as
data — an absent point *is* a NaN position — so a folded test resurrects removed
points at the origin. Don't reintroduce `isnan()`; a test enforces this.

## Testing without a GPU

`src/__tests__/mock-gl.ts` is a WebGL2 context that parses each shader's real
uniform and attribute declarations and reports only those as active. The engine
runs against it end to end.

This exists for one specific failure mode: uniforms are addressed by **string
name**, and a real driver silently ignores a name that doesn't exist. A typo
therefore produces a graph that renders and misbehaves — no repulsion, an
unmoving view — with nothing logged. The tests fail on it instead.

So when you add a uniform, add it to both the shader and the module that sets
it, and the test will tell you if the two disagree.

## What's still unported

Point image atlases and point/link sampling for label placement. Both exist
upstream in [cosmos.gl](https://github.com/cosmosgl/graph), and the shaders for
both are already generated in `src/core/shaders/generated/` — they need their
module and wiring, not new GLSL.

The larger gap is that **nothing here has run on physical hardware.** The tests
verify logic and wiring against a mock context; they have never compiled a
shader on a real driver. Reports from actual devices are the most useful
contribution right now.

## Benchmarking

`npm run bench` compares this engine against d3-force on the JS thread, which
is the usual React Native alternative. Add `-- --collision` to include the
collision force on both sides.

It reports what can be measured off-device — simulation cost per tick, per-frame
JS cost, GPU pass count, texture memory — and states plainly what it cannot:
shader time, Hermes versus V8, and real frame rates all need hardware.

## Style

Match the surrounding code. Comments explain *why* — the invariant being held,
the failure being avoided — not what the line does.
