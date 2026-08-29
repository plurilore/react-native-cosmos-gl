/**
 * Default palettes for column-driven encodings.
 *
 * These are not decorative choices. A graph is a scatter form: every category is
 * on screen simultaneously and any two can end up adjacent, so the palette has
 * to hold up under *all-pairs* comparison rather than the easier adjacent-pairs
 * case a bar chart gets. The values below were validated against that harder
 * test, and the limit it imposes is stated rather than hidden — see
 * `CATEGORICAL_ALL_PAIRS_SAFE_LIMIT`.
 */

/**
 * Categorical hues, in fixed assignment order.
 *
 * Stepped for a dark surface, which is the graph's default. Order is the
 * colorblind-safety mechanism, not cosmetics — slots are assigned in sequence
 * and never cycled, so a category keeps its color when other categories come
 * and go.
 */
export const CATEGORICAL_PALETTE_DARK: readonly string[] = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
]

/** The same hues stepped for a light surface. */
export const CATEGORICAL_PALETTE_LIGHT: readonly string[] = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
]

/**
 * How many categories stay reliably distinguishable **by color alone** in a
 * graph.
 *
 * The full eight-slot palette clears every gate when only adjacent pairs must
 * be told apart. A graph gives no such guarantee: points of any two categories
 * can land next to each other, and under all-pairs comparison the eight-slot
 * set fails — magenta against aqua is ΔE 1.6 for a deuteranope, and red against
 * orange is ΔE 7.1 even with full color vision. Only the first three slots
 * clear the floors with every pair in play.
 *
 * This is a property of color perception, not of this palette: no ordering of
 * eight distinct hues passes all-pairs, because the pairlist stops depending on
 * order once every pair counts.
 *
 * So beyond three categories, color is a *hint* and identity must also be
 * carried by something else. In a node-link graph that something is readily
 * available and unusually effective: **point shape**. Set `pointShapeBy` to the
 * same column as `pointColorBy` and the two channels reinforce each other. The
 * legend and tap-to-inspect carry the rest.
 */
export const CATEGORICAL_ALL_PAIRS_SAFE_LIMIT = 3

/**
 * Sequential ramp for continuous magnitude, light → dark in a single hue.
 *
 * One hue, monotonic in lightness. A rainbow ramp would invent boundaries the
 * data does not have — the eye reads a hue change as a category change — which
 * is exactly wrong for a continuous quantity.
 */
export const SEQUENTIAL_PALETTE: readonly string[] = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
]

/**
 * Diverging ramp for values with a meaningful midpoint, through a neutral gray.
 *
 * Two poles that read as opposites, with a gray middle — a hue at the midpoint
 * would make "no difference" look like a category of its own.
 *
 * Built for the dark surface, which inverts the usual construction: magnitude
 * has to read as *brighter*, so both arms lighten away from a midpoint that
 * sits close to the background. The familiar light-surface version, where the
 * arms darken outward from a pale middle, would put its strongest values
 * closest to a dark background and make them the hardest to see.
 */
export const DIVERGING_PALETTE: readonly string[] = [
  '#9ec5f4', // blue pole
  '#5598e7',
  '#3987e5',
  '#256abf',
  '#383835', // neutral midpoint, sitting near the dark surface
  '#a8332f',
  '#e66767',
  '#ee8f8f',
  '#f6bcbc', // red pole
]

/** The graph surface these palettes were validated against. */
export const DEFAULT_BACKGROUND_DARK = '#1a1a19'
export const DEFAULT_BACKGROUND_LIGHT = '#fcfcfb'

/** Color for points whose encoding column has no value. */
export const UNKNOWN_COLOR = 'rgba(140, 145, 155, 0.55)'

/**
 * Where a continuous scale clamps, as percentiles rather than the raw extent.
 *
 * A single outlier three orders of magnitude out would otherwise compress every
 * other value into the first step of the ramp, and the chart would encode one
 * row at the cost of all the others.
 */
export const CONTINUOUS_PERCENTILE_MIN = 0.05
export const CONTINUOUS_PERCENTILE_MAX = 0.95
