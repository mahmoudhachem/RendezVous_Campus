/*
 * Rendez-vous Campus — live groups.
 *
 * A group is 2 to 6 seats (A, B, C…). Each phone takes one seat and writes only its own
 * position and transport. Every phone reads all three seats and runs the same Dijkstra + minimax
 * locally, so all phones show the same meeting point without the server computing anything.
 *
 * Data:   groups/<CODE> = { size, seats: { <A..F>: { node, mode, gps: { m, off, acc } | null, online, at, by } } }
 *        (gps holds only the distance to the campus, never coordinates)
 *
 * Two backends with the same interface:
 *   - Firebase Realtime Database (between phones), when window.RDV_FIREBASE is set in js/config.js
 *   - "local" (BroadcastChannel + localStorage): between tabs of the same browser, for testing
 */
(function (root) {
  'use strict';
  const SEATS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const FB = 'https://cdn.jsdelivr.net/npm/firebase@10.12.2/';

  /** Short code without look-alike characters (no 0/O, 1/I/L). */
  function newCode() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    const r = (root.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint32Array(5)) : [0, 0, 0, 0, 0].map(() => Math.random() * 1e9);
    for (let k = 0; k < 5; k++) s += abc[r[k] % abc.length];
    return s;
  }
  /** One id per browser tab (survives a refresh), so a phone gets its own seat back but never takes someone else's. */
  const CLIENT = (() => {
    try { let id = sessionStorage.getItem('rdv-client'); if (!id) { id = newCode() + newCode(); sessionStorage.setItem('rdv-client', id); } return id; }
    catch (e) { return newCode() + newCode(); }
  })();
  /** A seat can be taken if it is empty, its phone went offline, or it is already mine. */
  const free = cur => !cur || cur.online === false || cur.by === CLIENT;
  /** My own seat first (after a refresh), then the one asked for, then A, B, C. */
  const seatOrder = (seats, preferred, size) => {
    const all = SEATS.slice(0, size || 3);
    const mine = all.filter(k => seats[k] && seats[k].by === CLIENT);
    return mine.concat(preferred && all.includes(preferred) ? [preferred] : [], all).filter((k, i, a) => a.indexOf(k) === i);
  };
  const loadScript = src => new Promise((ok, fail) => {
    const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = () => fail(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });

  // ---------------------------------------------------------------- Firebase backend
  async function firebaseBackend(cfg) {
    if (!root.firebase) { await loadScript(FB + 'firebase-app-compat.js'); await loadScript(FB + 'firebase-database-compat.js'); }
    const app = root.firebase.apps.length ? root.firebase.app() : root.firebase.initializeApp(cfg);
    const db = app.database();
    return {
      kind: 'firebase',
      async exists(code) { return (await db.ref('groups/' + code).once('value')).exists(); },
      async create(code, size) { await db.ref('groups/' + code).set({ created: root.firebase.database.ServerValue.TIMESTAMP, size: size || 3 }); },
      async size(code) { return (await db.ref('groups/' + code + '/size').once('value')).val() || 3; },
      /** Take the first free seat (a transaction, so two phones never get the same letter). */
      async claim(code, preferred, data, size) {
        const seats = (await db.ref('groups/' + code + '/seats').once('value')).val() || {};
        const order = seatOrder(seats, preferred, size);
        for (const seat of order) {
          const ref = db.ref('groups/' + code + '/seats/' + seat);
          const res = await ref.transaction(cur => free(cur) ? Object.assign({}, data, { by: CLIENT, online: true, at: Date.now() }) : undefined);
          if (res.committed) { ref.child('online').onDisconnect().set(false); return seat; }
        }
        return null;
      },
      write(code, seat, data) { return db.ref('groups/' + code + '/seats/' + seat).update(Object.assign({}, data, { by: CLIENT, online: true, at: Date.now() })); },
      subscribe(code, cb) {
        const ref = db.ref('groups/' + code);
        const h = snap => { const g = snap.val() || {}; cb(g.seats || {}, { goal: g.goal || null }); };
        ref.on('value', h);
        return () => ref.off('value', h);
      },
      setGoal(code, goal) { return db.ref('groups/' + code + '/goal').set(goal); },
      /** Free my seat; the last one out deletes the group. */
      async leave(code, seat) {
        await db.ref('groups/' + code + '/seats/' + seat).remove();
        const left = (await db.ref('groups/' + code + '/seats').once('value')).val();
        if (!left) await db.ref('groups/' + code).remove();
      }
    };
  }

  // ---------------------------------------------------------------- local backend (same browser)
  function localBackend() {
    const key = code => 'rdv-group-' + code;
    const read = code => { try { return JSON.parse(localStorage.getItem(key(code)) || 'null'); } catch (e) { return null; } };
    const chan = 'BroadcastChannel' in root ? new BroadcastChannel('rdv-groups') : null;
    const listeners = new Set();
    const save = (code, g) => {
      try { localStorage.setItem(key(code), JSON.stringify(g)); } catch (e) { /* storage blocked */ }
      if (chan) chan.postMessage(code);
      listeners.forEach(l => l(code));
    };
    if (chan) chan.onmessage = ev => listeners.forEach(l => l(ev.data));
    root.addEventListener('storage', ev => { if (ev.key && ev.key.startsWith('rdv-group-')) listeners.forEach(l => l(ev.key.slice(10))); });
    const mySeats = [];
    root.addEventListener('pagehide', () => mySeats.forEach(([code, seat]) => {
      const g = read(code); if (g && g.seats && g.seats[seat]) { g.seats[seat].online = false; save(code, g); }
    }));
    return {
      kind: 'local',
      async exists(code) { return !!read(code); },
      async create(code, size) { save(code, { created: Date.now(), size: size || 3, seats: {} }); },
      async size(code) { const g = read(code); return (g && g.size) || 3; },
      async claim(code, preferred, data, size) {
        const g = read(code) || { seats: {} }; g.seats = g.seats || {};
        const seats = g.seats;
        const order = seatOrder(seats, preferred, size);
        const seat = order.find(s => free(g.seats[s]));
        if (!seat) return null;
        g.seats[seat] = Object.assign({}, data, { by: CLIENT, online: true, at: Date.now() });
        save(code, g); mySeats.push([code, seat]);
        return seat;
      },
      async write(code, seat, data) {
        const g = read(code); if (!g) return;
        g.seats[seat] = Object.assign({}, g.seats[seat] || {}, data, { by: CLIENT, online: true, at: Date.now() });
        save(code, g);
      },
      subscribe(code, cb) {
        const l = c => { if (c === code) { const g = read(code); cb((g && g.seats) || {}, { goal: (g && g.goal) || null }); } };
        listeners.add(l); l(code);
        return () => listeners.delete(l);
      },
      async setGoal(code, goal) { const g = read(code); if (g) { g.goal = goal; save(code, g); } },
      async leave(code, seat) {
        const g = read(code); if (!g || !g.seats) return;
        delete g.seats[seat];
        if (Object.keys(g.seats).length) save(code, g);
        else { try { localStorage.removeItem(key(code)); } catch (e) { /* fine */ } }
      }
    };
  }

  let backend = null;
  async function getBackend() {
    if (backend) return backend;
    backend = root.RDV_FIREBASE ? await firebaseBackend(root.RDV_FIREBASE) : localBackend();
    return backend;
  }

  root.RDVSync = { SEATS, newCode, getBackend, isShared: () => !!root.RDV_FIREBASE };
})(typeof self !== 'undefined' ? self : this);
