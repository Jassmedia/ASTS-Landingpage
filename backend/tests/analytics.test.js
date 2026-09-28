// The example from the requirements: 100 unique visitors, 30 unique people
// click Book Free Demo, 10 register -> conversion rate 10%.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, UA } = require('./helpers');
const { conversionRate } = require('../src/services/analyticsService');

let app;
const api = (...args) => app.request(...args);
const sid = i => `example-visitor-${String(i).padStart(3, '0')}`;
const track = (i, eventType) =>
  api('POST', '/api/track', { session_id: sid(i), event_type: eventType }, { 'User-Agent': UA.desktop });

before(async () => {
  app = await startTestServer();

  for (let i = 0; i < 100; i++) {
    await track(i, 'page_view');
    if (i < 20) await track(i, 'page_view'); // 20 people refresh once
  }
  for (let i = 0; i < 30; i++) {
    const clicks = (i % 3) + 1; // 1, 2 or 3 clicks each -> 60 clicks in total
    for (let c = 0; c < clicks; c++) await track(i, 'demo_button_click');
  }
  for (let i = 0; i < 15; i++) {
    await track(i, 'form_started');
    await track(i, 'form_started'); // typing again doesn't count twice
  }
  for (let i = 0; i < 10; i++) {
    const res = await api('POST', '/api/registrations', {
      name: `Student ${String.fromCharCode(65 + i)}`, phone: `98765432${String(i).padStart(2, '0')}`,
      email: `student${i}@example.com`, city: i < 6 ? 'Hyderabad' : 'Chennai', course: 'Oracle EPBCS',
      session_id: sid(i), submission_id: `example-submission-${i}`
    });
    assert.equal(res.status, 201);
  }
  // One failed registration attempt must not count
  const failed = await api('POST', '/api/registrations', { name: 'X', phone: '12', city: '', course: '', session_id: sid(50) });
  assert.equal(failed.status, 400);
});
after(() => app.close());

describe('dashboard numbers', () => {
  let data;
  before(async () => {
    const res = await api('GET', '/api/admin/dashboard?tz=Asia/Kolkata');
    assert.equal(res.status, 200);
    data = res.body.data;
  });

  test('stat cards', () => {
    assert.deepEqual(data.metrics, {
      uniqueVisitors: 100,
      pageViews: 120,
      uniqueDemoClickers: 30,
      totalDemoClicks: 60,
      formStarts: 15,
      registrations: 10,
      conversionRate: 10 // registrations / unique visitors, not / clicks
    });
  });

  test('funnel counts unique people at each step', () => {
    assert.deepEqual(data.funnel.map(step => [step.key, step.people]), [
      ['visited', 100], ['clicked', 30], ['form_started', 15], ['registered', 10]
    ]);
  });

  test('each lead appears once, in an automatic state', () => {
    // The 10 who registered had clicked too: they are REGISTERED only, never also CLICKED
    assert.deepEqual(data.leads, { registered: 10, clicked: 20 });
    assert.equal(data.leads.registered + data.leads.clicked, data.metrics.uniqueDemoClickers);
  });

  test('daily breakdown adds up', () => {
    const total = data.daily.reduce((sum, d) => sum + d.registrations, 0);
    assert.equal(total, 10);
    assert.ok(data.daily.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
  });

  test('clicked-but-not-registered lists exactly the 20 clickers who never registered', async () => {
    const res = await api('GET', '/api/admin/clicked-not-registered');
    assert.equal(res.body.data.length, 20);
    const totalClicks = res.body.data.reduce((sum, row) => sum + row.clicks, 0);
    // visitors 10..29 clicked (i % 3) + 1 times
    const expected = Array.from({ length: 20 }, (_, k) => ((k + 10) % 3) + 1).reduce((a, b) => a + b, 0);
    assert.equal(totalClicks, expected);
  });

  test('registration filters narrow registrations but not visitors', async () => {
    const res = await api('GET', '/api/admin/dashboard?city=chennai');
    const { metrics } = res.body.data;
    assert.equal(metrics.registrations, 4);
    assert.equal(metrics.uniqueVisitors, 100);
    assert.equal(metrics.conversionRate, 4);
  });
});

describe('conversion rate', () => {
  test('matches the example from the brief and handles no visitors', () => {
    assert.equal(conversionRate(87, 1250), 6.96);
    assert.equal(conversionRate(10, 100), 10);
    assert.equal(conversionRate(0, 0), null);
  });
});
