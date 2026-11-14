"""
Build the outdoor graph from an OpenStreetMap export.

    python3 tools/osm_to_graph.py data/osm/campus_export.json data/outdoor.json data/indoor_batC.json

1. Keep the walkable OSM ways (footways, paths, service lanes, streets, steps) inside the campus area.
2. Turn them into a graph: one vertex per crossing / dead end, one edge per stretch of way between
   two vertices (its OSM shape is kept for drawing, its length in meters is measured on that shape).
3. Snap the campus places (buildings, bus stops, bike racks, parkings) onto the nearest path.
4. Write data/outdoor.json (nodes with lat/lng, edges with length_m) + a light base map
   (building outlines and path lines) so the app can draw the campus without any tile server.

Bât. C doors are linked to the paths later by tools/make_indoor.py (it knows where the doors are).
"""
import json, math, sys
from collections import defaultdict

SRC, OUT = sys.argv[1], sys.argv[2]
LAT0, LON0 = 47.4952, 6.8046                  # local origin (Bât. C), meters east / north from here
# meters per degree at this latitude (WGS84 ellipsoid); the rounded 110540 m/deg used before
# made lengths ~0.6 % too short (found by tests/verify_shortest_paths.js)
_phi = math.radians(LAT0)
KY = 111132.954 - 559.822 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
KX = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)
CLIP = (-275, -165, 275, 200)                  # x1, y1, x2, y2 in local meters
to_xy = lambda lat, lon: ((lon - LON0) * KX, (lat - LAT0) * KY)
to_ll = lambda x, y: [round(LAT0 + y / KY, 7), round(LON0 + x / KX, 7)]
inside = lambda p: CLIP[0] <= p[0] <= CLIP[2] and CLIP[1] <= p[1] <= CLIP[3]

data = json.load(open(SRC))['elements']
onode = {e['id']: e for e in data if e['type'] == 'node' and 'lat' in e}
oway = [e for e in data if e['type'] == 'way']
P = {i: to_xy(n['lat'], n['lon']) for i, n in onode.items()}

WALK = {'footway', 'path', 'pedestrian', 'service', 'living_street', 'residential', 'unclassified',
        'tertiary', 'steps', 'cycleway', 'track'}
def via_text(t):
    if t.get('name'): return t['name']
    hw = t['highway']
    if hw == 'footway' and t.get('footway') == 'crossing': return 'the pedestrian crossing'
    if hw == 'footway' and t.get('footway') == 'sidewalk': return 'the sidewalk'
    return {'footway': 'the footpath', 'pedestrian': 'the footpath', 'path': 'the path', 'steps': 'the steps',
            'service': 'the campus lane', 'cycleway': 'the cycle path', 'track': 'the track'}.get(hw, 'the street')

# ---------------------------------------------------------------- 1-2. graph of OSM nodes, then compress
seg = defaultdict(list)                        # osm node -> [(osm node, attrs)]
for w in oway:
    t = w.get('tags', {})
    if t.get('highway') not in WALK or t.get('access') in ('private', 'no') or t.get('area') == 'yes': continue
    attrs = (t['highway'] == 'steps', via_text(t), t['highway'], t.get('incline') if t['highway'] == 'steps' else None,
             t.get('step_count') if t['highway'] == 'steps' else None)
    for a, b in zip(w['nodes'], w['nodes'][1:]):
        if a in P and b in P and inside(P[a]) and inside(P[b]) and a != b:
            seg[a].append((b, attrs, 1)); seg[b].append((a, attrs, -1))   # 1 = same direction as the OSM way

# keep the biggest connected piece
seen, best = set(), []
for s in seg:
    if s in seen: continue
    comp, stack = [], [s]; seen.add(s)
    while stack:
        u = stack.pop(); comp.append(u)
        for v, _, _ in seg[u]:
            if v not in seen: seen.add(v); stack.append(v)
    if len(comp) > len(best): best = comp
keep = set(best)

def is_vertex(u):
    nb = seg[u]
    return len(nb) != 2 or nb[0][1] != nb[1][1]
vertices = {u for u in keep if is_vertex(u)}
edges, done = [], set()
for u in vertices:
    for v, attrs, sgn in seg[u]:
        if (u, v) in done: continue
        chain, prev, cur = [u, v], u, v
        while cur not in vertices:
            nxt = [x for x, at, _ in seg[cur] if x != prev][0]
            chain.append(nxt); prev, cur = cur, nxt
        for a, b in zip(chain, chain[1:]): done.add((a, b)); done.add((b, a))
        pts = [P[i] for i in chain]
        L = sum(math.dist(p, q) for p, q in zip(pts, pts[1:]))
        if L < 0.3: continue
        inc = attrs[3]
        if inc in ('up', 'down') and sgn < 0: inc = 'down' if inc == 'up' else 'up'   # walked against the OSM way
        edges.append({'a': chain[0], 'b': chain[-1], 'pts': pts, 'steps': attrs[0], 'via': attrs[1], 'hw': attrs[2], 'L': L,
                      'incline': inc if inc in ('up', 'down') else None, 'step_count': attrs[4]})

# ---------------------------------------------------------------- 3. places
# Checked on site (14 Nov 2026): OSM has the labels of Bât. B and Bât. C swapped.
# Bât. C (UFR STGI, our indoor plans) is the building next to the "Campus" bus stop = OSM way 155113787.
BATC_WAY = 155113787
SWAP = {155113787: 'UFR STGI - bât. C', 32428347: 'UFR STGI - bât. B'}
def poly(way_id):
    w = next(x for x in oway if x['id'] == way_id)
    return [P[i] for i in w['nodes'] if i in P]

def proj(p, a, b):
    ax, ay = a; bx, by = b; dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)))
    q = (ax + t * dx, ay + t * dy)
    return math.dist(p, q), q

vid = {}                                       # vertex key -> output node id
new_points = {}                                # synthetic vertex key -> xy
def snap(p, avoid_steps=True):
    """Nearest point on the network; splits the edge there and returns the vertex key."""
    best = None
    for ei, e in enumerate(edges):
        if avoid_steps and e['steps']: continue
        for k, (a, b) in enumerate(zip(e['pts'], e['pts'][1:])):
            d, q = proj(p, a, b)
            if best is None or d < best[0]: best = (d, ei, k, q)
    d, ei, k, q = best
    e = edges[ei]
    for end, pt in ((e['a'], e['pts'][0]), (e['b'], e['pts'][-1])):
        if math.dist(q, pt) < 2.0: return end, d
    key = 'S%d' % len(new_points); new_points[key] = q
    p1 = e['pts'][:k + 1] + [q]; p2 = [q] + e['pts'][k + 1:]
    L1 = sum(math.dist(a, b) for a, b in zip(p1, p1[1:])); L2 = sum(math.dist(a, b) for a, b in zip(p2, p2[1:]))
    edges[ei] = dict(e, b=key, pts=p1, L=L1)
    edges.append(dict(e, a=key, pts=p2, L=L2))
    return key, d

PLACES = []   # (id, name, type, meetable, xy, building ref)
def building(id, name, way, meet=True, ref=None, type='building'):
    pts = poly(way)
    PLACES.append((id, name, type, meet, pts, ref))
def point(id, name, type, xy, meet=False):
    PLACES.append((id, name, type, meet, [xy], None))

building('OUT_BU', 'Bibliothèque universitaire (BU)', 304083388, ref='17')
building('OUT_RESTO', 'Restaurant universitaire', 155028296, ref='20')
building('OUT_MEMO', 'MéMO – Maison des étudiants', 155113749, ref='21')
building('OUT_AMPHI13', 'Amphithéâtre F. Vion-Delphin (STGI)', 155113726, ref='13')
building('OUT_AMPHI15', 'Amphi B STGI', 32428348, ref='15')
building('OUT_AMPHI14', 'Amphi GACO / R&T', 155028368, ref='14')
building('OUT_BATA', 'UFR STGI – Bât. A', 155113747, False, ref='1')
building('OUT_BATB', 'UFR STGI – Bât. B', 32428347, False, ref='2')   # OSM calls this one "bât. C" (swapped, see SWAP)
building('OUT_MMI', 'IUT MMI', 155113722, False, ref='7')
building('OUT_NUMERICA', 'Numerica', 155030712, False, ref='11')
building('OUT_FEMTO', 'Chrono-Environnement / FEMTO-ST', 155028114, False, ref='9')
building('OUT_RT', 'IUT Réseaux et Télécoms (R&T)', 1336880930, False, ref='6')
building('OUT_GACO', 'IUT GACO', 1336797834, False, ref='5')
building('OUT_IFMS', 'IFMS', 969311918, False, ref='24')
building('OUT_SPORT', 'Espaces sportifs des Portes du Jura', 155028218, False)
point('OUT_BUS_CAMPUS_S', 'Bus stop Campus', 'bus_stop', P[4876779235], True)
point('OUT_BUS_CAMPUS_N', 'Bus stop Campus (other side)', 'bus_stop', P[4876779236], True)
point('OUT_BUS_DONZELOT', 'Bus stop Donzelot', 'bus_stop', P[8744120721], True)
for wid, nm in [(304083387, 'Parking (north, UTBM)'), (304083386, 'Parking (north-west)'), (304081912, 'Parking (east)'),
                (1334808741, 'Parking (west, FEMTO)'), (969311924, 'Parking (Numerica)')]:
    pts = poly(wid); c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    point('OUT_P_%d' % wid, nm, 'parking', c)

# bike racks: OSM nodes and areas, named after the closest building
racks = [(n['id'], P[n['id']], n['tags'].get('capacity')) for n in onode.values()
         if n.get('tags', {}).get('amenity') == 'bicycle_parking' and inside(P[n['id']])]
for w in oway:
    if w.get('tags', {}).get('amenity') == 'bicycle_parking':
        pts = poly(w['id']); c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        if inside(c): racks.append((w['id'], c, w['tags'].get('capacity')))
bnames = [(nm, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) for _, nm, ty, _, pts, _ in PLACES if ty == 'building']
seen_names = {}
for rid, xy, cap in racks:
    near = min(bnames, key=lambda b: math.dist(xy, (b[1], b[2])))[0]
    nm = 'Bike rack near ' + near.replace('UFR STGI – ', '')
    seen_names[nm] = seen_names.get(nm, 0) + 1
    if seen_names[nm] > 1: nm += ' (%d)' % seen_names[nm]          # several racks by the same building
    if cap: nm += ', %s places' % cap
    point('OUT_RACK_%d' % rid, nm, 'bike_rack', xy)

# Bât. C doors (positions come from tools/make_indoor.py)
DOORS = []
if len(sys.argv) > 3:
    indoor = json.load(open(sys.argv[3]))
    DOORS = [n for n in indoor['nodes'] if n['type'] == 'entrance']

out_nodes = []
link_edges = []
# ---------------------------------------------------------------- doors
# Where each building is entered. In order of trust:
#   1. data/entrances.json (checked on site, editable by hand: {"OUT_IFMS": [lat, lng], ...})
#   2. OSM entrance nodes on the building outline
#   3. a guess: the outline point that is close to a path AND faces the middle of the campus
#      (a door on the far side of a building is rare; the old "closest point to any path" rule
#       put the IFMS door on its back side).
import os
CAMPUS_MIDDLE = (-15, 5)                     # between Bât. A, B and C, local meters
ENTR_FILE = os.path.join(os.path.dirname(OUT), 'entrances.json')
ENTR = json.load(open(ENTR_FILE)) if os.path.exists(ENTR_FILE) else {}
osm_doors = {i: P[i] for i, n in onode.items() if 'entrance' in n.get('tags', {}) and i in P}
DOOR_SOURCE = {}
def d_path(p):
    return min(proj(p, a, b)[0] for e in edges if not e['steps'] for a, b in zip(e['pts'], e['pts'][1:]))
def door_of(pid, pts):
    if pid in ENTR:
        DOOR_SOURCE[pid] = 'checked'; return to_xy(*ENTR[pid])
    if len(pts) == 1:
        DOOR_SOURCE[pid] = 'point'; return pts[0]
    poly_set = set(pts)
    tagged = [q for q in osm_doors.values() if min(proj(q, a, b)[0] for a, b in zip(pts, pts[1:])) < 2.0]
    if tagged:
        DOOR_SOURCE[pid] = 'osm'
        return min(tagged, key=lambda q: math.dist(q, CAMPUS_MIDDLE))
    cands = pts + [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) for a, b in zip(pts, pts[1:])]
    DOOR_SOURCE[pid] = 'guess'
    return min(cands, key=lambda q: d_path(q) + 0.25 * math.dist(q, CAMPUS_MIDDLE))

for id, name, type, meet, pts, ref in PLACES:
    # the building node sits on the outline point closest to a path; then a short link to the path
    cand = door_of(id, pts)
    key, d = snap(cand)
    n = {'id': id, 'name': name, 'layer': 'out', 'type': type, 'lat': to_ll(*cand)[0], 'lng': to_ll(*cand)[1], 'meetable': meet}
    if ref: n['building'] = ref
    if type == 'building': n['door'] = DOOR_SOURCE.get(id, 'guess')
    out_nodes.append(n)
    link_edges.append({'from': id, 'to': key, 'kind': 'path', 'via': 'the entrance path', 'length_m': round(max(d, 1.0), 1)})

for door in DOORS:
    key, d = snap(to_xy(door['lat'], door['lng']))
    link_edges.append({'from': door['id'], 'to': key, 'kind': 'entrance', 'length_m': round(max(d, 1.0), 1),
                       'instr': {'fwd': 'Leave Bât. C through the ' + ('main doors.' if 'HALL' in door['id'] else 'side door.'),
                                 'back': 'Enter Bât. C through the ' + ('main doors into the hall.' if 'HALL' in door['id'] else 'side door.')}})

# ---------------------------------------------------------------- 4. output
used = {e['a'] for e in edges} | {e['b'] for e in edges}
for k in used:
    xy = new_points[k] if isinstance(k, str) else P[k]
    vid[k] = 'OUT_J%d' % len(vid)
    lat, lng = to_ll(*xy)
    out_nodes.append({'id': vid[k], 'name': 'Path', 'layer': 'out', 'type': 'junction', 'lat': lat, 'lng': lng, 'meetable': False})
out_edges = []
for e in edges:
    d = {'from': vid[e['a']], 'to': vid[e['b']], 'kind': 'stairs_outdoor' if e['steps'] else 'path', 'via': e['via'],
         'length_m': round(e['L'], 1), 'geometry': [to_ll(*p) for p in e['pts']]}
    if e['steps']:
        d['access'] = {'wheelchair': False, 'bike': False}
        if e.get('incline'): d['incline'] = e['incline']          # going from "from" to "to"
        if e.get('step_count'): d['step_count'] = int(e['step_count'])
    out_edges.append(d)
for l in link_edges:
    l['to'] = vid[l['to']]; out_edges.append(l)

# light base map: building outlines and path lines inside the area
base_b, base_p = [], []
for w in oway:
    t = w.get('tags', {})
    pts = [P[i] for i in w['nodes'] if i in P]
    if not pts or not any(inside(p) for p in pts): continue
    if 'building' in t and t.get('building') != 'roof':
        base_b.append({'name': SWAP.get(w['id']) or t.get('short_name') or t.get('name') or '', 'batc': w['id'] == BATC_WAY,
                       'uni': t.get('building') in ('university', 'college') or 'amenity' in t,
                       'poly': [to_ll(*p) for p in pts]})
    elif t.get('highway') in WALK | {'primary', 'secondary'} and t.get('area') != 'yes':
        base_p.append({'kind': 'road' if t['highway'] in ('primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street') else ('steps' if t['highway'] == 'steps' else 'path'),
                       'line': [to_ll(*p) for p in pts]})

out = {
    'meta': {'version': '1.0', 'source': 'OpenStreetMap contributors (ODbL), export of 2026-11-14',
             'description': 'Outdoor graph of Campus des Portes du Jura built from OpenStreetMap paths.',
             'origin': {'lat': LAT0, 'lng': LON0}},
    'layers': [{'id': 'out', 'name': 'Campus', 'floor': None}],
    'nodes': out_nodes, 'edges': out_edges,
    'basemap': {'buildings': base_b, 'paths': base_p,
                'bounds': [to_ll(CLIP[0], CLIP[1]), to_ll(CLIP[2], CLIP[3])]}
}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
print(len(out_nodes), 'nodes', len(out_edges), 'edges,', len(base_b), 'buildings', len(base_p), 'path lines')
