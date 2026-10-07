// Punch-out Report: how many employees punched out during each 30-minute slot.
// Mirror of the Punch-in Report. Loaded after app.js and punchin.js and reuses their helpers
// ($, api, toMin, fixOut, employeeIdentity, ...). Scope rules (business, location type, date,
// inactive employees) are identical to the Punch-in Report, so the totals agree.
//
// Counted: employees who punched IN on the selected date (they are the ones who can punch out).
//   - a punch-out time  -> the slot that contains it
//   - punched in, no punch-out -> "No punch-out"
// Employees with no punch at all that day (absent) are not part of this chart; the "Not in" note
// under the first card shows how many they are.
(function () {
  'use strict';

  // ---------- Slots ----------
  const START = 16 * 60;                        // first slot begins at 04:00 PM
  const END = 20 * 60;                          // slots run until 08:00 PM
  const STEP = 30;                              // minutes per slot
  const SLOT_COUNT = (END - START) / STEP;      // 8

  const clock = m => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')}`;
  const meridiem = m => (m % 1440) < 720 ? 'AM' : 'PM';
  const fullRange = (s, e) => meridiem(s) === meridiem(e)
    ? `${clock(s)} – ${clock(e)} ${meridiem(e)}`
    : `${clock(s)} ${meridiem(s)} – ${clock(e)} ${meridiem(e)}`;
  const axisRange = (s, e) => `${clock(s)}–${clock(e)}${s >= 720 ? ' pm' : ''}`;

  const BUCKETS = [{ kind: 'early', label: `Before ${clock(START)} PM`, axis: `Before ${clock(START)}` }];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = START + i * STEP, e = s + STEP;
    BUCKETS.push({ kind: 'slot', label: fullRange(s, e), axis: axisRange(s, e) });
  }
  BUCKETS.push({ kind: 'after', label: `${clock(END)} PM or later`, axis: `${clock(END)} pm or later` });
  BUCKETS.push({ kind: 'none', label: 'No punch-out', axis: 'No punch-out' });
  const IDX_AFTER = SLOT_COUNT + 1;
  const IDX_NONE = SLOT_COUNT + 2;

  function bucketIndex(outM) {
    if (outM == null) return IDX_NONE;
    if (outM < START) return 0;
    if (outM >= END) return IDX_AFTER;
    return 1 + Math.floor((outM - START) / STEP);
  }

  // ---------- State ----------
  let model = null;       // { date, scope, all, rows, ... }
  let branchKey = 'ALL';  // 'ALL' or a branch row key ('b:<SOURCE NAME>')
  let followTop = true;   // true: the graph follows the Branch dropdown at the top of the page
  let loadToken = 0;
  const ALL_VALUE = '__ALL__';   // the "ALL" entry added to the top Branch dropdown by punchin.js

  const $id = id => document.getElementById(id);
  const text = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const emptyCounts = () => new Array(BUCKETS.length).fill(0);
  const pct = (n, d) => d ? `${Math.round((n / d) * 100)}%` : '0%';
  const blank = (key, label) => ({ key, label, counts: emptyCounts(), total: 0, early: 0, away: 0 });

  function addInto(target, row) {
    row.counts.forEach((n, i) => { target.counts[i] += n; });
    target.total += row.total;
    target.early += row.early;
    target.away += row.away;
  }

  // Row key of the branch currently chosen in the top Branch dropdown.
  function topBranchKey() {
    const top = $id('branch');
    const source = top && top.value !== ALL_VALUE && top.selectedOptions[0]?.dataset.source;
    return source ? `b:${String(source).toUpperCase()}` : 'ALL';
  }

  function syncTopBranch() {
    const top = $id('branch');
    if (!top) return;
    if (branchKey === 'ALL') {
      if ([...top.options].some(o => o.value === ALL_VALUE)) top.value = ALL_VALUE;
      return;
    }
    const match = [...top.options].find(o => `b:${String(o.dataset.source).toUpperCase()}` === branchKey);
    if (match) top.value = match.value;
  }

  // ---------- Data ----------
  async function collect() {
    const businessNameAll = $('businessName').value === 'ALL';
    const selectedBusiness = $('businessName').value;
    const locationType = $('locationType').value;
    const selectedBusinessType = businessNameAll ? locationType : selectedBusiness;
    const allBusinesses = businessNameAll && selectedBusinessType === 'ALL';
    const businesses = allBusinesses ? BUSINESS_ORDER : [selectedBusinessType];

    const branches = slicerBranchSources(await api('/api/branches'));   // only what the slicers select
    const [, all] = await Promise.all([
      loadAttendanceMatrices(branches),
      Promise.all(branches.map(async branch => ({ branch, data: await api('/api/data', { branch }) })))
    ]);
    const date = $('date').value || defaultDate(all.flatMap(x => x.data.map(r => r.d)));
    const scope = allBusinesses
      ? 'ALL BUSINESSES'
      : selectedBusinessType === 'MAGNUS'
        ? businessNameAll ? 'MAGNUS' : `MAGNUS: ${locationType === 'core-office' ? 'CORE OFFICE' : 'BRANCH'}`
        : selectedBusinessType;

    const rowsByBranch = new Map(all.map(({ branch, data }) => {
      const employees = [...new Map(data.map(row => [employeeIdentity(row), row])).values()];
      const inactiveKeys = inactiveEmployeeKeys(branch, data) || new Set();
      const active = employees.filter(employee => !inactiveKeys.has(employeeIdentity(employee)));
      const day = new Map(data.filter(row => row.d === date).map(row => [employeeIdentity(row), row]));
      const row = blank(`b:${branch.toUpperCase()}`, branch);
      active.forEach(employee => {
        const punch = day.get(employeeIdentity(employee));
        const inM = punch ? toMin(punch.inT) : null;
        const outM = punch ? fixOut(inM, toMin(punch.outT), punch.outT) : null;
        if (inM == null && outM == null) { row.away++; return; }      // no punch at all: absent
        row.counts[bucketIndex(outM)]++;
        row.total++;
        if (outM != null && outM < EARLY_BEFORE) row.early++;
      });
      return [branch.toUpperCase(), row];
    }));

    const groups = [];
    businesses.forEach(business => {
      const branchRows = (BUSINESS_BRANCHES[business] || [])
        .map(branch => rowsByBranch.get(branchSourceName(business, branch).toUpperCase()))
        .filter(Boolean);
      const officeRows = business === 'MAGNUS'
        ? CORE_OFFICES[business].map(branch => rowsByBranch.get(CORE_OFFICE_SOURCE_ALIASES[branch].toUpperCase())).filter(Boolean)
        : [];
      if (business === 'MAGNUS') {
        if (businessNameAll || locationType === 'branch') groups.push({ label: 'MAGNUS: BRANCH', rows: branchRows });
        if (businessNameAll || locationType === 'core-office') groups.push({ label: 'MAGNUS: CORE OFFICE', rows: officeRows });
      } else {
        groups.push({ label: business, rows: branchRows });
      }
    });

    const visible = groups.filter(group => group.rows.length).map(group => {
      const sum = blank(`g:${group.label}`, group.label);
      group.rows.forEach(row => addInto(sum, row));
      return { ...group, sum };
    });
    const rows = [...new Map(visible.flatMap(group => group.rows).map(row => [row.key, row])).values()];
    const all_ = blank('ALL', 'All branches');
    rows.forEach(row => addInto(all_, row));

    // Business-wise counts (MAGNUS branch + core office combined), used for the expanded tooltip.
    const byBusiness = new Map();
    visible.forEach(group => {
      const name = group.label.split(':')[0];
      if (!byBusiness.has(name)) byBusiness.set(name, blank(`n:${name}`, name));
      addInto(byBusiness.get(name), group.sum);
    });
    return { date, scope, all: all_, rows, allBusinesses, byBusiness: [...byBusiness.values()] };
  }

  // ---------- Rendering ----------
  function peakOf(counts) {
    let best = -1;
    for (let i = 0; i < IDX_NONE; i++) if (counts[i] > 0 && (best < 0 || counts[i] > counts[best])) best = i;
    return best;
  }

  function renderCards(scope) {
    const out = scope.total - scope.counts[IDX_NONE];
    const peak = peakOf(scope.counts);
    $id('punchoutCards').innerHTML = [
      ['Punched out', out, `of ${scope.total} who punched in (${pct(out, scope.total)})` + (scope.away ? ` · ${scope.away} not in` : ''), ''],
      [`Left before ${clock(EARLY_BEFORE)} PM`, scope.early, `${pct(scope.early, out)} of punch-outs`, ''],
      ['No punch-out', scope.counts[IDX_NONE], `${pct(scope.counts[IDX_NONE], scope.total)} of those who punched in`, ''],
      ['Busiest slot', peak < 0 ? '—' : BUCKETS[peak].label, peak < 0 ? '' : `${scope.counts[peak]} employees`, ' small']
    ].map(([label, value, sub, cls]) =>
      `<div class="card"><div class="label">${text(label)}</div><div class="value${cls}">${text(value)}</div><div class="sub">${text(sub)}</div></div>`
    ).join('');
  }

  function niceStep(max) {
    const raw = max / 5;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const frac = raw / pow;
    return Math.max(1, (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow);
  }

  // Plain SVG chart, used only when the Highcharts CDN cannot be loaded.
  function renderChartSvg(scope, byBusiness) {
    const W = 920, H = 340, L = 46, R = 14, T = 44, B = 84;
    const iw = W - L - R, ih = H - T - B;
    const n = BUCKETS.length, band = iw / n, bw = Math.min(44, band * 0.66);
    const max = Math.max(1, ...scope.counts);
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = v => T + ih - (v / top) * ih;
    const peak = peakOf(scope.counts);

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-labelledby="punchoutChartTitle">`;
    for (let v = 0; v <= top; v += step) {
      svg += `<line class="pb-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`
        + `<text class="pb-tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    BUCKETS.forEach((bucket, i) => {
      const v = scope.counts[i];
      const cx = L + i * band + band / 2;
      const cls = i === peak ? 'peak' : bucket.kind === 'early' ? 'after' : bucket.kind;
      let tip = `${bucket.label}: ${v} employee${v === 1 ? '' : 's'} (${pct(v, scope.total)} of ${scope.total})`;
      if (byBusiness && v > 0)
        tip += byBusiness.filter(b => b.counts[i] > 0).map(b => `\n${b.label}: ${b.counts[i]}`).join('');
      svg += `<g class="pb-col"><title>${text(tip)}</title>`
        + `<rect class="pb-hit" x="${L + i * band}" y="${T}" width="${band}" height="${ih}"/>`
        + (v > 0 ? `<rect class="pb-bar ${cls}" x="${cx - bw / 2}" y="${y(v)}" width="${bw}" height="${(v / top) * ih}" rx="3"/>`
          + `<text class="pb-val" x="${cx}" y="${y(v) - 6}" text-anchor="middle">${v}</text>` : '')
        + `</g>`
        + `<text class="pb-axis" transform="translate(${cx + 4},${T + ih + 16}) rotate(-35)" text-anchor="end">${text(bucket.axis)}</text>`;
    });
    if (EARLY_BEFORE >= START && EARLY_BEFORE < END) {
      const x = L + (1 + (EARLY_BEFORE - START) / STEP) * band;
      svg += `<line class="pb-late" x1="${x}" x2="${x}" y1="${T - 16}" y2="${T + ih}"/>`
        + `<text class="pb-late-label" x="${x + 5}" y="${T - 22}">Early before ${clock(EARLY_BEFORE)} PM</text>`;
    }
    svg += `<line class="pb-base" x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}"/></svg>`;
    $id('punchoutChart').innerHTML = svg;
  }

  // ---------- Highcharts ----------
  let chart = null;
  function destroyChart() {
    if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
  }

  function renderChart(scope, byBusiness) {
    if (!window.Highcharts) return renderChartSvg(scope, byBusiness);   // CDN blocked: use the built-in SVG chart
    destroyChart();
    const box = $id('punchoutChart');
    box.innerHTML = '';

    const css = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const col = {
      slot: v('--navy-soft', '#16403d'), peak: v('--gold', '#c9a24b'), early: v('--red', '#b3382e'),
      none: v('--faint', '#9a937c'), line: v('--late', '#b45309'), text: v('--text', '#1b2b29'),
      muted: v('--muted', '#6f6a58'), border: v('--border', 'rgba(74, 65, 40, .14)'),
      surface: v('--surface', '#ffffff')
    };
    const peak = peakOf(scope.counts);
    const colorOf = (bucket, i) => i === peak ? col.peak : bucket.kind === 'early' ? col.early : bucket.kind === 'none' ? col.none : col.slot;
    const plural = n => `${n} employee${n === 1 ? '' : 's'}`;
    const lineX = 1 + (EARLY_BEFORE - START) / STEP - 0.5;      // axis units: category i is centred on i

    chart = Highcharts.chart(box, {
      chart: { type: 'column', height: 340, backgroundColor: 'transparent', spacing: [18, 10, 10, 6],
               style: { fontFamily: getComputedStyle(box).fontFamily } },
      title: { text: null }, credits: { enabled: false }, legend: { enabled: false },
      xAxis: {
        categories: BUCKETS.map(b => b.axis),
        lineColor: col.muted, tickLength: 0,
        labels: { rotation: -35, style: { color: col.muted, fontSize: '11px' } },
        crosshair: { color: 'rgba(201, 162, 75, .12)' },
        plotLines: (EARLY_BEFORE >= START && EARLY_BEFORE < END) ? [{
          value: lineX, color: col.line, width: 1.5, dashStyle: 'Dash', zIndex: 5,
          label: { text: `Early before ${clock(EARLY_BEFORE)} PM`, rotation: 0, x: 5, y: 12,
                   style: { color: col.line, fontWeight: '700', fontSize: '11px' } }
        }] : []
      },
      yAxis: {
        title: { text: null }, min: 0, allowDecimals: false, gridLineColor: col.border,
        labels: { style: { color: col.muted, fontSize: '11px' } }
      },
      plotOptions: {
        series: { animation: { duration: 250 }, states: { inactive: { opacity: 1 } } },
        column: { borderWidth: 0, borderRadius: 3, maxPointWidth: 44, pointPadding: 0.12, groupPadding: 0 }
      },
      tooltip: {
        shared: true, useHTML: true, outside: true, borderRadius: 8, borderColor: col.peak,
        backgroundColor: col.surface, shadow: false, style: { color: col.text, fontSize: '12px' },
        formatter() {
          const i = this.points[0].point.index, n = scope.counts[i], bucket = BUCKETS[i];
          let html = `<div style="min-width:150px"><b>${text(bucket.label)}</b><br>`
            + `${plural(n)} (${pct(n, scope.total)} of ${scope.total})`;
          if (byBusiness && n > 0) {              // ALL BUSINESS view only: business-wise split
            const parts = byBusiness.filter(b => b.counts[i] > 0);
            html += `<table style="width:100%;margin-top:6px;border-top:1px solid ${col.border};border-collapse:collapse">`
              + parts.map(b => `<tr><td style="padding:2px 0">${text(b.label)}</td>`
                + `<td style="padding:2px 0 2px 16px;text-align:right;font-weight:700">${b.counts[i]}</td></tr>`).join('')
              + '</table>';
          }
          return html + '</div>';
        }
      },
      series: [{
        name: 'Employees',
        data: BUCKETS.map((bucket, i) => ({ y: scope.counts[i], color: colorOf(bucket, i) })),
        dataLabels: {
          enabled: true, style: { color: col.text, fontSize: '11px', fontWeight: '700', textOutline: 'none' },
          formatter() { return this.y ? this.y : null; }
        }
      }]
    });
  }

  // Decide which branch to chart: the top Branch dropdown, or the whole Business selection.
  function resolveBranch() {
    if (followTop) branchKey = topBranchKey();
    if (!model.rows.some(row => row.key === branchKey)) branchKey = 'ALL';
    syncTopBranch();
  }

  function render() {
    if (!model) return;
    const row = branchKey === 'ALL' ? null : model.rows.find(r => r.key === branchKey);
    const scope = row || model.all;
    const scopeName = row ? `${row.label} (${model.scope})` : model.scope;
    if (!model.all.total && !model.all.away)
      return showMessage('No data for the selected Business Name / Business Type.', false);
    $id('punchoutHint').textContent = model.date
      ? `Punch-out times for ${dmy(model.date)} (${scopeName}).`
        + (scope.total ? '' : ' Nobody punched in on this date (weekly off / holiday?).')
      : '';
    $id('punchoutChartTitle').textContent = `Employees by punch-out time · ${row ? row.label : model.scope}`;
    renderCards(scope);
    renderChart(scope, model.allBusinesses && !row ? model.byBusiness : null);
  }

  function showMessage(message, isError) {
    $id('punchoutCards').innerHTML = '';
    $id('punchoutChartTitle').textContent = 'Employees by punch-out time';
    destroyChart();
    $id('punchoutChart').innerHTML = `<div class="empty">${isError ? 'Error: ' : ''}${text(message)}</div>`;
  }

  // Loading state: shimmering placeholder cards + chart instead of a plain "Loading…" text.
  const skeletonBars = [38, 62, 84, 100, 76, 52, 44, 30, 22, 16, 12, 8, 6];
  function showLoading() {
    $id('punchoutCards').innerHTML = `<div class="card skeleton-card" aria-hidden="true"><div class="sk sk-label"></div><div class="sk sk-value"></div><div class="sk sk-sub"></div></div>`.repeat(4);
    $id('punchoutChartTitle').textContent = 'Employees by punch-out time';
    destroyChart();
    $id('punchoutChart').innerHTML = '<div class="chart-skeleton" role="status" aria-label="Loading">'
      + skeletonBars.map(h => `<i class="sk" style="height:${h}%"></i>`).join('') + '</div>';
  }

  async function loadPunchout() {
    const token = ++loadToken;
    showLoading();
    try {
      const result = await collect();
      if (token !== loadToken) return;      // a newer load replaced this one
      model = result;
      resolveBranch();
      render();
    } catch (e) {
      if (token === loadToken) showMessage(e.message || String(e), true);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Top Branch dropdown -> graph shows that branch.
    const top = $id('branch');
    if (top) top.addEventListener('change', () => { followTop = true; }, true);
    // Business Name / Business Type -> graph shows the whole selection until a branch is picked.
    ['businessName', 'locationType'].forEach(id => {
      const el = $id(id);
      if (el) el.addEventListener('change', () => { followTop = false; branchKey = 'ALL'; }, true);
    });
  });

  document.addEventListener('attendance-theme-change', () => { if (model) render(); });

  // Opening the tab: follow the top Branch dropdown again and fit the chart to its container.
  if (typeof window.showTab === 'function') {
    const previousShowTab = window.showTab;
    window.showTab = function (tab) {
      if (tab === 'punchout') followTop = true;
      const result = previousShowTab.apply(this, arguments);
      if (tab === 'punchout') setTimeout(() => { if (chart) chart.reflow(); }, 0);
      return result;
    };
  }

  window.loadPunchout = loadPunchout;
  window.punchoutOpen = () => { const el = $id('punchout'); return Boolean(el) && !el.classList.contains('hidden'); };
})();