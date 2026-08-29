#!/usr/bin/env node
/**
 * Compiles every shader the engine ships through the Khronos reference
 * compiler, so a GLSL error is a failed command here instead of a black canvas
 * on someone's phone.
 *
 * Why this exists: the mock GL in the test suite links programs without
 * compiling GLSL, and desktop drivers are lenient in ways Adreno and Mali are
 * not. A type error like comparing a `bool` uniform against `0.0` compiles on
 * some drivers, is rejected outright by others, and is invisible to every other
 * check in this repo.
 *
 * The binary is not vendored — install it once with `npm run shaders:tools`,
 * or point GLSLANG at your own build. Without it the script exits 0 with a
 * notice so a contributor without the tool is not blocked; CI installs it and
 * gets the real gate.
 *
 * Run with `npm run shaders:validate`.
 */
import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const generatedDir = join(root, 'src', 'core', 'shaders', 'generated')
const handWrittenDir = join(root, 'src', 'core', 'shaders')

/**
 * Macros the engine injects at runtime via `Program`'s `defines`, which the
 * reference compiler would otherwise see as undeclared identifiers. A superset
 * is safe: an unused `#define` changes nothing.
 *
 * Keep in sync with the `defines:` call sites in `src/core/modules/`.
 */
const RUNTIME_DEFINES = {
  EXIT_DEFAULT_SIZE: '0.0',
  EXIT_DEFAULT_COLOR_CHANNEL: '0.0',
}

/** Resolves the reference compiler, preferring an explicit GLSLANG override. */
function findGlslang () {
  const candidates = [
    process.env.GLSLANG,
    join(root, 'node_modules', '.glslang', 'bin', 'glslang'),
    join(root, 'node_modules', '.glslang', 'bin', 'glslangValidator'),
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/**
 * Pulls the GLSL out of a generated module.
 *
 * The generated files are `export const name = \`…\`` followed by a default
 * re-export, so the source is everything between the first and last backtick.
 * Reading the text rather than importing it keeps this script plain Node — the
 * generated modules use extensionless TypeScript specifiers that Node's ESM
 * resolver will not follow.
 */
function extractTemplate (ts) {
  // Anchored on the `#version` line rather than the first backtick in the file:
  // a hand-written module's docstring may quote code in backticks.
  const start = ts.indexOf('`#version')
  const end = ts.lastIndexOf('`')
  if (start < 0 || end <= start) return null
  return ts
    .slice(start + 1, end)
    // Undo the escaping applied by scripts/build-shaders.mjs.
    .replace(/\\\$\{/g, '${')
    .replace(/\\`/g, '`')
    .replace(/\\\\/g, '\\')
    // A hand-written module may interpolate a baked constant (force-link-spring
    // bakes its loop bound); any plausible value validates the same code.
    .replace(/\$\{[^}]*\}/g, '8')
}

/**
 * The shared GLSL fragments in `src/core/shaders/modules.ts`, keyed by the
 * functions each one defines.
 *
 * The engine splices these in at compile time with `withShaderModules`, so a
 * shader that calls `conicParametricCurve` does not contain its definition.
 * Resolving them here by "referenced but not defined" mirrors that without
 * this script having to track every call site by hand — and still reports a
 * call to a function no module defines as the error it is.
 */
async function loadSharedModules () {
  const ts = await readFile(join(handWrittenDir, 'modules.ts'), 'utf8')
  const modules = []
  for (const match of ts.matchAll(/=\s*(?:\/\* glsl \*\/\s*)?`([^`]*)`/g)) {
    const glsl = match[1]
    const defines = [...glsl.matchAll(/^\s*\w+\s+(\w+)\s*\(/gm)].map((m) => m[1])
    if (defines.length > 0) modules.push({ glsl, defines })
  }
  return modules
}

/** Splices in every shared module the shader calls but does not define. */
function resolveSharedModules (source, modules) {
  const needed = modules.filter(({ defines }) => defines.some((name) => {
    const called = new RegExp(`\\b${name}\\s*\\(`).test(source)
    const defined = new RegExp(`\\w+\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).test(source)
    return called && !defined
  }))
  if (needed.length === 0) return source
  // Same insertion point as withShaderModules: after the preamble, since
  // #version must lead and precision declarations precede any definition.
  const lines = source.split('\n')
  let insertAt = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#version') || trimmed.startsWith('precision') ||
        trimmed.startsWith('#ifdef') || trimmed.startsWith('#endif') ||
        trimmed.startsWith('//') || trimmed === '') insertAt++
    else break
  }
  lines.splice(insertAt, 0, ...needed.map((module) => module.glsl))
  return lines.join('\n')
}

/** `points-draw-points-vert.ts` → `vert`. */
function stageFor (file) {
  if (file.endsWith('-vert.ts')) return 'vert'
  if (file.endsWith('-frag.ts')) return 'frag'
  return null
}

async function collectShaders () {
  const shaders = []
  for (const file of (await readdir(generatedDir)).sort()) {
    const stage = stageFor(file)
    if (!stage) continue
    const source = extractTemplate(await readFile(join(generatedDir, file), 'utf8'))
    if (source) shaders.push({ name: basename(file, '.ts'), stage, source })
  }
  // Hand-written modules that build a shader in TypeScript rather than in
  // `shaders/`; they compile on the same drivers and need the same gate.
  for (const file of (await readdir(handWrittenDir)).sort()) {
    if (!file.endsWith('.ts') || file === 'index.ts' || file === 'modules.ts') continue
    const ts = await readFile(join(handWrittenDir, file), 'utf8')
    if (!ts.includes('#version 300 es')) continue
    const source = extractTemplate(ts)
    if (source) shaders.push({ name: basename(file, '.ts'), stage: 'frag', source })
  }
  return shaders
}

/** Inserts the runtime defines after `#version`, exactly as `Program` does. */
function injectDefines (source) {
  const lines = source.split('\n')
  const versionIndex = lines.findIndex((line) => line.trim().startsWith('#version'))
  const defines = Object.entries(RUNTIME_DEFINES).map(([name, value]) => `#define ${name} ${value}`)
  lines.splice(versionIndex + 1, 0, ...defines)
  return lines.join('\n')
}

async function main () {
  const glslang = findGlslang()
  if (!glslang) {
    console.log('glslang not found — skipping shader validation. Install it with `npm run shaders:tools`.')
    return
  }

  const shaders = await collectShaders()
  const sharedModules = await loadSharedModules()
  const dir = await mkdtemp(join(tmpdir(), 'cosmos-shaders-'))
  const failures = []

  try {
    for (const { name, stage, source } of shaders) {
      const file = join(dir, `${name}.${stage}`)
      await writeFile(file, injectDefines(resolveSharedModules(source, sharedModules)))
      try {
        // `--auto-map-locations` silences the location requirements of the
        // Vulkan-flavoured defaults; the engine binds by name at link time.
        await run(glslang, ['-S', stage, '--auto-map-locations', file])
      } catch (error) {
        failures.push({ name, output: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() })
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  for (const { name, output } of failures) {
    console.error(`\n✗ ${name}\n${output}`)
  }
  console.log(`\n${shaders.length - failures.length}/${shaders.length} shaders compiled.`)
  if (failures.length > 0) process.exitCode = 1
}

await main()
