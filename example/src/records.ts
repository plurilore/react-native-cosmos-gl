/**
 * A record-shaped dataset, for the column-mapping path.
 *
 * The typed-array datasets in `data.ts` exercise the engine directly; this one
 * exercises the layer above it — ids, column-driven colour and size, labels,
 * clusters and a temporal column — which is the form data actually arrives in.
 */

export type PersonRow = {
  id: string
  name: string
  team: string
  seniority: string
  commits: number
  joined: number
}

export type EdgeRow = {
  from: string
  to: string
  reviews: number
  kind: string
}

const TEAMS = ['Platform', 'Rendering', 'Data', 'Mobile', 'Infra', 'Design']
const SENIORITY = ['Junior', 'Mid', 'Senior', 'Staff']
const FIRST = [
  'Ada', 'Grace', 'Alan', 'Barbara', 'Katherine', 'Linus', 'Margaret', 'Dennis',
  'Radia', 'Tim', 'Anita', 'Donald', 'Frances', 'Ken', 'Shafi', 'Leslie',
  'Edsger', 'Jean', 'Vint', 'Sophie',
]
const LAST = [
  'Lovelace', 'Hopper', 'Turing', 'Liskov', 'Johnson', 'Torvalds', 'Hamilton',
  'Ritchie', 'Perlman', 'Berners-Lee', 'Borg', 'Knuth', 'Allen', 'Thompson',
  'Goldwasser', 'Lamport', 'Dijkstra', 'Bartik', 'Cerf', 'Wilson',
]

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

/**
 * Builds a collaboration graph: people on teams, linked by code review.
 *
 * Links favour same-team pairs, so the layout has communities to find and the
 * cluster force has something real to pull on.
 */
export function makeOrgGraph (peopleCount = 400, seed = 11): {
  people: PersonRow[]
  edges: EdgeRow[]
} {
  const random = makeRandom(seed)
  const people: PersonRow[] = []
  const startOfRange = Date.UTC(2018, 0, 1)
  const endOfRange = Date.UTC(2026, 0, 1)

  for (let i = 0; i < peopleCount; i++) {
    const team = TEAMS[Math.floor(random() * TEAMS.length)] as string
    people.push({
      id: `p${i}`,
      name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
      team,
      seniority: SENIORITY[Math.floor(random() * SENIORITY.length)] as string,
      // A long tail rather than a uniform spread, so the percentile clamping in
      // continuous encodings has something to actually protect against.
      commits: Math.round(Math.pow(random(), 3) * 4000) + 1,
      joined: startOfRange + random() * (endOfRange - startOfRange),
    })
  }

  const edges: EdgeRow[] = []
  const byTeam = new Map<string, PersonRow[]>()
  for (const person of people) {
    const list = byTeam.get(person.team)
    if (list) list.push(person)
    else byTeam.set(person.team, [person])
  }

  for (const person of people) {
    const teammates = byTeam.get(person.team) ?? []
    const reviewCount = 1 + Math.floor(random() * 4)
    for (let i = 0; i < reviewCount; i++) {
      // Mostly within the team, occasionally across it — the cross-team links
      // are what keep the graph connected instead of six separate islands.
      const isCrossTeam = random() < 0.15
      const pool = isCrossTeam ? people : teammates
      const other = pool[Math.floor(random() * pool.length)]
      if (!other || other.id === person.id) continue
      edges.push({
        from: person.id,
        to: other.id,
        reviews: 1 + Math.floor(Math.pow(random(), 2) * 40),
        kind: isCrossTeam ? 'cross-team' : 'in-team',
      })
    }
  }

  return { people, edges }
}
