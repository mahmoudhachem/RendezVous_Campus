/*
 * Rendez-vous Campus — graph model and algorithms.
 *
 *   1. buildGraph()      JSON (nodes + edges)  ->  one weighted graph per transport mode
 *   2. dijkstra()        shortest times from one node (binary-heap Dijkstra)
 *   3. allPairs()        Dijkstra from every node  ->  distance matrix D + predecessor matrix P
 *   4. isTransitive()    3-loop check: is D[i][j] <= D[i][k] + D[k][j] for every i, j, k ?
 *   5. meetingPoint()    minimax: the place that minimises the LONGEST travel time
 *   6. rebuildPath() / itinerary()   path + step-by-step directions for each person
 *
 * Weights are travel times in seconds. Unreachable = Infinity.
 * Works in the browser (window.RDV) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RDV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- settings
  const DEFAULT_SETTINGS = {
    modes: {
      walk:       { label: 'Walk',       speedIndoor: 1.3, speedOutdoor: 1.3 },
      wheelchair: { label: 'Wheelchair', speedIndoor: 1.0, speedOutdoor: 1.0 },
      // A cyclist rides outdoors, then parks and walks inside.
      bike:       { label: 'Bike',       speedIndoor: 1.3, speedOutdoor: 4.5, parkSeconds: 30 }
    },
    vertical: { stairs: 20, spiral: 25, elevator: 30 }, // seconds per floor
    elevatorWait: 20                                    // seconds, added once per elevator ride
  };
  const MODES = Object.keys(DEFAULT_SETTINGS.modes);
  const VERTICAL = { stairs: true, spiral: true, elevator: true };

  // ---------------------------------------------------------------- graph
  /**
   * Merge several JSON graph files into one graph and precompute, for every
   * mode, an adjacency list of { to, w, e, dir } (w = seconds, e = edge index).
   */
  function buildGraph(dataFiles, settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const nodes = [], edges = [], layers = [], index = new Map();
    const scaleByLayer = {};

    for (const file of dataFiles) {
      for (const l of file.layers || []) {
        layers.push(l);
        scaleByLayer[l.id] = (file.meta && file.meta.scale_m_per_px) || null;
      }
      for (const n of file.nodes) {
        if (index.has(n.id)) throw new Error('Duplicate node id: ' + n.id);
        index.set(n.id, nodes.length);
        nodes.push(n);
      }
    }
    for (const file of dataFiles) {
      for (const e of file.edges) {
        if (!index.has(e.from) || !index.has(e.to))
          throw new Error('Edge ' + e.from + ' -> ' + e.to + ' uses an unknown node');
        const a = nodes[index.get(e.from)], b = nodes[index.get(e.to)];
        let length = e.length_m;
        if (length == null && !VERTICAL[e.kind] && a.layer === b.layer && scaleByLayer[a.layer]) {
          length = Math.hypot(a.x - b.x, a.y - b.y) * scaleByLayer[a.layer];
        }
        edges.push(Object.assign({}, e, {
          a: index.get(e.from), b: index.get(e.to),
          length: length == null ? 0 : length,
          outdoor: a.layer === 'out' && b.layer === 'out',
          // a door into/out of an elevator: half the waiting time on each side,
          // so one ride costs one wait whatever the number of floors
          elevatorDoor: !VERTICAL[e.kind] && ((a.type === 'elevator') !== (b.type === 'elevator'))
        }));
      }
    }

    const adj = {};
    for (const mode of MODES) {
      adj[mode] = nodes.map(() => []);
      edges.forEach((e, ei) => {
        const w = edgeSeconds(e, mode, settings);
        if (!isFinite(w)) return;
        adj[mode][e.a].push({ to: e.b, w, e: ei, dir: 'fwd' });
        if (!e.oneway) adj[mode][e.b].push({ to: e.a, w, e: ei, dir: 'back' });
      });
    }
    return { nodes, edges, layers, index, adj, settings };
  }

  /** Travel time of one edge for one mode, in seconds (Infinity = not allowed). */
  function edgeSeconds(e, mode, settings) {
    const m = settings.modes[mode];
    if (e.access && e.access[mode] === false) return Infinity;
    if (mode === 'wheelchair' && (e.kind === 'stairs' || e.kind === 'spiral')) return Infinity;
    if (VERTICAL[e.kind]) return settings.vertical[e.kind] * (e.floors || 1);
    const speed = e.outdoor ? m.speedOutdoor : m.speedIndoor;
    let t = e.length / speed;
    if (e.kind === 'stairs_outdoor') t = e.length / (settings.modes.walk.speedIndoor * 0.55);   // steps: about half walking speed
    if (e.elevatorDoor) t += settings.elevatorWait / 2;
    if (mode === 'bike' && e.kind === 'entrance') t += m.parkSeconds || 0; // park the bike
    return t;
  }

  // ---------------------------------------------------------------- Dijkstra
  /** Minimal binary min-heap of [priority, node]. */
  class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(p, v) {
      const a = this.a; a.push([p, v]);
      let i = a.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (a[parent][0] <= a[i][0]) break;
        [a[parent], a[i]] = [a[i], a[parent]]; i = parent;
      }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
  }

  /**
   * Dijkstra from `source` on one mode's adjacency list.
   * Returns dist[v] (seconds), prev[v] (previous node) and prevEdge[v].
   * `onVisit(v, dist)` is optional, e.g. to animate the visiting order.
   */
  function dijkstra(adj, source, onVisit) {
    const n = adj.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const prevEdge = new Array(n).fill(null);
    const done = new Uint8Array(n);
    const heap = new MinHeap();
    dist[source] = 0; heap.push(0, source);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (onVisit) onVisit(u, d);
      for (const { to, w, e, dir } of adj[u]) {
        const nd = d + w;
        if (nd < dist[to]) {
          dist[to] = nd; prev[to] = u; prevEdge[to] = { e, dir };
          heap.push(nd, to);
        }
      }
    }
    return { dist, prev, prevEdge };
  }

  /** Run Dijkstra from every node: D[s][t] = shortest time, P[s] = predecessors. */
  function allPairs(graph, mode) {
    const t0 = now();
    const D = [], P = [], PE = [];
    for (let s = 0; s < graph.nodes.length; s++) {
      const r = dijkstra(graph.adj[mode], s);
      D.push(r.dist); P.push(r.prev); PE.push(r.prevEdge);
    }
    return { mode, D, P, PE, runs: graph.nodes.length, ms: now() - t0 };
  }

  // ---------------------------------------------------------------- IsTransitive
  /**
   * The professor's "IsTransitive with 3 loops" (same loops as Floyd–Warshall).
   * Works on a copy of D. If D came from Dijkstra it is already complete,
   * so the expected result is 0 updates. Any update means a data problem
   * (e.g. a one-way edge or a negative weight).
   */
  function isTransitive(D, eps) {
    eps = eps == null ? 1e-9 : eps;
    const n = D.length;
    const M = D.map(row => Float64Array.from(row));
    let updates = 0; const examples = [];
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++) {
        const dik = M[i][k]; if (dik === Infinity) continue;
        for (let j = 0; j < n; j++) {
          const via = dik + M[k][j];
          if (via + eps < M[i][j]) {
            updates++;
            if (examples.length < 5) examples.push({ i, j, k, before: M[i][j], after: via });
            M[i][j] = via;
          }
        }
      }
    return { ok: updates === 0, updates, examples, matrix: M };
  }

  // ---------------------------------------------------------------- meeting point
  /**
   * Minimax meeting point (graph 1-center restricted to `candidates`).
   * people: [{ node: index, matrix: allPairs result for that person's mode }]
   * Score of v = max_i D_i[start_i][v]; ties broken by the sum of times.
   * Returns all candidates, best first.
   */
  function meetingPoint(people, candidates) {
    const ranked = candidates.map(v => {
      const times = people.map(p => (p.extra || 0) + p.matrix.D[p.node][v]);   // extra: time to reach the campus first (GPS off campus)
      return { node: v, times, max: Math.max(...times), sum: times.reduce((s, t) => s + t, 0) };
    });
    ranked.sort((x, y) => (x.max - y.max) || (x.sum - y.sum));
    return ranked;
  }

  // ---------------------------------------------------------------- paths + directions
  /** Follow predecessors back from t to s. Returns [] if unreachable. */
  function rebuildPath(matrix, s, t) {
    if (matrix.D[s][t] === Infinity) return [];
    const prev = matrix.P[s], path = [t];
    let v = t;
    while (v !== s) { v = prev[v]; if (v < 0) return []; path.push(v); }
    return path.reverse();
  }

  /**
   * Step-by-step directions from s to t. Consecutive outdoor steps on the
   * same street are merged ("Walk along Allée Lou Blazer to Bât. C").
   */
  function itinerary(graph, matrix, s, t) {
    const path = rebuildPath(matrix, s, t);
    const steps = [];
    const verb = matrix.mode === 'bike' ? 'Ride' : matrix.mode === 'wheelchair' ? 'Go' : 'Walk';
    for (let i = 1; i < path.length; i++) {
      const u = path[i - 1], v = path[i];
      const pe = matrix.PE[s][v];
      const e = graph.edges[pe.e];
      const w = edgeSeconds(e, matrix.mode, graph.settings);
      const to = graph.nodes[v];
      const step = { from: u, to: v, seconds: w, meters: e.length, kind: e.kind,
                     layer: to.layer, fromLayer: graph.nodes[u].layer, via: e.via || null };
      const last = steps[steps.length - 1];
      if (VERTICAL[e.kind]) {
        // one step per ride, however many floors: "Take the elevator up to Bât. C · 2e."
        const word = e.kind === 'elevator' ? 'the elevator' : e.kind === 'spiral' ? 'the spiral staircase' : 'the stairs';
        const startFloor = last && last.kind === e.kind ? last.startFloor : graph.nodes[u].floor;
        const up = to.floor > startFloor ? 'up' : 'down';
        const text = 'Take ' + word + ' ' + up + ' to ' + floorName(graph, to.layer) + '.';
        if (last && last.kind === e.kind) {
          last.to = v; last.seconds += w; last.text = text; last.layer = to.layer; last.path.push(v);
          continue;
        }
        step.text = text; step.startFloor = graph.nodes[u].floor;
      } else if (e.kind === 'stairs_outdoor') {
        // OSM tells which way is up; going against the link reverses it
        const up = e.incline ? (pe.dir === 'fwd' ? e.incline === 'up' : e.incline === 'down') : null;
        step.text = (up == null ? 'Take the steps' : up ? 'Go up the steps' : 'Go down the steps') +
          (e.step_count ? ' (' + e.step_count + ' steps)' : '') + '.';
      } else if (e.instr && e.instr[pe.dir] && e.instr[pe.dir] !== 'TBD') {
        step.text = e.instr[pe.dir];
      } else if (e.via) {
        const v2 = matrix.mode === 'bike' && e.outdoor ? 'Ride' : (matrix.mode === 'bike' ? 'Walk' : verb);
        step.text = v2 + ' along ' + e.via + ' to ' + to.name + '.';
      } else {
        step.text = 'Go to ' + to.name + '.';
      }
      // merge consecutive steps on the same outdoor street
      if (last && e.via && last.via === e.via && !e.instr && last.kind === e.kind) {
        last.to = v; last.seconds += w; last.meters += e.length;
        last.text = last.text.replace(/ to .*\.$/, ' to ' + to.name + '.');
        last.path.push(v);
      } else {
        step.path = [u, v];
        steps.push(step);
      }
    }
    // A street step that ends at a plain junction names the next street instead
    // ("Walk along Allée Lou Blazer to the junction with the entrance path.")
    steps.forEach((st, i) => {
      const end = graph.nodes[st.to];
      if (!st.via || end.type !== 'junction') return;
      const next = steps[i + 1];
      st.text = st.text.replace(/ to .*\.$/, next && next.via && next.via !== st.via
        ? ' to the junction with ' + next.via + '.' : '.');
    });
    return { path, steps, seconds: matrix.D[s][t] };
  }

  function floorName(graph, layerId) {
    const l = graph.layers.find(x => x.id === layerId);
    return l ? l.name : layerId;
  }

  /** Is every candidate reachable from every node? Returns unreachable pairs (for tests/debug). */
  function unreachable(matrix, from, to) {
    const out = [];
    for (const s of from) for (const t of to) if (matrix.D[s][t] === Infinity) out.push([s, t]);
    return out;
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return 'unreachable';
    sec = Math.round(sec);
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? m + ' min ' + String(s).padStart(2, '0') + ' s' : m + ' min';
  }

  function now() { return (typeof performance !== 'undefined' ? performance : Date).now(); }

  return { DEFAULT_SETTINGS, MODES, buildGraph, edgeSeconds, dijkstra, allPairs, isTransitive,
           meetingPoint, rebuildPath, itinerary, unreachable, formatTime, MinHeap };
});
