/**
 * CSS color parsing, standing in for `d3-color`.
 *
 * The engine accepts colors as CSS strings anywhere it accepts an RGBA tuple,
 * and the defaults (`'white'`, `'#222222'`) are strings — so a parser has to
 * exist. Pulling `d3-color` into a React Native bundle for it is not worth the
 * dependency, and d3's full CSS Color 4 surface is far more than the engine
 * ever sees.
 *
 * Supported: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`,
 * `hsl()`/`hsla()` (comma or space separated, percent or unit alpha),
 * `transparent`, and the 148 CSS named colors.
 */

export type Rgba = [number, number, number, number]

/** The 148 CSS named colors, packed as 24-bit integers to keep the table small. */
const NAMED_COLORS: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
  deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
  dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
  fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f,
  grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
  lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32,
  linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6,
  olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500,
  orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f,
  pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080,
  rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1,
  saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57,
  seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb,
  slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa,
  springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080,
  thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee,
  wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00,
  yellowgreen: 0x9acd32,
}

const FALLBACK: Rgba = [0, 0, 0, 1]

/**
 * Parses a CSS color, or passes an RGBA tuple straight through.
 *
 * Channels come back normalized to `0..1` — the form every shader in the engine
 * expects. An unparseable string becomes opaque black rather than throwing,
 * matching d3-color's forgiving behavior at the boundary.
 */
export function getRgbaColor (value: string | readonly number[]): Rgba {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const array = value as readonly number[]
    return [array[0] ?? 0, array[1] ?? 0, array[2] ?? 0, array[3] ?? 1]
  }

  const input = String(value).trim().toLowerCase()
  if (input.length === 0) return [...FALLBACK]
  if (input === 'transparent') return [0, 0, 0, 0]
  if (input === 'none') return [0, 0, 0, 0]

  if (input.charCodeAt(0) === 35 /* # */) return parseHex(input)

  const named = NAMED_COLORS[input]
  if (named !== undefined) {
    return [((named >> 16) & 0xff) / 255, ((named >> 8) & 0xff) / 255, (named & 0xff) / 255, 1]
  }

  const functional = parseFunctional(input)
  if (functional) return functional

  return [...FALLBACK]
}

function parseHex (input: string): Rgba {
  const hex = input.slice(1)
  const length = hex.length
  if (!/^[0-9a-f]+$/.test(hex)) return [...FALLBACK]

  // Shorthand forms repeat each digit: #abc → #aabbcc.
  if (length === 3 || length === 4) {
    const r = parseInt(hex[0]! + hex[0]!, 16)
    const g = parseInt(hex[1]! + hex[1]!, 16)
    const b = parseInt(hex[2]! + hex[2]!, 16)
    const a = length === 4 ? parseInt(hex[3]! + hex[3]!, 16) / 255 : 1
    return [r / 255, g / 255, b / 255, a]
  }

  if (length === 6 || length === 8) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
    return [r / 255, g / 255, b / 255, a]
  }

  return [...FALLBACK]
}

function parseFunctional (input: string): Rgba | undefined {
  const open = input.indexOf('(')
  if (open < 0 || !input.endsWith(')')) return undefined
  const fn = input.slice(0, open).trim()
  // Both the legacy comma syntax and the modern space syntax (with `/` before
  // alpha) reduce to the same token list once separators are normalized.
  const parts = input
    .slice(open + 1, -1)
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter((part) => part.length > 0)

  if (fn === 'rgb' || fn === 'rgba') {
    const r = channel(parts[0], 255)
    const g = channel(parts[1], 255)
    const b = channel(parts[2], 255)
    const a = parts.length > 3 ? alpha(parts[3]) : 1
    if (r === undefined || g === undefined || b === undefined) return undefined
    return [r, g, b, a]
  }

  if (fn === 'hsl' || fn === 'hsla') {
    const h = number(parts[0])
    const s = percent(parts[1])
    const l = percent(parts[2])
    const a = parts.length > 3 ? alpha(parts[3]) : 1
    if (h === undefined || s === undefined || l === undefined) return undefined
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp01(s), clamp01(l))
    return [r, g, b, a]
  }

  return undefined
}

/** A `0..255` or percentage channel, normalized to `0..1`. */
function channel (token: string | undefined, scale: number): number | undefined {
  if (token === undefined) return undefined
  if (token.endsWith('%')) {
    const value = Number.parseFloat(token)
    return Number.isFinite(value) ? clamp01(value / 100) : undefined
  }
  const value = Number.parseFloat(token)
  return Number.isFinite(value) ? clamp01(value / scale) : undefined
}

function percent (token: string | undefined): number | undefined {
  if (token === undefined) return undefined
  const value = Number.parseFloat(token)
  if (!Number.isFinite(value)) return undefined
  return token.endsWith('%') ? value / 100 : value
}

function number (token: string | undefined): number | undefined {
  if (token === undefined) return undefined
  const value = Number.parseFloat(token)
  return Number.isFinite(value) ? value : undefined
}

function alpha (token: string | undefined): number {
  const value = channel(token, 1)
  return value ?? 1
}

function clamp01 (value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function hslToRgb (h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hk = h / 360
  return [hueToRgb(p, q, hk + 1 / 3), hueToRgb(p, q, hk), hueToRgb(p, q, hk - 1 / 3)]
}

function hueToRgb (p: number, q: number, t: number): number {
  let value = t
  if (value < 0) value += 1
  if (value > 1) value -= 1
  if (value < 1 / 6) return p + (q - p) * 6 * value
  if (value < 1 / 2) return q
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
  return p
}

/**
 * Relative luminance, used to decide whether overlays on the background should
 * be drawn light or dark.
 */
export function rgbToBrightness (r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
