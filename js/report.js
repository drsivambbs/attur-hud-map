/*
 * PowerPoint report: renders the maps to high-resolution images (basemap tiles, boundaries,
 * clusters, cases, scale bar, north arrow) and lays out a 16:9 deck with PptxGenJS. Legends,
 * tables and the weekly chart are native PowerPoint objects so they stay sharp and editable.
 */
(function () {
  'use strict';

  const A = () => window.AtturApp;
  const $ = (id) => document.getElementById(id);
  const hex = (c) => c.replace('#', '').toUpperCase();
  const FONT = 'Calibri';
  const C = {
    ink: '17211E', ink2: '47544F', ink3: '75827D', line: 'D8DFDB', accent: '0E6E5F', accentSoft: 'DCEFE9',
    panel: 'F4F6F5', dengue: 'C92A2A', fever: '1C6FC9', active: 'D9480F', closed: '6C757D', hud: 'B3202A'
  };
  const SLIDE_W = 13.333;
  const MAP_BOX = { x: 0.45, y: 1.3, w: 8.95, h: 5.62 };
  const PANEL = { x: 9.62, y: 1.3, w: 3.26, h: 5.62 };

  /* =================================================================
   * Map rendering
   * ================================================================= */
  const TILE = 256;
  const projZ0 = (lat, lon) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * TILE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE];
  };
  const loadImg = (src) => new Promise((res) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });

  function colorFor(c, mode) {
    const app = A(), st = app.state;
    if (mode === 'cluster') {
      const id = st.membership.get(c.uid);
      return id ? st.clusterColor.get(id) : '#9aa3a9';
    }
    if (mode === 'recency') {
      const age = app.refDay() - app.eday(c);
      return (app.RECENCY.find((r) => age < r.max) || app.RECENCY[app.RECENCY.length - 1]).color;
    }
    return app.DISEASE_COLOR[c.disease];
  }

  function heatPalette() {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 1;
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 256, 0);
    [[0.2, '#ffffb2'], [0.4, '#fecc5c'], [0.6, '#fd8d3c'], [0.8, '#f03b20'], [1, '#bd0026']].forEach(([o, c]) => gr.addColorStop(o, c));
    g.fillStyle = gr; g.fillRect(0, 0, 256, 1);
    return g.getImageData(0, 0, 256, 1).data;
  }

  async function renderMap(opt) {
    const app = A(), st = app.state, HUD = app.HUD;
    const W = opt.width, H = opt.height, S = W / 1100;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');

    const b = opt.bounds;
    const sw = projZ0(b.getSouth(), b.getWest()), ne = projZ0(b.getNorth(), b.getEast());
    const zf = Math.min(Math.log2((W * 0.94) / (ne[0] - sw[0])), Math.log2((H * 0.94) / (sw[1] - ne[1])));
    const k = 2 ** zf;
    const ox = ((sw[0] + ne[0]) / 2) * k - W / 2, oy = ((sw[1] + ne[1]) / 2) * k - H / 2;
    const P = (lat, lon) => { const p = projZ0(lat, lon); return [p[0] * k - ox, p[1] * k - oy]; };
    const mpp = (lat) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / k;

    ctx.fillStyle = '#f6f7f6';
    ctx.fillRect(0, 0, W, H);

    const base = app.basemapInfo();
    let tilesOk = 0, tilesTried = 0;
    if (base) {
      const zt = Math.max(0, Math.min(18, Math.round(zf)));
      const ts = TILE * 2 ** (zf - zt);
      const x0 = Math.floor(ox / ts), x1 = Math.floor((ox + W) / ts), y0 = Math.floor(oy / ts), y1 = Math.floor((oy + H) / ts);
      const jobs = [];
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const sd = base.subdomains[Math.abs(x + y) % base.subdomains.length];
          const url = base.url.replace('{z}', zt).replace('{x}', x).replace('{y}', y).replace('{s}', sd);
          tilesTried++;
          jobs.push(loadImg(url).then((im) => { if (im) { tilesOk++; ctx.drawImage(im, x * ts - ox, y * ts - oy, ts + 0.6, ts + 0.6); } }));
        }
      }
      await Promise.all(jobs);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(0, 0, W, H);
    }

    const tracePolys = (g) => {
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      polys.forEach((poly) => poly.forEach((ring) => {
        ring.forEach(([lon, lat], i) => { const [x, y] = P(lat, lon); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.closePath();
      }));
    };
    const strokeFC = (fc, color, w) => {
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = w * S; ctx.lineJoin = 'round';
      fc.features.forEach((f) => { ctx.beginPath(); tracePolys(f.geometry); ctx.stroke(); });
      ctx.restore();
    };

    // Fade everything outside the HUD (or the selected area) so it reads as the subject.
    // A block dashboard passes its own area, cases and hotspots; otherwise the screen's view is used.
    const focusGeom = opt.subject || app.focusGeometry();
    const subject = focusGeom || HUD.hud.features[0].geometry;
    const clusterList = opt.clusterList || st.clusters;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); tracePolys(subject);
    ctx.fillStyle = base ? 'rgba(255,255,255,0.5)' : 'rgba(230,233,231,0.9)';
    ctx.fill('evenodd');
    ctx.restore();
    if (!base) {
      ctx.save(); ctx.beginPath(); tracePolys(subject); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
    }

    if (app.layerOn('lyrVillages')) strokeFC(HUD.villages, 'rgba(70,70,70,0.5)', 0.7);
    if (app.layerOn('lyrBlocks')) strokeFC(HUD.blocks, '#1b1b1b', 1.6);
    if (app.layerOn('lyrHud')) strokeFC(HUD.hud, '#b3202a', 3.2);
    if (focusGeom) strokeFC({ features: [{ geometry: focusGeom }] }, '#0e6e5f', 4);

    const onlyCl = app.layerOn('optOnlyClustered') || opt.mode === 'cluster-only';
    const ctxCases = opt.contextCases || st.contextCases;
    const ctxSet = new Set(ctxCases.map((c) => c.uid));
    const pts = (opt.cases || st.filtered).concat(ctxCases)
      .filter((c) => c.lat !== null && (!onlyCl || st.membership.has(c.uid)))
      .sort((a, z) => app.eday(a) - app.eday(z));
    // Rarer and more important points go on top: Dengue over IP Fever, clustered over unclustered.
    const layerRank = (c) => (ctxSet.has(c.uid) ? -1 : 0) + (opt.mode === 'cluster' ? (st.membership.has(c.uid) ? 1 : 0) : (c.disease === 'Dengue' ? 1 : 0));
    const drawOrder = pts.slice().sort((a, z) => layerRank(a) - layerRank(z));

    if (opt.heat && app.layerOn('lyrHeat')) {
      const hc = document.createElement('canvas'); hc.width = W; hc.height = H;
      const h = hc.getContext('2d');
      const R = 30 * S;
      pts.forEach((c) => {
        const [x, y] = P(c.lat, c.lon);
        const g = h.createRadialGradient(x, y, 0, x, y, R);
        g.addColorStop(0, 'rgba(0,0,0,0.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        h.fillStyle = g; h.fillRect(x - R, y - R, 2 * R, 2 * R);
      });
      const img = h.getImageData(0, 0, W, H), pal = heatPalette(), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (!a) continue;
        const j = Math.min(255, a) * 4;
        d[i] = pal[j]; d[i + 1] = pal[j + 1]; d[i + 2] = pal[j + 2];
        d[i + 3] = Math.min(200, 50 + a * 1.4);
      }
      h.putImageData(img, 0, 0);
      ctx.drawImage(hc, 0, 0);
    }

    if (opt.clusters) {
      clusterList.forEach((c) => {
        const [x, y] = P(c.lat, c.lon);
        const r = Math.max(120, c.radius + 80) / mpp(c.lat);
        const col = c.status === 'Active' ? '#d9480f' : '#6c757d';
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = c.status === 'Active' ? 'rgba(217,72,15,0.12)' : 'rgba(108,117,125,0.10)';
        ctx.fill();
        ctx.setLineDash([6 * S, 4 * S]); ctx.lineWidth = 2 * S; ctx.strokeStyle = col; ctx.stroke();
        ctx.restore();
      });
    }

    const r0 = st.pointSize * S * 0.95 * (opt.pointScale || 1);
    drawOrder.forEach((c) => {
      const [x, y] = P(c.lat, c.lon);
      const member = st.membership.has(c.uid);
      const r = opt.mode === 'cluster' ? (member ? r0 * 1.15 : r0 * 0.7) : r0;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.globalAlpha = ctxSet.has(c.uid) ? 0.4 : opt.mode === 'cluster' && !member ? 0.65 : 0.95;
      ctx.fillStyle = colorFor(c, opt.mode); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.3 * S; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    });

    if (opt.stackCounts) {
      const spot = new Map();
      drawOrder.forEach((c) => { const k = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`; spot.set(k, (spot.get(k) || []).concat([c])); });
      spot.forEach((list) => {
        if (list.length < 2) return;
        const [x, y] = P(list[0].lat, list[0].lon);
        const t = String(list.length);
        ctx.font = `bold ${10 * S}px Calibri, Arial, sans-serif`;
        const w = Math.max(15 * S, ctx.measureText(t).width + 8 * S), h = 15 * S, bx = x + r0 * 0.55, by = y - r0 * 0.55 - h;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, w, h, h / 2); else ctx.rect(bx, by, w, h);
        ctx.fillStyle = '#16201d'; ctx.fill(); ctx.lineWidth = 1.5 * S; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(t, bx + w / 2, by + h / 2 + 0.5 * S);
      });
    }

    const halo = (text, x, y, font, color, align) => {
      ctx.font = font; ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 4 * S; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineJoin = 'round';
      ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
    };
    const placed = [];
    if (app.layerOn('lyrLabels')) {
      HUD.blocks.features.forEach((f) => {
        const p = f.properties;
        const [x, y] = P(p.label_lat, p.label_lon);
        const t = (app.LINE_LIST_NAME[p.health_block] || p.health_block).toUpperCase();
        const font = `bold ${12.5 * S}px Calibri, Arial, sans-serif`;
        halo(t, x, y, font, '#1b2320');
        ctx.font = font;
        const w = ctx.measureText(t).width;
        placed.push({ x: x - w / 2 - 3 * S, y: y - 9 * S, w: w + 6 * S, h: 18 * S });
      });
    }

    if (opt.clusterLabels) {
      const hit = (a) => a.x < 2 || a.y < 2 || a.x + a.w > W - 2 || a.y + a.h > H - 2 ||
        placed.some((b2) => a.x < b2.x + b2.w && a.x + a.w > b2.x && a.y < b2.y + b2.h && a.y + a.h > b2.y);
      clusterList.slice().sort((a, z) => z.members.length - a.members.length).forEach((c) => {
        const [x, y] = P(c.lat, c.lon);
        const r = Math.max(120, c.radius + 80) / mpp(c.lat);
        const text = `${c.id} · ${c.members.length}`;
        ctx.font = `bold ${11.5 * S}px Consolas, "Courier New", monospace`;
        const w = ctx.measureText(text).width + 10 * S, h = 18 * S;
        // Try above, right, left, below and the diagonals, then further out; keep the first free spot.
        const g = 4 * S, cands = [];
        for (let ring = 0; ring < 5; ring++) {
          const d = ring * (h + 3 * S);
          cands.push({ x: x - w / 2, y: y - r - h - g - d }, { x: x + r + g + d * 0.6, y: y - h / 2 - d * 0.5 },
            { x: x - r - g - w - d * 0.6, y: y - h / 2 - d * 0.5 }, { x: x - w / 2, y: y + r + g + d },
            { x: x + r * 0.7 + g + d * 0.6, y: y - r * 0.7 - h - d * 0.6 }, { x: x - r * 0.7 - g - w - d * 0.6, y: y - r * 0.7 - h - d * 0.6 });
        }
        const box = cands.map((c2) => ({ ...c2, w, h })).find((bx) => !hit(bx)) || { x: x - w / 2, y: y - r - h - g, w, h };
        placed.push(box);
        const col = c.status === 'Active' ? '#d9480f' : '#6c757d';
        const bx = Math.max(box.x, Math.min(x, box.x + w)), by = Math.max(box.y, Math.min(y, box.y + h));
        if (Math.hypot(bx - x, by - y) > r + 3 * S) {
          const ang = Math.atan2(by - y, bx - x);
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
          ctx.strokeStyle = col; ctx.lineWidth = 1 * S; ctx.stroke();
        }
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(box.x, box.y, w, h, 3 * S); else ctx.rect(box.x, box.y, w, h);
        ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 1.2 * S; ctx.strokeStyle = col; ctx.stroke();
        ctx.fillStyle = c.status === 'Active' ? '#a33a0c' : '#3c4449';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, box.x + w / 2, box.y + h / 2 + 0.5 * S);
      });
    }

    // Scale bar
    const midLat = (b.getSouth() + b.getNorth()) / 2;
    const target = 130 * S * mpp(midLat);
    const nice = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].reduce((a, v) => (v <= target ? v : a), 50);
    const len = nice / mpp(midLat);
    const sx = 18 * S, sy = H - 22 * S;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(sx - 8 * S, sy - 22 * S, len + 26 * S, 32 * S);
    ctx.fillStyle = '#1b2320'; ctx.fillRect(sx, sy, len / 2, 5 * S);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(sx + len / 2, sy, len / 2, 5 * S);
    ctx.strokeStyle = '#1b2320'; ctx.lineWidth = 1 * S; ctx.strokeRect(sx, sy, len, 5 * S);
    ctx.fillStyle = '#1b2320'; ctx.font = `${11 * S}px Calibri, Arial, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('0', sx - 2 * S, sy - 5 * S);
    ctx.textAlign = 'center';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, sx + len, sy - 5 * S);

    // North arrow
    const nx = W - 34 * S, ny = 20 * S;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.arc(nx, ny + 20 * S, 21 * S, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(nx, ny + 4 * S); ctx.lineTo(nx + 8 * S, ny + 30 * S); ctx.lineTo(nx, ny + 24 * S); ctx.closePath();
    ctx.fillStyle = '#1b2320'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(nx, ny + 4 * S); ctx.lineTo(nx - 8 * S, ny + 30 * S); ctx.lineTo(nx, ny + 24 * S); ctx.closePath();
    ctx.fillStyle = '#8b9590'; ctx.fill();
    ctx.fillStyle = '#1b2320'; ctx.font = `bold ${10 * S}px Calibri, Arial, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('N', nx, ny + 40 * S);

    if (base) {
      const t = `© OpenStreetMap contributors${base.label.includes('Humanitarian') ? ' · tiles HOT' : ''}`;
      ctx.font = `${9.5 * S}px Calibri, Arial, sans-serif`;
      const tw = ctx.measureText(t).width;
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(W - tw - 12 * S, H - 16 * S, tw + 12 * S, 16 * S);
      ctx.fillStyle = '#47544f'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(t, W - 6 * S, H - 8 * S);
    }
    ctx.strokeStyle = '#c9d1cd'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, W - 2, H - 2);

    let data;
    try { data = cv.toDataURL(base ? 'image/jpeg' : 'image/png', 0.92); }
    catch (e) { throw new Error('The basemap tiles could not be copied into the report. Choose Basemap: None and try again.'); }
    return { data, tilesOk, tilesTried };
  }

  /* =================================================================
   * Slides
   * ================================================================= */
  function weeklySeries(app) {
    const st = app.state, LL = app.LL;
    const f = st.filtered;
    const wk = (d) => { const w = LL.isoWeek(d); return w.year * 100 + w.week; };
    const days = f.map(app.eday);
    if (!days.length) return { labels: [], series: [] };
    const start = days.reduce((m, v) => (v < m ? v : m), Infinity), end = days.reduce((m, v) => (v > m ? v : m), -Infinity);
    const monday = (x) => x - ((new Date(x * 86400000).getUTCDay() + 6) % 7);
    const weeks = [];
    for (let d = monday(start); d <= end; d += 7) weeks.push({ key: wk(d), monday: d });
    const counts = new Map();
    f.forEach((c, i) => { const k = `${c.disease}|${monday(days[i])}`; counts.set(k, (counts.get(k) || 0) + 1); });
    const series = ['Dengue', 'IP Fever'].filter((d) => st.f.disease.has(d)).map((dis) => ({
      name: dis, labels: weeks.map((w) => `W${w.key % 100}`),
      values: weeks.map((w) => counts.get(`${dis}|${w.monday}`) || 0)
    }));
    return { weeks, series };
  }

  // Official logos for the slides, read from the app's own assets (skipped if unavailable).
  const LOGO_FILES = [['assets/logos/tn-govt-emblem.png', 145 / 160], ['assets/logos/dph-tn.png', 1], ['assets/logos/nhm-tn.png', 215 / 160]];
  async function loadLogos() {
    const out = [];
    for (const [src, ratio] of LOGO_FILES) {
      try {
        const res = await fetch(src);
        if (!res.ok) continue;
        const blob = await res.blob();
        const data = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
        out.push({ data, ratio });
      } catch (e) { /* opened from disk: no logos */ }
    }
    return out;
  }
  const CREDIT = 'Designed by Dr. M. Sivachandran Mathiyazagan, MBBS, MPH (ICMR-NIE)';

  async function build(o) {
    const app = A(), st = app.state;
    const logos = await loadLogos();
    // Places the logos in a row ending at x = right; returns the row's left edge.
    const placeLogos = (s, right, y, h, gap) => {
      let x = right;
      logos.slice().reverse().forEach((l) => { const w = h * l.ratio; x -= w; s.addImage({ data: l.data, x, y, w, h }); x -= gap; });
      return x + gap;
    };
    const pptx = new window.PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Attur HUD';
    pptx.company = 'Attur Health Unit District';
    pptx.title = o.title;

    const f = st.f;
    const ref = app.refDay();
    const today = new Date();
    const prepared = `${String(today.getDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][today.getMonth()]} ${today.getFullYear()}`;
    const period = `${app.fmtDay(f.from)} – ${app.fmtDay(f.to)}`;
    const sources = st.files.map((x) => x.name).join(', ');
    const mapped = st.filtered.filter((c) => c.lat !== null);
    const byDis = app.countBy(st.filtered, 'disease');
    const active = st.clusters.filter((c) => c.status === 'Active');
    const inCl = st.filtered.filter((c) => st.membership.has(c.uid)).length;
    const win = window.Analysis.windowText(st.cl.days), activeDays = window.Analysis.activeWindow(st.cl.days);
    const clusterMethod = `ST-DBSCAN · ${st.cl.eps} m · ${win} · at least ${st.cl.minPts} cases · ${st.cl.pooled ? 'Dengue and IP Fever together' : 'each disease separately'}`;
    const filterText = app.filterSummaryRows()
      .filter((r) => ['Disease', 'Lab result / condition', 'Block', 'PHC', 'Area type', 'Sex', 'Age group'].includes(r.Setting) && r.Value !== 'All' && !/\(default\)$/.test(r.Value))
      .map((r) => `${r.Setting}: ${r.Value}`).join(' · ') || 'All cases (no filters)';
    const bounds = o.extent === 'view' ? app.map.getBounds() : app.areaBounds().pad(0.02);
    const area = app.areaLabel();
    const areaTag = st.focus ? ` · ${area}` : '';

    let page = 0;
    const footer = (s) => {
      s.addShape(pptx.ShapeType.line, { x: 0.45, y: 7.02, w: SLIDE_W - 0.9, h: 0, line: { color: C.line, width: 0.75 } });
      s.addText(`EpiTrack Attur  ·  ${o.title}  ·  Source: ${sources}  ·  Prepared ${prepared}`, { x: 0.45, y: 7.08, w: 11.4, h: 0.26, fontFace: FONT, fontSize: 9, color: C.ink3, margin: 0, fit: 'shrink' });
      s.addText(String(page), { x: 12.28, y: 7.08, w: 0.6, h: 0.26, fontFace: FONT, fontSize: 9, color: C.ink3, align: 'right', margin: 0 });
    };
    const newSlide = (title, subtitle) => {
      const s = pptx.addSlide();
      page++;
      s.background = { color: 'FFFFFF' };
      s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: SLIDE_W, h: 0.1, fill: { color: C.accent }, line: { color: C.accent, width: 0 } });
      const logoLeft = logos.length ? placeLogos(s, SLIDE_W - 0.45, 0.28, 0.5, 0.12) : SLIDE_W - 0.45;
      const tw = logoLeft - 0.45 - 0.25;
      s.addText(title, { x: 0.45, y: 0.26, w: tw, h: 0.52, fontFace: FONT, fontSize: 24, bold: true, color: C.ink, margin: 0, valign: 'middle', fit: 'shrink' });
      if (subtitle) s.addText(subtitle, { x: 0.45, y: 0.78, w: SLIDE_W - 0.9, h: 0.32, fontFace: FONT, fontSize: 12.5, color: C.ink2, margin: 0, valign: 'middle' });
      footer(s);
      return s;
    };

    /* ---------- legend panel helpers ---------- */
    const panel = (s) => {
      s.addShape(pptx.ShapeType.rect, { x: PANEL.x, y: PANEL.y, w: PANEL.w, h: PANEL.h, fill: { color: C.panel }, line: { color: C.line, width: 0.75 } });
      let y = PANEL.y + 0.16;
      const x = PANEL.x + 0.2, w = PANEL.w - 0.4;
      return {
        head(t) { s.addText(t.toUpperCase(), { x, y, w, h: 0.24, fontFace: FONT, fontSize: 10, bold: true, color: C.ink3, charSpacing: 1, margin: 0 }); y += 0.3; },
        dot(color, label, n) {
          s.addShape(pptx.ShapeType.ellipse, { x, y: y + 0.04, w: 0.17, h: 0.17, fill: { color: hex(color) }, line: { color: 'FFFFFF', width: 1 } });
          s.addText(label, { x: x + 0.28, y, w: w - 0.9, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink, margin: 0, valign: 'middle' });
          if (n !== undefined) s.addText(String(n), { x: x + w - 0.6, y, w: 0.6, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink2, align: 'right', margin: 0, valign: 'middle' });
          y += 0.29;
        },
        ring(color, label, n) {
          s.addShape(pptx.ShapeType.ellipse, { x: x - 0.02, y: y + 0.02, w: 0.21, h: 0.21, fill: { color: hex(color), transparency: 85 }, line: { color: hex(color), width: 1.5, dashType: 'dash' } });
          s.addText(label, { x: x + 0.28, y, w: w - 0.9, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink, margin: 0, valign: 'middle' });
          if (n !== undefined) s.addText(String(n), { x: x + w - 0.6, y, w: 0.6, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink2, align: 'right', margin: 0, valign: 'middle' });
          y += 0.29;
        },
        line(color, width, label) {
          s.addShape(pptx.ShapeType.line, { x, y: y + 0.125, w: 0.2, h: 0, line: { color: hex(color), width } });
          s.addText(label, { x: x + 0.28, y, w: w - 0.3, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink, margin: 0, valign: 'middle' });
          y += 0.29;
        },
        swatchBar(label) {
          s.addShape(pptx.ShapeType.rect, { x, y: y + 0.06, w: 0.2, h: 0.13, fill: { color: 'F03B20' }, line: { color: 'F03B20', width: 0 } });
          s.addText(label, { x: x + 0.28, y, w: w - 0.3, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink, margin: 0, valign: 'middle' });
          y += 0.29;
        },
        kv(label, value, color) {
          s.addText(label, { x, y, w: w - 0.8, h: 0.25, fontFace: FONT, fontSize: 11.5, color: C.ink2, margin: 0, valign: 'middle' });
          s.addText(String(value), { x: x + w - 1.0, y, w: 1.0, h: 0.25, fontFace: FONT, fontSize: 12, bold: true, color: color || C.ink, align: 'right', margin: 0, valign: 'middle' });
          y += 0.27;
        },
        gap(h = 0.1) {
          y += h;
          s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color: C.line, width: 0.75 } });
          y += 0.12;
        },
        note(t) { s.addText(t, { x, y, w, h: PANEL.y + PANEL.h - y - 0.1, fontFace: FONT, fontSize: 9.5, color: C.ink3, margin: 0, valign: 'bottom', fit: 'shrink' }); },
        get y() { return y; }
      };
    };
    const boundaryLegend = (L) => {
      if (st.focus && st.focus.feature) L.line('#0e6e5f', 3, `${area} (selected area)`);
      if (app.layerOn('lyrHud')) L.line('#b3202a', 2.5, 'HUD boundary');
      if (app.layerOn('lyrBlocks')) L.line('#1b1b1b', 1.25, 'Block boundary');
      if (app.layerOn('lyrVillages')) L.line('#6e6e6e', 0.75, 'Village boundary');
    };
    const kpiLegend = (L) => {
      L.kv('Cases shown', app.fmtN(st.filtered.length));
      L.kv('Dengue', app.fmtN(byDis.get('Dengue') || 0), C.dengue);
      L.kv('IP Fever', app.fmtN(byDis.get('IP Fever') || 0), C.fever);
      L.kv('Last 7 days', app.fmtN(st.filtered.filter((c) => app.eday(c) > ref - 7).length));
      L.kv('Active hotspots', `${active.length} of ${st.clusters.length}`, C.active);
    };

    /* ---------- 1. Cover ---------- */
    if (o.cover) {
      const s = pptx.addSlide();
      page++;
      s.background = { color: 'FFFFFF' };
      s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.28, h: 7.5, fill: { color: C.accent }, line: { color: C.accent, width: 0 } });
      if (logos.length) placeLogos(s, 12.9, 0.5, 0.85, 0.2);
      s.addText('EPITRACK ATTUR', { x: 0.85, y: 0.62, w: 7.5, h: 0.32, fontFace: FONT, fontSize: 13, bold: true, color: C.accent, charSpacing: 3, margin: 0 });
      s.addText(st.focus ? `Attur Health Unit District, Salem · ${area}` : 'Attur Health Unit District, Salem', { x: 0.85, y: 0.94, w: 7.5, h: 0.3, fontFace: FONT, fontSize: 12.5, color: C.ink2, margin: 0 });
      s.addText(o.title, { x: 0.85, y: 1.3, w: 11.8, h: 1.2, fontFace: FONT, fontSize: 38, bold: true, color: C.ink, margin: 0, valign: 'bottom', fit: 'shrink' });
      s.addText(o.subtitle, { x: 0.85, y: 2.6, w: 11.8, h: 0.45, fontFace: FONT, fontSize: 18, color: C.ink2, margin: 0, valign: 'top' });
      const tiles = [
        ['Cases shown', app.fmtN(st.filtered.length), C.ink],
        ['Dengue', app.fmtN(byDis.get('Dengue') || 0), C.dengue],
        ['IP Fever', app.fmtN(byDis.get('IP Fever') || 0), C.fever],
        ['Last 7 days', app.fmtN(st.filtered.filter((c) => app.eday(c) > ref - 7).length), C.ink],
        ['Active hotspots', String(active.length), C.active]
      ];
      const tw = 2.22, tg = 0.18;
      tiles.forEach(([label, value, color], i) => {
        const x = 0.85 + i * (tw + tg);
        s.addShape(pptx.ShapeType.rect, { x, y: 3.55, w: tw, h: 1.45, fill: { color: C.panel }, line: { color: C.line, width: 0.75 } });
        s.addShape(pptx.ShapeType.rect, { x, y: 3.55, w: 0.07, h: 1.45, fill: { color }, line: { color, width: 0 } });
        s.addText(label, { x: x + 0.25, y: 3.7, w: tw - 0.35, h: 0.3, fontFace: FONT, fontSize: 13, color: C.ink2, margin: 0 });
        s.addText(value, { x: x + 0.25, y: 4.05, w: tw - 0.35, h: 0.75, fontFace: FONT, fontSize: 40, bold: true, color, margin: 0, valign: 'middle' });
      });
      s.addText([
        { text: 'Filters: ', options: { bold: true, color: C.ink2 } }, { text: filterText, options: { color: C.ink2, breakLine: true } },
        { text: 'Clusters: ', options: { bold: true, color: C.ink2 } }, { text: clusterMethod, options: { color: C.ink2, breakLine: true } },
        { text: `IP Fever dated by ${app.BASIS_LABEL[f.basis].toLowerCase()}. Last 7 days = ${app.fmtShort(ref - 6)} – ${app.fmtShort(ref)}.`, options: { color: C.ink3 } }
      ], { x: 0.85, y: 5.35, w: 11.8, h: 1.0, fontFace: FONT, fontSize: 12, margin: 0, valign: 'top', paraSpaceAfter: 3 });
      s.addText(`Source: ${sources}  ·  Prepared ${prepared}`, { x: 0.85, y: 6.62, w: 11.8, h: 0.28, fontFace: FONT, fontSize: 10, color: C.ink3, margin: 0 });
      s.addShape(pptx.ShapeType.line, { x: 0.85, y: 6.98, w: 12.05, h: 0, line: { color: C.line, width: 0.75 } });
      s.addText(CREDIT, { x: 0.85, y: 7.04, w: 12.05, h: 0.28, fontFace: FONT, fontSize: 10.5, color: C.ink2, margin: 0 });
    }

    /* ---------- 2. Case map ---------- */
    const imgPx = { width: 1790, height: Math.round((1790 * MAP_BOX.h) / MAP_BOX.w) };
    let tileNote = '';
    if (o.caseMap) {
      const mode = st.colorBy;
      const img = await renderMap({ bounds, ...imgPx, mode, clusters: app.layerOn('lyrClusters'), clusterLabels: false, heat: true });
      if (img.tilesTried && img.tilesOk < img.tilesTried) tileNote = ` (${img.tilesTried - img.tilesOk} basemap tiles could not be loaded)`;
      const modeLabel = { disease: 'by disease', recency: 'by recency', cluster: 'by cluster' }[mode];
      const s = newSlide(`Distribution of Dengue and IP Fever cases${st.focus ? ` – ${area}` : ''}, ${modeLabel}`, `${period} · ${app.fmtN(mapped.length)} cases mapped · ${o.extent === 'view' ? 'map view as on screen' : st.focus ? area : 'whole HUD'}`);
      s.addImage({ data: img.data, x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h });
      const L = panel(s);
      L.head('Legend');
      if (mode === 'disease') {
        const by = app.countBy(mapped, 'disease');
        ['Dengue', 'IP Fever'].filter((d) => by.has(d)).forEach((d) => L.dot(app.DISEASE_COLOR[d], d, by.get(d)));
      } else if (mode === 'recency') {
        const by = app.countBy(mapped, (c) => app.RECENCY.findIndex((r) => ref - app.eday(c) < r.max));
        app.RECENCY.forEach((r, i) => L.dot(r.color, r.label, by.get(i) || 0));
      } else {
        const n = mapped.filter((c) => st.membership.has(c.uid)).length;
        L.dot('#7048e8', 'Case in a hotspot', n);
        L.dot('#9aa3a9', 'Case not in a hotspot', mapped.length - n);
      }
      if (app.layerOn('lyrClusters') && st.clusters.length) {
        L.ring('#d9480f', 'Active hotspot', active.length);
        L.ring('#6c757d', 'Hotspot now over', st.clusters.length - active.length);
      }
      if (app.layerOn('lyrHeat')) L.swatchBar('Case density (heatmap)');
      boundaryLegend(L);
      L.gap();
      L.head('Key figures');
      kpiLegend(L);
      L.gap(0.02);
      L.note(`${mode === 'recency' ? `Recency counted back from ${app.fmtDay(ref)}. ` : ''}Each point is one case at its recorded latitude/longitude.${st.contextCases.length ? ` Faded points lie outside ${area} but belong to its clusters.` : ''} ${filterText}.${tileNote}`);
    }

    /* ---------- 3. Cluster map ---------- */
    if (o.clusterMap) {
      const img = await renderMap({ bounds, ...imgPx, mode: 'cluster', clusters: true, clusterLabels: true, heat: false });
      const s = newSlide(`Hotspots – groups of cases close in place and time${st.focus ? ` – ${area}` : ''}`, `${period}${areaTag} · ${st.clusters.length} clusters, ${active.length} active · ${inCl} of ${mapped.length} mapped cases (${mapped.length ? Math.round((inCl / mapped.length) * 100) : 0}%) in clusters`);
      s.addImage({ data: img.data, x: MAP_BOX.x, y: MAP_BOX.y, w: MAP_BOX.w, h: MAP_BOX.h });
      const L = panel(s);
      L.head('Legend');
      L.ring('#d9480f', `Active (case in last ${activeDays} days)`, active.length);
      L.ring('#6c757d', 'Over', st.clusters.length - active.length);
      L.dot('#7048e8', 'Case in a hotspot', inCl);
      L.dot('#9aa3a9', 'Case not in a hotspot', mapped.length - inCl);
      boundaryLegend(L);
      L.gap();
      L.head('Largest active hotspots');
      active.slice().sort((a, z) => z.members.length - a.members.length).slice(0, 6)
        .forEach((c) => L.kv(`${c.id}  ${c.places[0] ? c.places[0][0] : ''}`, c.members.length, C.active));
      if (!active.length) L.kv('None', '');
      L.gap(0.02);
      L.note(`${st.focus ? `Clusters are found on the whole HUD; those touching ${area} are shown in full. ` : ''}Each cluster's cases share one colour. Labels show cluster ID · number of cases. Method: ${clusterMethod}. Two cases are neighbours when they are within ${st.cl.eps} m of each other${st.cl.days > 60 ? ', at any time' : ` and within ${st.cl.days} days`}.`);
    }

    /* ---------- 4. Cluster list ---------- */
    if (o.clusterList) {
      const list = st.clusters.slice().sort((a, z) => (a.status === z.status ? 0 : a.status === 'Active' ? -1 : 1) || z.last - a.last || z.members.length - a.members.length);
      const per = 11;
      const pages = Math.max(1, Math.ceil(list.length / per));
      const head = ['Hotspot', 'Disease', 'Status', 'Cases', 'Last 7 d', 'First case', 'Last case', 'Days', 'Radius', 'Places (cases)', 'Block'];
      const hdrCell = (t, align) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: C.accent }, align: align || 'left', fontSize: 11 } });
      for (let p = 0; p < pages; p++) {
        const chunk = list.slice(p * per, (p + 1) * per);
        const s = newSlide(`Hotspot list${st.focus ? ` – ${area}` : ''}${pages > 1 ? ` (${p + 1} of ${pages})` : ''}`, `Active hotspots first, then most recent · ${clusterMethod}`);
        if (!chunk.length) {
          s.addText('No hotspots were found with the current filters and rule.', { x: 0.45, y: 2.5, w: 12.4, h: 0.6, fontFace: FONT, fontSize: 16, color: C.ink2, align: 'center' });
          continue;
        }
        const rows = [head.map((h, i) => hdrCell(h, i >= 3 && i <= 8 && i !== 5 && i !== 6 ? 'right' : 'left'))];
        chunk.forEach((c, i) => {
          const fill = { color: i % 2 ? 'FFFFFF' : 'F7F9F8' };
          const cell = (text, opt = {}) => ({ text: String(text), options: { fill, ...opt } });
          const dis = c.key === 'All' ? c.diseases.map(([d, n]) => `${d} ${n}`).join(', ') : c.key;
          rows.push([
            cell(c.id, { bold: true, color: c.key === 'Dengue' ? C.dengue : c.key === 'IP Fever' ? C.fever : C.accent, fontFace: 'Consolas' }),
            cell(dis),
            cell((c.status === 'Active' ? 'Active' : 'Over') + (c.isNew ? ' · new' : ''), { bold: c.status === 'Active', color: c.status === 'Active' ? C.active : C.closed }),
            cell(c.members.length, { align: 'right', bold: true }),
            cell(c.recent7 || '–', { align: 'right' }),
            cell(app.fmtDay(c.first)),
            cell(app.fmtDay(c.last)),
            cell(c.spanDays, { align: 'right' }),
            cell(`${Math.max(50, Math.round(c.radius / 10) * 10)} m`, { align: 'right' }),
            cell(c.places.map(([pl, n]) => `${pl} (${n})`).join(', ')),
            cell(c.blocks.map(([b]) => b).join(', '))
          ]);
        });
        s.addTable(rows, {
          x: 0.45, y: 1.3, w: 12.43, colW: [0.9, 0.9, 0.95, 0.6, 0.7, 1.12, 1.12, 0.55, 0.78, 3.31, 1.5],
          fontFace: FONT, fontSize: 11, color: C.ink, valign: 'middle', rowH: 0.42,
          border: { type: 'solid', pt: 0.5, color: C.line }, autoPage: false, margin: [2, 5, 2, 5]
        });
      }
    }

    /* ---------- 5. Weekly trend and blocks ---------- */
    if (o.summary) {
      const s = newSlide(`Weekly trend and block-wise distribution${st.focus ? ` – ${area}` : ''}`, `${period} · IP Fever by ${app.BASIS_LABEL[f.basis].toLowerCase()}, Dengue by date of diagnosis · ISO weeks (Mon–Sun)`);
      const ws = weeklySeries(app);
      if (ws.series.length && ws.series[0].labels.length) {
        s.addChart(pptx.ChartType.bar, ws.series, {
          x: 0.45, y: 1.3, w: 7.35, h: 5.55, barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 45,
          chartColors: ws.series.map((x) => hex(app.DISEASE_COLOR[x.name])),
          showLegend: true, legendPos: 't', legendFontFace: FONT, legendFontSize: 11,
          showTitle: true, title: 'Cases by week', titleFontFace: FONT, titleFontSize: 13, titleColor: C.ink,
          catAxisLabelFontFace: FONT, catAxisLabelFontSize: 9, catAxisLabelColor: C.ink2, catAxisLabelRotate: ws.series[0].labels.length > 20 ? -45 : 0,
          valAxisLabelFontFace: FONT, valAxisLabelFontSize: 10, valAxisLabelColor: C.ink2, valAxisLabelFormatCode: '0',
          valGridLine: { color: 'E3E8E5', style: 'solid', size: 0.75 }, catGridLine: { style: 'none' },
          showValue: false
        });
      }
      const blocks = [...new Set(st.filtered.map((c) => c.block))].sort((a, b) => {
        const ia = app.BLOCK_ORDER.indexOf(a), ib = app.BLOCK_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      const actByBlock = app.countBy(active, (c) => c.blocks[0][0]);
      const hdr = (t, r) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: C.accent }, align: r ? 'right' : 'left', fontSize: 10 } });
      const rows = [[hdr('Block'), hdr('Dengue', 1), hdr('IP Fever', 1), hdr('Total', 1), hdr('7 days', 1), hdr('Active', 1)]];
      const tot = { d: 0, f: 0, t: 0, l: 0 };
      blocks.forEach((b, i) => {
        const l = st.filtered.filter((c) => c.block === b);
        const d = l.filter((c) => c.disease === 'Dengue').length, fv = l.length - d, l7 = l.filter((c) => app.eday(c) > ref - 7).length;
        tot.d += d; tot.f += fv; tot.t += l.length; tot.l += l7;
        const fill = { color: i % 2 ? 'FFFFFF' : 'F7F9F8' };
        rows.push([
          { text: b, options: { fill } },
          { text: String(d || ''), options: { fill, align: 'right', color: C.dengue } },
          { text: String(fv || ''), options: { fill, align: 'right', color: C.fever } },
          { text: String(l.length), options: { fill, align: 'right', bold: true } },
          { text: String(l7 || ''), options: { fill, align: 'right' } },
          { text: String(actByBlock.get(b) || ''), options: { fill, align: 'right', bold: true, color: C.active } }
        ]);
      });
      const tf = { fill: { color: C.accentSoft }, bold: true };
      rows.push([{ text: 'Total', options: tf }, { text: String(tot.d), options: { ...tf, align: 'right' } }, { text: String(tot.f), options: { ...tf, align: 'right' } },
        { text: String(tot.t), options: { ...tf, align: 'right' } }, { text: String(tot.l), options: { ...tf, align: 'right' } }, { text: String(active.length), options: { ...tf, align: 'right' } }]);
      s.addTable(rows, {
        x: 8.0, y: 1.3, w: 4.88, colW: [1.74, 0.72, 0.68, 0.56, 0.6, 0.58],
        fontFace: FONT, fontSize: Math.min(11, 11 * 13 / Math.max(13, rows.length)), color: C.ink, valign: 'middle',
        rowH: Math.min(0.4, 5.5 / rows.length), border: { type: 'solid', pt: 0.5, color: C.line }, margin: [2, 4, 2, 4], autoPage: false
      });
    }

    /* ---------- 5b. Block dashboards: one slide per block ---------- */
    if (o.blocks) {
      const HUD = app.HUD, LL = app.LL;
      const MPTY = { 'Attur Mpty': 'Attur (M)', 'Narasingapuram Mpty': 'Narasingapuram (M)' };
      const blockFeature = (b) => (MPTY[b]
        ? HUD.villages.features.find((v) => v.properties.village_name === MPTY[b])
        : HUD.blocks.features.find((v) => v.properties.health_block === LL.HEALTH_BLOCK[b]));
      const blockLabel = (b) => (MPTY[b] ? b.replace(/ Mpty$/, ' Municipality') : `${b} block`);
      const totals = app.countBy(st.filtered, 'block');
      const names = [...totals.keys()].filter((b) => b !== 'Not stated')
        .sort((a, b) => { const ia = app.BLOCK_ORDER.indexOf(a), ib = app.BLOCK_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
      const ranked = [...totals.entries()].filter(([b]) => b !== 'Not stated').sort((a, b) => b[1] - a[1]).map(([b]) => b);
      const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
      const allCl = st.allClusters || st.clusters;
      const monday = (x) => x - ((new Date(x * 86400000).getUTCDay() + 6) % 7);
      const lastMonday = monday(ref);
      const weekKeys = Array.from({ length: 12 }, (_, i) => lastMonday - (11 - i) * 7);
      const hudTotal = st.filtered.length;

      for (let bi = 0; bi < names.length; bi++) {
        const b = names[bi];
        if (o.onProgress) o.onProgress(`block ${bi + 1} of ${names.length}`);
        const cases = st.filtered.filter((c) => c.block === b);
        const inBlock = new Set(cases.map((c) => c.uid));
        const cls = allCl.filter((c) => c.members.some((m) => m.block === b && inBlock.has(m.uid)));
        const ctx = [];
        cls.forEach((c) => c.members.forEach((m) => { if (!inBlock.has(m.uid)) ctx.push(m); }));
        const feat = blockFeature(b);
        const dis = app.countBy(cases, 'disease');
        const thisWk = cases.filter((c) => app.eday(c) > ref - 7).length;
        const prevWk = cases.filter((c) => { const d = app.eday(c); return d > ref - 14 && d <= ref - 7; }).length;
        const act = cls.filter((c) => c.status === 'Active');
        const rank = ranked.indexOf(b) + 1;
        const hb = LL.HEALTH_BLOCK[b];

        const s = newSlide(`Block dashboard – ${blockLabel(b)}`,
          `${period}${hb && hb !== b && !MPTY[b] ? ` · ${hb} health block` : ''} · ${ordinal(rank)} highest of ${ranked.length} blocks by cases`);

        // 1. Six key figures
        const diff = thisWk - prevWk;
        const tiles = [
          ['Total cases', app.fmtN(cases.length), C.ink, ''],
          ['Dengue', app.fmtN(dis.get('Dengue') || 0), C.dengue, ''],
          ['IP Fever', app.fmtN(dis.get('IP Fever') || 0), C.fever, ''],
          ['This week', app.fmtN(thisWk), C.ink, prevWk || thisWk ? `${diff > 0 ? '▲' : diff < 0 ? '▼' : '='} ${diff > 0 ? '+' : ''}${diff} vs last week (${prevWk})` : 'none in last 2 weeks'],
          ['Active hotspots', String(act.length), C.active, cls.length ? `${cls.length} in period` : 'none'],
          ['Share of HUD cases', `${hudTotal ? Math.round((cases.length / hudTotal) * 100) : 0}%`, C.accent, `${app.fmtN(cases.length)} of ${app.fmtN(hudTotal)}`]
        ];
        const tw = (SLIDE_W - 0.9 - 5 * 0.14) / 6;
        tiles.forEach(([label, value, color, note], i) => {
          const x = 0.45 + i * (tw + 0.14);
          s.addShape(pptx.ShapeType.rect, { x, y: 1.25, w: tw, h: 1.02, fill: { color: C.panel }, line: { color: C.line, width: 0.75 } });
          s.addShape(pptx.ShapeType.rect, { x, y: 1.25, w: 0.06, h: 1.02, fill: { color }, line: { color, width: 0 } });
          s.addText(label, { x: x + 0.17, y: 1.3, w: tw - 0.22, h: 0.26, fontFace: FONT, fontSize: 11, color: C.ink2, margin: 0 });
          s.addText(value, { x: x + 0.17, y: 1.55, w: tw - 0.22, h: 0.46, fontFace: FONT, fontSize: 26, bold: true, color, margin: 0, valign: 'middle' });
          if (note) {
            const noteColor = label === 'This week' ? (diff > 0 ? C.dengue : diff < 0 ? '2F9E44' : C.ink3) : C.ink3;
            s.addText(note, { x: x + 0.17, y: 2.0, w: tw - 0.22, h: 0.22, fontFace: FONT, fontSize: 9.5, color: noteColor, margin: 0, fit: 'shrink' });
          }
        });

        // 2. Block map
        const MAP = { x: 0.45, y: 2.45, w: 5.75, h: 4.45 };
        let bb = feat ? L.geoJSON(feat).getBounds() : null;
        const pts = cases.concat(ctx).filter((c) => c.lat !== null).map((c) => [c.lat, c.lon]);
        if (pts.length) bb = bb ? bb.extend(L.latLngBounds(pts)) : L.latLngBounds(pts);
        if (bb) {
          const img = await renderMap({
            bounds: bb.pad(0.06), width: 1300, height: Math.round((1300 * MAP.h) / MAP.w), mode: 'disease',
            clusters: true, clusterLabels: true, heat: false, pointScale: 1.3, stackCounts: true,
            subject: feat ? feat.geometry : null, cases, contextCases: ctx, clusterList: cls
          });
          s.addImage({ data: img.data, x: MAP.x, y: MAP.y, w: MAP.w, h: MAP.h });
        }
        const byD = app.countBy(cases.filter((c) => c.lat !== null), 'disease');
        const legend = [
          { text: '● ', options: { color: C.dengue } }, { text: `Dengue ${byD.get('Dengue') || 0}    `, options: { color: C.ink2 } },
          { text: '● ', options: { color: C.fever } }, { text: `IP Fever ${byD.get('IP Fever') || 0}    `, options: { color: C.ink2 } },
          { text: '◌ ', options: { color: C.active, bold: true } }, { text: 'Active hotspot    ', options: { color: C.ink2 } },
          { text: '◌ ', options: { color: C.closed, bold: true } }, { text: 'Over', options: { color: C.ink2 } }
        ];
        s.addText(legend, { x: MAP.x + 0.1, y: MAP.y + 0.08, w: 4.6, h: 0.28, fontFace: FONT, fontSize: 10, margin: [2, 6, 2, 6], fill: { color: 'FFFFFF', transparency: 8 } });

        // 3. Weekly trend (last 12 weeks)
        const RX = 6.4, RW = SLIDE_W - 0.45 - RX;
        const wkCount = new Map();
        cases.forEach((c) => { const k = `${c.disease}|${monday(app.eday(c))}`; wkCount.set(k, (wkCount.get(k) || 0) + 1); });
        const series = ['Dengue', 'IP Fever'].filter((d) => st.f.disease.has(d)).map((d) => ({
          name: d, labels: weekKeys.map((m) => `W${LL.isoWeek(m).week}`), values: weekKeys.map((m) => wkCount.get(`${d}|${m}`) || 0)
        }));
        const peak = weekKeys.reduce((m, k) => Math.max(m, series.reduce((t, x) => t + (wkCount.get(`${x.name}|${k}`) || 0), 0)), 0);
        s.addText('Cases in the last 12 weeks', { x: RX, y: 2.42, w: RW, h: 0.28, fontFace: FONT, fontSize: 12, bold: true, color: C.ink, margin: 0 });
        if (series.length) {
          s.addChart(pptx.ChartType.bar, series, {
            x: RX - 0.05, y: 2.68, w: RW + 0.05, h: 1.95, barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 40,
            chartColors: series.map((x) => hex(app.DISEASE_COLOR[x.name])), showLegend: true, legendPos: 'r', legendFontSize: 9, legendFontFace: FONT,
            catAxisLabelFontSize: 8.5, catAxisLabelFontFace: FONT, catAxisLabelColor: C.ink2,
            valAxisLabelFontSize: 8.5, valAxisLabelFontFace: FONT, valAxisLabelColor: C.ink2, valAxisLabelFormatCode: '0',
            ...(peak <= 8 ? { valAxisMajorUnit: 1, valAxisMaxVal: Math.max(2, peak + 1), valAxisMinVal: 0 } : {}),
            valGridLine: { color: 'E3E8E5', style: 'solid', size: 0.5 }, catGridLine: { style: 'none' }, showValue: false
          });
        }

        // 4. Two tables: PHCs, and hotspots touching the block
        const TY = 4.78, PW = 2.7, HW = RW - PW - 0.2;
        const hdr = (t, r) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: C.accent }, align: r ? 'right' : 'left', fontSize: 10 } });
        const zebra = (i) => ({ color: i % 2 ? 'FFFFFF' : 'F7F9F8' });
        const phc = new Map();
        cases.forEach((c) => {
          if (!phc.has(c.phc)) phc.set(c.phc, { n: 0, wk: 0 });
          const r = phc.get(c.phc); r.n++; if (app.eday(c) > ref - 7) r.wk++;
        });
        const phcRows = [...phc.entries()].sort((a, z) => z[1].n - a[1].n).slice(0, 6);
        s.addText('PHCs', { x: RX, y: TY - 0.02, w: PW, h: 0.26, fontFace: FONT, fontSize: 12, bold: true, color: C.ink, margin: 0 });
        s.addTable([[hdr('PHC'), hdr('Cases', 1), hdr('This week', 1)]].concat(phcRows.map(([name, r], i) => [
          { text: name, options: { fill: zebra(i) } },
          { text: String(r.n), options: { fill: zebra(i), align: 'right', bold: true } },
          { text: r.wk ? String(r.wk) : '–', options: { fill: zebra(i), align: 'right', color: r.wk ? C.dengue : C.ink3 } }
        ])), { x: RX, y: TY + 0.28, w: PW, colW: [PW - 1.3, 0.55, 0.75], fontFace: FONT, fontSize: 10, color: C.ink, rowH: 0.26, border: { type: 'solid', pt: 0.5, color: C.line }, margin: [1, 4, 1, 4], autoPage: false });

        const HX = RX + PW + 0.2;
        const hot = cls.slice().sort((a, z) => (a.status === z.status ? 0 : a.status === 'Active' ? -1 : 1) || z.last - a.last).slice(0, 6);
        s.addText('Hotspots in this block', { x: HX, y: TY - 0.02, w: HW, h: 0.26, fontFace: FONT, fontSize: 12, bold: true, color: C.ink, margin: 0 });
        if (hot.length) {
          s.addTable([[hdr('ID'), hdr('Place'), hdr('Cases', 1), hdr('Status')]].concat(hot.map((c, i) => [
            { text: c.id, options: { fill: zebra(i), bold: true, fontFace: 'Consolas', color: c.key === 'Dengue' ? C.dengue : c.key === 'IP Fever' ? C.fever : C.accent } },
            { text: c.places[0] ? c.places[0][0] : '', options: { fill: zebra(i) } },
            { text: String(c.members.length), options: { fill: zebra(i), align: 'right', bold: true } },
            { text: c.status === 'Active' ? `Active${c.recent7 ? ` (${c.recent7} wk)` : ''}` : 'Over', options: { fill: zebra(i), color: c.status === 'Active' ? C.active : C.closed, bold: c.status === 'Active' } }
          ])), { x: HX, y: TY + 0.28, w: HW, colW: [0.66, HW - 0.66 - 0.5 - 0.98, 0.5, 0.98], fontFace: FONT, fontSize: 10, color: C.ink, rowH: 0.26, border: { type: 'solid', pt: 0.5, color: C.line }, margin: [1, 4, 1, 4], autoPage: false });
          if (cls.length > hot.length) s.addText(`+ ${cls.length - hot.length} more in the hotspot list`, { x: HX, y: TY + 0.28 + 0.26 * (hot.length + 1) + 0.04, w: HW, h: 0.22, fontFace: FONT, fontSize: 9, color: C.ink3, margin: 0 });
        } else {
          s.addText('No hotspots in this block for the period.', { x: HX, y: TY + 0.32, w: HW, h: 0.5, fontFace: FONT, fontSize: 11, color: C.ink3, margin: 0 });
        }
      }
    }

    /* ---------- 6. Methods and data quality ---------- */
    if (o.methods) {
      const s = newSlide('Methods and data quality', 'How the map and clusters were produced, and what to check in the line list');
      const d = st.data;
      const total = d.cases.length;
      const notShown = total - st.filtered.length;
      const para = (t, bold) => ({ text: t, options: { bold: !!bold, breakLine: true, color: bold ? C.ink : C.ink2, fontSize: bold ? 14 : 12, paraSpaceBefore: bold ? 8 : 2 } });
      const bullet = (t) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: true, color: C.ink2, fontSize: 12, paraSpaceBefore: 3 } });
      s.addText([
        para('Data', true),
        bullet(`Source: ${sources}`),
        ...d.sheets.map((x) => bullet(`${x.sheet} sheet → ${x.disease}: ${x.rows} rows${x.datesCorrected ? `; ${x.datesCorrected} dates stored month-first by Excel were corrected` : ''}`)),
        bullet(`${app.fmtN(st.filtered.length)} of ${app.fmtN(total)} records shown after filters${notShown ? ` (${notShown} left out by the period, filters, outside-HUD or duplicate rules)` : ''}.`),
        bullet(`IP Fever dated by ${app.BASIS_LABEL[f.basis].toLowerCase()}; Dengue by date of diagnosis. Weeks are ISO weeks (Mon–Sun).`),
        para('Cluster analysis', true),
        bullet('Space-time DBSCAN: two cases are neighbours when they lie within the distance AND within the number of days of each other. A cluster forms where a case has at least the minimum number of neighbours (itself included); isolated cases stay unclustered.'),
        bullet(`Settings: ${st.cl.eps} m, ${win}, at least ${st.cl.minPts} cases, ${st.cl.pooled ? 'both diseases together' : 'each disease separately'}.`),
        bullet(`Active = a case within the last ${activeDays} days up to ${app.fmtDay(ref)}; otherwise Closed. "New" = first case in the last 7 days.`),
        bullet('Boundaries: LGD block and village layers, health blocks as listed on salem.nic.in (Attur HUD).')
      ], { x: 0.45, y: 1.3, w: 7.3, h: 5.6, fontFace: FONT, margin: 0, valign: 'top' });

      const byType = new Map();
      d.issues.forEach((i) => { if (!byType.has(i.type)) byType.set(i.type, { sev: i.severity, n: 0 }); byType.get(i.type).n++; });
      const sevColor = { high: C.dengue, medium: C.active, low: 'A07400', info: C.fever };
      const rows = [[
        { text: 'Check', options: { bold: true, color: 'FFFFFF', fill: { color: C.accent } } },
        { text: 'Level', options: { bold: true, color: 'FFFFFF', fill: { color: C.accent } } },
        { text: 'Records', options: { bold: true, color: 'FFFFFF', fill: { color: C.accent }, align: 'right' } }
      ]];
      [...byType.entries()].sort((a, b) => app.SEV_ORDER[a[1].sev] - app.SEV_ORDER[b[1].sev] || b[1].n - a[1].n).forEach(([t, v], i) => {
        const fill = { color: i % 2 ? 'FFFFFF' : 'F7F9F8' };
        rows.push([{ text: t, options: { fill } }, { text: app.SEV_LABEL[v.sev], options: { fill, color: sevColor[v.sev], bold: true } }, { text: String(v.n), options: { fill, align: 'right', bold: true } }]);
      });
      if (rows.length === 1) rows.push([{ text: 'All records passed the checks', options: {} }, { text: '', options: {} }, { text: '', options: {} }]);
      s.addText('Data-quality checks (all loaded records)', { x: 8.1, y: 1.3, w: 4.78, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: C.ink, margin: 0 });
      s.addTable(rows, {
        x: 8.1, y: 1.7, w: 4.78, colW: [2.63, 1.35, 0.8], fontFace: FONT, fontSize: 11, color: C.ink, valign: 'middle',
        rowH: 0.36, border: { type: 'solid', pt: 0.5, color: C.line }, margin: [2, 5, 2, 5], autoPage: false
      });
      s.addText('The record-by-record list is in the app: Export → Data-quality issues.', { x: 8.1, y: 6.55, w: 4.78, h: 0.3, fontFace: FONT, fontSize: 10, color: C.ink3, margin: 0 });
    }

    const n = new Date();
    const stamp = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const fileName = `Attur_HUD_Fever_Dengue_${stamp}.pptx`;
    if (o.returnBlob) return { blob: await pptx.write({ outputType: 'blob' }), fileName, slides: page };
    await pptx.writeFile({ fileName });
    return { fileName, slides: page };
  }

  /* =================================================================
   * Dialog
   * ================================================================= */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('attur.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('attur.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const OPTS = ['pptCover', 'pptCaseMap', 'pptClusterMap', 'pptClusterList', 'pptSummary', 'pptBlocks', 'pptMethods'];

  function open() {
    const app = A();
    if (!app.state.data) return;
    if (!window.PptxGenJS) { app.toast('The PowerPoint library did not load. Check the internet connection and reload the page.', true); return; }
    const f = app.state.f;
    const area = app.areaLabel();
    $('pptTitle').value = app.state.focus ? `Fever & Dengue Surveillance – ${area}` : 'Fever & Dengue Surveillance – Attur HUD';  // EpiTrack Attur appears on every slide
    $('pptSubtitle').value = `${app.state.focus ? `${area}, Attur HUD · ` : ''}${app.fmtDay(f.from)} – ${app.fmtDay(f.to)} · data up to ${app.fmtDay(app.state.asOf)}`;
    $('pptExtentArea').textContent = app.state.focus ? area : 'Whole HUD';
    const saved = store.get('pptSlides', null);
    if (saved) OPTS.forEach((id) => { if (id in saved) $(id).checked = saved[id]; });
    $('pptDialog').showModal();
  }

  $('pptCancel').addEventListener('click', () => $('pptDialog').close());
  $('pptForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = A();
    const o = {
      title: $('pptTitle').value.trim() || 'Fever & Dengue Surveillance – Attur HUD',
      subtitle: $('pptSubtitle').value.trim(),
      extent: document.querySelector('input[name="pptExtent"]:checked').value,
      cover: $('pptCover').checked, caseMap: $('pptCaseMap').checked, clusterMap: $('pptClusterMap').checked,
      clusterList: $('pptClusterList').checked, summary: $('pptSummary').checked, methods: $('pptMethods').checked,
      blocks: $('pptBlocks').checked,
      onProgress: (t) => { $('pptCreate').textContent = `Building… ${t}`; }
    };
    if (!OPTS.some((id) => $(id).checked)) { app.toast('Choose at least one slide.', true); return; }
    store.set('pptSlides', Object.fromEntries(OPTS.map((id) => [id, $(id).checked])));
    $('pptCreate').disabled = true;
    $('pptCreate').textContent = 'Building…';
    try {
      const r = await build(o);
      $('pptDialog').close();
      app.toast(`Saved ${r.fileName} (${r.slides} slides).`);
    } catch (err) {
      app.toast(`The PowerPoint could not be created: ${err.message}`, true);
    } finally {
      $('pptCreate').disabled = false;
      $('pptCreate').textContent = 'Download PowerPoint';
    }
  });

  window.AtturReport = { open, build, renderMap };
})();
