/*
 * Spatial checks, data-quality checks and space-time clustering (ST-DBSCAN) for the case list.
 */
(function (global) {
  'use strict';

  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  function haversine(lat1, lon1, lat2, lon2) {
    const dl = rad(lat2 - lat1), dn = rad(lon2 - lon1);
    const a = Math.sin(dl / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Square grid over lat/lon (cell size in metres) so neighbour searches only look at nearby cells.
  function makeGrid(items, cellM) {
    const lat0 = items.length ? items[0].lat : 11.6;
    const my = 111320, mx = 111320 * Math.cos(rad(lat0));
    const gx = (lon) => Math.floor((lon * mx) / cellM), gy = (lat) => Math.floor((lat * my) / cellM);
    const cells = new Map();
    items.forEach((it, i) => {
      const k = gx(it.lon) + ':' + gy(it.lat);
      let c = cells.get(k);
      if (!c) { c = []; cells.set(k, c); }
      c.push(i);
    });
    return {
      cellM, gx, gy,
      cell: (x, y) => cells.get(x + ':' + y),
      // calls fn(index) for every item in the (2r+1) x (2r+1) block of cells around a point
      around(lat, lon, r, fn) {
        const x = gx(lon), y = gy(lat);
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          const c = cells.get((x + dx) + ':' + (y + dy));
          if (c) for (let i = 0; i < c.length; i++) fn(c[i]);
        }
      }
    };
  }

  /* ---------- Point in polygon ---------- */
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function polys(g) {
    return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  }
  function inGeom(x, y, g) {
    return polys(g).some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));
  }
  function bbox(g) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    polys(g).forEach((p) => p[0].forEach(([x, y]) => {
      if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y;
    }));
    return [a, b, c, d];
  }

  function buildGeoIndex(hudData) {
    const villages = hudData.villages.features.map((f) => ({ f, bb: bbox(f.geometry) }));
    const hud = hudData.hud.features[0].geometry;
    const hudVerts = [];
    polys(hud).forEach((p) => p[0].forEach((v) => hudVerts.push(v)));
    const locateFeature = (lon, lat) => {
      for (const v of villages) {
        const [a, b, c, d] = v.bb;
        if (lon < a || lon > c || lat < b || lat > d) continue;
        if (inGeom(lon, lat, v.f.geometry)) return v.f;
      }
      return null;
    };
    return {
      locateFeature,
      locate(lon, lat) {
        const f = locateFeature(lon, lat);
        return f ? f.properties : null;
      },
      kmOutside(lon, lat) {
        let best = Infinity;
        for (const [x, y] of hudVerts) best = Math.min(best, haversine(lat, lon, y, x));
        return best / 1000;
      }
    };
  }

  /* ---------- Enrichment and data quality ---------- */
  const normName = (s) => String(s || '').toLowerCase().replace(/^(mr|mrs|miss|ms|master|baby|b\/o)\.?\s*/i, '').replace(/[^a-z]/g, '');
  // Edit distance where swapping two neighbouring letters counts as one edit (Krishna / Krishan).
  function osa(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  const similarName = (a, b) => {
    const x = normName(a), y = normName(b);
    if (!x || !y) return false;
    return x === y || osa(x, y) <= 1 || (x.length > 4 && y.length > 4 && (x.startsWith(y) || y.startsWith(x)));
  };

  function enrichAndCheck(cases, geo) {
    const issues = [];
    const add = (c, severity, type, detail) => {
      issues.push({ uid: c.uid, severity, type, detail, disease: c.disease, sheet: c.sheet, row: c.row, file: c.file, name: c.name, day: c.day });
      c.flags.push(type);
    };

    cases.forEach((c) => {
      c.flags = [];
      c.village = null; c.villageLgd = null; c.geoHealthBlock = null; c.inHud = false; c.kmOutside = null;
      c.dupOf = null; c.laterDengue = null; c.alsoInFever = null;
      if (c.lat === null) {
        add(c, 'high', 'Missing coordinates', c.coordRaw.some((v) => v !== null && v !== '') ? `Unreadable value: ${c.coordRaw.join(', ')}` : 'Latitude / longitude blank');
      } else {
        const v = geo.locate(c.lon, c.lat);
        if (v) {
          c.village = v.village_name; c.villageLgd = v.village_lgd; c.villageType = v.unit_type; c.geoHealthBlock = v.health_block; c.inHud = true;
        } else {
          c.kmOutside = geo.kmOutside(c.lon, c.lat);
          add(c, c.kmOutside > 3 ? 'high' : 'medium', 'Outside HUD boundary', `${c.kmOutside.toFixed(1)} km outside the Attur HUD boundary`);
        }
        if (c.coordSwapped) add(c, 'info', 'Latitude and longitude swapped', 'Swapped back automatically');
        if (c.coordDecimals !== null && c.coordDecimals < 4) {
          add(c, 'medium', 'Low-precision coordinates', `Only ${c.coordDecimals} decimal place${c.coordDecimals === 1 ? '' : 's'} (accurate to about ${[11000, 1100, 110, 11][c.coordDecimals] || 11} m)`);
        }
        if (c.inHud && c.healthBlock && c.geoHealthBlock && c.healthBlock !== c.geoHealthBlock) {
          add(c, 'info', 'Block differs from location', `Line list says ${c.block}; the point falls in ${c.geoHealthBlock} health block`);
        }
      }
      if (c.day === null) add(c, 'high', 'Missing or unreadable date', 'No usable case date');
      if (c.dateBad) add(c, 'medium', 'Unreadable date', 'A date cell could not be read');
      if (c.onsetDay !== null && c.admDay !== null && c.onsetDay > c.admDay) add(c, 'medium', 'Onset after admission', 'Date of onset is later than the date of admission');
      if (c.onsetDay !== null && c.day !== null && c.day - c.onsetDay > 60) add(c, 'medium', 'Onset long before reporting', `Onset ${c.day - c.onsetDay} days before reporting (likely a year typo)`);
      if (c.admDay !== null && c.reportDay !== null && c.admDay > c.reportDay) add(c, 'low', 'Admission after reporting', 'Date of admission is later than the date of reporting');
      if (!c.blockKnown) add(c, 'low', 'Block name not recognised', `"${c.block}"`);
      if (c.sex === 'Unknown') add(c, 'low', 'Sex not recorded', 'Sex column blank or unreadable');
      if (c.ageYears === null) add(c, 'low', 'Age not recorded', 'Age column blank or unreadable');
    });

    // Possible duplicates within each disease: same phone, similar name, age within 2 years, within 7 days.
    // A duplicate must share a phone, a local body or a 1.5 km neighbourhood, so each case is compared
    // only with the few earlier cases that could qualify, not with every case of the same week.
    const my = 111320, mx = 111320 * Math.cos(rad(11.6)), CELL = 1500;
    const cellKey = (c, dx, dy) => (Math.floor((c.lon * mx) / CELL) + dx) + ':' + (Math.floor((c.lat * my) / CELL) + dy);
    const push = (m, k, c) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(c); };
    for (const dis of ['IP Fever', 'Dengue']) {
      const list = cases.filter((c) => c.disease === dis && c.day !== null);
      const order = new Map(list.map((c, i) => [c.uid, i]));
      list.sort((a, b) => a.day - b.day || order.get(a.uid) - order.get(b.uid));
      const rank = new Map(list.map((c, i) => [c.uid, i]));
      const byPhone = new Map(), byPlace = new Map(), byCell = new Map();
      for (const b of list) {
        const seen = new Set(), cands = [];
        const scan = (arr) => {
          if (!arr) return;
          for (let i = arr.length - 1; i >= 0; i--) {
            const a = arr[i];
            if (b.day - a.day > 7) break;
            if (!seen.has(a.uid)) { seen.add(a.uid); cands.push(a); }
          }
        };
        b.phones.forEach((ph) => scan(byPhone.get(ph)));
        scan(byPlace.get(b.localBody));
        if (b.lat !== null) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) scan(byCell.get(cellKey(b, dx, dy)));
        cands.sort((x, y) => rank.get(x.uid) - rank.get(y.uid)); // earliest match wins, as before
        for (const a of cands) {
          const phone = a.phones.some((ph) => b.phones.includes(ph));
          const place = a.localBody === b.localBody || (a.lat !== null && b.lat !== null && haversine(a.lat, a.lon, b.lat, b.lon) < 1500);
          if (!(phone || place)) continue;
          const age = a.ageYears === null || b.ageYears === null || Math.abs(a.ageYears - b.ageYears) <= 2;
          if (age && similarName(a.name, b.name)) {
            b.dupOf = a.uid;
            add(b, 'medium', 'Possible duplicate', `Looks like row ${a.row} (${a.name}, ${a.ageLabel}) reported ${b.day - a.day} day${b.day - a.day === 1 ? '' : 's'} earlier`);
            break;
          }
        }
        b.phones.forEach((ph) => push(byPhone, ph, b));
        push(byPlace, b.localBody, b);
        if (b.lat !== null) push(byCell, cellKey(b, 0, 0), b);
      }
    }

    // Fever cases that were later confirmed as dengue (same phone and similar name within 21 days).
    const dengueByPhone = new Map();
    cases.filter((c) => c.disease === 'Dengue' && c.day !== null).forEach((d) => d.phones.forEach((ph) => push(dengueByPhone, ph, d)));
    cases.filter((c) => c.disease === 'IP Fever' && c.day !== null && c.phones.length).forEach((f) => {
      const pool = [...new Set(f.phones.flatMap((ph) => dengueByPhone.get(ph) || []))].sort((a, b) => a.uid - b.uid);
      const m = pool.find((d) => similarName(f.name, d.name) && d.day - f.day >= -3 && d.day - f.day <= 21);
      if (m) {
        f.laterDengue = m.uid; m.alsoInFever = f.uid;
        add(f, 'info', 'Also in the dengue list', `Same patient appears in the dengue list (row ${m.row}, ${m.condition})`);
      }
    });
    return issues;
  }

  /* ---------- ST-DBSCAN ---------- */
  // Two cases are neighbours when they lie within epsM metres AND within `days` days of each other.
  // A cluster needs at least minPts cases in some case's neighbourhood (counting the case itself).
  function stDbscan(pts, epsM, days, minPts) {
    const n = pts.length;
    const order = pts.map((p, i) => i).sort((a, b) => pts[a].day - pts[b].day);
    const pos = new Array(n);
    order.forEach((idx, k) => { pos[idx] = k; });
    const nbrs = new Array(n);
    const grid = makeGrid(pts, epsM);
    for (let i = 0; i < n; i++) {
      const p = pts[i], list = [];
      grid.around(p.lat, p.lon, 1, (j) => {
        const q = pts[j];
        if (Math.abs(q.day - p.day) <= days && haversine(p.lat, p.lon, q.lat, q.lon) <= epsM) list.push(j);
      });
      list.sort((a, b) => pos[a] - pos[b]); // visit neighbours in time order, as a time-sorted scan would
      nbrs[i] = list;
    }
    const UNSEEN = -2, NOISE = -1;
    const label = new Array(n).fill(UNSEEN);
    const core = nbrs.map((l) => l.length >= minPts);
    let C = 0;
    for (const i of order) {
      if (label[i] !== UNSEEN) continue;
      if (!core[i]) { label[i] = NOISE; continue; }
      label[i] = C;
      const queue = nbrs[i].filter((j) => j !== i);
      for (let h = 0; h < queue.length; h++) {
        const j = queue[h];
        if (label[j] === NOISE) label[j] = C;
        if (label[j] !== UNSEEN) continue;
        label[j] = C;
        if (core[j]) { const nb = nbrs[j]; for (let t = 0; t < nb.length; t++) if (label[nb[t]] < 0) queue.push(nb[t]); }
      }
      C++;
    }
    return { label, core };
  }

  const PREFIX = { 'Dengue': 'DEN', 'IP Fever': 'IPF', 'All': 'ALL' };
  const topCounts = (arr, k = 3) => {
    const m = new Map();
    arr.filter(Boolean).forEach((v) => m.set(v, (m.get(v) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  };

  // Runs ST-DBSCAN per disease (or on all cases together) and describes each cluster.
  function findClusters(cases, opts) {
    const { epsM, days, minPts, pooled, asOf } = opts;
    const groups = pooled ? { All: cases } : { 'Dengue': cases.filter((c) => c.disease === 'Dengue'), 'IP Fever': cases.filter((c) => c.disease === 'IP Fever') };
    const clusters = [];
    const membership = new Map();
    for (const [key, list] of Object.entries(groups)) {
      const pts = list.filter((c) => c.lat !== null && c.day !== null);
      if (!pts.length) continue;
      const { label, core } = stDbscan(pts, epsM, days, minPts);
      const byLabel = new Map();
      label.forEach((l, i) => { if (l >= 0) { if (!byLabel.has(l)) byLabel.set(l, []); byLabel.get(l).push(i); } });
      const found = [...byLabel.values()].map((idx) => {
        const members = idx.map((i) => pts[i]).sort((a, b) => a.day - b.day);
        const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
        const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
        const radius = members.reduce((r, m) => Math.max(r, haversine(lat, lon, m.lat, m.lon)), 0);
        const first = members[0].day, last = members[members.length - 1].day;
        return {
          key, members, coreCount: idx.filter((i) => core[i]).length,
          lat, lon, radius, first, last,
          spanDays: last - first + 1,
          diseases: topCounts(members.map((m) => m.disease), 2),
          blocks: topCounts(members.map((m) => m.block)),
          places: topCounts(members.map((m) => m.village || m.localBody), 4),
          recent7: members.filter((m) => m.day > asOf - 7).length,
          status: asOf - last <= days ? 'Active' : 'Closed',
          isNew: first > asOf - 7
        };
      }).sort((a, b) => a.first - b.first || b.members.length - a.members.length);
      found.forEach((c, i) => {
        c.id = `${PREFIX[key]}-${String(i + 1).padStart(2, '0')}`;
        c.members.forEach((m) => membership.set(m.uid, c.id));
        clusters.push(c);
      });
    }
    return { clusters, membership };
  }

  // Clark–Evans nearest-neighbour ratio: <1 means cases are more clustered than random.
  function nearestNeighbourIndex(pts, areaKm2) {
    const n = pts.length;
    if (n < 3) return null;
    const A = areaKm2 * 1e6;
    const grid = makeGrid(pts, Math.max(50, 0.5 / Math.sqrt(n / A)));
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      let best = Infinity;
      const x = grid.gx(p.lon), y = grid.gy(p.lat);
      for (let r = 0; r < 400; r++) {
        // ring r = cells exactly r steps (Chebyshev) from the point's own cell
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const c = grid.cell(x + dx, y + dy);
          if (c) for (const j of c) if (j !== i) { const d = haversine(p.lat, p.lon, pts[j].lat, pts[j].lon); if (d < best) best = d; }
        }
        if (best <= r * grid.cellM) break; // nothing in a further ring can be closer
      }
      sum += best;
    }
    const observed = sum / n;
    const expected = 0.5 / Math.sqrt(n / A);
    const se = 0.26136 / Math.sqrt((n * n) / A);
    return { ratio: observed / expected, z: (observed - expected) / se, observed, expected };
  }

  global.Analysis = { haversine, buildGeoIndex, enrichAndCheck, stDbscan, findClusters, nearestNeighbourIndex };
})(typeof window !== 'undefined' ? window : globalThis);
