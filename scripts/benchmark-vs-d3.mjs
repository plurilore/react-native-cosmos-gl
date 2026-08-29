#!/usr/bin/env node
/**
 * Compares this engine against the common React Native alternative — d3-force
 * on the JS thread, drawn with react-native-skia — on the work that can be
 * measured off-device.
 *
 * That combination is the default answer for graphs in React Native, and it
 * has a very different performance shape: d3-force ticks in JavaScript, and a
 * declarative canvas reconciles one element per node and per edge on every
 * visual update. Both costs land on the thread that also runs the app.
 *
 * What this measures honestly:
 *   - d3-force simulation cost per tick, with a force set typical of a
 *     node-link layout (links, charge, collision, centering).
 *   - This engine's per-frame CPU cost, GPU pass count and texture memory, via
 *     the mock context the test suite uses.
 *   - The element count each approach reconciles per visual update.
 *
 * What it does NOT measure: GPU shader time, Hermes-vs-V8 differences, or real
 * device frame rates. Those need hardware. The JS-thread numbers are the half
 * of the comparison that transfers — and on React Native the JS thread is
 * usually the half that hurts.
 *
 * Run with `npm run bench`, or `npm run bench -- --collision` to include the
 * collision force on both sides.
 */
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  forceX,
  forceY,
} from 'd3-force'

const SIZES = [200, 900, 2000, 5000, 20000]
/**
 * Whether to enable the collision force.
 *
 * Off by default because it is the most memory-hungry force: the spatial grid
 * is built four times at half-cell offsets to catch pairs straddling a cell
 * boundary, so its cost is four grids rather than one.
 */
const WITH_COLLISION = process.argv.includes('--collision')

/**
 * Where a JS-thread simulation typically has to stop.
 *
 * Marked in the report because it is the practical ceiling of the d3-force
 * approach rather than an arbitrary size: past roughly this point a tick no
 * longer fits alongside everything else the thread is doing.
 */
const JS_PRACTICAL_CEILING = 900

function makeRandom (seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A clustered graph with a realistic edge-to-node ratio (~3). */
function makeGraph (nodeCount, seed = 7) {
  const random = makeRandom(seed)
  const nodes = []
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({ id: `n${i}`, radius: 4 + random() * 12, type: i % 50 === 0 ? 'hub' : 'leaf' })
  }
  const edges = []
  const edgesPerNode = 3
  for (let i = 1; i < nodeCount; i++) {
    for (let e = 0; e < edgesPerNode; e++) {
      // Preferential-ish attachment, so degree is skewed like a real graph
      // rather than uniform — which is what makes the quadtree's work realistic.
      const target = Math.floor(random() * random() * i)
      // Two edge kinds, so the link force has a distance to vary — the shape
      // most node-link layouts have, whatever the domain.
      edges.push({ source: `n${i}`, target: `n${target}`, relation: e === 0 ? 'primary' : 'secondary' })
    }
  }
  return { nodes, edges }
}

/**
 * A force set typical of a node-link layout.
 *
 * Links, charge, collision and centering — the combination most d3-force graph
 * setups use, with strengths in the usual range. The repulsion step-down by
 * size mirrors what implementations do to stay interactive as graphs grow.
 */
function buildD3Simulation (graph) {
  const nodes = graph.nodes.map((n) => ({ ...n, x: Math.random() * 1600, y: Math.random() * 1600 }))
  const ids = new Set(nodes.map((n) => n.id))
  const links = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ ...e }))
  const repulsion = nodes.length > 600 ? -34 : nodes.length > 250 ? -48 : -72

  const simulation = forceSimulation(nodes)
    .alpha(0.92)
    .alphaDecay(0.035)
    .velocityDecay(0.36)
    .force('links', forceLink(links).id((n) => n.id)
      .distance((l) => (l.relation === 'primary' ? 82 : 62)).strength(0.16))
    .force('charge', forceManyBody().strength(repulsion).distanceMin(12).distanceMax(460))
    .force('collision', forceCollide().radius((n) => n.radius + 6).strength(1).iterations(2))
    .force('center', forceCenter(800, 800).strength(0.055))
    .force('x', forceX(800).strength(0.008))
    .force('y', forceY(800).strength(0.008))
  simulation.stop()
  return simulation
}

function timeIt (fn, runs) {
  // One untimed run so JIT warm-up does not land in the first sample.
  fn()
  const samples = []
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return {
    median: samples[Math.floor(samples.length / 2)],
    p95: samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1],
  }
}

console.log('\n=== d3-force: cost of ONE simulation tick (JS thread) ===\n')
console.log('nodes'.padStart(7), 'edges'.padStart(7), 'median ms'.padStart(11), 'p95 ms'.padStart(9), 'ticks/s'.padStart(9), '  budget @60fps')

const d3Results = []
for (const size of SIZES) {
  const graph = makeGraph(size)
  const simulation = buildD3Simulation(graph)
  // Fewer runs at large sizes: a single 20k tick is already ~a second.
  const runs = size >= 20000 ? 3 : size >= 5000 ? 5 : 15
  const { median, p95 } = timeIt(() => simulation.tick(1), runs)
  const ticksPerSecond = 1000 / median
  const budget = median <= 16.7 ? 'fits' : `${(median / 16.7).toFixed(1)}x over`
  d3Results.push({ size, edges: graph.edges.length, median, p95 })
  console.log(
    String(size).padStart(7),
    String(graph.edges.length).padStart(7),
    median.toFixed(2).padStart(11),
    p95.toFixed(2).padStart(9),
    ticksPerSecond.toFixed(0).padStart(9),
    '  ' + budget
  )
}

console.log(`\n=== react-native-cosmos: per-frame JS cost and GPU passes${WITH_COLLISION ? ' (collision ON)' : ' (collision off)'} ===\n`)

const { createMockGL } = await import('../src/__tests__/mock-gl.ts')
const { Graph } = await import('../src/core/graph.ts')

console.log(
  'nodes'.padStart(7), 'edges'.padStart(7), 'frame ms'.padStart(10),
  'p95 ms'.padStart(9), 'GPU passes'.padStart(11), 'GPU mem'.padStart(10), '  budget @60fps'
)

const cosmosResults = []
for (const size of SIZES) {
  const graph = makeGraph(size)
  const positions = new Float32Array(size * 2)
  const random = makeRandom(11)
  for (let i = 0; i < size * 2; i++) positions[i] = random() * 4096
  const idToIndex = new Map(graph.nodes.map((n, i) => [n.id, i]))
  const links = new Float32Array(graph.edges.length * 2)
  graph.edges.forEach((e, i) => {
    links[i * 2] = idToIndex.get(e.source)
    links[i * 2 + 1] = idToIndex.get(e.target)
  })

  const { gl, record } = createMockGL()
  const engine = new Graph(gl, { simulationCollision: WITH_COLLISION ? 1 : 0 })
  engine.setSize(400, 800)
  engine.setPointPositions(positions)
  engine.setLinks(links)
  engine.start()
  engine.render([0, 0, 800, 1600])

  const before = record.drawCalls
  engine.render([0, 0, 800, 1600])
  const passes = record.drawCalls - before

  const runs = size >= 20000 ? 5 : 15
  const { median, p95 } = timeIt(() => engine.render([0, 0, 800, 1600]), runs)
  const budget = median <= 16.7 ? 'fits' : `${(median / 16.7).toFixed(1)}x over`
  const megabytes = record.peakTextureBytes / (1024 * 1024)
  cosmosResults.push({ size, edges: graph.edges.length, median, p95, passes, megabytes })
  console.log(
    String(size).padStart(7),
    String(graph.edges.length).padStart(7),
    median.toFixed(2).padStart(10),
    p95.toFixed(2).padStart(9),
    String(passes).padStart(11),
    (megabytes.toFixed(1) + ' MB').padStart(10),
    '  ' + budget
  )
  engine.destroy()
}

console.log('\n=== Per visual update: elements reconciled ===\n')
console.log('nodes'.padStart(7), 'edges'.padStart(7), 'declarative canvas'.padStart(20), 'this engine'.padStart(13))
for (const { size, edges } of d3Results) {
  // A declarative canvas draws one element per node and per edge, so the tree
  // it reconciles is the graph itself. This engine draws the whole graph from
  // one view whose contents never change.
  console.log(
    String(size).padStart(7),
    String(edges).padStart(7),
    String(size + edges).padStart(20),
    String(1).padStart(13)
  )
}

console.log('\n=== Side by side ===\n')
for (let i = 0; i < d3Results.length; i++) {
  const d3 = d3Results[i]
  const cosmos = cosmosResults[i]
  const ratio = d3.median / cosmos.median
  const marker = d3.size === JS_PRACTICAL_CEILING ? '  <- typical JS-thread ceiling' : ''
  console.log(
    `${String(d3.size).padStart(6)} nodes:  d3-force ${d3.median.toFixed(2)}ms/tick  vs  cosmos ${cosmos.median.toFixed(2)}ms/frame` +
    `  =  ${ratio.toFixed(1)}x${marker}`
  )
}

console.log('\n=== Where cosmos costs MORE: GPU memory ===\n')
console.log('This engine keeps positions, velocities and per-point channels in float')
console.log('textures, plus force scratch buffers and a picking buffer. d3-force holds')
console.log('plain JS objects, so its memory scales with the graph and nothing else.\n')
for (const c of cosmosResults) {
  // Two floats per node in a JS object graph, plus object overhead — a
  // deliberately generous floor for the d3 side rather than a precise figure.
  const d3Estimate = (c.size * 120 + c.edges * 80) / (1024 * 1024)
  console.log(
    `${String(c.size).padStart(6)} nodes:  cosmos ${c.megabytes.toFixed(1)} MB GPU` +
    `   vs  d3-force ~${d3Estimate.toFixed(1)} MB JS heap (rough)`
  )
}

console.log(
  '\nd3-force numbers are one tick. A settling simulation runs many per second,\n' +
  'so multiply by the tick rate to get the share of the JS thread it occupies.\n'
)
