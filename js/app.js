(function () {
  'use strict';

  const LL = window.LineList;
  const AN = window.Analysis;
  const HUD = window.HUD_DATA;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Number(n).toLocaleString('en-IN');
  // Math.min(...arr) fails on very large arrays, so reduce instead.
  const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
  const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);

  /* ---------- Dates ---------- */
  const DAY = 86400000;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const dt = (d) => new Date(d * DAY);
  const fmtDay = (d) => (d === null || d === undefined ? '—' : `${pad(dt(d).getUTCDate())} ${MON[dt(d).getUTCMonth()]} ${dt(d).getUTCFullYear()}`);
  const fmtShort = (d) => (d === null || d === undefined ? '—' : `${pad(dt(d).getUTCDate())} ${MON[dt(d).getUTCMonth()]}`);
  const fmtXl = (d) => (d === null || d === undefined ? '' : `${pad(dt(d).getUTCDate())}-${MON[dt(d).getUTCMonth()]}-${dt(d).getUTCFullYear()}`);
  const toInput = (d) => dt(d).toISOString().slice(0, 10);
  const fromInput = (s) => (s ? Math.round(Date.parse(s + 'T00:00:00Z') / DAY) : null);

  /* ---------- Constants ---------- */
  const DISEASE_COLOR = { 'Dengue': '#c92a2a', 'IP Fever': '#1c6fc9' };
  const RECENCY = [
    { max: 7, color: '#c92a2a', label: 'Last 7 days' },
    { max: 14, color: '#f76707', label: '8–14 days ago' },
    { max: 28, color: '#f2b100', label: '15–28 days ago' },
    { max: Infinity, color: '#8f9aa3', label: 'Older' }
  ];
  const CLUSTER_PALETTE = ['#e8590c', '#7048e8', '#0ca678', '#d6336c', '#1971c2', '#f08c00', '#5c940d', '#ae3ec9', '#0b7285', '#c2255c', '#364fc7', '#a61e4d'];
  const SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
  const SEV_LABEL = { high: 'Please fix', medium: 'Please check', low: 'Minor', info: 'For your information' };
  const PLAIN_ISSUE = {
    'Missing coordinates': 'No location (latitude / longitude)',
    'Outside HUD boundary': 'Location is outside Attur HUD',
    'Low-precision coordinates': 'Location is only approximate',
    'Latitude and longitude swapped': 'Latitude and longitude were swapped (fixed)',
    'Block differs from location': 'Block written does not match the location',
    'Missing or unreadable date': 'No usable date',
    'Unreadable date': 'A date could not be read',
    'Onset after admission': 'Fever start date is after admission',
    'Onset long before reporting': 'Fever start date looks wrong',
    'Admission after reporting': 'Admission date is after reporting date',
    'Block name not recognised': 'Block name not recognised',
    'Sex not recorded': 'Sex not filled in',
    'Age not recorded': 'Age not filled in',
    'Possible duplicate': 'Looks like the same patient entered twice',
    'Also in the dengue list': 'Fever case later confirmed as dengue'
  };
  const plainIssue = (t) => PLAIN_ISSUE[t] || t;
  const DISEASE_SOFT = { 'Dengue': '#fdecec', 'IP Fever': '#e8f1fc' };
  const BLOCK_ORDER = ['Attur', 'Attur Mpty', 'Narasingapuram Mpty', 'Ayothiyapattinam', 'Gangavalli', 'Panamarathupatti', 'Pethanaickenpalayam', 'Thalaivasal', 'Valapadi', 'Yercaud'];
  // Health-block polygons are labelled with the block name the line list uses.
  const LINE_LIST_NAME = { 'Attur': 'Attur', 'Ariyapalayam': 'Pethanaickenpalayam', 'Ayyothiyapattinam': 'Ayothiyapattinam', 'Belur': 'Valapadi', 'Panamarathupatty': 'Panamarathupatti', 'Thalaivasal': 'Thalaivasal', 'Thammampatty': 'Gangavalli', 'Yercaud': 'Yercaud' };
  const HUD_AREA_KM2 = HUD.villages.features.reduce((s, f) => s + f.properties.area_km2, 0);
  const BASIS_LABEL = { report: 'Date of reporting', adm: 'Date of admission', onset: 'Date of onset' };

  /* ---------- State ---------- */
  const state = {
    files: [],
    data: null,
    asOf: null, minDay: null,
    f: null,
    cl: { eps: 400, days: 14, minPts: 3, pooled: false, status: 'all', sort: 'recent', selected: null },
    colorBy: 'disease',
    basemap: 'osm',
    pointSize: 8,
    privacy: false,
    qaType: null,
    filtered: [], clusters: [], membership: new Map(), clusterColor: new Map(),
    baseFiltered: [], allClusters: [], contextCases: [], focus: null
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('attur.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('attur.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------- IndexedDB (remembered files) ---------- */
  const IDB = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('attur-hud-gis', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const req = fn(db.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    },
    get(k) { return this.run('readonly', (s) => s.get(k)); },
    set(k, v) { return this.run('readwrite', (s) => s.put(v, k)); },
    del(k) { return this.run('readwrite', (s) => s.delete(k)); }
  };

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 8000 : 4500);
  }

  /* =================================================================
   * Map
   * ================================================================= */
  const map = L.map('map', { zoomControl: true, minZoom: 7, preferCanvas: false });
  const basemaps = {
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }),
    hot: L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      maxZoom: 19, subdomains: 'abc',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, tiles: Humanitarian OSM Team'
    })
  };
  let currentBase = basemaps.osm.addTo(map);
  L.control.scale({ metric: true, imperial: false, position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix('EpiTrack Attur · Designed by Dr. M. Sivachandran Mathiyazagan, MBBS, MPH (ICMR-NIE) · <a href="https://leafletjs.com">Leaflet</a>');
  [['mask', 395], ['villages', 400], ['blocks', 410], ['hud', 420], ['focus', 425], ['heat', 430], ['clusters', 440], ['cases', 450]]
    .forEach(([n, z]) => { map.createPane(n); map.getPane(n).style.zIndex = z; });
  map.getPane('villages').style.pointerEvents = 'none';

  const hudLayer = L.geoJSON(HUD.hud, { pane: 'hud', interactive: false, style: { color: '#b3202a', weight: 3, fill: false } }).addTo(map);
  const blockLayer = L.geoJSON(HUD.blocks, { pane: 'blocks', interactive: false, style: { color: '#1b1b1b', weight: 1.4, fill: false, opacity: .75 } }).addTo(map);
  const villageLayer = L.geoJSON(HUD.villages, { pane: 'villages', interactive: false, style: { color: '#5b5b5b', weight: .6, fill: false, opacity: .7 } });
  const labelLayer = L.layerGroup(HUD.blocks.features.map((f) => {
    const p = f.properties;
    const ll = LINE_LIST_NAME[p.health_block] || p.health_block;
    return L.tooltip({ permanent: true, direction: 'center', className: 'block-label', interactive: false })
      .setLatLng([p.label_lat, p.label_lon]).setContent(esc(ll));
  })).addTo(map);
  const caseLayer = L.layerGroup().addTo(map);
  const stackLayer = L.layerGroup().addTo(map);
  const spotKey = (c) => `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`; // about 10 m
  let spots = new Map();
  // Case points are drawn on one canvas rather than one SVG element each, so large files stay smooth.
  const caseRenderer = L.canvas({ pane: 'cases', padding: 0.3, tolerance: 3 });
  const clusterLayer = L.layerGroup().addTo(map);
  const clusterRenderer = L.canvas({ pane: 'clusters', padding: 0.3 });
  const clusterLabelLayer = L.layerGroup().addTo(map);
  let heatLayer = null;
  const markerByUid = new Map();
  const circleById = new Map();

  const hudBounds = hudLayer.getBounds();
  const areaBounds = () => (state.focus ? state.focus.bounds : hudBounds);
  const fitHud = () => map.fitBounds(areaBounds(), { padding: [24, 24], maxZoom: 16 });
  const focusLayer = L.layerGroup().addTo(map);
  fitHud();
  let userMoved = false;
  ['pointerdown', 'wheel', 'keydown'].forEach((ev) => $('map').addEventListener(ev, () => { userMoved = true; }, { passive: true }));
  new ResizeObserver(() => { map.invalidateSize(); if (!userMoved) fitHud(); }).observe($('map'));
  $('fitBtn').addEventListener('click', () => { userMoved = false; fitHud(); });
  // Cluster ID labels crowd each other at district zoom; show them from zoom 11 upward.
  const syncLabelZoom = () => $('map').classList.toggle('far', map.getZoom() < 11);
  map.on('zoomend', syncLabelZoom);
  syncLabelZoom();

  /* =================================================================
   * Loading files
   * ================================================================= */
  const geo = AN.buildGeoIndex(HUD);

  async function readFile(file) {
    const buffer = await file.arrayBuffer();
    return { name: file.name, buffer, size: file.size, addedAt: Date.now() };
  }

  function processFiles(files) {
    const parsed = [];
    const problems = [];
    for (const f of files) {
      try {
        // CSV cells are kept as text so DD-MM dates are not read month-first by the library.
        const isCsv = /\.csv$/i.test(f.name);
        const wb = XLSX.read(new Uint8Array(f.buffer), { type: 'array', cellDates: false, raw: isCsv });
        const p = LL.parseWorkbook(wb, f.name);
        p.file = f.name;
        if (!p.cases.length) problems.push(`${f.name}: ${p.skipped.map((s) => `${s.sheet} – ${s.reason}`).join('; ') || 'no case rows found'}`);
        parsed.push(p);
      } catch (e) {
        problems.push(`${f.name}: could not be read as a spreadsheet (${e.message})`);
      }
    }
    const total = parsed.reduce((s, p) => s + p.cases.length, 0);
    if (!total) {
      toast(`No cases found. ${problems.join(' | ')}. Check that the headings match the template.`, true);
      return false;
    }
    const combined = LL.combine(parsed);
    const days = combined.cases.map((c) => c.day).filter((d) => d !== null);
    if (!days.length) {
      toast(`${fmtN(combined.cases.length)} rows were found, but none has a readable date. Dates should look like 03-09-2026.`, true);
      return false;
    }
    const issues = AN.enrichAndCheck(combined.cases, geo);
    state.files = files;
    state.data = { ...combined, issues };
    state.asOf = maxOf(days);
    state.minDay = minOf(days);
    state.cl.selected = null;
    state.qaType = null;
    state.focus = null;
    initFilters();
    $('emptyState').hidden = true;
    $('btnExport').disabled = false;
    const corrected = combined.sheets.reduce((s, x) => s + x.datesCorrected, 0);
    $('datasetChip').hidden = false;
    $('datasetText').innerHTML = `Data up to <b>${fmtDay(state.asOf)}</b> · ${fmtN(combined.cases.length)} cases · ${files.length === 1 ? esc(files[0].name) : files.length + ' files'}`;
    $('datasetChip').title = files.map((f) => f.name).join('\n');
    update();
    renderQuality();
    userMoved = false; fitHud();
    let msg = `Loaded ${fmtN(combined.cases.length)} cases. Data up to ${fmtDay(state.asOf)}.`;
    if (corrected) msg += ` ${fmtN(corrected)} dates that Excel had mixed up were put right.`;
    if (combined.exactDupes) msg += ` ${combined.exactDupes} rows found in two files were counted once.`;
    if (problems.length) msg += ` Skipped: ${problems.join('; ')}`;
    toast(msg);
    return true;
  }

  async function loadFiles(fileList, mode) {
    if (!fileList || !fileList.length) return;
    let read;
    try { read = await Promise.all([...fileList].map(readFile)); } catch (e) { toast(`Could not open the file: ${e.message}`, true); return; }
    const files = mode === 'add' ? state.files.concat(read.filter((r) => !state.files.some((f) => f.name === r.name && f.size === r.size))) : read;
    if (processFiles(files)) persist();
  }

  async function persist() {
    if (!$('optRemember').checked) return;
    try { await IDB.set('files', state.files.map(({ name, buffer, size, addedAt }) => ({ name, buffer, size, addedAt }))); } catch (e) { /* storage unavailable */ }
  }

  $('btnLoad').addEventListener('click', () => { $('fileInput').dataset.mode = 'replace'; $('fileInput').click(); });
  $('btnLoad2').addEventListener('click', () => { $('fileInput').dataset.mode = 'replace'; $('fileInput').click(); });
  $('btnAddFile').addEventListener('click', () => { $('fileInput').dataset.mode = 'add'; $('fileInput').click(); });
  $('fileInput').addEventListener('change', (e) => { loadFiles(e.target.files, e.target.dataset.mode || 'replace'); e.target.value = ''; });
  $('btnForget').addEventListener('click', async () => {
    try { await IDB.del('files'); } catch (e) { /* ignore */ }
    location.reload();
  });
  $('optRemember').checked = store.get('remember', true);
  $('optRemember').addEventListener('change', async (e) => {
    store.set('remember', e.target.checked);
    if (e.target.checked) persist();
    else { try { await IDB.del('files'); } catch (err) { /* ignore */ } toast('The loaded files will not be kept after you close this page.'); }
  });

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropZone').hidden = false; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropZone').hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('dropZone').hidden = true;
    loadFiles(e.dataTransfer.files, 'replace');
  });

  /* =================================================================
   * Filters
   * ================================================================= */
  const countBy = (list, key) => {
    const m = new Map();
    list.forEach((c) => { const v = typeof key === 'function' ? key(c) : c[key]; m.set(v, (m.get(v) || 0) + 1); });
    return m;
  };
  const eday = (c) => {
    if (c.disease !== 'IP Fever') return c.day;
    const b = state.f ? state.f.basis : 'report';
    if (b === 'adm') return c.admDay ?? c.day;
    if (b === 'onset') return c.onsetDay ?? null;
    return c.day;
  };

  // By default only IP Fever and Dengue cases are shown: every Dengue result, and on the Fever sheet
  // plain "Fever" plus NS1-positive dengue. Other infections (Leptospirosis, H1N1 ...) start unticked.
  const isCoreCase = (c) => c.disease === 'Dengue' || c.condition === 'Fever' || c.condition === 'Dengue NS1 +ve';
  const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));
  const isDefaultFilter = (k) => (k === 'condition' ? sameSet(state.f.condition, state.f.def.condition) : state.f[k].size === state.f.all[k].size);

  function initFilters() {
    const cases = state.data.cases;
    const sets = {};
    const opt = (key) => new Set(cases.map((c) => c[key]));
    sets.disease = opt('disease');
    sets.condition = opt('condition');
    sets.block = opt('block');
    sets.phc = opt('phc');
    sets.area = opt('areaType');
    sets.sex = opt('sex');
    sets.age = opt('ageGroup');
    sets.source = new Set(cases.filter((c) => c.disease === 'Dengue').map((c) => c.source || 'Not stated'));
    state.f = {
      from: state.minDay, to: state.asOf, basis: $('dateBasis').value || 'report',
      ...sets,
      all: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, new Set(v)])),
      inHud: $('optInHud').checked, noDup: $('optNoDup').checked, noFeverDengue: $('optNoFeverDengue').checked,
      phcSearch: ''
    };
    const core = new Set(cases.filter(isCoreCase).map((c) => c.condition));
    state.f.condition = new Set(core);
    state.f.def = { condition: core };
    $('phcSearch').value = '';
    $('periodNote').textContent = `Data ${fmtShort(state.minDay)} – ${fmtDay(state.asOf)}`;
    buildFilterControls();
    renderFocusBlocks();
    setDateInputs();
  }

  function setDateInputs() {
    const f = state.f;
    ['dateFrom', 'dateTo'].forEach((id) => { $(id).min = toInput(state.minDay); $(id).max = toInput(state.asOf); });
    $('dateFrom').value = toInput(f.from);
    $('dateTo').value = toInput(f.to);
    const presets = { 7: state.asOf - 6, 14: state.asOf - 13, 28: state.asOf - 27, all: state.minDay };
    const a = dt(state.asOf);
    presets.month = Math.round(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1) / DAY);
    const match = Object.keys(presets).find((k) => f.to === state.asOf && f.from === presets[k]);
    const custom = state.customPeriod || !match;
    $('periodSelect').value = custom ? 'custom' : match;
    $('customDates').hidden = !custom;
  }

  function syncDiseaseSelect() {
    if (!state.f) return;
    const on = ['Dengue', 'IP Fever'].filter((d) => state.f.disease.has(d));
    $('diseaseSelect').value = on.length === 1 ? on[0] : 'both';
  }
  $('diseaseSelect').addEventListener('change', (e) => {
    if (!state.f) return;
    const v = e.target.value;
    state.f.disease = new Set(v === 'both' ? [...state.f.all.disease] : [v]);
    buildFilterControls();
    update();
  });

  function chipGroup(el, key, items) {
    const set = state.f[key];
    el.innerHTML = items.map((it) => `<button type="button" data-v="${esc(it.value)}" aria-pressed="${set.has(it.value)}"${it.color ? ` style="--c:${it.color};--soft:${it.soft || 'transparent'}"` : ''}>
      ${it.color ? '<i></i>' : ''}${esc(it.label ?? it.value)}${it.count !== undefined ? ` <span class="n">${fmtN(it.count)}${it.unit ? ` ${it.unit}` : ''}</span>` : ''}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.v;
      set.has(v) ? set.delete(v) : set.add(v);
      b.setAttribute('aria-pressed', set.has(v));
      update();
    }));
  }

  function checklist(el, key, items) {
    const set = state.f[key];
    el.innerHTML = items.length ? items.map((it) => `<label><input type="checkbox" data-v="${esc(it.value)}" ${set.has(it.value) ? 'checked' : ''}>
      <span>${esc(it.value)}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</span><span class="n">${fmtN(it.count)}</span></label>`).join('')
      : '<p class="muted">No matches.</p>';
    el.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
      const v = cb.dataset.v;
      cb.checked ? set.add(v) : set.delete(v);
      update();
    }));
  }

  function buildFilterControls() {
    const cases = state.data.cases;
    const byDis = countBy(cases, 'disease');
    chipGroup($('fDisease'), 'disease', ['Dengue', 'IP Fever'].filter((d) => byDis.has(d))
      .map((d) => ({ value: d, count: byDis.get(d), color: DISEASE_COLOR[d], soft: DISEASE_SOFT[d] })));
    syncDiseaseSelect();
    const byCond = countBy(cases, 'condition');
    chipGroup($('fCondition'), 'condition', [...byCond.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, count: n })));
    const byArea = countBy(cases, 'areaType');
    chipGroup($('fArea'), 'area', ['VP', 'TP', 'Mpty', 'Corporation', 'Not stated'].filter((v) => byArea.has(v)).map((v) => ({ value: v, count: byArea.get(v) })));
    const bySex = countBy(cases, 'sex');
    chipGroup($('fSex'), 'sex', ['Male', 'Female', 'Unknown'].filter((v) => bySex.has(v)).map((v) => ({ value: v, count: bySex.get(v) })));
    const byAge = countBy(cases, 'ageGroup');
    chipGroup($('fAge'), 'age', LL.AGE_GROUPS.filter((v) => byAge.has(v)).map((v) => ({ value: v, count: byAge.get(v) })));
    const bySrc = countBy(cases.filter((c) => c.disease === 'Dengue'), (c) => c.source || 'Not stated');
    chipGroup($('fSource'), 'source', ['SSH', 'OVF', 'Not stated'].filter((v) => bySrc.has(v)).map((v) => ({ value: v, count: bySrc.get(v) })));
    renderBlockList();
    renderPhcList();
  }

  function renderBlockList() {
    const byBlock = countBy(state.data.cases, 'block');
    const names = [...byBlock.keys()].sort((a, b) => {
      const ia = BLOCK_ORDER.indexOf(a), ib = BLOCK_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    checklist($('fBlock'), 'block', names.map((n) => {
      const hb = LL.HEALTH_BLOCK[n];
      return { value: n, count: byBlock.get(n), sub: hb && hb !== n && !/Mpty/.test(n) ? `· ${hb} HB` : '' };
    }));
  }

  function renderPhcList() {
    const q = LL.norm(state.f.phcSearch);
    const inBlocks = state.data.cases.filter((c) => state.f.block.has(c.block));
    const byPhc = countBy(inBlocks, 'phc');
    const names = [...byPhc.keys()].filter((n) => !q || LL.norm(n).includes(q)).sort((a, b) => a.localeCompare(b));
    checklist($('fPhc'), 'phc', names.map((n) => ({ value: n, count: byPhc.get(n) })));
  }

  document.querySelectorAll('[data-all],[data-none]').forEach((b) => b.addEventListener('click', () => {
    if (!state.f) return;
    const id = b.dataset.all || b.dataset.none;
    const key = id === 'fBlock' ? 'block' : 'phc';
    const visible = [...$(id).querySelectorAll('input')].map((i) => i.dataset.v);
    visible.forEach((v) => (b.dataset.all ? state.f[key].add(v) : state.f[key].delete(v)));
    key === 'block' ? renderBlockList() : null;
    renderPhcList();
    update();
  }));
  $('phcSearch').addEventListener('input', (e) => { if (!state.f) return; state.f.phcSearch = e.target.value; renderPhcList(); });

  $('dateFrom').addEventListener('change', (e) => { if (!state.f) return; const d = fromInput(e.target.value); if (d !== null) { state.f.from = d; setDateInputs(); update(); } });
  $('dateTo').addEventListener('change', (e) => { if (!state.f) return; const d = fromInput(e.target.value); if (d !== null) { state.f.to = d; setDateInputs(); update(); } });
  $('periodSelect').addEventListener('change', (e) => {
    if (!state.f) return;
    const p = e.target.value;
    if (p === 'custom') { state.customPeriod = true; setDateInputs(); $('dateFrom').focus(); return; }
    state.customPeriod = false;
    state.f.to = state.asOf;
    if (p === 'all') state.f.from = state.minDay;
    else if (p === 'month') { const a = dt(state.asOf); state.f.from = Math.round(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1) / DAY); }
    else state.f.from = state.asOf - (+p - 1);
    setDateInputs(); update();
  });
  document.querySelectorAll('#datePresets button').forEach((b) => b.addEventListener('click', () => {
    if (!state.f) return;
    const p = b.dataset.preset;
    state.f.to = state.asOf;
    if (p === 'all') state.f.from = state.minDay;
    else if (p === 'month') { const a = dt(state.asOf); state.f.from = Math.round(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1) / DAY); }
    else state.f.from = state.asOf - (+p - 1);
    setDateInputs(); update();
  }));
  $('dateBasis').addEventListener('change', (e) => { if (!state.f) return; state.f.basis = e.target.value; update(); });
  [['optInHud', 'inHud'], ['optNoDup', 'noDup'], ['optNoFeverDengue', 'noFeverDengue']].forEach(([id, k]) =>
    $(id).addEventListener('change', (e) => { if (!state.f) return; state.f[k] = e.target.checked; update(); }));
  $('resetFilters').addEventListener('click', () => {
    if (!state.data) return;
    $('optInHud').checked = true; $('optNoDup').checked = true; $('optNoFeverDengue').checked = false;
    $('dateBasis').value = 'report';
    initFilters(); update();
  });

  function applyFilters() {
    const f = state.f;
    return state.data.cases.filter((c) => {
      if (!f.disease.has(c.disease) || !f.condition.has(c.condition) || !f.block.has(c.block) || !f.phc.has(c.phc)) return false;
      if (!f.area.has(c.areaType) || !f.sex.has(c.sex) || !f.age.has(c.ageGroup)) return false;
      if (c.disease === 'Dengue' && !f.source.has(c.source || 'Not stated')) return false;
      if (f.inHud && !c.inHud) return false;
      if (f.noDup && c.dupOf !== null) return false;
      if (f.noFeverDengue && c.laterDengue !== null) return false;
      const d = eday(c);
      return d !== null && d >= f.from && d <= f.to;
    });
  }

  /* =================================================================
   * Clusters
   * ================================================================= */
  const refDay = () => Math.min(state.f.to, state.asOf);

  function runClusters() {
    // Clusters are always found on the whole HUD so an area's clusters are not cut at its boundary.
    const pts = state.baseFiltered.map((c) => Object.assign(Object.create(c), { day: eday(c) }));
    const r = AN.findClusters(pts, { epsM: state.cl.eps, days: state.cl.days, minPts: state.cl.minPts, pooled: state.cl.pooled, asOf: refDay() });
    state.allClusters = r.clusters;
    state.clusters = r.clusters;
    state.membership = r.membership;
    state.clusterColor = new Map(r.clusters.map((c, i) => [c.id, CLUSTER_PALETTE[i % CLUSTER_PALETTE.length]]));
    if (state.cl.selected && !r.clusters.some((c) => c.id === state.cl.selected)) state.cl.selected = null;
  }

  function syncClusterControls() {
    $('eps').value = state.cl.eps; $('days').value = state.cl.days; $('minPts').value = state.cl.minPts;
    $('epsVal').textContent = state.cl.eps >= 1000 ? `${(state.cl.eps / 1000).toFixed(state.cl.eps % 1000 ? 2 : 0)} km` : `${state.cl.eps} m`;
    $('daysVal').textContent = AN.windowText(state.cl.days);
    $('minVal').textContent = `${state.cl.minPts} cases`;
    document.querySelectorAll('#clusterPresets button').forEach((b) => b.classList.toggle('on',
      +b.dataset.eps === state.cl.eps && +b.dataset.days === state.cl.days && +b.dataset.min === state.cl.minPts));
  }
  let clTimer = null;
  const clusterChanged = () => { syncClusterControls(); store.set('cluster', { eps: state.cl.eps, days: state.cl.days, minPts: state.cl.minPts, pooled: state.cl.pooled }); clearTimeout(clTimer); clTimer = setTimeout(() => { if (state.data) update(); }, 120); };
  ['input', 'change'].forEach((ev) => {
    $('eps').addEventListener(ev, (e) => { state.cl.eps = +e.target.value; clusterChanged(); });
    $('days').addEventListener(ev, (e) => { state.cl.days = +e.target.value; clusterChanged(); });
    $('minPts').addEventListener(ev, (e) => { state.cl.minPts = +e.target.value; clusterChanged(); });
  });
  document.querySelectorAll('input[name="pooled"]').forEach((r) => r.addEventListener('change', () => { state.cl.pooled = r.value === '1'; clusterChanged(); }));
  document.querySelectorAll('#clusterPresets button').forEach((b) => b.addEventListener('click', () => {
    state.cl.eps = +b.dataset.eps; state.cl.days = +b.dataset.days; state.cl.minPts = +b.dataset.min; clusterChanged();
  }));
  document.querySelectorAll('#clusterStatusFilter button').forEach((b) => b.addEventListener('click', () => {
    state.cl.status = b.dataset.status;
    document.querySelectorAll('#clusterStatusFilter button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    renderClusterList();
  }));
  $('clusterSort').addEventListener('change', (e) => { state.cl.sort = e.target.value; renderClusterList(); });

  function renderClusterStats() {
    const cl = state.clusters;
    const mapped = state.filtered.filter((c) => c.lat !== null).length;
    const inCl = state.filtered.filter((c) => state.membership.has(c.uid)).length;
    const active = cl.filter((c) => c.status === 'Active').length;
    $('clusterStats').innerHTML = `
      <div><dt>hotspots</dt><dd>${cl.length}</dd></div>
      <div><dt>cases in them (${mapped ? Math.round((inCl / mapped) * 100) : 0}% of cases shown)</dt><dd>${inCl}</dd></div>`;
    if (state.focus && !state.focus.areaKm2) { $('nni').textContent = ''; return; }
    const pts = state.focus ? state.filtered.filter((c) => c.lat !== null) : state.filtered.filter((c) => c.inHud);
    const nni = AN.nearestNeighbourIndex(pts, state.focus ? state.focus.areaKm2 : HUD_AREA_KM2);
    if (!nni) { $('nni').textContent = ''; return; }
    const verdict = nni.z < -2.58 ? 'Cases are <b>strongly grouped together</b>, far more than chance would give.'
      : nni.z < -1.96 ? 'Cases are <b>grouped together</b> more than chance would give.'
        : nni.z > 1.96 ? 'Cases are <b>spread out</b> evenly, with no grouping.'
          : 'Cases are <b>not clearly grouped</b>; the pattern could be chance.';
    $('nni').innerHTML = `${verdict} <span title="Clark–Evans nearest-neighbour ratio ${nni.ratio.toFixed(2)}, z = ${nni.z.toFixed(1)}" style="color:var(--ink-3)">(ratio ${nni.ratio.toFixed(2)})</span>`;
  }

  function renderClusterList() {
    let list = state.clusters.slice();
    if (state.cl.status !== 'all') list = list.filter((c) => c.status === state.cl.status);
    if (state.cl.sort === 'size') list.sort((a, b) => b.members.length - a.members.length || b.last - a.last);
    else if (state.cl.sort === 'first') list.sort((a, b) => a.first - b.first);
    else list.sort((a, b) => b.last - a.last || b.members.length - a.members.length);
    $('clusterBadge').textContent = state.clusters.filter((c) => c.status === 'Active').length || '';
    if (!list.length) {
      $('clusterList').innerHTML = `<li class="empty-note">${state.clusters.length ? 'No hotspots in this group.' : state.focus ? `No hotspots in ${esc(state.focus.label)} with this rule.` : 'No hotspots with this rule. Try "Broad" above.'}</li>`;
      return;
    }
    const ref = refDay();
    $('clusterList').innerHTML = list.map((c) => {
      const sel = state.cl.selected === c.id;
      const cls = c.key === 'Dengue' ? 'den' : c.key === 'IP Fever' ? 'ipf' : 'all';
      const place = c.places.map(([p]) => p).slice(0, 3).join(', ');
      const blocks = c.blocks.map(([b]) => b).join(', ');
      const mix = c.key === 'All' ? ` · ${c.diseases.map(([d, n]) => `${n} ${d}`).join(', ')}` : '';
      const members = sel ? `<ul class="members">${c.members.map((m) => `<li><span class="d">${fmtShort(m.day)}</span>
          <span>${esc(state.privacy ? (m.village || m.localBody) : `${m.name} · ${m.village || m.localBody}`)}</span>
          <span class="a">${esc(ageSex(m))}</span></li>`).join('')}</ul>` : '';
      const ago = ref - c.last;
      const lastTxt = ago <= 0 ? 'last case on the latest date' : ago === 1 ? 'last case 1 day ago' : `last case ${ago} days ago`;
      return `<li><button type="button" class="cluster-card${c.status === 'Active' ? ' is-active' : ''}" data-id="${c.id}" aria-expanded="${sel}">
        <div class="cc-place">${esc(place)}</div>
        <div class="cc-n">${c.members.length}<small>cases</small></div>
        <div class="cc-sub"><span class="pill ${c.status === 'Active' ? 'active' : 'closed'}">${c.status === 'Active' ? 'Active' : 'Over'}</span>
          ${c.isNew ? '<span class="pill new">New this week</span>' : ''}
          <span class="cc-id ${cls}">${c.id}</span><span>${esc(c.key === 'All' ? 'Dengue + IP Fever' : c.key)} · ${esc(blocks)}</span></div>
        <div class="cc-meta">${fmtShort(c.first)} to ${fmtShort(c.last)} · ${lastTxt}${c.recent7 ? ` · <b>${c.recent7} this week</b>` : ''}${esc(mix)}</div>
        ${members}
      </button></li>`;
    }).join('');
    $('clusterList').querySelectorAll('.cluster-card').forEach((b) => b.addEventListener('click', () => selectCluster(b.dataset.id, true)));
  }

  function selectCluster(id, zoom) {
    state.cl.selected = state.cl.selected === id ? null : id;
    renderClusterList();
    renderCases();
    renderClusterAreas();
    const c = state.clusters.find((x) => x.id === state.cl.selected);
    if (c && zoom) {
      userMoved = true;
      map.fitBounds(L.latLngBounds(c.members.map((m) => [m.lat, m.lon])).pad(0.6), { maxZoom: 16 });
    }
  }

  /* =================================================================
   * Map rendering
   * ================================================================= */
  function caseColor(c) {
    if (state.colorBy === 'recency') {
      const age = refDay() - eday(c);
      return (RECENCY.find((r) => age < r.max) || RECENCY[RECENCY.length - 1]).color;
    }
    if (state.colorBy === 'cluster') {
      const id = state.membership.get(c.uid);
      return id ? state.clusterColor.get(id) : '#9aa3a9';
    }
    return DISEASE_COLOR[c.disease];
  }

  const ageSex = (c) => {
    const a = c.ageYears === null ? '?' : c.ageYears >= 1 ? `${Math.floor(c.ageYears)} y` : c.ageLabel.replace(' months', ' mo').replace(' days', ' d');
    return `${a} ${c.sex === 'Male' ? 'M' : c.sex === 'Female' ? 'F' : ''}`.trim();
  };

  function popupHtml(c) {
    const cl = state.membership.get(c.uid);
    const rows = [];
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '') rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
    add(c.disease === 'IP Fever' ? BASIS_LABEL[state.f.basis] : 'Date', fmtDay(eday(c)));
    if (c.disease === 'IP Fever') {
      if (state.f.basis !== 'onset') add('Onset', c.onsetDay !== null ? fmtDay(c.onsetDay) : '');
      if (state.f.basis !== 'adm') add('Admission', c.admDay !== null ? fmtDay(c.admDay) : '');
    }
    add('Block', esc(c.block) + (c.healthBlock && c.healthBlock !== c.block && !/Mpty/.test(c.block) ? ` <span style="color:#75827d">(${esc(c.healthBlock)} HB)</span>` : ''));
    add('PHC / HSC', esc([c.phc, c.hsc].filter(Boolean).join(' / ')));
    add('Local body', `${esc(c.localBody)} <span style="color:#75827d">${esc(c.areaType)}</span>`);
    add('Ward / street', esc([c.ward, c.habitation].filter(Boolean).join(', ')));
    add('Location', c.village ? `${esc(c.village)}${c.villageType && c.villageType !== 'Revenue Village' ? ` (${esc(c.villageType)})` : ''}` : (c.kmOutside !== null ? `${c.kmOutside.toFixed(1)} km outside HUD` : ''));
    add('Hospital', esc(c.hospital));
    if (c.disease === 'Dengue') add('SSH / OVF', esc(c.source));
    add('Cluster', cl ? `<b>${cl}</b>` : 'Not in a cluster');
    if (!state.privacy) {
      add('Phone', esc(c.phones.join(', ')));
      add('Address', esc(c.address));
    }
    add('Record', `${esc(c.sheet)} row ${c.row}`);
    const flags = c.flags.filter((f) => f !== 'Block differs from location' || true);
    return `<div class="pop">
      <span class="tag" style="background:${DISEASE_COLOR[c.disease]}">${esc(c.disease)}</span><span style="font-size:12px;color:#47544f">${esc(c.condition)}</span>
      <h4>${esc(state.privacy ? `Case ${c.sheet} #${c.row}` : c.name || 'Name not recorded')}</h4>
      <div class="sub">${esc(ageSex(c))}${c.sex === 'Unknown' ? ' · sex not recorded' : ''}</div>
      <dl>${rows.join('')}</dl>
      ${flags.length ? `<div class="flag">${flags.map(esc).join(' · ')}</div>` : ''}
    </div>`;
  }

  function renderCases() {
    caseLayer.clearLayers();
    markerByUid.clear();
    if (!$('lyrCases').checked) return;
    const sel = state.cl.selected;
    // Dengue (rarer) is drawn over IP Fever so it is never hidden; within a disease, newest on top.
    const onlyCl = $('optOnlyClustered').checked;
    const context = new Set(state.contextCases.map((c) => c.uid));
    const list = state.filtered.concat(state.contextCases)
      .filter((c) => c.lat !== null && (!onlyCl || state.membership.has(c.uid)))
      .sort((a, b) => context.has(b.uid) - context.has(a.uid) || (a.disease === 'Dengue') - (b.disease === 'Dengue') || eday(a) - eday(b));
    for (const c of list) {
      const inSel = sel && state.membership.get(c.uid) === sel;
      const outside = context.has(c.uid);   // cluster member lying outside the selected area
      const faint = (sel && !inSel) || (outside && !inSel);
      const m = L.circleMarker([c.lat, c.lon], {
        pane: 'cases', renderer: caseRenderer,
        radius: inSel ? state.pointSize + 2 : state.pointSize,
        color: inSel ? '#111' : '#ffffff',
        weight: inSel ? 2 : state.pointSize >= 9 ? 1.6 : 1.3,
        fillColor: caseColor(c),
        fillOpacity: faint ? 0.35 : 0.92,
        opacity: faint ? 0.5 : 1
      });
      m.bindPopup(() => popupHtml(c) + stackHtml(c) + (outside ? `<div class="flag">Outside ${esc(state.focus.label)}; shown because it belongs to cluster ${state.membership.get(c.uid)}.</div>` : ''), { maxWidth: 320 });
      m.bindTooltip(() => `${esc(state.privacy ? c.disease : c.name)} · ${fmtShort(eday(c))}`, { direction: 'top', offset: [0, -6] });
      m.addTo(caseLayer);
      markerByUid.set(c.uid, m);
    }
  }

  // Cases that share one spot are drawn on top of each other, so the dot gets a count badge.
  function renderStacks() {
    stackLayer.clearLayers();
    spots = new Map();
    if (!state.data || !$('lyrCases').checked) return;
    const onlyCl = $('optOnlyClustered').checked;
    state.filtered.concat(state.contextCases).forEach((c) => {
      if (c.lat === null || (onlyCl && !state.membership.has(c.uid))) return;
      const k = spotKey(c);
      if (!spots.has(k)) spots.set(k, []);
      spots.get(k).push(c);
    });
    if (map.getZoom() < 12) return;
    const view = map.getBounds().pad(0.2);
    spots.forEach((list) => {
      if (list.length < 2 || !view.contains([list[0].lat, list[0].lon])) return;
      const off = state.pointSize + 2;
      L.marker([list[0].lat, list[0].lon], {
        pane: 'cases', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'stack-badge', html: `<span>${list.length}</span>`, iconSize: [0, 0], iconAnchor: [-off + 4, off + 6] })
      }).addTo(stackLayer);
    });
  }
  map.on('zoomend moveend', () => { if (state.data) renderStacks(); });
  function stackHtml(c) {
    const list = c.lat === null ? [] : (spots.get(spotKey(c)) || []).filter((x) => x.uid !== c.uid);
    if (!list.length) return '';
    return `<div class="stack"><b>${list.length} other case${list.length === 1 ? '' : 's'} at this same spot</b>${list.slice(0, 8).map((x) =>
      `${esc(fmtShort(eday(x)))} · ${esc(x.disease)} · ${esc(state.privacy ? ageSex(x) : `${x.name || 'no name'}, ${ageSex(x)}`)}`).join('<br>')}${list.length > 8 ? `<br>and ${list.length - 8} more` : ''}</div>`;
  }

  function renderClusterAreas() {
    clusterLayer.clearLayers();
    circleById.clear();
    if (!$('lyrClusters').checked) return;
    for (const c of state.clusters) {
      const active = c.status === 'Active';
      const sel = state.cl.selected === c.id;
      const col = active ? '#d9480f' : '#6c757d';
      const circle = L.circle([c.lat, c.lon], {
        pane: 'clusters', renderer: clusterRenderer,
        radius: Math.max(120, c.radius + 80),
        color: col, weight: sel ? 3 : 2, dashArray: sel ? null : '6 5',
        fillColor: col, fillOpacity: sel ? 0.16 : 0.07
      });
      circle.on('click', () => { showTab('clusters'); selectCluster(c.id, false); setTimeout(() => { const el = document.querySelector(`.cluster-card[data-id="${c.id}"]`); if (el) el.scrollIntoView({ block: 'nearest' }); }, 30); });
      circle.addTo(clusterLayer);
      circleById.set(c.id, circle);
    }
    renderClusterLabels();
  }

  // ID labels are made only for clusters inside the current view once zoomed in (or the selected
  // one), so hundreds of clusters do not mean hundreds of label elements.
  function renderClusterLabels() {
    clusterLabelLayer.clearLayers();
    if (!$('lyrClusters').checked || !state.clusters.length) return;
    const near = map.getZoom() >= 11;
    const view = map.getBounds().pad(0.1);
    let n = 0;
    for (const c of state.clusters) {
      const sel = state.cl.selected === c.id;
      if (!sel && (!near || !view.contains([c.lat, c.lon]) || n >= 300)) continue;
      n++;
      const active = c.status === 'Active';
      const rLat = Math.max(120, c.radius + 80) / 111320;
      L.tooltip({ permanent: true, direction: 'top', interactive: false, offset: [0, -2],
        className: `cluster-label${active ? ' active' : ''}${sel ? ' selected' : ''}` })
        .setLatLng([c.lat + rLat, c.lon]).setContent(`${c.id} · ${c.members.length}`).addTo(clusterLabelLayer);
    }
  }
  map.on('moveend', () => { if (state.data) renderClusterLabels(); });

  function renderHeat() {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (!$('lyrHeat').checked || typeof L.heatLayer !== 'function') return;
    const pts = state.filtered.filter((c) => c.lat !== null).map((c) => [c.lat, c.lon, 1]);
    heatLayer = L.heatLayer(pts, { pane: 'heat', radius: 22, blur: 18, maxZoom: 14, minOpacity: 0.3,
      gradient: { 0.2: '#ffffb2', 0.4: '#fecc5c', 0.6: '#fd8d3c', 0.8: '#f03b20', 1: '#bd0026' } }).addTo(map);
  }

  function renderLegend() {
    if (!state.data) { $('legendBox').innerHTML = ''; return; }
    const mapped = state.filtered.filter((c) => c.lat !== null && (!$('optOnlyClustered').checked || state.membership.has(c.uid)));
    let html = '';
    if ($('lyrCases').checked) {
      if (state.colorBy === 'disease') {
        const by = countBy(mapped, 'disease');
        html += '<h3>Cases</h3>' + ['Dengue', 'IP Fever'].filter((d) => by.has(d))
          .map((d) => `<div class="li"><span class="sw" style="background:${DISEASE_COLOR[d]}"></span>${d}<span class="n">${fmtN(by.get(d))}</span></div>`).join('');
      } else if (state.colorBy === 'recency') {
        const ref = refDay();
        const by = countBy(mapped, (c) => RECENCY.findIndex((r) => ref - eday(c) < r.max));
        html += `<h3>How recent (up to ${fmtShort(ref)})</h3>` + RECENCY.map((r, i) =>
          `<div class="li"><span class="sw" style="background:${r.color}"></span>${r.label}<span class="n">${fmtN(by.get(i) || 0)}</span></div>`).join('');
      } else {
        const inCl = mapped.filter((c) => state.membership.has(c.uid)).length;
        html += '<h3>Cases</h3>' +
          `<div class="li"><span class="sw" style="background:conic-gradient(${CLUSTER_PALETTE.slice(0, 6).join(',')})"></span>In a hotspot (one colour each)<span class="n">${fmtN(inCl)}</span></div>` +
          `<div class="li"><span class="sw" style="background:#9aa3a9"></span>Not in a hotspot<span class="n">${fmtN(mapped.length - inCl)}</span></div>`;
      }
    }
    if ($('lyrClusters').checked && state.clusters.length) {
      const act = state.clusters.filter((c) => c.status === 'Active').length;
      html += `${html ? '<div class="sep"></div>' : ''}<h3>Hotspots</h3>
        <div class="li"><span class="ring"></span>Active (case in last ${AN.activeWindow(state.cl.days)} days)<span class="n">${act}</span></div>
        <div class="li"><span class="ring closed"></span>Over<span class="n">${state.clusters.length - act}</span></div>`;
    }
    if ($('lyrHeat').checked) html += `${html ? '<div class="sep"></div>' : ''}<div class="li"><span class="sw" style="background:linear-gradient(90deg,#fecc5c,#bd0026);border-radius:3px;width:22px"></span>Case density (heatmap)</div>`;
    $('legendBox').innerHTML = html;
  }

  /* =================================================================
   * KPIs and summary
   * ================================================================= */
  function renderKpis() {
    if (!state.data) {
      $('kpis').innerHTML = [['cases', ''], ['Dengue', 'den'], ['IP Fever', 'ipf'], ['this week', ''], ['active hotspots', 'act']]
        .map(([k, c]) => `<div class="kpi ${c}"><dt>${k}</dt><dd>–</dd></div>`).join('');
      return;
    }
    const f = state.filtered;
    const by = countBy(f, 'disease');
    const ref = refDay();
    const last7 = f.filter((c) => eday(c) > ref - 7).length;
    const act = state.clusters.filter((c) => c.status === 'Active').length;
    $('kpis').innerHTML = `
      <div class="kpi" title="Cases shown on the map now"><dt>cases</dt><dd>${fmtN(f.length)}</dd></div>
      <div class="kpi den"><dt>Dengue</dt><dd>${fmtN(by.get('Dengue') || 0)}</dd></div>
      <div class="kpi ipf"><dt>IP Fever</dt><dd>${fmtN(by.get('IP Fever') || 0)}</dd></div>
      <div class="kpi" title="${fmtShort(ref - 6)} to ${fmtShort(ref)}"><dt>this week</dt><dd>${fmtN(last7)}</dd></div>
      <div class="kpi act" title="Hotspots with a case in the last ${AN.activeWindow(state.cl.days)} days"><dt>active hotspots</dt><dd>${act}</dd></div>`;
  }

  const charts = {};
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function renderSummary() {
    if (!state.data || $('panel-summary').hidden) return;
    const f = state.filtered;
    const ink2 = cssVar('--ink-2'), line = cssVar('--line');
    Chart.defaults.font.family = cssVar('--sans');
    Chart.defaults.color = ink2;

    // Weekly epicurve
    const wk = (d) => { const w = LL.isoWeek(d); return w.year * 100 + w.week; };
    const days = f.map(eday);
    const weeks = [];
    const counts = new Map(); // "disease|weekKey" -> cases, filled in one pass
    if (days.length) {
      const start = minOf(days), end = maxOf(days);
      let d = start - ((dt(start).getUTCDay() + 6) % 7);
      for (; d <= end; d += 7) weeks.push({ key: wk(d), monday: d });
      const mondayOf = (x) => x - ((dt(x).getUTCDay() + 6) % 7);
      const keyByMonday = new Map(weeks.map((w) => [w.monday, w.key]));
      f.forEach((c, i) => { const k = `${c.disease}|${keyByMonday.get(mondayOf(days[i]))}`; counts.set(k, (counts.get(k) || 0) + 1); });
    }
    const series = (dis) => weeks.map((w) => counts.get(`${dis}|${w.key}`) || 0);
    const epiData = {
      labels: weeks.map((w) => `W${w.key % 100}`),
      datasets: ['Dengue', 'IP Fever'].filter((d) => state.f.disease.has(d)).map((d) => ({
        label: d, data: series(d), backgroundColor: DISEASE_COLOR[d], borderWidth: 0, borderRadius: 2, maxBarThickness: 34
      }))
    };
    const epiOpts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { callbacks: { title: (items) => { const w = weeks[items[0].dataIndex]; return `Week ${w.key % 100}: ${fmtShort(w.monday)} – ${fmtShort(w.monday + 6)}`; } } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: line } } }
    };
    if (charts.epi) { charts.epi.data = epiData; charts.epi.options = epiOpts; charts.epi.update(); }
    else charts.epi = new Chart($('epiChart'), { type: 'bar', data: epiData, options: epiOpts });

    // Age and sex
    const groups = LL.AGE_GROUPS.filter((g) => f.some((c) => c.ageGroup === g));
    const ageData = {
      labels: groups,
      datasets: [['Male', '#3b7dd8'], ['Female', '#e07b39']].map(([s, col]) => ({
        label: s, data: groups.map((g) => f.filter((c) => c.ageGroup === g && c.sex === s).length), backgroundColor: col, borderRadius: 2, maxBarThickness: 22
      }))
    };
    const ageOpts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 10, boxHeight: 10 } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: line } } }
    };
    if (charts.age) { charts.age.data = ageData; charts.age.options = ageOpts; charts.age.update(); }
    else charts.age = new Chart($('ageChart'), { type: 'bar', data: ageData, options: ageOpts });

    // Block table
    const ref = refDay();
    const blocks = [...new Set(f.map((c) => c.block))].sort((a, b) => {
      const ia = BLOCK_ORDER.indexOf(a), ib = BLOCK_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const activeByBlock = countBy(state.clusters.filter((c) => c.status === 'Active'), (c) => c.blocks[0][0]);
    const row = (list) => ({
      den: list.filter((c) => c.disease === 'Dengue').length,
      ipf: list.filter((c) => c.disease === 'IP Fever').length,
      tot: list.length,
      l7: list.filter((c) => eday(c) > ref - 7).length
    });
    const tot = row(f);
    $('blockTable').innerHTML = `<thead><tr><th>Block</th><th class="r">Dengue</th><th class="r">IP Fever</th><th class="r">Total</th><th class="r">Last 7 d</th><th class="r" title="Active clusters">Active cl.</th></tr></thead>
      <tbody>${blocks.map((b) => { const r = row(f.filter((c) => c.block === b)); const a = activeByBlock.get(b) || 0;
        return `<tr><td>${esc(b)}</td><td class="r den">${r.den || ''}</td><td class="r ipf">${r.ipf || ''}</td><td class="r"><b>${r.tot}</b></td><td class="r">${r.l7 || ''}</td><td class="r ${a ? 'act' : ''}">${a || ''}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="r den">${tot.den}</td><td class="r ipf">${tot.ipf}</td><td class="r">${tot.tot}</td><td class="r">${tot.l7}</td><td class="r">${state.clusters.filter((c) => c.status === 'Active').length}</td></tr></tfoot>`;

    // Places
    const byPlace = new Map();
    f.forEach((c) => {
      const k = c.village || c.localBody;
      if (!byPlace.has(k)) byPlace.set(k, { place: k, block: c.block, n: 0, l7: 0, den: 0 });
      const p = byPlace.get(k);
      p.n++; if (eday(c) > ref - 7) p.l7++; if (c.disease === 'Dengue') p.den++;
    });
    const top = [...byPlace.values()].sort((a, b) => b.n - a.n || b.l7 - a.l7).slice(0, 12);
    $('placeTable').innerHTML = `<thead><tr><th>Place</th><th>Block</th><th class="r">Cases</th><th class="r">Dengue</th><th class="r">Last 7 d</th></tr></thead>
      <tbody>${top.map((p) => `<tr><td>${esc(p.place)}</td><td>${esc(p.block)}</td><td class="r"><b>${p.n}</b></td><td class="r den">${p.den || ''}</td><td class="r">${p.l7 || ''}</td></tr>`).join('')}</tbody>`;

    // Conditions
    const byCond = [...countBy(f, (c) => `${c.disease}|${c.condition}`).entries()].sort((a, b) => b[1] - a[1]);
    $('condTable').innerHTML = `<thead><tr><th>Disease</th><th>Result / condition</th><th class="r">Cases</th></tr></thead>
      <tbody>${byCond.map(([k, n]) => { const [d, c] = k.split('|'); return `<tr><td class="${d === 'Dengue' ? 'den' : 'ipf'}">${esc(d)}</td><td>${esc(c)}</td><td class="r">${n}</td></tr>`; }).join('')}</tbody>`;
  }

  /* =================================================================
   * Data quality
   * ================================================================= */
  function renderQuality() {
    if (!state.data) return;
    const d = state.data;
    $('fileList').innerHTML = state.files.map((file) => {
      const sh = d.sheets.filter((s) => s.file === file.name);
      const sk = d.skipped.filter((s) => s.file === file.name);
      return `<li><b>${esc(file.name)}</b>
        ${sh.map((s) => `<span>Sheet "${esc(s.sheet)}": ${fmtN(s.rows)} ${s.disease} cases${s.datesCorrected ? ` · ${fmtN(s.datesCorrected)} dates put right` : ''}${s.missing && s.missing.length ? `<br><em class="miss">Columns not found: ${esc(s.missing.join(', '))}</em>` : ''}</span>`).join('<br>')}
        ${sk.length ? `<br><span>Not used: ${sk.map((s) => `"${esc(s.sheet)}" (${esc(s.reason)})`).join(', ')}</span>` : ''}</li>`;
    }).join('') + (d.exactDupes ? `<li><span>${d.exactDupes} rows that appeared in two files were counted once.</span></li>` : '');

    const byType = new Map();
    d.issues.forEach((i) => {
      if (!byType.has(i.type)) byType.set(i.type, { type: i.type, severity: i.severity, n: 0 });
      byType.get(i.type).n++;
    });
    const types = [...byType.values()].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.n - a.n);
    const serious = d.issues.filter((i) => i.severity === 'high' || i.severity === 'medium').length;
    $('qaBadge').textContent = serious || '';
    if (!types.length) {
      $('qaSummary').innerHTML = '<div class="qa-ok">Nothing to correct. All rows look fine.</div>';
      $('qaList').innerHTML = '';
      return;
    }
    $('qaSummary').innerHTML = types.map((t) => `<button type="button" class="qa-row" data-type="${esc(t.type)}" aria-pressed="${state.qaType === t.type}">
        <i class="sev-${t.severity}" title="${SEV_LABEL[t.severity]}"></i><span>${esc(plainIssue(t.type))}</span><span class="n">${fmtN(t.n)}</span></button>`).join('') +
      `<div class="qa-legend">${Object.entries(SEV_LABEL).map(([k, v]) => `<span><i class="sev-${k}"></i>${v}</span>`).join('')}</div>`;
    $('qaSummary').querySelectorAll('.qa-row').forEach((b) => b.addEventListener('click', () => {
      state.qaType = state.qaType === b.dataset.type ? null : b.dataset.type;
      renderQuality();
    }));
    const list = state.qaType ? d.issues.filter((i) => i.type === state.qaType).sort((a, b) => (a.day ?? 0) - (b.day ?? 0)) : [];
    $('qaList').innerHTML = list.slice(0, 400).map((i) => `<li><button type="button" data-uid="${i.uid}">
        <span class="t">Row ${i.row} of "${esc(i.sheet)}" · ${esc(state.privacy ? i.disease : (i.name || 'no name'))} · ${fmtShort(i.day)}</span>
        <span class="m">${esc(i.detail)}</span></button></li>`).join('');
    $('qaList').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => focusCase(+b.dataset.uid)));
  }

  function focusCase(uid) {
    const c = state.data.cases.find((x) => x.uid === uid);
    if (!c) return;
    if (c.lat === null) { toast('This record has no usable coordinates, so it cannot be shown on the map.'); return; }
    showTab(null);
    userMoved = true;
    map.setView([c.lat, c.lon], Math.max(map.getZoom(), 15));
    const m = markerByUid.get(uid);
    if (m) { m.openPopup(); return; }
    L.popup({ maxWidth: 320 }).setLatLng([c.lat, c.lon]).setContent(popupHtml(c) + '<div class="flag">This case is hidden by the current filters.</div>').openOn(map);
  }

  /* =================================================================
   * Export
   * ================================================================= */
  const stamp = () => { const n = new Date(); return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; };
  function sheetFrom(rows) {
    const ws = XLSX.utils.json_to_sheet(rows);
    if (rows.length) ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(40, Math.max(k.length, ...rows.slice(0, 200).map((r) => String(r[k] ?? '').length)) + 2) }));
    return ws;
  }
  function caseRow(c) {
    const r = {
      'Disease': c.disease, 'Lab result / condition': c.condition,
      'Case date': fmtXl(eday(c)), 'Date of reporting': fmtXl(c.reportDay ?? (c.disease === 'Dengue' ? c.day : null)),
      'Date of admission': fmtXl(c.admDay), 'Date of onset': fmtXl(c.onsetDay)
    };
    if (!state.privacy) r['Name'] = c.name;
    Object.assign(r, { 'Age': c.ageLabel, 'Age group': c.ageGroup, 'Sex': c.sex });
    if (!state.privacy) { r['Phone'] = c.phones.join(', '); r['Address'] = c.address; }
    Object.assign(r, {
      'Block': c.block, 'Health block': c.healthBlock || '', 'PHC': c.phc, 'HSC': c.hsc, 'Area type': c.areaType,
      'Local body': c.localBody, 'Ward': c.ward, 'Habitation / street': c.habitation, 'Hospital': c.hospital,
      'SSH / OVF': c.source, 'Village (from location)': c.village || '', 'Inside HUD': c.inHud ? 'Yes' : 'No',
      'Latitude': c.lat, 'Longitude': c.lon, 'Cluster': state.membership.get(c.uid) || '',
      'Data-quality flags': c.flags.join('; '), 'Source file': c.file, 'Sheet': c.sheet, 'Excel row': c.row
    });
    return r;
  }
  function exportCases() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFrom(state.filtered.map(caseRow)), 'Cases');
    XLSX.utils.book_append_sheet(wb, sheetFrom(filterSummaryRows()), 'Filters used');
    XLSX.writeFile(wb, `Attur_HUD_cases_${stamp()}.xlsx`);
  }
  function filterSummaryRows() {
    const f = state.f;
    const desc = (k) => (k === 'condition' && isDefaultFilter(k) ? 'IP Fever and Dengue only (default)'
      : f[k].size === f.all[k].size ? 'All' : [...f[k]].join(', ') || 'None');
    return [
      ['Period', `${fmtXl(f.from)} to ${fmtXl(f.to)}`], ['IP Fever dated by', BASIS_LABEL[f.basis]],
      ['Disease', desc('disease')], ['Lab result / condition', desc('condition')], ['Block', desc('block')], ['PHC', desc('phc')],
      ['Area type', desc('area')], ['Sex', desc('sex')], ['Age group', desc('age')], ['Dengue SSH / OVF', desc('source')],
      ['Only inside HUD', f.inHud ? 'Yes' : 'No'], ['Possible duplicates left out', f.noDup ? 'Yes' : 'No'],
      ['Fever cases already in dengue list left out', f.noFeverDengue ? 'Yes' : 'No'],
      ['Cluster method', 'ST-DBSCAN'], ['Cluster distance', `${state.cl.eps} m`], ['Cluster time window', AN.windowText(state.cl.days)],
      ['Minimum cases per cluster', state.cl.minPts], ['Diseases clustered', state.cl.pooled ? 'Together' : 'Separately'],
      ['Status reference date', fmtXl(refDay())], ['Exported', new Date().toLocaleString('en-IN')]
    ].map(([k, v]) => ({ Setting: k, Value: v }));
  }
  function exportClusters() {
    const wb = XLSX.utils.book_new();
    const cl = state.clusters.map((c) => ({
      'Cluster': c.id, 'Disease': c.key === 'All' ? c.diseases.map(([d, n]) => `${d} ${n}`).join(', ') : c.key,
      'Status': c.status, 'New this week': c.isNew ? 'Yes' : '', 'Cases': c.members.length, 'Cases in last 7 days': c.recent7,
      'First case': fmtXl(c.first), 'Last case': fmtXl(c.last), 'Span (days)': c.spanDays,
      'Radius (m)': Math.round(c.radius), 'Centre latitude': +c.lat.toFixed(6), 'Centre longitude': +c.lon.toFixed(6),
      'Blocks': c.blocks.map(([b, n]) => `${b} (${n})`).join(', '), 'Places': c.places.map(([p, n]) => `${p} (${n})`).join(', ')
    }));
    const mem = [];
    state.clusters.forEach((c) => c.members.forEach((m) => mem.push({ 'Cluster': c.id, ...caseRow(m) })));
    XLSX.utils.book_append_sheet(wb, sheetFrom(cl.length ? cl : [{ Note: 'No clusters with the current settings' }]), 'Clusters');
    XLSX.utils.book_append_sheet(wb, sheetFrom(mem.length ? mem : [{ Note: 'No clusters' }]), 'Cluster members');
    XLSX.utils.book_append_sheet(wb, sheetFrom(filterSummaryRows()), 'Settings');
    XLSX.writeFile(wb, `Attur_HUD_clusters_${stamp()}.xlsx`);
  }
  function exportIssues() {
    const rows = state.data.issues.slice().sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.type.localeCompare(b.type) || a.row - b.row)
      .map((i) => {
        const r = { 'Level': SEV_LABEL[i.severity], 'Problem': plainIssue(i.type), 'Detail': i.detail, 'Disease': i.disease, 'File': i.file, 'Sheet': i.sheet, 'Excel row': i.row, 'Case date': fmtXl(i.day) };
        if (!state.privacy) r['Name'] = i.name;
        return r;
      });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFrom(rows.length ? rows : [{ Note: 'No issues found' }]), 'Data-quality issues');
    XLSX.writeFile(wb, `Attur_HUD_data_quality_${stamp()}.xlsx`);
  }
  async function downloadTemplate() {
    // Prefer the formatted template (dropdowns, text date columns, auto Month / Week) shipped with the app.
    try {
      const res = await fetch('template/Attur_HUD_line_list_template.xlsx', { cache: 'no-cache' });
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url; a.download = 'Attur_HUD_line_list_template.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return;
      }
    } catch (e) { /* opened from disk: fall back to a plain template */ }
    const wb = XLSX.utils.book_new();
    Object.entries(LL.TEMPLATE).forEach(([name, headers]) => {
      const ws = XLSX.utils.aoa_to_sheet([headers]);
      ws['!cols'] = headers.map((h) => ({ wch: Math.max(12, Math.min(34, h.length + 2)) }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    const notes = [
      ['How to fill this workbook'],
      ['1. One row per case. Keep the column headings exactly as they are; column order does not matter.'],
      ['2. IP Fever cases go in the "Fever" sheet, confirmed dengue cases in the "DENGUE" sheet. Separate files for each are also accepted.'],
      ['3. Dates: type them as DD-MM-YYYY (for example 03-09-2026). The map also reads real Excel dates.'],
      ['4. Fill Month and Week NO: they are used to check the dates.'],
      ['5. Latitude and longitude in decimal degrees with at least 5 decimal places (for example 11.59782 and 78.60303). Do not swap them.'],
      ['6. Disease condition (Fever sheet): write "Fever", or the positive result, e.g. "Leptospirosis Positive", "H1N1 Positive", "Rapid NS1 Positive".'],
      ['7. Type of Test (DENGUE sheet): e.g. "Dengue IgM Elisa Positive" or "Dengue NS1 Elisa Positive".'],
      ['8. Block: use the usual block names (Attur, Attur Mpty, Narasingapuram Mpty, Ayothiyapattinam, Gangavalli, Panamarathupatti, Pethanaickenpalayam, Thalaivasal, Valapadi, Yercaud).']
    ];
    const ws = XLSX.utils.aoa_to_sheet(notes);
    ws['!cols'] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Instructions');
    XLSX.writeFile(wb, 'Attur_HUD_line_list_template.xlsx');
  }
  $('btnTemplate').addEventListener('click', downloadTemplate);
  $('btnTemplate2').addEventListener('click', downloadTemplate);
  $('btnExport').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('exportMenu').hidden;
    $('exportMenu').hidden = !open;
    $('btnExport').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', () => { $('exportMenu').hidden = true; $('btnExport').setAttribute('aria-expanded', 'false'); });
  $('exportMenu').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.export === 'template') { downloadTemplate(); return; }
    if (!state.data) return;
    if (b.dataset.export === 'pptx') { window.AtturReport.open(); return; }
    ({ cases: exportCases, clusters: exportClusters, issues: exportIssues })[b.dataset.export]();
  }));

  /* =================================================================
   * Tabs, layers, privacy
   * ================================================================= */
  // 'summary' opens the Charts drawer, 'quality' the Data check drawer; anything else closes both.
  // The hotspot list is always in the sidebar.
  function showTab(name) {
    $('panel-summary').hidden = name !== 'summary';
    $('panel-quality').hidden = name !== 'quality';
    $('chartsBtn').setAttribute('aria-pressed', String(name === 'summary'));
    $('btnQuality').setAttribute('aria-pressed', String(name === 'quality'));
    if (name === 'summary') renderSummary();
  }
  $('chartsBtn').addEventListener('click', () => showTab($('panel-summary').hidden ? 'summary' : null));
  $('btnQuality').addEventListener('click', () => showTab($('panel-quality').hidden ? 'quality' : null));
  $('chartsClose').addEventListener('click', () => showTab(null));
  $('qualityClose').addEventListener('click', () => showTab(null));

  // More filters: a pop-up under its button.
  const setMore = (open) => { $('moreFilters').hidden = !open; $('moreBtn').setAttribute('aria-expanded', String(open)); };
  $('moreBtn').addEventListener('click', (e) => { e.stopPropagation(); setMore($('moreFilters').hidden); });
  $('moreDone').addEventListener('click', () => setMore(false));
  $('moreFilters').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => setMore(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMore(false); showTab(null); } });

  // The hotspot rule sits behind a small "Rule" link.
  const setRule = (open) => {
    $('ruleBox').hidden = !open;
    $('ruleToggle').setAttribute('aria-expanded', String(open));
    $('ruleToggle').textContent = open ? 'Hide rule' : 'Rule';
  };
  $('ruleToggle').addEventListener('click', () => setRule($('ruleBox').hidden));

  $('layerToggle').addEventListener('click', () => {
    const body = $('layerBody');
    body.hidden = !body.hidden;
    $('layerToggle').setAttribute('aria-expanded', String(!body.hidden));
  });
  const layerToggle = (id, layer) => $(id).addEventListener('change', (e) => { e.target.checked ? layer.addTo(map) : map.removeLayer(layer); });
  layerToggle('lyrHud', hudLayer);
  layerToggle('lyrBlocks', blockLayer);
  layerToggle('lyrVillages', villageLayer);

  // Village name on hover. The case points are drawn on a canvas above the village borders, which
  // would swallow ordinary hover events, so the village under the cursor is looked up instead.
  const villageHover = L.layerGroup().addTo(map);
  const villageTip = L.tooltip({ direction: 'right', offset: [16, 0], className: 'village-tip', interactive: false });
  let hoverFeature = null, hoverFrame = 0, lastMove = null;
  const clearVillageHover = () => { hoverFeature = null; villageHover.clearLayers(); map.closeTooltip(villageTip); };
  function showVillageHover() {
    hoverFrame = 0;
    if (!lastMove || !$('lyrVillages').checked) { clearVillageHover(); return; }
    const { lat, lng } = lastMove;
    const f = geo.locateFeature(lng, lat);
    if (!f) { clearVillageHover(); return; }
    if (f !== hoverFeature) {
      hoverFeature = f;
      villageHover.clearLayers();
      L.geoJSON(f, { pane: 'focus', interactive: false, style: { color: '#0e6e5f', weight: 3, fill: true, fillColor: '#0e6e5f', fillOpacity: 0.06 } }).addTo(villageHover);
      const p = f.properties;
      const n = state.data ? state.filtered.filter((c) => String(c.villageLgd) === String(p.village_lgd)).length : null;
      const kind = p.unit_type === 'Revenue Village' ? 'Village' : p.unit_type;
      villageTip.setContent(`<b>${esc(p.village_name)}</b><br><span>${esc(kind)} · ${esc(LINE_LIST_NAME[p.health_block] || p.health_block)} block${n === null ? '' : ` · ${n} case${n === 1 ? '' : 's'} shown`}</span>`);
    }
    villageTip.setLatLng(lastMove);
    if (!map.hasLayer(villageTip)) villageTip.addTo(map);
  }
  map.on('mousemove', (e) => { lastMove = e.latlng; if (!hoverFrame) hoverFrame = setTimeout(showVillageHover, 30); });
  map.on('mouseout', () => { lastMove = null; clearVillageHover(); });
  $('lyrVillages').addEventListener('change', (e) => { if (!e.target.checked) clearVillageHover(); });
  layerToggle('lyrLabels', labelLayer);
  $('lyrCases').addEventListener('change', () => { renderCases(); renderStacks(); renderLegend(); });
  $('optOnlyClustered').addEventListener('change', () => { if (state.data) { renderCases(); renderStacks(); renderLegend(); } });
  $('lyrClusters').addEventListener('change', () => { renderClusterAreas(); renderLegend(); });
  $('lyrHeat').addEventListener('change', () => { renderHeat(); renderLegend(); });
  document.querySelectorAll('input[name="colorBy"]').forEach((r) => r.addEventListener('change', () => { state.colorBy = r.value; if (state.data) { renderCases(); renderLegend(); } }));
  function setBasemap(key) {
    state.basemap = key;
    if (currentBase) map.removeLayer(currentBase);
    currentBase = basemaps[key] ? basemaps[key].addTo(map) : null;
    $('map').classList.toggle('nobase', !currentBase);
    store.set('basemap', key);
  }
  document.querySelectorAll('input[name="base"]').forEach((r) => r.addEventListener('change', () => setBasemap(r.value)));
  const savedBase = store.get('basemap', 'osm');
  if (savedBase !== 'osm' && $({ hot: 'baseHot', none: 'baseNone' }[savedBase])) { $({ hot: 'baseHot', none: 'baseNone' }[savedBase]).checked = true; setBasemap(savedBase); }

  state.pointSize = store.get('pointSize', 8);
  const syncPointSize = () => {
    $('ptSize').value = state.pointSize; $('ptSizeVal').textContent = `${state.pointSize} px`;
    const opts = [...document.querySelectorAll('input[name="ptSizeSel"]')];
    const nearest = opts.reduce((a, b) => (Math.abs(+b.value - state.pointSize) < Math.abs(+a.value - state.pointSize) ? b : a), opts[0]);
    if (nearest) nearest.checked = true;
  };
  syncPointSize();
  document.querySelectorAll('input[name="ptSizeSel"]').forEach((r) => r.addEventListener('change', () => {
    state.pointSize = +r.value; syncPointSize(); store.set('pointSize', state.pointSize);
    if (state.data) renderCases();
  }));
  $('ptSize').addEventListener('input', (e) => {
    state.pointSize = +e.target.value; syncPointSize(); store.set('pointSize', state.pointSize);
    if (state.data) renderCases();
  });
  state.privacy = store.get('privacy', false);
  $('privacy').checked = state.privacy;
  $('privacy').addEventListener('change', (e) => {
    state.privacy = e.target.checked; store.set('privacy', state.privacy);
    map.closePopup();
    if (state.data) { renderClusterList(); renderQuality(); renderCases(); }
  });

  /* =================================================================
   * One area at a time (block, PHC, village or town)
   * ================================================================= */
  const MPTY_POLYGON = { 'Attur Mpty': 'Attur (M)', 'Narasingapuram Mpty': 'Narasingapuram (M)' };
  const villageByLgd = new Map(HUD.villages.features.map((f) => [String(f.properties.village_lgd), f]));

  function makeFocus(type, value) {
    let feature = null, label = value, areaKm2 = null;
    if (type === 'block') {
      if (MPTY_POLYGON[value]) {
        feature = HUD.villages.features.find((f) => f.properties.village_name === MPTY_POLYGON[value]);
        label = value.replace(/ Mpty$/, ' Municipality');
      } else {
        feature = HUD.blocks.features.find((f) => f.properties.health_block === LL.HEALTH_BLOCK[value]);
        label = `${value} block`;
      }
    } else if (type === 'village') {
      feature = villageByLgd.get(String(value));
      const p = feature.properties;
      label = p.unit_type === 'Revenue Village' ? `${p.village_name} village` : p.village_name;
    } else if (type === 'phc') {
      label = `${value} PHC`;
    }
    if (feature) areaKm2 = feature.properties.area_km2;
    return { type, value, label, feature, areaKm2, bounds: null };
  }
  const inFocus = (c, f) => (f.type === 'block' ? c.block === f.value : f.type === 'phc' ? c.phc === f.value : String(c.villageLgd) === String(f.value));

  function applyFocus() {
    const f = state.focus;
    if (!f) {
      state.filtered = state.baseFiltered;
      state.clusters = state.allClusters;
      state.contextCases = [];
      return;
    }
    state.filtered = state.baseFiltered.filter((c) => inFocus(c, f));
    const shown = new Set(state.filtered.map((c) => c.uid));
    state.clusters = state.allClusters.filter((c) => c.members.some((m) => shown.has(m.uid)));
    const byUid = new Map(state.baseFiltered.map((c) => [c.uid, c]));
    const extra = new Map();
    state.clusters.forEach((c) => c.members.forEach((m) => { if (!shown.has(m.uid)) extra.set(m.uid, byUid.get(m.uid)); }));
    state.contextCases = [...extra.values()].filter(Boolean);
    if (state.cl.selected && !state.clusters.some((c) => c.id === state.cl.selected)) state.cl.selected = null;
  }

  function drawFocus() {
    focusLayer.clearLayers();
    const f = state.focus;
    $('focusChip').hidden = !f;
    $('focusClear').hidden = !f;
    $('fitBtn').textContent = f ? 'Zoom to area' : 'Full HUD';
    if ($('focusSelect').options.length && $('focusSelect').value !== (f ? `${f.type}|${f.value}` : '')) renderFocusBlocks();
    document.querySelectorAll('#focusBlocks button').forEach((b) => b.setAttribute('aria-pressed',
      String((!!f && f.type === 'block' && f.value === b.dataset.v) || (!f && b.dataset.v === ''))));
    if (!f) { $('focusNote').textContent = ''; return; }
    $('focusChipText').textContent = f.label;
    $('focusChip').title = `${f.label}: ${f.type === 'village' ? 'cases whose location is inside this place' : f.type === 'block' ? 'cases with this block in the line list' : 'cases with this PHC in the line list'}`;
    if (f.feature) {
      // Fade everything outside the area with a world-sized polygon that has the area cut out.
      const polys = f.feature.geometry.type === 'Polygon' ? [f.feature.geometry.coordinates] : f.feature.geometry.coordinates;
      const holes = polys.map((p) => p[0].map(([x, y]) => [y, x]));
      L.polygon([[[-89, -179], [-89, 179], [89, 179], [89, -179]], ...holes], {
        pane: 'mask', interactive: false, stroke: false, fillColor: '#ffffff', fillOpacity: 0.55
      }).addTo(focusLayer);
      L.geoJSON(f.feature, { pane: 'focus', interactive: false, style: { color: '#0e6e5f', weight: 4, fill: false, opacity: 0.95 } }).addTo(focusLayer);
    }
    const n = state.filtered.length, ctx = state.contextCases.length;
    $('focusNote').textContent = (f.type === 'village' ? 'Cases whose location is inside this place.' : f.type === 'block' ? 'Cases with this block in the line list.' : 'Cases with this PHC in the line list.') +
      (ctx ? ` ${ctx} case${ctx === 1 ? '' : 's'} just outside ${ctx === 1 ? 'is' : 'are'} shown faded, as part of the same hotspot.` : '');
  }

  function setFocus(type, value) {
    state.focus = type ? makeFocus(type, value) : null;
    state.cl.selected = null;
    update();
    const f = state.focus;
    if (f) {
      let b = f.feature ? L.geoJSON(f.feature).getBounds() : null;
      const pts = state.filtered.filter((c) => c.lat !== null).map((c) => [c.lat, c.lon]);
      if (pts.length) b = b ? b.extend(L.latLngBounds(pts)) : L.latLngBounds(pts);
      f.bounds = b ? b.pad(0.05) : hudBounds;
    }
    drawFocus();
    userMoved = false;
    fitHud();
    renderLegend();
  }

  function renderFocusBlocks() {
    const by = countBy(state.data.cases, 'block');
    const names = BLOCK_ORDER.filter((b) => by.has(b)).concat([...by.keys()].filter((b) => !BLOCK_ORDER.includes(b) && b !== 'Not stated'));
    const f = state.focus;
    const label = (b) => (/ Mpty$/.test(b) ? b.replace(/ Mpty$/, ' Municipality') : `${b} block`);
    $('focusSelect').innerHTML = `<option value="">Whole Attur HUD</option>` +
      `<optgroup label="Blocks and municipalities">${names.map((b) => `<option value="block|${esc(b)}">${esc(label(b))} (${fmtN(by.get(b))} cases)</option>`).join('')}</optgroup>` +
      (f && f.type !== 'block' ? `<optgroup label="Chosen by search"><option value="${f.type}|${esc(f.value)}">${esc(f.label)}</option></optgroup>` : '');
    $('focusSelect').value = f ? `${f.type}|${f.value}` : '';
    $('focusBlocks').innerHTML = `<button type="button" data-v="" aria-pressed="${!state.focus}">Whole HUD</button>` +
      names.map((b) => `<button type="button" data-v="${esc(b)}" aria-pressed="${!!state.focus && state.focus.type === 'block' && state.focus.value === b}">${esc(b)} <span class="n">${fmtN(by.get(b))}</span></button>`).join('');
    $('focusBlocks').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => (b.dataset.v ? setFocus('block', b.dataset.v) : setFocus(null))));
  }

  // Search across PHCs (from the line list) and all 385 villages / towns (from the boundary layer).
  let focusMatches = [], focusActive = -1;
  function focusIndex() {
    const phc = countBy(state.data.cases, 'phc');
    const vil = countBy(state.data.cases.filter((c) => c.villageLgd !== null), (c) => String(c.villageLgd));
    return [...phc.entries()].filter(([n]) => n !== 'Not stated').map(([n, k]) => ({ type: 'phc', value: n, name: n, kind: 'PHC', n: k }))
      .concat(HUD.villages.features.map((f) => {
        const p = f.properties;
        return { type: 'village', value: String(p.village_lgd), name: p.village_name, kind: `${p.unit_type} · ${LINE_LIST_NAME[p.health_block] || p.health_block}`, n: vil.get(String(p.village_lgd)) || 0 };
      }));
  }
  function renderFocusResults() {
    const q = LL.norm($('focusSearch').value);
    if (!q || !state.data) { $('focusResults').hidden = true; return; }
    const rank = (r) => (LL.norm(r.name).startsWith(q) ? 0 : 1);
    focusMatches = focusIndex().filter((r) => LL.norm(r.name).includes(q))
      .sort((a, b) => rank(a) - rank(b) || b.n - a.n || a.name.localeCompare(b.name)).slice(0, 14);
    focusActive = focusMatches.length ? 0 : -1;
    $('focusResults').innerHTML = focusMatches.length ? focusMatches.map((r, i) => `<li><button type="button" data-i="${i}" class="${i === focusActive ? 'active' : ''}">
        <span>${esc(r.name)}</span><small>${r.n ? `${fmtN(r.n)} case${r.n === 1 ? '' : 's'}` : 'no cases'}</small><span class="kind">${esc(r.kind)}</span></button></li>`).join('')
      : '<li class="empty">No PHC, village or town matches that name.</li>';
    $('focusResults').hidden = false;
    $('focusResults').querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (e) => { e.preventDefault(); pickFocus(focusMatches[+b.dataset.i]); }));
  }
  function pickFocus(r) {
    if (!r) return;
    $('focusSearch').value = '';
    $('focusResults').hidden = true;
    setFocus(r.type, r.value);
  }
  $('focusSearch').addEventListener('input', renderFocusResults);
  $('focusSearch').addEventListener('focus', renderFocusResults);
  $('focusSearch').addEventListener('blur', () => { $('focusResults').hidden = true; });
  $('focusSearch').addEventListener('keydown', (e) => {
    if ($('focusResults').hidden || !focusMatches.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusActive = (focusActive + (e.key === 'ArrowDown' ? 1 : -1) + focusMatches.length) % focusMatches.length;
      $('focusResults').querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', i === focusActive));
    } else if (e.key === 'Enter') { e.preventDefault(); pickFocus(focusMatches[focusActive]); }
    else if (e.key === 'Escape') { $('focusResults').hidden = true; }
  });
  $('focusClear').addEventListener('click', () => setFocus(null));
  $('focusSelect').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) { setFocus(null); return; }
    const i = v.indexOf('|');
    setFocus(v.slice(0, i), v.slice(i + 1));
  });
  $('focusChipClear').addEventListener('click', () => setFocus(null));

  /* =================================================================
   * Update cycle
   * ================================================================= */
  function renderScope() {
    if (!state.data) return;
    const f = state.f;
    const dis = ['Dengue', 'IP Fever'].filter((d) => f.disease.has(d));
    const disTxt = dis.length === 2 ? 'Dengue and IP Fever' : dis.length ? dis[0] : 'No disease chosen';
    const area = state.focus ? state.focus.label : 'Whole HUD';
    const names = { 7: 'Last 7 days', 14: 'Last 14 days', 28: 'Last 28 days', month: 'This month', all: 'All dates' };
    const when = names[$('periodSelect').value] || 'Chosen dates';
    $('periodNote').textContent = `${fmtDay(f.from)} – ${fmtDay(f.to)}`;
    const extra = Object.keys(f.all).filter((k) => k !== 'disease' && !isDefaultFilter(k)).length +
      (f.inHud ? 0 : 1) + (f.noDup ? 0 : 1) + (f.noFeverDengue ? 1 : 0) + (f.basis !== 'report' ? 1 : 0);
    $('moreCount').textContent = extra ? `${extra} on` : '';
    $('scopeLine').innerHTML = `<b>${esc(disTxt)}</b> · <b>${esc(area)}</b> · <b>${when}</b> ` +
      `<span class="muted">${fmtShort(f.from)} – ${fmtDay(f.to)}${extra ? ` · ${extra} more filter${extra === 1 ? '' : 's'}` : ''}</span>`;
  }

  function update() {
    if (!state.data) { renderKpis(); return; }
    state.baseFiltered = applyFilters();
    runClusters();
    applyFocus();
    renderKpis();
    renderCases();
    renderStacks();
    renderClusterAreas();
    renderHeat();
    renderLegend();
    renderClusterStats();
    renderClusterList();
    renderSummary();
    drawFocus();
    renderScope();
  }

  /* ---------- Home: back to how the app looks when first opened ---------- */
  // Resets the view (area, filters, period, selection, hotspot rule, map layers and position).
  // Saved preferences are kept: background map, dot size and "Hide names".
  function goHome() {
    map.closePopup();
    const setBox = (id, on) => { const el = $(id); if (el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change')); } };
    [['lyrCases', true], ['lyrClusters', true], ['lyrHeat', false], ['optOnlyClustered', false], ['lyrHud', true],
      ['lyrBlocks', true], ['lyrVillages', false], ['lyrLabels', true]].forEach(([id, on]) => setBox(id, on));
    $('cbDisease').checked = true; state.colorBy = 'disease';
    $('layerBody').hidden = true; $('layerToggle').setAttribute('aria-expanded', 'false');

    Object.assign(state.cl, { eps: 400, days: 14, minPts: 3, pooled: false, status: 'all', sort: 'recent', selected: null });
    $('pooled0').checked = true;
    $('clusterSort').value = 'recent';
    document.querySelectorAll('#clusterStatusFilter button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === 'all')));
    syncClusterControls();
    store.set('cluster', { eps: 400, days: 14, minPts: 3, pooled: false });

    $('optInHud').checked = true; $('optNoDup').checked = true; $('optNoFeverDengue').checked = false;
    $('dateBasis').value = 'report';
    $('focusSearch').value = ''; $('focusResults').hidden = true;
    setMore(false);
    setRule(false);
    state.customPeriod = false;
    document.querySelectorAll('.inline-more').forEach((d) => { d.open = false; });
    state.focus = null;
    state.qaType = null;
    showTab(null);
    document.querySelectorAll('.panel').forEach((p) => { p.scrollTop = 0; });

    if (state.data) {
      initFilters();
      update();
      renderQuality();
    }
    userMoved = false;
    fitHud();
    if (state.data) toast('Back to the start: whole HUD, all dates, both diseases.');
  }
  $('homeBtn').addEventListener('click', goHome);

  /* ---------- Help ---------- */
  $('btnHelp').addEventListener('click', () => $('helpDialog').showModal());
  $('helpClose').addEventListener('click', () => $('helpDialog').close());
  $('helpOk').addEventListener('click', () => $('helpDialog').close());
  $('datasetChip').addEventListener('click', () => { $('fileInput').dataset.mode = 'replace'; $('fileInput').click(); });

  /* ---------- Shared with the PowerPoint builder (js/report.js) ---------- */
  window.AtturApp = {
    state, map, HUD, LL, hudBounds: () => hudBounds,
    eday, refDay, caseColor, ageSex, countBy, filterSummaryRows, toast,
    fmtDay, fmtShort, fmtXl, fmtN,
    DISEASE_COLOR, RECENCY, CLUSTER_PALETTE, BASIS_LABEL, BLOCK_ORDER, LINE_LIST_NAME, SEV_LABEL, SEV_ORDER,
    basemapInfo: () => ({
      osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: [''], label: 'OpenStreetMap' },
      hot: { url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'], label: 'OpenStreetMap Humanitarian' }
    })[state.basemap] || null,
    layerOn: (id) => $(id).checked,
    areaBounds, focusGeometry: () => (state.focus && state.focus.feature ? state.focus.feature.geometry : null),
    areaLabel: () => (state.focus ? state.focus.label : 'Attur HUD')
  };

  /* ---------- Start ---------- */
  const savedCl = store.get('cluster', null);
  if (savedCl) Object.assign(state.cl, savedCl);
  if (![...$('days').options].some((o) => +o.value === state.cl.days)) state.cl.days = 14;   // e.g. the removed "at any time"
  $(state.cl.pooled ? 'pooled1' : 'pooled0').checked = true;
  syncClusterControls();
  renderKpis();
  (async () => {
    if (!$('optRemember').checked) return;
    try {
      const saved = await IDB.get('files');
      if (saved && saved.length) processFiles(saved);
    } catch (e) { /* no saved data */ }
  })();
})();
