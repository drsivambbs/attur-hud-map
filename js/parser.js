/*
 * Line-list parser for the Attur HUD fever / dengue workbook.
 *
 * Standard format: one sheet of IP Fever cases ("Fever") and one of Dengue cases ("DENGUE"),
 * one row per case, with the column headings used in the department's line list. Columns are
 * matched by their heading text, so column order and small wording changes do not matter.
 *
 * Everything here runs in the browser; nothing is sent anywhere.
 */
(function (global) {
  'use strict';

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];

  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const ACRONYMS = /\b(gh|ghs|gmkmch|uphc|phc|chc|uhc|hsc|sks|dhqh|dsimsh|dsmch|gemch|ohf|nh|mr|pnp|tp|vp|ssh|ovf|kmch|esi|idsp|dphl|jipmer|dh|sdh)\b/gi;
  const titleCase = (s) => clean(String(s ?? '').replace(/,/g, ' ')).toLowerCase()
    .replace(/(^|[\s(./-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
    .replace(ACRONYMS, (m) => m.toUpperCase());

  /* ---------- Column recognition ---------- */
  // Order matters: each heading is claimed by the first rule that matches it.
  const FIELD_RULES = [
    ['report_date', (h) => /dateofreporting|reportingdate|dateofreport|reporteddate|dateofnotification/.test(h)],
    ['adm_date', (h) => /dateofadmission|admissiondate/.test(h)],
    ['onset_date', (h) => /onset/.test(h)],
    ['date', (h) => /^date$|^dateofdiagnosis$|^diagnosisdate$|^testdate$|^dateoftest$|^dateofsample|^sampledate|^resultdate|^dateofresult|^casedate$/.test(h)],
    ['rep_district', (h) => /reportingssh|reportingdistrict/.test(h)],
    ['name', (h) => /^name$|^patientname$|^nameofthepatient$|^nameofpatient$|^ptname$|^patient$|^casename$/.test(h)],
    ['age', (h) => /^age/.test(h)],
    ['sex', (h) => /^sex|^gender/.test(h)],
    ['address', (h) => /address/.test(h)],
    ['hud', (h) => /hud$|^hud/.test(h)],
    ['block', (h) => /block/.test(h)],
    ['phc', (h) => /phc|^healthcentre|^healthcenter/.test(h)],
    ['phone', (h) => /contact|mobile|phone|cellno/.test(h)],
    ['condition', (h) => /diseasecondition|^disease$|^condition$/.test(h)],
    ['test', (h) => /typeoftest|^test/.test(h)],
    ['hospital', (h) => /hospital|institution|placeofdiagnosis/.test(h)],
    ['area_type', (h) => /^mptytpvp$|^vptpmpty$|areatype|localbodytype/.test(h)],
    ['local_body', (h) => /localbody|villagepanchayat|^nameofthevillage|^village$/.test(h)],
    ['ward', (h) => /ward/.test(h)],
    ['habitation', (h) => /habitation|street|hamlet/.test(h)],
    ['hsc', (h) => /hsc|subcentre|subcenter/.test(h)],
    ['month', (h) => /^month$/.test(h)],
    ['week', (h) => /^week/.test(h)],
    ['source', (h) => /sshovf|^ovf|^ssh/.test(h)],
    ['latlon', (h) => /^(gps|gpscoordinates|coordinates|coordinate|latlong|latlng|latlon|latitudelongitude|lattitudelongitude|location|geolocation|geotag)$/.test(h)],
    ['lat', (h) => /^lat|latitude|lattitude/.test(h)],
    ['lon', (h) => /^long|^lng|^lon|longitude/.test(h)],
    ['outcome', (h) => /outcome/.test(h)],
    ['remarks', (h) => /remark/.test(h)]
  ];

  function mapHeaders(row) {
    const map = {};
    row.forEach((cell, idx) => {
      const h = norm(cell);
      if (!h) return;
      for (const [field, test] of FIELD_RULES) {
        if (map[field] === undefined && test(h)) { map[field] = idx; break; }
      }
    });
    return map;
  }

  function findHeaderRow(rows) {
    let best = { idx: -1, map: {}, score: 0 };
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const map = mapHeaders(rows[i] || []);
      const score = Object.keys(map).length;
      if (score > best.score) best = { idx: i, map, score };
    }
    const m = best.map, hasCoords = (m.lat !== undefined && m.lon !== undefined) || m.latlon !== undefined;
    return best.score >= 5 || (best.score >= 3 && hasCoords) ? best : null;
  }

  function classifySheet(sheetName, map, fileName) {
    const n = norm(sheetName), f = norm(fileName);
    if (/dengue|^den/.test(n)) return 'Dengue';
    if (/fever|ipf|^ip/.test(n)) return 'IP Fever';
    if (map.test !== undefined && map.condition === undefined) return 'Dengue';
    if (map.condition !== undefined) return 'IP Fever';
    const dengueFile = /dengue/.test(f), feverFile = /fever|ipf/.test(f);
    if (dengueFile && !feverFile) return 'Dengue';
    if (feverFile && !dengueFile) return 'IP Fever';
    return null;
  }

  /* ---------- Coordinates ---------- */
  // Accepts decimal degrees (11.59782), text with hemisphere letters (11.59782 N) and
  // degrees-minutes-seconds (11°35'52.2"N or 11 35 52.2 N).
  function parseCoord(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v;
    const s = String(v).trim().toUpperCase().replace(/,/g, '.');
    const neg = /[SW]/.test(s) || /^-/.test(s);
    if (/[°º′'"″]|\d\s+\d+\s+\d/.test(s)) {
      const parts = s.match(/\d+(?:\.\d+)?/g) || [];
      if (!parts.length) return NaN;
      const val = +parts[0] + (+(parts[1] || 0)) / 60 + (+(parts[2] || 0)) / 3600;
      return neg ? -val : val;
    }
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
    return neg && n > 0 ? -n : n;
  }
  // One cell holding both values: "11.59782, 78.60303", "11.59782 78.60303" or "11°35'52\"N 78°36'11\"E".
  function parseLatLon(v) {
    if (v === null || v === undefined || v === '') return [NaN, NaN];
    const s = String(v).trim();
    let parts = s.split(/(?<=[NSns])[\s,;]+|[;,]\s*|\s{2,}|\s+(?=-?\d+\.\d+\s*[EeWw]?$)/).filter(Boolean);
    if (parts.length < 2) parts = s.split(/\s+/);
    if (parts.length < 2) return [NaN, NaN];
    return [parseCoord(parts[0]), parseCoord(parts.slice(1).join(' '))];
  }
  const numericLike = (v) => typeof v === 'number' || /^\s*-?\d+(\.\d+)?\s*$/.test(String(v ?? ''));

  /* ---------- Dates ---------- */
  const valid = (y, m, d) => {
    if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  };
  const toDay = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000); // days since epoch (UTC)

  // Returns the possible readings of a raw cell. Excel cells typed as DD-MM in a month-first
  // locale are stored with day and month exchanged, so a stored date also offers its swap.
  function dateCandidates(v) {
    if (v === null || v === undefined || v === '') return { kind: 'empty', c: [] };
    if (typeof v === 'number' && global.XLSX) {
      const p = global.XLSX.SSF.parse_date_code(v);
      if (!p) return { kind: 'bad', c: [] };
      const c = [];
      if (valid(p.y, p.m, p.d)) c.push({ y: p.y, m: p.m, d: p.d, swapped: false });
      if (p.d <= 12 && p.d !== p.m && valid(p.y, p.d, p.m)) c.push({ y: p.y, m: p.d, d: p.m, swapped: true });
      return { kind: 'cell', c };
    }
    if (v instanceof Date && !isNaN(v)) {
      const y = v.getFullYear(), m = v.getMonth() + 1, d = v.getDate();
      const c = [{ y, m, d, swapped: false }];
      if (d <= 12 && d !== m) c.push({ y, m: d, d: m, swapped: true });
      return { kind: 'cell', c };
    }
    const s = clean(v).replace(/[\sT]+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '');
    const mon = (t) => { const k = t.toLowerCase().slice(0, 3); const i = MONTHS.findIndex((x) => x.startsWith(k)); return i >= 0 ? i + 1 : 0; };
    let mm = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([A-Za-z]{3,9})[\s\-/.,]*(\d{2,4})$/);
    if (mm && mon(mm[2])) {
      let y = +mm[3]; if (y < 100) y += 2000;
      return valid(y, mon(mm[2]), +mm[1]) ? { kind: 'text', c: [{ y, m: mon(mm[2]), d: +mm[1], swapped: false }] } : { kind: 'bad', c: [] };
    }
    mm = s.match(/^([A-Za-z]{3,9})[\s\-/.]*(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.]*(\d{2,4})$/);
    if (mm && mon(mm[1])) {
      let y = +mm[3]; if (y < 100) y += 2000;
      return valid(y, mon(mm[1]), +mm[2]) ? { kind: 'text', c: [{ y, m: mon(mm[1]), d: +mm[2], swapped: false }] } : { kind: 'bad', c: [] };
    }
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      return valid(y, mo, d) ? { kind: 'text', c: [{ y, m: mo, d, swapped: false }] } : { kind: 'bad', c: [] };
    }
    m = s.match(/^(\d{1,2})[-/.\s](\d{1,2})[-/.\s](\d{2,4})$/);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      const d = +m[1], mo = +m[2];
      return valid(y, mo, d) ? { kind: 'text', c: [{ y, m: mo, d, swapped: false }] } : { kind: 'bad', c: [] };
    }
    return { kind: 'bad', c: [] };
  }

  function isoWeek(day) {
    const dt = new Date(day * 86400000);
    const dow = (dt.getUTCDay() + 6) % 7; // Mon=0
    const thu = new Date(dt); thu.setUTCDate(dt.getUTCDate() - dow + 3);
    const firstThu = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
    const fdow = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - fdow + 3);
    return { year: thu.getUTCFullYear(), week: 1 + Math.round((thu - firstThu) / 604800000) };
  }

  // Resolves every date in one column. Each row's own Month / Week cell decides between the
  // two readings of a stored date; rows without a hint follow the column's majority reading.
  function resolveDateColumn(raws, monthHints, weekHints) {
    const parsed = raws.map(dateCandidates);
    const pick = new Array(raws.length).fill(null);
    let votesSwap = 0, votesKeep = 0;
    parsed.forEach((p, i) => {
      if (!p.c.length) return;
      if (p.c.length === 1) {
        pick[i] = p.c[0];
        if (p.kind === 'text') votesSwap += 0.25; // text DD-MM entry hints that cells were typed DD-MM too
        return;
      }
      const mh = monthHints[i], wh = weekHints[i];
      let chosen = null;
      if (mh) chosen = p.c.find((c) => c.m === mh) || null;
      if (!chosen && wh) chosen = p.c.find((c) => isoWeek(toDay(c.y, c.m, c.d)).week === wh) || null;
      if (chosen) { pick[i] = chosen; chosen.swapped ? votesSwap++ : votesKeep++; }
    });
    const preferSwap = votesSwap > votesKeep;
    parsed.forEach((p, i) => {
      if (pick[i] || p.c.length < 2) return;
      pick[i] = p.c.find((c) => c.swapped === preferSwap) || p.c[0];
    });
    return parsed.map((p, i) => ({
      day: pick[i] ? toDay(pick[i].y, pick[i].m, pick[i].d) : null,
      swapped: !!(pick[i] && pick[i].swapped),
      bad: p.kind === 'bad',
      raw: raws[i]
    }));
  }

  /* ---------- Field cleaners ---------- */
  function parseAge(v) {
    if (v === null || v === undefined || v === '') return { years: null, label: '' };
    if (typeof v === 'number') return { years: v, label: String(v) };
    const s = clean(v).toLowerCase();
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    if (isNaN(n)) return { years: null, label: clean(v) };
    if (/d/.test(s) && !/mon|m\b/.test(s.replace(/days?/, ''))) return { years: n / 365, label: `${n} days` };
    if (/mon|mth|m\b|m$/.test(s)) return { years: n / 12, label: `${n} months` };
    return { years: n, label: String(n) };
  }

  function parseSex(v) {
    const s = norm(v);
    if (!s || /^\d+$/.test(s)) return { sex: 'Unknown', child: false };
    const child = /ch|^[mf]c$/.test(s);
    if (s[0] === 'f' || s.startsWith('w')) return { sex: 'Female', child };
    if (s[0] === 'm' || s.startsWith('b')) return { sex: 'Male', child };
    return { sex: 'Unknown', child: false };
  }

  function ageGroup(y) {
    if (y === null || y === undefined || isNaN(y)) return 'Unknown';
    if (y < 1) return '<1';
    if (y < 5) return '1–4';
    if (y < 15) return '5–14';
    if (y < 30) return '15–29';
    if (y < 45) return '30–44';
    if (y < 60) return '45–59';
    return '60+';
  }
  const AGE_GROUPS = ['<1', '1–4', '5–14', '15–29', '30–44', '45–59', '60+', 'Unknown'];

  // Blocks as the line list names them (revenue-block names plus the two municipalities).
  const BLOCK_ALIASES = {
    attur: 'Attur',
    atturmpty: 'Attur Mpty', atturmunicipality: 'Attur Mpty', atturm: 'Attur Mpty',
    narasingapurammpty: 'Narasingapuram Mpty', narasingapurammunicipality: 'Narasingapuram Mpty', narasingapuram: 'Narasingapuram Mpty',
    ayothiyapattinam: 'Ayothiyapattinam', ayyothiyapattinam: 'Ayothiyapattinam', ayodhiyapattinam: 'Ayothiyapattinam', ayothiapattinam: 'Ayothiyapattinam',
    gangavalli: 'Gangavalli', thammampatti: 'Gangavalli', thammampatty: 'Gangavalli',
    panamarathupatti: 'Panamarathupatti', panamrathupatti: 'Panamarathupatti', panamarathupatty: 'Panamarathupatti', panaimarathupatti: 'Panamarathupatti',
    pethanaickenpalayam: 'Pethanaickenpalayam', peddanaickenpalayam: 'Pethanaickenpalayam', pnpalayam: 'Pethanaickenpalayam', ariyapalayam: 'Pethanaickenpalayam', pethanaickanpalayam: 'Pethanaickenpalayam',
    thalaivasal: 'Thalaivasal', talavasal: 'Thalaivasal', thalaivasel: 'Thalaivasal',
    valapadi: 'Valapadi', valapady: 'Valapadi', vazhapadi: 'Valapadi', valappady: 'Valapadi', belur: 'Valapadi',
    yercaud: 'Yercaud', yercadu: 'Yercaud'
  };
  // The health-block name (salem.nic.in) each line-list block belongs to.
  const HEALTH_BLOCK = {
    'Attur': 'Attur', 'Attur Mpty': 'Attur', 'Narasingapuram Mpty': 'Attur',
    'Ayothiyapattinam': 'Ayyothiyapattinam', 'Gangavalli': 'Thammampatty',
    'Panamarathupatti': 'Panamarathupatty', 'Pethanaickenpalayam': 'Ariyapalayam',
    'Thalaivasal': 'Thalaivasal', 'Valapadi': 'Belur', 'Yercaud': 'Yercaud'
  };

  function lev(a, b) {
    if (a === b) return 0;
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }

  function canonBlock(v) {
    const k = norm(v).replace(/block$/, '');
    if (!k) return { block: 'Not stated', known: false };
    if (BLOCK_ALIASES[k]) return { block: BLOCK_ALIASES[k], known: true };
    let best = null, bd = 99;
    for (const key of Object.keys(BLOCK_ALIASES)) {
      const d = lev(k, key);
      if (d < bd) { bd = d; best = key; }
    }
    if (bd <= 2) return { block: BLOCK_ALIASES[best], known: true };
    return { block: titleCase(v), known: false };
  }

  function canonAreaType(v, localBody) {
    const s = norm(v);
    if (s === 'vp' || /village/.test(s)) return 'VP';
    if (s === 'tp' || /town/.test(s)) return 'TP';
    if (/mpty|municip|^m$/.test(s)) return 'Mpty';
    if (/corp/.test(s)) return 'Corporation';
    const lb = norm(localBody);
    if (/vp$/.test(lb)) return 'VP';
    if (/tp$/.test(lb)) return 'TP';
    if (/mpty$|municipality$/.test(lb)) return 'Mpty';
    return 'Not stated';
  }

  function cleanLocalBody(v) {
    return titleCase(String(v ?? '').replace(/\b(v\.?p|t\.?p|mpty|municipality|panchayat)\b\.?/gi, ''))
      .replace(/\s+/g, ' ').trim();
  }

  function canonCondition(disease, v) {
    const s = norm(v);
    if (disease === 'Dengue') {
      const ns1 = /ns1|ns 1/.test(String(v).toLowerCase()) || /ns1/.test(s);
      const igm = /igm/.test(s);
      if (ns1 && igm) return 'Dengue NS1 + IgM';
      if (ns1) return /rapid/.test(s) ? 'Dengue NS1 (rapid)' : 'Dengue NS1 ELISA';
      if (igm) return 'Dengue IgM ELISA';
      return s ? 'Dengue (other test)' : 'Dengue (test not stated)';
    }
    if (!s || s === 'fever') return 'Fever';
    if (/lepto/.test(s)) return 'Leptospirosis';
    if (/h1n1|influenzaa/.test(s)) return 'H1N1';
    if (/parain|parafl/.test(s)) return 'Parainfluenza';
    if (/ns1|dengue/.test(s)) return 'Dengue NS1 +ve';
    if (/scrub/.test(s)) return 'Scrub typhus';
    if (/typhoid|widal/.test(s)) return 'Typhoid';
    if (/malaria|vivax|falciparum/.test(s)) return 'Malaria';
    if (/fever/.test(s)) return 'Fever';
    return titleCase(v);
  }

  // Groups spellings of the same place ("Valaiyamadevi" / "Valaiyamdevi") under the most used one.
  function harmonize(values) {
    const counts = new Map();
    values.forEach((v) => { if (v) counts.set(v, (counts.get(v) || 0) + 1); });
    const names = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    const canon = new Map();
    const heads = [];
    for (const n of names) {
      const k = norm(n);
      let head = heads.find((h) => {
        const hk = norm(h);
        if (hk === k) return true;
        const tol = Math.max(1, Math.floor(Math.min(hk.length, k.length) / 6));
        return Math.abs(hk.length - k.length) <= tol && lev(hk, k) <= tol;
      });
      if (!head) { heads.push(n); head = n; }
      canon.set(n, head);
    }
    return (v) => (v ? canon.get(v) || v : v);
  }

  function parsePhones(v) {
    if (v === null || v === undefined) return [];
    const s = typeof v === 'number' ? String(Math.round(v)) : String(v);
    return (s.match(/\d{10}/g) || []);
  }

  function decimals(n) {
    const s = String(n);
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }

  /* ---------- Workbook ---------- */
  function parseWorkbook(wb, fileName) {
    const out = { cases: [], sheets: [], skipped: [], issues: [] };
    for (const sheetName of wb.SheetNames) {
      if (/^(instructions?|lists?|read ?me|notes?|help|about\b.*)$/i.test(sheetName.trim())) continue; // template helper sheets
      const ws = wb.Sheets[sheetName];
      const rows = global.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      const hdr = findHeaderRow(rows);
      if (!hdr) { out.skipped.push({ sheet: sheetName, reason: 'No recognisable line-list headings' }); continue; }
      const map = hdr.map;
      const disease = classifySheet(sheetName, map, fileName);
      if (!disease) { out.skipped.push({ sheet: sheetName, reason: 'Could not tell whether this sheet is IP Fever or Dengue' }); continue; }
      if ((map.lat === undefined || map.lon === undefined) && map.latlon === undefined) { out.skipped.push({ sheet: sheetName, reason: 'No latitude / longitude columns' }); continue; }
      const WANT = { block: 'Block', phc: 'PHC', age: 'Age', sex: 'Sex', local_body: 'Local body', name: 'Name' };
      if (disease === 'Dengue') WANT.test = 'Type of test'; else WANT.condition = 'Disease condition';
      const missing = Object.entries(WANT).filter(([k]) => map[k] === undefined).map(([, label]) => label);
      if (!['report_date', 'adm_date', 'date'].some((k) => map[k] !== undefined)) missing.unshift('Date');

      const body = rows.slice(hdr.idx + 1).filter((r) => r && r.some((c) => c !== null && String(c).trim() !== ''));
      const get = (r, f) => (map[f] === undefined ? null : r[map[f]]);
      const body2 = body.filter((r) => get(r, 'name') !== null || get(r, 'date') !== null || get(r, 'report_date') !== null || get(r, 'lat') !== null);

      const monthHints = body2.map((r) => {
        const m = norm(get(r, 'month'));
        const i = MONTHS.findIndex((x) => m && (x === m || x.startsWith(m.slice(0, 3))));
        return i >= 0 ? i + 1 : null;
      });
      const weekHints = body2.map((r) => { const w = parseInt(get(r, 'week'), 10); return isNaN(w) ? null : w; });
      const dateCols = ['report_date', 'adm_date', 'onset_date', 'date'].filter((f) => map[f] !== undefined);
      const resolved = {};
      for (const f of dateCols) {
        // Onset dates are not tied to the reporting month, so they only use the column majority.
        const useHints = f !== 'onset_date';
        resolved[f] = resolveDateColumn(body2.map((r) => get(r, f)),
          useHints ? monthHints : monthHints.map(() => null), useHints ? weekHints : weekHints.map(() => null));
      }

      let swappedCount = 0;
      body2.forEach((r, i) => {
        const excelRow = hdr.idx + 2 + body.indexOf(r);
        const d = (f) => (resolved[f] ? resolved[f][i] : { day: null, swapped: false, bad: false });
        const rep = d('report_date'), adm = d('adm_date'), ons = d('onset_date'), gen = d('date');
        [rep, adm, ons, gen].forEach((x) => { if (x.swapped) swappedCount++; });
        const primary = disease === 'Dengue' ? (gen.day ?? rep.day ?? adm.day) : (rep.day ?? adm.day ?? gen.day);

        let lat = parseCoord(get(r, 'lat')), lon = parseCoord(get(r, 'lon'));
        let rawLat = get(r, 'lat'), rawLon = get(r, 'lon');
        if ((isNaN(lat) || isNaN(lon)) && map.latlon !== undefined) {
          [lat, lon] = parseLatLon(get(r, 'latlon'));
          rawLat = rawLon = get(r, 'latlon');
        }
        let coordSwapped = false;
        if (!isNaN(lat) && !isNaN(lon) && lat > 60 && lon < 40) { [lat, lon] = [lon, lat]; coordSwapped = true; }
        const hasCoord = !isNaN(lat) && !isNaN(lon) && lat > 5 && lat < 38 && lon > 67 && lon < 98;

        const age = parseAge(get(r, 'age'));
        const sx = parseSex(get(r, 'sex'));
        const blk = canonBlock(get(r, 'block'));
        const localRaw = get(r, 'local_body');
        const c = {
          id: `${fileName}|${sheetName}|${excelRow}`,
          file: fileName, sheet: sheetName, row: excelRow,
          disease,
          condition: canonCondition(disease, disease === 'Dengue' ? get(r, 'test') : get(r, 'condition')),
          conditionRaw: clean(disease === 'Dengue' ? get(r, 'test') : get(r, 'condition')),
          day: primary,
          reportDay: rep.day, admDay: adm.day, onsetDay: ons.day,
          dateBad: [rep, adm, ons, gen].some((x) => x.bad),
          name: clean(get(r, 'name')),
          ageYears: age.years, ageLabel: age.label, ageGroup: ageGroup(age.years),
          sex: sx.sex,
          address: clean(get(r, 'address')),
          phones: parsePhones(get(r, 'phone')),
          block: blk.block, blockKnown: blk.known,
          healthBlock: HEALTH_BLOCK[blk.block] || null,
          phc: titleCase(String(get(r, 'phc') ?? '').replace(/\bphc\b\.?/gi, '')) || 'Not stated',
          hsc: titleCase(get(r, 'hsc')),
          areaType: canonAreaType(get(r, 'area_type'), localRaw),
          localBody: cleanLocalBody(localRaw) || 'Not stated',
          ward: clean(get(r, 'ward')),
          habitation: clean(get(r, 'habitation')),
          hospital: clean(get(r, 'hospital')),
          source: (() => { const s = norm(get(r, 'source')); return s.includes('ssh') ? 'SSH' : s.includes('ovf') ? 'OVF' : ''; })(),
          lat: hasCoord ? lat : null, lon: hasCoord ? lon : null,
          // Degrees-minutes-seconds and combined cells are treated as precise; decimals are counted otherwise.
          coordDecimals: hasCoord ? (numericLike(rawLat) && numericLike(rawLon) ? Math.min(decimals(rawLat), decimals(rawLon)) : 6) : null,
          coordSwapped,
          coordRaw: map.latlon !== undefined && map.lat === undefined ? [get(r, 'latlon')] : [get(r, 'lat'), get(r, 'lon')],
          remarks: clean(get(r, 'remarks'))
        };
        out.cases.push(c);
      });
      out.sheets.push({ sheet: sheetName, disease, rows: body2.length, datesCorrected: swappedCount, columns: Object.keys(map), missing });
    }
    return out;
  }

  // Merges parsed files, harmonises place-name spellings across the whole dataset,
  // and drops rows repeated exactly across files.
  function combine(parsedList) {
    const all = [];
    const seen = new Set();
    let exactDupes = 0;
    const sheets = [], skipped = [];
    for (const p of parsedList) {
      sheets.push(...p.sheets.map((s) => ({ ...s, file: p.file })));
      skipped.push(...p.skipped.map((s) => ({ ...s, file: p.file })));
      for (const c of p.cases) {
        const key = [c.disease, norm(c.name), c.day, c.phones.join(','), c.lat, c.lon].join('|');
        if (seen.has(key)) { exactDupes++; continue; }
        seen.add(key);
        all.push(c);
      }
    }
    const hPhc = harmonize(all.map((c) => c.phc));
    const hLb = harmonize(all.map((c) => c.localBody));
    const hHsc = harmonize(all.map((c) => c.hsc));
    const hHosp = harmonize(all.map((c) => titleCase(c.hospital)));
    all.forEach((c) => {
      c.phc = hPhc(c.phc);
      c.localBody = hLb(c.localBody);
      c.hsc = hHsc(c.hsc);
      c.hospital = hHosp(titleCase(c.hospital));
    });
    all.sort((a, b) => (a.day ?? 0) - (b.day ?? 0));
    all.forEach((c, i) => { c.uid = i; });
    return { cases: all, sheets, skipped, exactDupes };
  }

  /* ---------- Template ---------- */
  const TEMPLATE = {
    Fever: ['S.No', 'Date of Admission', 'Name', 'Age ()', 'Sex   ( M /F )', 'Address : Village / Town',
      'Name of the HUD', 'Name of the Block', 'Name of the PHC', 'Contact Number', 'Disease condition',
      'Name of the Hospital / Institution', 'Mpty / TP / VP', 'Name of the local body', 'Name of the ward',
      'Name of the Habitation / Street Name', 'Name of the HSC', 'Date of On-set of fever', 'Date of reporting',
      'Month', 'Week NO', 'Remarks', 'Lattitude', 'Longitude', 'Outcome', 'Remarks'],
    DENGUE: ['S.No', 'Date', 'Reporting SSH/ District', 'Name', 'Age', 'Sex (M/F)', 'ADDRESS', 'Mobile Number',
      'Name of the Village Panchayat /Town Panchayat/ Municipality / Corporation', 'Block', 'PHC / Urban PHC', 'HUD',
      'Type of Test', 'Place of Diagnosis', 'Mpty/ TP/VP', 'Hamlet Ward', 'SSH/ OVF', 'Week no', 'Month',
      'Health Sub-Centre', 'Remarks', 'Lat', 'Long']
  };

  global.LineList = {
    parseWorkbook, combine, isoWeek, toDay, TEMPLATE, AGE_GROUPS, HEALTH_BLOCK, norm, titleCase,
    _test: { dateCandidates, resolveDateColumn, parseAge, parseSex, canonBlock, canonCondition, canonAreaType, harmonize, cleanLocalBody, parseCoord, parseLatLon, classifySheet, findHeaderRow }
  };
})(typeof window !== 'undefined' ? window : globalThis);
