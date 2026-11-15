/*
 * Rendez-vous Campus — user interface.
 * Depends on Leaflet (global L) and js/algorithms.js (global RDV).
 * Data comes from window.CAMPUS_DATA (single-file build) or from data/*.json.
 */
(async function () {
  'use strict';

  // ------------------------------------------------------------------ data
  const data = window.CAMPUS_DATA || {
    outdoor: await fetch('data/outdoor.json').then(r => r.json()),
    indoor: await fetch('data/indoor_batC.json').then(r => r.json())
  };
  const graph = RDV.buildGraph([data.outdoor, data.indoor]);
  const N = graph.nodes;
  const idx = id => graph.index.get(id);

  // All-pairs Dijkstra once per mode, then IsTransitive as a check.
  const matrices = {}, checks = {};
  for (const mode of RDV.MODES) {
    matrices[mode] = RDV.allPairs(graph, mode);
    const t0 = performance.now();
    checks[mode] = RDV.isTransitive(matrices[mode].D);
    checks[mode].ms = performance.now() - t0;
  }
  const candidates = N.map((n, i) => (n.meetable ? i : -1)).filter(i => i >= 0);

  const LAYER_SHORT = { out: 'Campus', C0: 'RDC', C1: '1er', C2: '2e' };
  const MODE_LABEL = { walk: 'Walk', wheelchair: 'Wheelchair', bike: 'Bike' };
  const PICKABLE = n => !['junction', 'stairs', 'spiral', 'elevator'].includes(n.type);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ------------------------------------------------------------------ state
  const KEYS = 'ABCDEF', MIN_PEOPLE = 2, MAX_PEOPLE = KEYS.length;
  const START_AT = ['C2_TP6', 'OUT_RESTO', 'OUT_AMPHI13', 'OUT_BU', 'OUT_MEMO', 'OUT_GACO'];
  const START_MODE = ['walk', 'bike', 'wheelchair', 'walk', 'walk', 'walk'];
  const makePerson = i => ({ key: KEYS[i], colorVar: '--p' + KEYS[i].toLowerCase(),
    node: idx(START_AT[i]) != null ? idx(START_AT[i]) : idx('OUT_BU'), mode: START_MODE[i], gps: null });
  const DEFAULT_PEOPLE = [0, 1, 2].map(makePerson);
  /** Change how many people meet; the ones already set keep their place. */
  function setCount(n) {
    n = Math.max(MIN_PEOPLE, Math.min(MAX_PEOPLE, n));
    while (state.people.length < n) state.people.push(makePerson(state.people.length));
    state.people.length = n;
  }
  const state = {
    people: loadPeople() || DEFAULT_PEOPLE.map(p => Object.assign({}, p)),
    layer: 'out',
    picking: null,      // index of the person whose position is being tapped
    chosen: null,       // meeting point picked by hand from the table (null = best)
    showGraph: false,
    goal: 'fair',       // how the meeting point is chosen: fair (minimax) | total (min-sum) | me (closest to me)
    heat: false,        // fairness map shown
    single: null        // { from, to, mode } when opened from a shared route link
  };

  function loadPeople() {
    try {
      const saved = JSON.parse(localStorage.getItem('rdv-people') || 'null');
      if (!Array.isArray(saved) || saved.length < MIN_PEOPLE || saved.length > MAX_PEOPLE) return null;
      return saved.map((sv, i) => {
        const node = idx(sv.id);
        return Object.assign(makePerson(i), node == null ? {} : { node, mode: sv.mode });
      });
    } catch (e) { return null; }
  }
  function savePeople() {
    try {
      localStorage.setItem('rdv-people', JSON.stringify(state.people.map(p => ({ id: N[p.node].id, mode: p.mode }))));
    } catch (e) { /* storage unavailable: fine */ }
  }

  // ------------------------------------------------------------------ map
  // Everything is in real coordinates (lat/lng). The campus is drawn from OpenStreetMap data
  // shipped with the app, so it works offline; real map tiles can be switched on when online.
  const map = L.map('map', { zoomSnap: 0.25, maxZoom: 21, zoomControl: false, attributionControl: true });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  const PHONE = window.matchMedia('(max-width: 760px)');
  const $sheet = document.getElementById('sheet');
  /** Map padding so fitted content is not hidden under the planner (left card or bottom sheet). */
  function fitPad() {
    if (PHONE.matches) return { paddingTopLeft: [16, 64], paddingBottomRight: [76, $sheet.offsetHeight + 16] };
    return { paddingTopLeft: [$sheet.offsetWidth + 40, 70], paddingBottomRight: [84, 24] };
  }
  map.attributionControl.setPrefix(false);
  map.attributionControl.addAttribution('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');
  const ll = n => [n.lat, n.lng];
  const layerGroups = {};
  const baseGroup = L.layerGroup().addTo(map);
  const routeGroup = L.layerGroup().addTo(map);
  const markerGroup = L.layerGroup().addTo(map);
  const graphGroup = L.layerGroup().addTo(map);
  const playGroup = L.layerGroup().addTo(map);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 21, className: 'osm-tiles' });

  // edge lookup for drawing a route along the real shape of each path
  const edgeOf = new Map();
  graph.edges.forEach((e, i) => {
    for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
      const k = u + '|' + v, old = edgeOf.get(k);
      if (old == null || graph.edges[old].length > e.length) edgeOf.set(k, i);
    }
  });
  function segment(u, v) {
    const e = graph.edges[edgeOf.get(u + '|' + v)];
    if (!e || !e.geometry) return [ll(N[u]), ll(N[v])];
    return e.a === u ? e.geometry : e.geometry.slice().reverse();
  }
  const pathLatLngs = run => run.slice(1).reduce((pts, v, i) => pts.concat(segment(run[i], v).slice(1)), [ll(N[run[0]])]);

  function buildBaseLayers() {
    const bm = data.outdoor.basemap;
    for (const p of bm.paths) baseGroup.addLayer(L.polyline(p.line, { className: 'bm-' + p.kind, interactive: false,
      weight: p.kind === 'road' ? 7 : p.kind === 'steps' ? 3 : 3, lineCap: 'round', lineJoin: 'round', dashArray: p.kind === 'steps' ? '2 3' : null }));
    for (const b of bm.buildings) {
      baseGroup.addLayer(L.polygon(b.poly, { className: 'bm-building' + (b.uni ? ' bm-uni' : ''), weight: 1, interactive: false }));
    }
    // labels for the campus buildings that are meeting places or named
    const labels = L.layerGroup();
    for (const n of N) if (n.layer === 'out' && n.type === 'building')   // small dot = the door used for routing
      labels.addLayer(L.circleMarker(ll(n), { radius: 3.5, weight: 1.5, className: 'bm-door', interactive: false }));
    for (const n of N) if (n.layer === 'out' && n.type === 'building') labels.addLayer(L.marker(ll(n), { interactive: false,
      icon: L.divIcon({ className: 'bm-label', html: '<span>' + esc(n.name.replace('UFR STGI – ', '')) + '</span>', iconSize: null }) }));
    const hall = N[idx('C0_HALL')];
    labels.addLayer(L.marker(ll(hall), { interactive: false, icon: L.divIcon({ className: 'bm-label bm-label-c', html: '<span>Bât. C (UFR STGI)</span>', iconSize: null }) }));
    layerGroups.out = labels;
    const outN = N.filter(n => n.layer === 'out' && n.type !== 'junction');
    layerGroups.out.bounds = L.latLngBounds(outN.map(ll)).pad(0.04);
    layerGroups.out.maxBounds = L.latLngBounds(bm.bounds).pad(0.3);

    for (const layer of graph.layers.filter(l => l.id !== 'out')) {
      const g = L.layerGroup();
      const ns = N.filter(n => n.layer === layer.id);
      const areas = (data.indoor.areas || []).filter(a => a.layer === layer.id);
      // Floor drawn like the evacuation plan, at its real place on the campus.
      for (const a of areas) {
        const n = a.node != null ? N[idx(a.node)] : null;
        g.addLayer(L.polygon(a.poly, { interactive: false, weight: a.kind === 'corridor' ? 0 : 1.5,
          className: 'area area-' + a.kind + (n && n.meetable && a.kind === 'room' ? ' area-meetable' : '') }));
        const c = a.poly.reduce((s, p) => [s[0] + p[0] / a.poly.length, s[1] + p[1] / a.poly.length], [0, 0]);
        const text = a.label || (n && (n.code || n.short || n.name.replace(/\s*\(.*\)$/, '').replace(/^Office.*/, 'Office')));
        if (text) g.addLayer(L.marker(c, { interactive: false, icon: L.divIcon({
          className: 'room-label' + (a.kind === 'room' ? '' : ' room-label-minor'), html: '<span>' + esc(text) + '</span>', iconSize: null }) }));
      }
      for (const n of ns) {
        if (n.type === 'spiral') g.addLayer(L.marker(ll(n), { interactive: false, icon: L.divIcon({ className: 'fixture fixture-spiral', html: 'Spiral', iconSize: null }) }));
        if (n.type === 'entrance') g.addLayer(L.marker(ll(n), { interactive: false, icon: L.divIcon({ className: 'fixture fixture-door', html: esc(n.short || 'Door'), iconSize: null }) }));
      }
      g.bounds = L.latLngBounds(areas.flatMap(a => a.poly)).pad(0.06);
      layerGroups[layer.id] = g;
    }
  }

  // ------------------------------------------------------------------ view switch: Plan / Street / 3D
  let view = 'plan';
  document.getElementById('map-style').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-view]'); if (!b) return;
    setView(b.dataset.view);
  });
  function setView(v) {
    if (playing && playing.kind === 'play' && v !== view) stopPlayback();
    view = v;
    document.querySelectorAll('#map-style button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.view === v)));
    const $m = document.getElementById('map'), $3 = document.getElementById('map3d');
    if (v === '3d') {
      $m.hidden = true; $3.hidden = false;
      open3D();
    } else {
      $3.hidden = true; $m.hidden = false;
      if (v === 'street') tiles.addTo(map); else map.removeLayer(tiles);
      $m.classList.toggle('street', v === 'street');
      map.invalidateSize();
    }
  }

  // ------------------------------------------------------------------ 3D view (MapLibre GL)
  // Campus buildings raised from their OSM outlines; Bât. C floors stacked (spaced out so each
  // floor is visible); routes drawn as ribbons on their floor, with a column where they change floor.
  const ML = { js: 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js' };
  const FLOOR_H = 6;                                    // meters between floors in 3D (real ≈ 3.5, spaced out)
  const O = data.outdoor.meta.origin, PHI = O.lat * Math.PI / 180;
  const KYm = 111132.954 - 559.822 * Math.cos(2 * PHI) + 1.175 * Math.cos(4 * PHI), KXm = 111412.84 * Math.cos(PHI) - 93.5 * Math.cos(3 * PHI);
  const toM = p => [(p[1] - O.lng) * KXm, (p[0] - O.lat) * KYm];          // [lat,lng] -> meters
  const toLngLat = p => [O.lng + p[0] / KXm, O.lat + p[1] / KYm];         // meters -> [lng,lat]
  const floorOf = layer => layer === 'out' ? 0 : +layer.slice(1);
  let map3d = null, map3dReady = false;

  function loadScript(src) {
    return new Promise((ok, fail) => {
      if (window.maplibregl) return ok();
      const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = fail;
      document.head.appendChild(el);
    });
  }
  function hex(c) {                                     // css colour token -> [r,g,b]
    c = c.trim(); if (c[0] === '#') { if (c.length === 4) c = '#' + [...c.slice(1)].map(x => x + x).join(''); return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); }
    const m = c.match(/\d+/g); return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }
  const mix = (a, b, t) => { const A = hex(css(a)), B = hex(css(b)); return 'rgb(' + A.map((v, i) => Math.round(v * (1 - t) + B[i] * t)).join(',') + ')'; };
  const tok = name => 'rgb(' + hex(css(name)).join(',') + ')';

  const ext = (ring, color, base, height) => ({ type: 'Feature', properties: { color, base, height }, geometry: { type: 'Polygon', coordinates: [ring] } });
  const fc = features => ({ type: 'FeatureCollection', features });
  function ribbon(latlngs, width) {
    const out = [], P = latlngs.map(toM);
    for (let i = 1; i < P.length; i++) {
      const [x1, y1] = P[i - 1], [x2, y2] = P[i], dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy);
      if (L < 0.01) continue;
      const nx = -dy / L * width / 2, ny = dx / L * width / 2, ex = dx / L * width / 2, ey = dy / L * width / 2;
      out.push([[x1 - ex + nx, y1 - ey + ny], [x2 + ex + nx, y2 + ey + ny], [x2 + ex - nx, y2 + ey - ny], [x1 - ex - nx, y1 - ey - ny], [x1 - ex + nx, y1 - ey + ny]].map(toLngLat));
    }
    return out;
  }
  function square(latlng, size) {
    const [x, y] = toM(latlng), h = size / 2;
    return [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h], [x - h, y - h]].map(toLngLat);
  }
  function inset(poly, d) {                             // shrink a room a little so walls show as gaps
    const P = poly.map(toM), cx = P.reduce((s, p) => s + p[0], 0) / P.length, cy = P.reduce((s, p) => s + p[1], 0) / P.length;
    const ring = P.map(([x, y]) => { const L = Math.hypot(x - cx, y - cy) || 1; return toLngLat([x - (x - cx) / L * d, y - (y - cy) / L * d]); });
    return ring.concat([ring[0]]);
  }

  function campus3D() {
    const isC = b => b.batc;                            // the real Bât. C is drawn floor by floor instead
    return fc(data.outdoor.basemap.buildings.filter(b => !isC(b)).map(b =>
      ext(b.poly.map(p => [p[1], p[0]]), b.uni ? mix('--room', '--pa', 0.25) : tok('--room'), 0, b.uni ? 11 : 7)));
  }
  function paths3D() {
    return fc(data.outdoor.basemap.paths.map(p => ({ type: 'Feature', properties: { kind: p.kind },
      geometry: { type: 'LineString', coordinates: p.line.map(q => [q[1], q[0]]) } })));
  }
  function floor3D(layerId) {
    const f = floorOf(layerId), z = f * FLOOR_H, feats = [];
    for (const a of data.indoor.areas.filter(x => x.layer === layerId)) {
      const n = a.node ? N[idx(a.node)] : null;
      if (a.kind === 'void') continue;
      if (a.kind === 'elevator') { if (layerId === 'C0') feats.push(ext(inset(a.poly, 0.15), mix('--room', '--ink', 0.35), 0, 2 * FLOOR_H + 3)); continue; }  // lift shaft through all floors
      const color = a.kind === 'corridor' ? tok('--corridor') : a.kind === 'room' ? (n && n.meetable ? mix('--floor', '--meet', 0.18) : tok('--floor'))
        : a.kind === 'stairs' ? mix('--room', '--ink', 0.25) : tok('--room');
      feats.push(ext(a.kind === 'corridor' ? a.poly.concat([a.poly[0]]).map(p => [p[1], p[0]]) : inset(a.poly, 0.25), color, z, z + (a.kind === 'corridor' ? 0.2 : 1.4)));
    }
    return fc(feats);
  }
  function routes3D() {
    const feats = [];
    if (!result || state.stale) return fc(feats);
    const shown = result.single ? [0] : state.people.map((p, i) => i);
    shown.forEach((pi, k) => {
      const path = result.routes[k].path, color = result.single ? css('--pa') : personColor(pi), w = Math.max(0.7, 1.6 - 0.25 * k);
      for (let i = 1; i < path.length; i++) {
        const u = N[path[i - 1]], v = N[path[i]];
        const fu = floorOf(u.layer), fv = floorOf(v.layer);
        if (u.layer !== v.layer && u.layer !== 'out' && v.layer !== 'out') {
          feats.push(ext(square(ll(u), 1.6), color, Math.min(fu, fv) * FLOOR_H, Math.max(fu, fv) * FLOOR_H + 1.2));  // stairs / lift
        } else {
          const z = Math.max(fu, fv) * FLOOR_H + 0.3;
          for (const r of ribbon(segment(path[i - 1], path[i]), w)) feats.push(ext(r, color, z, z + 1.6));
        }
      }
      const s = N[path[0]] || N[state.people[pi] ? state.people[pi].node : 0];
      if (s) { const z = floorOf(s.layer) * FLOOR_H; feats.push(ext(square(ll(s), 2.4), color, z + 0.5, z + 5)); }
    });
    if (!result.single) state.people.forEach((p, i) => {
      if (result.routes[i].path.length) return;
      const s = N[p.node], z = floorOf(s.layer) * FLOOR_H; feats.push(ext(square(ll(s), 2.4), personColor(i), z + 0.5, z + 5));
    });
    const m = N[result.meet.node];
    if (m && isFinite(result.meet.max === undefined ? 0 : result.meet.max)) {
      const z = floorOf(m.layer) * FLOOR_H; feats.push(ext(square(ll(m), 3.4), css('--meet'), z + 0.5, z + 9));
    }
    return fc(feats);
  }

  async function open3D() {
    const $3 = document.getElementById('map3d');
    if (map3d) { map3d.resize(); refresh3D(); return; }
    $3.innerHTML = '<p class="map3d-msg">Loading the 3D view…</p>';
    try { await loadScript(ML.js); } catch (e) { $3.innerHTML = '<p class="map3d-msg">The 3D view needs an internet connection the first time (to load MapLibre).</p>'; return; }
    $3.innerHTML = '';
    const cBat = N[idx('C0_HALL')];
    try {
      map3d = new maplibregl.Map({
        container: $3, attributionControl: false, center: [cBat.lng, cBat.lat], zoom: 17.4, pitch: 58, bearing: -16, maxPitch: 75,
        style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': tok('--map-bg') } }] }
      });
    } catch (e) { $3.innerHTML = '<p class="map3d-msg">This browser cannot show 3D (WebGL is off).</p>'; map3d = null; return; }
    map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map3d.on('dragstart', () => { userMovedAt = performance.now(); });
    map3d.on('rotatestart', e => { if (e.originalEvent) userMovedAt = performance.now(); });
    map3d.on('zoomstart', e => { if (e.originalEvent) userMovedAt = performance.now(); });
    map3d.on('move', liftWalker);
    pad3D();
    map3d.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors' }));
    map3d.on('load', () => {
      const extr = (id, source, opacity) => map3d.addLayer({ id, type: 'fill-extrusion', source, paint: {
        'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-opacity': opacity, 'fill-extrusion-vertical-gradient': true } });
      map3d.addSource('paths', { type: 'geojson', data: paths3D() });
      map3d.addLayer({ id: 'paths', type: 'line', source: 'paths', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['match', ['get', 'kind'], 'road', tok('--road'), tok('--path')], 'line-width': ['match', ['get', 'kind'], 'road', 6, 2.5] } });
      map3d.addSource('campus', { type: 'geojson', data: campus3D() }); extr('campus', 'campus', 0.55);
      for (const l of ['C0', 'C1', 'C2']) { map3d.addSource('floor-' + l, { type: 'geojson', data: floor3D(l) }); extr('floor-' + l, 'floor-' + l, 0.95); }
      map3d.addSource('routes', { type: 'geojson', data: routes3D() }); extr('routes', 'routes', 1);
      map3d.addSource('playdot', { type: 'geojson', data: fc([]) }); extr('playdot', 'playdot', 1);
      map3dReady = true; refresh3D();
    });
  }

  function refresh3D(recolor, fly = true) {
    if (!map3d || !map3dReady) return;
    if (recolor) {
      map3d.setPaintProperty('bg', 'background-color', tok('--map-bg'));
      map3d.setPaintProperty('paths', 'line-color', ['match', ['get', 'kind'], 'road', tok('--road'), tok('--path')]);
      map3d.getSource('campus').setData(campus3D());
      for (const l of ['C0', 'C1', 'C2']) map3d.getSource('floor-' + l).setData(floor3D(l));
    }
    map3d.getSource('routes').setData(routes3D());
    // the chosen floor stands out; floors above it fade so you can look inside
    const sel = state.layer === 'out' ? null : floorOf(state.layer);
    const walking = playing && playing.kind === 'play';
    map3d.setPaintProperty('campus', 'fill-extrusion-opacity', walking ? 0.22 : sel == null ? 0.55 : 0.18);
    if (fly && map3d.lastLayer !== state.layer) {
      const c = N[idx('C0_HALL')];
      map3d.easeTo(sel == null ? { center: [c.lng, c.lat], zoom: 17.4, pitch: 58, bearing: -16 }
        : { center: [c.lng, c.lat], zoom: 19.2, pitch: 60, bearing: -16 + 25, duration: 900 });
      map3d.lastLayer = state.layer;
    }
    ['C0', 'C1', 'C2'].forEach(l => {
      const f = floorOf(l);
      map3d.setPaintProperty('floor-' + l, 'fill-extrusion-opacity', sel == null ? 0.9 : f === sel ? 1 : f > sel ? 0.1 : 0.45);
    });
  }


  function showLayer(id, fit) {
    for (const k in layerGroups) map.removeLayer(layerGroups[k]);
    layerGroups[id].addTo(map);
    layerGroups[id].bringToBack && layerGroups[id].bringToBack();
    state.layer = id;
    document.getElementById('map').classList.toggle('indoor', id !== 'out');
    map.setMaxBounds(null);
    if (fit !== false) map.fitBounds(layerGroups[id].bounds, Object.assign({ animate: false }, fitPad()));
    map.setMaxBounds(layerGroups.out.maxBounds);          // same generous limit everywhere: sliding never bounces back
    renderTabs(); drawRoutes(); drawGraph();
  }

  // ------------------------------------------------------------------ compute
  function compute() {
    const people = state.people.map(p => ({ node: p.node, matrix: matrices[p.mode], extra: approachSeconds(p) }));
    const ranked = RDV.meetingPoint(people, candidates);       // minimax order: max, then sum
    const me = myIndex(), goal = state.goal;
    if (goal === 'total') ranked.sort((x, y) => (x.sum - y.sum) || (x.max - y.max));
    else if (goal === 'me') ranked.sort((x, y) => (x.times[me] - y.times[me]) || (x.max - y.max));
    const best = ranked[0];
    const meet = state.chosen != null ? ranked.find(r => r.node === state.chosen) || best : best;
    const routes = state.people.map((p, i) => {
      const r = RDV.itinerary(graph, matrices[p.mode], p.node, meet.node), extra = people[i].extra;
      return extra ? Object.assign({}, r, { seconds: r.seconds + extra, approach: { seconds: extra, m: p.gps.m, off: p.gps.off } }) : r;
    });
    return { ranked, best, meet, routes };
  }

  let result = null;
  function update() {
    stopWave();
    if (state.single) {
      const { from, to, mode } = state.single;
      result = { single: true, meet: { node: to }, routes: [RDV.itinerary(graph, matrices[mode], from, to)] };
    } else {
      result = compute();
      state.stale = false;
      savePeople();
    }
    renderPanel(); renderTabs(); drawRoutes();
    if (state.heat && !legendShown()) showLegend();
  }

  // ------------------------------------------------------------------ drawing
  function personColor(i) { return css(state.people[i].colorVar); }
  const visibleHere = n => n.layer === state.layer || state.layer === 'out';
  const floorTag = n => n.layer !== state.layer ? '<small>' + LAYER_SHORT[n.layer] + '</small>' : '';
  function personPin(n, letter, color) {
    return L.marker(ll(n), { zIndexOffset: 500, icon: L.divIcon({ className: 'pin' + (n.layer !== state.layer ? ' pin-inside' : ''),
      html: '<span style="background:' + color + '">' + letter + '</span>' + floorTag(n), iconSize: [30, 30], iconAnchor: [15, 15] }) })
      .bindTooltip(esc(n.name) + (n.layer !== 'out' ? ' · ' + esc(layerName(n.layer)) : ''));
  }

  function drawRoutes() {
    if (view === '3d') refresh3D();
    if (state.stale) { heatGroup.clearLayers(); return drawPending(); }
    routeGroup.clearLayers(); markerGroup.clearLayers();
    if (!result) return;
    const casing = css('--panel');
    const peopleShown = result.single ? [0] : state.people.map((p, i) => i);
    const widths = peopleShown.map((p, k) => Math.max(3, 8 - 1.5 * k));

    peopleShown.forEach((pi, k) => {
      const path = result.routes[k].path;
      if (!path.length) return;
      const color = result.single ? css('--pa') : personColor(pi);
      // split the path into runs on the same layer
      let run = [];
      const flush = () => {
        if (run.length < 2) return;
        const pts = pathLatLngs(run);
        if (N[run[0]].layer === state.layer) {
          routeGroup.addLayer(L.polyline(pts, { color: casing, weight: widths[k] + 4, opacity: 0.9, interactive: false }));
          routeGroup.addLayer(L.polyline(pts, { color, weight: widths[k], opacity: 0.95, interactive: false, lineJoin: 'round' }));
        } else if (state.layer === 'out') {
          // seen from the campus, the indoor part of a route is drawn dashed over Bât. C
          routeGroup.addLayer(L.polyline(pts, { color, weight: Math.max(3, widths[k] - 2), opacity: 0.9, dashArray: '1 8',
            lineCap: 'round', interactive: false }));
        }
      };
      for (let i = 0; i < path.length; i++) {
        const v = path[i];
        if (run.length && N[run[run.length - 1]].layer !== N[v].layer) {
          // layer change: a clickable chip on this layer pointing to the next one
          const here = run[run.length - 1];
          if (state.layer === 'out' && (N[here].layer === 'out' || N[v].layer === 'out'))   // the step through the door
            routeGroup.addLayer(L.polyline([ll(N[here]), ll(N[v])], { color, weight: widths[k], opacity: 0.95, interactive: false }));
          if (N[here].layer === state.layer) addTransition(N[here], N[v].layer, color);
          if (N[v].layer === state.layer) addTransition(N[v], N[here].layer, color);
          flush(); run = [];
        }
        run.push(v);
      }
      flush();
      // start marker
      const start = N[path[0]];
      if (visibleHere(start)) markerGroup.addLayer(personPin(start, result.single ? 'You' : state.people[pi].key, color));
    });
    gpsLinks();
    drawHeat();
    // people whose route is empty (already at the meeting point / unreachable) still get a pin
    if (!result.single) state.people.forEach((p, i) => {
      if (result.routes[i].path.length || !visibleHere(N[p.node])) return;
      markerGroup.addLayer(personPin(N[p.node], p.key, personColor(i)));
    });
    const m = N[result.meet.node];
    if (isFinite(result.meet.max === undefined ? 0 : result.meet.max) && visibleHere(m)) {
      markerGroup.addLayer(L.marker(ll(m), { zIndexOffset: 1000, icon: L.divIcon({ className: 'meet-pin',
        html: '<span>' + ICON_MEET + '</span>' + floorTag(m), iconSize: [44, 44], iconAnchor: [22, 52] }) }).bindTooltip(esc(m.name), { direction: 'top', offset: [0, -20] }));
    }
  }

  /** After a change, pins move at once; routes wait for the button. */
  function drawPending() {
    routeGroup.clearLayers(); markerGroup.clearLayers();
    state.people.forEach((p, i) => {
      if (state.group && !state.group.seats[SEAT[i]]) return;    // not in the live group yet
      if (visibleHere(N[p.node])) markerGroup.addLayer(personPin(N[p.node], p.key, personColor(i)));
    });
    gpsLinks();
  }

  function addTransition(node, toLayer, color) {
    const mk = L.marker(ll(node), { zIndexOffset: 800, icon: L.divIcon({ className: 'transition',
      html: '<span style="border-color:' + color + '">→ ' + LAYER_SHORT[toLayer] + '</span>', iconSize: null, iconAnchor: [-10, 28] }) });
    mk.on('click', () => showLayer(toLayer));
    routeGroup.addLayer(mk);
  }

  function drawGraph() {
    graphGroup.clearLayers();
    if (!state.showGraph) return;
    for (const e of graph.edges) {
      const a = N[e.a], b = N[e.b];
      if (a.layer !== state.layer || b.layer !== state.layer) continue;
      graphGroup.addLayer(L.polyline(e.geometry || [ll(a), ll(b)], { className: 'graph-edge', weight: 2, interactive: false }));
    }
    N.forEach(n => {
      if (n.layer !== state.layer) return;
      graphGroup.addLayer(L.circleMarker(ll(n), { radius: n.type === 'junction' ? 3 : 5, className: 'graph-node' + (n.meetable ? ' meetable' : ''), weight: 1.5 })
        .bindTooltip(esc(n.id) + '<br>' + esc(n.name) + '<br>' + n.lat.toFixed(6) + ', ' + n.lng.toFixed(6)));
    });
  }

  // ------------------------------------------------------------------ map clicks
  map.on('click', ev => {
    const $c = document.getElementById('coords');
    if ($c) $c.textContent = ev.latlng.lat.toFixed(6) + ', ' + ev.latlng.lng.toFixed(6) + ' · layer ' + state.layer;
    if (state.picking == null) return;
    const best = nearestPlace(ev.latlng, state.layer);
    if (best != null) {
      setPlace(state.picking, best);
      stopPicking();
      drawPending();
    }
  });

  /** Closest place a person can stand at, on one layer. */
  function nearestPlace(latlng, layer) {
    let best = null, bd = Infinity;
    N.forEach((n, i) => {
      // on the campus view, Bât. C's ground floor counts too (tap the building to choose it)
      if (!PICKABLE(n) || !(n.layer === layer || (layer === 'out' && n.layer === 'C0'))) return;
      const d = map.distance(latlng, ll(n));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  // ------------------------------------------------------------------ panel
  // Simple flow: 2–6 "Where are you?" fields + transport, one button, one result.
  const $panel = document.getElementById('panel-body');
  const ICON = {
    walk: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="2.2"/><path d="M13 7.5l-2.5 5 3 3-1 5.5M10.5 12.5L8 21M11.5 9L8 11.5v3M13.5 9l3 3.5h2.5"/></svg>',
    wheelchair: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="4" r="2.2"/><path d="M10 7.5v6h5.5l2 5.5M10 10.5h5"/><path d="M7.5 10.8a5.5 5.5 0 1 0 7.6 6.9"/></svg>',
    bike: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16l4-7.5h6l3 7.5M9.5 8.5l3.5 7.5H5.5M14 5.5h3"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.8-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 15.2 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/></svg>',
    locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="2.2" class="fill"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>'
  };
  const placeLabel = i => {
    const n = N[i];
    return (n.code ? n.code + ' – ' : '') + n.name + ' · ' + (LAYER_SHORT[n.layer] === 'Campus' ? 'Campus' : 'Bât. C ' + LAYER_SHORT[n.layer]);
  };
  const GROUP_ORDER = ['C0', 'C1', 'C2', 'out'];
  const groupName = l => l === 'out' ? 'Campus' : 'Bât. C · ' + LAYER_SHORT[l];
  const shortLabel = i => { const n = N[i]; return (n.code ? n.code + ' – ' : '') + n.name; };
  const places = N.map((n, i) => i).filter(i => PICKABLE(N[i]))
    .sort((a, b) => GROUP_ORDER.indexOf(N[a].layer) - GROUP_ORDER.indexOf(N[b].layer) ||
      (N[a].code ? 0 : 1) - (N[b].code ? 0 : 1) || shortLabel(a).localeCompare(shortLabel(b), 'fr', { numeric: true }));
  const byLabel = new Map(places.map(i => [placeLabel(i).toLowerCase(), i]));

  /** Turn what was typed into a place: exact label, room number ("c104"), or a unique partial match. */
  function resolvePlace(text) {
    const t = text.trim().toLowerCase();
    if (!t) return null;
    if (byLabel.has(t)) return byLabel.get(t);
    const code = places.find(i => (N[i].code || '').toLowerCase() === t);
    if (code != null) return code;
    const hits = places.filter(i => placeLabel(i).toLowerCase().includes(t));
    return hits.length === 1 ? hits[0] : null;
  }

  function renderForm() {
    const n = state.people.length;
    let html = '<form id="plan" class="plan" novalidate>' + groupBarHtml() +
      (state.group ? '' : '<div class="count-row"><span id="count-label">Who\'s meeting?</span><div class="stepper" role="group" aria-labelledby="count-label">' +
        '<button type="button" class="icon-btn" data-count="-1" aria-label="One person fewer"' + (n <= MIN_PEOPLE ? ' disabled' : '') + '>−</button>' +
        '<output aria-live="polite"><strong>' + n + '</strong> people</output>' +
        '<button type="button" class="icon-btn" data-count="1" aria-label="One more person"' + (n >= MAX_PEOPLE ? ' disabled' : '') + '>+</button></div></div>') +
      '<div class="people">';
    state.people.forEach((p, i) => {
      const ro = state.group && state.group.idx !== i;     // in a group you only edit your own row
      html += '<fieldset class="person' + (ro ? ' remote' : '') + (state.group && state.group.idx === i ? ' me' : '') + '" id="person-' + i + '" style="--c:var(' + p.colorVar + ')"' + (ro ? ' disabled' : '') + '><legend class="visually-hidden">Person ' + p.key + '</legend>' +
        '<span class="avatar" aria-hidden="true">' + p.key + '</span><div class="person-main">' +
        '<div class="field"><div class="combo"><input id="where-' + i + '" data-i="' + i + '" role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
        'aria-label="Where is person ' + p.key + '?" aria-controls="list-' + i + '" autocomplete="off" enterkeyhint="done" placeholder="Where is ' + p.key + '? Room or place" value="' + esc(personLabel(i)) + '">' +
        '<ul class="combo-list" id="list-' + i + '" role="listbox" aria-label="Places" hidden></ul></div>' +
        '<button type="button" class="icon-btn" data-locate="' + i + '" title="Use my location" aria-label="Use my location for person ' + p.key + '">' + ICON.locate + '</button>' +
        '<button type="button" class="icon-btn" data-tap="' + i + '" aria-pressed="false" title="Pick on the map" aria-label="Pick person ' + p.key + ' on the map">' + ICON.pin + '</button></div>' +
        '<p class="gps-note" id="gps-' + i + '"' + (p.gps ? '' : ' hidden') + '>' + gpsNote(i) + '</p>' +
        '<p class="field-error" id="err-' + i + '" hidden>Pick a place from the list, or type a room number like C104.</p>' +
        (state.group ? '<p class="seat-status" id="seat-' + i + '">' + seatStatus(i) + '</p>' : '') +
        '<div class="modes" role="radiogroup" aria-label="How does ' + p.key + ' travel?">' +
        RDV.MODES.map(mode => '<button type="button" role="radio" aria-checked="' + (p.mode === mode) + '" aria-label="' + MODE_LABEL[mode] + '" title="' + MODE_LABEL[mode] + '" data-i="' + i + '" data-mode="' + mode + '">' +
          ICON[mode] + '<span>' + MODE_LABEL[mode] + '</span></button>').join('') +
        '</div></div></fieldset>';
    });
    html += '</div><button type="submit" class="primary" id="find"' + (state.group ? ' hidden' : '') + '>Find where to meet</button></form><div id="result" aria-live="polite"></div>';
    $panel.innerHTML = html;
  }


  function markStale() {
    if (playing) stopPlayback();
    state.chosen = null; state.stale = true;
    drawPending();
    const $r = document.getElementById('result');
    if ($r) $r.classList.add('stale');
    document.getElementById('find').classList.add('ready');
  }

  function renderPanel() {
    if (playing) stopPlayback();
    if (result.single) return renderSingle();
    const { meet, best, ranked, routes } = result;
    const $r = document.getElementById('result');
    $r.classList.remove('stale');
    document.getElementById('find').classList.remove('ready');
    if (!isFinite(meet.max)) {
      $r.innerHTML = '<section class="meet none"><h2>No common meeting place</h2><p>At least one person cannot reach any meeting place with the chosen transport. Try another transport or place.</p></section>';
      return;
    }
    const m = N[meet.node];
    const custom = state.chosen != null && meet !== best;
    let html = '<section class="meet"><div class="meet-head"><span class="meet-icon" aria-hidden="true">' + ICON_MEET + '</span><div>' +
      '<div class="eyebrow">' + (custom ? 'Meet here · your choice' : 'Best place to meet') + '</div>' +
      '<h2>' + esc((m.code ? m.code + ' – ' : '') + m.name) + '</h2></div></div>' +
      '<p class="where"><button type="button" class="chip" data-layer="' + m.layer + '">' + ICON_LAYER + esc(layerName(m.layer)) + '</button>' +
      '<span class="big-time">all there in <strong>' + clock(meet.max) + '</strong> min</span></p>' +
      (custom ? '<button type="button" class="link reset" data-reset>Use the best place instead (' + RDV.formatTime(best.max) + ')</button>' : '') +
      goalHtml(meet) +
      '<p class="stale-note">Changes made. Press <strong>Find where to meet</strong> to update.</p></section>';

    html += '<section class="routes" aria-label="Trips">';
    state.people.forEach((p, i) => {
      const r = routes[i];
      const mine = state.group && state.group.idx === i;
      html += '<details class="route' + (mine ? ' mine' : '') + '" id="route-' + i + '" style="--c:var(' + p.colorVar + ')"' + (mine ? ' open' : '') + '>' +
        '<summary aria-label="Directions for ' + p.key + (mine ? ' (you)' : '') + '"><span class="avatar">' + p.key + '</span>' + legsHtml(r, p.mode, mine) +
        '<span class="trip-time"><strong>' + clock(r.seconds) + '</strong><span>min</span></span>' +
        '<span class="from">from ' + esc(p.gps ? (p.gps.off ? 'off campus' : 'your location') : N[p.node].name) + '</span></summary>' +
        '<div class="route-body">' + actionsHtml(i, r) + approachHtml(r, p) + stepsHtml(r) + '<button type="button" class="link share" data-share="' + i + '">Copy link to this route</button></div></details>';
    });
    html += '</section>' + hoodHtml(ranked, meet);
    $r.innerHTML = html;
  }

  function renderSingle() {
    const { from, to, mode } = state.single;
    const r = result.routes[0];
    $panel.innerHTML = '<section class="meet"><div class="eyebrow">Your route</div><h2>' + esc((N[to].code ? N[to].code + ' – ' : '') + N[to].name) + '</h2>' +
      '<p class="where"><span>' + MODE_LABEL[mode] + ' from ' + esc(N[from].name) + '</span><span><strong>' + RDV.formatTime(r.seconds) + '</strong></span></p></section>' +
      '<section class="routes"><div class="route single" id="route-0" style="--c:var(--pa)">' + actionsHtml(0, r) + stepsHtml(r) + '</div></section>' +
      '<button type="button" class="primary" data-plan>Plan a new meeting</button>';
  }

  function stepsHtml(r) {
    if (!isFinite(r.seconds)) return '<p class="hint">Not reachable with this transport.</p>';
    if (!r.steps.length) return '<p class="hint">Already at the meeting place.</p>';
    let html = '<ol class="steps">', layer = null;
    for (const [k, s] of r.steps.entries()) {
      if (s.layer !== layer && s.fromLayer !== layer) {
        layer = s.fromLayer;
        html += '<li class="layer-sep"><button type="button" class="link" data-layer="' + layer + '">' + esc(layerName(layer)) + '</button></li>';
      }
      html += '<li data-s="' + k + '"><span>' + esc(s.text) + '</span><span class="t">' + short(s.seconds) + '</span></li>';
      layer = s.layer;
    }
    return html + '</ol>';
  }

  // ------------------------------------------------------------------ trip summary chips
  const ICON_MEET = '<svg viewBox="0 0 24 24"><path d="M6 21.5V3.5h1.8v1h10.4l-2.6 4.2 2.6 4.3H7.8v8.5z"/></svg>';
  const ICON_LAYER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>';
  const LEG_ICON = {
    inside: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/></svg>',
    stairs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h5v-5h5v-5h5V5h3"/></svg>',
    lift: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9.5 9.5L12 7l2.5 2.5M9.5 14.5L12 17l2.5-2.5"/></svg>'
  };
  /** "2:13" from seconds */
  function clock(sec) { if (!isFinite(sec)) return '—'; sec = Math.round(sec); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
  /** Journey chips, Citymapper style: inside › stairs › outside, each with its time. */
  function legsHtml(r, mode, mine) {
    const you = mine ? '<span class="you-chip">You</span>' : '';
    if (!isFinite(r.seconds)) return '<span class="legs">' + you + '<span class="leg">Not reachable</span></span>';
    if (!r.steps.length && !r.approach) return '<span class="legs">' + you + '<span class="leg">Already there</span></span>';
    const legs = [];
    for (const st of r.steps) {
      const type = st.kind === 'elevator' ? 'lift' : (st.kind === 'stairs' || st.kind === 'spiral' || st.kind === 'stairs_outdoor') ? 'stairs'
        : (st.layer === 'out' && st.fromLayer === 'out') || st.kind === 'entrance' ? 'outside' : 'inside';
      const last = legs[legs.length - 1];
      if (last && last.type === type) last.sec += st.seconds; else legs.push({ type, sec: st.seconds });
    }
    if (r.approach) legs.unshift({ type: 'to campus', sec: r.approach.seconds, icon: ICON.locate });
    return '<span class="legs">' + you + legs.map(l => '<span class="leg" title="' + l.type + '">' + (l.icon || (l.type === 'outside' ? ICON[mode] : LEG_ICON[l.type])) +
      (l.sec >= 30 || legs.length === 1 ? clock(l.sec) : '') + '</span>').join('<span class="leg-sep" aria-hidden="true">›</span>') + '</span>';
  }

  // ------------------------------------------------------------------ play route + voice
  // "Play" moves a dot along the route (switching floors on its own) and reads each step aloud.
  // "Read aloud" only reads the directions. Speech uses the browser's own voices: no server, works offline.
  const SPEECH = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
  const ICON_VOICE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  state.voice = true;
  let playToken = 0, playing = null;
  let userMovedAt = 0;                                     // the camera stops following for a while after the user moves the map
  const userIsMoving = () => performance.now() - userMovedAt < 5000;
  map.on('dragstart', () => { userMovedAt = performance.now(); });          // only real user gestures, not the app's own moves
  map.getContainer().addEventListener('wheel', () => { userMovedAt = performance.now(); }, { passive: true });
  map.getContainer().addEventListener('touchstart', e => { if (e.touches.length > 1) userMovedAt = performance.now(); }, { passive: true });                      // playing = { i, kind: 'play' | 'speak' }

  function actionsHtml(i, r) {
    if (!isFinite(r.seconds) || !r.steps.length) return '';
    const on = playing && playing.i === i;
    return '<div class="route-actions">' +
      '<button type="button" class="act" data-play="' + i + '">' + (on && playing.kind === 'play' ? ICON_STOP + 'Stop' : ICON_PLAY + 'Play route') + '</button>' +
      (SPEECH ? '<button type="button" class="act" data-speak="' + i + '">' + (on && playing.kind === 'speak' ? ICON_STOP + 'Stop' : ICON_VOICE + 'Read aloud') + '</button>' +
        '<label class="voice-opt"><input type="checkbox" data-voice' + (state.voice ? ' checked' : '') + '> Voice while playing</label>' : '') +
      '</div>';
  }
  function refreshActions() {
    if (!result) return;
    result.routes.forEach((r, i) => {
      const $a = document.querySelector('#route-' + i + ' .route-actions');
      if ($a) $a.outerHTML = actionsHtml(i, r);
    });
  }

  function say(text, force) {
    return new Promise(done => {
      if (!SPEECH || (!force && !state.voice)) return done();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/ – /g, ', ').replace(/Bât\. /g, 'Building '));
      u.lang = 'en-GB'; u.rate = 1.02;
      const v = speechSynthesis.getVoices().find(x => /^en[-_]/i.test(x.lang));
      if (v) u.voice = v;
      let over = false; const end = () => { if (!over) { over = true; done(); } };
      u.onend = end; u.onerror = end;
      setTimeout(end, 1500 + text.split(/\s+/).length * 450);   // never wait forever if the voice stays silent
      speechSynthesis.speak(u);
    });
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function highlightStep(i, k) {
    const $route = document.getElementById('route-' + i); if (!$route) return;
    if ($route.tagName === 'DETAILS') $route.open = true;
    $route.querySelectorAll('.steps li[data-s]').forEach(li => li.classList.toggle('current', +li.dataset.s === k));
    const $li = $route.querySelector('.steps li[data-s="' + k + '"]');
    if ($li) scrollInPanel($li, 'nearest');
  }

  function stopPlayback() {
    playToken++;
    if (SPEECH) speechSynthesis.cancel();
    playGroup.clearLayers(); clearDot3D();
    document.querySelectorAll('.steps li.current').forEach(li => li.classList.remove('current'));
    playing = null; refreshActions();
  }

  /** The pieces of one step: [{ pts: [latlng...], layer, vertical }] */
  function stepPieces(step) {
    const out = [];
    for (let k = 1; k < step.path.length; k++) {
      const u = N[step.path[k - 1]], v = N[step.path[k]];
      if (u.layer === v.layer) out.push({ pts: segment(step.path[k - 1], step.path[k]), layer: u.layer });
      else if (u.layer === 'out' || v.layer === 'out') out.push({ pts: [ll(u), ll(v)], layer: 'out' });
      else out.push({ pts: [ll(u), ll(v)], layer: v.layer, from: u.layer, vertical: true });   // stairs / lift: change floor
    }
    return out;
  }
  function pointAt(pts, f) {                                // position at fraction f of a polyline
    if (pts.length === 1) return pts[0];
    const seg = []; let total = 0;
    for (let k = 1; k < pts.length; k++) { const d = map.distance(pts[k - 1], pts[k]); seg.push(d); total += d; }
    let goal = f * total;
    for (let k = 0; k < seg.length; k++) {
      if (goal <= seg[k] || k === seg.length - 1) {
        const t = seg[k] ? Math.min(1, goal / seg[k]) : 1, a = pts[k], b = pts[k + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      goal -= seg[k];
    }
    return pts[pts.length - 1];
  }
  function moveAlong(step, seconds, dot, alive) {
    const pieces = stepPieces(step);
    const len = pieces.map(p => p.vertical ? 0 : p.pts.slice(1).reduce((s, q, k) => s + map.distance(p.pts[k], q), 0));
    const flat = len.reduce((s, x) => s + x, 0), nVert = pieces.filter(p => p.vertical).length;
    const vertTime = nVert ? Math.min(1.2, seconds * 0.5) / nVert : 0;
    const times = pieces.map((p, k) => p.vertical ? vertTime : (flat ? (seconds - vertTime * nVert) * len[k] / flat : 0));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return pieces.reduce((chain, piece, k) => chain.then(() => new Promise(done => {
      if (!alive()) return done();
      if (piece.layer !== state.layer) {
        showLayer(piece.layer, piece.layer !== 'out');
        if (piece.layer === 'out') map.setView(piece.pts[0], Math.max(map.getZoom(), 18), { animate: false });
      }
      const ms = Math.max(1, times[k] * 1000);
      if (reduce || piece.vertical) { dot.setLatLng(piece.pts[piece.pts.length - 1]); return setTimeout(done, reduce ? 0 : ms); }  // floor change
      const t0 = performance.now();
      const frame = now => {
        if (!alive()) return done();
        const f = Math.min(1, (now - t0) / ms);
        const at = pointAt(piece.pts, f); dot.setLatLng(at);
        if (piece.layer === 'out' && !userIsMoving() && !map.getBounds().pad(-0.15).contains(at)) map.panTo(at, { animate: false });
        if (f < 1) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    })), Promise.resolve());
  }

  /** Same walk as moveAlong, in the 3D view: a small column glides along the ribbons and climbs between floors. */
  function moveAlong3D(step, seconds, color, alive) {
    const pieces = stepPieces(step);
    const len = pieces.map(p => p.vertical ? 0 : p.pts.slice(1).reduce((s, q, k) => s + map.distance(p.pts[k], q), 0));
    const flat = len.reduce((s, x) => s + x, 0), nVert = pieces.filter(p => p.vertical).length;
    const vertTime = nVert ? Math.min(1.6, seconds * 0.5) / nVert : 0;
    const times = pieces.map((p, k) => p.vertical ? vertTime : (flat ? (seconds - vertTime * nVert) * len[k] / flat : 0));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let lastPan = 0;
    const put = (at, z) => {
      // the person icon floats at the floor's height; a small coloured mark shows the exact spot below it
      map3d.getSource('playdot').setData(fc([ext(square(at, 2.2), color, z + 0.3, z + 0.9)]));
      walker3D.setLngLat([at[1], at[0]]); walker3D.z = z; liftWalker();
      const now = performance.now(), c = map3d.getCenter();
      if (!userIsMoving() && now - lastPan > 700 && map.distance([c.lat, c.lng], at) > 25) {      // keep the walker in view
        lastPan = now; map3d.easeTo({ center: [at[1], at[0]], duration: 700 });
      }
    };
    return pieces.reduce((chain, piece, k) => chain.then(() => new Promise(done => {
      if (!alive()) return done();
      const z0 = floorOf(piece.vertical ? piece.from : piece.layer) * FLOOR_H, z1 = floorOf(piece.layer) * FLOOR_H;
      if (piece.layer !== 'out' && piece.layer !== state.layer) { state.layer = piece.layer; renderTabs(); refresh3D(false, false); }
      if (piece.layer === 'out' && state.layer !== 'out' && !piece.vertical) { state.layer = 'out'; renderTabs(); refresh3D(false, false); }
      const ms = Math.max(1, times[k] * 1000);
      if (reduce) { put(piece.pts[piece.pts.length - 1], z1); return done(); }
      const t0 = performance.now();
      const frame = now => {
        if (!alive()) return done();
        const f = Math.min(1, (now - t0) / ms);
        put(piece.vertical ? piece.pts[piece.pts.length - 1] : pointAt(piece.pts, f), piece.vertical ? z0 + (z1 - z0) * f : z1);
        if (f < 1) requestAnimationFrame(frame); else done();
      };
      requestAnimationFrame(frame);
    })), Promise.resolve());
  }
  function clearDot3D() {
    if (map3d && map3dReady && map3d.getSource('playdot')) map3d.getSource('playdot').setData(fc([]));
    if (walker3D) { walker3D.remove(); walker3D = null; }
  }
  /** The walking person: mode icon in the person's colour. */
  function walkerHtml(i, color) {
    const mode = result && result.single ? state.single.mode : state.people[i].mode;
    return '<span style="background:' + color + '">' + ICON[mode] + '</span>';
  }
  // MapLibre markers sit on the ground; lift the icon by the floor's height (meters -> pixels at this zoom and tilt)
  let walker3D = null;
  function liftWalker() {
    if (!walker3D || !map3d) return;
    const lat = walker3D.getLngLat().lat;
    const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, map3d.getZoom()));
    walker3D.setOffset([0, -((walker3D.z || 0) + 1.5) / mpp * Math.sin(map3d.getPitch() * Math.PI / 180) - 18]);
  }

  async function runRoute(i, kind) {
    const was = playing && playing.i === i && playing.kind === kind;
    stopPlayback();
    if (was) return;                                        // the button was "Stop"
    const token = playToken, alive = () => token === playToken;
    const r = result.routes[i]; if (!r || !r.steps.length) return;
    playing = { i, kind }; refreshActions();
    const color = result.single ? css('--pa') : personColor(i);
    let dot = null;
    const in3D = kind === 'play' && view === '3d';
    if (in3D) {                                              // wait until the 3D view is ready
      for (let t = 0; t < 100 && !(map3d && map3dReady) && alive(); t++) await wait(100);
      if (!(map3d && map3dReady)) { setView('plan'); }
    }
    if (kind === 'play' && view === '3d') {
      const s0 = N[r.path[0]];
      const el = document.createElement('div'); el.className = 'walker'; el.innerHTML = walkerHtml(i, color);
      walker3D = new maplibregl.Marker({ element: el }).setLngLat([s0.lng, s0.lat]).addTo(map3d);
      walker3D.z = floorOf(s0.layer) * FLOOR_H; liftWalker();
      state.layer = s0.layer; renderTabs(); refresh3D(false, false);
      map3d.easeTo({ center: [s0.lng, s0.lat], zoom: 18.8, pitch: 60, duration: 800 });
      await wait(800);
    } else if (kind === 'play') {
      dot = L.marker(ll(N[r.path[0]]), { zIndexOffset: 2000, interactive: false,
        icon: L.divIcon({ className: 'walker', html: walkerHtml(i, color), iconSize: [40, 40], iconAnchor: [20, 20] }) });
      playGroup.addLayer(dot);
      showLayer(N[r.path[0]].layer, true);
    }
    // the animation takes 6-20 s whatever the real trip length, so a demo stays watchable
    const scale = Math.min(20, Math.max(6, r.seconds / 8)) / r.seconds;
    for (let k = 0; k < r.steps.length && alive(); k++) {
      const step = r.steps[k];
      highlightStep(i, k);
      const speech = say(step.text, kind === 'speak');
      if (kind === 'play') {
        if (dot) await moveAlong(step, Math.max(0.5, step.seconds * scale), dot, alive);
        else await moveAlong3D(step, Math.max(0.5, step.seconds * scale), color, alive);
      }
      await speech;
      if (kind === 'speak') await wait(300);
    }
    if (!alive()) return;
    if (kind === 'play') await say('You have arrived.', false);
    if (alive()) { playing = null; refreshActions(); setTimeout(() => { if (alive()) { playGroup.clearLayers(); clearDot3D(); } }, 2500); }
  }

  function hoodHtml(ranked, meet) {
    const rows = RDV.MODES.map(mode => {
      const m = matrices[mode], c = checks[mode];
      return '<tr><td>' + MODE_LABEL[mode] + '</td><td class="num">' + m.runs + '</td><td class="num">' + m.ms.toFixed(1) + ' ms</td>' +
        '<td class="' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '0 updates' : c.updates + ' updates') + '</td></tr>';
    }).join('');
    const top = ranked.filter(r => isFinite(r.max)).slice(0, 6);
    return '<details class="hood"' + (state.hoodOpen ? ' open' : '') + '><summary>How it works</summary>' +
      '<ol class="explain"><li>The campus is a graph of <strong>' + N.length + ' places</strong> and <strong>' + graph.edges.length + ' links</strong>, each with a travel time per transport.</li>' +
      '<li><strong>Dijkstra</strong> runs from every place and fills a ' + N.length + ' × ' + N.length + ' table of shortest times per transport.</li>' +
      '<li><strong>IsTransitive</strong> (3 loops k, i, j) checks the table: 0 updates means no shortcut was missed.</li>' +
      '<li><strong>Minimax</strong> picks, among ' + candidates.length + ' meeting places, the one where the longest trip is shortest.</li></ol>' +
      '<h3>Minimax table</h3><p class="hint">Tap a row to meet there instead.</p>' +
      '<div class="scroll"><table class="minimax"><thead><tr><th>Place</th>' + state.people.map(p => '<th style="color:var(' + p.colorVar + ')">' + p.key + '</th>').join('') + '<th>Max</th></tr></thead><tbody>' +
      top.map(r => '<tr data-node="' + r.node + '" class="' + (r.node === meet.node ? 'sel' : '') + '"><td>' + esc((N[r.node].code ? N[r.node].code + ' – ' : '') + N[r.node].name) + '</td>' +
        r.times.map(t => '<td class="num">' + short(t) + '</td>').join('') + '<td class="num max">' + short(r.max) + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<h3>Algorithm check</h3><div class="scroll"><table><thead><tr><th>Transport</th><th>Dijkstra runs</th><th>Time</th><th>IsTransitive</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<label class="toggle"><input type="checkbox" id="show-graph"' + (state.showGraph ? ' checked' : '') + '> Show the graph on the map</label>' +
      '<p class="hint">Map coordinates (for editing the data): <code id="coords">tap the map</code></p></details>';
  }

  // ------------------------------------------------------------------ place picker (searchable list)
  // Shows every place, grouped by floor, and narrows down while typing ("c2", "amphi", "bus"...).
  const fold = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const combo = { i: null, items: [], active: -1 };
  function openList(i, query) {
    const $l = document.getElementById('list-' + i), $in = document.getElementById('where-' + i);
    const q = fold(query || '').trim();
    const starts = n => fold(shortLabel(n)).startsWith(q) || fold(N[n].code || '') === q ? 0 : 1;
    const items = places.filter(n => !q || fold(placeLabel(n)).includes(q))   // best matches first within each floor
      .map((n, k) => [n, k]).sort((a, b) => GROUP_ORDER.indexOf(N[a[0]].layer) - GROUP_ORDER.indexOf(N[b[0]].layer) ||
        (q ? starts(a[0]) - starts(b[0]) : 0) || a[1] - b[1]).map(x => x[0]);
    combo.i = i; combo.items = items; combo.active = items.length ? 0 : -1;
    let html = '', group = null;
    items.forEach((n, k) => {
      if (N[n].layer !== group) { group = N[n].layer; html += '<li class="combo-group" role="presentation">' + esc(groupName(group)) + '</li>'; }
      html += '<li role="option" id="opt-' + i + '-' + k + '" data-k="' + k + '" aria-selected="' + (k === 0) + '">' + esc(shortLabel(n)) + '</li>';
    });
    $l.innerHTML = html || '<li class="combo-empty" role="presentation">No place matches. Try a room number like C104.</li>';
    $l.hidden = false; $in.setAttribute('aria-expanded', 'true');
    $in.setAttribute('aria-activedescendant', items.length ? 'opt-' + i + '-0' : '');
  }
  function closeList() {
    if (combo.i == null) return;
    const $l = document.getElementById('list-' + combo.i), $in = document.getElementById('where-' + combo.i);
    if ($l) $l.hidden = true;
    if ($in) { $in.setAttribute('aria-expanded', 'false'); $in.removeAttribute('aria-activedescendant'); }
    combo.i = null;
  }
  function moveActive(d) {
    if (!combo.items.length) return;
    combo.active = (combo.active + d + combo.items.length) % combo.items.length;
    const $l = document.getElementById('list-' + combo.i);
    $l.querySelectorAll('[role="option"]').forEach(o => o.setAttribute('aria-selected', String(+o.dataset.k === combo.active)));
    const $o = document.getElementById('opt-' + combo.i + '-' + combo.active);
    if ($o) { const $l = $o.parentNode; if ($o.offsetTop < $l.scrollTop) $l.scrollTop = $o.offsetTop - 4; else if ($o.offsetTop + $o.offsetHeight > $l.scrollTop + $l.clientHeight) $l.scrollTop = $o.offsetTop + $o.offsetHeight - $l.clientHeight + 4; document.getElementById('where-' + combo.i).setAttribute('aria-activedescendant', $o.id); }
  }
  function choose(i, node) {
    closeList(); setPlace(i, node);
    if (N[node].layer !== state.layer) showLayer(N[node].layer);
  }
  $panel.addEventListener('focusin', ev => {
    const t = ev.target; if (!t.matches('input[data-i]')) return;
    t.select(); openList(+t.dataset.i, '');
  });
  $panel.addEventListener('input', ev => {
    const t = ev.target; if (t.matches('input[data-i]')) openList(+t.dataset.i, t.value);
  });
  $panel.addEventListener('keydown', ev => {
    const t = ev.target; if (!t.matches('input[data-i]')) return;
    const i = +t.dataset.i;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); if (combo.i !== i) openList(i, t.value); else moveActive(ev.key === 'ArrowDown' ? 1 : -1); }
    else if (ev.key === 'Enter' && combo.i === i) { ev.preventDefault(); if (combo.active >= 0) { choose(i, combo.items[combo.active]); t.blur(); } }
    else if (ev.key === 'Escape') { closeList(); t.value = personLabel(i); }
  });
  $panel.addEventListener('pointerdown', ev => {
    const o = ev.target.closest('.combo-list [role="option"]'); if (!o) return;
    ev.preventDefault();                                   // keep focus, so the list does not close first
    const i = +o.closest('.combo-list').id.split('-')[1];
    choose(i, combo.items[+o.dataset.k]); document.getElementById('where-' + i).blur();
  });
  $panel.addEventListener('focusout', ev => {
    const t = ev.target; if (!t.matches('input[data-i]')) return;
    const i = +t.dataset.i;
    setTimeout(() => {
      if (document.activeElement === t) return;
      if (combo.i === i) closeList();
      const node = resolvePlace(t.value);
      if (node != null && node !== state.people[i].node) choose(i, node);
      else if (node == null) t.value = personLabel(i);   // nothing valid typed: keep the current place
    }, 0);
  });

  // ------------------------------------------------------------------ events
  function setPlace(i, node, gps) {
    state.people[i].node = node; state.people[i].gps = gps || null;
    const $g = document.getElementById('gps-' + i); if ($g) { $g.hidden = !gps; $g.innerHTML = gpsNote(i); }
    const $in = document.getElementById('where-' + i);
    if ($in) { $in.value = personLabel(i); $in.removeAttribute('aria-invalid'); }
    const $e = document.getElementById('err-' + i); if ($e) $e.hidden = true;
    markStale();
    // in a live group there is no Find button: sharing my place recomputes on every phone, mine included.
    // (It must come after markStale, because the database can answer straight away.)
    if (state.group && state.group.idx === i) pushMine();
  }
  $panel.addEventListener('change', ev => {
    const t = ev.target;
    if (t.matches('[data-voice]')) {
      state.voice = t.checked;
      document.querySelectorAll('[data-voice]').forEach(x => { x.checked = t.checked; });
      if (!t.checked && SPEECH && playing && playing.kind === 'play') speechSynthesis.cancel();
      return;
    }
    if (t.id === 'show-graph') {
      state.showGraph = t.checked; drawGraph();
    }
  });
  $panel.addEventListener('toggle', ev => { if (ev.target.classList && ev.target.classList.contains('hood')) state.hoodOpen = ev.target.open; }, true);
  $panel.addEventListener('submit', ev => {
    ev.preventDefault();
    // accept a typed value that was not confirmed with Enter yet
    let ok = true;
    state.people.forEach((p, i) => {
      const $in = document.getElementById('where-' + i);
      if (p.gps && $in.value === personLabel(i)) return;      // located by GPS: keep it
      const node = resolvePlace($in.value);
      if (node == null) { ok = false; $in.setAttribute('aria-invalid', 'true'); document.getElementById('err-' + i).hidden = false; }
      else if (node !== p.node) setPlace(i, node);
    });
    if (!ok) return;
    stopPicking();
    update();
    if (PHONE.matches) setSheet('half');
    // frame everyone, after the sheet has settled (its height decides the free part of the map)
    setTimeout(() => {
      showOverview();
      const $r = document.getElementById('result');
      scrollInPanel($r, 'start');
    }, PHONE.matches ? 280 : 0);
  });
  $panel.addEventListener('click', ev => {
    const b = ev.target.closest('button, tr[data-node]');
    if (!b) return;
    if (b.dataset.play != null) return runRoute(+b.dataset.play, 'play');
    if (b.dataset.speak != null) return runRoute(+b.dataset.speak, 'speak');
    if (b.dataset.group) return groupAction(b.dataset.group, b);
    if (b.dataset.goal) return setGoal(b.dataset.goal);
    if (b.hasAttribute('data-wave')) return startWave();
    if (b.hasAttribute('data-heat')) return toggleHeat();
    if (b.dataset.count) { setCount(state.people.length + +b.dataset.count); renderForm(); markStale(); return; }
    if (b.dataset.locate) return locate(+b.dataset.locate, b);
    if (b.dataset.mode) {
      const i = +b.dataset.i; state.people[i].mode = b.dataset.mode;
      b.parentNode.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-checked', String(x === b)));
      const $g = document.getElementById('gps-' + i); if ($g && state.people[i].gps) $g.innerHTML = gpsNote(i);
      if (state.group && state.group.idx === i) pushMine(); else markStale();
    }
    else if (b.dataset.tap != null) {
      const i = +b.dataset.tap;
      if (state.picking === i) stopPicking(); else startPicking(i);
    }
    else if (b.dataset.layer) showLayer(b.dataset.layer);
    else if (b.dataset.node) { state.chosen = +b.dataset.node; update(); const n = N[state.chosen]; if (n.layer !== state.layer) showLayer(n.layer); }
    else if (b.hasAttribute('data-reset')) { state.chosen = null; update(); }
    else if (b.dataset.share != null) shareRoute(+b.dataset.share, b);
    else if (b.hasAttribute('data-plan')) { state.single = null; history.replaceState(null, '', location.pathname + location.search); renderForm(); update(); }
  });
  function startPicking(i) {
    if (view === '3d') setView('plan');
    state.picking = i;
    document.body.classList.add('picking');
    document.querySelectorAll('[data-tap]').forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.tap === i)));
    document.querySelector('.pick-hint').innerHTML = 'Tap the map where person ' + state.people[i].key + ' is' +
      ('geolocation' in navigator ? ' <button type="button" class="locate">or use my location</button>' : '');
  }
  document.querySelector('.pick-hint').addEventListener('click', ev => {
    if (!ev.target.closest('.locate') || state.picking == null) return;
    const i = state.picking;           // same as the location button in the row (off campus included)
    stopPicking();
    locate(i, document.querySelector('[data-locate="' + i + '"]'));
  });

  function stopPicking() {
    state.picking = null;
    document.body.classList.remove('picking');
    document.querySelectorAll('[data-tap]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  }

  // Shared route links: #route--C2-TP6--OUT-C-WEST--walk  (ids with "_" written as "-")
  const enc = id => encodeURIComponent(id);
  const dec = s => { const id = decodeURIComponent(s); return idx(id) != null ? id : id.replace(/-/g, '_'); };   // old links wrote "_" as "-"
  function shareRoute(i, btn) {
    const p = state.people[i];
    const hash = '#route--' + enc(N[p.node].id) + '--' + enc(N[result.meet.node].id) + '--' + p.mode;
    const url = location.href.split('#')[0] + hash;
    const done = () => { btn.textContent = 'Link copied'; setTimeout(() => (btn.textContent = 'Copy link to this route'), 1800); };
    try {
      navigator.clipboard.writeText(url).then(done, () => { btn.textContent = url; });
    } catch (e) { btn.textContent = url; }
  }
  function readHash() {
    if (/^#join-[A-Z0-9]{5}$/i.test(location.hash)) return null;
    const m = /^#route--(.+)--(.+)--(walk|bike|wheelchair)$/.exec(location.hash);
    if (!m) return null;
    const from = idx(dec(m[1])), to = idx(dec(m[2]));
    return from != null && to != null ? { from, to, mode: m[3] } : null;
  }
  window.addEventListener('hashchange', () => {
    const j = /^#join-([A-Z0-9]{5})$/i.exec(location.hash);
    if (j) return joinGroup(j[1].toUpperCase());
    state.single = readHash(); if (!state.single) renderForm(); update();
  });

  // ------------------------------------------------------------------ tabs
  const $tabs = document.getElementById('tabs');
  const ICON_CAMPUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';
  function renderTabs() {
    const order = ['C2', 'C1', 'C0', 'out'];
    $tabs.innerHTML = order.map(id => graph.layers.find(l => l.id === id)).filter(Boolean).map(l => {
      const dots = [];
      if (result) {
        if (!result.single) state.people.forEach(p => { if (N[p.node].layer === l.id) dots.push('<i style="background:var(' + p.colorVar + ')"></i>'); });
        if (N[result.meet.node].layer === l.id) dots.push('<i class="meet-dot"></i>');
      }
      const label = l.id === 'out' ? ICON_CAMPUS + '<span class="visually-hidden">Campus</span>' : esc(LAYER_SHORT[l.id] || l.name);
      return '<button type="button" role="tab" class="' + (l.id === 'out' ? 'floor-campus' : '') + '" aria-selected="' + (state.layer === l.id) + '" data-layer="' + l.id + '" title="' + esc(l.id === 'out' ? 'Campus' : l.name) + '">' +
        label + (dots.length ? '<span class="dots">' + dots.join('') + '</span>' : '') + '</button>';
    }).join('');
  }

  $tabs.addEventListener('click', ev => { const b = ev.target.closest('button[data-layer]'); if (b) showLayer(b.dataset.layer); });

  /** Scroll only the planner (never the page or the map behind it). */
  function scrollInPanel(el, where) {
    if (!el) return;
    const box = $panel.getBoundingClientRect(), r = el.getBoundingClientRect();
    let top = null;
    if (where === 'start') top = $panel.scrollTop + r.top - box.top - 8;
    else if (r.top < box.top) top = $panel.scrollTop + r.top - box.top - 8;
    else if (r.bottom > box.bottom) top = $panel.scrollTop + r.bottom - box.bottom + 8;
    if (top != null) $panel.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  /** First view of a result: everyone on one floor -> that floor; otherwise the campus, framed on everyone. */
  function showOverview() {
    if (!result || result.single) return;
    const pts = state.people.map(p => N[p.node]).concat([N[result.meet.node]]);
    const layers = new Set(pts.map(n => n.layer));
    if (layers.size === 1 && !layers.has('out')) return showLayer([...layers][0]);
    showLayer('out', false);
    const all = result.routes.flatMap(r => r.path.map(i => ll(N[i]))).concat(pts.map(ll));
    map.fitBounds(L.latLngBounds(all), Object.assign({ animate: false, maxZoom: 19 }, fitPad()));
  }

  // ------------------------------------------------------------------ theme: light by default, dark or follow the device
  const THEMES = ['light', 'dark', 'auto'];
  const THEME_ICON = {
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 0 0 0-16z" fill="currentColor"/></svg>'
  };
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    const $b = document.getElementById('theme-btn');
    if ($b) { $b.innerHTML = THEME_ICON[t]; $b.title = 'Theme: ' + t + ' (tap to change)'; $b.setAttribute('aria-label', 'Theme: ' + t + '. Change theme'); }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = css('--surface') || '#ffffff';
  }
  let theme = 'light';
  try { theme = localStorage.getItem('rdv-theme') || 'light'; } catch (e) { /* storage blocked */ }
  if (!THEMES.includes(theme)) theme = 'light';
  document.getElementById('theme-btn').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('rdv-theme', theme); } catch (e) { /* fine */ }
    applyTheme(theme);
  });
  applyTheme(theme);

  // ------------------------------------------------------------------ bottom sheet (phone)
  const SHEET_ORDER = ['peek', 'half', 'full'];
  function setSheet(stateName) {
    $sheet.dataset.state = stateName;
    document.getElementById('sheet-handle').setAttribute('aria-label', stateName === 'full' ? 'Show less' : 'Show more');
  }
  // Drag the sheet by its handle or its title: it follows the finger, then snaps to the nearest size.
  // (Before, the browser also sent a "click" after the drag, which moved the sheet one size further: the jump back.)
  (() => {
    const grips = [document.getElementById('sheet-handle'), $sheet.querySelector('.brand')];
    let y0 = null, h0 = 0, moved = false;
    const sizes = () => ({ peek: 150, half: window.innerHeight * 0.52, full: window.innerHeight - 64 });
    grips.forEach(g => {
      g.addEventListener('pointerdown', e => {
        if (!PHONE.matches || e.target.closest('#theme-btn')) return;
        y0 = e.clientY; h0 = $sheet.offsetHeight; moved = false; g.setPointerCapture(e.pointerId);
      });
      g.addEventListener('pointermove', e => {
        if (y0 == null) return;
        const dy = e.clientY - y0;
        if (Math.abs(dy) > 6) moved = true;
        if (moved) { $sheet.style.transition = 'none'; $sheet.style.height = Math.max(120, Math.min(sizes().full, h0 - dy)) + 'px'; }
      });
      const end = () => {
        if (y0 == null) return;
        y0 = null; $sheet.style.transition = ''; 
        if (!moved) return;
        const hNow = $sheet.offsetHeight, S = sizes();
        const best = Object.keys(S).reduce((a, k) => Math.abs(S[k] - hNow) < Math.abs(S[a] - hNow) ? k : a, 'half');
        $sheet.style.height = ''; setSheet(best);
        g.dataset.justDragged = '1'; setTimeout(() => { delete g.dataset.justDragged; }, 50);
      };
      g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    });
    document.getElementById('sheet-handle').addEventListener('click', e => {
      if (e.currentTarget.dataset.justDragged) return;           // that "click" was the end of a drag
      const k = SHEET_ORDER.indexOf($sheet.dataset.state);
      setSheet(SHEET_ORDER[k === SHEET_ORDER.length - 1 ? 0 : k + 1]);
    });
  })();
  function syncSheetOffset() {
    const off = PHONE.matches ? $sheet.offsetHeight : 0;
    document.documentElement.style.setProperty('--sheet-offset', off + 'px');
    pad3D();
  }
  function pad3D() {
    if (!map3d) return;
    map3d.setPadding(PHONE.matches ? { left: 0, right: 0, top: 50, bottom: $sheet.offsetHeight } : { left: $sheet.offsetWidth + 32, right: 0, top: 0, bottom: 0 });
  }
  new ResizeObserver(syncSheetOffset).observe($sheet);
  PHONE.addEventListener('change', () => { syncSheetOffset(); map.invalidateSize(); });

  // ------------------------------------------------------------------ how the meeting point is chosen
  // fair  = minimax: the last person arrives as early as possible (the default, and what the professor asked)
  // total = min-sum: least travel time for the group, even if one person travels much longer
  // me    = closest to me (not offered in a live group: every phone would get a different answer)
  const myIndex = () => state.group ? state.group.idx : 0;
  const GOALS = {
    fair: { label: 'Fairest', explain: 'the last person arrives as early as possible' },
    total: { label: 'Least travel', explain: 'the smallest total travel time for the group' },
    me: { label: 'Closest to me', explain: 'the shortest trip for you' }
  };
  const goalValue = (r, goal) => goal === 'total' ? r.sum : goal === 'me' ? r.times[myIndex()] : r.max;
  function goalHtml(meet) {
    const goals = state.group ? ['fair', 'total'] : ['fair', 'total', 'me'];
    const label = k => k === 'me' && !state.group ? 'Closest to ' + state.people[0].key : GOALS[k].label;
    return '<div class="goal"><div class="seg" role="radiogroup" aria-label="Choose the meeting point by">' +
      goals.map(k => '<button type="button" role="radio" data-goal="' + k + '" aria-checked="' + (state.goal === k) + '">' + label(k) + '</button>').join('') + '</div>' +
      '<p class="goal-why">' + (state.goal === 'me' && !state.group ? 'The shortest trip for ' + state.people[0].key : GOALS[state.goal].explain[0].toUpperCase() + GOALS[state.goal].explain.slice(1)) +
      ' · total travel <strong>' + clock(meet.sum) + '</strong> min</p>' +
      '<div class="how"><button type="button" class="act-pill" data-wave>' + ICON_WAVE + 'Watch Dijkstra</button>' +
      '<button type="button" class="act-pill" data-heat aria-pressed="' + state.heat + '">' + ICON_HEAT + 'Fairness map</button></div></div>';
  }
  function setGoal(goal) {
    if (!GOALS[goal] || goal === state.goal) return;
    state.goal = goal; state.chosen = null;
    if (state.group) state.group.backend.setGoal(state.group.code, goal);
    update();
  }
  const ICON_WAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="17" r="2"/><path d="M6 11.5a5.5 5.5 0 0 1 5.5 5.5M6 6.5A10.5 10.5 0 0 1 16.5 17"/><path d="M19 4l.01 0"/></svg>';
  const ICON_HEAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18l5-6 4 3 7-9"/><path d="M4 6h3M4 10h2"/></svg>';

  // ------------------------------------------------------------------ fairness map
  // Every place on the map coloured by the chosen goal if the group met THERE: green = good, red = someone waits.
  // It shows why the meeting point wins, not only where it is.
  map.createPane('heat').style.zIndex = 390;                 // under the routes (400), over the base map
  const heatGroup = L.layerGroup().addTo(map);
  const heatRenderer = L.canvas({ pane: 'heat', padding: 0.3 });
  const RAMP = [[11, 159, 110], [242, 201, 76], [229, 72, 77]];   // green → yellow → red
  function rampColor(f) {
    f = Math.max(0, Math.min(1, f));
    const k = f < 0.5 ? 0 : 1, g = f < 0.5 ? f * 2 : (f - 0.5) * 2;
    return 'rgb(' + RAMP[k].map((c, j) => Math.round(c + (RAMP[k + 1][j] - c) * g)).join(',') + ')';
  }
  /** Goal value at every node: what it would cost if the group met there. */
  function nodeScores() {
    const ps = state.people.map(p => ({ D: matrices[p.mode].D[p.node], extra: approachSeconds(p) }));
    return N.map((n, v) => {
      const times = ps.map(p => p.extra + p.D[v]);
      return goalValue({ times, max: Math.max(...times), sum: times.reduce((s, t) => s + t, 0) }, state.goal);
    });
  }
  function heatRange(sc) {
    const fin = sc.filter(isFinite).sort((a, b) => a - b);
    const lo = fin[0], far = fin[Math.floor(fin.length * 0.95)] || fin[fin.length - 1];
    return [lo, Math.min(far, Math.max(lo * 2, lo + 60))];   // red = twice the best time: the contrast stays around the meeting point
  }
  function drawHeat() {
    heatGroup.clearLayers();
    if (!state.heat || !result || result.single || state.stale) return;
    const sc = nodeScores(), [lo, hi] = heatRange(sc), span = Math.max(1, hi - lo);
    for (const e of graph.edges) {
      if (N[e.a].layer !== state.layer || N[e.b].layer !== state.layer) continue;
      const s = (sc[e.a] + sc[e.b]) / 2;
      if (!isFinite(s)) continue;
      heatGroup.addLayer(L.polyline(segment(e.a, e.b), { renderer: heatRenderer, color: rampColor((s - lo) / span), weight: 7, opacity: 0.9,
        lineCap: 'round', interactive: false }));
    }
    if (legendShown()) showLegend(sc);
  }
  const $bar = document.getElementById('algo-bar');
  const legendShown = () => !$bar.hidden && $bar.dataset.mode === 'heat';
  function showLegend(sc) {
    if (!state.heat || !result || result.single) return;
    const [lo, hi] = heatRange(sc || nodeScores());
    const what = state.goal === 'total' ? 'Total travel time of the group' : state.goal === 'me' ? 'Your travel time' : 'When the last person arrives';
    $bar.dataset.mode = 'heat'; $bar.hidden = false;
    $bar.innerHTML = '<div class="bar-text"><strong>' + what + '</strong> if you met there</div>' +
      '<div class="ramp"><span>' + clock(lo) + '</span><i></i><span>' + clock(hi) + '+</span></div>' +
      '<button type="button" class="bar-close" data-bar-close aria-label="Hide the fairness map">✕</button>';
  }
  function toggleHeat(on) {
    stopWave();
    state.heat = on == null ? !state.heat : on;
    document.querySelectorAll('[data-heat]').forEach(b => b.setAttribute('aria-pressed', String(state.heat)));
    if (state.heat) { showLegend(); if (view === '3d') setView('plan'); if (PHONE.matches) setSheet('peek'); }
    else if ($bar.dataset.mode === 'heat') $bar.hidden = true;
    drawHeat();
  }
  $bar.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-bar-close')) { if ($bar.dataset.mode === 'heat') toggleHeat(false); else stopWave(); }
    if (b.hasAttribute('data-replay')) startWave();
  });

  // ------------------------------------------------------------------ watch Dijkstra
  // Each person's Dijkstra spreads like a wave at their own speed (slower on stairs, no stairs in a wheelchair).
  // A place is "reached" by a person at exactly the shortest time Dijkstra computed for it. With the fair
  // goal, the meeting point is the FIRST meeting place that every wave has reached: that is minimax.
  let wave = null;
  function startWave() {
    if (!result || result.single || state.stale || !isFinite(result.meet.max)) return;
    stopWave(); if (playing) stopPlayback();
    if (state.heat) toggleHeat(false);
    if (view === '3d') setView('plan');
    if (PHONE.matches) setSheet('peek');
    showOverview();
    const ps = state.people.map((p, i) => ({ key: p.key, color: personColor(i), mode: p.mode,
      D: matrices[p.mode].D[p.node], extra: approachSeconds(p), arrive: result.meet.times[i] }));
    const T = Math.max(...ps.map(p => p.arrive));
    const el = document.createElement('canvas'); el.className = 'wave-canvas';
    map.getContainer().appendChild(el);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    wave = { ps, T, end: T * 1.12, el, dur: reduce ? 1 : 9000, t0: performance.now(), raf: 0, t: 0 };
    $bar.dataset.mode = 'wave'; $bar.hidden = false;
    $bar.innerHTML = '<div class="bar-text" id="wave-text"></div><div class="wave-people" id="wave-people"></div>' +
      '<button type="button" class="bar-close" data-bar-close aria-label="Stop">✕</button>';
    map.on('move zoom resize', drawWave);
    tickWave();
  }
  function tickWave() {
    if (!wave) return;
    wave.t = Math.min(wave.end, (performance.now() - wave.t0) / wave.dur * wave.end);
    drawWave();
    if (wave.t < wave.end) wave.raf = requestAnimationFrame(tickWave);
  }
  function stopWave() {
    if (!wave) return;
    cancelAnimationFrame(wave.raf); map.off('move zoom resize', drawWave);
    wave.el.remove(); wave = null;
    if ($bar.dataset.mode === 'wave') $bar.hidden = true;
  }
  /** Points along a pixel polyline between fractions f0..f1 of its length. */
  function subLine(pts, f0, f1) {
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const L0 = f0 * len[len.length - 1], L1 = f1 * len[len.length - 1], out = [];
    const at = L => { let i = 1; while (i < len.length - 1 && len[i] < L) i++;
      const k = (L - len[i - 1]) / ((len[i] - len[i - 1]) || 1);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k }; };
    out.push(at(L0));
    for (let i = 1; i < len.length - 1; i++) if (len[i] > L0 && len[i] < L1) out.push(pts[i]);
    out.push(at(L1));
    return out;
  }
  function drawWave() {
    if (!wave) return;
    const { el, ps, t, T } = wave, size = map.getSize(), dpr = window.devicePixelRatio || 1;
    if (el.width !== size.x * dpr || el.height !== size.y * dpr) { el.width = size.x * dpr; el.height = size.y * dpr; el.style.width = size.x + 'px'; el.style.height = size.y + 'px'; }
    const c = el.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, size.x, size.y);
    c.lineCap = 'round'; c.lineJoin = 'round';
    const px = ll => map.latLngToContainerPoint(ll);
    const edges = graph.edges.filter(e => N[e.a].layer === state.layer && N[e.b].layer === state.layer);
    const geo = edges.map(e => segment(e.a, e.b).map(px));
    ps.forEach((p, k) => {
      const fronts = [];
      c.strokeStyle = p.color; c.globalAlpha = 0.85; c.lineWidth = Math.max(2.5, 8 - 2 * k);
      c.beginPath();
      edges.forEach((e, j) => {
        const w = RDV.edgeSeconds(e, p.mode, graph.settings);
        if (!isFinite(w) || w <= 0) return;
        const fa = Math.max(0, Math.min(1, (t - p.extra - p.D[e.a]) / w));
        const fb = Math.max(0, Math.min(1, (t - p.extra - p.D[e.b]) / w));
        if (fa + fb >= 1) { const pts = geo[j]; c.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach(q => c.lineTo(q.x, q.y)); return; }
        for (const [f0, f1, front] of [[0, fa, fa], [1 - fb, 1, 1 - fb]]) {
          if (f1 - f0 <= 0) continue;
          const pts = subLine(geo[j], f0, f1);
          c.moveTo(pts[0].x, pts[0].y); pts.slice(1).forEach(q => c.lineTo(q.x, q.y));
          fronts.push(front === fa ? pts[pts.length - 1] : pts[0]);
        }
      });
      c.stroke();
      c.globalAlpha = 1; c.fillStyle = p.color;          // the wave front
      for (const f of fronts) { c.beginPath(); c.arc(f.x, f.y, 3.5, 0, 7); c.fill(); }
    });
    // the meeting point lights up when the last wave reaches it
    const m = N[result.meet.node];
    if (m.layer === state.layer || state.layer === 'out') {
      const q = px(ll(m)), done = t >= T;
      c.globalAlpha = 1; c.lineWidth = 3; c.strokeStyle = done ? css('--accent') : css('--muted');
      c.beginPath(); c.arc(q.x, q.y, done ? 14 + 6 * Math.sin(performance.now() / 180) : 11, 0, 7); c.stroke();
      if (done && wave.t >= wave.end) requestAnimationFrame(() => wave && wave.t >= wave.end && drawWave());   // keep pulsing
    }
    waveText();
  }
  function waveText() {
    const { ps, t, T } = wave, m = N[result.meet.node];
    const $t = document.getElementById('wave-text'), $p = document.getElementById('wave-people');
    if (!$t) return;
    const done = t >= T;
    const msg = !done ? 'Dijkstra · <strong>' + clock(t) + '</strong> · each wave spreads at its own speed'
      : state.goal === 'fair' ? '<strong>' + esc(m.name) + '</strong> is the first meeting place every wave reaches: <strong>' + clock(T) + '</strong>'
      : 'Everyone has reached <strong>' + esc(m.name) + '</strong> at <strong>' + clock(T) + '</strong>';
    if ($t.innerHTML !== msg) $t.innerHTML = msg;
    const chips = ps.map(p => '<span class="wp" style="--c:' + p.color + '"' + (t >= p.arrive ? ' data-done' : '') + '>' + p.key +
      (t >= p.arrive ? ' ✓ ' + clock(p.arrive) : '') + '</span>').join('') + (done ? '<button type="button" class="act-pill" data-replay>Replay</button>' : '');
    if ($p.innerHTML !== chips) $p.innerHTML = chips;
  }

  // ------------------------------------------------------------------ my location (GPS)
  // GPS cannot tell the floor, so it snaps to the nearest campus path. Off campus, the person starts at the
  // nearest point of the campus and the time to get there is estimated (straight line × 1.3, at their speed)
  // and added to their total, so the meeting point stays fair for someone still on the way.
  const ON_CAMPUS_M = 60, DETOUR = 1.3, TOO_FAR_M = 15000;
  const outdoorNodes = N.map((n, i) => i).filter(i => N[i].layer === 'out');
  const speedOf = mode => graph.settings.modes[mode].speedOutdoor;
  function approachSeconds(p) {
    if (!p.gps) return 0;
    return p.gps.m * (p.gps.off ? DETOUR : 1) / speedOf(p.mode);
  }
  const km = m => m >= 1000 ? (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km' : Math.round(m) + ' m';
  function nearestPickableOut(node) {
    let best = node, bd = Infinity;
    for (const i of places) if (N[i].layer === 'out' && N[i].type !== 'bike_rack') { const d = map.distance(ll(N[i]), ll(N[node])); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  function personLabel(i) {
    const p = state.people[i];
    if (!p.gps) return placeLabel(p.node);
    return p.gps.off ? 'Off campus · ' + km(p.gps.m) + ' away' : 'My location · near ' + shortLabel(nearestPickableOut(p.node));
  }
  function gpsNote(i) {
    const p = state.people[i]; if (!p || !p.gps) return '';
    const t = Math.max(1, Math.round(approachSeconds(p) / 60));
    if (!p.gps.off) return 'From GPS' + (p.gps.acc > 50 ? ' (±' + Math.round(p.gps.acc) + ' m)' : '') + '. Inside a building? Pick your room instead: GPS can\'t tell the floor.';
    return 'About <strong>' + t + ' min</strong> to reach the campus (' + km(p.gps.m) + ' in a straight line, estimate) — counted in the meeting point. Arrives near ' + esc(shortLabel(nearestPickableOut(p.node))) + '.' +
      (p.mode !== 'bike' && p.gps.m > 3000 ? ' Coming by bus or car? Pick the bus stop or parking where you\'ll arrive.' : '');
  }
  function approachHtml(r, p) {
    if (!r.approach) return '';
    return '<p class="approach">' + ICON.locate + '<span>' + (r.approach.off
      ? 'First get to the campus: about <strong>' + Math.max(1, Math.round(r.approach.seconds / 60)) + ' min</strong> (' + km(r.approach.m) + ' as the crow flies, estimate). Then:'
      : 'Walk ' + km(r.approach.m) + ' to the nearest path. Then:') + '</span></p>';
  }
  const seatData = p => ({ node: N[p.node].id, mode: p.mode, gps: p.gps ? { m: Math.round(p.gps.m), off: p.gps.off, acc: Math.round(p.gps.acc || 0) } : null });
  /** Dashed line from where the GPS put you to where your route starts (campus view, this phone only). */
  function gpsLinks() {
    if (state.layer !== 'out' || (result && result.single)) return;
    state.people.forEach((p, i) => {
      if (!p.gps || p.gps.lat == null) return;
      const color = personColor(i);
      markerGroup.addLayer(L.polyline([[p.gps.lat, p.gps.lng], ll(N[p.node])], { color, weight: 3, dashArray: '2 7', lineCap: 'round', interactive: false }));
      markerGroup.addLayer(L.circleMarker([p.gps.lat, p.gps.lng], { radius: 7, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }).bindTooltip(p.key + ' · GPS'));
      if (p.gps.acc > 15 && !p.gps.off) markerGroup.addLayer(L.circle([p.gps.lat, p.gps.lng], { radius: p.gps.acc, color, weight: 1, fillOpacity: 0.08, interactive: false }));
    });
  }
  function locate(i, btn) {
    const $g = document.getElementById('gps-' + i);
    const say = html => { if ($g) { $g.hidden = false; $g.innerHTML = html; } };
    if (!('geolocation' in navigator)) return say('This browser cannot share your location. Pick your place instead.');
    btn.classList.add('busy'); say('Finding you…');
    navigator.geolocation.getCurrentPosition(pos => {
      btn.classList.remove('busy');
      const lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy || 0;
      let node = null, d = Infinity;
      for (const k of outdoorNodes) { const dk = map.distance([lat, lng], ll(N[k])); if (dk < d) { d = dk; node = k; } }
      if (d > TOO_FAR_M)
        return say('You are about ' + km(d) + ' from the campus: too far to plan the whole trip here. Pick where you will arrive (a bus stop or a parking) instead.');
      setPlace(i, node, { lat, lng, acc, m: d, off: d > ON_CAMPUS_M });
      if (state.layer !== 'out') showLayer('out');
      if (d <= ON_CAMPUS_M + 400) map.flyTo([lat, lng], Math.max(map.getZoom(), 17), { duration: 0.6 });
    }, err => {
      btn.classList.remove('busy');
      say(err.code === 1 ? 'Location is blocked. Allow it for this site in your browser settings, or pick your place.'
        : 'Could not get your location right now. Try again outside, or pick your place.');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  }

  // ------------------------------------------------------------------ live group (each person on their own phone)
  // Each phone takes a seat (A, B, C…) and writes only its own place and transport. Every phone runs the
  // same Dijkstra + minimax on all the seats, so all show the same meeting point; each sees its own trip first.
  const SEAT = KEYS.split('');
  const seatKeys = () => SEAT.slice(0, state.people.length);
  state.group = null;     // { code, seat, idx, backend, unsub, seats, shownOnce }

  function seatStatus(i) {
    const g = state.group; if (!g) return '';
    const s = g.seats[SEAT[i]];
    if (i === g.idx) return '<span class="live-dot"></span>You';
    if (!s) return 'Waiting for ' + SEAT[i] + ' to join…';
    return s.online === false ? 'Offline · last place shown' : '<span class="live-dot"></span>Live';
  }
  function groupBarHtml() {
    const g = state.group;
    if (!g) return '<div class="group-bar"><div class="group-intro"><strong>Meeting friends?</strong> Each person sets their own place on their phone.</div>' +
      '<div class="group-actions"><button type="button" class="act-pill strong" data-group="start">' + ICON_GROUP + 'Plan together</button>' +
      '<button type="button" class="act-pill" data-group="join">Join with a code</button></div>' +
      '<div class="join-row" id="join-row" hidden><input id="join-code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Code, e.g. K7P2Q" aria-label="Group code">' +
      '<button type="button" class="act-pill strong" data-group="join-go">Join</button></div>' +
      '<p class="field-error" id="join-err" hidden></p></div>';
    const n = seatKeys().filter(k => g.seats[k]).length;
    return '<div class="group-bar live"><div class="group-head"><span class="live-dot"></span><span>Live group <strong class="code">' + g.code + '</strong></span>' +
      '<span class="count">' + n + '/' + state.people.length + ' here</span></div>' +
      '<div class="group-actions"><button type="button" class="act-pill strong" data-group="invite">' + ICON_GROUP + 'Invite</button>' +
      '<button type="button" class="act-pill" data-group="leave">Leave</button></div>' +
      (g.backend.kind === 'local' ? '<p class="hint">Test mode: works between tabs of this browser. Add a Firebase config (js/config.js) to connect different phones.</p>' : '') +
      '<div class="invite" id="invite" hidden></div></div>';
  }
  const inviteLink = code => location.href.split('#')[0] + '#join-' + code;

  async function startGroup() {
    const backend = await RDVSync.getBackend();
    let code = RDVSync.newCode();
    for (let k = 0; k < 5 && await backend.exists(code); k++) code = RDVSync.newCode();
    await backend.create(code, state.people.length);
    await enterGroup(backend, code, 'A');
    groupAction('invite');
  }
  async function joinGroup(code) {
    const $err = document.getElementById('join-err');
    try {
      const backend = await RDVSync.getBackend();
      if (!(await backend.exists(code))) {
        if ($err) { $err.textContent = 'No group with code ' + code + '. Check the code with the person who invited you.'; $err.hidden = false; }
        else alertInPanel('No group with code ' + code + '.');
        return;
      }
      setCount(await backend.size(code));
      let prev = null; try { prev = sessionStorage.getItem('rdv-seat-' + code); } catch (e) { /* fine */ }
      await enterGroup(backend, code, prev);
    } catch (e) {
      alertInPanel('Could not join: ' + e.message);
    }
  }
  async function enterGroup(backend, code, preferred) {
    if (state.group) await leaveGroup(true);
    // start from my current row A, so a joining phone keeps what it had typed
    const k0 = preferred ? SEAT.indexOf(preferred) : 0;
    const mine = Object.assign({}, state.people[k0 >= 0 && k0 < state.people.length ? k0 : 0]);
    const seat = await backend.claim(code, preferred, seatData(mine), state.people.length);
    if (!seat) { alertInPanel('This group is already full (' + state.people.length + ' people).'); return; }
    const idx = SEAT.indexOf(seat);
    // my place and transport move into my seat's row
    Object.assign(state.people[idx], { node: mine.node, mode: mine.mode, gps: mine.gps });
    try { sessionStorage.setItem('rdv-seat-' + code, seat); } catch (e) { /* fine */ }
    state.group = { code, seat, idx, backend, seats: {}, shownOnce: false };
    if (location.hash !== '#join-' + code) history.replaceState(null, '', location.pathname + location.search + '#join-' + code);
    renderForm();
    state.group.unsub = backend.subscribe(code, (seats, meta) => onSeats(seats, meta));
    pushMine();
  }
  async function leaveGroup(silent) {
    const g = state.group; if (!g) return;
    if (g.unsub) g.unsub();
    try { await g.backend.leave(g.code, g.seat); } catch (e) { /* offline: fine */ }
    state.group = null;
    if (!silent) { history.replaceState(null, '', location.pathname + location.search); renderForm(); update(); }
  }
  function pushMine() {
    const g = state.group; if (!g) return;
    const me = state.people[g.idx];
    g.backend.write(g.code, g.seat, seatData(me));
  }
  /** Seats changed (someone joined, moved or left): update their rows and recompute. */
  function onSeats(seats, meta) {
    const g = state.group; if (!g) return;
    g.seats = seats || {};
    if (meta && meta.goal && meta.goal !== state.goal && meta.goal !== 'me') { state.goal = meta.goal; state.chosen = null; }
    seatKeys().forEach((k, i) => {
      const s = g.seats[k];
      if (i !== g.idx && s && idx(s.node) != null) {
        state.people[i].node = idx(s.node); state.people[i].mode = s.mode || 'walk';
        state.people[i].gps = s.gps && s.gps.m ? { m: s.gps.m, off: !!s.gps.off, acc: s.gps.acc || 0 } : null;   // no coordinates are shared
        const $in = document.getElementById('where-' + i); if ($in) $in.value = personLabel(i);
        const $g = document.getElementById('gps-' + i); if ($g) { $g.hidden = !state.people[i].gps; $g.innerHTML = gpsNote(i); }
        document.querySelectorAll('#person-' + i + ' [data-mode]').forEach(x => x.setAttribute('aria-checked', String(x.dataset.mode === state.people[i].mode)));
      }
      if (i !== g.idx && !s) { const $in = document.getElementById('where-' + i); if ($in) $in.value = ''; }
      const $st = document.getElementById('seat-' + i); if ($st) $st.innerHTML = seatStatus(i);
    });
    const $c = document.querySelector('.group-bar .count'); if ($c) $c.textContent = seatKeys().filter(k => g.seats[k]).length + '/' + state.people.length + ' here';
    const everyone = seatKeys().every(k => g.seats[k]);
    if (!everyone) {
      const waiting = seatKeys().filter(k => !g.seats[k]).join(', ').replace(/, (\w)$/, ' and $1');
      const $r = document.getElementById('result');
      if ($r) $r.innerHTML = '<p class="hint group-wait">Waiting for ' + waiting + ' to join. The meeting point appears on every phone as soon as everyone is here.</p>';
      drawPending(); return;
    }
    if (!g.wasFull) { g.wasFull = true; const $i = document.getElementById('invite'); if ($i) $i.hidden = true; }
    update();                                             // same result on every phone
    if (!g.shownOnce) { g.shownOnce = true; showOverview(); }
  }
  function alertInPanel(msg) {
    const $e = document.getElementById('join-err');
    if ($e) { $e.textContent = msg; $e.hidden = false; }
  }
  function groupAction(what, btn) {
    const g = state.group;
    if (what === 'start') return startGroup().catch(e => alertInPanel('Could not start a group: ' + e.message));
    if (what === 'join') { const $r = document.getElementById('join-row'); $r.hidden = !$r.hidden; if (!$r.hidden) document.getElementById('join-code').focus(); return; }
    if (what === 'join-go') { const v = document.getElementById('join-code').value.trim().toUpperCase(); if (v.length === 5) joinGroup(v); else alertInPanel('A group code has 5 characters.'); return; }
    if (what === 'leave') return leaveGroup(false);
    if (what === 'invite' && g) {
      const $i = document.getElementById('invite');
      if (!$i.hidden && btn) { $i.hidden = true; return; }
      const link = inviteLink(g.code);
      $i.innerHTML = '<div class="invite-code">' + g.code.split('').map(c => '<span>' + c + '</span>').join('') + '</div>' +
        '<div class="qr" id="qr" aria-label="QR code to join"></div>' +
        '<p class="hint">Friends scan the QR code, open the link, or tap "Join with a code" and type the code.</p>' +
        '<div class="invite-link"><input readonly id="invite-url" value="' + esc(link) + '" aria-label="Invite link"><button type="button" class="act-pill strong" data-group="copy">Copy link</button></div>';
      $i.hidden = false;
      drawQR(link);
      return;
    }
    if (what === 'copy') {
      const $u = document.getElementById('invite-url');
      const ok = () => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy link'), 1500); };
      try { navigator.clipboard.writeText($u.value).then(ok, () => { $u.select(); }); } catch (e) { $u.select(); }
    }
  }
  $panel.addEventListener('keydown', ev => { if (ev.target.id === 'join-code' && ev.key === 'Enter') { ev.preventDefault(); groupAction('join-go'); } });
  async function drawQR(text) {
    const $q = document.getElementById('qr'); if (!$q) return;
    try {
      if (!window.qrcode) await new Promise((ok, fail) => { const el = document.createElement('script');
        el.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'; el.onload = ok; el.onerror = fail; document.head.appendChild(el); });
      const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
      $q.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch (e) { $q.innerHTML = '<p class="hint">QR code needs an internet connection; share the code or the link instead.</p>'; }
  }
  const ICON_GROUP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.5 6-5.5s5.4 2.1 6 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16.5 14.6c2.6.2 4.1 2 4.5 4.9"/></svg>';

  // ------------------------------------------------------------------ helpers
  function layerName(id) { const l = graph.layers.find(x => x.id === id); return l ? l.name : id; }
  function short(t) {
    if (!isFinite(t)) return '—';
    const s = Math.round(t); return s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ------------------------------------------------------------------ start
  buildBaseLayers();
  state.single = readHash();
  if (!state.single) renderForm();
  update();
  showLayer(state.single ? N[state.single.from].layer : 'out');
  const joinAtStart = /^#join-([A-Z0-9]{5})$/i.exec(location.hash);
  if (joinAtStart) joinGroup(joinAtStart[1].toUpperCase());
  const onTheme = () => { drawRoutes(); refresh3D(true); };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
  new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
