// Run with:  node tests/test_algorithms.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RDV = require('../js/algorithms.js');

const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

// ---- 1. a tiny hand-made graph with a known answer -------------------------
//   A --10m-- X --10m-- B        meeting at X: max = 10 m
//             |
//            10m
//             |
//             C
const tiny = {
  meta: { scale_m_per_px: 1 }, layers: [{ id: 'out', name: 'Test' }],
  nodes: [
    { id: 'A', name: 'A', layer: 'out', x: 0,  y: 0,  meetable: true },
    { id: 'X', name: 'X', layer: 'out', x: 10, y: 0,  meetable: true },
    { id: 'B', name: 'B', layer: 'out', x: 20, y: 0,  meetable: true },
    { id: 'C', name: 'C', layer: 'out', x: 10, y: 10, meetable: true }
  ],
  edges: [
    { from: 'A', to: 'X', kind: 'path' }, { from: 'X', to: 'B', kind: 'path' },
    { from: 'X', to: 'C', kind: 'path' }
  ]
};

console.log('Tiny graph');
const tg = RDV.buildGraph([tiny]);
const tm = RDV.allPairs(tg, 'walk');
test('Dijkstra distance A->B = 20 m at 1.3 m/s', () => {
  assert(Math.abs(tm.D[0][2] - 20 / 1.3) < 1e-9);
});
test('IsTransitive finds 0 updates', () => assert.strictEqual(RDV.isTransitive(tm.D).updates, 0));
test('Minimax picks X', () => {
  const people = [0, 2, 3].map(node => ({ node, matrix: tm }));
  const best = RDV.meetingPoint(people, [0, 1, 2, 3])[0];
  assert.strictEqual(tg.nodes[best.node].id, 'X');
});
test('Path A->C goes through X', () => {
  assert.deepStrictEqual(RDV.rebuildPath(tm, 0, 3).map(i => tg.nodes[i].id), ['A', 'X', 'C']);
});
test('IsTransitive detects a broken matrix', () => {
  const D = tm.D.map(r => Float64Array.from(r));
  D[0][2] = 999; // pretend A->B was computed wrongly
  assert(RDV.isTransitive(D).updates > 0);
});

// ---- 2. the real campus graph ----------------------------------------------
console.log('Campus graph');
const g = RDV.buildGraph([load('outdoor.json'), load('indoor_batC.json')]);
const id = s => g.index.get(s);
const meetable = g.nodes.map((n, i) => n.meetable ? i : -1).filter(i => i >= 0);
const M = {};
for (const mode of RDV.MODES) M[mode] = RDV.allPairs(g, mode);
console.log('       ' + g.nodes.length + ' nodes, ' + g.edges.length + ' edges, ' + meetable.length + ' meeting places');

for (const mode of RDV.MODES) {
  test(mode + ': IsTransitive confirms the Dijkstra matrix (0 updates)', () => {
    const r = RDV.isTransitive(M[mode].D);
    assert.strictEqual(r.updates, 0, JSON.stringify(r.examples));
  });
  test(mode + ': every meeting place reachable from the bus stop', () => {
    const bad = RDV.unreachable(M[mode], [id('OUT_BUS_CAMPUS_S')], meetable);
    assert.strictEqual(bad.length, 0, bad.map(([, t]) => g.nodes[t].id).join(', '));
  });
  test(mode + ': matrix is symmetric (two-way edges)', () => {
    const D = M[mode].D;
    for (let i = 0; i < D.length; i++) for (let j = 0; j < i; j++)
      assert(Math.abs(D[i][j] - D[j][i]) < 1e-6 || (D[i][j] === Infinity && D[j][i] === Infinity), g.nodes[i].id + '/' + g.nodes[j].id);
  });
}

test('wheelchair route to the 2nd floor uses the elevator, never stairs', () => {
  const it = RDV.itinerary(g, M.wheelchair, id('OUT_BUS_CAMPUS_S'), id('C2_TP6'));
  const kinds = it.steps.map(s => s.kind);
  assert(kinds.includes('elevator'));
  assert(!kinds.includes('stairs') && !kinds.includes('spiral'));
});
test('walking route to the 2nd floor is faster than wheelchair', () => {
  assert(M.walk.D[id('OUT_BUS_CAMPUS_S')][id('C2_TP6')] < M.wheelchair.D[id('OUT_BUS_CAMPUS_S')][id('C2_TP6')]);
});
test('bike is faster than walking from IUT GACO to the bus stop', () => {
  assert(M.bike.D[id('OUT_GACO')][id('OUT_BUS_CAMPUS_S')] < M.walk.D[id('OUT_GACO')][id('OUT_BUS_CAMPUS_S')]);
});
test('demo scenario returns a finite meeting point', () => {
  const people = [
    { node: id('C2_TP6'), matrix: M.walk },
    { node: id('OUT_GACO'), matrix: M.bike },
    { node: id('OUT_AMPHI13'), matrix: M.wheelchair }
  ];
  const best = RDV.meetingPoint(people, meetable)[0];
  assert(isFinite(best.max));
  console.log('       demo meeting point: ' + g.nodes[best.node].name + ' (max ' + RDV.formatTime(best.max) + ')');
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ', some FAILED' : ''));
