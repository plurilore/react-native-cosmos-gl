/**
 * What the Skia JSI bindings actually accept, as opposed to what they declare.
 *
 * `@shopify/react-native-skia` ships TypeScript declarations that contradict
 * its own native bindings. `SkFont.setSubpixel` is declared `(x: boolean)` and
 * implemented as `arguments[0].asNumber()`, so the call TypeScript demands
 * throws `Value is true, expected a number` the first time it runs — on the
 * device, inside a passive effect, with a stack that names none of this.
 *
 * A compiler cannot catch that, because the declaration is the thing that is
 * wrong. So the mock the tests draw against enforces the *native* types listed
 * here, and `skia-binding-contract.test.ts` re-derives this table from the
 * installed C++ headers, so an upgrade that changes a binding fails in CI
 * rather than on a phone.
 *
 * Every row must be derivable from a header — a plain `arguments[n].asX()` —
 * so that check can be exact. Methods that read their arguments through a
 * helper are not listed; nothing in this package passes them a primitive.
 */

export type NativeArgumentType = 'number' | 'boolean' | 'string'

/** JSI accessor → the runtime type it demands. */
export const ACCESSOR_TYPE = {
  asNumber: 'number',
  getBool: 'boolean',
  asString: 'string',
} as const satisfies Record<string, NativeArgumentType>

/**
 * `Class.method` → the runtime type of each leading argument.
 *
 * Kept to what this package calls, plus the neighbours a future change would
 * most plausibly reach for. The list is the audit: adding a Skia call means
 * adding its row.
 */
export const SKIA_NATIVE_CONTRACT: Record<string, NativeArgumentType[]> = {
  // Declared `boolean`, read as a number. Calling these the way the type says
  // is the crash this table exists for.
  'Font.setSubpixel': ['number'],
  'Font.setEmbolden': ['number'],
  // Numeric enums and measurements — declaration and binding agree.
  'Font.setEdging': ['number'],
  'Font.setHinting': ['number'],
  'Font.setSize': ['number'],
  'Font.setScaleX': ['number'],
  'Font.setSkewX': ['number'],
  // Genuinely boolean.
  'Font.setLinearMetrics': ['boolean'],
  'Font.embeddedBitmaps': ['boolean'],
  'Paint.setAntiAlias': ['boolean'],
  'Paint.setDither': ['boolean'],
  'Paint.setStrokeWidth': ['number'],
  'Paint.setStyle': ['number'],
  'Canvas.drawText': ['string', 'number', 'number'],
}

/** Thrown with the same shape as the JSI failure it stands in for. */
export class NativeContractError extends Error {}

/**
 * Checks one call against the contract, throwing the way the binding would.
 *
 * The message mirrors JSI's own — `Value is true, expected a number` — so a
 * failing test reads like the device crash it is standing in for.
 */
export function assertNativeCall (key: string, args: readonly unknown[]): void {
  const expected = SKIA_NATIVE_CONTRACT[key]
  if (!expected) return
  expected.forEach((want, index) => {
    if (index >= args.length) return
    if (typeof args[index] === want) return
    throw new NativeContractError(
      `Exception in HostFunction: Value is ${String(args[index])}, ` +
      `expected a ${want} (${key}, argument ${index})`
    )
  })
}
