/* ASTS Leads Dashboard. Plain JS, no build step.
 * All data comes from /api/admin/* and /api/registrations with the admin key.
 * Anything from the database is inserted with textContent, never innerHTML. */
(() => {
  'use strict';

  const KEY_STORAGE = 'asts_admin_key';
  const RANGE_STORAGE = 'asts_dashboard_range';
  const REFRESH_MS = 30000;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = id => document.getElementById(id);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const numberFormat = new Intl.NumberFormat('en-IN');
  const fmt = n => numberFormat.format(n ?? 0);
  const dateTimeFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
  const longDayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const storage = {
    get(key) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } },
    set(key, value) { try { value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch { /* private mode */ } }
  };

  const state = {
    key: storage.get(KEY_STORAGE),
    range: storage.get(RANGE_STORAGE) || '7d',
    loading: false,
    last: null // last successful data, for redraw on resize
  };

  // ---------------------------------------------------------------- API

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (state.key) headers.Authorization = `Bearer ${state.key}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || !json.success) {
      const err = new Error((json && json.message) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  // ---------------------------------------------------------------- Dates

  const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const parseLocalDate = value => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function rangeBounds() {
    const today = startOfDay(new Date());
    switch (state.range) {
      case 'today': return { from: today, to: addDays(today, 1) };
      case 'yesterday': return { from: addDays(today, -1), to: today };
      case '7d': return { from: addDays(today, -6), to: addDays(today, 1) };
      case '30d': return { from: addDays(today, -29), to: addDays(today, 1) };
      case 'custom': {
        const from = $('fromDate').value, to = $('toDate').value;
        return { from: from ? parseLocalDate(from) : null, to: to ? addDays(parseLocalDate(to), 1) : null };
      }
      default: return { from: null, to: null };
    }
  }

  function filterValues() {
    const values = {};
    document.querySelectorAll('select[data-filter]').forEach(select => {
      if (select.value) values[select.dataset.filter] = select.value;
    });
    return values;
  }

  function buildQuery(keys) {
    const { from, to } = rangeBounds();
    const params = new URLSearchParams();
    if (from) params.set('from', from.toISOString());
    if (to) params.set('to', to.toISOString());
    params.set('tz', timeZone);
    const filters = filterValues();
    for (const key of keys) if (filters[key]) params.set(key, filters[key]);
    return params.toString();
  }

  // ---------------------------------------------------------------- DOM helpers

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (key === 'style') Object.assign(node.style, value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  function badge(kind, label) {
    return el('span', { className: `badge badge-${kind}`, text: label });
  }

  // ---------------------------------------------------------------- Tooltip

  const tooltip = $('tooltip');
  function showTooltip(event, value, label) {
    tooltip.replaceChildren(el('strong', { text: value }), document.createTextNode(label));
    tooltip.hidden = false;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX ?? rect.left + rect.width / 2;
    const y = event.clientY ?? rect.top;
    const tip = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.min(Math.max(8, x + 12), window.innerWidth - tip.width - 8)}px`;
    tooltip.style.top = `${Math.max(8, y - tip.height - 12)}px`;
  }
  const hideTooltip = () => { tooltip.hidden = true; };

  function withTooltip(node, value, label) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', `${label}: ${value}`);
    node.addEventListener('pointermove', e => showTooltip(e, value, label));
    node.addEventListener('focus', e => showTooltip(e, value, label));
    node.addEventListener('pointerleave', hideTooltip);
    node.addEventListener('blur', hideTooltip);
    return node;
  }

  // ---------------------------------------------------------------- Rendering

  function setText(id, value) { $(id).textContent = value; }

  function renderStats(m) {
    setText('sVisitors', fmt(m.uniqueVisitors));
    setText('sVisitorsSub', `${fmt(m.pageViews)} page views`);
    setText('sClicks', fmt(m.totalDemoClicks));
    setText('sClicksSub', `${fmt(m.uniqueDemoClickers)} unique ${m.uniqueDemoClickers === 1 ? 'person' : 'people'}`);
    setText('sRegs', fmt(m.registrations));
    setText('sRegsSub', `${fmt(m.formStarts)} started the form`);
    setText('sRate', m.conversionRate === null ? '—' : `${m.conversionRate.toFixed(2)}%`);

    setText('mVisitors', fmt(m.uniqueVisitors));
    setText('mViews', fmt(m.pageViews));
    setText('mClickers', fmt(m.uniqueDemoClickers));
    setText('mClicks', fmt(m.totalDemoClicks));
    setText('mForms', fmt(m.formStarts));
    setText('mRegs', fmt(m.registrations));
  }

  function renderFunnel(steps) {
    const base = steps[0].people || 0;
    const rows = steps.map(step => {
      const share = base ? (step.people / base) * 100 : 0;
      const shareText = base ? `${share.toFixed(1)}%` : '—';
      const bar = el('div', {
        className: `funnel-bar${step.key === 'registered' ? ' is-registered' : ''}`,
        style: { width: `${Math.min(100, share)}%` }
      });
      withTooltip(bar, fmt(step.people), `${step.label} · ${shareText} of visitors`);
      return el('div', { className: 'funnel-row' }, [
        el('div', { className: 'funnel-label' }, [
          el('span', { text: step.label }),
          el('span', {}, [el('strong', { text: fmt(step.people) }), document.createTextNode(` · ${shareText}`)])
        ]),
        el('div', { className: 'funnel-track' }, bar)
      ]);
    });
    $('funnel').replaceChildren(...rows);
  }

  // The two automatic lead states. Nobody sets these by hand.
  function renderLeads(leads) {
    const parts = [
      { key: 'registered', label: 'Registered', count: leads.registered, color: 'var(--c-registered)', badge: 'registered' },
      { key: 'clicked', label: 'Clicked, not registered', count: leads.clicked, color: 'var(--c-clicked)', badge: 'clicked' }
    ];
    const total = parts.reduce((sum, p) => sum + p.count, 0);
    const pct = n => (total ? `${((n / total) * 100).toFixed(1)}%` : '0%');

    const bar = $('statusBar');
    bar.classList.toggle('is-empty', total === 0);
    bar.setAttribute('aria-label', parts.map(p => `${p.label}: ${p.count}`).join(', '));
    bar.replaceChildren(...parts.filter(p => p.count > 0).map(p =>
      withTooltip(el('div', { className: 'status-seg', style: { flex: `${p.count} 1 0`, background: p.color } }),
        fmt(p.count), `${p.label} · ${pct(p.count)}`)
    ));

    $('statusLegend').replaceChildren(...parts.map(p => el('li', {}, [
      el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } }, [
        el('span', { className: 'swatch', style: { background: p.color } }),
        badge(p.badge, p.key === 'clicked' ? 'Clicked' : 'Registered')
      ]),
      el('span', { className: 'value' }, [el('strong', { text: fmt(p.count) }), document.createTextNode(` · ${pct(p.count)}`)])
    ])));
  }

  // Every day in the selected range, so empty days show as gaps
  function daySeries(daily) {
    const byDay = new Map(daily.map(d => [d.date, d]));
    let { from, to } = rangeBounds();
    if (!from) from = daily.length ? parseLocalDate(daily[0].date) : startOfDay(new Date());
    if (!to) to = addDays(startOfDay(new Date()), 1);
    const days = [];
    for (let d = startOfDay(from); d < to && days.length < 800; d = addDays(d, 1)) {
      const key = dayKey(d);
      const row = byDay.get(key) || { visitors: 0, clickers: 0, registrations: 0 };
      days.push({ date: d, key, visitors: row.visitors, clickers: row.clickers, registrations: row.registrations });
    }
    return days;
  }

  const TREND_SERIES = [
    { key: 'visitors', label: 'Unique visitors', color: 'var(--c-visitors)' },
    { key: 'clickers', label: 'Clicked Book Free Demo', color: 'var(--c-clicked)' },
    { key: 'registrations', label: 'Registrations', color: 'var(--c-registered)' }
  ];

  function renderTrend(daily) {
    const days = daySeries(daily);
    const note = $('trendNote');
    const container = $('trend');
    if (days.length < 2) {
      note.hidden = false;
      note.textContent = 'The daily trend needs at least two days. Choose "Last 7 days" or longer.';
      container.replaceChildren();
      $('trendTableWrap').replaceChildren();
      return;
    }
    note.hidden = true;
    container.replaceChildren(...TREND_SERIES.map(series => smallMultiple(series, days)));
    renderTrendTable(days);
  }

  // One small column chart per measure: its own scale, one colour, no legend needed
  function smallMultiple(series, days) {
    const wrap = el('div', { className: 'multiple' });
    const peak = Math.max(0, ...days.map(d => d[series.key]));
    wrap.append(
      el('h3', {}, [el('span', { className: 'swatch', style: { background: series.color } }), document.createTextNode(series.label)]),
      el('p', { className: 'peak', text: `Busiest day: ${fmt(peak)}` })
    );

    const width = Math.max(240, Math.round(($('trend').clientWidth || 900) / (window.innerWidth > 900 ? 3 : 1)) - 12);
    const height = 130, top = 6, bottom = 20, left = 0, right = 0;
    const plotH = height - top - bottom;
    const plotW = width - left - right;
    const band = plotW / days.length;
    const barW = Math.max(1, Math.min(24, band * 0.7));
    const scaleMax = peak || 1;

    const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${series.label} per day. Busiest day ${peak}.` });
    chart.append(svg('line', { class: 'gridline', x1: 0, x2: width, y1: top, y2: top }));

    days.forEach((day, i) => {
      const value = day[series.key];
      const h = value ? Math.max(2, (value / scaleMax) * plotH) : 0;
      const x = left + i * band + (band - barW) / 2;
      const y = top + plotH - h;
      const r = Math.min(4, barW / 2, h);
      const hit = svg('rect', { class: 'hit', x: left + i * band, y: top, width: band, height: plotH });
      withTooltip(hit, fmt(value), `${series.label} · ${longDayFormat.format(day.date)}`);
      chart.append(hit);
      if (h > 0) {
        // Rounded data end, square at the baseline
        const d = `M${x},${top + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${top + plotH} Z`;
        chart.append(svg('path', { class: 'bar', d, fill: series.color, 'pointer-events': 'none' }));
      }
    });

    chart.append(svg('line', { class: 'baseline', x1: 0, x2: width, y1: top + plotH + 0.5, y2: top + plotH + 0.5 }));
    const first = svg('text', { class: 'axis-label', x: 0, y: height - 4 });
    first.textContent = dayFormat.format(days[0].date);
    const last = svg('text', { class: 'axis-label', x: width, y: height - 4, 'text-anchor': 'end' });
    last.textContent = dayFormat.format(days[days.length - 1].date);
    chart.append(first, last);

    wrap.append(chart);
    return wrap;
  }

  function renderTrendTable(days) {
    const head = el('tr', {}, [el('th', { scope: 'col', text: 'Date' }),
      ...TREND_SERIES.map(s => el('th', { scope: 'col', className: 'num', text: s.label }))]);
    const body = [...days].reverse().map(day => el('tr', {}, [
      el('td', { text: longDayFormat.format(day.date) }),
      ...TREND_SERIES.map(s => el('td', { className: 'num', text: fmt(day[s.key]) }))
    ]));
    $('trendTableWrap').replaceChildren(el('table', { className: 'data-table' }, [el('thead', {}, head), el('tbody', {}, body)]));
  }

  function renderRegistrations(rows) {
    setText('regCount', `(${fmt(rows.length)})`);
    $('regEmpty').hidden = rows.length > 0;
    $('regTable').querySelector('tbody').replaceChildren(...rows.map(reg => el('tr', {}, [
      el('td', { className: 'name', text: reg.name }),
      el('td', { text: reg.phone }),
      el('td', { className: reg.email ? '' : 'dim', text: reg.email || '—' }),
      el('td', { text: reg.city }),
      el('td', { text: reg.course }),
      el('td', { text: dateTimeFormat.format(new Date(reg.createdAt)) }),
      el('td', { text: reg.source || '—' })
    ])));
  }

  function renderClicked(rows) {
    setText('clickedCount', `(${fmt(rows.length)})`);
    $('clickedEmpty').hidden = rows.length > 0;
    $('clickedTable').querySelector('tbody').replaceChildren(...rows.map(row => el('tr', {}, [
      el('td', { text: dateTimeFormat.format(new Date(row.lastClickedAt)) }),
      el('td', { className: 'name', text: row.visitor }),
      el('td', { text: row.source }),
      el('td', { text: row.device }),
      el('td', { className: 'num', text: fmt(row.clicks) }),
      el('td', {}, badge('clicked', 'Clicked'))
    ])));
  }

  function renderSheets(status) {
    const button = $('syncBtn');
    const error = $('sheetsError');
    if (!status.enabled) {
      setText('sheetsStatus', 'Not connected. Add the GOOGLE_* settings to backend/.env and restart the backend.');
      button.disabled = true;
      error.hidden = true;
      return;
    }
    button.disabled = false;
    const last = status.lastSyncAt ? dateTimeFormat.format(new Date(status.lastSyncAt)) : 'not yet';
    setText('sheetsStatus', `Connected. Updates a few seconds after each change. Last update: ${last}.`);
    if (status.lastError) {
      error.hidden = false;
      error.textContent = `Last problem (${status.lastError.task}): ${status.lastError.message}` +
        (status.needsFullSync ? ' Some rows may be missing. Click "Sync now" to rebuild the sheet.' : '');
    } else {
      error.hidden = true;
    }
  }

  function fillSelect(select, values, labels = {}) {
    const current = select.value;
    const first = select.options[0];
    const options = [...new Set([...values, ...(current ? [current] : [])])];
    select.replaceChildren(first, ...options.map(v => el('option', { value: v, text: labels[v] || v })));
    select.value = current;
  }

  function renderOptions(options) {
    fillSelect($('fCourse'), options.courses);
    fillSelect($('fCity'), options.cities);
    fillSelect($('fSource'), options.sources);
  }

  // Status filter: which lead list to show (Registered / Clicked / both)
  function applyStateFilter() {
    const state = $('fState').value;
    $('regCard').hidden = state === 'clicked';
    $('clickedCard').hidden = state === 'registered';
  }

  // ---------------------------------------------------------------- Loading

  async function load() {
    if (state.loading) return;
    state.loading = true;
    $('app').classList.add('is-loading');
    try {
      const [dashboard, registrations, clicked, sheets] = await Promise.all([
        api(`/api/admin/dashboard?${buildQuery(['course', 'city', 'source'])}`),
        api(`/api/registrations?${buildQuery(['course', 'city', 'source'])}`),
        api(`/api/admin/clicked-not-registered?${buildQuery(['source'])}`),
        api('/api/admin/sheets')
      ]);
      state.last = dashboard;
      renderOptions(dashboard.options);
      renderStats(dashboard.metrics);
      renderFunnel(dashboard.funnel);
      renderLeads(dashboard.leads);
      renderTrend(dashboard.daily);
      renderRegistrations(registrations);
      renderClicked(clicked);
      renderSheets(sheets);
      $('loadError').hidden = true;
      setText('updatedAt', `Updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    } catch (err) {
      if (err.status === 401) return showLogin('Your admin key is no longer valid. Please enter it again.');
      $('loadError').hidden = false;
      $('loadError').textContent = `Couldn't load the dashboard: ${err.message}`;
    } finally {
      state.loading = false;
      $('app').classList.remove('is-loading');
    }
  }

  async function syncSheets() {
    const button = $('syncBtn');
    button.disabled = true;
    button.textContent = 'Syncing…';
    try {
      renderSheets(await api('/api/admin/sheets/sync', { method: 'POST' }));
    } catch (err) {
      $('sheetsError').hidden = false;
      $('sheetsError').textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Sync now';
    }
  }

  // ---------------------------------------------------------------- Login & startup

  function showLogin(message = '') {
    $('app').hidden = true;
    $('refreshBtn').hidden = true;
    $('signOutBtn').hidden = true;
    $('login').hidden = false;
    setText('loginError', message);
    $('adminKey').focus();
  }

  function showDashboard(session) {
    $('login').hidden = true;
    $('app').hidden = false;
    $('refreshBtn').hidden = false;
    $('signOutBtn').hidden = !state.key;
    const db = $('dbBadge');
    db.hidden = false;
    db.classList.toggle('is-local', session.database !== 'supabase');
    db.textContent = session.database === 'supabase' ? 'Supabase' : 'Local dev database';
    db.title = session.database === 'supabase'
      ? 'Connected to Supabase'
      : 'Local development database: data resets when the backend restarts';
    load();
  }

  async function start() {
    try {
      showDashboard(await api('/api/admin/session'));
    } catch (err) {
      if (err.status === 401) showLogin();
      else {
        $('loadError').hidden = false;
        $('loadError').textContent = `Couldn't reach the backend: ${err.message}`;
      }
    }
  }

  function setRange(range) {
    state.range = range;
    storage.set(RANGE_STORAGE, range);
    document.querySelectorAll('.range button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    $('customRange').hidden = range !== 'custom';
    if (range === 'custom' && !$('fromDate').value) {
      $('fromDate').value = dayKey(addDays(new Date(), -6));
      $('toDate').value = dayKey(new Date());
    }
  }

  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    state.key = $('adminKey').value.trim();
    try {
      const session = await api('/api/admin/session');
      storage.set(KEY_STORAGE, state.key);
      $('adminKey').value = '';
      showDashboard(session);
    } catch (err) {
      state.key = '';
      setText('loginError', err.status === 401 ? 'That key is not correct.' : err.message);
    }
  });

  $('signOutBtn').addEventListener('click', () => {
    state.key = '';
    storage.set(KEY_STORAGE, '');
    showLogin();
  });

  $('refreshBtn').addEventListener('click', load);
  $('syncBtn').addEventListener('click', syncSheets);

  document.querySelectorAll('.range button').forEach(button => {
    button.addEventListener('click', () => { setRange(button.dataset.range); load(); });
  });
  ['fromDate', 'toDate'].forEach(id => $(id).addEventListener('change', load));
  document.querySelectorAll('select[data-filter]').forEach(select => select.addEventListener('change', load));
  $('fState').addEventListener('change', applyStateFilter);
  $('resetFilters').addEventListener('click', () => {
    document.querySelectorAll('select[data-filter]').forEach(select => { select.value = ''; });
    $('fState').value = '';
    applyStateFilter();
    setRange('7d');
    load();
  });

  $('trendToggle').addEventListener('click', () => {
    const showTable = $('trendTableWrap').hidden;
    $('trendTableWrap').hidden = !showTable;
    $('trend').hidden = showTable;
    $('trendToggle').textContent = showTable ? 'Show as charts' : 'Show as table';
    $('trendToggle').setAttribute('aria-expanded', String(showTable));
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.last) renderTrend(state.last.daily); }, 150);
  });

  // Keep the numbers fresh while the tab is open
  setInterval(() => {
    if (document.visibilityState === 'visible' && !$('app').hidden) load();
  }, REFRESH_MS);

  setRange(state.range);
  start();
})();
