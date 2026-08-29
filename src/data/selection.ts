import type { Graph } from '../core/graph'

/**
 * Which points and links the user has selected.
 *
 * Kept as its own object rather than as graph config because selection is
 * *derived*: highlighting a set of points usually means highlighting the links
 * between them too, and a selection made by tapping one point usually means its
 * neighbours as well. Doing that expansion once, here, keeps every caller —
 * a tap, a lasso, a search result, a histogram brush — landing on the same
 * rules.
 *
 * An empty selection is not the same as no selection. Nothing selected means
 * *everything* is shown normally; a selection of zero points after a filter
 * means everything is greyed out. The distinction is `hasSelection`.
 */
export class Selection {
  private points: Set<number> | undefined
  private links: Set<number> | undefined

  /** True while a selection is active, even if it selects nothing. */
  public get hasSelection (): boolean {
    return this.points !== undefined || this.links !== undefined
  }

  public get pointIndices (): number[] | undefined {
    return this.points ? [...this.points] : undefined
  }

  public get linkIndices (): number[] | undefined {
    return this.links ? [...this.links] : undefined
  }

  public get pointCount (): number {
    return this.points?.size ?? 0
  }

  public isPointSelected (index: number): boolean {
    return this.points?.has(index) ?? false
  }

  /**
   * Selects points, optionally pulling in their neighbours and the links
   * between everything selected.
   */
  public selectPoints (
    graph: Graph,
    indices: number[],
    options: { additive?: boolean; includeNeighbors?: boolean; includeLinks?: boolean } = {}
  ): void {
    const { additive = false, includeNeighbors = false, includeLinks = true } = options

    const next = additive && this.points ? new Set(this.points) : new Set<number>()
    for (const index of indices) next.add(index)
    if (includeNeighbors && indices.length > 0) {
      for (const index of graph.getNeighboringPointIndices(indices)) next.add(index)
    }

    this.points = next
    // Only links with *both* ends selected: a link with one end outside the
    // selection is not part of what was selected, and highlighting it would
    // draw attention out of the subgraph the user asked for.
    this.links = includeLinks ? new Set(graph.getConnectedLinkIndices([...next])) : undefined
  }

  /** Selects links, optionally pulling in their endpoints. */
  public selectLinks (
    graph: Graph,
    indices: number[],
    options: { additive?: boolean; includeEndpoints?: boolean } = {}
  ): void {
    const { additive = false, includeEndpoints = true } = options

    const next = additive && this.links ? new Set(this.links) : new Set<number>()
    for (const index of indices) next.add(index)
    this.links = next

    if (includeEndpoints) {
      const endpoints = graph.getConnectedPointIndices([...next])
      const points = additive && this.points ? new Set(this.points) : new Set<number>()
      for (const index of endpoints) points.add(index)
      this.points = points
    }
  }

  public unselectPoints (indices: number[]): void {
    if (!this.points) return
    for (const index of indices) this.points.delete(index)
  }

  /** Clears the selection entirely, returning to "nothing selected". */
  public clear (): void {
    this.points = undefined
    this.links = undefined
  }

  /**
   * The graph config this selection implies.
   *
   * `undefined` for both means no highlighting, which is what the graph needs
   * to render everything at full strength.
   */
  public toConfig (): { highlightedPointIndices?: number[]; highlightedLinkIndices?: number[] } {
    if (!this.hasSelection) return {}
    return {
      highlightedPointIndices: this.pointIndices,
      highlightedLinkIndices: this.linkIndices,
    }
  }
}
