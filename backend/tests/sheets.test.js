// Google Sheets sync, tested against an in-memory fake of the Sheets API.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, UA } = require('./helpers');
const { visitorLabel } = require('../src/utils/visitorLabel');

// Behaves like the few Sheets API calls the sync uses
function createFakeSheetsClient() {
  let nextId = 100;
  const tabs = new Map([['Sheet1', { sheetId: 0, rows: [], rules: [] }]]);
  const failures = { append: false };
  const parse = ref => {
    const [, title, row] = ref.match(/^'(.+)'!A(\d+)/);
    return { tab: tabs.get(title), row: Number(row) };
  };

  return {
    tabs,
    failures,
    rows: title => tabs.get(title).rows,
    async getSpreadsheet() {
      return {
        sheets: [...tabs].map(([title, t]) => ({
          properties: { sheetId: t.sheetId, title },
          conditionalFormats: t.rules.length ? t.rules : undefined
        }))
      };
    },
    async batchUpdate(requests) {
      for (const r of requests) {
        if (r.addSheet) tabs.set(r.addSheet.properties.title, { sheetId: nextId++, rows: [], rules: [] });
        const byId = id => [...tabs.values()].find(t => t.sheetId === id);
        if (r.addConditionalFormatRule) byId(r.addConditionalFormatRule.rule.ranges[0].sheetId).rules.push(r.addConditionalFormatRule.rule);
        if (r.deleteConditionalFormatRule) byId(r.deleteConditionalFormatRule.sheetId).rules.splice(r.deleteConditionalFormatRule.index, 1);
      }
    },
    async clearRanges(ranges) {
      for (const ref of ranges) {
        const { tab, row } = parse(ref);
        tab.rows.length = Math.min(tab.rows.length, row - 1);
      }
    },
    async writeRanges(data) {
      for (const { range, values } of data) {
        const { tab, row } = parse(range);
        values.forEach((v, i) => { tab.rows[row - 1 + i] = v; });
      }
    },
    async appendRows(range, values) {
      if (failures.append) throw new Error('The caller does not have permission');
      parse(range).tab.rows.push(...values);
    }
  };
}

let app;
let sheets;
const api = (...args) => app.request(...args);
const track = (sessionId, eventType) =>
  api('POST', '/api/track', { session_id: sessionId, event_type: eventType, utm_source: 'sheet-test' }, { 'User-Agent': UA.mobile });
const flush = () => app.services.sheets.flush();

before(async () => {
  sheets = createFakeSheetsClient();
  app = await startTestServer({
    sheetsClient: sheets,
    sheetsOptions: { appendDelayMs: 5, snapshotDelayMs: 5, snapshotMinIntervalMs: 0, logger: { log() {}, warn() {}, error() {} } }
  });
});
after(() => app.close());

describe('Google Sheets sync', () => {
  test('creates the tabs with headers', async () => {
    await app.services.sheets.checkSetup();
    assert.deepEqual(sheets.rows('Visitors')[0], ['Date', 'Session ID', 'Page', 'Source', 'Device']);
    assert.deepEqual(sheets.rows('Clicks')[0], ['Date', 'Session ID', 'Event', 'Page', 'Source', 'Device']);
    assert.deepEqual(sheets.rows('Registrations')[0], ['Date', 'Name', 'Phone', 'Email', 'City', 'Course', 'Source', 'Activity']);
    assert.deepEqual(sheets.rows('Summary')[0], ['Metric', 'Count']);
    assert.deepEqual(sheets.rows('Clicked Not Registered')[0], ['Last Click', 'Session ID', 'Source', 'Device', 'Clicks', 'Activity']);
  });

  test('colours rows by the automatic Activity with conditional formatting', async () => {
    const formulas = tab => sheets.tabs.get(tab).rules.map(rule => rule.booleanRule.condition.values[0].userEnteredValue);
    assert.deepEqual(formulas('Registrations'), ['=$H2="REGISTERED"', '=$H2="CLICKED"']);
    assert.deepEqual(formulas('Clicked Not Registered'), ['=$F2="REGISTERED"', '=$F2="CLICKED"']);

    const [green, yellow] = sheets.tabs.get('Registrations').rules.map(r => r.booleanRule.format.backgroundColor);
    assert.ok(green.green > green.red && green.green > green.blue, 'REGISTERED is green');
    assert.ok(yellow.red > 0.9 && yellow.green > 0.85 && yellow.blue < 0.75, 'CLICKED is yellow');
  });

  test('visitors and clicks are appended; the sheet shows the anonymous label', async () => {
    await track('sheet-session-0001', 'page_view');
    await track('sheet-session-0001', 'page_view'); // refresh: no new visitor row
    await track('sheet-session-0001', 'demo_button_click');
    await track('sheet-session-0002', 'page_view');
    await track('sheet-session-0002', 'demo_button_click');
    await flush();

    const visitors = sheets.rows('Visitors').slice(1);
    assert.equal(visitors.length, 2);
    assert.deepEqual(visitors[0].slice(1), [visitorLabel('sheet-session-0001'), '/', 'sheet-test', 'mobile']);
    assert.match(visitors[0][0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const clicks = sheets.rows('Clicks').slice(1);
    assert.deepEqual(clicks.map(r => r[2]), ['Demo button click', 'Demo button click']);
    assert.ok(!JSON.stringify(sheets.rows('Clicks')).includes('sheet-session-0001'), 'raw session IDs are not written');

    // Both have clicked and not registered: CLICKED
    const clicked = sheets.rows('Clicked Not Registered').slice(1);
    assert.deepEqual(clicked.map(r => r[5]), ['CLICKED', 'CLICKED']);
  });

  test('a registration is written as REGISTERED and updates Summary', async () => {
    const res = await api('POST', '/api/registrations', {
      name: 'Sheet Student', phone: '919876543210', email: 'sheet@example.com', city: 'Hyderabad',
      course: 'Oracle EPBCS', session_id: 'sheet-session-0001', submission_id: 'sheet-submission-01'
    });
    assert.equal(res.status, 201);
    await flush();

    const regs = sheets.rows('Registrations').slice(1);
    assert.equal(regs.length, 1);
    assert.deepEqual(regs[0].slice(1), ['Sheet Student', '919876543210', 'sheet@example.com', 'Hyderabad', 'Oracle EPBCS', 'sheet-test', 'REGISTERED']);

    assert.equal(sheets.rows('Clicks').at(-1)[2], 'Registration submitted');

    const summary = Object.fromEntries(sheets.rows('Summary').slice(1).filter(r => r.length));
    assert.equal(summary['Unique Visitors'], 2);
    assert.equal(summary['Total Page Views'], 3);
    assert.equal(summary['Unique Demo Clickers'], 2);
    assert.equal(summary['Total Demo Clicks'], 2);
    assert.equal(summary.Registrations, 1);
    assert.equal(summary['Conversion Rate'], '50.00%');

    // Session 1 moved to REGISTERED automatically; session 2 is still CLICKED
    const clicked = sheets.rows('Clicked Not Registered').slice(1);
    assert.deepEqual(clicked.map(r => [r[1], r[5]]), [[visitorLabel('sheet-session-0002'), 'CLICKED']]);
  });

  test('when a clicker registers later, they move from CLICKED to REGISTERED with no manual step', async () => {
    const res = await api('POST', '/api/registrations', {
      name: 'Late Registrant', phone: '919812345678', city: 'Pune', course: 'Oracle EPBCS',
      session_id: 'sheet-session-0002', submission_id: 'sheet-submission-02'
    });
    assert.equal(res.status, 201);
    await flush();

    assert.equal(sheets.rows('Clicked Not Registered').length, 1, 'only the header is left');
    const regs = sheets.rows('Registrations').slice(1);
    assert.deepEqual(regs.map(r => [r[1], r[7]]), [['Late Registrant', 'REGISTERED'], ['Sheet Student', 'REGISTERED']]);
  });

  test('setting up again replaces old colour rules instead of adding more', async () => {
    // A sheet made by an older version had six manual-status rules
    sheets.tabs.get('Registrations').rules.push({}, {}, {}, {});
    const { createSheetsService } = require('../src/services/sheetsService');
    const again = createSheetsService({ client: sheets, timeZone: 'UTC', logger: { log() {}, error() {} } });
    assert.equal(await again.checkSetup(), null);
    assert.equal(sheets.tabs.get('Registrations').rules.length, 2);
    assert.equal(sheets.tabs.get('Clicked Not Registered').rules.length, 2);
  });

  test('"Sync now" rebuilds every tab from the database', async () => {
    sheets.rows('Visitors').push(['junk row']);
    const res = await api('POST', '/api/admin/sheets/sync');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(sheets.rows('Visitors').length, 1 + 2);
    assert.equal(sheets.rows('Clicks').length, 1 + 4); // 2 clicks + 2 registrations
    assert.equal(sheets.rows('Registrations').length, 1 + 2);
    assert.equal(sheets.rows('Clicked Not Registered').length, 1);
  });

  test('a Google Sheets failure never breaks tracking or registration', async () => {
    sheets.failures.append = true;
    const tracked = await track('sheet-session-0003', 'page_view');
    assert.equal(tracked.status, 202);
    await flush();

    const status = await api('GET', '/api/admin/sheets');
    assert.equal(status.body.data.enabled, true);
    assert.match(status.body.data.lastError.message, /permission/);
    assert.equal(status.body.data.needsFullSync, true, 'the error stays visible until a full sync');

    sheets.failures.append = false;
    const res = await api('POST', '/api/admin/sheets/sync');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.lastError, null);
    assert.equal(res.body.data.needsFullSync, false);
    assert.equal(sheets.rows('Visitors').length, 1 + 3, 'the missed visitor is caught up');
  });
});
