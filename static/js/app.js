// ---------- CONFIG ----------
// Leave blank when the page is served by the Flask app itself.
// If you host the front end elsewhere, set this to your Flask URL, e.g. 'https://attendance.example.com'.
const API_URL = '';

const LATE_AFTER = 9 * 60 + 10;   // 09:10
const EARLY_BEFORE = 17 * 60;     // 17:00
const PRESENT_MIN = 5 * 60 + 1;   // > 5h -> P (durations are calculated to whole minutes)
const HALF_MIN = 4 * 60;          // 4h through 5h -> H
const HALF_MAX = 5 * 60;          // 5h inclusive
const ABSENT_AFTER = 14 * 60;     // Punch-in after 2 PM -> A

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const p2 = n => String(n).padStart(2, '0');
const fmtHM = m => m == null ? '' : p2(Math.floor(m / 60)) + ':' + p2(m % 60);   // durations (late, early, worked)
const fmt12 = m => {                                                              // clock times (punch in / out)
  if (m == null) return '';
  const h = Math.floor(m / 60) % 24;
  return p2(h % 12 || 12) + ':' + p2(m % 60) + ' ' + (h < 12 ? 'AM' : 'PM');
};
const dmy = iso => iso.split('-').reverse().join('-');
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toMin(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = +m[1];
  if (/pm/i.test(s) && h < 12) h += 12;
  if (/am/i.test(s) && h === 12) h = 0;
  return h * 60 + +m[2];
}

function status(min) {
  return min >= PRESENT_MIN ? 'P' : (min >= HALF_MIN && min <= HALF_MAX ? 'H' : 'A');
}

function durationMinutes(value) {
  const m = String(value || '').match(/^\s*(\d+):([0-5]?\d)(?::([0-5]?\d))?\s*$/);
  return m ? (+m[1] * 60 + +m[2]) : null;
}

// Punch-out without AM/PM (e.g. "04:55") that is earlier than punch-in (or before 08:00 with no
// punch-in) can only be an afternoon time -> treat as PM (04:55 -> 16:55).
function fixOut(inM, outM, raw) {
  if (outM == null || /[ap]m/i.test(String(raw))) return outM;
  if (outM < 12 * 60 && (inM != null ? outM < inM : outM < 8 * 60)) return outM + 12 * 60;
  return outM;
}

function analyse(r) {
  if (!r) return { inM: null, outM: null, work: 0, st: 'A' };
  const inM = toMin(r.inT), outM = fixOut(inM, toMin(r.outT), r.outT);
  const work = inM != null && outM != null && outM > inM
    ? outM - inM
    : (inM != null && outM == null ? (durationMinutes(r.dur) || 0) : 0);
  const st = inM != null && inM > ABSENT_AFTER ? 'A' : status(work);
  return { inM, outM, work, st };
}

const pill = s => `<span class="pill ${s}">${s}</span>`;

// ---------- API ----------
const API_CACHE_TTL_MS = 30_000;
const API_CACHE_MAX_ENTRIES = 200;
const apiResponseCache = new Map();
const apiInflightRequests = new Map();
let apiCacheGeneration = 0;

function clearApiCache() {
  apiCacheGeneration++;
  apiResponseCache.clear();
  apiInflightRequests.clear();
}

async function api(path, params, options = {}) {
  const query = params
    ? new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))).toString()
    : '';
  const url = API_URL + path + (query ? '?' + query : '');
  const useCache = options.cache !== false;
  const force = options.force === true;
  const cached = useCache && !force ? apiResponseCache.get(url) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (cached) apiResponseCache.delete(url);
  if (useCache && !force && apiInflightRequests.has(url))
    return apiInflightRequests.get(url);

  const generation = apiCacheGeneration;
  const request = (async () => {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
      if (data && data.error) throw new Error(data.error);
      if (useCache && generation === apiCacheGeneration) {
        apiResponseCache.set(url, { data, expiresAt: Date.now() + API_CACHE_TTL_MS });
        if (apiResponseCache.size > API_CACHE_MAX_ENTRIES)
          apiResponseCache.delete(apiResponseCache.keys().next().value);
      }
      return data;
    } finally {
      if (apiInflightRequests.get(url) === request) apiInflightRequests.delete(url);
    }
  })();

  if (useCache) apiInflightRequests.set(url, request);
  return request;
}

// ---------- State ----------
const CORE_OFFICES = {
  MAGNUS: ['HEAD OFFICE', 'R&D', 'FR', 'FCO']
};
const CORE_OFFICE_SOURCE_ALIASES = {
  'HEAD OFFICE': 'HEAD OFFICE',
  'R&D': 'MANJERI R&D',
  FR: 'MANJERI FR',
  FCO: 'FCO MANJERI'
};
const BUSINESS_ORDER = ['MAGNUS', 'ALIMS', 'M&D', 'MERCHX', 'HU', 'GRANDIS'];
const BUSINESS_BRANCHES = {
  MAGNUS: ['Manjeri', 'Kasargod', 'Kannur', 'Kuttiyadi', 'Kozhikode', 'Tirur', 'Palakkad', 'Thrissur', 'Ernakulam', 'Alappuzha', 'Kottayam', 'Kollam', 'Trivandrum', 'Marthandam', 'Nagpur', 'Hyderabad', 'Bangalore'],
  ALIMS: ['Manjeri', 'Kozhikode', 'Ernakulam', 'Thrissur', 'Trivandrum'],
  'M&D': ['Manjeri', 'Ernakulam'],
  MERCHX: ['Manjeri', 'Kozhikode', 'Thrissur', 'Ernakulam'],
  HU: ['Manjeri'],
  GRANDIS: ['Thoduppuzha', 'Chennai']
};
const BRANCH_SOURCE_ALIASES = {
  'MAGNUS|Kuttiyadi': 'KUTTIYADI',
  'MERCHX|Manjeri': 'MERCHX MANJERI',
  'HU|Manjeri': 'HU MANJERI'
};
function branchSourceName(business, branch) {
  return BRANCH_SOURCE_ALIASES[`${business}|${branch}`]
    || (business === 'MAGNUS' ? branch.toUpperCase() : `${business} ${branch}`.toUpperCase());
}
let rows = [];              // raw punch rows of the selected branch
let savedMatrix = { dates: [], rows: [] };
let byKey = new Map();      // "date|name" -> row
let names = [];
let availableBranches = [];
let allBusinessType = 'MAGNUS';
let selectedLocationType = 'branch';

function indexRows() {
  byKey = new Map();
  rows.forEach(r => byKey.set(r.d + '|' + r.name, r));
  names = [...new Set(rows.map(r => r.name))].sort((a, b) => a.localeCompare(b));
}

function addEmployeeCodes(matrix, sourceRows) {
  const codeByName = new Map();
  sourceRows.forEach(row => {
    const name = String(row.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const code = String(row.code || '').trim();
    if (name && code && !codeByName.has(name)) codeByName.set(name, code);
  });

  const uniqueRows = new Map();
  (matrix.rows || []).forEach(row => {
    const nameKey = String(row.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const code = row.code !== undefined
      ? String(row.code || '').trim()
      : codeByName.get(nameKey) || '';
    const key = code ? `code:${code.toUpperCase()}` : `name:${String(row.name || '').trim().toUpperCase()}`;
    const existing = uniqueRows.get(key);
    if (!existing) {
      uniqueRows.set(key, { ...row, code, statuses: { ...(row.statuses || {}) } });
      return;
    }
    Object.entries(row.statuses || {}).forEach(([day, value]) => {
      if (!existing.statuses[day]) existing.statuses[day] = value;
    });
  });

  return { ...matrix, rows: [...uniqueRows.values()] };
}

function setMsg(text, isError = false) {
  const el = $('msg');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------- Daily ----------
function renderDaily() {
  const d = $('date').value;
  const heads = ['SL NO', 'EMP NAME', 'PUNCH IN TIME', 'LATE TIME', 'PUNCH OUT',
                 'EARLY LEAVING TIME', 'TOTAL WORKING HOURS', 'STATUS'];
  $('dailyHead').innerHTML = heads.map(h => `<th>${h}</th>`).join('');

  const cnt = { P: 0, H: 0, A: 0 };
  $('dailyBody').innerHTML = names.map((n, i) => {
    const a = analyse(byKey.get(d + '|' + n));
    cnt[a.st]++;
    const afterTwoPm = a.inM != null && a.inM > ABSENT_AFTER;
    const late = !afterTwoPm && a.inM != null && a.inM > LATE_AFTER ? fmtHM(a.inM - LATE_AFTER) : '';
    const early = a.outM != null && a.outM < EARLY_BEFORE ? fmtHM(EARLY_BEFORE - a.outM) : '';
    const out = a.outM != null
      ? fmt12(a.outM)
      : (a.inM != null ? '<span class="no-out">No out punch</span>' : '');
    return `<tr class="${afterTwoPm ? 'after-2pm' : ''}">
      <td>${i + 1}</td><td class="name">${esc(n)}</td>
      <td>${fmt12(a.inM)}</td>
      <td class="late">${late}</td>
      <td>${out}</td>
      <td class="early">${early}</td>
      <td>${fmtHM(a.work)}</td>
      <td>${pill(a.st)}</td></tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">No data</td></tr>`;

  $('cards').innerHTML = [['P', 'Present'], ['H', 'Half-day'], ['A', 'Absent']].map(([k, l]) =>
    `<div class="card"><div class="label">${l}</div><div class="value">${cnt[k]}</div></div>`).join('');
}

// ---------- Matrix ----------
function renderMatrix() {
  const f = $('from').value, t = $('to').value;
  if (!f || !t || f > t) { $('matrixTable').innerHTML = ''; return; }

  const days = [];
  for (let d = new Date(f + 'T00:00:00'); d <= new Date(t + 'T00:00:00') && days.length < 92; d.setDate(d.getDate() + 1))
    days.push(d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()));

  const head = `<tr><th class="corner code-corner">EMP CODE</th><th class="name-corner">EMP NAME</th>` +
    days.map(x => `<th>${dmy(x)}</th>`).join('') + `</tr>`;

  const body = savedMatrix.rows.map(({ code, name, statuses }) => {
    const cells = days.map(x => {
      const value = statuses[x];
      return value ? `<td>${pill(value)}</td>` : `<td></td>`;
    }).join('');
    return `<tr><td class="emp-code">${esc(code)}</td><td class="emp">${esc(name)}</td>${cells}</tr>`;
  }).join('');

  $('matrixTable').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

function setMonthRange() {
  const d = $('date').value;
  if (!d) return;
  const [y, m] = d.split('-').map(Number);
  $('from').value = `${y}-${p2(m)}-01`;
  $('to').value = `${y}-${p2(m)}-${p2(new Date(y, m, 0).getDate())}`;
}

// ---------- Load ----------
async function loadBranch() {
  setMsg('Loading…');
  try {
    const selectedBranch = $('branch').selectedOptions[0];
    const sourceBranch = selectedBranch?.dataset.source || $('branch').value;
    const [branchRows, branchMatrix] = await Promise.all([
      api('/api/data', { branch: sourceBranch }),
      api('/api/matrix', { branch: sourceBranch }).catch(error => {
        console.error('Saved matrix could not be loaded:', error);
        return { dates: [], rows: [] };
      })
    ]);
    rows = branchRows;
    savedMatrix = addEmployeeCodes(branchMatrix, branchRows);
    indexRows();
    const latest = rows.map(r => r.d).sort().pop();
    if (!$('date').value || !rows.some(r => r.d === $('date').value))
      $('date').value = latest || new Date().toISOString().slice(0, 10);
    setMonthRange();
    renderDaily();
    renderMatrix();
    setMsg(`${rows.length} records · ${names.length} employees · updated ${new Date().toLocaleTimeString()}`);
  } catch (e) { setMsg('Error: ' + (e.message || e), true); }
}

async function loadBranches() {
  availableBranches = await api('/api/branches');
  await updateBranchOptions();
}

async function updateBranchOptions() {
  const branchSelect = $('branch');
  if ($('businessName').value === 'ALL' && $('locationType').value === 'ALL') return;
  const currentOption = branchSelect.selectedOptions[0];
  const currentBusiness = currentOption?.dataset.business;
  const currentBranch = currentOption?.dataset.branch;
  let options;
  const allBusinessSelected = $('businessName').value === 'ALL';
  const business = allBusinessSelected ? $('locationType').value : $('businessName').value;
  const coreOffices = CORE_OFFICES[business] || [];
  if (!allBusinessSelected && $('locationType').value === 'core-office' && coreOffices.length) {
    options = coreOffices.map(branch => ({
      business: 'MAGNUS', branch,
      source: CORE_OFFICE_SOURCE_ALIASES[branch],
      label: branch,
      value: `MAGNUS|office|${branch}`
    }));
  } else {
    options = BUSINESS_BRANCHES[business].map(branch => {
      const sourceName = branchSourceName(business, branch);
      const source = availableBranches.find(name => name.toUpperCase() === sourceName.toUpperCase()) || sourceName;
      return {
        business, branch, source,
        label: branch,
        value: `${business}|${branch}`
      };
    });
  }
  branchSelect.innerHTML = options.map(option =>
    `<option value="${esc(option.value)}" data-source="${esc(option.source)}" data-business="${esc(option.business)}" data-branch="${esc(option.branch)}">${esc(option.label)}</option>`
  ).join('');
  if (!options.length) {
    rows = [];
    indexRows();
    renderDaily();
    renderMatrix();
    setMsg('No branches found in the source sheet. Check SHEET_ID and that the tabs have data.', true);
    return;
  }
  const selection = options.find(option => option.business === currentBusiness && option.branch === currentBranch)
    || options.find(option => option.branch === currentBranch)
    || options[0];
  branchSelect.value = selection.value;
  await loadBranch();
}

function updateLocationTypeOptions() {
  const locationType = $('locationType');
  const isAllBusiness = $('businessName').value === 'ALL';
  const wasBusinessType = locationType.dataset.mode === 'business-type';
  const currentBranchBusiness = $('branch').selectedOptions[0]?.dataset.business;

  if (wasBusinessType) allBusinessType = locationType.value;
  else selectedLocationType = locationType.value;
  if (!wasBusinessType && BUSINESS_ORDER.includes(currentBranchBusiness))
    allBusinessType = currentBranchBusiness;

  if (isAllBusiness) {
    $('locationTypeLabel').textContent = 'Business Type';
    locationType.innerHTML = [['ALL', 'ALL'], ...BUSINESS_ORDER.map(business => [business, business])].map(([value, label]) =>
      `<option value="${esc(value)}">${esc(label)}</option>`
    ).join('');
    locationType.value = allBusinessType;
    locationType.dataset.mode = 'business-type';
    return;
  }

  const coreOffices = CORE_OFFICES[$('businessName').value] || [];
  if (!coreOffices.length && selectedLocationType === 'core-office') selectedLocationType = 'branch';
  $('locationTypeLabel').textContent = 'Location Type';
  const locationOptions = coreOffices.length
    ? [['core-office', 'CORE OFFICE'], ['branch', 'BRANCH']]
    : [['branch', 'BRANCH']];
  locationType.innerHTML = locationOptions.map(([value, label]) =>
    `<option value="${value}">${label}</option>`
  ).join('');
  locationType.value = selectedLocationType;
  locationType.dataset.mode = 'location-type';
}

async function syncSheet() {
  const btn = $('sync');
  btn.disabled = true;
  setMsg('Syncing from Google Sheet…');
  try {
    const r = await api('/api/sync', null, { cache: false });
    clearApiCache();
    const current = $('branch').value;
    await loadBranches();
    if (current && [...$('branch').options].some(o => o.value === current)) {
      $('branch').value = current;
      await loadBranch();
    }
    setMsg(`Synced ${r.rows} rows · matrix saved for ${r.branches} branch(es) in the output Google Sheet.`);
  } catch (e) { setMsg('Sync error: ' + (e.message || e), true); }
  btn.disabled = false;
}

// ---------- PDF export (Daily Report) ----------
function dailyRowsFor(data, date) {
  const map = new Map(data.map(r => [r.d + '|' + r.name, r]));
  const emp = [...new Set(data.map(r => r.name))].sort((a, b) => a.localeCompare(b));
  const cnt = { P: 0, H: 0, A: 0 };
  const body = emp.map((n, i) => {
    const a = analyse(map.get(date + '|' + n));
    cnt[a.st]++;
    return [
      i + 1, n, fmt12(a.inM),
      a.inM != null && a.inM > LATE_AFTER ? fmtHM(a.inM - LATE_AFTER) : '',
      a.outM != null ? fmt12(a.outM) : (a.inM != null ? 'No out punch' : ''),
      a.outM != null && a.outM < EARLY_BEFORE ? fmtHM(EARLY_BEFORE - a.outM) : '',
      fmtHM(a.work), a.st
    ];
  });
  return { body, cnt };
}

function makePdf(branch, data, date) {
  const { jsPDF } = window.jspdf;
  const { body, cnt } = dailyRowsFor(data, date);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFontSize(16);
  doc.text(`${branch} - Daily Report`, 40, 40);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Date: ${dmy(date)}   |   Total: ${body.length}   Present: ${cnt.P}   Half-day: ${cnt.H}   Absent: ${cnt.A}`, 40, 58);
  const colors = { P: [[220, 252, 231], [22, 101, 52]], H: [[254, 243, 199], [146, 64, 14]], A: [[254, 226, 226], [153, 27, 27]] };
  doc.autoTable({
    startY: 70,
    head: [['SL NO', 'EMP NAME', 'PUNCH IN', 'LATE', 'PUNCH OUT', 'EARLY LEAVING', 'WORKING HRS', 'STATUS']],
    body,
    styles: { fontSize: 8.5, cellPadding: 4 },
    headStyles: { fillColor: [15, 23, 42] },
    didParseCell: h => {
      if (h.section !== 'body') return;
      if (h.column.index === 3 || h.column.index === 5) h.cell.styles.textColor = [220, 38, 38];
      if (h.column.index === 7) {
        const [bg, fg] = colors[h.cell.raw] || colors.A;
        h.cell.styles.fillColor = bg; h.cell.styles.textColor = fg;
        h.cell.styles.fontStyle = 'bold'; h.cell.styles.halign = 'center';
      }
    }
  });
  doc.save(String(branch).replace(/[\\/:*?"<>|]/g, '_').trim() + '.pdf');   // e.g. MANJERI.pdf
}

function loadScript(src) {
  return new Promise((ok, fail) => {
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
}

// jsPDF is normally loaded by index.html; if the page didn't include it, load it here.
async function pdfReady() {
  try {
    if (!(window.jspdf && window.jspdf.jsPDF))
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    if (!(window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable))
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    if (!window.html2canvas)
      await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    return true;
  } catch (e) {
    setMsg('PDF library could not be loaded (check internet / CDN access).', true);
    return false;
  }
}

async function exportBranchPdf() {
  const date = $('date').value;
  if (!(await pdfReady())) return;
  if (!date || !rows.length) return setMsg('No data to export for this branch/date.', true);
  const branch = $('branch').selectedOptions[0]?.textContent || $('branch').value;
  makePdf(branch, rows, date);
  setMsg(`Exported ${branch}.pdf`);
}

async function exportAllPdf() {
  const date = $('date').value;
  if (!(await pdfReady())) return;
  if (!date) return setMsg('Select a date first.', true);
  const btn = $('exportAll');
  btn.disabled = true;
  try {
    const branches = await api('/api/branches');
    for (let i = 0; i < branches.length; i++) {
      setMsg(`Preparing ${branches[i]}.pdf (${i + 1}/${branches.length})…`);
      makePdf(branches[i], await api('/api/data', { branch: branches[i] }), date);
      await new Promise(r => setTimeout(r, 500));   // small gap so the browser accepts every download
    }
    setMsg(`Downloaded ${branches.length} branch PDF(s) for ${dmy(date)}. If some are missing, allow multiple downloads in your browser.`);
  } catch (e) { setMsg('Export error: ' + (e.message || e), true); }
  btn.disabled = false;
}

function applyStatusColorsForPdfCell(cell, theme = '') {
  if (!cell || !cell.cell) return;
  const value = String(cell.cell.raw ?? cell.cell.text ?? '').trim().toUpperCase();
  const status = value === 'P' ? { bg: [220, 252, 231], fg: [22, 101, 52] }
    : value === 'H' ? { bg: [254, 243, 199], fg: [146, 64, 14] }
    : value === 'A' ? { bg: [254, 226, 226], fg: [153, 27, 27] }
    : null;

  if (status) {
    cell.cell.styles.fillColor = status.bg;
    cell.cell.styles.textColor = status.fg;
    cell.cell.styles.fontStyle = 'bold';
    cell.cell.styles.halign = 'center';
    return;
  }

  if (theme !== 'summary' || !cell.column) return;
  const summaryPalette = {
    3: { bg: [220, 252, 231], fg: [22, 101, 52] },
    4: { bg: [254, 243, 199], fg: [146, 64, 14] },
    5: { bg: [254, 226, 226], fg: [153, 27, 27] }
  };
  const palette = summaryPalette[cell.column.index];
  if (!palette) return;

  if (cell.section === 'head') {
    cell.cell.styles.fillColor = palette.bg;
    cell.cell.styles.textColor = palette.fg;
  } else {
    cell.cell.styles.textColor = palette.fg;
  }
  cell.cell.styles.fontStyle = 'bold';
  cell.cell.styles.halign = 'center';
}

async function exportTablePdf(tableId, title, filename, options = {}) {
  if (!(await pdfReady())) return;
  const table = $(tableId);
  if (!table || !table.querySelector('thead tr') || !table.querySelector('tbody tr') || table.querySelector('tbody .empty'))
    return setMsg('No data to export for this view.', true);

  try {
    const { jsPDF } = window.jspdf;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
      background: #f8fafc;
      width: 100%;
      max-width: 1000px;
      padding: 0;
      margin: 0;
      box-sizing: border-box;
      font-family: 'Lora', Georgia, 'Times New Roman', serif;
      color: #1e293b;
    `;

    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.cssText = `
      font-family: 'Lora', Georgia, 'Times New Roman', serif;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: #1e293b;
      margin: 0 0 10px 0;
      line-height: 1.2;
    `;

    const tableClone = table.cloneNode(true);
    tableClone.style.margin = '0';
    tableClone.style.width = '100%';
    tableClone.style.maxWidth = '100%';
    tableClone.style.borderCollapse = 'collapse';
    tableClone.style.borderSpacing = '0';
    tableClone.style.display = 'table';
    tableClone.style.background = '#f8fafc';
    tableClone.style.fontFamily = `'Lora', Georgia, 'Times New Roman', serif`;
    tableClone.style.color = '#1e293b';

    const headerCells = tableClone.querySelectorAll('thead th');
    headerCells.forEach((cell, idx) => {
      cell.style.cssText = `
        background: #0f172a;
        color: #ffffff;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-align: center;
        padding: 10px 12px;
        border: 1px solid #dfe7ef;
        line-height: 1.3;
        font-family: 'Lora', Georgia, 'Times New Roman', serif;
      `;
      if (idx === 0 || idx === 1) cell.style.textAlign = 'left';
      if (idx === 3) cell.style.background = '#dcfce7'; cell.style.color = '#166534';
      if (idx === 4) cell.style.background = '#fef3c7'; cell.style.color = '#92400e';
      if (idx === 5) cell.style.background = '#fee2e2'; cell.style.color = '#991b1b';
    });

    const rows = tableClone.querySelectorAll('tbody tr');
    rows.forEach((row) => {
      row.style.background = '#f3f6f8';
      row.style.borderTop = '1px solid #dfe7ef';
      const cells = row.querySelectorAll('td');
      cells.forEach((cell, idx) => {
        cell.style.cssText = `
          padding: 8px 12px;
          border-top: 1px solid #dfe7ef;
          border-bottom: 1px solid #dfe7ef;
          border-left: none;
          border-right: none;
          text-align: center;
          font-family: 'Lora', Georgia, 'Times New Roman', serif;
          color: #1e293b;
          background: transparent;
        `;
        if (idx === 1) {
          cell.style.textAlign = 'left';
          cell.style.fontWeight = '500';
        }
      });

      const label = row.cells[1]?.textContent?.trim() || '';
      if (label.includes(':')) {
        row.style.background = '#e8eef5';
        row.style.fontWeight = '700';
        row.cells[1].style.fontWeight = '700';
      }
    });

    const valueCells = tableClone.querySelectorAll('tbody td:nth-child(4), tbody td:nth-child(5), tbody td:nth-child(6)');
    valueCells.forEach((cell) => {
      const value = (cell.textContent || '').trim();
      if (value === '0') cell.style.color = '#dc2626';
      const colIndex = Array.from(cell.parentElement.children).indexOf(cell) + 1;
      if (colIndex === 4) {
        cell.style.color = '#16a34a';
        cell.style.fontWeight = '700';
      }
      if (colIndex === 5) {
        cell.style.color = '#ca8a04';
        cell.style.fontWeight = '700';
      }
      if (colIndex === 6) {
        cell.style.color = '#dc2626';
        cell.style.fontWeight = '700';
      }
    });

    wrapper.appendChild(titleEl);
    wrapper.appendChild(tableClone);

    document.body.appendChild(wrapper);
    wrapper.style.position = 'absolute';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';

    const canvas = await window.html2canvas(wrapper, {
      backgroundColor: '#f8fafc',
      scale: 2,
      useCORS: true,
      logging: false
    });

    document.body.removeChild(wrapper);

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({
      unit: 'pt',
      format: 'a4',
      orientation: options.landscape ? 'landscape' : 'portrait'
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX = 16;
    const marginY = 12;
    const availableWidth = pageWidth - (marginX * 2);
    const availableHeight = pageHeight - (marginY * 2);
    const ratio = Math.min(availableWidth / canvas.width, availableHeight / canvas.height);
    const imgWidth = canvas.width * ratio;
    const imgHeight = canvas.height * ratio;

    pdf.addImage(imgData, 'PNG', marginX, marginY, imgWidth, imgHeight);
    pdf.save(filename);
    setMsg(`Exported ${filename}`);
  } catch (e) {
    setMsg('PDF export failed: ' + (e.message || e), true);
    console.error(e);
  }
}

function exportMatrixPdf() {
  const branch = $('branch').selectedOptions[0]?.textContent || $('branch').value;
  const from = $('from').value, to = $('to').value;
  const range = from && to ? `${dmy(from)} - ${dmy(to)}` : '';
  const safeBranch = String(branch).replace(/[\\/:*?"<>|]/g, '_').trim();
  return exportTablePdf('matrixTable', `${branch} - Status Matrix${range ? ` (${range})` : ''}`,
    `${safeBranch}-status-matrix.pdf`, { landscape: true, theme: 'matrix' });
}

function exportSummaryPdf() {
  const title = `Overall Summary${$('summaryHint').textContent ? ` - ${$('summaryHint').textContent}` : ''}`;
  return exportTablePdf('summaryTable', title, 'overall-summary.pdf', { theme: 'summary' });
}

// ---------- Tabs & events ----------
// ---------- Overall summary (selected business scope, selected date) ----------
async function loadInactive() {
  const body = $('inactiveBody');
  const startDate = $('inactiveStartDate').value;
  const days = Math.max(1, Number.parseInt($('inactiveDays').value, 10) || 2);
  body.innerHTML = '<tr><td colspan="2" class="empty">Loading inactive employees…</td></tr>';
  try {
    const params = { n_days: String(days) };
    if (startDate) params.start_date = startDate;
    const inactiveByBranch = await api('/api/inactive', params);
    const branchSelect = $('branch');
    const knownBranches = new Set(
      [...branchSelect.options].map(option => String(option.dataset.source || option.value).toUpperCase())
    );
    Object.keys(inactiveByBranch).forEach(branch => {
      if (knownBranches.has(branch.toUpperCase())) return;
      const option = new Option(branch, branch);
      option.dataset.source = branch;
      option.dataset.business = '';
      option.dataset.branch = branch;
      branchSelect.add(option);
      knownBranches.add(branch.toUpperCase());
    });
    const selectedOption = branchSelect.selectedOptions[0];
    const selectedBranch = String(selectedOption?.dataset.source || branchSelect.value || '').toUpperCase();
    $('inactiveHint').textContent = startDate
      ? `Absent on ${days} archived dates from ${dmy(startDate)} onward.`
      : `Absent on the latest ${days} archived dates.`;
    const employees = Object.entries(inactiveByBranch)
      .filter(([branch]) => branch.toUpperCase() === selectedBranch)
      .flatMap(([, rows]) =>
        rows.map(row => ({
        code: row['EMPLOYEE CODE'] || '',
        name: row['EMPLOYEE NAME'] || ''
        }))
      ).sort((a, b) => a.name.localeCompare(b.name));
    body.innerHTML = employees.map(row => `<tr>
      <td>${esc(row.code)}</td><td class="name">${esc(row.name)}</td>
    </tr>`).join('') || `<tr><td colspan="2" class="empty">No inactive employees found for ${days} archived dates.</td></tr>`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="2" class="empty">Error: ${esc(e.message || e)}</td></tr>`;
  }
}

async function loadSummary() {
  const body = $('summaryBody');
  body.innerHTML = `<tr><td colspan="7" class="empty">Loading…</td></tr>`;
  try {
    const businessNameAll = $('businessName').value === 'ALL';
    const selectedBusiness = $('businessName').value;
    const locationType = $('locationType').value;
    const selectedBusinessType = businessNameAll ? locationType : selectedBusiness;
    const allBusinesses = businessNameAll && selectedBusinessType === 'ALL';
    const businesses = allBusinesses ? BUSINESS_ORDER : [selectedBusinessType];
    const branches = await api('/api/branches');
    const all = await Promise.all(branches.map(async b => ({ branch: b, data: await api('/api/data', { branch: b }) })));
    const date = $('date').value || all.flatMap(x => x.data.map(r => r.d)).sort().pop() || '';
    const selectedScope = allBusinesses
      ? 'ALL BUSINESSES'
      : selectedBusinessType === 'MAGNUS'
        ? businessNameAll ? 'MAGNUS' : `MAGNUS: ${locationType === 'core-office' ? 'CORE OFFICE' : 'BRANCH'}`
        : selectedBusinessType;
    $('summaryHint').textContent = date ? `Attendance summary for ${dmy(date)} (${selectedScope})` : '';

    // Uses the same analyse() as the Daily Report, so the two views can never disagree.
    const rowsByBranch = new Map(await Promise.all(all.map(async ({ branch, data }) => {
      const emp = [...new Set(data.map(r => r.name))];
      const day = new Map(data.filter(r => r.d === date).map(r => [r.name, r]));
      const cnt = { P: 0, H: 0, A: 0 };
      let work = 0;
      emp.forEach(n => {
        const a = analyse(day.get(n));
        cnt[a.st]++;
        work += a.work;
      });
      return [branch.toUpperCase(), {
        branch, total: emp.length, work, present: cnt.P, absent: cnt.A, half: cnt.H
      }];
    })));
    const groups = [];
    businesses.forEach(business => {
      const branchRows = (BUSINESS_BRANCHES[business] || []).map(branch => {
        const source = branchSourceName(business, branch);
        return rowsByBranch.get(source.toUpperCase());
      }).filter(Boolean);
      const officeRows = business === 'MAGNUS'
        ? CORE_OFFICES[business].map(branch => rowsByBranch.get(CORE_OFFICE_SOURCE_ALIASES[branch].toUpperCase())).filter(Boolean)
        : [];

      if (business === 'MAGNUS') {
        if (businessNameAll || locationType === 'branch')
          groups.push({ label: 'MAGNUS: BRANCH', rows: branchRows });
        if (businessNameAll || locationType === 'core-office')
          groups.push({ label: 'MAGNUS: CORE OFFICE', rows: officeRows });
      } else {
        groups.push({ label: business, rows: branchRows });
      }
    });
    const visibleGroups = groups.filter(group => group.rows.length);
    const includedRows = [...new Map(visibleGroups.flatMap(group => group.rows).map(row => [row.branch, row])).values()];
    const tot = { total: 0, work: 0, present: 0, absent: 0, half: 0 };
    includedRows.forEach(r => Object.keys(tot).forEach(k => tot[k] += r[k]));
    let serial = 0;
    let html = visibleGroups.map(group => {
      const subtotal = { total: 0, work: 0, present: 0, absent: 0, half: 0 };
      group.rows.forEach(r => Object.keys(subtotal).forEach(k => subtotal[k] += r[k]));
      const businessRow = `<tr class="business-row"><td></td><td>${esc(group.label)}</td>
        <td>${subtotal.total}</td><td>${subtotal.present}</td><td>${subtotal.half}</td><td>${subtotal.absent}</td><td>${fmtHM(subtotal.work)}</td></tr>`;
      const branchRows = group.rows.map(r => `<tr><td>${++serial}</td><td class="name summary-branch">${esc(r.branch)}</td>
        <td>${r.total}</td><td>${r.present}</td><td>${r.half}</td><td>${r.absent}</td><td>${fmtHM(r.work)}</td></tr>`).join('');
      return businessRow + branchRows;
    }).join('');
    if (includedRows.length)
      html += `<tr class="total-row"><td></td><td>TOTAL</td>
        <td>${tot.total}</td><td>${tot.present}</td><td>${tot.half}</td><td>${tot.absent}</td><td>${fmtHM(tot.work)}</td></tr>`;
    body.innerHTML = html || `<tr><td colspan="7" class="empty">No data</td></tr>`;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="empty">Error: ${esc(e.message || e)}</td></tr>`;
  }
}

function showTab(t) {
  ['daily', 'matrix', 'inactive', 'summary'].forEach(x => $(x).classList.toggle('hidden', x !== t));
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('exportPdf').classList.toggle('hidden', t !== 'daily');
  $('exportAll').classList.toggle('hidden', t !== 'daily');
  $('exportMatrixPdf').classList.toggle('hidden', t !== 'matrix');
  $('exportSummaryPdf').classList.toggle('hidden', t !== 'summary');
  if (t === 'inactive') loadInactive();
  if (t === 'summary') loadSummary();
}

const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };   // never let a missing element break the page

// If the HTML template is an older/cached copy without the export buttons, add them here.
function ensureExportBar() {
  if ($('exportPdf') || !$('daily')) return;
  const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const bar = document.createElement('div');
  bar.className = 'export-bar';
  bar.innerHTML = `<button id="exportPdf" class="btn-export">${icon}Export to PDF</button>` +
                  `<button id="exportAll" class="btn-export">${icon}Download All (PDF)</button>`;
  $('daily').appendChild(bar);
}
ensureExportBar();

document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
const summaryOpen = () => $('summary') && !$('summary').classList.contains('hidden');
on('branch', 'onchange', () => {
  $('date').value = '';
  loadBranch();
  if (!$('inactive').classList.contains('hidden')) loadInactive();
});
on('locationType', 'onchange', () => {
  if ($('businessName').value === 'ALL') allBusinessType = $('locationType').value;
  else selectedLocationType = $('locationType').value;
  updateBranchOptions();
  if (summaryOpen()) loadSummary();
});
on('businessName', 'onchange', () => {
  updateLocationTypeOptions();
  updateBranchOptions();
  if (summaryOpen()) loadSummary();
});
on('refresh', 'onclick', async () => {
  clearApiCache();
  await loadBranch();
  if (summaryOpen()) loadSummary();
});
on('inactiveUpdate', 'onclick', loadInactive);
on('sync', 'onclick', syncSheet);
on('exportPdf', 'onclick', exportBranchPdf);
on('exportAll', 'onclick', exportAllPdf);
on('exportMatrixPdf', 'onclick', exportMatrixPdf);
on('exportSummaryPdf', 'onclick', exportSummaryPdf);
on('date', 'onchange', () => { setMonthRange(); renderDaily(); renderMatrix(); if (summaryOpen()) loadSummary(); });
on('from', 'onchange', renderMatrix);
on('to', 'onchange', renderMatrix);

// show any unexpected script error on screen instead of failing silently
window.addEventListener('error', e => setMsg('Script error: ' + e.message, true));

(async () => {
  updateLocationTypeOptions();
  showTab('daily');
  try { await loadBranches(); }
  catch (e) { setMsg('Error: ' + (e.message || e), true); }
})();