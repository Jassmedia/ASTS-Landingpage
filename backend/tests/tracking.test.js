const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, UA } = require('./helpers');
const { visitorLabel } = require('../src/utils/visitorLabel');

let app;
const api = (...args) => app.request(...args);

// Each test tags its visitors with its own utm_source, then filters the
// dashboard by that source, so tests don't see each other's data.
function track(sessionId, eventType, extra = {}, headers = { 'User-Agent': UA.desktop }) {
  return api('POST', '/api/track', { session_id: sessionId, event_type: eventType, page: '/', ...extra }, headers);
}
async function dashboard(query = '') {
  const res = await api('GET', `/api/admin/dashboard${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}
async function clickedList(query = '') {
  const res = await api('GET', `/api/admin/clicked-not-registered${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

before(async () => {
  app = await startTestServer();
});
after(() => app.close());

describe('POST /api/track', () => {
  test('a refresh is another page view, not another visitor', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await track('refresh-session-0001', 'page_view', { utm_source: 'refresh-test' });
      assert.equal(res.status, 202);
      assert.equal(res.body.recorded, true);
    }
    const { metrics } = await dashboard('?source=refresh-test');
    assert.equal(metrics.uniqueVisitors, 1);
    assert.equal(metrics.pageViews, 5);
  });

  test('repeated demo clicks count as clicks, not as more people', async () => {
    const tag = { utm_source: 'click-test' };
    await track('click-session-aaaa', 'page_view', tag);
    await track('click-session-bbbb', 'page_view', tag);
    for (let i = 0; i < 3; i++) await track('click-session-aaaa', 'demo_button_click', tag);
    await track('click-session-bbbb', 'demo_button_click', tag);

    const { metrics } = await dashboard('?source=click-test');
    assert.equal(metrics.totalDemoClicks, 4);
    assert.equal(metrics.uniqueDemoClickers, 2);
  });

  test('form_started is stored once per session', async () => {
    const tag = { utm_source: 'form-test' };
    const first = await track('form-session-0001', 'form_started', tag);
    const second = await track('form-session-0001', 'form_started', tag);
    assert.equal(first.body.recorded, true);
    assert.equal(second.body.recorded, false);
    const { metrics } = await dashboard('?source=form-test');
    assert.equal(metrics.formStarts, 1);
  });

  test('rejects bad input', async () => {
    const forged = await track('forge-session-0001', 'registration_submitted');
    assert.equal(forged.status, 400, 'only the server records registration_submitted');
    assert.ok(forged.body.errors.event_type);

    const noSession = await api('POST', '/api/track', { event_type: 'page_view' });
    assert.equal(noSession.status, 400);
    assert.ok(noSession.body.errors.session_id);

    const badSession = await track('bad id with spaces', 'page_view');
    assert.equal(badSession.status, 400);
  });

  test('ignores search-engine bots', async () => {
    const res = await track('bot-session-00001', 'page_view', { utm_source: 'bot-test' }, { 'User-Agent': UA.bot });
    assert.equal(res.status, 202);
    assert.equal(res.body.recorded, false);
    const { metrics } = await dashboard('?source=bot-test');
    assert.equal(metrics.uniqueVisitors, 0);
  });

  test('works the way the landing page sends it (text/plain beacon)', async () => {
    const body = JSON.stringify({ session_id: 'beacon-session-01', event_type: 'page_view', utm_source: 'beacon-test' });
    const res = await api('POST', '/api/track', body, { 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': UA.desktop });
    assert.equal(res.status, 202);
    // Without this the browser blocks the beacon's response and logs an error
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });

  test('other API responses keep the strict same-origin policy', async () => {
    const res = await api('GET', '/api/health');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  });
});

describe('source and device', () => {
  test('are worked out from the visit and never store the raw referrer', async () => {
    const visits = [
      ['src-utm-000001', { utm_source: 'Facebook' }, 'facebook'],
      ['src-gclid-00001', { gclid: true }, 'google_ads'],
      ['src-google-0001', { referrer: 'https://www.google.co.in/search?q=epbcs+training' }, 'google'],
      ['src-linkedin-01', { referrer: 'https://www.linkedin.com/feed/' }, 'linkedin'],
      ['src-other-00001', { referrer: 'https://blog.example.org/post/1' }, 'blog.example.org'],
      ['src-direct-0001', {}, 'direct']
    ];
    for (const [sessionId, extra] of visits) {
      await track(sessionId, 'demo_button_click', extra, { 'User-Agent': UA.mobile });
    }
    // A referrer from the landing page itself is not a traffic source
    await track('src-internal-01', 'demo_button_click', { referrer: 'http://localhost:8080/#modules' }, {
      'User-Agent': UA.desktop, Origin: 'http://localhost:8080'
    });

    const list = await clickedList();
    const byLabel = new Map(list.map(row => [row.visitor, row]));
    for (const [sessionId, , source] of visits) {
      const row = byLabel.get(visitorLabel(sessionId));
      assert.ok(row, `missing ${sessionId}`);
      assert.equal(row.source, source, sessionId);
      assert.equal(row.device, 'mobile');
    }
    assert.equal(byLabel.get(visitorLabel('src-internal-01')).source, 'direct');
    assert.equal(byLabel.get(visitorLabel('src-internal-01')).device, 'desktop');
  });

  test('the anonymous label matches the database formula and hides the session ID', async () => {
    const label = await app.db.rpc('asts_visitor_label', { p_session_id: 'src-utm-000001' });
    assert.equal(label, visitorLabel('src-utm-000001'));
    assert.match(label, /^V-[0-9A-F]{8}$/);
    const list = await clickedList();
    assert.ok(list.every(row => !JSON.stringify(row).includes('src-utm-000001')));
  });
});

describe('clicked vs registered', () => {
  const tag = { utm_source: 'journey-test' };

  test('someone who clicked and later registered is REGISTERED only', async () => {
    await track('journey-session-01', 'page_view', tag);
    await track('journey-session-01', 'demo_button_click', tag);
    await track('journey-session-01', 'form_started', tag);

    let data = await dashboard('?source=journey-test');
    assert.deepEqual(data.leads, { registered: 0, clicked: 1 }); // CLICKED (yellow)
    assert.equal((await clickedList('?source=journey-test')).length, 1);

    const reg = await api('POST', '/api/registrations', {
      name: 'Journey Person', phone: '9876543210', email: 'journey@example.com', city: 'Pune',
      course: 'Oracle EPBCS', session_id: 'journey-session-01', submission_id: 'journey-submission-01'
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.data.source, 'journey-test', 'registration inherits the visitor source');

    data = await dashboard('?source=journey-test');
    assert.deepEqual(data.leads, { registered: 1, clicked: 0 }); // now REGISTERED (green) only
    assert.equal(data.metrics.registrations, 1);
    assert.equal((await clickedList('?source=journey-test')).length, 0);
  });

  test('someone who clicked but never registered is CLICKED', async () => {
    await track('journey-session-02', 'page_view', tag);
    await track('journey-session-02', 'demo_button_click', tag);
    await track('journey-session-02', 'demo_button_click', tag);
    await track('journey-session-03', 'page_view', tag); // only looked

    const data = await dashboard('?source=journey-test');
    assert.deepEqual(data.leads, { registered: 1, clicked: 1 }); // the look-only visitor is not a lead
    const list = await clickedList('?source=journey-test');
    assert.equal(list.length, 1);
    assert.equal(list[0].visitor, visitorLabel('journey-session-02'));
    assert.equal(list[0].clicks, 2);
  });

  test('a successful registration records registration_submitted; a failed one records nothing', async () => {
    const bad = await api('POST', '/api/registrations', {
      name: '', phone: '1', city: 'Pune', course: 'Oracle EPBCS', session_id: 'journey-session-04'
    });
    assert.equal(bad.status, 400);

    const events = await app.db.rpc('asts_export_events');
    const submitted = events.filter(e => e.event_type === 'registration_submitted');
    assert.deepEqual(submitted.map(e => e.visitor), [visitorLabel('journey-session-01')]);
  });
});

describe('dashboard filters', () => {
  test('a date range with no activity shows zeros and no conversion rate', async () => {
    const data = await dashboard('?from=2000-01-01T00:00:00Z&to=2000-01-02T00:00:00Z');
    assert.equal(data.metrics.uniqueVisitors, 0);
    assert.equal(data.metrics.registrations, 0);
    assert.equal(data.metrics.conversionRate, null);
  });

  test('rejects invalid filters', async () => {
    for (const query of ['?from=yesterday', '?tz=Mars/Base', `?course=${'x'.repeat(101)}`, '?from=2026-02-01&to=2026-01-01']) {
      const res = await api('GET', `/api/admin/dashboard${query}`);
      assert.equal(res.status, 400, query);
    }
  });

  test('returns filter options', async () => {
    const { options } = await dashboard();
    assert.ok(options.sources.includes('journey-test'));
    assert.ok(options.cities.includes('Pune'));
    assert.equal(options.statuses, undefined, 'no manual statuses');
  });
});
