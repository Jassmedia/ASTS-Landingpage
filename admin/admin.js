/*
 * ASTS private admin dashboard.
 *
 * Every number comes from the Google Apps Script Web App set in config.js (the
 * same /exec URL as the registration website), which reads the Google Sheet.
 * There is no sample data. Data from the Sheet is only ever inserted with
 * textContent, never parsed as HTML.
 */
(function () {
  'use strict';

  const APPS_SCRIPT_URL = String((window.ADMIN_CONFIG || {}).APPS_SCRIPT_URL || '').trim();
  const POLL_MS = 30 * 1000;
  const TIMEOUT_MS = 45 * 1000;
  const TIME_ZONE = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  })();

  // The admin key lives ONLY in this variable: never in localStorage,
  // sessionStorage, cookies, the URL or the page source.
  let adminKey = '';

  const state = {
    tab: 'dashboard',
    period: '7d',
    custom: { from: '', to: '' },
    data: null,
    range: null,
    lastUpdated: 0,
    error: '',
    seq: 0,
    timer: 0,
    trendTable: false
  };

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  const $ = id => document.getElementById(id);

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.keys(props || {}).forEach(key => {
      const value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    children.flat().forEach(child => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  function svg(tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(key => node.setAttribute(key, attrs[key]));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  const numberFormat = new Intl.NumberFormat();
  const num = n => (typeof n === 'number' && isFinite(n) ? numberFormat.format(n) : '—');
  const pct = n => (typeof n === 'number' && isFinite(n) ? n.toFixed(1) + '%' : '—');
  const shareOf = (part, whole) => (whole ? (part / whole) * 100 : null);
  const notSet = value => value || '(not set)';
  const shortId = id => (id ? id.slice(0, 8) + '…' : '');
  const pad = n => String(n).padStart(2, '0');

  function dateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }
  function dateTimeSeconds(ms) {
    return new Date(ms).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
    });
  }
  function shortDate(date, withYear) {
    return date.toLocaleDateString(undefined, withYear
      ? { day: 'numeric', month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short' });
  }
  function pageLabel(url) {
    try { const u = new URL(url); return u.host + u.pathname; } catch (e) { return url || ''; }
  }

  // ---------------------------------------------------------------------------
  // Periods (computed in this browser's time zone, sent to Apps Script as instants)
  // ---------------------------------------------------------------------------

  const PERIOD_NAMES = {
    today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days',
    month: 'This month', all: 'All time', custom: 'Custom range'
  };

  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const hourKey = d => dayKey(d) + 'T' + pad(d.getHours());
  function keyToDate(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}))?$/.exec(key);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0) : null;
  }
  function inputDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }

  // [from, to) as local Dates (null = no limit), plus the chart bucket
  function currentRange() {
    const today = startOfDay(new Date());
    let from = null;
    let to = null;
    switch (state.period) {
      case 'today': from = today; to = addDays(today, 1); break;
      case 'yesterday': from = addDays(today, -1); to = today; break;
      case '7d': from = addDays(today, -6); to = addDays(today, 1); break;
      case '30d': from = addDays(today, -29); to = addDays(today, 1); break;
      case 'month': from = new Date(today.getFullYear(), today.getMonth(), 1); to = addDays(today, 1); break;
      case 'custom': {
        from = inputDate(state.custom.from);
        const end = inputDate(state.custom.to);
        to = end ? addDays(end, 1) : null;
        break;
      }
      default: break; // all time
    }
    const bucket = from && to && to - from <= 25 * 3600 * 1000 ? 'hour' : 'day';
    return { from: from, to: to, bucket: bucket };
  }

  function describeRange(range) {
    if (!range.from) return 'All time';
    const last = addDays(range.to, -1);
    const name = PERIOD_NAMES[state.period];
    if (dayKey(range.from) === dayKey(last)) return name + ' · ' + shortDate(range.from, true);
    return name + ' · ' + shortDate(range.from, range.from.getFullYear() !== last.getFullYear()) + ' – ' + shortDate(last, true);
  }

  // ---------------------------------------------------------------------------
  // Talking to the Apps Script
  // ---------------------------------------------------------------------------

  async function fetchDashboard(key, range) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        // Plain-text JSON and no custom headers, so the browser sends it without
        // a CORS pre-check. The key travels in this HTTPS body, never in the URL.
        body: JSON.stringify({
          action: 'dashboard',
          adminKey: key,
          from: range.from ? range.from.getTime() : null,
          to: range.to ? range.to.getTime() : null,
          timeZone: TIME_ZONE,
          bucket: range.bucket
        }),
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      let body = null;
      try { body = await response.json(); } catch (e) { /* not JSON */ }
      if (!body) {
        return {
          ok: false, code: 'BAD_RESPONSE',
          message: 'The Apps Script did not send back data (HTTP ' + response.status + '). Check the /exec URL in config.js and that the deployment\'s access is "Anyone".'
        };
      }
      if (body.success !== true || !body.data) {
        return { ok: false, code: body.code || 'ERROR', message: body.error || 'The Apps Script returned an error.' };
      }
      return { ok: true, data: body.data };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, code: 'TIMEOUT', message: 'The Apps Script took too long to answer.' };
      }
      return {
        ok: false, code: 'NETWORK',
        message: 'Could not reach the Apps Script. Check your internet connection, the /exec URL in config.js, and that the deployment\'s access is "Anyone".'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // Loads fresh data. reason: 'poll' (every 30 s), 'visible', 'manual', 'period'
  async function load(reason) {
    if (!adminKey) return;
    clearTimeout(state.timer);
    if (reason === 'poll' && document.hidden) return; // resumes when the tab is shown again

    const seq = ++state.seq;
    const range = currentRange();
    setBusy(true, reason === 'manual' || reason === 'period');
    const result = await fetchDashboard(adminKey, range);
    if (seq !== state.seq) return; // a newer request (e.g. another period) replaced this one
    setBusy(false);

    if (result.ok) {
      state.data = result.data;
      state.range = range;
      state.lastUpdated = Date.now();
      state.error = '';
      render();
    } else if (result.code === 'UNAUTHORIZED' || result.code === 'NOT_CONFIGURED') {
      signOut(result.code === 'UNAUTHORIZED'
        ? 'The admin key is no longer accepted. It may have been changed in Script properties.'
        : result.message);
      return;
    } else {
      state.error = result.message;
      renderStatus();
    }
    state.timer = setTimeout(() => load('poll'), POLL_MS);
  }

  function setBusy(busy, dimContent) {
    $('refreshBtn').classList.toggle('is-busy', busy);
    document.body.classList.toggle('is-loading', busy && !!dimContent && !!state.data);
  }

  // ---------------------------------------------------------------------------
  // Views, sign in and sign out
  // ---------------------------------------------------------------------------

  function showView(name) {
    $('setupView').hidden = name !== 'setup';
    $('loginView').hidden = name !== 'login';
    $('appView').hidden = name !== 'app';
  }

  function showLoginError(message) {
    const box = $('loginError');
    box.textContent = message;
    box.hidden = !message;
  }

  async function signIn(event) {
    event.preventDefault();
    const input = $('adminKey');
    const key = input.value.trim();
    if (!key) { showLoginError('Enter your admin key.'); input.focus(); return; }

    const button = $('loginBtn');
    button.disabled = true;
    button.textContent = 'Signing in…';
    showLoginError('');
    const range = currentRange();
    const result = await fetchDashboard(key, range);
    button.disabled = false;
    button.textContent = 'Sign in';

    if (!result.ok) {
      showLoginError(result.code === 'UNAUTHORIZED' ? 'That admin key is not correct.' : result.message);
      input.select();
      return;
    }
    adminKey = key;
    state.seq++;
    state.data = result.data;
    state.range = range;
    state.lastUpdated = Date.now();
    state.error = '';
    showView('app');
    setTimeout(() => { input.value = ''; }, 0);
    render();
    state.timer = setTimeout(() => load('poll'), POLL_MS);
  }

  function signOut(message) {
    adminKey = '';
    state.seq++; // ignore answers that are still on their way
    clearTimeout(state.timer);
    state.data = null;
    state.lastUpdated = 0;
    clearRendered(); // removes personal data from the page
    showView('login');
    showLoginError(message || '');
    $('adminKey').focus();
  }

  // ---------------------------------------------------------------------------
  // Tables: search, sorting and pagination (all in the browser)
  // ---------------------------------------------------------------------------

  function createTable(mount, options) {
    const o = Object.assign({ pageSize: 25, empty: 'Nothing to show for this period.', filter: null }, options);
    let rows = [];
    let term = '';
    let filterValue = '';
    let sortKey = o.sort.key;
    let sortDir = o.sort.dir;
    let page = 1;
    let pageSize = o.pageSize;

    const tools = [];
    if (o.searchPlaceholder) {
      const search = h('input', { class: 'input search', type: 'search', placeholder: o.searchPlaceholder, 'aria-label': o.searchPlaceholder });
      search.addEventListener('input', () => { term = search.value.trim().toLowerCase(); page = 1; draw(); });
      tools.push(search);
    }
    if (o.filter) {
      const select = h('select', { class: 'input', 'aria-label': o.filter.label },
        o.filter.options.map(opt => h('option', { value: opt[0], text: opt[1] })));
      select.addEventListener('change', () => { filterValue = select.value; page = 1; draw(); });
      tools.push(select);
    }
    const count = h('span', { class: 'table-count', 'aria-live': 'polite' });
    const sizeSelect = h('select', { class: 'input', 'aria-label': 'Rows per page' },
      [10, 25, 50, 100].map(n => h('option', { value: n, text: n + ' per page', selected: n === pageSize })));
    sizeSelect.addEventListener('change', () => { pageSize = +sizeSelect.value; page = 1; draw(); });

    const table = h('table', { class: 'data-table' });
    const info = h('span', { class: 'pager-info' });
    const prev = h('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Previous', onclick: () => { page--; draw(); } });
    const next = h('button', { class: 'btn btn-light btn-sm', type: 'button', text: 'Next', onclick: () => { page++; draw(); } });
    const pager = h('div', { class: 'pager' }, info, h('div', { class: 'pager-buttons' }, prev, next));
    mount.replaceChildren(
      o.compact ? '' : h('div', { class: 'table-tools' }, tools, count, sizeSelect),
      h('div', { class: 'table-scroll' }, table),
      o.compact ? '' : pager
    );

    const textOf = (col, row) => {
      const value = col.text ? col.text(row) : col.value(row);
      return value === null || value === undefined ? '' : String(value);
    };
    const isEmpty = v => v === null || v === undefined || v === '';

    function draw() {
      let list = rows;
      if (o.filter && filterValue) list = list.filter(row => o.filter.test(row, filterValue));
      if (term) {
        list = list.filter(row => o.columns.map(c => textOf(c, row))
          .concat(o.extraSearch ? o.extraSearch(row) : [])
          .join(' ').toLowerCase().includes(term));
      }
      const col = o.columns.find(c => c.key === sortKey) || o.columns[0];
      const dir = sortDir === 'asc' ? 1 : -1;
      list = list.slice().sort((a, b) => {
        const va = col.value(a);
        const vb = col.value(b);
        if (isEmpty(va) || isEmpty(vb)) return isEmpty(va) === isEmpty(vb) ? 0 : isEmpty(va) ? 1 : -1; // empty last
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });

      const pages = Math.max(1, Math.ceil(list.length / pageSize));
      page = Math.min(Math.max(page, 1), pages);
      const start = (page - 1) * pageSize;
      const visible = o.compact ? list.slice(0, o.limit || 5) : list.slice(start, start + pageSize);

      const head = h('tr', null, o.columns.map(c => {
        const active = c.key === sortKey;
        return h('th', {
          scope: 'col',
          class: c.numeric ? 'num' : null,
          'aria-sort': o.compact ? null : active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
        }, o.compact ? c.label : h('button', {
          class: 'sort' + (active ? ' active' : ''), type: 'button',
          onclick: () => {
            if (sortKey === c.key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            else { sortKey = c.key; sortDir = c.firstDir || 'asc'; }
            draw();
          }
        }, c.label, h('span', { class: 'sort-mark', 'aria-hidden': 'true', text: active ? (sortDir === 'asc' ? '▲' : '▼') : '↕' })));
      }));

      const body = visible.length
        ? visible.map(row => h('tr', null, o.columns.map(c => cell(c, row))))
        : [h('tr', null, h('td', { class: 'empty-cell', colspan: o.columns.length, text: rows.length ? 'No rows match your search.' : o.empty }))];
      table.replaceChildren(h('thead', null, head), h('tbody', null, body));

      if (!o.compact) {
        count.textContent = num(list.length) + (list.length === 1 ? ' row' : ' rows') +
          (list.length !== rows.length ? ' of ' + num(rows.length) : '');
        info.textContent = list.length
          ? 'Showing ' + num(start + 1) + '–' + num(start + visible.length) + ' of ' + num(list.length) + ' · Page ' + page + ' of ' + pages
          : '';
        prev.disabled = page <= 1;
        next.disabled = page >= pages;
        pager.hidden = pages <= 1;
      }
    }

    function cell(c, row) {
      if (c.cell) return h('td', { class: c.className || null }, c.cell(row));
      const text = textOf(c, row);
      const classes = [c.numeric ? 'num' : '', c.className || '', text ? '' : 'muted'].filter(Boolean).join(' ');
      return h('td', { class: classes || null, title: c.title ? c.title(row) || null : null, text: text || '—' });
    }

    return { setRows(list) { rows = list || []; draw(); } };
  }

  // ---------------------------------------------------------------------------
  // Small building blocks
  // ---------------------------------------------------------------------------

  function tile(label, value, caption, dotType) {
    return h('div', { class: 'card kpi' },
      h('div', { class: 'kpi-label' }, dotType ? h('span', { class: 'dot dot-' + dotType, 'aria-hidden': 'true' }) : '', label),
      h('div', { class: 'kpi-value', text: value }),
      h('div', { class: 'kpi-caption', text: caption }));
  }

  // Horizontal bars: label | bar | value (and share)
  function barList(items, max) {
    return h('ol', { class: 'bars' }, items.map(item => {
      const fill = h('span', { class: 'bar-fill' });
      fill.style.width = (max ? Math.max(item.value / max * 100, item.value ? 1 : 0) : 0) + '%';
      return h('li', { class: 'bar-row' + (item.other ? ' is-other' : '') },
        h('span', { class: 'bar-label', text: item.label }),
        h('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
        h('span', { class: 'bar-value' }, num(item.value), item.note ? h('small', { text: item.note }) : ''));
    }));
  }

  function eventName(type) {
    return {
      page_view: 'Page view',
      demo_button_click: 'Demo button click',
      form_started: 'Form started',
      registration_submitted: 'Registration submitted'
    }[type] || type;
  }

  function eventBadge(type) {
    return h('span', { class: 'event-type' }, h('span', { class: 'dot dot-' + type, 'aria-hidden': 'true' }), eventName(type));
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  let tables = null;

  function buildTables() {
    const regColumns = [
      { key: 'registrationId', label: 'Registration ID', value: r => r.registrationId, className: 'mono nowrap' },
      { key: 'name', label: 'Name', value: r => r.name },
      { key: 'phone', label: 'Phone', value: r => r.phone, text: r => (r.phone ? '+' + r.phone : ''), className: 'nowrap' },
      { key: 'email', label: 'Email', value: r => r.email },
      { key: 'city', label: 'City', value: r => r.city },
      { key: 'course', label: 'Course', value: r => r.course },
      { key: 'submittedAt', label: 'Registered At', value: r => Date.parse(r.submittedAt), text: r => dateTime(r.submittedAt), className: 'nowrap', firstDir: 'desc' },
      { key: 'utmSource', label: 'UTM Source', value: r => r.utmSource },
      { key: 'utmMedium', label: 'UTM Medium', value: r => r.utmMedium },
      { key: 'utmCampaign', label: 'UTM Campaign', value: r => r.utmCampaign },
      { key: 'gclid', label: 'GCLID', value: r => r.gclid, className: 'clip mono', title: r => r.gclid }
    ];

    tables = {
      registrations: createTable($('registrationsTable'), {
        columns: regColumns,
        sort: { key: 'submittedAt', dir: 'desc' },
        searchPlaceholder: 'Search name, phone, email, city, course, campaign…',
        extraSearch: r => [r.country, r.utmTerm, r.visitorId, r.device, r.browser],
        empty: 'No registrations in this period.'
      }),
      latest: createTable($('latestRegistrations'), {
        columns: regColumns.filter(c => ['name', 'phone', 'city', 'course', 'submittedAt', 'utmCampaign'].includes(c.key)),
        sort: { key: 'submittedAt', dir: 'desc' },
        compact: true,
        limit: 5,
        empty: 'No registrations in this period yet.'
      }),
      sources: createTable($('sourcesTable'), {
        columns: [
          { key: 'source', label: 'UTM Source', value: s => s.source, text: s => notSet(s.source) },
          { key: 'medium', label: 'UTM Medium', value: s => s.medium, text: s => notSet(s.medium) },
          { key: 'campaign', label: 'UTM Campaign', value: s => s.campaign, text: s => notSet(s.campaign) },
          { key: 'visitors', label: 'Unique visitors', value: s => s.visitors, text: s => num(s.visitors), numeric: true, firstDir: 'desc' },
          { key: 'clickers', label: 'Unique clickers', value: s => s.clickers, text: s => num(s.clickers), numeric: true, firstDir: 'desc' },
          { key: 'registrations', label: 'Registrations', value: s => s.registrations, text: s => num(s.registrations), numeric: true, firstDir: 'desc' },
          { key: 'conversion', label: 'Conversion', value: s => shareOf(s.registrations, s.visitors), text: s => pct(shareOf(s.registrations, s.visitors)), numeric: true, firstDir: 'desc' }
        ],
        sort: { key: 'registrations', dir: 'desc' },
        searchPlaceholder: 'Search source, medium or campaign…',
        pageSize: 10,
        empty: 'No visits or registrations in this period.'
      }),
      clicked: createTable($('clickedTable'), {
        columns: [
          { key: 'visitorId', label: 'Visitor', value: c => c.visitorId, text: c => shortId(c.visitorId), className: 'mono nowrap', title: c => c.visitorId },
          { key: 'lastClick', label: 'Last click', value: c => Date.parse(c.lastClick), text: c => dateTime(c.lastClick), className: 'nowrap', firstDir: 'desc' },
          { key: 'firstClick', label: 'First click', value: c => Date.parse(c.firstClick), text: c => dateTime(c.firstClick), className: 'nowrap', firstDir: 'desc' },
          { key: 'clicks', label: 'Clicks', value: c => c.clicks, text: c => num(c.clicks), numeric: true, firstDir: 'desc' },
          { key: 'utmSource', label: 'UTM Source', value: c => c.utmSource },
          { key: 'utmMedium', label: 'UTM Medium', value: c => c.utmMedium },
          { key: 'utmCampaign', label: 'UTM Campaign', value: c => c.utmCampaign },
          { key: 'gclid', label: 'GCLID', value: c => c.gclid, className: 'clip mono', title: c => c.gclid },
          { key: 'device', label: 'Device', value: c => c.device },
          { key: 'browser', label: 'Browser', value: c => c.browser }
        ],
        sort: { key: 'lastClick', dir: 'desc' },
        searchPlaceholder: 'Search visitor, campaign, device…',
        extraSearch: c => [c.pageUrl],
        empty: 'Nobody in this period clicked without registering.'
      }),
      events: createTable($('eventsTable'), {
        columns: [
          { key: 'time', label: 'Time', value: e => Date.parse(e.time), text: e => dateTime(e.time), className: 'nowrap', firstDir: 'desc' },
          { key: 'type', label: 'Event', value: e => e.type, text: e => eventName(e.type), cell: e => eventBadge(e.type) },
          { key: 'visitorId', label: 'Visitor', value: e => e.visitorId, text: e => shortId(e.visitorId), className: 'mono nowrap', title: e => e.visitorId },
          { key: 'sessionId', label: 'Session', value: e => e.sessionId, text: e => shortId(e.sessionId), className: 'mono nowrap', title: e => e.sessionId },
          { key: 'pageUrl', label: 'Page', value: e => e.pageUrl, text: e => pageLabel(e.pageUrl), className: 'clip', title: e => e.pageUrl },
          { key: 'utmSource', label: 'UTM Source', value: e => e.utmSource },
          { key: 'utmCampaign', label: 'UTM Campaign', value: e => e.utmCampaign },
          { key: 'device', label: 'Device', value: e => e.device },
          { key: 'browser', label: 'Browser', value: e => e.browser }
        ],
        sort: { key: 'time', dir: 'desc' },
        searchPlaceholder: 'Search visitor, page, campaign…',
        extraSearch: e => [e.type, e.utmMedium, e.gclid],
        filter: {
          label: 'Event type',
          options: [['', 'All events'], ['page_view', 'Page views'], ['demo_button_click', 'Demo button clicks'],
            ['form_started', 'Form starts'], ['registration_submitted', 'Registrations submitted']],
          test: (e, value) => e.type === value
        },
        empty: 'No tracking events in this period.'
      })
    };
  }

  function clearRendered() {
    ['kpis', 'leadStatus', 'funnel', 'trends', 'trendTable', 'breakdowns', 'eventTiles'].forEach(id => $(id).replaceChildren());
    Object.keys(tables || {}).forEach(name => tables[name].setRows([]));
    ['registrationsSub', 'trendsSub', 'eventsSub', 'periodLabel'].forEach(id => { $(id).textContent = ''; });
    state.error = '';
    renderStatus();
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const m = d.metrics;
    renderStatus();
    $('periodLabel').textContent = 'Showing ' + describeRange(state.range) + ' · updates every 30 seconds';

    // Dashboard
    $('kpis').replaceChildren(
      tile('Total Visitors', num(m.totalVisitors), 'All page views, refreshes included'),
      tile('Unique Visitors', num(m.uniqueVisitors), 'Different people (browsers)'),
      tile('Demo Button Clicks', num(m.demoClicks), 'Every Book Free Demo click'),
      tile('Unique Clickers', num(m.uniqueClickers), 'Different people who clicked'),
      tile('Form Starts', num(m.formStarts), 'People who started the form'),
      tile('Registrations', num(m.registrations), 'Saved in the Google Sheet'),
      tile('Conversion Rate', pct(m.conversionRate), 'Registrations ÷ unique visitors'),
      tile('Clicked But Not Registered', num(m.clickedNotRegistered), 'Clicked, no registration yet')
    );
    $('leadStatus').replaceChildren(
      h('div', { class: 'status-tile' },
        h('span', { class: 'status-pill status-good' }, h('span', { 'aria-hidden': 'true', text: '✓' }), 'REGISTERED'),
        h('span', { class: 'status-value', text: num(m.registrations) }),
        h('span', { class: 'status-note', text: 'Completed registration in this period' })),
      h('div', { class: 'status-tile' },
        h('span', { class: 'status-pill status-warn' }, h('span', { 'aria-hidden': 'true', text: '●' }), 'CLICKED BUT NOT REGISTERED'),
        h('span', { class: 'status-value', text: num(m.clickedNotRegistered) }),
        h('span', { class: 'status-note', text: 'Clicked Book Free Demo, have not registered' }))
    );
    const funnel = [
      ['Visited the page', m.uniqueVisitors],
      ['Clicked Book Free Demo', m.uniqueClickers],
      ['Started the form', m.formStarts],
      ['Registered', m.registrations]
    ];
    $('funnel').replaceChildren(m.uniqueVisitors || m.registrations
      ? barList(funnel.map(step => ({
        label: step[0],
        value: step[1],
        note: m.uniqueVisitors ? pct(shareOf(step[1], m.uniqueVisitors)) : ''
      })), Math.max.apply(null, funnel.map(step => step[1])))
      : h('p', { class: 'empty', text: 'No visitors in this period yet.' }));
    tables.latest.setRows(d.registrations);

    // Registrations
    $('registrationsSub').textContent = num(m.registrations) + (m.registrations === 1 ? ' registration' : ' registrations') +
      ' · ' + describeRange(state.range) + ' · latest first';
    tables.registrations.setRows(d.registrations);

    // Analytics
    renderTrends();
    renderBreakdowns(d);
    tables.sources.setRows(d.sources);

    // Tracking
    const c = d.eventCounts;
    $('eventTiles').replaceChildren(
      tile('Page views', num(c.page_view), 'page_view events', 'page_view'),
      tile('Demo button clicks', num(c.demo_button_click), 'demo_button_click events', 'demo_button_click'),
      tile('Form starts', num(c.form_started), 'form_started events (once per visit)', 'form_started'),
      tile('Registrations submitted', num(c.registration_submitted), 'registration_submitted events', 'registration_submitted')
    );
    tables.clicked.setRows(d.clickedNotRegistered);
    tables.events.setRows(d.events);
    $('eventsSub').textContent = d.eventsInRange > d.events.length
      ? 'The latest ' + num(d.events.length) + ' of ' + num(d.eventsInRange) + ' events in this period. All of them are in the Events tab of the Google Sheet.'
      : num(d.eventsInRange) + (d.eventsInRange === 1 ? ' event' : ' events') + ' in this period, latest first.';
  }

  function renderStatus() {
    $('lastUpdated').textContent = 'Last Updated: ' + (state.lastUpdated ? dateTimeSeconds(state.lastUpdated) : '—');
    const banner = $('statusBanner');
    banner.hidden = !state.error;
    banner.textContent = state.error
      ? 'Could not update: ' + state.error + (state.lastUpdated ? ' Showing the data from ' + dateTimeSeconds(state.lastUpdated) + '.' : '') + ' Trying again in 30 seconds.'
      : '';
  }

  // ---------------------------------------------------------------------------
  // Analytics: trends (one chart per measure) and breakdowns
  // ---------------------------------------------------------------------------

  const TRENDS = [
    { field: 'visitors', title: 'Visitors', unit: 'unique visitors', total: m => m.uniqueVisitors, totalNote: 'unique' },
    { field: 'clicks', title: 'Demo clicks', unit: 'demo clicks', total: m => m.demoClicks, totalNote: 'clicks' },
    { field: 'formStarts', title: 'Form starts', unit: 'people started the form', total: m => m.formStarts, totalNote: 'people' },
    { field: 'registrations', title: 'Registrations', unit: 'registrations', total: m => m.registrations, totalNote: 'saved' }
  ];

  // Every day (or hour) of the period, including the empty ones, up to now
  function filledSeries(d, range) {
    const byKey = {};
    d.series.forEach(point => { byKey[point.key] = point; });
    const keys = [];
    const now = new Date();
    if (d.bucket === 'hour') {
      const end = Math.min(range.to.getTime(), now.getTime());
      for (let t = range.from.getTime(); t < end; t += 3600 * 1000) keys.push(hourKey(new Date(t)));
      if (!keys.length) keys.push(hourKey(range.from));
    } else {
      const today = startOfDay(now);
      const first = d.series.length ? keyToDate(d.series[0].key) : today;
      const lastData = d.series.length ? keyToDate(d.series[d.series.length - 1].key) : today;
      let start = range.from ? startOfDay(range.from) : first;
      let end = range.to ? addDays(range.to, -1) : today;
      if (end > today) end = lastData > today ? lastData : today;
      if (start > end) start = end;
      for (let day = start; day <= end; day = addDays(day, 1)) keys.push(dayKey(day));
    }
    return Array.from(new Set(keys)).map(key => Object.assign(
      { key: key, pageViews: 0, visitors: 0, clicks: 0, clickers: 0, formStarts: 0, registrations: 0 },
      byKey[key] || {}
    ));
  }

  function bucketLabel(key, long) {
    const date = keyToDate(key);
    if (!date) return key;
    if (key.length > 10) {
      const hour = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return long ? shortDate(date, true) + ', ' + hour : hour;
    }
    return long
      ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : shortDate(date, false);
  }

  function renderTrends() {
    const d = state.data;
    if (!d) return;
    const points = filledSeries(d, state.range);
    const perWhat = d.bucket === 'hour' ? 'per hour' : 'per day';
    $('trendsSub').textContent = 'Each chart is one measure ' + perWhat + ' · ' + describeRange(state.range) + ' · hover or use the arrow keys for exact values';

    $('trendViewToggle').textContent = state.trendTable ? 'Show as charts' : 'Show as table';
    $('trendViewToggle').setAttribute('aria-pressed', String(state.trendTable));
    $('trends').hidden = state.trendTable;
    $('trendTable').hidden = !state.trendTable;

    if (state.trendTable) {
      const label = d.bucket === 'hour' ? 'Hour' : 'Date';
      $('trendTable').replaceChildren(h('div', { class: 'table-scroll' }, h('table', { class: 'data-table' },
        h('thead', null, h('tr', null, [label, 'Page views', 'Unique visitors', 'Demo clicks', 'Form starts', 'Registrations']
          .map((text, i) => h('th', { scope: 'col', class: i ? 'num' : null, text: text })))),
        h('tbody', null, points.slice().reverse().map(p => h('tr', null,
          h('td', { class: 'nowrap', text: bucketLabel(p.key, true) }),
          [p.pageViews, p.visitors, p.clicks, p.formStarts, p.registrations].map(v => h('td', { class: 'num', text: num(v) }))))))));
      return;
    }

    // Charts measure their width, so they are drawn only while Analytics is visible
    if ($('panel-analytics').hidden) return;
    $('trends').replaceChildren(...TRENDS.map(def => {
      const box = h('div', { class: 'chart' });
      const card = h('div', { class: 'trend' },
        h('div', { class: 'trend-head' },
          h('h3', { text: def.title }),
          h('span', { class: 'trend-total' }, num(def.total(d.metrics)), h('small', { text: def.totalNote }))),
        h('p', { class: 'trend-sub', text: 'Number of ' + def.unit + ' ' + perWhat }),
        box);
      box._draw = () => drawTrend(box, points.map(p => ({ key: p.key, value: p[def.field] })), def.unit);
      return card;
    }));
    $('trends').querySelectorAll('.chart').forEach(box => box._draw());
  }

  function niceTicks(max) {
    if (!(max > 0)) return [0, 1, 2, 3, 4];
    const rough = max / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = Math.max(1, [1, 2, 5, 10].map(k => k * magnitude).find(s => s >= rough));
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
    return ticks;
  }

  // Line + soft area for one measure over time, with a crosshair tooltip
  function drawTrend(box, points, unit) {
    const width = Math.max(box.clientWidth, 260);
    const height = 190; // includes the x-axis labels, so the card never scrolls
    const m = { top: 12, right: 14, bottom: 26, left: 40 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const n = points.length;
    const ticks = niceTicks(Math.max.apply(null, points.map(p => p.value)));
    const top = ticks[ticks.length - 1];
    const x = i => m.left + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const y = v => m.top + plotH - (v / top) * plotH;
    const total = points.reduce((sum, p) => sum + p.value, 0);

    const chart = svg('svg', {
      width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, role: 'img',
      'aria-label': unit + ': ' + num(total) + ' over ' + n + (n === 1 ? ' period' : ' periods')
    });
    ticks.forEach(t => {
      chart.append(svg('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.left, x2: width - m.right, y1: y(t), y2: y(t) }));
      chart.append(svg('text', { class: 'tick', x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end' }, num(t)));
    });

    const maxLabels = Math.max(2, Math.floor(plotW / 72));
    const labelIdx = [];
    if (n <= maxLabels) { for (let i = 0; i < n; i++) labelIdx.push(i); }
    else { for (let k = 0; k < maxLabels; k++) labelIdx.push(Math.round((k * (n - 1)) / (maxLabels - 1))); }
    Array.from(new Set(labelIdx)).forEach(i => {
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      chart.append(svg('text', { class: 'tick', x: x(i), y: height - 6, 'text-anchor': anchor }, bucketLabel(points[i].key, false)));
    });

    const path = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
    if (n > 1) {
      chart.append(svg('path', { class: 'trend-area', d: path + ' L' + x(n - 1).toFixed(1) + ' ' + y(0) + ' L' + x(0).toFixed(1) + ' ' + y(0) + ' Z' }));
      chart.append(svg('path', { class: 'trend-line', d: path }));
    }
    chart.append(svg('circle', { class: 'trend-dot', cx: x(n - 1), cy: y(points[n - 1].value), r: 4 }));

    const cross = svg('line', { class: 'crosshair', x1: 0, x2: 0, y1: m.top, y2: m.top + plotH, visibility: 'hidden' });
    const hoverDot = svg('circle', { class: 'trend-dot', r: 4.5, cx: 0, cy: 0, visibility: 'hidden' });
    const hit = svg('rect', { class: 'hit', x: m.left - 8, y: m.top, width: plotW + 16, height: plotH });
    chart.append(cross, hoverDot, hit);

    const tip = h('div', { class: 'tooltip', hidden: true });
    box.replaceChildren(chart, tip);
    box.tabIndex = 0;
    box.setAttribute('aria-label', unit + ' chart. Use the left and right arrow keys to read each value.');

    let current = -1;
    function show(i) {
      current = Math.max(0, Math.min(n - 1, i));
      const px = x(current);
      const py = y(points[current].value);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', px); hoverDot.setAttribute('cy', py); hoverDot.setAttribute('visibility', 'visible');
      tip.replaceChildren(h('strong', { text: num(points[current].value) }), h('span', { text: unit + ' · ' + bucketLabel(points[current].key, true) }));
      tip.hidden = false;
      const tipW = tip.offsetWidth;
      const left = Math.min(Math.max(px - tipW / 2, 0), width - tipW);
      tip.style.transform = 'translate(' + left + 'px,' + Math.max(py - tip.offsetHeight - 12, 0) + 'px)';
    }
    function hide() {
      current = -1;
      cross.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    }
    hit.addEventListener('pointermove', event => {
      const rect = chart.getBoundingClientRect();
      const px = event.clientX - rect.left;
      show(n === 1 ? 0 : Math.round(((px - m.left) / plotW) * (n - 1)));
    });
    hit.addEventListener('pointerleave', hide);
    box.onkeydown = event => {
      const moves = { ArrowLeft: -1, ArrowRight: 1 };
      if (event.key in moves) { event.preventDefault(); show(current < 0 ? n - 1 : current + moves[event.key]); }
      else if (event.key === 'Home') { event.preventDefault(); show(0); }
      else if (event.key === 'End') { event.preventDefault(); show(n - 1); }
      else if (event.key === 'Escape') hide();
    };
    box.onfocus = () => show(n - 1);
    box.onblur = hide;
  }

  function renderBreakdowns(d) {
    const total = d.metrics.registrations;
    if (!total) {
      $('breakdowns').replaceChildren(h('p', { class: 'empty', text: 'No registrations in this period yet. These charts appear when registrations exist.' }));
      return;
    }
    const groups = [
      ['By course', d.breakdowns.course],
      ['By city', d.breakdowns.city],
      ['By UTM source', d.breakdowns.utmSource],
      ['By UTM campaign', d.breakdowns.utmCampaign]
    ];
    const MAX_ROWS = 8;
    $('breakdowns').replaceChildren(...groups.map(group => {
      const items = group[1].slice(0, MAX_ROWS).map(g => ({ label: notSet(g.label), value: g.count, note: pct(shareOf(g.count, total)) }));
      const shown = items.reduce((sum, item) => sum + item.value, 0);
      if (total > shown) {
        items.push({ label: 'Everything else', value: total - shown, note: pct(shareOf(total - shown, total)), other: true });
      }
      return h('section', { class: 'breakdown' }, h('h3', { text: group[0] }),
        barList(items, Math.max.apply(null, items.map(item => item.value))));
    }));
  }

  // ---------------------------------------------------------------------------
  // Tabs and filters
  // ---------------------------------------------------------------------------

  function selectTab(name, focus) {
    state.tab = name;
    document.querySelectorAll('[role="tab"]').forEach(tab => {
      const on = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    document.querySelectorAll('[role="tabpanel"]').forEach(panel => { panel.hidden = panel.id !== 'panel-' + name; });
    if (name === 'analytics') renderTrends();
  }

  function updatePeriodButtons(pressed) {
    document.querySelectorAll('[data-period]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.period === pressed));
    });
  }

  function wireEvents() {
    $('loginForm').addEventListener('submit', signIn);
    $('signOutBtn').addEventListener('click', () => signOut(''));
    $('refreshBtn').addEventListener('click', () => load('manual'));

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
      tab.addEventListener('keydown', event => {
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (!step) return;
        event.preventDefault();
        selectTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab, true);
      });
    });
    document.querySelectorAll('[data-goto]').forEach(button => {
      button.addEventListener('click', () => selectTab(button.dataset.goto, true));
    });

    document.querySelectorAll('[data-period]').forEach(button => {
      button.addEventListener('click', () => {
        const period = button.dataset.period;
        if (period === 'custom') {
          const today = startOfDay(new Date());
          $('customFrom').max = $('customTo').max = dayKey(today);
          if (!$('customFrom').value) $('customFrom').value = state.custom.from || dayKey(addDays(today, -6));
          if (!$('customTo').value) $('customTo').value = state.custom.to || dayKey(today);
          $('customRange').hidden = false;
          updatePeriodButtons('custom');
          $('customFrom').focus();
          return;
        }
        $('customRange').hidden = true;
        state.period = period;
        updatePeriodButtons(period);
        load('period');
      });
    });
    $('customRange').addEventListener('submit', event => {
      event.preventDefault();
      const from = $('customFrom').value;
      const to = $('customTo').value;
      if (!inputDate(from) || !inputDate(to)) { $('customFrom').focus(); return; }
      if (from > to) { $('customTo').setCustomValidity('The end date must be on or after the start date.'); $('customTo').reportValidity(); return; }
      $('customTo').setCustomValidity('');
      state.period = 'custom';
      state.custom = { from: from, to: to };
      load('period');
    });
    $('customTo').addEventListener('input', () => $('customTo').setCustomValidity(''));

    $('trendViewToggle').addEventListener('click', () => {
      state.trendTable = !state.trendTable;
      renderTrends();
    });

    // Redraw charts when their width changes
    let lastWidth = 0;
    let frame = 0;
    new ResizeObserver(entries => {
      const width = Math.round(entries[0].contentRect.width);
      if (!width || width === lastWidth) return;
      lastWidth = width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => $('trends').querySelectorAll('.chart').forEach(box => box._draw && box._draw()));
    }).observe($('trends'));

    // No polling while the tab is hidden; catch up as soon as it is shown again
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !adminKey) return;
      const age = Date.now() - state.lastUpdated;
      if (age >= POLL_MS) load('visible');
      else { clearTimeout(state.timer); state.timer = setTimeout(() => load('poll'), POLL_MS - age); }
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  function isConnected(url) {
    if (!url || url.indexOf('PASTE_') !== -1) return false;
    return /^https:\/\/script\.google\.com\/.+\/exec$/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
  }

  function start() {
    $('boot').hidden = true;
    if (!isConnected(APPS_SCRIPT_URL)) {
      if (/\/dev$/.test(APPS_SCRIPT_URL)) {
        $('setupMessage').textContent = 'config.js has a /dev URL. Use the /exec URL from Deploy → Manage deployments (the same one as in index.html).';
      } else if (APPS_SCRIPT_URL && APPS_SCRIPT_URL.indexOf('PASTE_') === -1) {
        $('setupMessage').textContent = 'The URL in config.js does not look like a Google Apps Script Web App URL. It should start with https://script.google.com/ and end with /exec.';
      }
      showView('setup');
      return;
    }
    buildTables();
    wireEvents();
    showView('login');
    $('adminKey').focus();
  }

  start();
})();
