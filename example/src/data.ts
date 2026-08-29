/**
 * Synthetic graphs for the example, built directly into the flat typed arrays
 * the engine consumes.
 *
 * Deliberately generated rather than loaded from a fixture: the interesting
 * question for this library is how it behaves at 50k points, and a file that
 * size has no place in a repo.
 */

export type GraphDataset = {
  name: string
  description: string
  pointPositions: Float32Array
  links: Float32Array
  pointColors: Float32Array
  pointSizes: Float32Array
}

/** A deterministic PRNG, so a dataset looks the same on every launch. */
function makeRandom (seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A pleasant categorical palette, already normalized to the 0..1 the GPU wants. */
const PALETTE: [number, number, number][] = [
  [0.40, 0.76, 0.96],
  [0.98, 0.55, 0.38],
  [0.55, 0.83, 0.51],
  [0.90, 0.45, 0.72],
  [0.98, 0.82, 0.36],
  [0.68, 0.58, 0.94],
]

function paint (count: number, group: (index: number) => number, alpha = 1): Float32Array {
  const colors = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const rgb = PALETTE[group(i) % PALETTE.length] as [number, number, number]
    colors[i * 4] = rgb[0]
    colors[i * 4 + 1] = rgb[1]
    colors[i * 4 + 2] = rgb[2]
    colors[i * 4 + 3] = alpha
  }
  return colors
}

/**
 * Communities of densely-linked points with a few bridges between them — the
 * structure a force layout is actually good at revealing, and the one where you
 * can tell at a glance whether the simulation is working.
 */
export function makeClusteredGraph (
  clusterCount: number,
  pointsPerCluster: number,
  seed = 42
): GraphDataset {
  const random = makeRandom(seed)
  const count = clusterCount * pointsPerCluster
  const positions = new Float32Array(count * 2)
  const linkList: number[] = []

  for (let i = 0; i < count; i++) {
    // Start scattered: the layout should be the simulation's doing, not the
    // generator's.
    positions[i * 2] = random() * 4096
    positions[i * 2 + 1] = random() * 4096
  }

  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const base = cluster * pointsPerCluster
    for (let i = 1; i < pointsPerCluster; i++) {
      // Attach each new point to an existing one in the cluster, biased toward
      // earlier points — a cheap preferential attachment that produces hubs.
      const target = base + Math.floor(random() * random() * i)
      linkList.push(base + i, target)
    }
    // A handful of bridges to the next cluster, enough to hold the graph
    // together without dissolving the communities.
    const next = ((cluster + 1) % clusterCount) * pointsPerCluster
    for (let bridge = 0; bridge < 3; bridge++) {
      linkList.push(base + Math.floor(random() * pointsPerCluster), next + Math.floor(random() * pointsPerCluster))
    }
  }

  const degree = new Uint32Array(count)
  for (let i = 0; i < linkList.length; i += 2) {
    degree[linkList[i] as number] = (degree[linkList[i] as number] ?? 0) + 1
    degree[linkList[i + 1] as number] = (degree[linkList[i + 1] as number] ?? 0) + 1
  }

  const sizes = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    // Square root, so a hub with 100 links reads as important without becoming
    // a disc that swallows its neighbours.
    sizes[i] = 2.5 + Math.sqrt(degree[i] ?? 0) * 1.4
  }

  return {
    name: `${clusterCount} clusters`,
    description: `${count.toLocaleString()} points · ${(linkList.length / 2).toLocaleString()} links`,
    pointPositions: positions,
    links: Float32Array.from(linkList),
    pointColors: paint(count, (i) => Math.floor(i / pointsPerCluster)),
    pointSizes: sizes,
  }
}

/**
 * A large point cloud with no links — the scatter/embedding case, which skips
 * the link force entirely and shows the renderer's raw throughput.
 */
export function makePointCloud (count: number, seed = 7): GraphDataset {
  const random = makeRandom(seed)
  const positions = new Float32Array(count * 2)
  const groups = new Uint8Array(count)

  const blobs = 6
  for (let i = 0; i < count; i++) {
    const blob = Math.floor(random() * blobs)
    groups[i] = blob
    const angle = (blob / blobs) * Math.PI * 2
    const cx = 2048 + Math.cos(angle) * 1200
    const cy = 2048 + Math.sin(angle) * 1200
    // Box–Muller, so each blob is a real Gaussian rather than a uniform disc.
    const r = Math.sqrt(-2 * Math.log(1 - random())) * 260
    const theta = random() * Math.PI * 2
    positions[i * 2] = cx + r * Math.cos(theta)
    positions[i * 2 + 1] = cy + r * Math.sin(theta)
  }

  return {
    name: 'Point cloud',
    description: `${count.toLocaleString()} points · no links`,
    pointPositions: positions,
    links: new Float32Array(0),
    pointColors: paint(count, (i) => groups[i] ?? 0, 0.85),
    pointSizes: new Float32Array(count).fill(3),
  }
}

/** A lattice — a regular structure, where a wrong force reads as an obvious distortion. */
export function makeMesh (side: number): GraphDataset {
  const count = side * side
  const positions = new Float32Array(count * 2)
  const linkList: number[] = []

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x
      positions[i * 2] = 1024 + (x / side) * 2048
      positions[i * 2 + 1] = 1024 + (y / side) * 2048
      if (x < side - 1) linkList.push(i, i + 1)
      if (y < side - 1) linkList.push(i, i + side)
    }
  }

  return {
    name: 'Mesh',
    description: `${count.toLocaleString()} points · ${(linkList.length / 2).toLocaleString()} links`,
    pointPositions: positions,
    links: Float32Array.from(linkList),
    pointColors: paint(count, (i) => Math.floor((i % side) / (side / PALETTE.length))),
    pointSizes: new Float32Array(count).fill(3.5),
  }
}

export const DATASETS: (() => GraphDataset)[] = [
  () => makeClusteredGraph(6, 250),
  () => makeClusteredGraph(20, 500),
  () => makeMesh(90),
  () => makePointCloud(50000),
]
