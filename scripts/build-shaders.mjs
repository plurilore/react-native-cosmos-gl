#!/usr/bin/env node
/**
 * Converts the GLSL sources in `shaders/` into TypeScript modules under
 * `src/core/shaders/`.
 *
 * Metro has no equivalent of Vite's `?raw` import, so shader text has to reach
 * the bundle as a string literal in a `.ts` file. Authoring the GLSL in real
 * `.glsl` files and generating from them keeps editor syntax highlighting and
 * keeps diffs against upstream cosmos.gl readable — the generated modules are
 * committed so consumers never need this script.
 *
 * Run with `npm run shaders`.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, basename, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(root, 'shaders')
// Generated files get their own directory so the hand-written shader helpers
// beside them are never clobbered, and so CI can assert the generated tree is
// in sync without flagging edits to those helpers.
const outDir = join(root, 'src', 'core', 'shaders', 'generated')

/**
 * Turns `Points/draw-points.vert` into `pointsDrawPointsVert`.
 *
 * The module directory is part of the name because basenames are not unique —
 * `calculate-centermass.frag` exists in both `Clusters/` and `ForceCenter/`,
 * and they are different shaders.
 */
function identifierFor (file) {
  const ext = extname(file).slice(1)
  const stem = basename(file, extname(file))
  const moduleDir = basename(dirname(file))
  const camel = (s) => s.replace(/[-_.](\w)/g, (_, c) => c.toUpperCase())
  const head = camel(moduleDir.charAt(0).toLowerCase() + moduleDir.slice(1))
  const tail = camel(stem).replace(/^\w/, (c) => c.toUpperCase())
  return head + tail + ext.charAt(0).toUpperCase() + ext.slice(1)
}

function moduleNameFor (file) {
  const moduleDir = basename(dirname(file))
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
  return `${moduleDir}-${basename(file, extname(file))}-${extname(file).slice(1)}`
}

/** Escapes GLSL for a TS template literal. */
function escapeTemplate (source) {
  return source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/**
 * A bit-exact NaN test, injected into any shader that needs one.
 *
 * GLSL ES 3.00's built-in `isnan()` is unreliable on mobile GPUs: several
 * Adreno and Mali driver versions compile shaders under relaxed floating-point
 * assumptions in which NaN "cannot occur", and fold `isnan()` to a constant
 * `false`. The comparison-based idiom `!(x <= 0.0 || x >= 0.0)` folds away for
 * the same reason.
 *
 * The engine leans on NaN as real data — an absent point is one whose position
 * is NaN, and a NaN color or size channel means "resolve the default" — so a
 * folded test does not degrade gracefully; removed points reappear at the
 * origin and unstyled points render black. Reading the bit pattern cannot be
 * folded: NaN is exponent all-ones with a non-zero mantissa, and that is a
 * fact about the bits rather than about arithmetic.
 */
const NAN_HELPERS = `
// Injected by scripts/build-shaders.mjs — see NAN_HELPERS there for why the
// built-in isnan() is not used.
bool cosmosIsNaN(float x) {
  uint bits = floatBitsToUint(x);
  return (bits & 0x7F800000u) == 0x7F800000u && (bits & 0x007FFFFFu) != 0u;
}
bvec2 cosmosIsNaN(vec2 v) { return bvec2(cosmosIsNaN(v.x), cosmosIsNaN(v.y)); }
bvec3 cosmosIsNaN(vec3 v) { return bvec3(cosmosIsNaN(v.x), cosmosIsNaN(v.y), cosmosIsNaN(v.z)); }
bvec4 cosmosIsNaN(vec4 v) { return bvec4(cosmosIsNaN(v.x), cosmosIsNaN(v.y), cosmosIsNaN(v.z), cosmosIsNaN(v.w)); }
`

/**
 * Rewrites `isnan(` to the injected helper and places the helper after the
 * last `precision` / `#endif` line of the shader preamble, which is the first
 * point at which a function definition is legal.
 */
function applyNanHelpers (source) {
  if (!/\bisnan\s*\(/.test(source)) return source
  const rewritten = source.replace(/\bisnan\s*\(/g, 'cosmosIsNaN(')

  const lines = rewritten.split('\n')
  let insertAt = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('#version') || line.startsWith('precision') ||
        line.startsWith('#ifdef') || line.startsWith('#endif') ||
        line.startsWith('//') || line === '') {
      insertAt = i + 1
    } else {
      break
    }
  }
  lines.splice(insertAt, 0, NAN_HELPERS)
  return lines.join('\n')
}

async function collect (dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(full)))
    else if (/\.(vert|frag|glsl)$/.test(entry.name)) files.push(full)
  }
  return files
}

const files = (await collect(sourceDir)).sort()
if (files.length === 0) {
  console.error(`No shaders found in ${sourceDir}`)
  process.exit(1)
}

await mkdir(outDir, { recursive: true })
const exports = []

for (const file of files) {
  const raw = await readFile(file, 'utf8')
  const source = applyNanHelpers(raw)
  const identifier = identifierFor(file)
  const moduleName = moduleNameFor(file)
  const relativePath = relative(root, file)

  const contents = `// Generated from ${relativePath} by scripts/build-shaders.mjs. Do not edit.
// Derived from cosmos.gl (https://github.com/cosmosgl/graph), MIT licensed.
export const ${identifier} = \`${escapeTemplate(source.trimEnd())}
\`
export default ${identifier}
`
  await writeFile(join(outDir, `${moduleName}.ts`), contents)
  exports.push({ identifier, moduleName })
}

const index = `// Generated by scripts/build-shaders.mjs. Do not edit.
${exports.map((e) => `export { ${e.identifier} } from './${e.moduleName}'`).join('\n')}
`
await writeFile(join(outDir, 'index.ts'), index)

console.log(`Generated ${files.length} shader modules in ${relative(root, outDir)}`)
