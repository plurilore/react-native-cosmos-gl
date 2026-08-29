# ADR 0001 — GPU backend: WebGL2 via expo-gl, not WebGPU

**Status:** accepted · **Date:** 2026-08-28

## Context

cosmos.gl v3 runs on [luma.gl](https://luma.gl/) 9.3, whose `Device` API is
backend-agnostic. That raises the obvious question for a React Native port:
can we skip WebGL entirely and target WebGPU through `react-native-webgpu`,
which is native (Dawn) rather than a bridged GL implementation, and whose
compute shaders would replace the fragment-shader GPGPU tricks the engine
currently relies on?

We checked. The answer is no — not yet, and not cheaply.

### luma.gl does support WebGPU

`@luma.gl/webgpu@9.3.6` is a complete WebGPU adapter for the luma.gl core
Device API: buffers, textures, render pipelines, and — relevantly —
`WebGPUComputePipeline` and `WebGPUComputePass`.

### But cosmos.gl cannot reach it

The device layer is abstracted; the shader layer is not.

1. **luma.gl's WebGPU adapter refuses GLSL.** `WebGPUShader`'s constructor
   throws `'GLSL shaders are not supported in WebGPU'` when the source declares
   `language: 'glsl'` or merely contains `#version`. There is no transpile
   path — the glslang hook in `webgpu-device.js` is commented out:

   ```js
   // Load the glslang module now so that it is available synchronously when compiling shaders
   // const {glsl = true} = props;
   // this.glslang = glsl && await loadGlslangModule();
   ```

   `WebGPUDevice.getShaderLayout()` reflects WGSL only (`getShaderLayoutFromWGSL`),
   and the device reports `shadingLanguage: 'wgsl'`.

2. **cosmos.gl ships no WGSL.** All 36 shaders are GLSL ES 3.00 (`#version 300 es`),
   ~3,000 lines covering the whole simulation and renderer.

3. **cosmos.gl registers only the WebGL2 adapter** (`adapters: [webgl2Adapter]`).

The std140 `mat4` padding in `Store.transformationMatrix4x4` and the
`USE_UNIFORM_BUFFERS` `#ifdef`s throughout the shaders are groundwork for a
WebGPU port that has not happened. Taking that route means hand-rewriting the
entire engine in WGSL before rendering a single frame.

## Decision

Target **WebGL2**, obtained from `expo-gl` on iOS/Android and from a `<canvas>`
on web.

- The GLSL ports over essentially verbatim, including the `#else` (plain
  uniform) branch of every `USE_UNIFORM_BUFFERS` block — so we skip uniform
  buffer objects entirely and set uniforms by name.
- We do **not** depend on luma.gl. It assumes a DOM `canvas`, pulls in
  `@probe.gl/*`, and we need only a narrow slice of it. `src/gl/` is a
  purpose-built ~1k-line WebGL2 layer instead: `Device`, `GLBuffer`,
  `Texture`, `Framebuffer`, `Program`, `Model`.

## Consequences

- Ships against real devices today, with the upstream shaders as the source of
  truth — which means upstream fixes port across as diffs, not rewrites.
- We own our GL layer, so we carry the maintenance. In exchange it stays small,
  has no DOM coupling, and caches GL state aggressively — which matters far more
  on React Native, where every call crosses a bridge, than it does in a browser.
- We inherit WebGL2's constraints: no compute shaders, so the many-body force
  keeps its depth-peeled near field and ping-pong FBOs; and we need
  `EXT_color_buffer_float` (plus `EXT_float_blend` for the accumulating forces).
  `Device.features` probes these once and degrades where it can.

## Revisiting

A WebGPU backend stays additive, and the boundary is drawn for it: nothing above
`src/gl/` names a GL enum or calls a `gl.*` method. The work it would need is a
WGSL translation of `src/core/shaders/`, at which point the compute-shader
rewrite of ForceManyBody becomes worthwhile on its own merits. Reassess when
`react-native-webgpu` is stable across both platforms and a GLSL→WGSL path
(naga, tint, or hand-authored WGSL upstream) exists.
