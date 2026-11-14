// Independent checks that Dijkstra really returns the shortest paths, and that the minimax
// meeting point is really the best one.   Run:  node tests/verify_shortest_paths.js
//
// The idea: compute the same answers a second way that shares no code with Dijkstra
// (Floyd–Warshall from scratch, brute force over every path on small graphs, a plain scan
// for minimax) and require identical results.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RDV = require('../js/algorithms.js');

const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const EPS = 1e-6;
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}
const same = (a, b) => (a === Infinity && b === Infinity) || Math.abs(a - b) < EPS;

/** Floyd–Warshall written from the edge list (does not use Dijkstra or the adjacency lists). */
function floyd(graph, mode) {
  const n = graph.nodes.length, D = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n).fill(Infinity); r[i] = 0; return r; });
  for (const e of graph.edges) {
    const w = RDV.edgeSeconds(e, mode, graph.settings);
    if (!isFinite(w)) continue;
    if (w < D[e.a][e.b]) D[e.a][e.b] = w;
    if (!e.oneway && w < D[e.b][e.a]) D[e.b][e.a] = w;
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const dik = D[i][k]; if (dik === Infinity) continue;
    for (let j = 0; j < n; j++) if (dik + D[k][j] < D[i][j]) D[i][j] = dik + D[k][j];
  }
  return D;
}

/** Weight of the cheapest edge between u and v for a mode (what a path step costs). */
function stepCost(graph, mode, u, v) {
  let best = Infinity;
  for (const e of graph.edges) if ((e.a === u && e.b === v) || (!e.oneway && e.a === v && e.b === u))
    best = Math.min(best, RDV.edgeSeconds(e, mode, graph.settings));
  return best;
}

// ---------------------------------------------------------------- 1. the real campus graph
console.log('\n1. Real campus graph: Dijkstra vs Floyd–Warshall (independent)');
const g = RDV.buildGraph([load('outdoor.json'), load('indoor_batC.json')]);
const n = g.nodes.length;
const M = {};
for (const mode of RDV.MODES) {
  M[mode] = RDV.allPairs(g, mode);
  const F = floyd(g, mode);
  check(mode + ': all ' + n + ' × ' + n + ' = ' + (n * n) + ' distances identical', () => {
    let bad = 0, ex = '';
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (!same(M[mode].D[i][j], F[i][j])) {
      if (!bad) ex = g.nodes[i].id + ' -> ' + g.nodes[j].id + ': ' + M[mode].D[i][j] + ' vs ' + F[i][j];
      bad++;
    }
    assert.strictEqual(bad, 0, bad + ' differences, e.g. ' + ex);
  });
}

console.log('\n2. Every returned path is real, and costs exactly what Dijkstra says');
for (const mode of RDV.MODES) {
  check(mode + ': for all pairs, path = existing edges and sum of edges = distance', () => {
    let checkedPairs = 0;
    for (let s = 0; s < n; s++) for (let t = 0; t < n; t++) {
      const d = M[mode].D[s][t];
      const p = RDV.rebuildPath(M[mode], s, t);
      if (d === Infinity) { assert.strictEqual(p.length, 0); continue; }
      assert.strictEqual(p[0], s); assert.strictEqual(p[p.length - 1], t);
      let sum = 0;
      for (let k = 1; k < p.length; k++) {
        const c = stepCost(g, mode, p[k - 1], p[k]);
        assert(isFinite(c), 'path uses a missing or forbidden link ' + g.nodes[p[k - 1]].id + ' -> ' + g.nodes[p[k]].id);
        sum += c;
      }
      assert(same(sum, d), g.nodes[s].id + ' -> ' + g.nodes[t].id + ': path costs ' + sum + ' but distance is ' + d);
      checkedPairs++;
    }
    if (mode === 'walk') console.log('       (' + checkedPairs + ' paths rebuilt and re-added)');
  });
}

console.log('\n3. Transport rules hold on every route');
check('wheelchair: no route anywhere uses stairs, spiral or outdoor steps', () => {
  const W = M.wheelchair;
  for (let s = 0; s < n; s += 1) for (let t = 0; t < n; t += 3) {
    const p = RDV.rebuildPath(W, s, t);
    for (let k = 1; k < p.length; k++) {
      const pe = W.PE[s][p[k]], e = g.edges[pe.e];
      assert(!['stairs', 'spiral', 'stairs_outdoor'].includes(e.kind), g.nodes[s].id + ' -> ' + g.nodes[t].id + ' uses ' + e.kind);
    }
  }
});
check('walk is never slower than wheelchair (walkers can use every wheelchair route, faster)', () => {
  for (let s = 0; s < n; s++) for (let t = 0; t < n; t++) assert(M.walk.D[s][t] <= M.wheelchair.D[s][t] + EPS);
});
check('outdoors, a walking route is never shorter than the straight line (speed 1.3 m/s)', () => {
  const out = g.nodes.map((x, i) => x.layer === 'out' ? i : -1).filter(i => i >= 0);
  const R = 6371000, rad = x => x * Math.PI / 180;
  const crow = (a, b) => { const dl = rad(b.lat - a.lat), dn = rad(b.lng - a.lng);
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2)); };
  for (const s of out) for (const t of out) {
    const d = M.walk.D[s][t]; if (!isFinite(d)) continue;
    assert(d * 1.3 + 0.5 >= crow(g.nodes[s], g.nodes[t]), g.nodes[s].id + ' -> ' + g.nodes[t].id + ' shorter than a straight line');
  }
});
check('the path from A to B and from B to A take the same time (no one-way corridors)', () => {
  for (let s = 0; s < n; s++) for (let t = 0; t < s; t++) assert(same(M.walk.D[s][t], M.walk.D[t][s]));
});

console.log('\n4. Minimax really picks the best meeting place');
const meetable = g.nodes.map((x, i) => x.meetable ? i : -1).filter(i => i >= 0);
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pickable = g.nodes.map((x, i) => ['junction', 'stairs', 'spiral', 'elevator'].includes(x.type) ? -1 : i).filter(i => i >= 0);
check('500 random groups of 3 (random places and transports): no other place has a smaller longest trip', () => {
  for (let trial = 0; trial < 500; trial++) {
    const people = [0, 1, 2].map(() => ({ node: pickable[Math.floor(rnd() * pickable.length)], matrix: M[RDV.MODES[Math.floor(rnd() * 3)]] }));
    const best = RDV.meetingPoint(people, meetable)[0];
    for (const v of meetable) {                         // plain scan, written separately
      const worst = Math.max(...people.map(p => p.matrix.D[p.node][v]));
      assert(worst >= best.max - EPS, 'place ' + g.nodes[v].id + ' beats the chosen one');
      if (same(worst, best.max)) {                      // tie: the chosen one must have the smallest total
        const sum = people.reduce((s, p) => s + p.matrix.D[p.node][v], 0);
        assert(sum >= best.sum - EPS, 'tie broken wrongly at ' + g.nodes[v].id);
      }
    }
  }
});
check('three people in the same room meet in that room (if it is a meeting place)', () => {
  const room = g.index.get('C2_TP6');
  const best = RDV.meetingPoint([0, 1, 2].map(() => ({ node: room, matrix: M.walk })), meetable)[0];
  assert.strictEqual(best.node, room); assert.strictEqual(best.max, 0);
});

// ---------------------------------------------------------------- 5. random graphs vs brute force
console.log('\n5. Random small graphs: Dijkstra vs trying every possible path');
function bruteForce(nn, edges, s, t) {                 // depth-first search over all simple paths
  let best = Infinity; const seen = new Uint8Array(nn);
  const adj = Array.from({ length: nn }, () => []);
  for (const [a, b, w] of edges) { adj[a].push([b, w]); adj[b].push([a, w]); }
  (function dfs(u, d) {
    if (d >= best) return;
    if (u === t) { best = d; return; }
    seen[u] = 1;
    for (const [v, w] of adj[u]) if (!seen[v]) dfs(v, d + w);
    seen[u] = 0;
  })(s, 0);
  return best;
}
check('300 random graphs (6–9 nodes, random lengths, some disconnected): identical to brute force', () => {
  for (let trial = 0; trial < 300; trial++) {
    const nn = 6 + Math.floor(rnd() * 4), nodes = [], edges = [];
    for (let i = 0; i < nn; i++) nodes.push({ id: 'N' + i, name: 'N' + i, layer: 'out', x: rnd() * 100, y: rnd() * 100, meetable: true });
    for (let i = 0; i < nn; i++) for (let j = i + 1; j < nn; j++) if (rnd() < 0.35) edges.push([i, j, Math.round(1 + rnd() * 50)]);
    const file = { meta: {}, layers: [{ id: 'out' }], nodes,
      edges: edges.map(([a, b, w]) => ({ from: 'N' + a, to: 'N' + b, kind: 'path', length_m: w })) };
    const gg = RDV.buildGraph([file]), mm = RDV.allPairs(gg, 'walk');
    for (let s = 0; s < nn; s++) for (let t = 0; t < nn; t++) {
      const bf = bruteForce(nn, edges, s, t) / 1.3;  // walk speed
      assert(same(mm.D[s][t], bf), 'graph ' + trial + ' ' + s + '->' + t + ': ' + mm.D[s][t] + ' vs ' + bf);
    }
  }
});

console.log('\n' + passed + ' checks passed' + (failed ? ', ' + failed + ' FAILED' : ''));
process.exitCode = failed ? 1 : 0;
