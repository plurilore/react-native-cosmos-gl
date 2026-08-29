/**
 * Enumerations shared between the data model and the defaults.
 *
 * They live in their own module to break a cycle: `variables.ts` needs
 * `PointShape.Circle` for its defaults, and `graph-data.ts` needs
 * `defaultConfigValues` to validate against them. With the enums declared in
 * either of those files, whichever module the bundler evaluates second sees the
 * other only half-initialized, and the default shape resolves to `undefined` at
 * import time.
 */

export enum PointShape {
  Circle = 0,
  Square = 1,
  Triangle = 2,
  Diamond = 3,
  Pentagon = 4,
  Hexagon = 5,
  Star = 6,
  Cross = 7,
  None = 8,
}

/** Link stroke pattern; one value per link via `setLinkStyles`. */
export enum LinkStyle {
  Solid = 0,
  Dashed = 1,
  Dotted = 2,
}
