#!/usr/bin/env node
/**
 * Downloads the Khronos reference GLSL compiler into `node_modules/.glslang`
 * for `npm run shaders:validate`.
 *
 * It is a download rather than a dependency because the published npm wrappers
 * are years behind the releases, and because the binary is only needed by the
 * shader gate — an app consuming this package never compiles GLSL offline.
 *
 * Run with `npm run shaders:tools`.
 */
import { mkdir, rm, chmod, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:os'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'node_modules', '.glslang')

// Pinned: a compiler that changes under you turns an unrelated commit into a
// shader failure. Bump deliberately.
const VERSION = '16.5.0'

function assetFor () {
  const os = platform()
  if (os === 'linux' && arch() === 'x64') return `glslang-${VERSION}-linux-x86_64-release.tar.gz`
  if (os === 'darwin') return `glslang-${VERSION}-macos-universal-release.tar.gz`
  return null
}

const asset = assetFor()
if (!asset) {
  console.error(
    `No pinned glslang build for ${platform()}/${arch()}.\n` +
    'Build or download it yourself and point GLSLANG at the binary.'
  )
  process.exit(1)
}

const url = `https://github.com/KhronosGroup/glslang/releases/download/${VERSION}/${asset}`
console.log(`Downloading ${url}`)

const response = await fetch(url, { redirect: 'follow' })
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`)
  process.exit(1)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
const archive = join(target, asset)
await writeFile(archive, Buffer.from(await response.arrayBuffer()))
// `tar` ships with macOS and every Linux distro this runs on; unpacking in
// JavaScript would mean a dependency for one command.
await run('tar', ['xzf', archive, '-C', target])
await rm(archive)
await chmod(join(target, 'bin', 'glslang'), 0o755)

const { stdout } = await run(join(target, 'bin', 'glslang'), ['--version'])
console.log(stdout.trim())
