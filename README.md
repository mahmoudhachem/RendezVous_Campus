# Rendez-vous Campus

Find the fairest meeting point for 3 people on the Campus des Portes du Jura (Montbéliard),
indoors (Bât. C, UFR STGI) and outdoors, by walking, wheelchair or bike.

## How it works

1. **Graph** – `data/outdoor.json` (campus paths, drawn on the campus guide map) and
   `data/indoor_batC.json` (Bât. C floors) are merged into one graph. Each edge has a length,
   a kind (`path`, `corridor`, `door`, `stairs`, `elevator`, `entrance`…) and optional directions text.
2. **Weights** – travel time in seconds, computed per mode (`js/algorithms.js → edgeSeconds`):
   - walk 1.3 m/s, wheelchair 1.0 m/s (no stairs / spiral), bike 4.5 m/s outdoors and walking indoors (+30 s to park)
   - stairs 20 s/floor, spiral 25 s/floor, elevator 30 s/floor + 20 s waiting
3. **Dijkstra** (binary heap) from every node → distance matrix `D` + predecessors `P`, one per mode.
4. **IsTransitive** – the 3 loops (k, i, j) check `D[i][j] <= D[i][k] + D[k][j]`. 0 updates = matrix is complete.
5. **Minimax** – among the `meetable` nodes, choose the one whose **longest** trip is shortest (ties: smallest total).
6. **Directions** – rebuild each person's path from `P` and read the edge instructions.

## Run

```bash
npm test                 # algorithm tests (Node, no dependencies)
npm start                # serves the folder at http://localhost:8080
npm run build            # dist/rendezvous-campus.html, one file, open directly
```

## Editing the graph

- Turn on **How it works → Show the graph on the map** to see every node and edge, then tap the
  map to read `x, y` coordinates for new nodes.
- Outdoor coordinates are pixels on `assets/campus_map.jpg` (1598 × 850). `meta.scale_m_per_px`
  converts them to meters (0.35 is an estimate: calibrate it with one real distance).
- An edge without `length_m` gets its length from the coordinates.
- Indoor and outdoor are joined by `entrance` edges in `outdoor.json` (`C0_EXIT_HALL ↔ OUT_C_MAIN`, `C0_EXIT_SIDE ↔ OUT_C_SIDE`).
- Mark a node `"meetable": true` to make it a candidate meeting point.

## To do

- Room numbers for the 1st floor (C1xx) and the remaining 2nd floor rooms (C2xx)
- Measure one outdoor distance to calibrate the campus map (indoor scale comes from the 1.5 m corridor)
- Check step-free entrances and the passages through Bât. 6 and Bât. A
- V2: share positions live between 3 phones (e.g. Firebase), Dijkstra animation

## Indoor data

`tools/make_indoor.py` generates `data/indoor_batC.json`
(`python3 tools/make_indoor.py data/indoor_batC.json`). Coordinates are pixels on the 2nd-floor
evacuation plan photo, 0.031 m per pixel (corridor width 1.5 m ≈ 48 px). The ground-floor plan
hangs rotated by 90° on the wall, so its points are turned to match the upper floors.

## Real coordinates and OpenStreetMap (v1.0)

Everything is now placed on real latitude/longitude:

- `data/osm/campus_export.json` – raw OpenStreetMap export of the campus area (Overpass Turbo).
- `tools/osm_to_graph.py` – turns the OSM footpaths, lanes and steps into the outdoor graph
  (crossings become nodes, each stretch of path becomes an edge with its real length in meters),
  snaps the campus buildings, bus stops, bike racks and parkings onto the paths, and links the
  Bât. C doors. It also writes a light base map (building outlines + paths) used by the app.
- `tools/make_indoor.py` – places the Bât. C floors on the OSM outline of "UFR STGI - bât. C"
  (`georef` in the file: turned 16°, 0.031 m per plan pixel). Change those numbers if the overlay is off.

Rebuild the data in this order:

```bash
python3 tools/make_indoor.py data/indoor_batC.json
python3 tools/osm_to_graph.py data/osm/campus_export.json data/outdoor.json data/indoor_batC.json
npm test && npm run build
```

The map shows the campus drawn from the OSM data (works offline). "Street map" switches to the
OpenStreetMap tiles when online. When picking a position, "use my location" uses the phone's GPS
(outdoors) and snaps to the nearest campus place.

Map data © OpenStreetMap contributors, ODbL.

## Proving the shortest paths

`npm run verify` (about 20 s) checks the algorithm against methods that share no code with it:

1. **Dijkstra vs Floyd–Warshall** written separately from the edge list: all 293 × 293 distances, for each transport, must be identical.
2. **Every path is real**: each of the 85 849 paths is rebuilt, each step must be an existing, allowed link, and the sum of its links must equal the distance.
3. **Transport rules**: no wheelchair route uses stairs or steps; walking is never slower than a wheelchair; no outdoor route is shorter than the straight line; A→B takes as long as B→A.
4. **Minimax**: 500 random groups of 3 people with random transports; a separate scan of every meeting place must find none with a shorter longest trip (and ties go to the smallest total).
5. **Random graphs vs brute force**: 300 small random graphs; Dijkstra must match trying every possible path.

Check 3 found a real data bug: meters per degree of latitude was rounded (110 540 m), making outdoor lengths 0.6 % short. Fixed with the exact value for Montbéliard's latitude.

## Live groups (each person on their own phone)

Tap **Plan together**: the app creates a group with a 5-letter code and shows a QR code and a link.
The others scan the QR code, open the link, or tap **Join with a code**. Each phone takes a seat
(A, B, C…; the group has as many seats as people chosen when it was started) and edits only its own place and transport; the other two rows update live.
As soon as everyone is in, every phone runs the same Dijkstra + minimax and shows the same
meeting point, with **its own trip opened first** (marked "You").

- Only the seats are shared: `groups/<CODE> = { size, seats: { A..F: { node, mode, gps, online, at, by } } }`.
  `gps` is only the distance to the campus, never coordinates.
  The server computes nothing; no names, no GPS.
- Refreshing the page gives you your own seat back. If a phone closes, its seat shows "Offline"
  and keeps its last place; someone new can take it.
- **Leave** frees your seat.

### Test mode (no setup)
While `js/config.js` contains `window.RDV_FIREBASE = null`, groups work between tabs/windows
of the **same browser** (localStorage + BroadcastChannel). Good for demos on one laptop:
open three tabs, start in one, join from the other two.

### Real phones: Firebase Realtime Database (free plan)
1. https://console.firebase.google.com → **Add project** (Analytics not needed).
2. **Build → Realtime Database → Create database**, location *europe-west1*, start in *locked mode*.
3. **Rules** tab, paste and **Publish**:
   ```json
   {
     "rules": {
       "groups": {
         "$code": {
           ".read": true,
           ".write": "$code.length === 5",
           "seats": { "$seat": { ".validate": "$seat.matches(/^[A-F]$/)" } }
         }
       }
     }
   }
   ```
   (Anyone with a code can read/write that group, which is fine for a campus demo; nothing personal is stored.)
4. **Project settings → Your apps → Web (</>)** → register the app → copy `firebaseConfig`
   into `js/config.js` as `window.RDV_FIREBASE = { ... }` (must include `databaseURL`).
5. Phones need the app on a real web address (not `localhost`): e.g. push the folder to GitHub
   and turn on **Settings → Pages**, or `npm run build` and upload `dist/rendezvous-campus.html`.
   Then open the address on each phone.

## How many people, and "Use my location"

- **Who's meeting? − / +**: 2 to 6 people (A–F). Minimax works for any number: the meeting point is the
  place where the *last* person to arrive arrives soonest.
- **Use my location** (target button next to each place): the phone's GPS snaps to the nearest campus path.
  GPS cannot tell the floor, so inside Bât. C it is better to pick the room.
- **Not on campus yet?** If the GPS is more than 60 m from any campus path, the person starts at the
  nearest point of the campus, and the time to get there is **estimated**: straight-line distance × 1.3
  (detour factor) at that person's speed (walk 1.3 m/s, wheelchair 1.0, bike 4.5). That time is added to
  their trip *and to the minimax*, so the meeting point moves towards the one still on the way.
  Beyond 15 km the app asks to pick the arrival point instead (bus stop, parking).
- GPS needs HTTPS (or localhost) and the user's permission.

## Keeping the Firebase config out of the repository

`js/config.js` is in `.gitignore`: keep your real config there on your computer only
(start from `js/config.example.js`). GitHub Pages gets it from a repository secret instead:

1. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**,
   name `FIREBASE_CONFIG`, value = the config object as JSON, e.g.
   `{"apiKey":"AIza...","authDomain":"...","databaseURL":"https://...firebasedatabase.app","projectId":"...","appId":"..."}`
2. **Settings → Pages → Source: GitHub Actions**.
3. Push to `main`: `.github/workflows/pages.yml` writes `js/config.js` and publishes the site.

The deployed site still sends the key to every visitor's browser (it has to, to connect);
this only keeps it out of the code. The data is protected by the Realtime Database rules.

## Explaining the choice: goals, fairness map, Dijkstra wave

- **Fairest / Least travel / Closest to me** (in the meeting card): minimax (default), min-sum, or the
  shortest trip for one person. In a live group the goal is shared, so every phone keeps the same
  result ("Closest to me" is hidden there, since it would differ per phone).
- **Fairness map**: every path coloured by the goal value if the group met there (green = best,
  red = twice the best time or more). It shows *why* the meeting point wins.
- **Watch Dijkstra**: each person's Dijkstra drawn as a wave spreading at that person's speed
  (stairs slower, no stairs in a wheelchair, bike outside only). A place is reached at exactly its
  shortest time, so with the fair goal the meeting point is **the first meeting place that every
  wave has reached**, which is the definition of minimax. Switch floors to watch it inside.
