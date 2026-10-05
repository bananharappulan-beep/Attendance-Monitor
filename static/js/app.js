// ---------- CONFIG ----------
// Leave blank when the page is served by the Flask app itself.
// If you host the front end elsewhere, set this to your Flask URL, e.g. 'https://attendance.example.com'.
const API_URL = '';

const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('attendance-monitor-theme');
document.documentElement.dataset.theme = savedTheme === 'dark' ? 'dark' : 'light';

if (themeToggle) {
  const updateThemeToggle = () => {
    const isDark = document.documentElement.dataset.theme === 'dark';
    themeToggle.textContent = isDark ? 'Light mode' : 'Dark mode';
    themeToggle.setAttribute('aria-pressed', String(isDark));
    themeToggle.title = `Switch to ${isDark ? 'light' : 'dark'} mode`;
  };
  updateThemeToggle();
  themeToggle.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem('attendance-monitor-theme', nextTheme);
    updateThemeToggle();
    document.dispatchEvent(new Event('attendance-theme-change'));
  });
}

window.addEventListener('load', async () => {
  let user;
  try {
    user = await api('/api/me', null, { cache: false });
  } catch (e) {
    return;
  }

  if (window.AuthUI) AuthUI.init(user);
  const permissions = user.permissions || { tabs: ['daily', 'matrix', 'inactive', 'summary'], download: true, change_date: true };
  if (user.must_change_password) {
    document.querySelector('.app-layout').classList.add('hidden');
    document.querySelector('.topbar .controls').classList.add('hidden');
    $('exportActions').classList.add('hidden');
    setMsg('Set a new password to access attendance data.');
    if (window.AuthUI) AuthUI.forcePasswordChange();
    return;
  }

  if (user.role === 'business') {
    const businessSelect = $('businessName');
    businessSelect.innerHTML = `<option value="${esc(user.business)}">${esc(user.business)}</option>`;
    businessSelect.value = user.business;
    businessSelect.disabled = true;
  }
  document.querySelectorAll('.tab[data-tab]').forEach(button =>
    button.classList.toggle('hidden', !permissions.tabs.includes(['presence', 'monthly'].includes(button.dataset.tab) ? 'punchin' : button.dataset.tab))
  );
  // hide the whole Reports group when none of its reports is allowed
  $('reportsGroup')?.classList.toggle('hidden', !document.querySelector('#reportsOptions .tab[data-tab]:not(.hidden)'));
  if (!permissions.download) $('exportActions').classList.add('hidden');
  if (!permissions.change_date) {
    ['date', 'from', 'to'].forEach(id => {
      const element = $(id);
      if (element) element.disabled = true;
    });
  }

  $('employeeSearch').addEventListener('input', filterVisibleRows);
  updateLocationTypeOptions();
  const firstTab = ['daily', 'matrix', 'inactive', 'summary'].find(tab => permissions.tabs.includes(tab)) || 'daily';
  showTab(firstTab);
  try {
    await loadBranches();
  } catch (e) {
    setMsg('Error: ' + (e.message || e), true);
  }
});

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

function employeeIdentity(row) {
  const code = String(row.code || '').trim();
  return code
    ? `code:${code.toUpperCase()}`
    : `name:${String(row.name || '').trim().toUpperCase()}`;
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
  const search = new URLSearchParams();
  if (params) {
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).forEach(([key, value]) => {
      (Array.isArray(value) ? value : [value]).forEach(item => search.append(key, item));
    });
  }
  const query = search.toString();
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
      const res = await fetch(url, { method: options.method || 'GET', cache: 'no-store' });
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
let matrixLoadSequence = 0;
const attendanceMatrices = new Map();

async function loadAttendanceMatrix(branch, force = false) {
  const key = String(branch || '').toUpperCase();
  if (!key) throw new Error('A branch is required to load attendance history.');
  if (!force && attendanceMatrices.has(key)) return attendanceMatrices.get(key);

  const matrix = await api('/api/attendance-matrix', { branch }, { cache: false });
  if (!matrix || !Array.isArray(matrix.dates) || !Array.isArray(matrix.rows))
    throw new Error(`Invalid attendance matrix for ${branch}.`);
  attendanceMatrices.set(key, matrix);
  return matrix;
}

async function loadAttendanceMatrices(branches) {
  if (!branches.length) return {};
  const matrices = await api('/api/attendance-matrices', { branch: branches });
  const result = {};
  branches.forEach(branch => {
    const matrix = matrices[branch];
    if (!matrix || !Array.isArray(matrix.dates) || !Array.isArray(matrix.rows))
      throw new Error(`Invalid attendance matrix for ${branch}.`);
    attendanceMatrices.set(branch.toUpperCase(), matrix);
    result[branch] = matrix;
  });
  return result;
}

function findInactiveEmployees(matrix, nDays = 4) {
  const dates = (matrix.dates || [])
    .filter(day => (matrix.rows || []).some(row => String(row.statuses?.[day] || '').trim()))
    .sort();
  if (dates.length < nDays) return [];

  const latestDates = dates.slice(-nDays);
  return matrix.rows.filter(row => latestDates.every(day =>
    String(row.statuses?.[day] || '').trim().toUpperCase() === 'A'
  ));
}

function inactiveEmployeeKeys(branch, sourceRows = [], nDays = 4) {
  const matrix = attendanceMatrices.get(String(branch || '').toUpperCase());
  if (!matrix) return null;
  const inactiveRows = findInactiveEmployees(matrix, nDays);
  const normalized = addEmployeeCodes({ ...matrix, rows: inactiveRows }, sourceRows);
  return new Set(normalized.rows.map(employeeIdentity));
}

function indexRows() {
  byKey = new Map();
  const employees = new Map();
  rows.forEach(row => {
    const identity = employeeIdentity(row);
    byKey.set(row.d + '|' + identity, row);
    if (!employees.has(identity))
      employees.set(identity, { key: identity, name: row.name, code: row.code || '' });
  });
  names = [...employees.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || String(a.code).localeCompare(String(b.code))
  );
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
    const code = String(row.code || '').trim() || codeByName.get(nameKey) || '';
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
  $('dailyBody').innerHTML = names.map((employee, i) => {
    const a = analyse(byKey.get(d + '|' + employee.key));
    cnt[a.st]++;
    const afterTwoPm = a.inM != null && a.inM > ABSENT_AFTER;
    const late = !afterTwoPm && a.inM != null && a.inM > LATE_AFTER ? fmtHM(a.inM - LATE_AFTER) : '';
    const early = a.outM != null && a.outM < EARLY_BEFORE ? fmtHM(EARLY_BEFORE - a.outM) : '';
    const out = a.outM != null
      ? fmt12(a.outM)
      : (a.inM != null ? '<span class="no-out">No out punch</span>' : '');
    return `<tr class="${afterTwoPm ? 'after-2pm' : ''}" data-employee-key="${esc(employee.key)}">
      <td>${i + 1}</td><td class="name">${esc(employee.name)}${employee.code ? ` <small>(${esc(employee.code)})</small>` : ''}</td>
      <td>${fmt12(a.inM)}</td>
      <td class="late">${late}</td>
      <td>${out}</td>
      <td class="early">${early}</td>
      <td>${fmtHM(a.work)}</td>
      <td>${pill(a.st)}</td></tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">No data</td></tr>`;

  $('cards').innerHTML = [['P', 'Present'], ['H', 'Half-day'], ['A', 'Absent']].map(([k, l]) =>
    `<div class="card"><div class="label">${l}</div><div class="value">${cnt[k]}</div></div>`).join('');
  filterVisibleRows();
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
  filterVisibleRows();
}

function filterVisibleRows() {
  const query = $('employeeSearch')?.value.trim().toLocaleLowerCase() || '';
  const activeView = ['daily', 'matrix', 'inactive', 'summary']
    .find(id => !$(`${id}`).classList.contains('hidden'));
  if (!activeView || activeView === 'summary') return;
  const table = document.querySelector(`#${activeView} table`);
  if (!table) return;
  const columns = { daily: [1], matrix: [0, 1], inactive: [0, 1], summary: [1] }[activeView];
  table.querySelectorAll('tbody tr').forEach(row => {
    if (row.querySelector('.empty')) {
      row.classList.remove('hidden');
      return;
    }
    const searchableText = columns.map(index => row.cells[index]?.textContent || '').join(' ').toLocaleLowerCase();
    row.classList.toggle('hidden', Boolean(query) && !searchableText.includes(query));
  });
  if (activeView === 'daily') {
    const counts = { P: 0, H: 0, A: 0 };
    const branch = $('branch').selectedOptions[0]?.dataset.source || $('branch').value;
    const inactiveKeys = inactiveEmployeeKeys(branch, rows);
    table.querySelectorAll('tbody tr:not(.hidden)').forEach(row => {
      if (inactiveKeys?.has(row.dataset.employeeKey)) return;
      const status = row.cells[7]?.textContent.trim();
      if (status in counts) counts[status]++;
    });
    if (!inactiveKeys) counts.A = '—';
    $('cards').innerHTML = [['P', 'Present'], ['H', 'Half-day'], ['A', 'Absent']].map(([key, label]) =>
      `<div class="card"><div class="label">${label}</div><div class="value">${counts[key]}</div></div>`).join('');
  }
}

function setMonthRange() {
  const d = $('date').value;
  if (!d) return;
  const [y, m] = d.split('-').map(Number);
  $('from').value = `${y}-${p2(m)}-01`;
  $('to').value = `${y}-${p2(m)}-${p2(new Date(y, m, 0).getDate())}`;
}

// ---------- Load ----------
async function loadMatrix(sourceBranch) {
  const branch = sourceBranch || $('branch').selectedOptions[0]?.dataset.source || $('branch').value;
  if (!branch) return;

  const requestId = ++matrixLoadSequence;
  savedMatrix = { dates: [], rows: [] };
  $('matrixTable').innerHTML = '<tbody><tr><td class="empty">Loading status matrix…</td></tr></tbody>';
  try {
    const matrix = await api('/api/matrix', { branch }, { cache: false });
    const selected = $('branch').selectedOptions[0];
    const currentBranch = selected?.dataset.source || $('branch').value;
    if (requestId !== matrixLoadSequence || currentBranch !== branch) return;
    savedMatrix = addEmployeeCodes(matrix, rows);
    renderMatrix();
  } catch (e) {
    const selected = $('branch').selectedOptions[0];
    const currentBranch = selected?.dataset.source || $('branch').value;
    if (requestId !== matrixLoadSequence || currentBranch !== branch) return;
    console.error('Status matrix could not be loaded:', e);
    $('matrixTable').innerHTML =
      `<tbody><tr><td class="empty">Could not load status matrix: ${esc(e.message || e)}</td></tr></tbody>`;
    setMsg('Status matrix load failed: ' + (e.message || e), true);
  }
}

async function loadBranch() {
  setMsg('Loading…');
  try {
    const selectedBranch = $('branch').selectedOptions[0];
    const sourceBranch = selectedBranch?.dataset.source || $('branch').value;
    const branchRows = await api('/api/data', { branch: sourceBranch });
    rows = branchRows;
    indexRows();
    let attendanceMatrixError = null;
    try {
      await loadAttendanceMatrix(sourceBranch, true);
    } catch (error) {
      attendanceMatrices.delete(sourceBranch.toUpperCase());
      attendanceMatrixError = error;
      console.error('Attendance history could not be loaded:', error);
    }
    const latest = rows.map(r => r.d).sort().pop();
    if (!$('date').value || !rows.some(r => r.d === $('date').value))
      $('date').value = latest || new Date().toISOString().slice(0, 10);
    setMonthRange();
    renderDaily();
    if (!$('matrix').classList.contains('hidden')) await loadMatrix(sourceBranch);
    setMsg(attendanceMatrixError
      ? `Inactive status unavailable: ${attendanceMatrixError.message || attendanceMatrixError}`
      : `${rows.length} records · ${names.length} employees · updated ${new Date().toLocaleTimeString()}`,
    Boolean(attendanceMatrixError));
  } catch (e) { setMsg('Error: ' + (e.message || e), true); }
}

function appendSyncLog(message) {
  const logElement = $('syncLog');
  logElement.textContent += `${message}\n`;
  logElement.scrollTop = logElement.scrollHeight;
}

function showDeveloperSyncPanel(action) {
  ['daily', 'matrix', 'inactive', 'summary', 'punchin', 'presence', 'monthly'].forEach(id => $(id)?.classList.add('hidden'));
  $('syncPanel').classList.remove('hidden');
  $('employeeSearchRow').classList.add('hidden');
  document.querySelectorAll('.tab[data-tab]').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('.sync-action').forEach(button =>
    button.classList.toggle('active', button.id === (action === 'archive' ? 'syncArchive' : 'syncFetchData'))
  );
  ['exportPdf', 'exportAll', 'exportMatrixPdf', 'exportInactivePdf', 'exportSummaryPdf']
    .forEach(id => $(id).classList.add('hidden'));
  $('syncTitle').textContent = action === 'archive' ? 'Archive Attendance' : 'Fetch Attendance Data';
  $('syncLog').textContent = '';
  $('syncStatus').className = 'sync-status';
  $('syncStatus').textContent = action === 'archive' ? "Archiving yesterday's attendance..." : 'Starting the attendance fetch...';
}

async function runDeveloperSyncAction(action) {
  showDeveloperSyncPanel(action);
  const buttons = [$('syncArchive'), $('syncFetchData')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (action === 'archive') {
      const result = await api('/api/developer/archive', null, { method: 'POST', cache: false });
      appendSyncLog(result.message);
      $('syncStatus').textContent = 'Archive completed.';
      $('syncStatus').classList.add('success');
      return;
    }

    const response = await fetch(API_URL + '/api/developer/fetch-data', {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store'
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Request failed (${response.status})`);
    }
    if (!response.body) throw new Error('This browser cannot stream fetch logs.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let completion = null;
    const consume = block => {
      if (!block.trim()) return;
      const eventName = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = block.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) return;
      const payload = JSON.parse(data);
      if (eventName === 'log') appendSyncLog(payload.message);
      if (eventName === 'done') completion = payload;
    };
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop();
      blocks.forEach(consume);
      if (done) break;
    }
    consume(pending);
    if (!completion) throw new Error('Fetch log stream ended without a completion status.');
    $('syncStatus').textContent = completion.message;
    $('syncStatus').classList.add(completion.ok ? 'success' : 'error');
  } catch (error) {
    $('syncStatus').textContent = error.message || String(error);
    $('syncStatus').classList.add('error');
    appendSyncLog(`ERROR: ${error.message || error}`);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

window.runDeveloperSyncAction = runDeveloperSyncAction;

function setReportsOpen(open) {
  const toggle = $('reportsToggle'), options = $('reportsOptions');
  if (!toggle || !options) return;
  toggle.setAttribute('aria-expanded', String(open));
  options.hidden = !open;
}
$('reportsToggle')?.addEventListener('click', () =>
  setReportsOpen($('reportsToggle').getAttribute('aria-expanded') !== 'true')
);

function showTab(tab) {
  $('syncPanel').classList.add('hidden');
  document.querySelectorAll('.sync-action').forEach(button => button.classList.remove('active'));
  ['daily', 'matrix', 'inactive', 'summary', 'punchin', 'presence', 'monthly'].forEach(id => $(id)?.classList.toggle('hidden', id !== tab));
  $('employeeSearchRow').classList.toggle('hidden', ['summary', 'punchin', 'presence'].includes(tab));
  document.querySelectorAll('.tab[data-tab]').forEach(button =>
    button.classList.toggle('active', button.dataset.tab === tab)
  );
  setReportsOpen(true);
  $('exportPdf').classList.toggle('hidden', tab !== 'daily');
  $('exportAll').classList.toggle('hidden', tab !== 'daily');
  $('exportMatrixPdf').classList.toggle('hidden', tab !== 'matrix');
  $('exportInactivePdf').classList.toggle('hidden', tab !== 'inactive');
  $('exportSummaryPdf').classList.toggle('hidden', tab !== 'summary');
  refreshActiveView();
  filterVisibleRows();
}

document.querySelectorAll('.tab[data-tab]').forEach(button =>
  button.addEventListener('click', () => showTab(button.dataset.tab))
);
const bind = (id, event, handler) => {
  const element = $(id);
  if (element) element[event] = handler;
};
bind('branch', 'onchange', () => {
  $('date').value = '';
  refreshActiveView();
});
bind('locationType', 'onchange', () => {
  if ($('businessName').value === 'ALL') allBusinessType = $('locationType').value;
  else selectedLocationType = $('locationType').value;
  updateBranchOptions(false).then(refreshActiveView);
});
bind('businessName', 'onchange', () => {
  updateLocationTypeOptions();
  updateBranchOptions(false).then(refreshActiveView);
});
bind('date', 'onchange', () => {
  setMonthRange();
  renderDaily();
  renderMatrix();
  if (!$('summary').classList.contains('hidden')) loadSummary();
  if (window.punchinOpen?.()) loadPunchin();
  if (window.monthlyOpen?.()) loadMonthly();
});
bind('from', 'onchange', renderMatrix);
bind('to', 'onchange', renderMatrix);
bind('exportSummaryPdf', 'onclick', exportSummaryPdf);

async function refreshActiveView() {
  if (!$('branch').value) return;
  clearApiCache();
  const activeTab = ['daily', 'matrix', 'inactive', 'summary', 'punchin', 'presence', 'monthly']
    .find(id => !$(`${id}`).classList.contains('hidden'));
  if (activeTab === 'punchin' || activeTab === 'presence') {
    await loadPunchin();
    return;
  }
  if (activeTab === 'monthly') {
    await loadMonthly();
    return;
  }
  if (activeTab === 'summary') {
    await loadSummary();
    return;
  }
  await loadBranch();
  if (activeTab === 'inactive') await loadInactive();
}

async function loadSummary() {
  const body = $('summaryBody');
  body.innerHTML = '<tr><td colspan="7" class="empty">Loading...</td></tr>';
  try {
    const businessNameAll = $('businessName').value === 'ALL';
    const selectedBusiness = $('businessName').value;
    const locationType = $('locationType').value;
    const selectedBusinessType = businessNameAll ? locationType : selectedBusiness;
    const allBusinesses = businessNameAll && selectedBusinessType === 'ALL';
    const businesses = allBusinesses ? BUSINESS_ORDER : [selectedBusinessType];
    const available = await api('/api/branches');
    const availableByName = new Map(available.map(branch => [branch.toUpperCase(), branch]));
    const groupSpecs = [];

    businesses.forEach(business => {
      const branchSources = (BUSINESS_BRANCHES[business] || []).map(branch => branchSourceName(business, branch));
      const officeSources = business === 'MAGNUS'
        ? CORE_OFFICES[business].map(branch => CORE_OFFICE_SOURCE_ALIASES[branch])
        : [];
      if (business === 'MAGNUS') {
        if (businessNameAll || locationType === 'branch')
          groupSpecs.push({ label: 'MAGNUS: BRANCH', sources: branchSources });
        if (businessNameAll || locationType === 'core-office')
          groupSpecs.push({ label: 'MAGNUS: CORE OFFICE', sources: officeSources });
      } else {
        groupSpecs.push({ label: business, sources: branchSources });
      }
    });

    const scopedGroups = groupSpecs.map(group => ({
      ...group,
      sources: group.sources
        .map(source => availableByName.get(source.toUpperCase()))
        .filter(Boolean)
    })).filter(group => group.sources.length);
    const branches = [...new Set(scopedGroups.flatMap(group => group.sources))];
    const [matrices, all] = await Promise.all([
      loadAttendanceMatrices(branches),
      Promise.all(branches.map(async branch => ({
        branch,
        data: await api('/api/data', { branch }, { cache: false })
      })))
    ]);
    const date = $('date').value || all.flatMap(item => item.data.map(row => row.d)).sort().pop() || '';
    const selectedScope = allBusinesses
      ? 'ALL BUSINESSES'
      : selectedBusinessType === 'MAGNUS'
        ? businessNameAll ? 'MAGNUS' : `MAGNUS: ${locationType === 'core-office' ? 'CORE OFFICE' : 'BRANCH'}`
        : selectedBusinessType;
    $('summaryHint').textContent = date ? `Attendance summary for ${dmy(date)} (${selectedScope})` : '';

    const rowsByBranch = new Map();
    all.forEach(({ branch, data }) => {
      const employees = [...new Map(data.map(row => [employeeIdentity(row), row])).values()];
      const day = new Map(data.filter(row => row.d === date).map(row => [employeeIdentity(row), row]));
      const inactiveRows = findInactiveEmployees(matrices[branch]);
      const normalizedInactiveRows = addEmployeeCodes({ ...matrices[branch], rows: inactiveRows }, data);
      const inactiveKeys = new Set(normalizedInactiveRows.rows.map(employeeIdentity));
      const activeEmployees = employees.filter(employee => !inactiveKeys.has(employeeIdentity(employee)));
      const cnt = { P: 0, H: 0, A: 0 };
      let work = 0;
      activeEmployees.forEach(employee => {
        const result = analyse(day.get(employeeIdentity(employee)));
        cnt[result.st]++;
        work += result.work;
      });
      rowsByBranch.set(branch.toUpperCase(), {
        branch, total: activeEmployees.length, work, present: cnt.P, half: cnt.H, absent: cnt.A
      });
    });

    const visibleGroups = scopedGroups.map(group => ({
      label: group.label,
      rows: group.sources.map(source => rowsByBranch.get(source.toUpperCase())).filter(Boolean)
    })).filter(group => group.rows.length);
    const includedRows = [...new Map(visibleGroups.flatMap(group => group.rows).map(row => [row.branch, row])).values()];
    const total = { employees: 0, work: 0, present: 0, half: 0, absent: 0 };
    includedRows.forEach(row => {
      total.employees += row.total;
      total.work += row.work;
      total.present += row.present;
      total.half += row.half;
      total.absent += row.absent;
    });

    let serial = 0;
    let html = visibleGroups.map(group => {
      const subtotal = { employees: 0, work: 0, present: 0, half: 0, absent: 0 };
      group.rows.forEach(row => {
        subtotal.employees += row.total;
        subtotal.work += row.work;
        subtotal.present += row.present;
        subtotal.half += row.half;
        subtotal.absent += row.absent;
      });
      const businessRow = `<tr class="business-row"><td></td><td>${esc(group.label)}</td>
        <td>${subtotal.employees}</td><td>${subtotal.present}</td><td>${subtotal.half}</td><td>${subtotal.absent}</td><td>${fmtHM(subtotal.work)}</td></tr>`;
      const branchRows = group.rows.map(row => `<tr><td>${++serial}</td><td class="name summary-branch">${esc(row.branch)}</td>
        <td>${row.total}</td><td>${row.present}</td><td>${row.half}</td><td>${row.absent}</td><td>${fmtHM(row.work)}</td></tr>`).join('');
      return businessRow + branchRows;
    }).join('');
    if (includedRows.length)
      html += `<tr class="total-row"><td></td><td>TOTAL</td><td>${total.employees}</td><td>${total.present}</td><td>${total.half}</td><td>${total.absent}</td><td>${fmtHM(total.work)}</td></tr>`;
    body.innerHTML = html || '<tr><td colspan="7" class="empty">No data</td></tr>';
  } catch (e) {
    body.innerHTML = `<tr><td colspan="7" class="empty">Error: ${esc(e.message || e)}</td></tr>`;
  }
}

async function exportSummaryPdf() {
  const title = `Overall Summary${$('summaryHint').textContent ? ` - ${$('summaryHint').textContent}` : ''}`;
  await exportTablePdf('summaryTable', title, 'overall-summary.pdf', { landscape: true, theme: 'summary' });
}

async function loadBranches() {
  availableBranches = await api('/api/branches');
  await updateBranchOptions();
}

async function updateBranchOptions(loadData = true) {
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
  if (loadData) {
    await loadBranch();
    if (!$('summary').classList.contains('hidden')) await loadSummary();
  }
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
  const map = new Map(data.map(row => [row.d + '|' + employeeIdentity(row), row]));
  const empMap = new Map();
  data.forEach(row => {
    const identity = employeeIdentity(row);
    if (!empMap.has(identity))
      empMap.set(identity, { ...row, key: identity });
  });
  const employees = [...empMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name) || String(a.code).localeCompare(String(b.code))
  );
  const cnt = { P: 0, H: 0, A: 0 };
  const body = employees.map((employee, i) => {
    const a = analyse(map.get(date + '|' + employee.key));
    cnt[a.st]++;
    return [
      i + 1,
      employee.code ? `${employee.name} (${employee.code})` : employee.name,
      fmt12(a.inM),
      a.inM != null && a.inM > LATE_AFTER ? fmtHM(a.inM - LATE_AFTER) : '',
      a.outM != null ? fmt12(a.outM) : (a.inM != null ? 'No out punch' : ''),
      a.outM != null && a.outM < EARLY_BEFORE ? fmtHM(EARLY_BEFORE - a.outM) : '',
      fmtHM(a.work), a.st
    ];
  });
  return { body, cnt };
}

let loraFontPromise;
let loraBoldFontPromise;

async function registerLoraFont(pdf) {
  if (!loraFontPromise) {
    loraFontPromise = fetchPdfFont('/static/fonts/Lora-Variable.ttf');
    loraBoldFontPromise = fetchPdfFont('/static/fonts/Lora-Bold.ttf');
  }
  const [fontData, boldFontData] = await Promise.all([loraFontPromise, loraBoldFontPromise]);
  pdf.addFileToVFS('Lora-Variable.ttf', fontData);
  pdf.addFont('Lora-Variable.ttf', 'Lora', 'normal');
  pdf.addFileToVFS('Lora-Bold.ttf', boldFontData);
  pdf.addFont('Lora-Bold.ttf', 'Lora', 'bold');
}

async function fetchPdfFont(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the Lora font file.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function makePdf(branch, data, date) {
  const { jsPDF } = window.jspdf;
  const { body, cnt } = dailyRowsFor(data, date);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  await registerLoraFont(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  doc.setFont('Lora', 'bold');
  doc.setFontSize(16);
  doc.text(`${branch} - Daily Report`, pageWidth / 2, 40, { align: 'center' });
  doc.setFont('Lora', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Date: ${dmy(date)}   |   Total: ${body.length}   Present: ${cnt.P}   Half-day: ${cnt.H}   Absent: ${cnt.A}`, pageWidth / 2, 58, { align: 'center' });
  const colors = { P: [[220, 252, 231], [22, 101, 52]], H: [[254, 243, 199], [146, 64, 14]], A: [[254, 226, 226], [153, 27, 27]] };
  doc.autoTable({
    startY: 70,
    head: [['SL NO', 'EMP NAME', 'PUNCH IN', 'LATE', 'PUNCH OUT', 'EARLY LEAVING', 'WORKING HRS', 'STATUS']],
    body,
    styles: { font: 'Lora', fontSize: 8.5, cellPadding: 4, halign: 'center' },
    headStyles: { fillColor: [217, 217, 217], textColor: [0, 0, 0], font: 'Lora', fontStyle: 'bold', halign: 'center' },
    didParseCell: h => {
      if (h.section !== 'body') return;
      if (h.column.index === 1) h.cell.styles.halign = 'left';
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
    await document.fonts.load('400 12px Lora');
    await document.fonts.ready;
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
  await makePdf(branch, rows, date);
  setMsg(`Exported ${branch}.pdf`);
}

// Source tab names that fall inside the current Business Name / Business Type slicers.
function slicerBranchSources(available) {
  const byName = new Map(available.map(name => [name.toUpperCase(), name]));
  const businessNameAll = $('businessName').value === 'ALL';
  const locationType = $('locationType').value;
  const selected = businessNameAll ? locationType : $('businessName').value;
  const businesses = businessNameAll && selected === 'ALL' ? BUSINESS_ORDER : [selected];
  const sources = [];
  businesses.forEach(business => {
    if (business !== 'MAGNUS' || businessNameAll || locationType === 'branch')
      (BUSINESS_BRANCHES[business] || []).forEach(branch => sources.push(branchSourceName(business, branch)));
    if (business === 'MAGNUS' && (businessNameAll || locationType === 'core-office'))
      CORE_OFFICES.MAGNUS.forEach(office => sources.push(CORE_OFFICE_SOURCE_ALIASES[office]));
  });
  return [...new Set(sources.map(name => byName.get(name.toUpperCase())).filter(Boolean))];
}

async function exportAllPdf() {
  const date = $('date').value;
  if (!(await pdfReady())) return;
  if (!date) return setMsg('Select a date first.', true);
  const btn = $('exportAll');
  btn.disabled = true;
  try {
    const available = await api('/api/branches');
    const branches = slicerBranchSources(available);
    if (!branches.length) throw new Error('No branches found for the selected Business Name / Business Type.');
    for (let i = 0; i < branches.length; i++) {
      setMsg(`Preparing ${branches[i]}.pdf (${i + 1}/${branches.length})…`);
      await makePdf(branches[i], await api('/api/data', { branch: branches[i] }), date);
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

async function exportInactivePdf() {
  if (!(await pdfReady())) return;
  const table = $('inactiveTable');
  const body = [...table.querySelectorAll('tbody tr')]
    .filter(row => !row.querySelector('.empty'))
    .map(row => [...row.cells].map(cell => cell.textContent.trim()));
  if (!body.length) return setMsg('No inactive employees to export for this view.', true);

  const branch = $('branch').selectedOptions[0]?.textContent || $('branch').value;
  const safeBranch = String(branch).replace(/[\\/:*?"<>|]/g, '_').trim();
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  await registerLoraFont(pdf);
  const pageWidth = pdf.internal.pageSize.getWidth();
  pdf.setFont('Lora', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor(0, 0, 0);
  pdf.text(`Inactive Employees - ${branch}`, pageWidth / 2, 34, { align: 'center' });
  pdf.autoTable({
    startY: 52,
    margin: { left: 32, right: 32 },
    head: [['EMPLOYEE CODE', 'EMPLOYEE NAME']],
    body,
    showHead: 'everyPage',
    styles: { font: 'Lora', fontSize: 10, cellPadding: 6, halign: 'center', textColor: [0, 0, 0] },
    headStyles: { fillColor: [217, 217, 217], textColor: [0, 0, 0], font: 'Lora', fontStyle: 'bold', halign: 'center' }
  });
  pdf.save(`${safeBranch}-inactive-employees.pdf`);
  setMsg(`Exported ${safeBranch}-inactive-employees.pdf`);
}

async function loadInactive() {
  const body = $('inactiveBody');
  const days = 4;
  body.innerHTML = '<tr><td colspan="2" class="empty">Loading inactive employees…</td></tr>';
  try {
    const selectedOption = $('branch').selectedOptions[0];
    const branch = selectedOption?.dataset.source || $('branch').value;
    const matrix = await loadAttendanceMatrix(branch);
    const sourceRows = String($('branch').selectedOptions[0]?.dataset.source || $('branch').value || '').toUpperCase() === branch.toUpperCase()
      ? rows
      : [];
    const employees = addEmployeeCodes({
      ...matrix,
      rows: findInactiveEmployees(matrix, days)
    }, sourceRows).rows.sort((a, b) => a.name.localeCompare(b.name));
    body.innerHTML = employees.map(row => `<tr>
      <td>${esc(row.code)}</td><td class="name">${esc(row.name)}</td>
    </tr>`).join('') || `<tr><td colspan="2" class="empty">No employees were absent on the latest ${days} populated attendance dates.</td></tr>`;
    filterVisibleRows();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="2" class="empty">Error: ${esc(e.message || e)}</td></tr>`;
  }
}