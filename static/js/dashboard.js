// Dashboard: the landing page. One screen with the Punch-in, Punch-out and Present/Absent views.
// Loaded after app.js / punchin.js / punchout.js and reuses their helpers ($, api, toMin, fixOut,
// employeeIdentity, slicerBranchSources, ...). Everything follows the slicers (Business Name,
// Location Type, Branch, Date) exactly like the Punch-in / Punch-out reports, so the numbers agree:
//   - Punch-in  : every active employee is counted (no punch-in = absent)
//   - Punch-out : employees who punched in that day (no punch-out = "No punch-out")
(function () {
  'use strict';

  // ---------- Slots (same as punchin.js / punchout.js) ----------
  const STEP = 30;
  const clock = m => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')}`;
  const meridiem = m => (m % 1440) < 720 ? 'AM' : 'PM';
  const fullRange = (s, e) => meridiem(s) === meridiem(e)
    ? `${clock(s)} – ${clock(e)} ${meridiem(e)}`
    : `${clock(s)} ${meridiem(s)} – ${clock(e)} ${meridiem(e)}`;
  const axisRange = (s, e) => `${clock(s)}–${clock(e)}${s >= 720 ? ' pm' : ''}`;

  function makeBuckets(start, end, before, after, none) {
    const list = [{ kind: 'early', label: before.label, axis: before.axis }];
    for (let s = start; s < end; s += STEP)
      list.push({ kind: 'slot', label: fullRange(s, s + STEP), axis: axisRange(s, s + STEP) });
    list.push({ kind: 'after', label: after.label, axis: after.axis });
    list.push({ kind: 'none', label: none, axis: none });
    return list;
  }

  const IN_START = 8 * 60 + 30, IN_END = 14 * 60;
  const OUT_START = 16 * 60, OUT_END = 20 * 60;
  const IN = makeBuckets(IN_START, IN_END,
    { label: 'Before 8:30 AM', axis: 'Before 8:30' },
    { label: '2:00 PM or later', axis: '2:00 pm or later' }, 'No punch-in');
  const OUT = makeBuckets(OUT_START, OUT_END,
    { label: 'Before 4:00 PM', axis: 'Before 4:00' },
    { label: '8:00 PM or later', axis: '8:00 pm or later' }, 'No punch-out');
  const IN_NONE = IN.length - 1, OUT_NONE = OUT.length - 1;

  const inIndex = m => m == null ? IN_NONE : m < IN_START ? 0 : m >= IN_END ? IN.length - 2 : 1 + Math.floor((m - IN_START) / STEP);
  const outIndex = m => m == null ? OUT_NONE : m < OUT_START ? 0 : m >= OUT_END ? OUT.length - 2 : 1 + Math.floor((m - OUT_START) / STEP);

  // ---------- Helpers ----------
  const $id = id => document.getElementById(id);
  const text = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (n, d) => d ? `${Math.round((n / d) * 100)}%` : '0%';
  const plural = (n, word = 'employee') => `${n} ${word}${n === 1 ? '' : 's'}`;
  const ALL_VALUE = '__ALL__';       // the "ALL" entry in the top Branch dropdown (added by punchin.js)

  const blank = (key, label) => ({
    key, label, inC: new Array(IN.length).fill(0), outC: new Array(OUT.length).fill(0),
    total: 0, late: 0, outTotal: 0, early: 0, away: 0,
    P: 0, H: 0, A: 0            // status counts, same P / H / A rules as the Overall Summary
  });
  function addInto(target, row) {
    row.inC.forEach((n, i) => { target.inC[i] += n; });
    row.outC.forEach((n, i) => { target.outC[i] += n; });
    ['total', 'late', 'outTotal', 'early', 'away', 'P', 'H', 'A'].forEach(k => { target[k] += row[k]; });
  }
  // Present / Half day / Absent follow the Overall Summary (analyse() in app.js):
  //   P = worked more than 5h, H = 4h to 5h, A = under 4h, no record, or punched in after 2:00 PM.
  const presentOf = r => r.P;
  const halfOf = r => r.H;
  const absentOf = r => r.A;
  const punchedOf = r => r.total - r.inC[IN_NONE];      // anyone with a punch-in (used by the punch-in chart)

  // ---------- State ----------
  let model = null;          // { date, scope, all, rows, groups, allBusinesses, byBusiness }
  let branchKey = 'ALL';     // 'ALL' or a branch row key ('b:<SOURCE NAME>')
  let followTop = false;     // first landing shows the whole slicer selection; afterwards the Branch dropdown wins
  let loadedOnce = false;
  let loadToken = 0;
  const charts = { inn: null, out: null, pie: null };

  function destroyCharts() {
    Object.keys(charts).forEach(k => {
      if (charts[k]) { try { charts[k].destroy(); } catch (e) { /* ignore */ } charts[k] = null; }
    });
  }

  function hasRealBranch() {
    const top = $id('branch');
    return Boolean(top) && [...top.options].some(o => o.value !== ALL_VALUE);
  }
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
        row[analyse(punch).st]++;                      // P / H / A exactly like the Overall Summary
        row.inC[inIndex(inM)]++;
        row.total++;
        if (inM != null && inM > LATE_AFTER) row.late++;
        if (inM == null && outM == null) { row.away++; return; }       // no punch at all: not part of punch-out
        row.outC[outIndex(outM)]++;
        row.outTotal++;
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

    // Business-wise counts (MAGNUS branch + core office combined), used for the expanded tooltips.
    const byBusiness = new Map();
    visible.forEach(group => {
      const name = group.label.split(':')[0];
      if (!byBusiness.has(name)) byBusiness.set(name, blank(`n:${name}`, name));
      addInto(byBusiness.get(name), group.sum);
    });
    return { date, scope, all: all_, rows, groups: visible, allBusinesses, byBusiness: [...byBusiness.values()] };
  }

  // ---------- Rendering ----------
  function peakOf(counts, noneIdx) {
    let best = -1;
    for (let i = 0; i < noneIdx; i++) if (counts[i] > 0 && (best < 0 || counts[i] > counts[best])) best = i;
    return best;
  }

  function renderKpis(s) {
    const present = presentOf(s), half = halfOf(s), absent = absentOf(s), punched = punchedOf(s);
    const outPunched = s.outTotal - s.outC[OUT_NONE];
    const pIn = peakOf(s.inC, IN_NONE), pOut = peakOf(s.outC, OUT_NONE);
    const tiles = [
      ['green', 'Present', present, `${pct(present, s.total)} of ${s.total} active` + (half ? ` · ${half} half day` : ''), ''],
      ['red', 'Absent', absent, `${pct(absent, s.total)} of ${s.total} active`, ''],
      ['amber', `Late after ${clock(LATE_AFTER)}`, s.late, `${pct(s.late, punched)} of punch-ins`, ''],
      ['amber', `Left before ${clock(EARLY_BEFORE)} PM`, s.early, `${pct(s.early, outPunched)} of punch-outs`, ''],
      ['navy', 'Peak punch-in', pIn < 0 ? '—' : IN[pIn].label, pIn < 0 ? '' : plural(s.inC[pIn]), ' small'],
      ['navy', 'Peak punch-out', pOut < 0 ? '—' : OUT[pOut].label, pOut < 0 ? '' : plural(s.outC[pOut]), ' small']
    ];
    $id('dashKpis').innerHTML = tiles.map(([tone, label, value, sub, cls]) =>
      `<div class="card dash-kpi ${tone}"><div class="label">${text(label)}</div>`
      + `<div class="value${cls}">${text(value)}</div><div class="sub">${text(sub)}</div></div>`).join('');
  }

  // Colours come from the premium palette defined on #dashboard in dashboard.css (light and dark).
  function themeColors(box) {
    const css = getComputedStyle($id('dashboard') || document.documentElement);
    const v = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    const grad = (hi, lo) => ({ linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 }, stops: [[0, hi], [1, lo]] });
    return {
      slot: v('--navy-soft', '#14504a'), peak: v('--gold', '#c9a24b'), red: v('--red', '#a42e38'),
      none: v('--faint', '#a39b86'), late: v('--late', '#a8650f'), text: v('--text', '#1b2b29'),
      muted: v('--muted', '#6f6a58'), border: v('--border', 'rgba(74, 65, 40, .14)'),
      surface: v('--d-card-1', '#ffffff'), green: v('--green-fg', '#1b7653'),
      // gradient fills (top -> bottom) for bars and donut slices
      slotG: grad(v('--d-emerald-hi', '#2f8274'), v('--d-emerald-lo', '#0d3732')),
      peakG: grad(v('--d-gold-hi', '#efd590'), v('--d-gold-lo', '#b7872f')),
      redG: grad(v('--d-ruby-hi', '#c75a60'), v('--d-ruby-lo', '#8a1f2d')),
      noneG: grad(v('--d-taupe-hi', '#c1b9a4'), v('--d-taupe-lo', '#8e876e')),
      greenG: grad(v('--d-jade-hi', '#38a478'), v('--d-jade-lo', '#14573f')),
      font: getComputedStyle(box).fontFamily
    };
  }

  // ---------- fit the dashboard to the window ----------
  // The dashboard is as tall as the space under the header (see dashboard.css); the cards share that
  // height and each chart is drawn at exactly the size of its box, so it fills any display size / zoom.
  function fitToWindow() {
    const dash = $id('dashboard');
    if (!dash || dash.classList.contains('hidden')) return;
    const top = dash.getBoundingClientRect().top + window.scrollY;
    const h = Math.max(520, window.innerHeight - top - 16);
    dash.style.setProperty('--dash-h', Math.round(h) + 'px');
  }
  const boxHeight = (box, min) => Math.max(min, Math.floor(box.clientHeight) || 260);

  // One column chart (used for punch-in and punch-out).
  function columnChart(slot, boxId, spec) {
    const box = $id(boxId);
    if (!box) return;
    if (charts[slot]) { try { charts[slot].destroy(); } catch (e) { /* ignore */ } charts[slot] = null; }
    box.innerHTML = '';
    if (!window.Highcharts) {
      box.innerHTML = '<div class="empty">Charts could not be loaded (Highcharts CDN blocked).</div>';
      return;
    }
    const col = themeColors(box);
    const { buckets, counts, total, peak, cutX, cutLabel, redKinds, byBusiness, pick } = spec;
    const colorOf = (bucket, i) => i === peak ? col.peakG : redKinds.includes(bucket.kind) ? col.redG : bucket.kind === 'none' ? col.noneG : col.slotG;

    charts[slot] = Highcharts.chart(box, {
      chart: { type: 'column', height: boxHeight(box, 110), backgroundColor: 'transparent', spacing: [18, 10, 6, 4],
               style: { fontFamily: col.font } },
      title: { text: null }, credits: { enabled: false }, legend: { enabled: false },
      xAxis: {
        categories: buckets.map(b => b.axis), lineColor: col.muted, tickLength: 0,
        labels: { rotation: -35, style: { color: col.muted, fontSize: boxHeight(box, 110) < 230 ? '10px' : '11px', textOverflow: 'none', whiteSpace: 'nowrap' } },
        crosshair: { color: 'rgba(201, 162, 75, .12)' },
        plotLines: [{ value: cutX, color: col.late, width: 1.5, dashStyle: 'Dash', zIndex: 5,
                      label: { text: cutLabel, rotation: 0, x: 5, y: 12,
                               style: { color: col.late, fontWeight: '700', fontSize: '11px' } } }]
      },
      yAxis: { title: { text: null }, min: 0, maxPadding: 0.16, allowDecimals: false, gridLineColor: col.border,
               labels: { style: { color: col.muted, fontSize: '11px' } } },
      plotOptions: {
        series: { animation: { duration: 250 }, states: { inactive: { opacity: 1 } } },
        column: { borderWidth: 0, borderRadius: 3, maxPointWidth: 44, pointPadding: 0.12, groupPadding: 0 }
      },
      tooltip: {
        shared: true, useHTML: true, outside: true, borderRadius: 8, borderColor: col.peak,
        backgroundColor: col.surface, shadow: false, style: { color: col.text, fontSize: '12px' },
        formatter() {
          const i = this.points[0].point.index, n = counts[i];
          let html = `<div style="min-width:150px"><b>${text(buckets[i].label)}</b><br>${plural(n)} (${pct(n, total)} of ${total})`;
          if (byBusiness && n > 0) {
            const parts = byBusiness.filter(b => pick(b)[i] > 0);
            html += `<table style="width:100%;margin-top:6px;border-top:1px solid ${col.border};border-collapse:collapse">`
              + parts.map(b => `<tr><td style="padding:2px 0">${text(b.label)}</td>`
                + `<td style="padding:2px 0 2px 16px;text-align:right;font-weight:700">${pick(b)[i]}</td></tr>`).join('')
              + '</table>';
          }
          return html + '</div>';
        }
      },
      series: [{
        name: 'Employees',
        data: buckets.map((bucket, i) => ({ y: counts[i], color: colorOf(bucket, i) })),
        dataLabels: { enabled: true, style: { color: col.text, fontSize: '11px', fontWeight: '700', textOutline: 'none' },
                      formatter() { return this.y ? this.y : null; } }
      }]
    });
  }

  function donutChart(s, byBusiness) {
    const box = $id('dashPresenceChart');
    if (!box) return;
    if (charts.pie) { try { charts.pie.destroy(); } catch (e) { /* ignore */ } charts.pie = null; }
    box.innerHTML = '';
    const present = presentOf(s), half = halfOf(s), absent = absentOf(s);
    if (!window.Highcharts) {
      box.innerHTML = `<div class="empty">Present: ${present} · Half day: ${half} · Absent: ${absent}</div>`;
      return;
    }
    const col = themeColors(box);
    const names = { present: 'Present', half: 'Half day', absent: 'Absent' };
    const countOf = (b, key) => key === 'present' ? presentOf(b) : key === 'half' ? halfOf(b) : absentOf(b);
    charts.pie = Highcharts.chart(box, {
      chart: { type: 'pie', height: boxHeight(box, 130), backgroundColor: 'transparent', spacing: [4, 4, 4, 4], style: { fontFamily: col.font } },
      title: { text: `<div style="text-align:center;line-height:1.25"><div style="font-size:1.9rem;font-weight:700;color:${col.green}">${pct(present, s.total)}</div>`
                      + `<div style="font-size:.8rem;color:${col.muted}">present</div></div>`,
               useHTML: true, verticalAlign: 'middle', floating: true, y: 6 },
      credits: { enabled: false }, legend: { enabled: false },
      tooltip: {
        useHTML: true, outside: true, borderRadius: 8, borderColor: col.peak, backgroundColor: col.surface,
        shadow: false, style: { color: col.text, fontSize: '12px' },
        formatter() {
          const key = this.point.options.key, n = this.y;
          let html = `<div style="min-width:150px"><b>${names[key]}</b><br>${plural(n)} (${pct(n, s.total)} of ${s.total})`;
          if (byBusiness && n > 0) {
            const parts = byBusiness.filter(b => countOf(b, key) > 0);
            html += `<table style="width:100%;margin-top:6px;border-top:1px solid ${col.border};border-collapse:collapse">`
              + parts.map(b => `<tr><td style="padding:2px 0">${text(b.label)}</td>`
                + `<td style="padding:2px 0 2px 16px;text-align:right;font-weight:700">${countOf(b, key)}</td></tr>`).join('')
              + '</table>';
          }
          return html + '</div>';
        }
      },
      plotOptions: { pie: {
        innerSize: '68%', size: '100%', borderWidth: 3, borderColor: col.surface, dataLabels: { enabled: false },
        states: { inactive: { opacity: 1 } }, animation: { duration: 250 }
      } },
      series: [{ name: 'Employees', data: [
        { name: names.present, key: 'present', y: present, color: col.greenG },
        { name: names.half, key: 'half', y: half, color: col.peakG },
        { name: names.absent, key: 'absent', y: absent, color: col.redG }
      ] }]
    });
    $id('dashPieLegend').innerHTML =
      `<span><i style="background:var(--green-fg)"></i>Present ${present}</span>`
      + `<span><i style="background:var(--gold)"></i>Half day ${half}</span>`
      + `<span><i style="background:var(--red)"></i>Absent ${absent}</span>`;
  }

  function buildInsights(s, scopeRows) {
    const list = [];
    const present = punchedOf(s), absent = absentOf(s), half = halfOf(s);
    const outPunched = s.outTotal - s.outC[OUT_NONE];
    const pIn = peakOf(s.inC, IN_NONE), pOut = peakOf(s.outC, OUT_NONE);
    if (present) list.push(['green', `${present - s.late} of ${present} punched in on time (by ${clock(LATE_AFTER)} AM)`]);
    if (pIn >= 0) list.push(['gold', `Most arrivals (${s.inC[pIn]}) were in ${IN[pIn].label}`]);
    if (s.late) list.push(['red', `${s.late} late punch-in${s.late === 1 ? '' : 's'} after ${clock(LATE_AFTER)} AM (${pct(s.late, present)})`]);
    if (pOut >= 0) list.push(['gold', `${s.outC[pOut]} of ${outPunched} punched out in ${OUT[pOut].label}`]);
    if (s.early) list.push(['red', `${s.early} left before ${clock(EARLY_BEFORE)} PM (${pct(s.early, outPunched)})`]);
    const noOut = s.outC[OUT_NONE];
    if (absent || noOut)
      list.push(['grey', `${absent} absent` + (half ? ` · ${half} half day` : '') + (noOut ? ` · ${noOut} punched in with no punch-out` : '')]);
    if (scopeRows.length > 1) {          // whole selection: call out the branches that need attention
      const lateTop = [...scopeRows].sort((a, b) => b.late - a.late)[0];
      if (lateTop && lateTop.late) list.push(['red', `Most late punch-ins: ${lateTop.label} (${lateTop.late})`]);
      const ranked = scopeRows.filter(r => r.total).sort((a, b) => presentOf(a) / a.total - presentOf(b) / b.total)[0];
      if (ranked && absentOf(ranked)) list.push(['grey', `Lowest attendance: ${ranked.label} (${pct(presentOf(ranked), ranked.total)})`]);
    }
    return list;
  }

  function renderInsights(s, scopeRows) {
    const items = buildInsights(s, scopeRows);
    $id('dashInsights').innerHTML = items.length
      ? items.map(([tone, msg]) => `<li class="${tone}"><span>${text(msg)}</span></li>`).join('')
      : '<li class="grey"><span>No punches recorded for this selection.</span></li>';
  }

  function resolveBranch() {
    if (followTop) branchKey = topBranchKey();
    if (!model.rows.some(row => row.key === branchKey)) branchKey = 'ALL';
    syncTopBranch();
  }

  function render() {
    if (!model) return;
    const row = branchKey === 'ALL' ? null : model.rows.find(r => r.key === branchKey);
    const s = row || model.all;
    const scopeName = row ? `${row.label} (${model.scope})` : model.scope;
    if (!model.all.total && !model.all.away) return showMessage('No data for the selected Business Name / Business Type.');
    const split = model.allBusinesses && !row ? model.byBusiness : null;
    const label = row ? row.label : model.scope;

    $id('dashInTitle').textContent = `Employees by punch-in time · ${label}`;
    $id('dashOutTitle').textContent = `Employees by punch-out time · ${label}`;
    $id('dashPieTitle').textContent = 'Present vs Absent';
    renderKpis(s);

    fitToWindow();
    const pIn = peakOf(s.inC, IN_NONE), pOut = peakOf(s.outC, OUT_NONE);
    columnChart('inn', 'dashPunchinChart', {
      buckets: IN, counts: s.inC, total: s.total, peak: pIn, redKinds: ['after'], byBusiness: split, pick: b => b.inC,
      cutX: 1 + (LATE_AFTER - IN_START) / STEP - 0.5, cutLabel: `Late after ${clock(LATE_AFTER)}`
    });
    columnChart('out', 'dashPunchoutChart', {
      buckets: OUT, counts: s.outC, total: s.outTotal, peak: pOut, redKinds: ['early'], byBusiness: split, pick: b => b.outC,
      cutX: 1 + (EARLY_BEFORE - OUT_START) / STEP - 0.5, cutLabel: `Early before ${clock(EARLY_BEFORE)} PM`
    });
    donutChart(s, split);
    renderInsights(s, branchKey === 'ALL' ? model.rows : []);
    // second pass: the legend and insights are in place now, so size each chart to its final box
    [['inn', 'dashPunchinChart', 110], ['out', 'dashPunchoutChart', 110], ['pie', 'dashPresenceChart', 130]].forEach(([k, id, min]) => {
      const c = charts[k], b = $id(id);
      if (!c || !b) return;
      const h = Math.max(min, Math.floor(b.clientHeight));
      if (Math.abs(h - c.chartHeight) > 2) c.setSize(null, h, false);
    });
    setMsg('');                       // the dashboard shows no status line
  }

  function showMessage(message, isError) {
    fitToWindow();
    destroyCharts();
    $id('dashKpis').innerHTML = '';
    $id('dashInsights').innerHTML = '';
    $id('dashPieLegend').innerHTML = '';
    const html = `<div class="empty">${isError ? 'Error: ' : ''}${text(message)}</div>`;
    ['dashPunchinChart', 'dashPunchoutChart', 'dashPresenceChart'].forEach(id => { $id(id).innerHTML = html; });
  }

  const skeletonBars = [38, 62, 84, 100, 76, 52, 44, 30, 22, 16, 12, 8, 6];
  function showLoading() {
    fitToWindow();
    destroyCharts();
    $id('dashKpis').innerHTML = `<div class="card skeleton-card" aria-hidden="true"><div class="sk sk-label"></div><div class="sk sk-value"></div><div class="sk sk-sub"></div></div>`.repeat(6);
    const bars = '<div class="chart-skeleton" role="status" aria-label="Loading">'
      + skeletonBars.map(h => `<i class="sk" style="height:${h}%"></i>`).join('') + '</div>';
    $id('dashPunchinChart').innerHTML = bars;
    $id('dashPunchoutChart').innerHTML = bars;
    $id('dashPresenceChart').innerHTML = '<div class="pie-skeleton" role="status" aria-label="Loading"><i class="sk"></i></div>';
    $id('dashInsights').innerHTML = '';
    $id('dashPieLegend').innerHTML = '';
  }

  async function loadDashboard() {
    const token = ++loadToken;
    window.addAllBranchOption?.();            // the slicers rebuild the Branch list, so put the ALL entry back
    if (!hasRealBranch()) { showLoading(); return; }   // branches are not loaded yet; loadBranches() will call us again
    showLoading();
    try {
      const result = await collect();
      if (token !== loadToken) return;        // a newer load replaced this one
      model = result;
      if (!$('date').value && model.date) $('date').value = model.date;   // the Branch dropdown clears it; show the date in use
      resolveBranch();
      render();
      loadedOnce = true;
    } catch (e) {
      if (token === loadToken) showMessage(e.message || String(e), true);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Top Branch dropdown -> the dashboard shows that branch (or ALL).
    const top = $id('branch');
    if (top) top.addEventListener('change', () => { followTop = true; }, true);
    // Business Name / Location Type -> the dashboard shows the whole selection until a branch is picked.
    ['businessName', 'locationType'].forEach(id => {
      const el = $id(id);
      if (el) el.addEventListener('change', () => { followTop = false; branchKey = 'ALL'; }, true);
    });
  });

  document.addEventListener('attendance-theme-change', () => { if (model && window.dashboardOpen()) render(); });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (model && window.dashboardOpen()) render(); }, 150);
  });

  // Opening the tab again: follow the Branch dropdown, and fit the charts to their cards.
  if (typeof window.showTab === 'function') {
    const previousShowTab = window.showTab;
    window.showTab = function (tab) {
      if (tab === 'dashboard' && loadedOnce) followTop = true;
      const result = previousShowTab.apply(this, arguments);
      if (tab === 'dashboard') setTimeout(() => { if (model && window.dashboardOpen()) render(); else Object.values(charts).forEach(c => { if (c) c.reflow(); }); }, 0);
      return result;
    };
  }

  window.loadDashboard = loadDashboard;
  window.dashboardOpen = () => { const el = $id('dashboard'); return Boolean(el) && !el.classList.contains('hidden'); };
})();