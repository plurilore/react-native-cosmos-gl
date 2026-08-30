// Referenced rather than relied on: the root config does not pull `@types/node`
// in by default, and `tsconfig.build.json` sets `types: []` so no shipped
// declaration can depend on it. This file is the only one that reads the disk.
/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCESSOR_TYPE,
  SKIA_NATIVE_CONTRACT,
  type NativeArgumentType,
} from './skia-native-contract'

/**
 * Holds the contract table against the Skia the package is built with.
 *
 * The table is what the mock enforces, so it has to keep matching reality — a
 * Skia upgrade that flips an accessor would otherwise leave every test green
 * and the device crashing. Deriving it from the shipped headers is exact: this
 * is the same source the native module is compiled from.
 *
 * It also documents the upstream defect in place. `Font.setSubpixel` and
 * `Font.setEmbolden` are declared `boolean` and read as numbers; if a release
 * fixes that, this test fails and says so, which is the signal to simplify.
 */

const CPP = join(
  process.cwd(), 'node_modules', '@shopify', 'react-native-skia', 'cpp'
)

/** Every `JsiSk*.h` under the installed package. */
function headers (dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...headers(path))
    else if (/^JsiSk\w+\.h$/.test(entry.name)) found.push(path)
  }
  return found
}

/**
 * Reads the leading argument accessors out of each host function.
 *
 * Scoped to one function at a time — a fixed-size window bleeds into the next
 * one and reports its accessors as this one's, which is how a first attempt at
 * this had `Paint.setColor` reading a number.
 */
function derive (): Map<string, NativeArgumentType[]> {
  const contract = new Map<string, NativeArgumentType[]>()
  for (const header of headers(CPP)) {
    const source = readFileSync(header, 'utf8')
    const cls = (header.split('/').pop() ?? '').replace(/^JsiSk|\.h$/g, '')
    const marks = [...source.matchAll(/JSI_HOST_FUNCTION\((\w+)\)/g)]
    marks.forEach((mark, index) => {
      const start = (mark.index ?? 0) + mark[0].length
      const end = index + 1 < marks.length ? marks[index + 1]?.index ?? source.length : source.length
      const body = source.slice(start, end)
      const args: NativeArgumentType[] = []
      for (const call of body.matchAll(/arguments\[(\d+)\]\.(asNumber|getBool|asString)\(/g)) {
        const at = Number(call[1])
        args[at] ??= ACCESSOR_TYPE[call[2] as keyof typeof ACCESSOR_TYPE]
      }
      // Only leading arguments, and only an unbroken run of them: a gap means
      // the binding reads that one through a helper we cannot see.
      const leading: NativeArgumentType[] = []
      for (const arg of args) {
        if (arg === undefined) break
        leading.push(arg)
      }
      if (leading.length > 0) contract.set(`${cls}.${mark[1]}`, leading)
    })
  }
  return contract
}

describe('the Skia binding contract', () => {
  const installed = existsSync(CPP)

  it.runIf(installed)('matches every row against the shipped headers', () => {
    const derived = derive()
    const mismatches: string[] = []
    for (const [key, expected] of Object.entries(SKIA_NATIVE_CONTRACT)) {
      const actual = derived.get(key)
      if (!actual) {
        mismatches.push(`${key}: no such host function in the installed headers`)
        continue
      }
      const overlap = actual.slice(0, expected.length)
      if (overlap.join(',') !== expected.join(',')) {
        mismatches.push(`${key}: table says ${expected.join(',')}, binding reads ${overlap.join(',')}`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it.runIf(installed)('still finds the declarations that lie', () => {
    // The whole reason for the table. If an upstream release fixes these, this
    // fails — and the fix is to simplify, not to widen the assertion.
    const derived = derive()
    expect(derived.get('Font.setSubpixel')).toEqual(['number'])
    expect(derived.get('Font.setEmbolden')).toEqual(['number'])
  })

  it.runIf(installed)('reads enough of the surface to be worth trusting', () => {
    // A regex that quietly stopped matching would make this whole file inert.
    expect(derive().size).toBeGreaterThan(100)
  })

  it('types each accessor the way JSI does', () => {
    expect(ACCESSOR_TYPE.asNumber).toBe('number')
    expect(ACCESSOR_TYPE.getBool).toBe('boolean')
    expect(ACCESSOR_TYPE.asString).toBe('string')
  })
})
