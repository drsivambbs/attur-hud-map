# EpiTrack Attur – Fever & Dengue Surveillance Map

Directorate of Public Health and Preventive Medicine · Government of Tamil Nadu · National Health Mission, Tamil Nadu — Attur Health Unit District, Salem.

Designed by **Dr. M. Sivachandran Mathiyazagan**, MBBS, MPH (ICMR-NIE).

A static web app that maps the IP Fever and Dengue line list for Attur Health Unit District (Salem), with filters, space-time cluster analysis, a weekly summary and data-quality checks. Excel files are read **inside the browser**: no server, no upload, no patient data stored in this folder.

## Using it

The screen is built for non-technical users. **Filter bar** above the map: Area (block / municipality, or type a PHC or village), Period (Last 7 / 14 / 28 days, This month, All dates, or chosen dates), Disease (both, Dengue only, IP Fever only), **More filters** (a pop-up with lab result, block, PHC, area type, sex, age, SSH/OVF, date type, record options), **Charts** and **Home**. Under it, one line of key figures. The **sidebar** is only the hotspot list (the rule sits behind "Rule"). **Charts** and **Data check** (top bar) open as drawers over the map. By default only **IP Fever and Dengue** cases are selected; other infections (Leptospirosis, H1N1, Parainfluenza …) start unticked under More filters → Lab result. **Home** returns to the fresh view. With **Village borders** on, pointing at the map shows the village name, type, block and cases.

Details:


1. Open the app and click **Load Excel** (or drop the workbook on the page). Several files can be loaded together, for example a Fever file and a Dengue file.
2. **Show one area** (top of the Filters tab): pick a block, or search any PHC, village or town. The map zooms to it and fades the rest; KPIs, tables, exports and the PowerPoint cover only that area. Clusters are still found on the whole HUD, so a cluster crossing the area's edge is shown in full (outside cases faded) and keeps the same ID. Block and PHC use what the line list says; a village or town uses the case location.
3. **Filters** tab: period (with Last 7 / 14 / 28 days, This month, All), disease, lab result, block, PHC, area type, sex, age group, SSH/OVF. IP Fever can be dated by reporting, admission or onset.
4. **Clusters** tab: space-time DBSCAN (see below). Click a cluster to zoom to it and list its cases.
5. **Summary** tab: weekly epicurve, block table, age–sex chart, most affected places, lab results.
6. **Data quality** tab: every problem found in the file, grouped by check. Click a record to find it on the map.
7. **Layers** panel (on the map): colour cases by disease / recency / cluster, point size, **only cases in clusters**, heatmap, boundaries, and basemap (OSM, Humanitarian or **None** for a plain white map).
8. **Export → PowerPoint report**: a 16:9 deck built from what is on screen — cover with key figures, case map, cluster map (IDs and case counts), cluster list, weekly epicurve with block table, and methods / data-quality. The title, subtitle, map extent (whole HUD or current view) and slides can be chosen. Optional **block dashboards** add one slide per block: six key figures (total, Dengue, IP Fever, this week vs last week, active hotspots, share of HUD cases), a map zoomed to the block, the last 12 weeks as a chart, and PHC and hotspot tables. Maps are high-resolution images with scale bar, north arrow and OSM credit; legends, tables and the chart are native PowerPoint objects (editable).
9. **Export**: filtered cases, clusters with their members, or the data-quality list, as Excel.
10. **Hide personal details** removes names, phone numbers and addresses from the screen and from exports.
11. **Template** downloads the standard import workbook (`template/Attur_HUD_line_list_template.xlsx`): exact headings, dropdowns for block / PHC / area type / sex / condition / test / SSH-OVF, date columns kept as text (type DD-MM-YYYY, so Excel cannot swap day and month), Month and Week NO filled in automatically, coordinate range checks, and an Instructions sheet. Rebuild it with `python tools/make_template.py`.

The last loaded files are remembered in this browser only (turn off under Data quality → "Remember the loaded files on this computer", or use **Clear data**).

## Standard file format

The department's line-list workbook: a **Fever** sheet and a **DENGUE** sheet, one row per case, with the usual headings (see the template). Columns are recognised by heading, so order and small wording changes do not matter. Needed at minimum: a date, block, and latitude/longitude.

What the app cleans automatically:

- **Dates** typed as DD-MM-YYYY that Excel stored month-first (for example 01-08-2026 saved as 8 January) are corrected. Each row's Month and Week NO decide which reading is right.
- Ages such as "8mon", "14 Days"; sex codes such as Mch / FCH / Female.
- Block spellings (Valappady → Valapadi, P N Palayam → Pethanaickenpalayam …) and PHC / place-name spelling variants.
- Latitude and longitude entered the wrong way round.
- Rows repeated exactly across files.

### Other Excel layouts

Beyond the standard template the reader also accepts: title rows above the headings (it searches the first 20 rows), other heading wordings (Patient Name, Date of Test, Mobile, GPS …), coordinates as degrees-minutes-seconds (11°35'52"N) or both in one "GPS / Lat Long" column, dates with month names (03-Sep-2026, Sept 12, 2026) or with a time, and sheets whose names do not say Fever or Dengue (the headings or file name decide). The Data quality tab lists, per sheet, any important column it could not find.

It cannot use: sheets without latitude/longitude (no geocoding from addresses), summary tables, password-protected files, or a single sheet mixing Fever and Dengue rows (keep them in separate sheets or files).

### How big a file

Measured on this laptop (Chrome/Node, synthetic data built from the real rows):

| Cases in file | File size | First load | Each filter / area change |
|---|---|---|---|
| 2,000 | 2 MB | < 1 s | instant |
| 10,000 | 8 MB | ~1 s | < 0.3 s |
| 25,000 | 21 MB | ~5 s | ~0.5 s |
| 50,000 | 42 MB | ~11 s | < 1 s |
| 100,000 | 85 MB | ~30 s | ~2 s (heavy; ~0.7 GB memory) |

Comfortable up to about 50,000 cases (several years of HUD line lists); workable to ~100,000. Beyond that, split by year. The PowerPoint map rendering is not affected by file size in any noticeable way.

## Cluster method: ST-DBSCAN

Two cases are neighbours when they are within **distance** metres of each other **and** within **days** of each other. A cluster forms where a case has at least **minimum cases** neighbours (counting itself); clusters grow through connected neighbourhoods, and isolated cases are left out.

- Default: 400 m (about the flight range of *Aedes*), 14 days, 3 cases, each disease clustered separately. The **Separately / Together** switch on the Hotspots tab pools the two: with Together, e.g. 2 Dengue + 2 IP Fever cases within 400 m and 14 days of each other form one hotspot (ID prefix ALL-); with Separately they form none, since each disease has only 2.
- **Active** = a case within the time window of the latest date shown; otherwise **Closed**. **New this week** = first case in the last 7 days.
- **Stacked dots**: cases sharing one location (about 10 m) are drawn on top of each other; from zoom 12 the dot shows a count badge and its popup lists the other cases there. (In Aug–Sep 2026, 74 of 445 cases shared a spot with another case.) Block-dashboard maps in the PowerPoint show the same counts.
- Cluster IDs (IPF-01, DEN-01 …) are numbered by first case date and change when the settings or filters change.
- The **nearest-neighbour ratio** (Clark–Evans) tests whether the cases shown are more clustered than random across the HUD (ratio < 1, z < −1.96).

The method matches scikit-learn's DBSCAN with a precomputed space-and-time neighbour matrix.

## Data-quality checks

Missing / unreadable coordinates, points outside the HUD boundary, low-precision coordinates (fewer than 4 decimals), missing or impossible dates (onset after admission, onset > 60 days before reporting), unrecognised block names, possible duplicates (same disease, similar name, age within 2 years, same phone or place, within 7 days), fever cases that also appear in the dengue list, and cases whose location falls in a different health block from the one written.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Layout and styles |
| `js/parser.js` | Reads and cleans the workbook (no map code) |
| `js/analysis.js` | Location checks, data-quality checks, ST-DBSCAN, nearest-neighbour index |
| `js/app.js` | Filters, map, clusters, summary, upload, export |
| `js/report.js` | PowerPoint report: map rendering and slide layout (PptxGenJS) |
| `assets/logos/` | Government of Tamil Nadu emblem, DPH and NHM Tamil Nadu logos |
| `template/` | Standard import template (no patient data) |
| `tools/make_template.py` | Rebuilds the template (openpyxl) |
| `data/hud-data.js` | Attur HUD, health-block and village boundaries (from `../Attur_HUD_GeoJSON`) |

## Run locally

```bash
python -m http.server 8765 --directory Attur_HUD_GIS
```

Then open http://localhost:8765.

## Online

**Live at https://drsivambbs.github.io/attur-hud-map/** (GitHub Pages, from the `main` branch of this repository).

Anyone with the link can open the app, but not any data: each user loads their own Excel file, which is read only in their browser. **Never add line-list Excel files to this repository** – `.gitignore` blocks `.xlsx`, `.xls` and `.csv` files (except the blank template) as a safety net.

To publish a change:

- **From this computer:** `git add -A`, `git commit -m "what changed"`, `git push`. The site updates about a minute later.
- **Without the command line:** on github.com open the repository → *Add file* → *Upload files*, drop the changed files (keeping the same folder, e.g. `js/app.js`), and press *Commit changes*.

Every version is kept in the repository history, so a bad change can be undone.

## Sources

Health-block list: Attur HUD page on salem.nic.in. Boundaries: LGD Blocks and LGD Villages (ramSeraph/indian_admin_boundaries). Basemap © OpenStreetMap contributors.
