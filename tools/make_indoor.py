import json, sys
out_path = sys.argv[1]
N, E = [], []
def node(id, name, floor, type, x, y, meet=False, **kw):
    d = {'id': id, 'name': name, 'layer': 'C%d' % floor, 'floor': floor, 'type': type, 'x': x, 'y': y, 'meetable': meet}
    d.update(kw); N.append(d)
def edge(a, b, kind, fwd=None, back=None, **kw):
    d = {'from': a, 'to': b, 'kind': kind}
    if fwd: d['instr'] = {'fwd': fwd, 'back': back}
    d.update(kw); E.append(d)

# ---------------------------------------------------------------- RDC
# Traced on the RDC evacuation plan, which hangs rotated 90 deg: points are turned
# and scaled so the RDC lines up with the floors above (elevator over elevator).
K = 0.8  # the RDC photo was taken closer: its elevator is 1.25x bigger than on the 2nd-floor photo
R = lambda x, y: (round(235 + K * (y - 368)), round(620 - K * (x - 452)))  # RDC elevator centre -> upper-floor elevator centre
def n0(id, name, type, px, py, meet=False, **kw):
    x, y = R(px, py); node(id, name, 0, type, x, y, meet, **kw)
n0('C0_HALL', 'Hall', 'hall', 170, 300, True)
n0('C0_EXIT_HALL', 'Main entrance (hall)', 'entrance', 25, 262)
n0('C0_EXIT_SIDE', 'Side entrance (near Archives)', 'entrance', 790, 488)
n0('C0_SPIRAL', 'Spiral staircase (hall)', 'spiral', 150, 440)
n0('C0_J_STAIRS', 'Foot of the main staircase', 'junction', 265, 165)
n0('C0_STAIR_A', 'Main staircase', 'stairs', 360, 100)
n0('C0_WC', 'Toilets (incl. PMR)', 'wc', 360, 260)
n0('C0_J_CORE', 'In front of the elevator', 'junction', 450, 460)
n0('C0_ELEVATOR', 'Elevator', 'elevator', 452, 368)
n0('C0_J_EAST', 'Corridor to the side entrance', 'junction', 642, 470)
n0('C0_J_OFFICES', 'Corridor to the offices', 'junction', 642, 310)
n0('C0_REPRO', 'Repro', 'service', 542, 362)
n0('C0_ARCHIVES', 'Archives', 'service', 715, 370)
n0('C0_SECRETARIAT', 'Secretariat', 'office', 560, 190)
n0('C0_DIRECTION', 'Direction', 'office', 715, 190)
n0('C0_ROOM_L', 'Lecture room C01', 'room', 220, 680, True, code='C01', verify=['C01 = room on the hall side?'], emergency_exit=True)
n0('C0_ROOM_R', 'Lecture room C02', 'room', 592, 680, True, code='C02', verify=['C02 = room on the side-entrance side?'], emergency_exit=True)

edge('C0_EXIT_HALL', 'C0_HALL', 'corridor', 'Walk into the hall.', 'Cross the hall to the main entrance.')
edge('C0_HALL', 'C0_SPIRAL', 'corridor', 'Walk to the spiral staircase in the hall.', 'Step off the spiral staircase into the hall.')
edge('C0_HALL', 'C0_J_STAIRS', 'corridor', 'Cross the hall to the main staircase.', 'Walk from the staircase into the hall.')
edge('C0_J_STAIRS', 'C0_STAIR_A', 'door', 'The main staircase is in front of you.', 'Leave the staircase.')
edge('C0_HALL', 'C0_WC', 'door', 'The toilets are off the hall.', 'Leave the toilets into the hall.')
edge('C0_HALL', 'C0_J_CORE', 'corridor', 'Cross the hall towards the elevator.', 'Walk back into the hall.')
edge('C0_HALL', 'C0_ROOM_L', 'door', 'Lecture room C01 opens off the hall.', 'Leave C01 into the hall.')
edge('C0_J_CORE', 'C0_ELEVATOR', 'door', 'The elevator is in front of you.', 'Step out of the elevator.')
edge('C0_J_CORE', 'C0_ROOM_R', 'door', 'Lecture room C02 is in front of you.', 'Leave C02 towards the elevator.')
edge('C0_J_CORE', 'C0_J_EAST', 'corridor', 'Walk past the elevator towards the offices.', 'Walk back towards the elevator.')
edge('C0_J_EAST', 'C0_REPRO', 'door', 'Repro is on your left.', 'Leave Repro.')
edge('C0_J_EAST', 'C0_J_OFFICES', 'corridor', 'Turn into the corridor between Repro and Archives.', 'Walk back to the main corridor.')
edge('C0_J_OFFICES', 'C0_ARCHIVES', 'door', 'Archives is on your right.', 'Leave Archives.')
edge('C0_J_OFFICES', 'C0_SECRETARIAT', 'door', 'The secretariat is on your left.', 'Leave the secretariat.')
edge('C0_J_OFFICES', 'C0_DIRECTION', 'door', 'Direction is on your right.', 'Leave Direction.')
edge('C0_J_EAST', 'C0_EXIT_SIDE', 'corridor', 'Leave through the side entrance.', 'Enter through the side entrance.')

# ---------------------------------------------------------------- floors 1 and 2 share the same T layout
def frame(f):
    p = 'C%d_' % f
    node(p+'J_TOP_W',   'Top corridor × central corridor', f, 'junction', 310, 268)
    node(p+'J_TOP_MIDW','Top corridor', f, 'junction', 540, 268)
    node(p+'J_TOP_MID', 'Landing at the top staircase', f, 'junction', 720, 268, True)
    node(p+'J_TOP_E',   'Top corridor, east end', f, 'junction', 885, 268)
    node(p+'J_MID',     'Central corridor (north)', f, 'junction', 310, 345)
    node(p+'J_LOW',     'Central corridor (middle)', f, 'junction', 310, 510)
    node(p+'J_CORE',    'Central corridor, at the elevator', f, 'junction', 310, 640, True)
    node(p+'J_BOTTOM',  'Central corridor (south)', f, 'junction', 310, 725)
    node(p+'J_SW',      'Corridor to the south-west stairs', f, 'junction', 150, 728)
    node(p+'STAIR_A',   'South-west staircase', f, 'stairs', 55, 680, sas=True)
    node(p+'STAIR_B',   'Top staircase', f, 'stairs', 725, 140, sas=True)
    node(p+'STAIR_E',   'East staircase (private wing)', f, 'stairs', 1015, 200, verify=['publicly accessible?'])
    node(p+'ELEVATOR',  'Elevator', f, 'elevator', 235, 612)
    node(p+'WC',        'Toilets (incl. PMR)', f, 'wc', 165, 650)
    edge(p+'J_TOP_W', p+'J_TOP_MIDW', 'corridor', 'Turn into the top corridor.', 'Walk along the top corridor to the central corridor.')
    edge(p+'J_TOP_MIDW', p+'J_TOP_MID', 'corridor', 'Continue along the top corridor.', 'Continue along the top corridor.')
    edge(p+'J_TOP_MID', p+'STAIR_B', 'door', 'The staircase is on your left.', 'Leave the stairwell into the top corridor.')
    edge(p+'J_TOP_MID', p+'J_TOP_E', 'corridor', 'Continue towards the east end of the corridor.', 'Walk back along the top corridor.')
    edge(p+'J_TOP_E', p+'STAIR_E', 'door', 'The east staircase is at the end.', 'Leave the stairwell.', access={'walk': True, 'wheelchair': False, 'bike': True})
    edge(p+'J_TOP_W', p+'J_MID', 'corridor', 'Turn into the central corridor.', 'Walk to the end of the central corridor.')
    edge(p+'J_MID', p+'J_LOW', 'corridor', 'Continue down the central corridor.', 'Continue up the central corridor.')
    edge(p+'J_LOW', p+'J_CORE', 'corridor', 'Continue down the central corridor to the elevator.', 'Walk up the central corridor.')
    edge(p+'J_CORE', p+'J_BOTTOM', 'corridor', 'Continue to the end of the central corridor.', 'Walk up the central corridor to the elevator.')
    edge(p+'J_BOTTOM', p+'J_SW', 'corridor', 'Turn right towards the south-west stairs.', 'Walk back to the central corridor.')
    edge(p+'J_SW', p+'STAIR_A', 'door', 'The staircase is at the end.', 'Leave the stairwell.')
    edge(p+'J_CORE', p+'ELEVATOR', 'door', 'The elevator is next to the toilets.', 'Step out of the elevator.')
    edge(p+'J_CORE', p+'WC', 'door', 'The toilets are next to the elevator.', 'Leave the toilets.')

def room(f, id, name, x, y, j, meet=True, type='room', code=None, fwd=None, back=None, guess=False):
    extra = {'verify': ['exact room for ' + code + '?']} if guess else {}
    node('C%d_%s' % (f, id), name, f, type, x, y, meet, code=code, **extra)
    edge('C%d_%s' % (f, j), 'C%d_%s' % (f, id), 'door', fwd or (name + ' is here.'), back or ('Leave ' + name + '.'))

# ---------------------------------------------------------------- 1st floor
frame(1)
node('C1_SPIRAL', 'Spiral staircase (top)', 1, 'spiral', 310, 830)
edge('C1_J_BOTTOM', 'C1_SPIRAL', 'corridor', 'The spiral staircase is at the end of the corridor.', 'Step off the spiral staircase into the corridor.')
room(1, 'TD', 'TD room (north-west)', 145, 165, 'J_TOP_W', fwd='The TD room is on your left at the corner.')
room(1, 'BUREAU_1', 'Office (north 1)', 297, 150, 'J_TOP_W', False, 'office')
room(1, 'BUREAU_2', 'Office (north 2)', 405, 150, 'J_TOP_W', False, 'office')
room(1, 'BUREAU_3', 'Office (north 3)', 520, 150, 'J_TOP_MIDW', False, 'office')
room(1, 'BUREAU_4', 'Office (by the stairs)', 632, 105, 'J_TOP_MIDW', False, 'office')
room(1, 'WC_N', 'Toilets (north)', 632, 202, 'J_TOP_MIDW', False, 'wc')
room(1, 'INFO_N', 'Computer room (east end)', 895, 102, 'J_TOP_E', code='C112', fwd='Go straight to the end of the corridor; C112 is the room furthest on your left.')
room(1, 'INFO_S', 'Office (east)', 895, 197, 'J_TOP_E', False, 'office', fwd='The office is on your left.')
room(1, 'REGIE', 'Régie', 190, 345, 'J_MID', False, 'office')
room(1, 'BUREAU_E', 'Office (central)', 385, 350, 'J_MID', False, 'office')
room(1, 'TD1', 'Lecture room (TD 1)', 150, 500, 'J_LOW', code='C104', fwd='C104 is on your right.')
room(1, 'TP2', 'Computer room (TP Info 2)', 450, 510, 'J_LOW', code='C103', fwd='C103 is on your left.')
room(1, 'RESEAUX', 'Network / server room', 390, 640, 'J_CORE', False, 'service')
room(1, 'BUREAU_ING', 'Bureau ingénieur', 500, 640, 'J_CORE', False, 'office')
room(1, 'TP1', 'Computer room (TP Info 1)', 445, 790, 'J_BOTTOM', code='C101', fwd='C101 is on your left.')

# ---------------------------------------------------------------- 2nd floor
# Numbers from the door signs (3 Nov). "guess" = type confirmed, exact room still to check.
frame(2)
room(2, 'TD_LANGUES', 'Computer room (TD Multimédia Langues)', 145, 165, 'J_TOP_W', code='C208', fwd='C208 is at the corner.')
room(2, 'BUREAU_1', 'Office', 290, 160, 'J_TOP_W', False, 'office', code='C209')
room(2, 'BUREAU_2', 'Office', 375, 160, 'J_TOP_W', False, 'office', code='C210')
room(2, 'TP6', 'Computer room (TP Info 6)', 540, 160, 'J_TOP_MIDW', code='C211', fwd='C211 is on your left.')
room(2, 'TP7', 'Computer room (TP Info 7)', 890, 165, 'J_TOP_E', code='C212', fwd='C212 is on your left.')
room(2, 'BUREAU_3', 'Office Multimédia & Informatique', 190, 345, 'J_MID', False, 'office', code='C207')
room(2, 'VIDEO', 'Bureau association', 385, 350, 'J_MID', False, 'office', code='C206')
room(2, 'TD2', 'Lecture room (TD 2)', 150, 500, 'J_LOW', code='C205', fwd='C205 is on your right.')
room(2, 'TP4', 'Computer room (TP Info 4)', 450, 510, 'J_LOW', code='C204', fwd='C204 is on your left.')
room(2, 'REUNION', 'Video-conference room (Salle de réunion)', 455, 640, 'J_CORE', code='C201', fwd='C201 is on your left.')
room(2, 'TP3', 'Computer room (TP Info 3)', 445, 790, 'J_BOTTOM', code='C203', fwd='C203 is on your left.')
room(2, 'TP5', 'Computer room (TP Info 5)', 190, 815, 'J_SW', code='C202', fwd='C202 is on your left.')

# ---------------------------------------------------------------- vertical links
def up(a, b, kind, word):
    edge(a, b, kind, floors=1)
up('C0_STAIR_A', 'C1_STAIR_A', 'stairs', '')
up('C1_STAIR_A', 'C2_STAIR_A', 'stairs', '')
up('C0_SPIRAL', 'C1_SPIRAL', 'spiral', '')
up('C0_ELEVATOR', 'C1_ELEVATOR', 'elevator', '')
up('C1_ELEVATOR', 'C2_ELEVATOR', 'elevator', '')
up('C1_STAIR_B', 'C2_STAIR_B', 'stairs', '')
up('C1_STAIR_E', 'C2_STAIR_E', 'stairs', '')

# ---------------------------------------------------------------- floor drawing (walls as on the evacuation plans)
# Each area is a rectangle [x1, y1, x2, y2] in the same pixels as the nodes.
# kind: room, corridor, stairs, elevator, wc, service, private, void. "node" links a room to its graph node.
A = []
def area(layer, kind, rect, node=None, label=None):
    d = {'layer': layer, 'kind': kind, 'rect': rect}
    if node: d['node'] = node
    if label: d['label'] = label
    A.append(d)

def rot(r):  # ground-floor plan rectangle -> common orientation (same turn as R)
    x1, y1, x2, y2 = r
    (ax, ay), (bx, by) = R(x1, y1), R(x2, y2)
    return [min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)]

# Ground floor, traced on the RDC plan in its own orientation, then turned
for kind, r, nd, lb in [
    ('corridor', [35, 95, 225, 510], None, None),          # hall
    ('corridor', [225, 185, 305, 510], None, None),
    ('corridor', [305, 410, 500, 510], None, None),         # lobby in front of the elevator
    ('corridor', [500, 445, 780, 510], None, None),         # corridor to the side entrance
    ('corridor', [625, 300, 660, 445], None, None),         # corridor between Repro and Archives
    ('stairs',   [225, 15, 500, 185], 'C0_STAIR_A', 'Stairs'),
    ('wc',       [305, 185, 490, 325], 'C0_WC', 'WC'),
    ('service',  [305, 325, 415, 410], None, None),
    ('elevator', [415, 325, 490, 410], 'C0_ELEVATOR', 'Lift'),
    ('room',     [500, 95, 625, 300], 'C0_SECRETARIAT', None),
    ('room',     [625, 95, 780, 300], 'C0_DIRECTION', None),
    ('room',     [500, 300, 625, 445], 'C0_REPRO', None),
    ('room',     [660, 300, 780, 445], 'C0_ARCHIVES', None),
    ('room',     [35, 510, 405, 850], 'C0_ROOM_L', None),
    ('room',     [405, 510, 780, 850], 'C0_ROOM_R', None),
]:
    area('C0', kind, rot(r), nd, lb)

def common(f):
    L = 'C%d' % f; p = L + '_'
    area(L, 'corridor', [250, 245, 1000, 290])               # top corridor
    area(L, 'corridor', [285, 290, 335, 750])                # central corridor
    area(L, 'corridor', [0, 700, 335, 750])                  # corridor to the south-west stairs
    area(L, 'stairs',   [690, 75, 790, 245], p + 'STAIR_B', 'Stairs')
    area(L, 'stairs',   [0, 595, 105, 700], p + 'STAIR_A', 'Stairs')
    area(L, 'wc',       [105, 590, 200, 700], p + 'WC', 'WC')
    area(L, 'elevator', [205, 595, 265, 645], p + 'ELEVATOR', 'Lift')
    area(L, 'service',  [200, 645, 285, 700])
    area(L, 'private',  [1000, 55, 1190, 290], p + 'STAIR_E', 'Private')

common(1)
for kind, r, nd, lb in [
    ('room', [40, 50, 250, 285], 'C1_TD', None),
    ('room', [250, 50, 345, 245], 'C1_BUREAU_1', None),
    ('room', [345, 50, 465, 245], 'C1_BUREAU_2', None),
    ('room', [465, 50, 575, 245], 'C1_BUREAU_3', None),
    ('room', [575, 50, 690, 160], 'C1_BUREAU_4', None),
    ('wc',   [575, 160, 690, 245], 'C1_WC_N', 'WC'),
    ('room', [790, 55, 1000, 150], 'C1_INFO_N', None),
    ('room', [790, 150, 1000, 245], 'C1_INFO_S', None),
    ('room', [115, 290, 285, 395], 'C1_REGIE', None),
    ('room', [335, 290, 435, 395], 'C1_BUREAU_E', None),
    ('room', [45, 395, 285, 590], 'C1_TD1', None),
    ('room', [335, 395, 565, 585], 'C1_TP2', None),
    ('room', [335, 585, 445, 700], 'C1_RESEAUX', None),
    ('room', [445, 585, 555, 700], 'C1_BUREAU_ING', None),
    ('room', [335, 700, 555, 875], 'C1_TP1', None),
    ('void', [50, 750, 285, 875], None, 'Void above the hall'),
    ('corridor', [285, 750, 335, 875], None, None),
]:
    area('C1', kind, r, nd, lb)

common(2)
for kind, r, nd, lb in [
    ('room', [40, 50, 250, 285], 'C2_TD_LANGUES', None),
    ('room', [250, 50, 330, 245], 'C2_BUREAU_1', None),
    ('room', [330, 50, 405, 245], 'C2_BUREAU_2', None),
    ('room', [405, 50, 690, 245], 'C2_TP6', None),
    ('room', [790, 60, 1000, 245], 'C2_TP7', None),
    ('room', [115, 290, 285, 395], 'C2_BUREAU_3', None),
    ('room', [335, 290, 435, 395], 'C2_VIDEO', None),
    ('room', [45, 395, 285, 590], 'C2_TD2', None),
    ('room', [335, 395, 565, 585], 'C2_TP4', None),
    ('room', [335, 585, 555, 700], 'C2_REUNION', None),
    ('room', [335, 700, 555, 875], 'C2_TP3', None),
    ('room', [50, 750, 330, 870], 'C2_TP5', None),
]:
    area('C2', kind, r, nd, lb)


# ---------------------------------------------------------------- real coordinates (georeference)
# The plans are drawn with north up (the T's long bar on the road side, as on the campus guide).
# OpenStreetMap's outline of Bât. C is turned 16 deg anticlockwise from north, so the plans are
# turned the same way, scaled at 0.031 m per pixel, and the ground-floor footprint is centred
# on the real Bât. C: the building next to the "Campus" bus stop (OSM has B and C swapped).
# Adjust these three numbers if the overlay looks off.
import math
LAT0, LON0 = 47.4952, 6.8046
# meters per degree at this latitude (WGS84 ellipsoid); the rounded 110540 m/deg used before
# made lengths ~0.6 % too short (found by tests/verify_shortest_paths.js)
_phi = math.radians(LAT0)
KY = 111132.954 - 559.822 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
KX = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)
ROT = math.radians(16)
ANCHOR_M = (-0.5, 30.2)           # centre of the real Bât. C (OSM way 155113787, labelled "bât. B" in OSM by mistake)
c0 = [a['rect'] for a in A if a['layer'] == 'C0']
ANCHOR_PX = ((min(r[0] for r in c0) + max(r[2] for r in c0)) / 2, (min(r[1] for r in c0) + max(r[3] for r in c0)) / 2)
M_PER_PX = 0.031
def px_to_ll(x, y):
    dx, dn = (x - ANCHOR_PX[0]) * M_PER_PX, -(y - ANCHOR_PX[1]) * M_PER_PX
    e = dx * math.cos(ROT) - dn * math.sin(ROT) + ANCHOR_M[0]
    n = dx * math.sin(ROT) + dn * math.cos(ROT) + ANCHOR_M[1]
    return [round(LAT0 + n / KY, 7), round(LON0 + e / KX, 7)]
for n in N:
    n['lat'], n['lng'] = px_to_ll(n['x'], n['y'])
for a in A:
    x1, y1, x2, y2 = a['rect']
    a['poly'] = [px_to_ll(x1, y1), px_to_ll(x2, y1), px_to_ll(x2, y2), px_to_ll(x1, y2)]
GEOREF = {'anchor_px': [round(v, 1) for v in ANCHOR_PX], 'anchor_m': ANCHOR_M, 'rotation_deg': 16, 'm_per_px': M_PER_PX,
          'origin': {'lat': LAT0, 'lng': LON0}}

out = {
  'meta': {
    'version': '0.3',
    'description': 'Indoor graph of Bâtiment C (UFR STGI): ground, 1st and 2nd floor, traced from the evacuation plans.',
    'coordinates': 'Pixels on the 2nd-floor evacuation plan photo; the ground-floor plan is rotated to the same orientation.',
    'scale_m_per_px': 0.031,
    'georef': GEOREF,
    'scale_source': 'Corridor width 1.5 m measured on site = about 48 px on the plan.',
    'todo': [
      '1st floor offices C102, C106-C111 and repro C105 (optional)',
      'Confirm C01 / C02 sides',
      'Does the top staircase (B) reach the ground floor?',
      'Is the east staircase (private wing) open to the public?',
      'Which entrances are step-free?'
    ]
  },
  'layers': [{'id': 'C0', 'name': 'Bât. C · RDC', 'floor': 0}, {'id': 'C1', 'name': 'Bât. C · 1er', 'floor': 1}, {'id': 'C2', 'name': 'Bât. C · 2e', 'floor': 2}],
  'nodes': N, 'edges': E, 'areas': A
}
ids = [n['id'] for n in N]
assert len(ids) == len(set(ids)), 'duplicate ids'
for e in E: assert e['from'] in ids and e['to'] in ids, e
for a in A: assert 'node' not in a or a['node'] in ids, a
short={'C1_RESEAUX':'Réseaux','C1_BUREAU_ING':'Bur. ing.','C0_EXIT_HALL':'Main door','C0_EXIT_SIDE':'Side door'}
for n in N:
    if n['id'] in short: n['short']=short[n['id']]
json.dump(out, open(out_path, 'w'), indent=1, ensure_ascii=False)
print(len(N), 'nodes', len(E), 'edges')
