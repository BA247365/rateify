window.__RATEIFY_BUILD="v24-static-corr-alignment-20260216";

/* Rateify v5 - tabbed + 10-journal output + editable percentile bands (UL only) */


let ALLOWLIST = null; // Set of allowed emails (lowercased). If present, enforced.
async function loadAllowlist(){
  try{
    const res = await fetch("data/allowlist.json", {cache:"no-store"});
    if (!res.ok) return;
    const j = await res.json();

    // Support formats:
    // 1) ["a@x.com","b@y.com"]
    // 2) { "emails": ["a@x.com", ...] }
    // 3) [{ "email":"a@x.com", "allowed": true }, ...]
    // 4) { "emails": [{ "email":"a@x.com", "allowed": true }, ...] }
    let items = [];
    if (Array.isArray(j)) items = j;
    else if (j && Array.isArray(j.emails)) items = j.emails;

    const normalized = [];
    for (const it of items){
      if (!it) continue;
      if (typeof it === "string"){
        normalized.push(it);
      }else if (typeof it === "object"){
        const allowed = (it.allowed === undefined) ? true : !!it.allowed;
        if (!allowed) continue;
        const em = it.email || it.mail || it.id;
        if (em) normalized.push(String(em));
      }
    }
    ALLOWLIST = new Set(normalized.map(e=>String(e).trim().toLowerCase()).filter(Boolean));
  }catch(e){
    // ignore: allowlist optional
  }
}

const PAGE_SIZE = 600;

const STATE = {
  user: null,
  scopus: [],
  scopusByTitleLower: new Map(),
  scopusTitleCollisions: new Set(),
  scopusByIssn: new Map(),
  abdcTitleCollisions: new Set(),
  abdcByIssn: new Map(),
  scopusIndex2: new Map(),
  abdcList: [],
  manualNames: [],
  scopusTypeahead: [],
  abdcByTitleLower: new Map(),
  abdc2025JQL: [],
  abdc2025Removed: [],
  abdcCommon1702: [],
  abdcSerialByTitleKey: new Map(),
  commonArrays: null,
  corrData: null,
  abdcPage: 0,
  scopusPage: 0,
  removedPage: 0,

  // bands: UL cutoffs (0..100) used for computation
  bands: { ulA: 75, ulB: 50, ulC: 25 },

  // band widths (A*/A/B/C) used for display + CSV export
  bandWidths: { Astar: 25, A: 25, B: 25, C: 25 },

  bandsDirty: false, // if user changed preset/custom, prompt "press compute"

  outputRows: []
};
// Demo build: disable authentication (login coming soon)
const AUTH_DISABLED = true;


function $(id){ return document.getElementById(id); }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }


function buildUniqueMap(records, keyFn){
  const map = new Map();
  const collisions = new Set();
  for (const r of records){
    const k = keyFn(r);
    if (!k) continue;
    if (!map.has(k)){
      map.set(k, r);
    }else{
      collisions.add(k);
      map.set(k, null);
    }
  }
  return {map, collisions};
}

function buildIssnMap(records, getIssnsFn){
  const map = new Map();
  const collisions = new Set();
  for (const r of records){
    const arr = getIssnsFn(r) || [];
    for (const issn of arr){
      const k = normalizeIssnKey(issn);
      if (!k) continue;
      if (!map.has(k)){
        map.set(k, r);
      }else{
        collisions.add(k);
        map.set(k, null);
      }
    }
  }
  return {map, collisions};
}

function extractIssnsFromAbdc(rec){
  const out = [];
  if (!rec) return out;
  if (rec.issn_print_fmt) out.push(rec.issn_print_fmt);
  if (rec.issn_e_fmt) out.push(rec.issn_e_fmt);
  if (rec.issn) out.push(rec.issn);
  if (rec.eissn) out.push(rec.eissn);
  return out.filter(Boolean);
}

function extractIssnsFromScopus(rec){
  const out = [];
  if (!rec) return out;
  if (rec.issn_print_fmt) out.push(rec.issn_print_fmt);
  if (rec.issn_e_fmt) out.push(rec.issn_e_fmt);
  if (rec.issn) out.push(rec.issn);
  if (rec.eissn) out.push(rec.eissn);
  if (rec.print_issn) out.push(rec.print_issn);
  if (rec.e_issn) out.push(rec.e_issn);
  return out.filter(Boolean);
}

function isLikelyIssn(s){
  const k = normalizeIssnKey(s);
  return k.length === 8;
}

function diceCoeff(a, b){
  // Dice coefficient on bigrams, [0,1]
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i=0;i<a.length-1;i++){
    const g = a.slice(i,i+2);
    bigrams.set(g, (bigrams.get(g)||0)+1);
  }
  let matches = 0;
  for (let i=0;i<b.length-1;i++){
    const g = b.slice(i,i+2);
    const c = bigrams.get(g)||0;
    if (c>0){
      bigrams.set(g, c-1);
      matches++;
    }
  }
  return (2*matches) / ((a.length-1)+(b.length-1));
}

async function fetchJsonSmart(path){
  const tries = [path, `./${path}`, `/${path}`];
  let lastErr = null;
  for (const u of tries){
    try{
      const r = await fetch(u, {cache:'no-store'});
      if (!r.ok) throw new Error(`${u}: ${r.status} ${r.statusText}`);
      const txt = await r.text();
      const head = txt.slice(0,60).toLowerCase();
      if (head.includes('<!doctype') || head.includes('<html')) throw new Error(`${u}: got HTML instead of JSON`);
      return JSON.parse(txt);
    }catch(e){ lastErr = e; }
  }
  throw lastErr || new Error(`Failed to load ${path}`);
}

function showDataErrorBanner(msg){
  const el = document.getElementById('dataErrorBanner');
  if (el){ el.textContent = msg; el.style.display='block'; }
}



function normalizeWidths(widths){
  // widths: {Astar,A,B,C}. For presets, we want clean 0–100 boundaries.
  // If the sum is not 100, we treat A*/A/B as fixed and set C to the remainder.
  // (If remainder would be negative, fall back to proportional normalization.)
  const Astar = Number(widths.Astar||0);
  const A = Number(widths.A||0);
  const B = Number(widths.B||0);
  const C_in = Number(widths.C||0);
  const sum = Astar + A + B + C_in;

  if (!sum || sum <= 0) return {Astar:25, A:25, B:25, C:25, _factor:1};

  if (Math.abs(sum - 100) < 1e-9){
    return {Astar, A, B, C: C_in, _factor:1};
  }

  // Prefer "remainder" behaviour (keeps A*/A/B intuitive)
  const C = 100 - (Astar + A + B);
  if (C >= 0){
    return {Astar, A, B, C, _factor:1, _remainderAdjusted:true};
  }

  // Otherwise, proportional normalization (rare; e.g., A*/A/B already exceed 100)
  const factor = 100 / sum;
  return {
    Astar: Astar*factor,
    A: A*factor,
    B: B*factor,
    C: C_in*factor,
    _factor: factor,
    _normalized:true
  };
}

function widthsToCutoffs(widths){
  // Convert widths (top-down A*/A/B/C) into cumulative cutoffs from bottom (ulC, ulB, ulA)
  const w = normalizeWidths(widths);
  const ulC = w.C;
  const ulB = w.C + w.B;
  const ulA = w.C + w.B + w.A;
  return { ulA, ulB, ulC };
}

function cutoffsToWidths(bands){
  // Convert cutoffs into widths (A*/A/B/C)
  const ulA = Number(bands.ulA), ulB = Number(bands.ulB), ulC = Number(bands.ulC);
  const C = Math.max(0, Math.min(100, ulC));
  const B = Math.max(0, Math.min(100, ulB) - C);
  const A = Math.max(0, Math.min(100, ulA) - (C+B));
  const Astar = Math.max(0, 100 - (C+B+A));
  return {Astar, A, B, C};
}

function fmtWidthsSlash(w){
  // Display as widths in A*/A/B/C order: e.g., 25/25/25/25
  const r = (x)=> String(Math.round(x));
  return `${r(w.Astar)}/${r(w.A)}/${r(w.B)}/${r(w.C)}`;
}
function toNum(v){
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase()==='na' || s.toLowerCase()==='#n/a' || s.toLowerCase()==='n/a') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function labelForValue(value, ranges){
  if (value === null) return "#N/A";
  for (const r of ranges){
    if (value >= r.ll && value < r.ul) return r.label;
  }
  // include upper edge
  const last = ranges[ranges.length-1];
  if (last && value >= last.ll && (last.ul === Infinity || value <= last.ul)) return last.label;
  return "#N/A";
}

function computePercentileValue(sortedArr, p){
  // p in [0,100]
  if (!sortedArr || sortedArr.length===0) return null;
  const n = sortedArr.length;
  if (p <= 0) return sortedArr[0];
  if (p >= 100) return sortedArr[n-1];
  const q = p/100;
  const idx = (n-1)*q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo]*(1-w) + sortedArr[hi]*w;
}

function bandsToRanges(ulA, ulB, ulC){
  // descending labels: A*, A, B, C with percentiles
  // A*: [ulA,100], A: [ulB,ulA], B:[ulC,ulB], C:[0,ulC]
  return [
    {label:"A*", pll: ulA, pul:100},
    {label:"A",  pll: ulB, pul: ulA},
    {label:"B",  pll: ulC, pul: ulB},
    {label:"C",  pll: 0,   pul: ulC}
  ];
}

function validateBands(ulA, ulB, ulC){
  return (0 < ulC && ulC < ulB && ulB < ulA && ulA < 100);
}

function updateBandLLLabels(){
  const {ulA, ulB, ulC} = STATE.bands;
  const aStar = document.getElementById("ll_astar");
  const a = document.getElementById("ll_a");
  const b = document.getElementById("ll_b");
  if (aStar) aStar.textContent = String(Math.round(ulA));
  if (a) a.textContent = String(Math.round(ulB));
  if (b) b.textContent = String(Math.round(ulC));
}

// Build the editable percentile bands table (Label / LL / UL).
// This table also contains the UL number inputs (ul_a / ul_b / ul_c)
// that are used by wireBands().
function renderBandsTable(){
  const el = document.getElementById("bandsTable");
  if (!el) return;

  // One merged table: Editable percentile bands + CiteScore/SNIP/SJR value ranges.
  // Keeping IDs (ul_a/ul_b/ul_c, ll_*) so wireBands() and updateBandLLLabels() continue to work.
  el.innerHTML = `
    <colgroup>
      <col class="c-eb-label"><col class="c-eb-ll"><col class="c-eb-ul">
      <col class="c-cs-label"><col class="c-cs-ll"><col class="c-cs-ul">
      <col class="c-snip-label"><col class="c-snip-ll"><col class="c-snip-ul">
      <col class="c-sjr-label"><col class="c-sjr-ll"><col class="c-sjr-ul">
    </colgroup>
    <thead>
      <tr class="mega-groups">
        <th colspan="3" class="mega-group">Editable percentile bands</th>
        <th colspan="3" class="mega-group cs">CiteScore ranges</th>
        <th colspan="3" class="mega-group snip">SNIP ranges</th>
        <th colspan="3" class="mega-group sjr">SJR ranges</th>
      </tr>
      <tr class="mega-cols">
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
      </tr>
    </thead>
    <tbody>
      <tr class="r-Astar">
        <td><b>A*</b></td>
        <td class="num" id="ll_astar">${Math.round(STATE.bands.ulA)}</td>
        <td class="num">100</td>

        <td><b>A*</b></td><td class="num" id="cs_ll_astar">–</td><td class="num" id="cs_ul_astar">–</td>
        <td><b>A*</b></td><td class="num" id="snip_ll_astar">–</td><td class="num" id="snip_ul_astar">–</td>
        <td><b>A*</b></td><td class="num" id="sjr_ll_astar">–</td><td class="num" id="sjr_ul_astar">–</td>
      </tr>

      <tr class="r-A">
        <td><b>A</b></td>
        <td class="num" id="ll_a">${Math.round(STATE.bands.ulB)}</td>
        <td class="num">
          <div class="pct-stepper">
            <button type="button" class="pct-btn" data-delta="-1" aria-label="Decrease A upper bound">−</button>
            <input id="ul_a" type="number" min="1" max="99" step="1" value="${Math.round(STATE.bands.ulA)}" />
            <button type="button" class="pct-btn" data-delta="+1" aria-label="Increase A upper bound">+</button>
          </div>
        </td>

        <td><b>A</b></td><td class="num" id="cs_ll_a">–</td><td class="num" id="cs_ul_a">–</td>
        <td><b>A</b></td><td class="num" id="snip_ll_a">–</td><td class="num" id="snip_ul_a">–</td>
        <td><b>A</b></td><td class="num" id="sjr_ll_a">–</td><td class="num" id="sjr_ul_a">–</td>
      </tr>

      <tr class="r-B">
        <td><b>B</b></td>
        <td class="num" id="ll_b">${Math.round(STATE.bands.ulC)}</td>
        <td class="num">
          <div class="pct-stepper">
            <button type="button" class="pct-btn" data-delta="-1" aria-label="Decrease B upper bound">−</button>
            <input id="ul_b" type="number" min="1" max="99" step="1" value="${Math.round(STATE.bands.ulB)}" />
            <button type="button" class="pct-btn" data-delta="+1" aria-label="Increase B upper bound">+</button>
          </div>
        </td>

        <td><b>B</b></td><td class="num" id="cs_ll_b">–</td><td class="num" id="cs_ul_b">–</td>
        <td><b>B</b></td><td class="num" id="snip_ll_b">–</td><td class="num" id="snip_ul_b">–</td>
        <td><b>B</b></td><td class="num" id="sjr_ll_b">–</td><td class="num" id="sjr_ul_b">–</td>
      </tr>

      <tr class="r-C">
        <td><b>C</b></td>
        <td class="num" id="ll_c">0</td>
        <td class="num">
          <div class="pct-stepper">
            <button type="button" class="pct-btn" data-delta="-1" aria-label="Decrease C upper bound">−</button>
            <input id="ul_c" type="number" min="1" max="99" step="1" value="${Math.round(STATE.bands.ulC)}" />
            <button type="button" class="pct-btn" data-delta="+1" aria-label="Increase C upper bound">+</button>
          </div>
        </td>

        <td><b>C</b></td><td class="num" id="cs_ll_c">–</td><td class="num" id="cs_ul_c">–</td>
        <td><b>C</b></td><td class="num" id="snip_ll_c">–</td><td class="num" id="snip_ul_c">–</td>
        <td><b>C</b></td><td class="num" id="sjr_ll_c">–</td><td class="num" id="sjr_ul_c">–</td>
      </tr>
    </tbody>
  `;
}

function buildValueRanges(metricKey, sortedArr){
  const {ulA, ulB, ulC} = STATE.bands;
  // Display in the same top-down order as the editable table: A*, A, B, C
  const pct = bandsToRanges(ulA, ulB, ulC);
  // convert percentile bands to value LL/UL
  const rows = pct.map(b => {
    const vll = computePercentileValue(sortedArr, b.pll);
    // For the top band (A*), we keep the upper bound open-ended for classification,
    // but we still compute a display UL as the max of the matched set.
    const vul_display = computePercentileValue(sortedArr, b.pul);
    const vul = (b.label === "A*") ? null : vul_display;
    return {
      label: b.label,
      pll: b.pll, pul: b.pul,
      ll: vll ?? null,
      ul: vul ?? null,
      ul_display: vul_display ?? (vul ?? null)
    };
  });
  return rows;
}

function renderMiniRangeTable(tableEl, rows, palette){
  tableEl.innerHTML = `
    <thead>
      <tr><th>Label</th><th>LL</th><th>UL</th></tr>
    </thead>
    <tbody>
      ${rows.map(r => `
        <tr class="r-${r.label.replace('*','star')}">
          <td><b>${esc(r.label)}</b></td>
          <td class="num">${r.ll===null ? "#N/A" : r.ll.toFixed(2)}</td>
          <td class="num">${(r.ul_display===null || r.ul_display===undefined) ? "—" : r.ul_display.toFixed(2)}</td>
        </tr>
      `).join("")}
    </tbody>
  `;
}


function showPressCompute(){
  const el = $("pressCompute");
  if (el) el.style.display = "block";
  const btn = $("btnCompute");
  // Visual cue: when bands change, highlight Compute.
  if (btn) btn.classList.add("primary");
}
function hidePressCompute(){
  const el = $("pressCompute");
  if (el) el.style.display = "none";
  const btn = $("btnCompute");
  // Remove highlight once user recomputes.
  if (btn) btn.classList.remove("primary");
}
function fillMetricCells(prefix, rows){
  const map = {"A*":"astar","A":"a","B":"b","C":"c"};
  const fmt = (v) => {
    if (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) return "#N/A";
    const n = (typeof v === "number") ? v : Number(v);
    if (!isFinite(n)) return "#N/A";
    return n.toFixed(2);
  };
  for (const r of rows){
    const key = map[r.label];
    if (!key) continue;
    const llEl = document.getElementById(`${prefix}_ll_${key}`);
    const ulEl = document.getElementById(`${prefix}_ul_${key}`);
    if (llEl) llEl.textContent = fmt(r.ll);
    if (ulEl) ulEl.textContent = fmt((r.ul_display!==undefined && r.ul_display!==null) ? r.ul_display : r.ul);
  }
}


function updateRangesUI(){
  updateBandLLLabels();

  const ok = validateBands(STATE.bands.ulA, STATE.bands.ulB, STATE.bands.ulC);
  const msgEl = $("bandsMsg");
  if (msgEl) msgEl.textContent = ok ? "" : "Percentiles must satisfy: 0 < C < B < A < 100.";
  if (!ok || !STATE.commonArrays) return;

  const csRows = buildValueRanges("citescore", STATE.commonArrays.metrics.citescore);
  const snRows = buildValueRanges("snip", STATE.commonArrays.metrics.snip);
  const sjRows = buildValueRanges("sjr", STATE.commonArrays.metrics.sjr);

  fillMetricCells("cs", csRows);
  fillMetricCells("snip", snRows);
  fillMetricCells("sjr", sjRows);

  // policy note
  const {ulA, ulB, ulC} = STATE.bands;
  $("policyNote").textContent = `Percentile band widths used (A*/A/B/C): ${fmtWidthsSlash(STATE.bandWidths)}. (These are applied only after you press Compute.)`;
}

function buildLabelRangesForMetric(sortedArr){
  // build value ranges for label classification based on current bands
  const {ulA, ulB, ulC} = STATE.bands;
  const bands = bandsToRanges(ulA, ulB, ulC); // A*,A,B,C
  const valueBands = bands.map(b => ({
    label: b.label,
    ll: computePercentileValue(sortedArr, b.pll),
    ul: computePercentileValue(sortedArr, b.pul)
  }));

  // produce classifier ranges as half-open [ll, next_ll) except A* inclusive top.
  // we will derive from C,B,A,A* value boundaries in ascending.
  const asc = valueBands.slice().sort((x,y)=>x.ll-y.ll);
  const ranges = [];
  for (let i=0;i<asc.length;i++){
    const cur = asc[i];
    const next = asc[i+1];
    const ll = cur.ll ?? null;
    let ul = cur.ul ?? null;
    if (next && next.ll != null) ul = next.ll;
    if (ll==null || ul==null) continue;
    ranges.push({label: cur.label, ll, ul, ul_display: ul});
  }
  // ensure last label covers to max
  if (asc.length){
    const last = asc[asc.length-1];
    const ll = last.ll, ul = last.ul;
    if (ll!=null && ul!=null) ranges.push({label:last.label, ll, ul, ul_display: ul});
  }
  // IMPORTANT: make the highest band open-ended (A* "or more") so values
  // above the matched-set max (e.g., Nature/Cell CiteScore) still classify.
  if (ranges.length){
    /* keep display UL as matched-set max */
    if (ranges[ranges.length-1].ul_display === undefined || ranges[ranges.length-1].ul_display === null){
      ranges[ranges.length-1].ul_display = ranges[ranges.length-1].ul;
    }
    ranges[ranges.length-1].ul = Infinity;
  }
  // merge duplicates by label if any
  return ranges;
}

function normalizeTitleForKey(s){
  // Title key for deterministic cross-database matching.
  // Conservative normalization to reduce false negatives without fuzzy matching.
  let t = String(s ?? "").toLowerCase().trim();
  t = t.replace(/&/g, " and ");
  t = t.replace(/[\u2010-\u2015\-–—:,.;(){}\[\]\/\\'"`’“”!?+]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}


function tokenizeTitleForMatch(s){
  let t = normalizeTitleForKey(s);
  // Remove very common stopwords to improve similarity for long subtitles.
  const stop = new Set(["the","an","a","and","or","for","of","in","to","on","with","journal","international","research","studies"]);
  const parts = t.split(" ").filter(w => w.length>2 && !stop.has(w));
  return new Set(parts);
}

function jaccardSim(aSet, bSet){
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const x of aSet){ if (bSet.has(x)) inter++; }
  const uni = aSet.size + bSet.size - inter;
  return uni ? inter/uni : 0;
}

function normalizeTokenForMatch(tok){
  // basic normalization: strip trailing plural 's' for longer tokens
  let t = String(tok||"").trim();
  if (t.length >= 6 && t.endsWith("s")) t = t.slice(0,-1);
  return t;
}

function editDistanceLeq1(a,b){
  a = normalizeTokenForMatch(a);
  b = normalizeTokenForMatch(b);
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // If either token is very short, don't do fuzzy matching (avoid noise like CELL in EXCELLENCE)
  if (Math.min(la, lb) < 6) return false;

  // same length: allow one substitution
  if (la === lb){
    let diff = 0;
    for (let i=0;i<la;i++){
      if (a[i] !== b[i]){ diff++; if (diff>1) return false; }
    }
    return diff === 1;
  }

  // length differs by 1: allow one insert/delete
  let s = a, t = b;
  if (la > lb){ s = b; t = a; } // s shorter
  let i=0, j=0, edits=0;
  while (i < s.length && j < t.length){
    if (s[i] === t[j]){ i++; j++; continue; }
    edits++; if (edits>1) return false;
    j++; // skip one char in longer string
  }
  // account for trailing extra char
  return true;
}

function fuzzyJaccardSim(aSet, bSet){
  if (!aSet.size || !bSet.size) return 0;
  const aArr = Array.from(aSet).map(normalizeTokenForMatch);
  const bArr = Array.from(bSet).map(normalizeTokenForMatch);

  // exact intersection first
  const bExact = new Set(bArr);
  let inter = 0;
  const usedB = new Set();
  for (const x of aArr){
    if (bExact.has(x) && !usedB.has(x)){
      inter++; usedB.add(x);
    }
  }
  // fuzzy intersection for remaining tokens (edit distance <=1, only for tokens >=6)
  for (const x of aArr){
    if (bExact.has(x)) continue;
    for (const y of bArr){
      if (usedB.has(y)) continue;
      if (editDistanceLeq1(x,y)){
        inter++; usedB.add(y);
        break;
      }
    }
  }
  const union = new Set([...aArr, ...bArr]).size;
  return union ? (inter / union) : 0;
}


function findCloseAbdcTitles(scopusTitle, maxN=3){
  // Returns up to maxN ABDC records that are high-confidence close matches to scopusTitle.
  const qTokens = tokenizeTitleForMatch(scopusTitle);
  const qKey = normalizeTitleForKey(scopusTitle);
  let best = [];
  for (const r of (STATE.abdc2025JQL || [])){
    const t = r.title || "";
    const key = normalizeTitleForKey(t);
    // Fast path: containment on normalized strings
    let score = 0;
    if (key === qKey) score = 1.0;
    else {
      const sim = fuzzyJaccardSim(qTokens, tokenizeTitleForMatch(t));
      score = sim;
    }
    if (score >= 0.62){
      best.push({r, score});
    }
  }
  best.sort((a,b)=>b.score-a.score);
  return best.slice(0,maxN).map(x=>x.r);
}

function normalizeIssnKey(s){
  // ISSN normalized: strip hyphens/spaces, uppercase
  return String(s ?? "").toUpperCase().replace(/[^0-9X]/g, "");
}


function ensureSignedIn(){
  if (AUTH_DISABLED) return true;
  if (!STATE.user || !STATE.user.email) return false;
  const em = String(STATE.user.email).toLowerCase();
  const isAhdUni = em.endsWith("@ahduni.edu.in");
  if (isAhdUni) return true;
  if (ALLOWLIST && ALLOWLIST.size){
    return ALLOWLIST.has(em);
  }
  return false;
}


function setSignedInUI(){
  const ok = ensureSignedIn();
  $("btnCompute").disabled = false;
  $("btnExport").disabled = (STATE.outputRows.length===0) || !ok;
  $("userStatus").textContent = (AUTH_DISABLED ? "Demo mode (login coming soon)" : ok ? `Signed in: ${STATE.user.email}` : "Not signed in");
}

function signIn(){
  // Note: this is *not* mailbox verification. It enforces domain / allowlist rules for externals.
  // Real mailbox verification requires Supabase magic-link/OTP, which is a separate integration.
  const email = ($("email") ? $("email").value : "").trim();
  const name = $("fullName").value.trim();
  const desig = $("designation").value.trim();
  const school = ($("schoolDept") ? $("schoolDept").value.trim() : "");
  const uni = ($("universityOrg") ? $("universityOrg").value.trim() : "");

  // Hard mandatory fields (also enforced via HTML 'required')
  if (!email){ $("loginMsg").textContent = "Please enter your email."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ $("loginMsg").textContent = "Please enter a valid email address."; return; }
  if (!name){ $("loginMsg").textContent = "Please enter your name."; return; }
  if (!desig){ $("loginMsg").textContent = "Please enter your designation."; return; }
  if (!school){ $("loginMsg").textContent = "Please enter your School/Department."; return; }
  if (!uni){ $("loginMsg").textContent = "Please enter your University/Organisation."; return; }

  const em = email.toLowerCase();
  const isAhdUni = em.endsWith("@ahduni.edu.in");

  // If allowlist exists and has entries: allow all @ahduni.edu.in + allowlisted externals.
  // If allowlist missing/empty: allow only @ahduni.edu.in.
  if (ALLOWLIST && ALLOWLIST.size){
    if (!isAhdUni && !ALLOWLIST.has(em)){
      $("loginMsg").textContent = "This external email is not on the allowed list.";
      return;
    }
  } else {
    if (!isAhdUni){
      $("loginMsg").textContent = "Only @ahduni.edu.in emails are allowed (or provide an allowlist for externals).";
      return;
    }
  }

  STATE.user = {email, name, designation: desig, schoolDept: school, universityOrg: uni, ts: new Date().toISOString()};
  localStorage.setItem("rateify_user", JSON.stringify(STATE.user));
  $("loginMsg").textContent = "Signed in.";
  setSignedInUI();
}


function restoreUser(){
  try{
    const raw = localStorage.getItem("rateify_user");
    if (!raw) return;
    STATE.user = JSON.parse(raw);
    if (STATE.user?.email){
      if ($("email")) $("email").value = STATE.user.email || "";
      $("fullName").value = STATE.user.name || "";
      $("designation").value = STATE.user.designation || "";
      if ($("schoolDept")) $("schoolDept").value = STATE.user.schoolDept || STATE.user.schoolCentre || "";
      if ($("universityOrg")) $("universityOrg").value = STATE.user.universityOrg || "";
    }
  }catch(e){}
  setSignedInUI();
}

function parseJournalNames(){
  const manual = Array.isArray(STATE.manualNames) ? STATE.manualNames.slice() : [];
  const pasteRaw = String($("journalInput")?.value || "");
  const pasted = pasteRaw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const combined = [];
  const seen = new Set();
  for (const x of [...manual, ...pasted]){
    const k = String(x).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(String(x));
  }
  return combined;
}

function computeOne(name, rangesCS, rangesSNIP, rangesSJR){
  const raw = String(name ?? "").trim();
  const key = normalizeTitleForKey(raw);

  let abRec = null;
  let scRec = null;
  let ambiguous = false;

  // ISSN-first if user provided an ISSN
  if (isLikelyIssn(raw)){
    const kIssn = normalizeIssnKey(raw);
    abRec = STATE.abdcByIssn.get(kIssn) || null;
    scRec = STATE.scopusByIssn.get(kIssn) || null;
  } else {
    if (STATE.abdcTitleCollisions.has(key)) ambiguous = true;
    if (STATE.scopusTitleCollisions.has(key)) ambiguous = true;
    abRec = STATE.abdcByTitleLower.get(key) || null;
    scRec = STATE.scopusByTitleLower.get(key) || null;
  }

  // Secondary reconciliation by ISSN (only if one side missing)
  if (!ambiguous && abRec && !scRec){
    const issns = extractIssnsFromAbdc(abRec);
    for (const issn of issns){
      const cand = STATE.scopusByIssn.get(normalizeIssnKey(issn));
      if (cand){ scRec = cand; break; }
    }
  }
  if (!ambiguous && scRec && !abRec){
    const issns = extractIssnsFromScopus(scRec);
    for (const issn of issns){
      const cand = STATE.abdcByIssn.get(normalizeIssnKey(issn));
      if (cand){ abRec = cand; break; }
    }
  }

  // False-positive avoidance: if ambiguous, return safest output
  if (ambiguous){
    return {
      input: raw,
      abdc_rating: "na",
      citescore: "#N/A",
      cs_eq: "#N/A",
      top10: "#N/A",
      snip: "#N/A",
      snip_eq: "#N/A",
      sjr: "#N/A",
      sjr_eq: "#N/A",
      sjr_q: "#N/A",
      quick: "na - #N/A - #N/A - #N/A - #N/A",
      note: "Ambiguous title match",
      abdc_candidates: []
    };
  }

  const abdc_rating = (abRec && (abRec.rating_2025 || abRec.abdc_2025_proposed_rating || abRec.abdc_2025_proposed_rating)) ? String(abRec.rating_2025 || abRec.abdc_2025_proposed_rating || abRec.abdc_2025_proposed_rating) : "na";

  if (!scRec){
    // Case 3 or 4
    const quick = `${abdc_rating} - #N/A - #N/A - #N/A - #N/A`;
    return {
      input: raw,
      abdc_rating,
      citescore: "#N/A",
      cs_eq: "#N/A",
      top10: "#N/A",
      snip: "#N/A",
      snip_eq: "#N/A",
      sjr: "#N/A",
      sjr_eq: "#N/A",
      sjr_q: "#N/A",
      quick: abdc_rating==="na" ? "na - #N/A - #N/A - #N/A - #N/A" : quick,
      note: "",
      abdc_candidates: []
    };
  }

  const cs = toNum(scRec.citescore);
  const sn = toNum(scRec.snip);
  const sj = toNum(scRec.sjr);

  const cs_eq = (cs===null) ? "#N/A" : labelForValue(cs, rangesCS);
  const snip_eq = (sn===null) ? "#N/A" : labelForValue(sn, rangesSNIP);
  const sjr_eq = (sj===null) ? "#N/A" : labelForValue(sj, rangesSJR);

  const pct = toNum(scRec.citescore_percentile);
  const top10 = (pct===null) ? "#N/A" : (pct>=90 ? "Yes" : "No");
  const sjr_q = scRec.scopus_quartile ? `Q${scRec.scopus_quartile}` : "na";

  const quick = `${abdc_rating} - ${cs_eq} - ${snip_eq} - ${sjr_eq} - ${sjr_q}`;

  // Secondary validation note: ISSN mismatch (only when ABDC record exists)
  let note = "";
  if (abRec){
    const abIssn = new Set(extractIssnsFromAbdc(abRec).map(normalizeIssnKey).filter(Boolean));
    const scIssn = new Set(extractIssnsFromScopus(scRec).map(normalizeIssnKey).filter(Boolean));
    if (abIssn.size && scIssn.size){
      let overlap = false;
      for (const x of abIssn){ if (scIssn.has(x)) { overlap=true; break; } }
      if (!overlap) note = "ISSN mismatch";
    }
  }

  return {
    input: raw,
    abdc_rating,
    citescore: cs===null ? "#N/A" : cs,
    cs_eq,
    top10,
    snip: sn===null ? "#N/A" : sn,
    snip_eq,
    sjr: sj===null ? "#N/A" : sj,
    sjr_eq,
    sjr_q,
    quick,
    note,
    abdc_candidates
  };
}



function getCurrentLineInfo(textarea){
  const v = textarea.value;
  const pos = textarea.selectionStart || 0;
  const start = v.lastIndexOf("\n", pos-1) + 1;
  let end = v.indexOf("\n", pos);
  if (end === -1) end = v.length;
  const line = v.slice(start, end);
  return {start, end, line};
}

function setLine(textarea, start, end, newLine){
  const v = textarea.value;
  textarea.value = v.slice(0,start) + newLine + v.slice(end);
  const caret = start + newLine.length;
  textarea.setSelectionRange(caret, caret);
}

let _sugTimer = null;


function currentTotalCount(){
  const seen = new Set();

  // manual chips
  if (Array.isArray(STATE.manualNames)){
    for (const x of STATE.manualNames){
      const k = String(x).toLowerCase();
      if (!k) continue;
      if (seen.has(k)) continue;
      seen.add(k);
    }
  }

  // pasted box
  const pasteRaw = String($("journalInput")?.value || "");
  const pasted = pasteRaw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  for (const x of pasted){
    const k = String(x).toLowerCase();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
  }

  // pending typed (Box A) — count it so Compute isn't mysteriously disabled
  const pending = String($("journalTypeInput")?.value || "").trim();
  if (pending){
    const k = pending.toLowerCase();
    if (!seen.has(k)) seen.add(k);
  }

  return seen.size;
}

function setSearchLimitMsg(msg){
  const el = $("searchLimitMsg");
  if (!el) return;
  if (!msg){
    el.style.display = "none";
    el.textContent = "";
  } else {
    el.style.display = "block";
    el.textContent = msg;
  }
}

function updateSearchCounterAndCompute(){
  const n = currentTotalCount();
  const counter = $("searchCounter");
  if (counter){
    counter.textContent = `${n} / 10 journals added`;
    counter.classList.toggle("over", n>10);
  }

  // IMPORTANT: never disable Compute via UI state.
  // Disabling can make the button appear "unclickable" if counts drift or inputs are mid-edit.
  // We enforce the 10-journal limit inside computeAll() with an explicit alert instead.
  const btn = $("btnCompute");
  if (btn){
    btn.disabled = false;
    // Defensive: ensure the button remains clickable even if other UI state
    // temporarily changes pointer-events.
    btn.style.pointerEvents = "auto";
  }

  if (n>10){
    setSearchLimitMsg("Maximum 10 journals allowed. Please remove one before computing.");
  } else {
    setSearchLimitMsg("");
  }

  // Re-assert the click handler defensively.
  ensureComputeWired();
}

// Defensive: keep Compute reliably clickable even if parts of the UI rerender
// or a previous click caused an exception.
function ensureComputeWired(){
  const btn = $("btnCompute");
  if (!btn) return;
  btn.disabled = false;
  btn.style.pointerEvents = "auto";

  // Use onclick (in addition to any addEventListener) so a lost handler is recovered.
  // Wrap in try/catch so an exception doesn't make it appear "not pressable".
  btn.onclick = () => {
    try{
      computeAll();
    }catch(e){
      console.error("Compute failed", e);
      alert(
        "Compute failed due to an internal error. " +
        "Please open DevTools Console and share the error message.\n\n" +
        (e?.message || String(e))
      );
    }
  };
}

function renderManualList(){
  const box = $("manualList");
  if (!box) return;
  const names = Array.isArray(STATE.manualNames) ? STATE.manualNames : [];
  if (!names.length){
    box.innerHTML = "";
    return;
  }
  const tags = names.map((t,i)=>`<span class="manual-tag">${esc(t)}<button type="button" class="tag-x" data-idx="${i}" aria-label="Remove">×</button></span>`).join("");
  box.innerHTML = `<div class="manual-tags">${tags}</div>`;
  box.querySelectorAll(".tag-x").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = Number(btn.getAttribute("data-idx"));
      if (!Number.isFinite(idx)) return;
      STATE.manualNames.splice(idx,1);
      renderManualList();
      updateSearchCounterAndCompute();
    });
  });
}

function addManualName(title){
  const t = String(title||"").trim();
  if (!t) return;
  if (!Array.isArray(STATE.manualNames)) STATE.manualNames = [];
  // de-dupe within manual list (case-insensitive)
  if (STATE.manualNames.some(x=>String(x).toLowerCase()===t.toLowerCase())) return;

  // Hard cap across both inputs: block adding if already 10 unique
  if (currentTotalCount() >= 10){
    setSearchLimitMsg("Maximum 10 journals allowed. Please remove one before adding more.");
    updateSearchCounterAndCompute();
    return;
  }
  STATE.manualNames.push(t);
  renderManualList();
  updateSearchCounterAndCompute();

  // update placeholder after first add
  const inp = $("journalTypeInput");
  if (inp) inp.placeholder = "Type the next journal title if you wish…";
}

let _typeTimer = null;

function updateTypeahead(){
  const inp = $("journalTypeInput");
  const dd = $("typeaheadDropdown");
  if (!inp || !dd) return;

  const raw = String(inp.value||"").trim();
  const q = normalizeTitleForKey(raw);

  if (!raw || q.length < 3){
    dd.style.display = "none";
    dd.innerHTML = "";
    return;
  }

  const candidates = [];
  for (const rec of (STATE.scopusTypeahead || [])){
    const norm = rec.norm;
    if (!norm) continue;

    let score = null;
    if (norm === q) score = 0;
    else if (norm.startsWith(q)) score = 1;
    else {
      const padded = ` ${norm} `;
      const needle = ` ${q} `;
      if (padded.includes(needle)) score = 2;
      else if (norm.includes(q)) score = 3;
    }
    if (score === null) continue;
    candidates.push({ score, len: rec.title.length, title: rec.title });
  }

  if (!candidates.length){
    dd.style.display = "none";
    dd.innerHTML = "";
    return;
  }

  candidates.sort((a,b)=>{
    if (a.score !== b.score) return a.score - b.score;
    if (a.len !== b.len) return a.len - b.len;
    return a.title.localeCompare(b.title);
  });

  const results = candidates.slice(0, 15).map(x=>x.title);

  dd.style.display = "block";
  dd.innerHTML = results.map(t=>`<button type="button" class="typeahead-item" data-title="${esc(t)}">${esc(t)}</button>`).join("");
  dd.querySelectorAll(".typeahead-item").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const t = btn.getAttribute("data-title") || "";
      // click = add
      addManualName(t);
      inp.value = "";
      dd.style.display = "none";
      dd.innerHTML = "";
      inp.focus();
    });
  });
}

function wireTypeahead(){
  const inp = $("journalTypeInput");
  const dd = $("typeaheadDropdown");
  if (!inp || !dd) return;

  const handler = ()=>{
    clearTimeout(_typeTimer);
    _typeTimer = setTimeout(updateTypeahead, 180);
  };
  inp.addEventListener("input", handler);
  inp.addEventListener("focus", handler);

  document.addEventListener("click", (e)=>{
    if (!dd.contains(e.target) && e.target !== inp){
      dd.style.display = "none";
    }
  });

  inp.addEventListener("keydown", (e)=>{
    if (e.key === "Enter"){
      e.preventDefault();
      const val = String(inp.value||"").trim();
      if (val) addManualName(val);
      inp.value = "";
      dd.style.display = "none";
      dd.innerHTML = "";
      inp.focus();
    }
  });
}

function updateSearchSuggestions(){
  const ta = $("journalInput");
  const box = $("searchSuggestions");
  if (!ta || !box) return;

  const {start, end, line} = getCurrentLineInfo(ta);
  const raw = String(line ?? "").trim();
  const q = normalizeTitleForKey(raw);

  // No suggestions for empty / very short / exact matches
  if (!raw || q.length < 4 || STATE.scopusByTitleLower.has(q) || isLikelyIssn(raw)){
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  const k2 = q.slice(0,2);
  const bucket = STATE.scopusIndex2.get(k2) || [];
  if (!bucket.length){
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  // score candidates
  const scored = [];
  for (const cand of bucket){
    const s = diceCoeff(q, cand.norm);
    if (s >= 0.72) scored.push({title: cand.title, score: s});
  }
  scored.sort((a,b)=>b.score-a.score);
  const top = scored.slice(0,5);

  if (!top.length){
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  box.style.display = "flex";
  box.innerHTML = `<span class="sug-label">Did you mean (Scopus):</span>` + top.map(c =>
    `<button type="button" class="sug-pill" data-title="${esc(c.title)}">${esc(c.title)}</button>`
  ).join("");

  box.querySelectorAll(".sug-pill").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const t = btn.getAttribute("data-title") || "";
      setLine(ta, start, end, t);
      box.style.display = "none";
      box.innerHTML = "";
    });
  });
}

function wireSearchSuggestions(){
  const ta = $("journalInput");
  if (!ta) return;
  const handler = ()=>{
    updateSearchCounterAndCompute();
    clearTimeout(_sugTimer);
    _sugTimer = setTimeout(updateSearchSuggestions, 180);
  };
  ta.addEventListener("input", handler);
  ta.addEventListener("click", handler);
  ta.addEventListener("keyup", handler);
}

function renderOutput(){
  const body = $("outputBody");
  body.innerHTML = STATE.outputRows.map((r,ri) => `
    <tr>
      <td>${esc(r.input ?? "")}${r.note ? `<div class="match-note">${esc(r.note)}</div>` : ``}</td>
      <td>${esc(r.quick)}</td>
      <td class="num">${(r.abdc_rating!=="na")
        ? `<b>${esc(r.abdc_rating)}</b>${r.abdc_confirmed ? `<div class="confirm-badge">User-confirmed match</div>` : ``}`
        : `<b>na</b>` + ((r.abdc_candidates && r.abdc_candidates.length)
            ? `<div class="variant-flag">Possible ABDC title variant</div>
               <button type="button" class="btn tinybtn abdc-choose" data-ri="${ri}">Choose ABDC close match</button>
               <div class="abdc-choicebox" id="abdcChoice_${ri}" style="display:none;">
                 ${(r.abdc_candidates||[]).map(c=>`<button type="button" class="sug-pill abdc-pick" data-ri="${ri}" data-title="${esc(c.title)}" data-rating="${esc(c.rating_2025||'')}">${esc(c.title)} <span class="muted">(${esc(c.rating_2025||'')})</span></button>`).join('')}
               </div>`
            : ``)}</td>
      <td class="num">${typeof r.citescore==='number' ? r.citescore.toFixed(2) : esc(r.citescore)}</td>
      <td class="num"><b>${esc(r.cs_eq)}</b></td>
      <td class="num">${esc(r.top10)}</td>
      <td class="num">${typeof r.snip==='number' ? r.snip.toFixed(2) : esc(r.snip)}</td>
      <td class="num"><b>${esc(r.snip_eq)}</b></td>
      <td class="num">${typeof r.sjr==='number' ? r.sjr.toFixed(2) : esc(r.sjr)}</td>
      <td class="num"><b>${esc(r.sjr_eq)}</b></td>
      <td class="num">${esc(r.sjr_q)}</td>
    </tr>
  `).join("");
  
  // Wire ABDC close-match chooser (user-confirmed; no automatic aliasing)
  body.querySelectorAll(".abdc-choose").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const ri = Number(btn.getAttribute("data-ri"));
      const box = document.getElementById(`abdcChoice_${ri}`);
      if (!box) return;
      box.style.display = (box.style.display==="none" || !box.style.display) ? "flex" : "none";
    });
  });
  body.querySelectorAll(".abdc-pick").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const ri = Number(btn.getAttribute("data-ri"));
      const title = btn.getAttribute("data-title") || "";
      const rating = btn.getAttribute("data-rating") || "";
      const row = STATE.outputRows[ri];
      if (!row) return;
      row.abdc_rating = rating || row.abdc_rating;
      row.abdc_confirmed = true;
      // Update quick code first component
      if (row.quick){
        const parts = String(row.quick).split(" - ");
        if (parts.length>=1) parts[0] = row.abdc_rating;
        row.quick = parts.join(" - ");
      }
      // Add note (do not overwrite ISSN mismatch if present)
      if (row.note){
        if (!row.note.includes("User-confirmed")) row.note = row.note + " | User-confirmed title variant";
      } else {
        row.note = "User-confirmed title variant";
      }
      // hide chooser after pick
      const box = document.getElementById(`abdcChoice_${ri}`);
      if (box) box.style.display = "none";
      renderOutput();
    });
  });

$("btnExport").disabled = !ensureSignedIn() || STATE.outputRows.length===0;
// Defensive: output rerenders shouldn't break Compute.
ensureComputeWired();
}

function computeAll(){
  if (!ensureSignedIn()){
    alert("Please sign in with an @ahduni.edu.in email first.");
    return;
  }
  const ok = validateBands(STATE.bands.ulA, STATE.bands.ulB, STATE.bands.ulC);
  if (!ok){
    alert("Invalid percentile bands. Please fix the UL values.");
    return;
  }
  if (!STATE.commonArrays || !STATE.commonArrays.metrics){
    alert("Data is still loading. Please wait a moment and try Compute again.");
    return;
  }
  const names = parseJournalNames();
  if (names.length>10){
    alert("Maximum 10 journals allowed. Please remove extras.");
    return;
  }
  if (names.length===0){
    alert("Enter at least one journal name.");
    return;
  }

  const rangesCS = buildLabelRangesForMetric(STATE.commonArrays.metrics.citescore);
  const rangesSN = buildLabelRangesForMetric(STATE.commonArrays.metrics.snip);
  const rangesSJ = buildLabelRangesForMetric(STATE.commonArrays.metrics.sjr);

  STATE.outputRows = names.map(n => computeOne(n, rangesCS, rangesSN, rangesSJ));
  renderOutput();
  STATE.bandsDirty = false;
  hidePressCompute();
}

function recomputeIfPossible(){
  // Recompute outputs immediately when percentile bands change (no extra click).
  try{
    if (!STATE.commonArrays) return;
    const names = parseJournalNames();
    if (!names || names.length===0) return;

    const ok = validateBands(STATE.bands.ulA, STATE.bands.ulB, STATE.bands.ulC);
    if (!ok) return;

    const rangesCS = buildLabelRangesForMetric(STATE.commonArrays.metrics.citescore);
    const rangesSN = buildLabelRangesForMetric(STATE.commonArrays.metrics.snip);
    const rangesSJ = buildLabelRangesForMetric(STATE.commonArrays.metrics.sjr);

    STATE.outputRows = names.map(n => computeOne(n, rangesCS, rangesSN, rangesSJ));
    renderOutput();
    STATE.bandsDirty = false;
    hidePressCompute();
  }catch(e){
    // Fail silently; band table will still update via updateRangesUI().
    console.warn("recomputeIfPossible failed", e);
  }
}

function makeCSV(){
  const w = STATE.bandWidths || cutoffsToWidths(STATE.bands);
  const ts = new Date().toISOString();

  const rows = [];
  rows.push(["Rateify export",""]);
  rows.push(["User", STATE.user?.email ?? ""]);
  rows.push(["Name", STATE.user?.name ?? ""]);
  rows.push(["Designation", STATE.user?.designation ?? ""]);
  rows.push(["School/Centre", STATE.user?.schoolCentre ?? ""]);
  rows.push(["Version", "2026-01"]);
  rows.push(["Percentile band widths (A*/A/B/C)", `${Math.round(w.Astar)}/${Math.round(w.A)}/${Math.round(w.B)}/${Math.round(w.C)}`]);
  rows.push(["Generated", ts]);
  rows.push(["",""]); // blank row

  const header = [
    "Journal\nname",
    "Quick\ncode",
    "ABDC\nrating",
    "CiteScore",
    "ABDC equivalent\n(CiteScore)",
    "Top 10% CiteScore\npercentile",
    "SNIP",
    "ABDC equivalent\n(SNIP)",
    "SJR",
    "ABDC equivalent\n(SJR)",
    "SJR\nQuartile"
  ];
  rows.push(header);

  for (const r of STATE.outputRows){
    rows.push([
      r.input,
      r.quick,
      r.abdc_rating,
      (typeof r.citescore==="number" ? r.citescore.toFixed(2) : r.citescore),
      r.cs_eq,
      r.top10,
      (typeof r.snip==="number" ? r.snip.toFixed(2) : r.snip),
      r.snip_eq,
      (typeof r.sjr==="number" ? r.sjr.toFixed(2) : r.sjr),
      r.sjr_eq,
      r.sjr_q
    ]);
  }
const escCSV = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)){
      return '"' + s.replace(/"/g,'""') + '"';
    }
    return s;
  };

  return rows.map(row => row.map(escCSV).join(",")).join("\n");
}

async function exportCSV(){
  if (!ensureSignedIn()){
    alert("Please sign in first.");
    return;
  }
  if (!STATE.outputRows.length){
    alert("Nothing to export.");
    return;
  }
  const csv = makeCSV();

  // Optional server-side export (for audit + silent saving)
  // Set window.RATEIFY_EXPORT_ENDPOINT = "/api/export" via Worker if enabled.
  if (window.RATEIFY_EXPORT_ENDPOINT){
    try{
      const res = await fetch(window.RATEIFY_EXPORT_ENDPOINT, {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify({user: STATE.user, bands: STATE.bands, csv})
      });
      if (res.ok){
        const {downloadUrl} = await res.json();
        window.open(downloadUrl, "_blank");
        return;
      }
    }catch(e){}
  }

  // Client-side download (default)
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rateify_export_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


function clamp(n,min,max){return Math.max(min, Math.min(max,n));}

function updatePager(prefix, page, pageCount, totalRows, showingStart, showingEnd){
  const info = document.getElementById(prefix+"PageInfo");
  const prev = document.getElementById(prefix+"Prev");
  const next = document.getElementById(prefix+"Next");
  if (info) info.textContent = totalRows===0 ? "No rows" : `Showing ${showingStart}–${showingEnd} of ${totalRows} (page ${page+1} of ${pageCount})`;
  if (prev) prev.disabled = page<=0;
  if (next) next.disabled = page>=pageCount-1;
}
function switchTab(tabKey){
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab===tabKey));
  document.querySelectorAll(".tabpanel").forEach(p => p.classList.remove("active"));
  $("tab-"+tabKey).classList.add("active");

  // Ensure correlation plots lay out correctly when the tab becomes visible.
  if (tabKey === "corr"){
    try {
      renderCorrelation();
      renderCorrPlots();
	    }
	    catch (e){}
  }
}

function wireTabs(){
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", (e) => {
      // Clicking the (i) inside Search tab should open modal, not switch tabs.
      const t = e.target;
      switchTab(btn.dataset.tab);
    });
  });
}


function wireBands(){
  // Ensure the editable bands table (and its UL inputs) exist before wiring events.
  renderBandsTable();

  const setBandStateFromWidths = (widths) => {
    // store user-facing widths (may not sum to 100)
    STATE.bandWidths = { ...widths };
    // compute internal cutoffs from normalized widths
    const cut = widthsToCutoffs(widths);
    STATE.bands.ulA = cut.ulA;
    STATE.bands.ulB = cut.ulB;
    STATE.bands.ulC = cut.ulC;
    // reflect cutoffs in inputs (rounded for UI)
    $("ul_a").value = String(Math.round(STATE.bands.ulA));
    $("ul_b").value = String(Math.round(STATE.bands.ulB));
    $("ul_c").value = String(Math.round(STATE.bands.ulC));
    updateRangesUI();
  };

  const applyPreset = (preset) => {
    if (preset === "default"){
      setBandStateFromWidths({Astar:25, A:25, B:25, C:25});
    } else if (preset === "alt1"){
      setBandStateFromWidths({Astar:10, A:30, B:30, C:30});
    } else if (preset === "alt2"){
      setBandStateFromWidths({Astar:10, A:20, B:30, C:40});
    }
  };

  $("presetBands").addEventListener("change", e => {
    const v = e.target.value;
    if (v === "custom"){
      STATE.bandsDirty = true;
      showPressCompute();
      return;
    }
    applyPreset(v);
    STATE.bandsDirty = true;
    showPressCompute();
  });

  ["ul_a","ul_b","ul_c"].forEach(id => {
    $(id).addEventListener("input", () => {
      // user edited cutoffs; derive widths for display/export
      STATE.bands.ulA = Number($("ul_a").value);
      STATE.bands.ulB = Number($("ul_b").value);
      STATE.bands.ulC = Number($("ul_c").value);
      STATE.bandWidths = cutoffsToWidths(STATE.bands);
      $("presetBands").value = "custom";
      updateRangesUI();
      STATE.bandsDirty = true;
      showPressCompute();
      recomputeIfPossible();
    });
  });
  // Percentile +/- buttons (mobile-friendly)
  document.querySelectorAll(".pct-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const delta = Number(btn.getAttribute("data-delta") || 0);
      const wrap = btn.closest(".pct-stepper");
      if (!wrap) return;
      const inp = wrap.querySelector('input[type="number"]');
      if (!inp) return;

      const min = inp.min !== "" ? Number(inp.min) : -Infinity;
      const max = inp.max !== "" ? Number(inp.max) : Infinity;
      const step = inp.step && inp.step !== "any" ? Number(inp.step) : 1;

      let v = Number(inp.value);
      if (!Number.isFinite(v)) v = 0;
      v = v + delta * step;
      v = Math.min(max, Math.max(min, v));
      inp.value = String(v);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });



  applyPreset("default");
}
function wireSearch(){
  $("btnSignIn").addEventListener("click", signIn);
  $("btnCompute").addEventListener("click", computeAll);
  ensureComputeWired();
  $("btnExport").addEventListener("click", exportCSV);
  // Keep counter + Compute enabled state in sync with inputs
  const ji = $("journalInput");
  if (ji){
    ji.addEventListener("input", () => {
      updateSearchCounterAndCompute();
      // refresh suggestions on edit
      if (typeof renderPasteSuggestions === "function") renderPasteSuggestions();
    });
  }
  const jt = $("journalTypeInput");
  if (jt){
    jt.addEventListener("input", () => {
      updateSearchCounterAndCompute();
    });
  }

  // initial state
  updateSearchCounterAndCompute();
}

function getABDCViewList(){
  // ABDC view used for percentile-calibrated display: 1702 common journals (ABDC 2025 JQL titles matched to Scopus canonical)
  return STATE.abdcCommon1702 || [];
}
function wireSortableTable(tableId, onSort){
  const t = document.getElementById(tableId);
  if (!t) return;
  const ths = Array.from(t.querySelectorAll('thead th'));
  ths.forEach((th, idx)=>{
    th.addEventListener('click', ()=>onSort(idx));
  });
}
function renderABDCList(filter=""){
  const q = filter.trim().toLowerCase();
  let src = getABDCViewList();

  // Sorting: index maps to columns EXCLUDING S# (which is fixed/sticky)
  const sortIdx = STATE.abdcSortIdx ?? 0;
  const sortDir = STATE.abdcSortDir ?? 1;
  const keyMap = ['title','rating_2022','rating_2025','citescore','snip','sjr','publisher','issn_print','issn_online','year_inception','for','recommendation'];
  const k = keyMap[sortIdx] || 'title';

  function metricFor(r, key){
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    if (!rec) return null;
    const v = rec[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function getSortVal(r){
    if (k === 'citescore') return metricFor(r,'citescore');
    if (k === 'snip') return metricFor(r,'snip');
    if (k === 'sjr') return metricFor(r,'sjr');
    // numeric-ish fields
    if (k === 'year_inception'){
      const n = Number(r.year_inception);
      return Number.isFinite(n) ? n : null;
    }
    return String(r[k] ?? '');
  }

  src = src.slice().sort((a,b)=>{
    const av = getSortVal(a);
    const bv = getSortVal(b);
    const an = Number(av), bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sortDir*(an-bn);
    return sortDir*String(av??'').localeCompare(String(bv??''), undefined, {sensitivity:'base'});
  });

  const filtered = !q ? src : src.filter(r => {
    const t = String(r.title ?? "").toLowerCase();
    const i = String(r.issn_print ?? "").toLowerCase();
    const e = String(r.issn_online ?? "").toLowerCase();
    return t.includes(q) || i.includes(q) || e.includes(q);
  });

  const totalRows = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  STATE.abdcPage = clamp(STATE.abdcPage||0, 0, pageCount-1);
  const startIdx = (STATE.abdcPage) * PAGE_SIZE;
  const endIdx = Math.min(totalRows, startIdx + PAGE_SIZE);
  const rows = filtered.slice(startIdx, endIdx);

  function fmtMetric(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    // trim trailing zeros
    return (Math.round(n*100)/100).toFixed(2).replace(/\.?0+$/,'');
  }

  $("abdcBody").innerHTML = rows.map((r, idx) => {
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    const cs = rec ? fmtMetric(rec.citescore) : "ERR";
    const sn = rec ? fmtMetric(rec.snip) : "ERR";
    const sj = rec ? fmtMetric(rec.sjr) : "ERR";

    return `
      <tr>
        <td class="scol">${STATE.abdcViewSerialByTitleKey.get(normalizeTitleForKey(r.title)) ?? ""}</td>
        <td>${esc(r.title)}</td>
        <td class="num"><b>${esc(r.rating_2022 ?? "")}</b></td>
        <td class="num"><b>${esc(r.rating_2025 ?? "")}</b></td>
        <td class="num">${cs === "ERR" ? "ERR" : esc(cs)}</td>
        <td class="num">${sn === "ERR" ? "ERR" : esc(sn)}</td>
        <td class="num">${sj === "ERR" ? "ERR" : esc(sj)}</td>
        <td>${esc(r.publisher ?? "")}</td>
        <td class="num">${esc(r.issn_print ?? "")}</td>
        <td class="num">${esc(r.issn_online ?? "")}</td>
        <td class="num">${esc(r.year_inception ?? "")}</td>
        <td class="num">${esc(r.for ?? "")}</td>
        <td>${esc(r.recommendation ?? "")}</td>
      </tr>
    `;
  }).join("");

  const total = src.length;
  $("abdcCount").textContent = `Total ${total} (ABDC 2025 JQL). Percentile calibration uses the ABDC–Scopus matched subset (N=1702).`;
  updatePager("abdc", STATE.abdcPage, pageCount, totalRows, totalRows?startIdx+1:0, endIdx);

}



function renderRemovedList(filter=""){
  const q = filter.trim().toLowerCase();
  let src = STATE.abdc2025Removed || [];

  const sortIdx = STATE.removedSortIdx ?? 0;
  const sortDir = STATE.removedSortDir ?? 1;
  const keyMap = ['title','rating_2022','rating_2025','citescore','snip','sjr','publisher','issn_print','issn_online','year_inception','for','recommendation'];
  const k = keyMap[sortIdx] || 'title';

  function metricFor(r, key){
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    if (!rec) return null;
    const v = rec[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function getSortVal(r){
    if (k === 'citescore') return metricFor(r,'citescore');
    if (k === 'snip') return metricFor(r,'snip');
    if (k === 'sjr') return metricFor(r,'sjr');
    if (k === 'year_inception'){
      const n = Number(r.year_inception);
      return Number.isFinite(n) ? n : null;
    }
    return String(r[k] ?? '');
  }

  src = src.slice().sort((a,b)=>{
    const av=getSortVal(a), bv=getSortVal(b);
    const an=Number(av), bn=Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sortDir*(an-bn);
    return sortDir*String(av??'').localeCompare(String(bv??''), undefined, {sensitivity:'base'});
  });

  const filtered = !q ? src : src.filter(r => {
    const t = String(r.title ?? "").toLowerCase();
    const i = String(r.issn_print ?? "").toLowerCase();
    const e = String(r.issn_online ?? "").toLowerCase();
    return t.includes(q) || i.includes(q) || e.includes(q);
  });

  const totalRows = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  STATE.removedPage = clamp(STATE.removedPage||0, 0, pageCount-1);
  const startIdx = (STATE.removedPage) * PAGE_SIZE;
  const endIdx = Math.min(totalRows, startIdx + PAGE_SIZE);
  const rows = filtered.slice(startIdx, endIdx);

  function fmtMetric(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return (Math.round(n*100)/100).toFixed(2).replace(/\.?0+$/,'');
  }

  $("abdcRemoveBody").innerHTML = rows.map((r) => {
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    const cs = rec ? fmtMetric(rec.citescore) : "ERR";
    const sn = rec ? fmtMetric(rec.snip) : "ERR";
    const sj = rec ? fmtMetric(rec.sjr) : "ERR";
    const serial = (src.findIndex(x => normalizeTitleForKey(x.title)===normalizeTitleForKey(r.title)) + 1);

    return `
      <tr>
        <td class="scol">${serial}</td>
        <td>${esc(r.title)}</td>
        <td class="num"><b>${esc(r.rating_2022 ?? "")}</b></td>
        <td class="num"><b>${esc(r.rating_2025 ?? "")}</b></td>
        <td class="num">${cs === "ERR" ? "ERR" : esc(cs)}</td>
        <td class="num">${sn === "ERR" ? "ERR" : esc(sn)}</td>
        <td class="num">${sj === "ERR" ? "ERR" : esc(sj)}</td>
        <td>${esc(r.publisher ?? "")}</td>
        <td class="num">${esc(r.issn_print ?? "")}</td>
        <td class="num">${esc(r.issn_online ?? "")}</td>
        <td class="num">${esc(r.year_inception ?? "")}</td>
        <td class="num">${esc(r.for ?? "")}</td>
        <td>${esc(r.recommendation ?? "")}</td>
      </tr>
    `;
  }).join("");

  $("abdcRemoveCount").textContent = `Total ${src.length}.`;
  updatePager("abdcRemove", STATE.removedPage, pageCount, totalRows, totalRows?startIdx+1:0, endIdx);
}

function renderScopusList(filter=""){
  const q = filter.trim().toLowerCase();
  const sortIdx = STATE.scopusSortIdx ?? 0;
  const sortDir = STATE.scopusSortDir ?? 1;
  const keyMap = ['title','issn_print_fmt','issn_e_fmt','citescore','snip','sjr','sjr_quartile'];
  const k = keyMap[sortIdx] || 'title';
  const sorted = STATE.scopus.slice().sort((a,b)=>{
    const av=a[k], bv=b[k];
    const an=Number(av), bn=Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sortDir*(an-bn);
    return sortDir*String(av??'').localeCompare(String(bv??''), undefined, {sensitivity:'base'});
  });
  const filtered = !q ? sorted : sorted.filter(r => {
    const t = String(r.title ?? "").toLowerCase();
    const i = String(r.issn_print_fmt ?? "").toLowerCase();
    const e = String(r.issn_e_fmt ?? "").toLowerCase();
    return t.includes(q) || i.includes(q) || e.includes(q);
  });

  const totalRows = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  STATE.scopusPage = clamp(STATE.scopusPage||0, 0, pageCount-1);
  const startIdx = (STATE.scopusPage) * PAGE_SIZE;
  const endIdx = Math.min(totalRows, startIdx + PAGE_SIZE);
  const rows = filtered.slice(startIdx, endIdx);

  $("scopusBody").innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.title)}</td>
      <td class="num">${esc(r.issn_print_fmt ?? "")}</td>
      <td class="num">${esc(r.issn_e_fmt ?? "")}</td>
      <td class="num">${toNum(r.citescore)===null ? "" : toNum(r.citescore).toFixed(2)}</td>
      <td class="num">${toNum(r.snip)===null ? "" : toNum(r.snip).toFixed(2)}</td>
      <td class="num">${toNum(r.sjr)===null ? "" : toNum(r.sjr).toFixed(2)}</td>
      <td class="num">${r.scopus_quartile ? "Q"+r.scopus_quartile : ""}</td>
    </tr>
  `).join("");
  $("scopusCount").textContent = `Total ${sorted.length}.`;
  updatePager("scopus", STATE.scopusPage, pageCount, totalRows, totalRows?startIdx+1:0, endIdx);

}

function wireDBSearch(){
  $("abdcSearch").addEventListener("input", e => { STATE.abdcPage = 0; renderABDCList(e.target.value); });
  $("scopusSearch").addEventListener("input", e => { STATE.scopusPage = 0; renderScopusList(e.target.value); });
  const rs = document.getElementById("abdcRemoveSearch");
  if (rs) rs.addEventListener("input", e => { STATE.removedPage = 0; renderRemovedList(e.target.value); });

  // Pagination buttons
  const ap = document.getElementById("abdcPrev"); const an = document.getElementById("abdcNext");
  if (ap) ap.addEventListener("click", ()=>{ STATE.abdcPage = Math.max(0,(STATE.abdcPage||0)-1); renderABDCList($("abdcSearch").value||""); });
  if (an) an.addEventListener("click", ()=>{ STATE.abdcPage = (STATE.abdcPage||0)+1; renderABDCList($("abdcSearch").value||""); });

  const sp = document.getElementById("scopusPrev"); const sn = document.getElementById("scopusNext");
  if (sp) sp.addEventListener("click", ()=>{ STATE.scopusPage = Math.max(0,(STATE.scopusPage||0)-1); renderScopusList($("scopusSearch").value||""); });
  if (sn) sn.addEventListener("click", ()=>{ STATE.scopusPage = (STATE.scopusPage||0)+1; renderScopusList($("scopusSearch").value||""); });

  // Remove-list pagination controls (separate tab)
  const rpp = document.getElementById("abdcRemovePrev");
  const rnn = document.getElementById("abdcRemoveNext");
  if (rpp) rpp.addEventListener("click", ()=>{ STATE.removedPage = Math.max(0,(STATE.removedPage||0)-1); renderRemovedList(rs ? (rs.value||"") : ""); });
  if (rnn) rnn.addEventListener("click", ()=>{ STATE.removedPage = (STATE.removedPage||0)+1; renderRemovedList(rs ? (rs.value||"") : ""); });
}


function renderCorrelation(){
  if (!STATE.corrData) return;
  const p = STATE.corrData.pearson;

  // Correlation-matrix UI is optional (may be removed in some builds).
  const corrSummaryEl = document.getElementById("corrSummary");
  if (corrSummaryEl) corrSummaryEl.textContent = `N (complete cases): ${STATE.corrData.n}.`;

  const corrMatrixEl = document.getElementById("corrMatrix");
  if (corrMatrixEl){
    corrMatrixEl.innerHTML = `
      <thead>
        <tr><th></th><th>CiteScore</th><th>SNIP</th><th>SJR</th></tr>
      </thead>
      <tbody>
        <tr><td><b>CiteScore</b></td><td class="num">1.000</td><td class="num">${p.cs_snip.toFixed(3)}</td><td class="num">${p.cs_sjr.toFixed(3)}</td></tr>
        <tr><td><b>SNIP</b></td><td class="num">${p.cs_snip.toFixed(3)}</td><td class="num">1.000</td><td class="num">${p.snip_sjr.toFixed(3)}</td></tr>
        <tr><td><b>SJR</b></td><td class="num">${p.cs_sjr.toFixed(3)}</td><td class="num">${p.snip_sjr.toFixed(3)}</td><td class="num">1.000</td></tr>
      </tbody>
    `;
  }

  // Render static scatter plots (trim extreme outliers for readability).
  try {
    renderCorrPlots();
  } catch (e){
    // ignore
  }
}

function computePearsonCorr(xs, ys){
  const n = xs.length;
  if (n === 0) return NaN;
  let sumX=0, sumY=0;
  for (let i=0;i<n;i++){ sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX/n, meanY=sumY/n;
  let num=0, denX=0, denY=0;
  for (let i=0;i<n;i++){
    const dx = xs[i]-meanX, dy = ys[i]-meanY;
    num += dx*dy;
    denX += dx*dx;
    denY += dy*dy;
  }
  const den = Math.sqrt(denX*denY);
  return den === 0 ? NaN : (num/den);
}

function computeCorrelationsFromScopus(){
  const cs=[], sn=[], sj=[];
  for (const r of STATE.scopus){
    const a = toNum(r.citescore);
    const b = toNum(r.snip);
    const c = toNum(r.sjr);
    if (a!==null && b!==null && c!==null){
      cs.push(a); sn.push(b); sj.push(c);
    }
  }
  const n = cs.length;
  STATE.corrData = {
    n,
    // store full arrays (complete cases) for plotting without sampling
    cs,
    sn,
    sj,
    pearson: {
      cs_snip: computePearsonCorr(cs, sn),
      cs_sjr: computePearsonCorr(cs, sj),
      snip_sjr: computePearsonCorr(sn, sj),
    }
  };
}


function secondLargestDistinct(arr){
  // returns {max, max2}; max2 is second-largest distinct, or max if not available
  let max = -Infinity;
  let max2 = -Infinity;
  for (const v of arr){
    if (!Number.isFinite(v)) continue;
    if (v > max){
      max2 = max;
      max = v;
    } else if (v < max && v > max2){
      max2 = v;
    }
  }
  if (max2 === -Infinity) max2 = max;
  return {max, max2};
}

function drawStaticScatter(canvasId, xs, ys, xLabel, yLabel){
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Trim scale by ignoring a single extreme high outlier (use 2nd-largest distinct)
  const {max: xMax, max2: xMax2} = secondLargestDistinct(xs);
  const {max: yMax, max2: yMax2} = secondLargestDistinct(ys);

  // Filter points within trimmed bounds (keeps almost all points, drops only the extreme)
  const xf=[], yf=[];
  for (let i=0;i<xs.length;i++){
    const x=xs[i], y=ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x <= xMax2 && y <= yMax2){
      xf.push(x); yf.push(y);
    }
  }

  const n = xf.length;

  // Bounds (include 0 for nicer scaling)
  const xMin = 0;
  const yMin = 0;
  const xHi = Math.max(xMax2, 1e-6);
  const yHi = Math.max(yMax2, 1e-6);

  // Layout
  const padL = 55, padR = 18, padT = 22, padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  function xPix(x){ return padL + (x - xMin) * (plotW / (xHi - xMin)); }
  function yPix(y){ return padT + plotH - (y - yMin) * (plotH / (yHi - yMin)); }

  // Clear
  ctx.clearRect(0,0,W,H);

  // Background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,W,H);

  // Axes
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT+plotH);
  ctx.lineTo(padL+plotW, padT+plotH);
  ctx.stroke();

  // Ticks
  ctx.fillStyle = '#333';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  const ticks = 5;
  ctx.strokeStyle = '#e6e6e6';
  ctx.lineWidth = 1;

  for (let t=0;t<=ticks;t++){
    const frac = t/ticks;
    const xVal = xMin + frac*(xHi-xMin);
    const yVal = yMin + frac*(yHi-yMin);

    const xp = padL + frac*plotW;
    const yp = padT + plotH - frac*plotH;

    // vertical grid
    ctx.beginPath(); ctx.moveTo(xp, padT); ctx.lineTo(xp, padT+plotH); ctx.stroke();
    // horizontal grid
    ctx.beginPath(); ctx.moveTo(padL, yp); ctx.lineTo(padL+plotW, yp); ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.fillText(xVal.toFixed(1), xp-10, padT+plotH+18);
    ctx.fillText(yVal.toFixed(1), 6, yp+4);
  }

  // Labels
  ctx.fillStyle = '#111';
  ctx.font = '13px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText(xLabel, padL + plotW/2 - ctx.measureText(xLabel).width/2, H-12);

  // y label rotated
  ctx.save();
  ctx.translate(14, padT + plotH/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillText(yLabel, -ctx.measureText(yLabel).width/2, 0);
  ctx.restore();

  // Points
  ctx.fillStyle = 'rgba(255,0,0,0.20)';
  for (let i=0;i<n;i++){
    const xp = xPix(xf[i]);
    const yp = yPix(yf[i]);
    // small dot
    ctx.fillRect(xp, yp, 2, 2);
  }

  return {n, xHi, yHi, dropped: xs.length - n};
}

function renderCorrPlots(){
  if (!STATE.corrData) return;

  const cs = STATE.corrData.cs;
  const sn = STATE.corrData.sn;
  const sj = STATE.corrData.sj;

  // Section title with N
  const st = document.getElementById('scatterTitle');
  if (st){
    st.textContent = `Scatter plots and Pearson's correlation coefficient`;
  }

  // Draw 3 static plots (trim extreme outlier for viewing)
  const r1 = drawStaticScatter('plot_cs_snip', cs, sn, 'CiteScore', 'SNIP');
  const r2 = drawStaticScatter('plot_cs_sjr',  cs, sj, 'CiteScore', 'SJR');
  const r3 = drawStaticScatter('plot_snip_sjr', sn, sj, 'SNIP', 'SJR');

  // r-value pills (computed on complete cases; matches matrix values)
  const p = STATE.corrData.pearson;
  const pill1 = document.getElementById('r_cs_snip'); if (pill1) pill1.textContent = `r=${p.cs_snip.toFixed(3)}`;
  const pill2 = document.getElementById('r_cs_sjr'); if (pill2) pill2.textContent = `r=${p.cs_sjr.toFixed(3)}`;
  const pill3 = document.getElementById('r_snip_sjr'); if (pill3) pill3.textContent = `r=${p.snip_sjr.toFixed(3)}`;

  // Update N labels next to plot titles
  const n1 = document.getElementById('n_cs_snip'); if (n1 && r1) n1.textContent = `(N=${r1.n})`;
  const n2 = document.getElementById('n_cs_sjr');  if (n2 && r2) n2.textContent = `(N=${r2.n})`;
  const n3 = document.getElementById('n_snip_sjr'); if (n3 && r3) n3.textContent = `(N=${r3.n})`;
}


// Load all required JSON assets for the app.
// NOTE: must be a plain function (not an object parameter) so the file parses correctly.
function showDataErrorBanner(msg){
  const el = document.getElementById('dataErrorBanner');
  if (el){ el.textContent = msg; el.style.display='block'; }
}



function normalizeWidths(widths){
  // widths: {Astar,A,B,C}. For presets, we want clean 0–100 boundaries.
  // If the sum is not 100, we treat A*/A/B as fixed and set C to the remainder.
  // (If remainder would be negative, fall back to proportional normalization.)
  const Astar = Number(widths.Astar||0);
  const A = Number(widths.A||0);
  const B = Number(widths.B||0);
  const C_in = Number(widths.C||0);
  const sum = Astar + A + B + C_in;

  if (!sum || sum <= 0) return {Astar:25, A:25, B:25, C:25, _factor:1};

  if (Math.abs(sum - 100) < 1e-9){
    return {Astar, A, B, C: C_in, _factor:1};
  }

  // Prefer "remainder" behaviour (keeps A*/A/B intuitive)
  const C = 100 - (Astar + A + B);
  if (C >= 0){
    return {Astar, A, B, C, _factor:1, _remainderAdjusted:true};
  }

  // Otherwise, proportional normalization (rare; e.g., A*/A/B already exceed 100)
  const factor = 100 / sum;
  return {
    Astar: Astar*factor,
    A: A*factor,
    B: B*factor,
    C: C_in*factor,
    _factor: factor,
    _normalized:true
  };
}

function widthsToCutoffs(widths){
  // Convert widths (top-down A*/A/B/C) into cumulative cutoffs from bottom (ulC, ulB, ulA)
  const w = normalizeWidths(widths);
  const ulC = w.C;
  const ulB = w.C + w.B;
  const ulA = w.C + w.B + w.A;
  return { ulA, ulB, ulC };
}

function cutoffsToWidths(bands){
  // Convert cutoffs into widths (A*/A/B/C)
  const ulA = Number(bands.ulA), ulB = Number(bands.ulB), ulC = Number(bands.ulC);
  const C = Math.max(0, Math.min(100, ulC));
  const B = Math.max(0, Math.min(100, ulB) - C);
  const A = Math.max(0, Math.min(100, ulA) - (C+B));
  const Astar = Math.max(0, 100 - (C+B+A));
  return {Astar, A, B, C};
}

function fmtWidthsSlash(w){
  // Display as widths in A*/A/B/C order: e.g., 25/25/25/25
  const r = (x)=> String(Math.round(x));
  return `${r(w.Astar)}/${r(w.A)}/${r(w.B)}/${r(w.C)}`;
}
function toNum(v){
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase()==='na' || s.toLowerCase()==='#n/a' || s.toLowerCase()==='n/a') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function labelForValue(value, ranges){
  if (value === null) return "#N/A";
  for (const r of ranges){
    if (value >= r.ll && value < r.ul) return r.label;
  }
  // include upper edge
  const last = ranges[ranges.length-1];
  if (last && value >= last.ll && (last.ul === Infinity || value <= last.ul)) return last.label;
  return "#N/A";
}

function computePercentileValue(sortedArr, p){
  // p in [0,100]
  if (!sortedArr || sortedArr.length===0) return null;
  const n = sortedArr.length;
  if (p <= 0) return sortedArr[0];
  if (p >= 100) return sortedArr[n-1];
  const q = p/100;
  const idx = (n-1)*q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo]*(1-w) + sortedArr[hi]*w;
}

function bandsToRanges(ulA, ulB, ulC){
  // descending labels: A*, A, B, C with percentiles
  // A*: [ulA,100], A: [ulB,ulA], B:[ulC,ulB], C:[0,ulC]
  return [
    {label:"A*", pll: ulA, pul:100},
    {label:"A",  pll: ulB, pul: ulA},
    {label:"B",  pll: ulC, pul: ulB},
    {label:"C",  pll: 0,   pul: ulC}
  ];
}

function validateBands(ulA, ulB, ulC){
  return (0 < ulC && ulC < ulB && ulB < ulA && ulA < 100);
}

function updateBandLLLabels(){
  const {ulA, ulB, ulC} = STATE.bands;
  const aStar = document.getElementById("ll_astar");
  const a = document.getElementById("ll_a");
  const b = document.getElementById("ll_b");
  if (aStar) aStar.textContent = String(Math.round(ulA));
  if (a) a.textContent = String(Math.round(ulB));
  if (b) b.textContent = String(Math.round(ulC));
}

// Build the editable percentile bands table (Label / LL / UL).
// This table also contains the UL number inputs (ul_a / ul_b / ul_c)
// that are used by wireBands().
function renderBandsTable(){
  const el = document.getElementById("bandsTable");
  if (!el) return;

  // One merged table: Editable percentile bands + CiteScore/SNIP/SJR value ranges.
  // Keeping IDs (ul_a/ul_b/ul_c, ll_*) so wireBands() and updateBandLLLabels() continue to work.
  el.innerHTML = `
    <colgroup>
      <col class="c-eb-label"><col class="c-eb-ll"><col class="c-eb-ul">
      <col class="c-cs-label"><col class="c-cs-ll"><col class="c-cs-ul">
      <col class="c-snip-label"><col class="c-snip-ll"><col class="c-snip-ul">
      <col class="c-sjr-label"><col class="c-sjr-ll"><col class="c-sjr-ul">
    </colgroup>
    <thead>
      <tr class="mega-groups">
        <th colspan="3" class="mega-group">Editable percentile bands</th>
        <th colspan="3" class="mega-group cs">CiteScore ranges</th>
        <th colspan="3" class="mega-group snip">SNIP ranges</th>
        <th colspan="3" class="mega-group sjr">SJR ranges</th>
      </tr>
      <tr class="mega-cols">
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
        <th>Label</th><th class="num">LL</th><th class="num">UL</th>
      </tr>
    </thead>
    <tbody>
      <tr class="r-Astar">
        <td><b>A*</b></td>
        <td class="num" id="ll_astar">${Math.round(STATE.bands.ulA)}</td>
        <td class="num">100</td>

        <td><b>A*</b></td><td class="num" id="cs_ll_astar">–</td><td class="num" id="cs_ul_astar">–</td>
        <td><b>A*</b></td><td class="num" id="snip_ll_astar">–</td><td class="num" id="snip_ul_astar">–</td>
        <td><b>A*</b></td><td class="num" id="sjr_ll_astar">–</td><td class="num" id="sjr_ul_astar">–</td>
      </tr>

      <tr class="r-A">
        <td><b>A</b></td>
        <td class="num" id="ll_a">${Math.round(STATE.bands.ulB)}</td>
        <td class="num">
          <div class="pct-stepper">
            <button type="button" class="pct-btn" data-delta="-1" aria-label="Decrease A upper bound">−</button>
            <input id="ul_a" type="number" min="1" max="99" step="1" value="${Math.round(STATE.bands.ulA)}" />
            <button type="button" class="pct-btn" data-delta="+1" aria-label="Increase A upper bound">+</button>
          </div>
        </td>

        <td><b>A</b></td><td class="num" id="cs_ll_a">–</td><td class="num" id="cs_ul_a">–</td>
        <td><b>A</b></td><td class="num" id="snip_ll_a">–</td><td class="num" id="snip_ul_a">–</td>
        <td><b>A</b></td><td class="num" id="sjr_ll_a">–</td><td class="num" id="sjr_ul_a">–</td>
      </tr>

      <tr class="r-B">
        <td><b>B</b></td>
        <td class="num" id="ll_b">${Math.round(STATE.bands.ulC)}</td>
        <td class="num">
          <div class="pct-stepper">
            <button type="button" class="pct-btn" data-delta="-1" aria-label="Decrease B upper bound">−</button>
            <input id="ul_b" type="number" min="1" max="99" step="1" value="${Math.round(STATE.bands.ulB)}" />
            <button type="button" class="pct-btn" data-delta="+1" aria-label="Increase B upper bound">+</button>
          </div>
        </td>

        <td><b>B</b></td><td class="num" id="cs_ll_b">–</td><td class="num" id="cs_ul_b">–</td>
        <td><b>B</b></td><td class="num" id="snip_ll_b">–</td><td class="num" id="snip_ul_b">–</td>
        <td><b>B</b></td><td class="num" id="sjr_ll_b">–</td><td class="num" id="sjr_ul_b">–</td>
      </tr>

      <tr class="r-C">
        <td><b>C</b></td>
        <td class="num" id="ll_c">0</td>
        <td class="num">
          <div class="pct-stepper">
            <button type="button" class="pct-btn" data-delta="-1" aria-label="Decrease C upper bound">−</button>
            <input id="ul_c" type="number" min="1" max="99" step="1" value="${Math.round(STATE.bands.ulC)}" />
            <button type="button" class="pct-btn" data-delta="+1" aria-label="Increase C upper bound">+</button>
          </div>
        </td>

        <td><b>C</b></td><td class="num" id="cs_ll_c">–</td><td class="num" id="cs_ul_c">–</td>
        <td><b>C</b></td><td class="num" id="snip_ll_c">–</td><td class="num" id="snip_ul_c">–</td>
        <td><b>C</b></td><td class="num" id="sjr_ll_c">–</td><td class="num" id="sjr_ul_c">–</td>
      </tr>
    </tbody>
  `;
}

function buildValueRanges(metricKey, sortedArr){
  const {ulA, ulB, ulC} = STATE.bands;
  // Display in the same top-down order as the editable table: A*, A, B, C
  const pct = bandsToRanges(ulA, ulB, ulC);
  // convert percentile bands to value LL/UL
  const rows = pct.map(b => {
    const vll = computePercentileValue(sortedArr, b.pll);
    // For the top band (A*), we keep the upper bound open-ended for classification,
    // but we still compute a display UL as the max of the matched set.
    const vul_display = computePercentileValue(sortedArr, b.pul);
    const vul = (b.label === "A*") ? null : vul_display;
    return {
      label: b.label,
      pll: b.pll, pul: b.pul,
      ll: vll ?? null,
      ul: vul ?? null,
      ul_display: vul_display ?? (vul ?? null)
    };
  });
  return rows;
}

function renderMiniRangeTable(tableEl, rows, palette){
  tableEl.innerHTML = `
    <thead>
      <tr><th>Label</th><th>LL</th><th>UL</th></tr>
    </thead>
    <tbody>
      ${rows.map(r => `
        <tr class="r-${r.label.replace('*','star')}">
          <td><b>${esc(r.label)}</b></td>
          <td class="num">${r.ll===null ? "#N/A" : r.ll.toFixed(2)}</td>
          <td class="num">${(r.ul_display===null || r.ul_display===undefined) ? "—" : r.ul_display.toFixed(2)}</td>
        </tr>
      `).join("")}
    </tbody>
  `;
}


function showPressCompute(){
  const el = $("pressCompute");
  if (el) el.style.display = "block";
  const btn = $("btnCompute");
  // Visual cue: when bands change, highlight Compute.
  if (btn) btn.classList.add("primary");
}
function hidePressCompute(){
  const el = $("pressCompute");
  if (el) el.style.display = "none";
  const btn = $("btnCompute");
  // Remove highlight once user recomputes.
  if (btn) btn.classList.remove("primary");
}
function fillMetricCells(prefix, rows){
  const map = {"A*":"astar","A":"a","B":"b","C":"c"};
  const fmt = (v) => {
    if (v === null || v === undefined || (typeof v === "number" && !isFinite(v))) return "#N/A";
    const n = (typeof v === "number") ? v : Number(v);
    if (!isFinite(n)) return "#N/A";
    return n.toFixed(2);
  };
  for (const r of rows){
    const key = map[r.label];
    if (!key) continue;
    const llEl = document.getElementById(`${prefix}_ll_${key}`);
    const ulEl = document.getElementById(`${prefix}_ul_${key}`);
    if (llEl) llEl.textContent = fmt(r.ll);
    if (ulEl) ulEl.textContent = fmt((r.ul_display!==undefined && r.ul_display!==null) ? r.ul_display : r.ul);
  }
}


function updateRangesUI(){
  updateBandLLLabels();

  const ok = validateBands(STATE.bands.ulA, STATE.bands.ulB, STATE.bands.ulC);
  const msgEl = $("bandsMsg");
  if (msgEl) msgEl.textContent = ok ? "" : "Percentiles must satisfy: 0 < C < B < A < 100.";
  if (!ok || !STATE.commonArrays) return;

  const csRows = buildValueRanges("citescore", STATE.commonArrays.metrics.citescore);
  const snRows = buildValueRanges("snip", STATE.commonArrays.metrics.snip);
  const sjRows = buildValueRanges("sjr", STATE.commonArrays.metrics.sjr);

  fillMetricCells("cs", csRows);
  fillMetricCells("snip", snRows);
  fillMetricCells("sjr", sjRows);

  // policy note
  const {ulA, ulB, ulC} = STATE.bands;
  $("policyNote").textContent = `Percentile band widths used (A*/A/B/C): ${fmtWidthsSlash(STATE.bandWidths)}. (These are applied only after you press Compute.)`;
}

function buildLabelRangesForMetric(sortedArr){
  // build value ranges for label classification based on current bands
  const {ulA, ulB, ulC} = STATE.bands;
  const bands = bandsToRanges(ulA, ulB, ulC); // A*,A,B,C
  const valueBands = bands.map(b => ({
    label: b.label,
    ll: computePercentileValue(sortedArr, b.pll),
    ul: computePercentileValue(sortedArr, b.pul)
  }));

  // produce classifier ranges as half-open [ll, next_ll) except A* inclusive top.
  // we will derive from C,B,A,A* value boundaries in ascending.
  const asc = valueBands.slice().sort((x,y)=>x.ll-y.ll);
  const ranges = [];
  for (let i=0;i<asc.length;i++){
    const cur = asc[i];
    const next = asc[i+1];
    const ll = cur.ll ?? null;
    let ul = cur.ul ?? null;
    if (next && next.ll != null) ul = next.ll;
    if (ll==null || ul==null) continue;
    ranges.push({label: cur.label, ll, ul, ul_display: ul});
  }
  // ensure last label covers to max
  if (asc.length){
    const last = asc[asc.length-1];
    const ll = last.ll, ul = last.ul;
    if (ll!=null && ul!=null) ranges.push({label:last.label, ll, ul, ul_display: ul});
  }
  // IMPORTANT: make the highest band open-ended (A* "or more") so values
  // above the matched-set max (e.g., Nature/Cell CiteScore) still classify.
  if (ranges.length){
    /* keep display UL as matched-set max */
    if (ranges[ranges.length-1].ul_display === undefined || ranges[ranges.length-1].ul_display === null){
      ranges[ranges.length-1].ul_display = ranges[ranges.length-1].ul;
    }
    ranges[ranges.length-1].ul = Infinity;
  }
  // merge duplicates by label if any
  return ranges;
}

function normalizeTitleForKey(s){
  // Title key for deterministic cross-database matching.
  // Conservative normalization to reduce false negatives without fuzzy matching.
  let t = String(s ?? "").toLowerCase().trim();
  t = t.replace(/&/g, " and ");
  t = t.replace(/[\u2010-\u2015\-–—:,.;(){}\[\]\/\\'"`’“”!?+]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function normalizeIssnKey(s){
  // ISSN normalized: strip hyphens/spaces, uppercase
  return String(s ?? "").toUpperCase().replace(/[^0-9X]/g, "");
}


function ensureSignedIn(){
  if (AUTH_DISABLED) return true;
  if (!STATE.user || !STATE.user.email) return false;
  const em = String(STATE.user.email).toLowerCase();
  const isAhdUni = em.endsWith("@ahduni.edu.in");
  if (isAhdUni) return true;
  if (ALLOWLIST && ALLOWLIST.size){
    return ALLOWLIST.has(em);
  }
  return false;
}


function setSignedInUI(){
  const ok = ensureSignedIn();
  $("btnCompute").disabled = false;
  $("btnExport").disabled = (STATE.outputRows.length===0) || !ok;
  $("userStatus").textContent = (AUTH_DISABLED ? "Demo mode (login coming soon)" : ok ? `Signed in: ${STATE.user.email}` : "Not signed in");
}

function signIn(){
  // Note: this is *not* mailbox verification. It enforces domain / allowlist rules for externals.
  // Real mailbox verification requires Supabase magic-link/OTP, which is a separate integration.
  const email = ($("email") ? $("email").value : "").trim();
  const name = $("fullName").value.trim();
  const desig = $("designation").value.trim();
  const school = ($("schoolDept") ? $("schoolDept").value.trim() : "");
  const uni = ($("universityOrg") ? $("universityOrg").value.trim() : "");

  // Hard mandatory fields (also enforced via HTML 'required')
  if (!email){ $("loginMsg").textContent = "Please enter your email."; return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ $("loginMsg").textContent = "Please enter a valid email address."; return; }
  if (!name){ $("loginMsg").textContent = "Please enter your name."; return; }
  if (!desig){ $("loginMsg").textContent = "Please enter your designation."; return; }
  if (!school){ $("loginMsg").textContent = "Please enter your School/Department."; return; }
  if (!uni){ $("loginMsg").textContent = "Please enter your University/Organisation."; return; }

  const em = email.toLowerCase();
  const isAhdUni = em.endsWith("@ahduni.edu.in");

  // If allowlist exists and has entries: allow all @ahduni.edu.in + allowlisted externals.
  // If allowlist missing/empty: allow only @ahduni.edu.in.
  if (ALLOWLIST && ALLOWLIST.size){
    if (!isAhdUni && !ALLOWLIST.has(em)){
      $("loginMsg").textContent = "This external email is not on the allowed list.";
      return;
    }
  } else {
    if (!isAhdUni){
      $("loginMsg").textContent = "Only @ahduni.edu.in emails are allowed (or provide an allowlist for externals).";
      return;
    }
  }

  STATE.user = {email, name, designation: desig, schoolDept: school, universityOrg: uni, ts: new Date().toISOString()};
  localStorage.setItem("rateify_user", JSON.stringify(STATE.user));
  $("loginMsg").textContent = "Signed in.";
  setSignedInUI();
}


function restoreUser(){
  try{
    const raw = localStorage.getItem("rateify_user");
    if (!raw) return;
    STATE.user = JSON.parse(raw);
    if (STATE.user?.email){
      if ($("email")) $("email").value = STATE.user.email || "";
      $("fullName").value = STATE.user.name || "";
      $("designation").value = STATE.user.designation || "";
      if ($("schoolDept")) $("schoolDept").value = STATE.user.schoolDept || STATE.user.schoolCentre || "";
      if ($("universityOrg")) $("universityOrg").value = STATE.user.universityOrg || "";
    }
  }catch(e){}
  setSignedInUI();
}

function parseJournalNames(){
  const manual = Array.isArray(STATE.manualNames) ? STATE.manualNames.slice() : [];
  const pasteRaw = String($("journalInput")?.value || "");
  const pasted = pasteRaw.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const combined = [];
  const seen = new Set();
  for (const x of [...manual, ...pasted]){
    const k = String(x).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(String(x));
  }
  return combined;
}

function computeOne(name, rangesCS, rangesSNIP, rangesSJR){
  const raw = String(name ?? "").trim();
  const key = normalizeTitleForKey(raw);

  let abRec = null;
  let scRec = null;
  let ambiguous = false;

  // ISSN-first if user provided an ISSN
  if (isLikelyIssn(raw)){
    const kIssn = normalizeIssnKey(raw);
    abRec = STATE.abdcByIssn.get(kIssn) || null;
    scRec = STATE.scopusByIssn.get(kIssn) || null;
  } else {
    if (STATE.abdcTitleCollisions.has(key)) ambiguous = true;
    if (STATE.scopusTitleCollisions.has(key)) ambiguous = true;
    abRec = STATE.abdcByTitleLower.get(key) || null;
    scRec = STATE.scopusByTitleLower.get(key) || null;
  }

  // Secondary reconciliation by ISSN (only if one side missing)
  if (!ambiguous && abRec && !scRec){
    const issns = extractIssnsFromAbdc(abRec);
    for (const issn of issns){
      const cand = STATE.scopusByIssn.get(normalizeIssnKey(issn));
      if (cand){ scRec = cand; break; }
    }
  }
  if (!ambiguous && scRec && !abRec){
    const issns = extractIssnsFromScopus(scRec);
    for (const issn of issns){
      const cand = STATE.abdcByIssn.get(normalizeIssnKey(issn));
      if (cand){ abRec = cand; break; }
    }
  }

  // False-positive avoidance: if ambiguous, return safest output
  if (ambiguous){
    return {
      input: raw,
      abdc_rating: "na",
      citescore: "#N/A",
      cs_eq: "#N/A",
      top10: "#N/A",
      snip: "#N/A",
      snip_eq: "#N/A",
      sjr: "#N/A",
      sjr_eq: "#N/A",
      sjr_q: "#N/A",
      quick: "na - #N/A - #N/A - #N/A - #N/A",
      note: "Ambiguous title match",
      abdc_candidates: []
    };
  }

  const abdc_rating = (abRec && (abRec.rating_2025 || abRec.abdc_2025_proposed_rating || abRec.abdc_2025_proposed_rating)) ? String(abRec.rating_2025 || abRec.abdc_2025_proposed_rating || abRec.abdc_2025_proposed_rating) : "na";

  if (!scRec){
    // Case 3 or 4
    const quick = `${abdc_rating} - #N/A - #N/A - #N/A - #N/A`;
    return {
      input: raw,
      abdc_rating,
      citescore: "#N/A",
      cs_eq: "#N/A",
      top10: "#N/A",
      snip: "#N/A",
      snip_eq: "#N/A",
      sjr: "#N/A",
      sjr_eq: "#N/A",
      sjr_q: "#N/A",
      quick: abdc_rating==="na" ? "na - #N/A - #N/A - #N/A - #N/A" : quick,
      note: ""
    };
  }

  const cs = toNum(scRec.citescore);
  const sn = toNum(scRec.snip);
  const sj = toNum(scRec.sjr);

  const cs_eq = (cs===null) ? "#N/A" : labelForValue(cs, rangesCS);
  const snip_eq = (sn===null) ? "#N/A" : labelForValue(sn, rangesSNIP);
  const sjr_eq = (sj===null) ? "#N/A" : labelForValue(sj, rangesSJR);

  const pct = toNum(scRec.citescore_percentile);
  const top10 = (pct===null) ? "#N/A" : (pct>=90 ? "Yes" : "No");
  const sjr_q = scRec.scopus_quartile ? `Q${scRec.scopus_quartile}` : "na";

  const quick = `${abdc_rating} - ${cs_eq} - ${snip_eq} - ${sjr_eq} - ${sjr_q}`;

  // Secondary validation note: ISSN mismatch (only when ABDC record exists)
  let note = "";
  if (abRec){
    const abIssn = new Set(extractIssnsFromAbdc(abRec).map(normalizeIssnKey).filter(Boolean));
    const scIssn = new Set(extractIssnsFromScopus(scRec).map(normalizeIssnKey).filter(Boolean));
    if (abIssn.size && scIssn.size){
      let overlap = false;
      for (const x of abIssn){ if (scIssn.has(x)) { overlap=true; break; } }
      if (!overlap) note = "ISSN mismatch";
    }
  }

    const abdc_candidates = (!abRec && scRec) ? findCloseAbdcTitles(scRec.title || raw, 3).map(r=>({title:r.title, rating_2025:r.rating_2025, rating_2022:r.rating_2022})) : [];

return {
    input: raw,
    abdc_rating,
    citescore: cs===null ? "#N/A" : cs,
    cs_eq,
    top10,
    snip: sn===null ? "#N/A" : sn,
    snip_eq,
    sjr: sj===null ? "#N/A" : sj,
    sjr_eq,
    sjr_q,
    quick,
    note,
    abdc_candidates
  };
}



// (dedup) Removed duplicate renderOutput definition.


function computeAll(){
  if (!ensureSignedIn()){
    alert("Please sign in with an @ahduni.edu.in email first.");
    return;
  }
  const ok = validateBands(STATE.bands.ulA, STATE.bands.ulB, STATE.bands.ulC);
  if (!ok){
    alert("Invalid percentile bands. Please fix the UL values.");
    return;
  }
  const names = parseJournalNames();
  if (names.length>10){
    alert("Maximum 10 journals allowed. Please remove extras.");
    return;
  }
  if (names.length===0){
    alert("Enter at least one journal name.");
    return;
  }

  const rangesCS = buildLabelRangesForMetric(STATE.commonArrays.metrics.citescore);
  const rangesSN = buildLabelRangesForMetric(STATE.commonArrays.metrics.snip);
  const rangesSJ = buildLabelRangesForMetric(STATE.commonArrays.metrics.sjr);

  STATE.outputRows = names.map(n => computeOne(n, rangesCS, rangesSN, rangesSJ));
  renderOutput();
  STATE.bandsDirty = false;
  hidePressCompute();
}

function recomputeIfPossible(){
  // Recompute outputs immediately when percentile bands change (no extra click).
  try{
    if (!STATE.commonArrays) return;
    const names = parseJournalNames();
    if (!names || names.length===0) return;

    const ok = validateBands(STATE.bands.ulA, STATE.bands.ulB, STATE.bands.ulC);
    if (!ok) return;

    const rangesCS = buildLabelRangesForMetric(STATE.commonArrays.metrics.citescore);
    const rangesSN = buildLabelRangesForMetric(STATE.commonArrays.metrics.snip);
    const rangesSJ = buildLabelRangesForMetric(STATE.commonArrays.metrics.sjr);

    STATE.outputRows = names.map(n => computeOne(n, rangesCS, rangesSN, rangesSJ));
    renderOutput();
    STATE.bandsDirty = false;
    hidePressCompute();
  }catch(e){
    // Fail silently; band table will still update via updateRangesUI().
    console.warn("recomputeIfPossible failed", e);
  }
}

function makeCSV(){
  const w = STATE.bandWidths || cutoffsToWidths(STATE.bands);
  const ts = new Date().toISOString();

  const rows = [];
  rows.push(["Rateify export",""]);
  rows.push(["User", STATE.user?.email ?? ""]);
  rows.push(["Name", STATE.user?.name ?? ""]);
  rows.push(["Designation", STATE.user?.designation ?? ""]);
  rows.push(["School/Centre", STATE.user?.schoolCentre ?? ""]);
  rows.push(["Version", "2026-01"]);
  rows.push(["Percentile band widths (A*/A/B/C)", `${Math.round(w.Astar)}/${Math.round(w.A)}/${Math.round(w.B)}/${Math.round(w.C)}`]);
  rows.push(["Generated", ts]);
  rows.push(["",""]); // blank row

  const header = [
    "Journal\nname",
    "Quick\ncode",
    "ABDC\nrating",
    "CiteScore",
    "ABDC equivalent\n(CiteScore)",
    "Top 10% CiteScore\npercentile",
    "SNIP",
    "ABDC equivalent\n(SNIP)",
    "SJR",
    "ABDC equivalent\n(SJR)",
    "SJR\nQuartile"
  ];
  rows.push(header);

  for (const r of STATE.outputRows){
    rows.push([
      r.input,
      r.quick,
      r.abdc_rating,
      (typeof r.citescore==="number" ? r.citescore.toFixed(2) : r.citescore),
      r.cs_eq,
      r.top10,
      (typeof r.snip==="number" ? r.snip.toFixed(2) : r.snip),
      r.snip_eq,
      (typeof r.sjr==="number" ? r.sjr.toFixed(2) : r.sjr),
      r.sjr_eq,
      r.sjr_q
    ]);
  }
const escCSV = (v) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)){
      return '"' + s.replace(/"/g,'""') + '"';
    }
    return s;
  };

  return rows.map(row => row.map(escCSV).join(",")).join("\n");
}

async function exportCSV(){
  if (!ensureSignedIn()){
    alert("Please sign in first.");
    return;
  }
  if (!STATE.outputRows.length){
    alert("Nothing to export.");
    return;
  }
  const csv = makeCSV();

  // Optional server-side export (for audit + silent saving)
  // Set window.RATEIFY_EXPORT_ENDPOINT = "/api/export" via Worker if enabled.
  if (window.RATEIFY_EXPORT_ENDPOINT){
    try{
      const res = await fetch(window.RATEIFY_EXPORT_ENDPOINT, {
        method: "POST",
        headers: {"content-type":"application/json"},
        body: JSON.stringify({user: STATE.user, bands: STATE.bands, csv})
      });
      if (res.ok){
        const {downloadUrl} = await res.json();
        window.open(downloadUrl, "_blank");
        return;
      }
    }catch(e){}
  }

  // Client-side download (default)
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rateify_export_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


function clamp(n,min,max){return Math.max(min, Math.min(max,n));}

function updatePager(prefix, page, pageCount, totalRows, showingStart, showingEnd){
  const info = document.getElementById(prefix+"PageInfo");
  const prev = document.getElementById(prefix+"Prev");
  const next = document.getElementById(prefix+"Next");
  if (info) info.textContent = totalRows===0 ? "No rows" : `Showing ${showingStart}–${showingEnd} of ${totalRows} (page ${page+1} of ${pageCount})`;
  if (prev) prev.disabled = page<=0;
  if (next) next.disabled = page>=pageCount-1;
}
function switchTab(tabKey){
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab===tabKey));
  document.querySelectorAll(".tabpanel").forEach(p => p.classList.remove("active"));
  $("tab-"+tabKey).classList.add("active");

  // Ensure correlation plots lay out correctly when the tab becomes visible.
  if (tabKey === "corr"){
    try {
      renderCorrelation();
      renderCorrPlots();
	    }
	    catch (e){}
  }
}

function wireTabs(){
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", (e) => {
      // Clicking the (i) inside Search tab should open modal, not switch tabs.
      const t = e.target;
      switchTab(btn.dataset.tab);
    });
  });
}


function wireBands(){
  // Ensure the editable bands table (and its UL inputs) exist before wiring events.
  renderBandsTable();

  const setBandStateFromWidths = (widths) => {
    // store user-facing widths (may not sum to 100)
    STATE.bandWidths = { ...widths };
    // compute internal cutoffs from normalized widths
    const cut = widthsToCutoffs(widths);
    STATE.bands.ulA = cut.ulA;
    STATE.bands.ulB = cut.ulB;
    STATE.bands.ulC = cut.ulC;
    // reflect cutoffs in inputs (rounded for UI)
    $("ul_a").value = String(Math.round(STATE.bands.ulA));
    $("ul_b").value = String(Math.round(STATE.bands.ulB));
    $("ul_c").value = String(Math.round(STATE.bands.ulC));
    updateRangesUI();
  };

  const applyPreset = (preset) => {
    if (preset === "default"){
      setBandStateFromWidths({Astar:25, A:25, B:25, C:25});
    } else if (preset === "alt1"){
      setBandStateFromWidths({Astar:10, A:30, B:30, C:30});
    } else if (preset === "alt2"){
      setBandStateFromWidths({Astar:10, A:20, B:30, C:40});
    }
  };

  $("presetBands").addEventListener("change", e => {
    const v = e.target.value;
    if (v === "custom"){
      STATE.bandsDirty = true;
      showPressCompute();
      return;
    }
    applyPreset(v);
    STATE.bandsDirty = true;
    showPressCompute();
  });

  ["ul_a","ul_b","ul_c"].forEach(id => {
    $(id).addEventListener("input", () => {
      // user edited cutoffs; derive widths for display/export
      STATE.bands.ulA = Number($("ul_a").value);
      STATE.bands.ulB = Number($("ul_b").value);
      STATE.bands.ulC = Number($("ul_c").value);
      STATE.bandWidths = cutoffsToWidths(STATE.bands);
      $("presetBands").value = "custom";
      updateRangesUI();
      STATE.bandsDirty = true;
      showPressCompute();
      recomputeIfPossible();
    });
  });
  // Percentile +/- buttons (mobile-friendly)
  document.querySelectorAll(".pct-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const delta = Number(btn.getAttribute("data-delta") || 0);
      const wrap = btn.closest(".pct-stepper");
      if (!wrap) return;
      const inp = wrap.querySelector('input[type="number"]');
      if (!inp) return;

      const min = inp.min !== "" ? Number(inp.min) : -Infinity;
      const max = inp.max !== "" ? Number(inp.max) : Infinity;
      const step = inp.step && inp.step !== "any" ? Number(inp.step) : 1;

      let v = Number(inp.value);
      if (!Number.isFinite(v)) v = 0;
      v = v + delta * step;
      v = Math.min(max, Math.max(min, v));
      inp.value = String(v);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });



  applyPreset("default");
}
function wireSearch(){
  $("btnSignIn").addEventListener("click", signIn);
  $("btnCompute").addEventListener("click", computeAll);
  ensureComputeWired();
  $("btnExport").addEventListener("click", exportCSV);

  // Keep counter/limits in sync even if this (older) wiring path runs.
  const ji = $("journalInput");
  if (ji) ji.addEventListener("input", updateSearchCounterAndCompute);
  const jt = $("journalTypeInput");
  if (jt) jt.addEventListener("input", updateSearchCounterAndCompute);
  updateSearchCounterAndCompute();
}

function getABDCViewList(){
  // ABDC view used for percentile-calibrated display: 1702 common journals (ABDC 2025 JQL titles matched to Scopus canonical)
  return STATE.abdcCommon1702 || [];
}
function wireSortableTable(tableId, onSort){
  const t = document.getElementById(tableId);
  if (!t) return;
  const ths = Array.from(t.querySelectorAll('thead th'));
  ths.forEach((th, idx)=>{
    th.addEventListener('click', ()=>onSort(idx));
  });
}
function renderABDCList(filter=""){
  const q = filter.trim().toLowerCase();
  let src = getABDCViewList();

  // Sorting: index maps to columns EXCLUDING S# (which is fixed/sticky)
  const sortIdx = STATE.abdcSortIdx ?? 0;
  const sortDir = STATE.abdcSortDir ?? 1;
  const keyMap = ['title','rating_2022','rating_2025','citescore','snip','sjr','publisher','issn_print','issn_online','year_inception','for','recommendation'];
  const k = keyMap[sortIdx] || 'title';

  function metricFor(r, key){
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    if (!rec) return null;
    const v = rec[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function getSortVal(r){
    if (k === 'citescore') return metricFor(r,'citescore');
    if (k === 'snip') return metricFor(r,'snip');
    if (k === 'sjr') return metricFor(r,'sjr');
    // numeric-ish fields
    if (k === 'year_inception'){
      const n = Number(r.year_inception);
      return Number.isFinite(n) ? n : null;
    }
    return String(r[k] ?? '');
  }

  src = src.slice().sort((a,b)=>{
    const av = getSortVal(a);
    const bv = getSortVal(b);
    const an = Number(av), bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sortDir*(an-bn);
    return sortDir*String(av??'').localeCompare(String(bv??''), undefined, {sensitivity:'base'});
  });

  const filtered = !q ? src : src.filter(r => {
    const t = String(r.title ?? "").toLowerCase();
    const i = String(r.issn_print ?? "").toLowerCase();
    const e = String(r.issn_online ?? "").toLowerCase();
    return t.includes(q) || i.includes(q) || e.includes(q);
  });

  const totalRows = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  STATE.abdcPage = clamp(STATE.abdcPage||0, 0, pageCount-1);
  const startIdx = (STATE.abdcPage) * PAGE_SIZE;
  const endIdx = Math.min(totalRows, startIdx + PAGE_SIZE);
  const rows = filtered.slice(startIdx, endIdx);

  function fmtMetric(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    // trim trailing zeros
    return (Math.round(n*100)/100).toFixed(2).replace(/\.?0+$/,'');
  }

  $("abdcBody").innerHTML = rows.map((r, idx) => {
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    const cs = rec ? fmtMetric(rec.citescore) : "ERR";
    const sn = rec ? fmtMetric(rec.snip) : "ERR";
    const sj = rec ? fmtMetric(rec.sjr) : "ERR";

    return `
      <tr>
        <td class="scol">${STATE.abdcViewSerialByTitleKey.get(normalizeTitleForKey(r.title)) ?? ""}</td>
        <td>${esc(r.title)}</td>
        <td class="num"><b>${esc(r.rating_2022 ?? "")}</b></td>
        <td class="num"><b>${esc(r.rating_2025 ?? "")}</b></td>
        <td class="num">${cs === "ERR" ? "ERR" : esc(cs)}</td>
        <td class="num">${sn === "ERR" ? "ERR" : esc(sn)}</td>
        <td class="num">${sj === "ERR" ? "ERR" : esc(sj)}</td>
        <td>${esc(r.publisher ?? "")}</td>
        <td class="num">${esc(r.issn_print ?? "")}</td>
        <td class="num">${esc(r.issn_online ?? "")}</td>
        <td class="num">${esc(r.year_inception ?? "")}</td>
        <td class="num">${esc(r.for ?? "")}</td>
        <td>${esc(r.recommendation ?? "")}</td>
      </tr>
    `;
  }).join("");

  const total = src.length;
  $("abdcCount").textContent = `Total ${total} (ABDC 2025 JQL). Percentile calibration uses the ABDC–Scopus matched subset (N=1702).`;
  updatePager("abdc", STATE.abdcPage, pageCount, totalRows, totalRows?startIdx+1:0, endIdx);

}



function renderRemovedList(filter=""){
  const q = filter.trim().toLowerCase();
  let src = STATE.abdc2025Removed || [];

  const sortIdx = STATE.removedSortIdx ?? 0;
  const sortDir = STATE.removedSortDir ?? 1;
  const keyMap = ['title','rating_2022','rating_2025','citescore','snip','sjr','publisher','issn_print','issn_online','year_inception','for','recommendation'];
  const k = keyMap[sortIdx] || 'title';

  function metricFor(r, key){
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    if (!rec) return null;
    const v = rec[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function getSortVal(r){
    if (k === 'citescore') return metricFor(r,'citescore');
    if (k === 'snip') return metricFor(r,'snip');
    if (k === 'sjr') return metricFor(r,'sjr');
    if (k === 'year_inception'){
      const n = Number(r.year_inception);
      return Number.isFinite(n) ? n : null;
    }
    return String(r[k] ?? '');
  }

  src = src.slice().sort((a,b)=>{
    const av=getSortVal(a), bv=getSortVal(b);
    const an=Number(av), bn=Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sortDir*(an-bn);
    return sortDir*String(av??'').localeCompare(String(bv??''), undefined, {sensitivity:'base'});
  });

  const filtered = !q ? src : src.filter(r => {
    const t = String(r.title ?? "").toLowerCase();
    const i = String(r.issn_print ?? "").toLowerCase();
    const e = String(r.issn_online ?? "").toLowerCase();
    return t.includes(q) || i.includes(q) || e.includes(q);
  });

  const totalRows = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  STATE.removedPage = clamp(STATE.removedPage||0, 0, pageCount-1);
  const startIdx = (STATE.removedPage) * PAGE_SIZE;
  const endIdx = Math.min(totalRows, startIdx + PAGE_SIZE);
  const rows = filtered.slice(startIdx, endIdx);

  function fmtMetric(v){
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return (Math.round(n*100)/100).toFixed(2).replace(/\.?0+$/,'');
  }

  $("abdcRemoveBody").innerHTML = rows.map((r) => {
    const rec = STATE.scopusByTitleLower.get(normalizeTitleForKey(r.title));
    const cs = rec ? fmtMetric(rec.citescore) : "ERR";
    const sn = rec ? fmtMetric(rec.snip) : "ERR";
    const sj = rec ? fmtMetric(rec.sjr) : "ERR";
    const serial = (src.findIndex(x => normalizeTitleForKey(x.title)===normalizeTitleForKey(r.title)) + 1);

    return `
      <tr>
        <td class="scol">${serial}</td>
        <td>${esc(r.title)}</td>
        <td class="num"><b>${esc(r.rating_2022 ?? "")}</b></td>
        <td class="num"><b>${esc(r.rating_2025 ?? "")}</b></td>
        <td class="num">${cs === "ERR" ? "ERR" : esc(cs)}</td>
        <td class="num">${sn === "ERR" ? "ERR" : esc(sn)}</td>
        <td class="num">${sj === "ERR" ? "ERR" : esc(sj)}</td>
        <td>${esc(r.publisher ?? "")}</td>
        <td class="num">${esc(r.issn_print ?? "")}</td>
        <td class="num">${esc(r.issn_online ?? "")}</td>
        <td class="num">${esc(r.year_inception ?? "")}</td>
        <td class="num">${esc(r.for ?? "")}</td>
        <td>${esc(r.recommendation ?? "")}</td>
      </tr>
    `;
  }).join("");

  $("abdcRemoveCount").textContent = `Total ${src.length}.`;
  updatePager("abdcRemove", STATE.removedPage, pageCount, totalRows, totalRows?startIdx+1:0, endIdx);
}

function renderScopusList(filter=""){
  const q = filter.trim().toLowerCase();
  const sortIdx = STATE.scopusSortIdx ?? 0;
  const sortDir = STATE.scopusSortDir ?? 1;
  const keyMap = ['title','issn_print_fmt','issn_e_fmt','citescore','snip','sjr','sjr_quartile'];
  const k = keyMap[sortIdx] || 'title';
  const sorted = STATE.scopus.slice().sort((a,b)=>{
    const av=a[k], bv=b[k];
    const an=Number(av), bn=Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) return sortDir*(an-bn);
    return sortDir*String(av??'').localeCompare(String(bv??''), undefined, {sensitivity:'base'});
  });
  const filtered = !q ? sorted : sorted.filter(r => {
    const t = String(r.title ?? "").toLowerCase();
    const i = String(r.issn_print_fmt ?? "").toLowerCase();
    const e = String(r.issn_e_fmt ?? "").toLowerCase();
    return t.includes(q) || i.includes(q) || e.includes(q);
  });

  const totalRows = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  STATE.scopusPage = clamp(STATE.scopusPage||0, 0, pageCount-1);
  const startIdx = (STATE.scopusPage) * PAGE_SIZE;
  const endIdx = Math.min(totalRows, startIdx + PAGE_SIZE);
  const rows = filtered.slice(startIdx, endIdx);

  $("scopusBody").innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.title)}</td>
      <td class="num">${esc(r.issn_print_fmt ?? "")}</td>
      <td class="num">${esc(r.issn_e_fmt ?? "")}</td>
      <td class="num">${toNum(r.citescore)===null ? "" : toNum(r.citescore).toFixed(2)}</td>
      <td class="num">${toNum(r.snip)===null ? "" : toNum(r.snip).toFixed(2)}</td>
      <td class="num">${toNum(r.sjr)===null ? "" : toNum(r.sjr).toFixed(2)}</td>
      <td class="num">${r.scopus_quartile ? "Q"+r.scopus_quartile : ""}</td>
    </tr>
  `).join("");
  $("scopusCount").textContent = `Total ${sorted.length}.`;
  updatePager("scopus", STATE.scopusPage, pageCount, totalRows, totalRows?startIdx+1:0, endIdx);

}

function wireDBSearch(){
  $("abdcSearch").addEventListener("input", e => { STATE.abdcPage = 0; renderABDCList(e.target.value); });
  $("scopusSearch").addEventListener("input", e => { STATE.scopusPage = 0; renderScopusList(e.target.value); });
  const rs = document.getElementById("abdcRemoveSearch");
  if (rs) rs.addEventListener("input", e => { STATE.removedPage = 0; renderRemovedList(e.target.value); });

  // Pagination buttons
  const ap = document.getElementById("abdcPrev"); const an = document.getElementById("abdcNext");
  if (ap) ap.addEventListener("click", ()=>{ STATE.abdcPage = Math.max(0,(STATE.abdcPage||0)-1); renderABDCList($("abdcSearch").value||""); });
  if (an) an.addEventListener("click", ()=>{ STATE.abdcPage = (STATE.abdcPage||0)+1; renderABDCList($("abdcSearch").value||""); });

  const sp = document.getElementById("scopusPrev"); const sn = document.getElementById("scopusNext");
  if (sp) sp.addEventListener("click", ()=>{ STATE.scopusPage = Math.max(0,(STATE.scopusPage||0)-1); renderScopusList($("scopusSearch").value||""); });
  if (sn) sn.addEventListener("click", ()=>{ STATE.scopusPage = (STATE.scopusPage||0)+1; renderScopusList($("scopusSearch").value||""); });

  // Remove-list pagination controls (separate tab)
  const rpp = document.getElementById("abdcRemovePrev");
  const rnn = document.getElementById("abdcRemoveNext");
  if (rpp) rpp.addEventListener("click", ()=>{ STATE.removedPage = Math.max(0,(STATE.removedPage||0)-1); renderRemovedList(rs ? (rs.value||"") : ""); });
  if (rnn) rnn.addEventListener("click", ()=>{ STATE.removedPage = (STATE.removedPage||0)+1; renderRemovedList(rs ? (rs.value||"") : ""); });
}


function renderCorrelation(){
  if (!STATE.corrData) return;
  const p = STATE.corrData.pearson;

  // Correlation-matrix UI is optional (may be removed in some builds).
  const corrSummaryEl = document.getElementById("corrSummary");
  if (corrSummaryEl) corrSummaryEl.textContent = `N (complete cases): ${STATE.corrData.n}.`;

  const corrMatrixEl = document.getElementById("corrMatrix");
  if (corrMatrixEl){
    corrMatrixEl.innerHTML = `
      <thead>
        <tr><th></th><th>CiteScore</th><th>SNIP</th><th>SJR</th></tr>
      </thead>
      <tbody>
        <tr><td><b>CiteScore</b></td><td class="num">1.000</td><td class="num">${p.cs_snip.toFixed(3)}</td><td class="num">${p.cs_sjr.toFixed(3)}</td></tr>
        <tr><td><b>SNIP</b></td><td class="num">${p.cs_snip.toFixed(3)}</td><td class="num">1.000</td><td class="num">${p.snip_sjr.toFixed(3)}</td></tr>
        <tr><td><b>SJR</b></td><td class="num">${p.cs_sjr.toFixed(3)}</td><td class="num">${p.snip_sjr.toFixed(3)}</td><td class="num">1.000</td></tr>
      </tbody>
    `;
  }

  // Render static scatter plots (trim extreme outliers for readability).
  try {
    renderCorrPlots();
  } catch (e){
    // ignore
  }
}

function computePearsonCorr(xs, ys){
  const n = xs.length;
  if (n === 0) return NaN;
  let sumX=0, sumY=0;
  for (let i=0;i<n;i++){ sumX += xs[i]; sumY += ys[i]; }
  const meanX = sumX/n, meanY=sumY/n;
  let num=0, denX=0, denY=0;
  for (let i=0;i<n;i++){
    const dx = xs[i]-meanX, dy = ys[i]-meanY;
    num += dx*dy;
    denX += dx*dx;
    denY += dy*dy;
  }
  const den = Math.sqrt(denX*denY);
  return den === 0 ? NaN : (num/den);
}

function computeCorrelationsFromScopus(){
  const cs=[], sn=[], sj=[];
  for (const r of STATE.scopus){
    const a = toNum(r.citescore);
    const b = toNum(r.snip);
    const c = toNum(r.sjr);
    if (a!==null && b!==null && c!==null){
      cs.push(a); sn.push(b); sj.push(c);
    }
  }
  const n = cs.length;
  STATE.corrData = {
    n,
    // store full arrays (complete cases) for plotting without sampling
    cs,
    sn,
    sj,
    pearson: {
      cs_snip: computePearsonCorr(cs, sn),
      cs_sjr: computePearsonCorr(cs, sj),
      snip_sjr: computePearsonCorr(sn, sj),
    }
  };
}


function secondLargestDistinct(arr){
  // returns {max, max2}; max2 is second-largest distinct, or max if not available
  let max = -Infinity;
  let max2 = -Infinity;
  for (const v of arr){
    if (!Number.isFinite(v)) continue;
    if (v > max){
      max2 = max;
      max = v;
    } else if (v < max && v > max2){
      max2 = v;
    }
  }
  if (max2 === -Infinity) max2 = max;
  return {max, max2};
}

function drawStaticScatter(canvasId, xs, ys, xLabel, yLabel){
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Trim scale by ignoring a single extreme high outlier (use 2nd-largest distinct)
  const {max: xMax, max2: xMax2} = secondLargestDistinct(xs);
  const {max: yMax, max2: yMax2} = secondLargestDistinct(ys);

  // Filter points within trimmed bounds (keeps almost all points, drops only the extreme)
  const xf=[], yf=[];
  for (let i=0;i<xs.length;i++){
    const x=xs[i], y=ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x <= xMax2 && y <= yMax2){
      xf.push(x); yf.push(y);
    }
  }

  const n = xf.length;

  // Bounds (include 0 for nicer scaling)
  const xMin = 0;
  const yMin = 0;
  const xHi = Math.max(xMax2, 1e-6);
  const yHi = Math.max(yMax2, 1e-6);

  // Layout
  const padL = 55, padR = 18, padT = 22, padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  function xPix(x){ return padL + (x - xMin) * (plotW / (xHi - xMin)); }
  function yPix(y){ return padT + plotH - (y - yMin) * (plotH / (yHi - yMin)); }

  // Clear
  ctx.clearRect(0,0,W,H);

  // Background
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,W,H);

  // Axes
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT+plotH);
  ctx.lineTo(padL+plotW, padT+plotH);
  ctx.stroke();

  // Ticks
  ctx.fillStyle = '#333';
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  const ticks = 5;
  ctx.strokeStyle = '#e6e6e6';
  ctx.lineWidth = 1;

  for (let t=0;t<=ticks;t++){
    const frac = t/ticks;
    const xVal = xMin + frac*(xHi-xMin);
    const yVal = yMin + frac*(yHi-yMin);

    const xp = padL + frac*plotW;
    const yp = padT + plotH - frac*plotH;

    // vertical grid
    ctx.beginPath(); ctx.moveTo(xp, padT); ctx.lineTo(xp, padT+plotH); ctx.stroke();
    // horizontal grid
    ctx.beginPath(); ctx.moveTo(padL, yp); ctx.lineTo(padL+plotW, yp); ctx.stroke();

    ctx.fillStyle = '#333';
    ctx.fillText(xVal.toFixed(1), xp-10, padT+plotH+18);
    ctx.fillText(yVal.toFixed(1), 6, yp+4);
  }

  // Labels
  ctx.fillStyle = '#111';
  ctx.font = '13px system-ui, -apple-system, Segoe UI, Roboto, Arial';
  ctx.fillText(xLabel, padL + plotW/2 - ctx.measureText(xLabel).width/2, H-12);

  // y label rotated
  ctx.save();
  ctx.translate(14, padT + plotH/2);
  ctx.rotate(-Math.PI/2);
  ctx.fillText(yLabel, -ctx.measureText(yLabel).width/2, 0);
  ctx.restore();

  // Points
  ctx.fillStyle = 'rgba(255,0,0,0.20)';
  for (let i=0;i<n;i++){
    const xp = xPix(xf[i]);
    const yp = yPix(yf[i]);
    // small dot
    ctx.fillRect(xp, yp, 2, 2);
  }

  return {n, xHi, yHi, dropped: xs.length - n};
}

function renderCorrPlots(){
  if (!STATE.corrData) return;

  const cs = STATE.corrData.cs;
  const sn = STATE.corrData.sn;
  const sj = STATE.corrData.sj;

  // Section title with N
  const st = document.getElementById('scatterTitle');
  if (st){
    st.textContent = `Scatter plots and Pearson's correlation coefficient`;
  }

  // Draw 3 static plots (trim extreme outlier for viewing)
  const r1 = drawStaticScatter('plot_cs_snip', cs, sn, 'CiteScore', 'SNIP');
  const r2 = drawStaticScatter('plot_cs_sjr',  cs, sj, 'CiteScore', 'SJR');
  const r3 = drawStaticScatter('plot_snip_sjr', sn, sj, 'SNIP', 'SJR');

  // r-value pills (computed on complete cases; matches matrix values)
  const p = STATE.corrData.pearson;
  const pill1 = document.getElementById('r_cs_snip'); if (pill1) pill1.textContent = `r=${p.cs_snip.toFixed(3)}`;
  const pill2 = document.getElementById('r_cs_sjr'); if (pill2) pill2.textContent = `r=${p.cs_sjr.toFixed(3)}`;
  const pill3 = document.getElementById('r_snip_sjr'); if (pill3) pill3.textContent = `r=${p.snip_sjr.toFixed(3)}`;

  // Update N labels next to plot titles
  const n1 = document.getElementById('n_cs_snip'); if (n1 && r1) n1.textContent = `(N=${r1.n})`;
  const n2 = document.getElementById('n_cs_sjr');  if (n2 && r2) n2.textContent = `(N=${r2.n})`;
  const n3 = document.getElementById('n_snip_sjr'); if (n3 && r3) n3.textContent = `(N=${r3.n})`;
}


// Load all required JSON assets for the app.
// NOTE: must be a plain function (not an object parameter) so the file parses correctly.
async function loadData(){
  // Scopus slim
  const sc = await fetchJsonSmart("data/rateify_canonical.slim.json");
  STATE.scopus = sc;
  STATE.scopus.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""), undefined, {sensitivity:"base"}));
  STATE.scopusByTitleLower = new Map(sc.map(r => [normalizeTitleForKey(r.title), r]));
  STATE.scopusTypeahead = sc.map(r=>({title:String(r.title||""), norm: normalizeTitleForKey(r.title)}));

  // Build 2-char prefix index for "Did you mean" suggestions (Box B)
  STATE.scopusIndex2 = new Map();
  for (const it of STATE.scopusTypeahead){
    const k = (it.norm || "").slice(0,2);
    if (!k) continue;
    const arr = STATE.scopusIndex2.get(k);
    if (arr) arr.push(it);
    else STATE.scopusIndex2.set(k, [it]);
  }

  // ABDC list
  const ab = await fetchJsonSmart("data/abdc_list.json");
  STATE.abdcList = ab;
  STATE.abdcList.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""), undefined, {sensitivity:"base"}));
  // NOTE: abdc_list.json is retained for legacy display only; Search matching uses the Draft 2025 JQL below.
  STATE.abdcByTitleLower = new Map();

  // ABDC 2025 (view-only sheets)
  STATE.abdc2025JQL = await fetchJsonSmart("data/abdc_2025_jql.json");
  STATE.abdc2025JQL.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""), undefined, {sensitivity:"base"}));

  // Serial numbers for ABDC 2025 JQL view: fixed 1..N and does not change with sorting
  STATE.abdcViewSerialByTitleKey = new Map();
  for (let i=0;i<STATE.abdc2025JQL.length;i++){
    const key = normalizeTitleForKey(STATE.abdc2025JQL[i].title);
    if (key && !STATE.abdcViewSerialByTitleKey.has(key)) STATE.abdcViewSerialByTitleKey.set(key, i+1);
  }
  // Build authoritative ABDC title/ISSN indices from Draft 2025 JQL
  STATE.abdcByTitleLower = new Map(STATE.abdc2025JQL.map(r => [normalizeTitleForKey(r.title), r]));
  STATE.abdcByIssn = new Map();
  for (const r of STATE.abdc2025JQL){
    const issns = [r.issn_print_fmt, r.issn_e_fmt].filter(Boolean);
    for (const issn of issns){
      const k = normalizeIssnKey(issn);
      if (k) STATE.abdcByIssn.set(k, r);
    }
  }
  STATE.abdc2025Removed = await fetchJsonSmart("data/abdc_2025_removed.json");
  STATE.abdc2025Removed.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""), undefined, {sensitivity:"base"}));

  // common arrays
  STATE.commonArrays = await fetchJsonSmart("data/abdc_common_metric_arrays.json");

  // Build ABDC common list (title-matched subset) for display + calibration basis
  const nCommon = (STATE.commonArrays && STATE.commonArrays.n_common) ? STATE.commonArrays.n_common : 1702;
  const matched = (STATE.abdc2025JQL || []).filter(r => STATE.scopusByTitleLower.has(normalizeTitleForKey(r.title)));
  matched.sort((a,b)=>String(a.title||"").localeCompare(String(b.title||""), undefined, {sensitivity:"base"}));
  STATE.abdcCommon1702 = matched.slice(0, nCommon);
  // Serial numbers for common ABDC journals: fixed 1..1702 and does not change with sorting
  STATE.abdcSerialByTitleKey = new Map();
  for (let i=0;i<STATE.abdcCommon1702.length;i++){
    const key = normalizeTitleForKey(STATE.abdcCommon1702[i].title);
    if (key) STATE.abdcSerialByTitleKey.set(key, i+1);
  }


  // correlations computed client-side from full Scopus dataset
  computeCorrelationsFromScopus();
  updateRangesUI();
  renderABDCList();
  wireSortableTable('abdcTable',(idx)=>{
    // idx 0 is S# (fixed/sticky; not sortable)
    if (idx===0) return;
    const sIdx = idx-1;
    if(STATE.abdcSortIdx===sIdx){STATE.abdcSortDir=-(STATE.abdcSortDir||1);} else {STATE.abdcSortIdx=sIdx; STATE.abdcSortDir=1;}
    STATE.abdcPage = 0;
    renderABDCList($('abdcSearch').value||'');
  });
  
  // ABDC Remove list tab
  renderRemovedList();
  wireSortableTable('abdcRemoveTable',(idx)=>{
    if (idx===0) return;
    const sIdx = idx-1;
    if(STATE.removedSortIdx===sIdx){STATE.removedSortDir=-(STATE.removedSortDir||1);} else {STATE.removedSortIdx=sIdx; STATE.removedSortDir=1;}
    STATE.removedPage = 0;
    renderRemovedList(($('abdcRemoveSearch')?.value)||'');
  });
renderScopusList();
  wireSortableTable('scopusTable',(idx)=>{ if(STATE.scopusSortIdx===idx){STATE.scopusSortDir=-(STATE.scopusSortDir||1);} else {STATE.scopusSortIdx=idx; STATE.scopusSortDir=1;} STATE.scopusPage=0; renderScopusList($('scopusSearch').value||''); });
  renderCorrelation();
      renderCorrPlots();
}

function init(){
  wireTabs();
  wireSearch();
  wireSearchSuggestions();
  wireTypeahead();
  wireBands();
  wireDBSearch();
  loadAllowlist();

  updateSearchCounterAndCompute();

  // Demo mode: keep the login card blurred and always show the full-length
  // example values (do not restore any previously stored user).
  try{ localStorage.removeItem("rateify_user"); }catch(e){}
  if ($("email")) $("email").value = "dummy@univeristy.edu";
  if ($("fullName")) $("fullName").value = "Harry Potter";
  if ($("designation")) $("designation").value = "Professor of Alchemy";
  if ($("schoolDept")) $("schoolDept").value = "School of Witchcraft";
  if ($("universityOrg")) $("universityOrg").value = "University of Wizardry";
  setSignedInUI();

  loadData().catch(err => {
    console.error(err);
    alert("Failed to load data files. Check deployment.");
  });
}

document.addEventListener("DOMContentLoaded", init);
