// Monthly Status Report: employee-wise Present / Half Day / Absent totals for one month.
// Loaded after app.js and punchin.js; reuses their helpers ($, api, analyse, employeeIdentity, ...).
// Source = the saved Status Matrix (output sheet), refreshed with the latest source rows for the
// dates they cover (same rule the Status Matrix uses). Month = month of the selected date.
(function () {
  'use strict';

  const ALL_VALUE = '__ALL__';
  const $id = id => document.getElementById(id);
  const text = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let model = null;                          // { monthLabel, scope, rows:[...] }
  let sort = { key: 'name', dir: 1 };
  let loadToken = 0;

  const COLUMNS = [
    { key: 'sl', label: 'SL NO', nosort: true },
    { key: 'code', label: 'EMP CODE' },
    { key: 'name', label: 'EMP NAME' },
    { key: 'branch', label: 'BRANCH' },
    { key: 'P', label: 'PRESENT', num: true },
    { key: 'H', label: 'HALF DAY', num: true },
    { key: 'A', label: 'ABSENT', num: true },
    { key: 'total', label: 'TOTAL DAYS', num: true },
    { key: 'pct', label: 'PRESENT %', num: true }
  ];

  const pct = (n, d) => d ? Math.round((n / d) * 100) : 0;

  function monthName(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }

  // ---------- Data ----------
  async function collect() {
    const top = $id('branch');
    const available = await api('/api/branches');
    let branches = slicerBranchSources(available);
    if (top && top.value && top.value !== ALL_VALUE) {
      const chosen = top.selectedOptions[0]?.dataset.source || top.value;
      const only = branches.find(b => b.toUpperCase() === String(chosen).toUpperCase());
      branches = only ? [only] : [];
    }
    if (!branches.length) throw new Error('No branches found for the selected Business Name / Business Type.');

    const [, all] = await Promise.all([
      loadAttendanceMatrices(branches),
      Promise.all(branches.map(async branch => ({ branch, data: await api('/api/data', { branch }) })))
    ]);

    const selected = $id('date').value;
    const latest = all.flatMap(x => x.data.map(r => r.d)).sort().pop()
      || all.flatMap(x => attendanceMatrices.get(x.branch.toUpperCase())?.dates || []).sort().pop() || '';
    const ym = (selected || latest).slice(0, 7);
    if (!ym) throw new Error('No attendance data found.');

    const rows = [];
    all.forEach(({ branch, data }) => {
      const matrix = attendanceMatrices.get(branch.toUpperCase());
      const inactive = inactiveEmployeeKeys(branch, data) || new Set();
      const normalized = matrix ? addEmployeeCodes(matrix, data) : { dates: [], rows: [] };

      const sourceDates = new Set(data.map(r => r.d));
      const byDay = new Map();                                    // 'date|identity' -> source row
      data.forEach(r => byDay.set(r.d + '|' + employeeIdentity(r), r));

      const people = new Map();                                   // identity -> { code, name, statuses }
      normalized.rows.forEach(r => people.set(employeeIdentity(r), { code: r.code || '', name: r.name, statuses: { ...(r.statuses || {}) } }));
      data.forEach(r => {
        const id = employeeIdentity(r);
        if (!people.has(id)) people.set(id, { code: r.code || '', name: r.name, statuses: {} });
      });

      const dates = [...new Set([...(normalized.dates || []), ...sourceDates])].filter(d => d.startsWith(ym)).sort();
      people.forEach((person, id) => {
        if (inactive.has(id)) return;                             // same exclusion as the other reports
        const count = { P: 0, H: 0, A: 0 };
        dates.forEach(day => {
          let st = String(person.statuses[day] || '').trim().toUpperCase();
          if (sourceDates.has(day)) st = analyse(byDay.get(day + '|' + id)).st;   // latest source wins
          if (st === 'P' || st === 'H' || st === 'A') count[st]++;
        });
        const total = count.P + count.H + count.A;
        rows.push({ code: person.code, name: person.name, branch, ...count, total, pct: pct(count.P, total), days: dates.length });
      });
    });

    const businessNameAll = $id('businessName').value === 'ALL';
    const business = businessNameAll ? $id('locationType').value : $id('businessName').value;
    const scope = (business === 'ALL' ? 'ALL BUSINESSES' : business)
      + (top && top.value !== ALL_VALUE ? ` · ${top.selectedOptions[0]?.textContent || ''}` : '');
    return { ym, monthLabel: monthName(ym), scope, branchCount: branches.length, rows };
  }

  // ---------- Render ----------
  function sorted(rows) {
    const { key, dir } = sort;
    const num = COLUMNS.find(c => c.key === key)?.num;
    return [...rows].sort((a, b) => {
      const r = num ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key]), undefined, { numeric: true });
      return (r || String(a.name).localeCompare(String(b.name)) || String(a.branch).localeCompare(String(b.branch))) * dir;
    });
  }

  function render() {
    if (!model) return;
    const q = String($id('employeeSearch')?.value || '').trim().toLowerCase();
    const shown = sorted(model.rows.filter(r => !q || `${r.code} ${r.name}`.toLowerCase().includes(q)));
    const sum = shown.reduce((t, r) => { t.P += r.P; t.H += r.H; t.A += r.A; return t; }, { P: 0, H: 0, A: 0 });
    const total = sum.P + sum.H + sum.A;

    $id('monthlyHint').textContent =
      `${model.monthLabel} · ${model.scope} · ${shown.length} employee${shown.length === 1 ? '' : 's'}`
      + ` · ${model.branchCount} branch${model.branchCount === 1 ? '' : 'es'}. Totals count recorded days only (blank matrix cells are skipped).`;

    $id('monthlyCards').innerHTML = [['Present', sum.P], ['Half Day', sum.H], ['Absent', sum.A]]
      .map(([label, n]) => `<div class="card"><div class="label">${label} (days)</div><div class="value">${n}</div>`
        + `<div class="sub">${pct(n, total)}% of recorded days</div></div>`).join('');

    $id('monthlyHead').innerHTML = '<tr>' + COLUMNS.map(c => {
      const active = sort.key === c.key;
      const arrow = active ? (sort.dir > 0 ? ' ▲' : ' ▼') : '';
      return c.nosort ? `<th>${c.label}</th>`
        : `<th class="sortable${c.num ? ' num' : ''}" data-sort="${c.key}" tabindex="0" aria-sort="${active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${c.label}${arrow}</th>`;
    }).join('') + '</tr>';

    $id('monthlyBody').innerHTML = shown.length
      ? shown.map((r, i) => `<tr>
          <td>${i + 1}</td><td>${text(r.code)}</td><td>${text(r.name)}</td><td class="nowrap">${text(r.branch)}</td>
          <td class="num"><span class="pill P">${r.P}</span></td>
          <td class="num"><span class="pill H">${r.H}</span></td>
          <td class="num"><span class="pill A">${r.A}</span></td>
          <td class="num">${r.total}</td>
          <td class="num monthly-pct"><span class="monthly-bar" aria-hidden="true"><i class="p" style="width:${pct(r.P, r.total)}%"></i><i class="h" style="width:${pct(r.H, r.total)}%"></i><i class="a" style="width:${pct(r.A, r.total)}%"></i></span>${r.pct}%</td>
        </tr>`).join('')
      : `<tr><td colspan="${COLUMNS.length}" class="empty">No employees found.</td></tr>`;
  }

  function message(msg, isError) {
    $id('monthlyHint').textContent = '';
    $id('monthlyCards').innerHTML = '';
    $id('monthlyHead').innerHTML = '';
    $id('monthlyBody').innerHTML = `<tr><td class="empty">${isError ? 'Error: ' : ''}${text(msg)}</td></tr>`;
  }

  async function loadMonthly() {
    const token = ++loadToken;
    window.addAllBranchOption?.();      // the slicers rebuild the Branch list, so put the ALL entry back
    message('Loading…', false);
    try {
      const result = await collect();
      if (token !== loadToken) return;
      model = result;
      render();
    } catch (e) {
      if (token === loadToken) message(e.message || String(e), true);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const head = $id('monthlyHead');
    const apply = th => {
      const key = th && th.dataset.sort;
      if (!key) return;
      sort = { key, dir: sort.key === key ? -sort.dir : 1 };
      render();
    };
    head.addEventListener('click', e => apply(e.target.closest('th')));
    head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(e.target.closest('th')); } });
    $id('employeeSearch')?.addEventListener('input', () => { if (window.monthlyOpen()) render(); });
  });

  window.loadMonthly = loadMonthly;
  window.monthlyOpen = () => { const el = $id('monthly'); return Boolean(el) && !el.classList.contains('hidden'); };
})();
