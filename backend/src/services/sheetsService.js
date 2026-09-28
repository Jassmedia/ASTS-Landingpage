const ApiError = require('../utils/ApiError');
const { visitorLabel } = require('../utils/visitorLabel');
const { LEAD_STATES } = require('../config/constants');

/*
 * Mirrors the database into Google Sheets. Supabase stays the source of
 * truth; the sheet is a read-only view that can be rebuilt at any time.
 *
 *  - Visitors, Clicks: new rows are appended (batched every few seconds)
 *  - Registrations, Clicked Not Registered, Summary: rewritten from the
 *    database shortly after any change. When someone who clicked registers,
 *    they move from Clicked Not Registered (CLICKED) to Registrations
 *    (REGISTERED) automatically. Nobody edits a status by hand.
 *  - "Sync now" (POST /api/admin/sheets/sync) rebuilds every tab
 *
 * Sheet problems never affect the API: failures are logged and reported in
 * GET /api/admin/sheets, and the next sync catches up.
 */

const TABS = {
  visitors: { title: 'Visitors', headers: ['Date', 'Session ID', 'Page', 'Source', 'Device'] },
  clicks: { title: 'Clicks', headers: ['Date', 'Session ID', 'Event', 'Page', 'Source', 'Device'] },
  registrations: {
    title: 'Registrations',
    headers: ['Date', 'Name', 'Phone', 'Email', 'City', 'Course', 'Source', 'Activity']
  },
  summary: { title: 'Summary', headers: ['Metric', 'Count'] },
  clickedNotRegistered: {
    title: 'Clicked Not Registered',
    headers: ['Last Click', 'Session ID', 'Source', 'Device', 'Clicks', 'Activity']
  }
};

const EVENT_LABELS = {
  demo_button_click: 'Demo button click',
  form_started: 'Form started',
  registration_submitted: 'Registration submitted'
};

// Row colours, applied by conditional formatting on the Activity column
const COLORS = {
  green: '#b7e1cd',
  yellow: '#fce8b2',
  headerBg: '#0a1f5c',
  headerText: '#ffffff'
};

// The Activity value is written by the backend (never typed by a person)
const ACTIVITY_COLORS = [
  [LEAD_STATES.REGISTERED, 'green'],
  [LEAD_STATES.CLICKED, 'yellow']
];
const ACTIVITY_RULES = {
  registrations: { column: 'H', rules: ACTIVITY_COLORS },
  clickedNotRegistered: { column: 'F', rules: ACTIVITY_COLORS }
};

const rgb = hex => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255
});

const range = (tabKey, cells) => `'${TABS[tabKey].title}'!${cells}`;

function formatDate(iso, timeZone) {
  if (!iso) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(iso)).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function disabledSheetsService() {
  return {
    enabled: false,
    subscribe() {},
    status: () => ({ enabled: false }),
    async syncNow() {
      throw new ApiError(400, 'Google Sheets is not configured. Set the GOOGLE_* variables in backend/.env.');
    },
    async checkSetup() { return null; },
    async flush() {}
  };
}

/**
 * @param {object} deps
 * @param {object|null} deps.client        Google Sheets client, or null when not configured
 * @param {object} deps.registrations      registration repository
 * @param {object} deps.tracking           tracking repository
 * @param {object} deps.analytics          analytics service
 * @param {string} deps.timeZone           time zone for dates written to the sheet
 */
function createSheetsService({
  client, registrations, tracking, analytics, timeZone,
  appendDelayMs = 3000, snapshotDelayMs = 3000, snapshotMinIntervalMs = 10000,
  logger = console
}) {
  if (!client) return disabledSheetsService();

  // needsFullSync: some appended rows were lost; "Sync now" rebuilds them
  const state = { lastSyncAt: null, lastError: null, needsFullSync: false };
  const date = iso => formatDate(iso, timeZone);
  const APPEND = 'append rows';
  const FULL_SYNC = 'full sync';

  // Every sheet operation runs one at a time, in order.
  // Resolves to null on success or the error message on failure.
  let queue = Promise.resolve();
  function run(label, task) {
    const result = queue.then(task).then(
      () => {
        state.lastSyncAt = new Date().toISOString();
        // A full sync repairs everything. Other tasks only clear their own
        // earlier error, except appends: lost rows need a full sync.
        if (label === FULL_SYNC) {
          state.lastError = null;
          state.needsFullSync = false;
        } else if (state.lastError?.task === label && label !== APPEND) {
          state.lastError = null;
        }
        return null;
      },
      err => {
        const message = err?.message || String(err);
        state.lastError = { at: new Date().toISOString(), task: label, message };
        if (label === APPEND) state.needsFullSync = true;
        logger.error(`[sheets] ${label} failed: ${message}`);
        return message;
      }
    );
    queue = result;
    return result;
  }

  // ---------- One-time setup: tabs, headers, formatting ----------

  let setupPromise = null;
  function ensureSetup() {
    if (!setupPromise) {
      setupPromise = setupSpreadsheet().catch(err => {
        setupPromise = null; // try again next time
        throw err;
      });
    }
    return setupPromise;
  }

  async function setupSpreadsheet() {
    let { sheets = [] } = await client.getSpreadsheet();
    const existing = new Set(sheets.map(s => s.properties.title));
    const missing = Object.values(TABS).filter(tab => !existing.has(tab.title));
    if (missing.length) {
      await client.batchUpdate(missing.map(tab => ({
        addSheet: { properties: { title: tab.title, gridProperties: { frozenRowCount: 1 } } }
      })));
      ({ sheets = [] } = await client.getSpreadsheet());
    }
    const byTitle = new Map(sheets.map(s => [s.properties.title, s]));

    await client.writeRanges(Object.keys(TABS).map(key => ({ range: range(key, 'A1'), values: [TABS[key].headers] })));

    const requests = [];
    for (const tab of Object.values(TABS)) {
      const sheetId = byTitle.get(tab.title).properties.sheetId;
      requests.push(
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: tab.headers.length },
            cell: {
              userEnteredFormat: {
                backgroundColor: rgb(COLORS.headerBg),
                textFormat: { bold: true, foregroundColor: rgb(COLORS.headerText) }
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)'
          }
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount'
          }
        }
      );
    }

    // Replace the colour rules on the lead tabs (whole row, based on Activity).
    // This also clears rules left by older versions of the sheet.
    for (const [key, { column, rules }] of Object.entries(ACTIVITY_RULES)) {
      const sheet = byTitle.get(TABS[key].title);
      const sheetId = sheet.properties.sheetId;
      for (let i = (sheet.conditionalFormats || []).length - 1; i >= 0; i--) {
        requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
      }
      rules.forEach(([text, color], index) => {
        requests.push({
          addConditionalFormatRule: {
            index,
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: TABS[key].headers.length }],
              booleanRule: {
                condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=$${column}2="${text}"` }] },
                format: { backgroundColor: rgb(COLORS[color]) }
              }
            }
          }
        });
      });
    }

    await client.batchUpdate(requests);
    logger.log('[sheets] Spreadsheet is set up (tabs, headers, colour rules).');
  }

  // ---------- Row builders ----------

  const visitorRow = v => [date(v.visitedAt), v.label, v.page, v.source, v.device];
  const clickRow = e => [date(e.createdAt), e.label, EVENT_LABELS[e.type] || e.type, e.page, e.source, e.device];
  const registrationRow = r => [
    date(r.createdAt), r.name, r.phone, r.email || '', r.city, r.course, r.source, LEAD_STATES.REGISTERED
  ];
  const clickedRow = c => [date(c.lastClickedAt), c.visitor, c.source, c.device, c.clicks, LEAD_STATES.CLICKED];

  function summaryRows(s) {
    return [
      ['Unique Visitors', s.uniqueVisitors],
      ['Total Page Views', s.pageViews],
      ['Unique Demo Clickers', s.uniqueDemoClickers],
      ['Total Demo Clicks', s.totalDemoClicks],
      ['Form Starts', s.formStarts],
      ['Registrations', s.registrations],
      ['Conversion Rate', s.conversionRate === null ? 'n/a' : `${s.conversionRate.toFixed(2)}%`],
      ['Clicked but not registered', s.clickedNotRegistered],
      [],
      ['Last updated', `${date(new Date().toISOString())} (${timeZone})`]
    ];
  }

  // ---------- Appends (Visitors, Clicks) ----------

  const pending = { visitors: [], clicks: [] };
  let appendTimer = null;

  function queueRow(tabKey, row) {
    pending[tabKey].push(row);
    if (!appendTimer) {
      appendTimer = setTimeout(() => {
        appendTimer = null;
        run(APPEND, flushAppends);
      }, appendDelayMs);
      appendTimer.unref?.();
    }
  }

  async function flushAppends() {
    await ensureSetup();
    for (const tabKey of Object.keys(pending)) {
      const rows = pending[tabKey].splice(0);
      if (rows.length) await client.appendRows(range(tabKey, 'A1'), rows);
    }
  }

  // ---------- Snapshots (Registrations, Clicked Not Registered, Summary) ----------

  let snapshotTimer = null;
  let lastSnapshotAt = 0;

  // Runs soon after a change, but at most once every snapshotMinIntervalMs
  function scheduleSnapshot() {
    if (snapshotTimer) return;
    const wait = Math.max(snapshotDelayMs, lastSnapshotAt + snapshotMinIntervalMs - Date.now());
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      lastSnapshotAt = Date.now();
      run('update registrations and summary', writeSnapshot);
    }, wait);
    snapshotTimer.unref?.();
  }

  async function snapshotData() {
    const [regs, clicked, summary] = await Promise.all([
      registrations.findAll(),
      tracking.getClickedNotRegistered({ limit: 5000 }),
      analytics.getSummary()
    ]);
    return [
      { key: 'registrations', rows: regs.map(registrationRow) },
      { key: 'clickedNotRegistered', rows: clicked.map(clickedRow) },
      { key: 'summary', rows: summaryRows(summary) }
    ];
  }

  async function replaceTabs(tabs) {
    await client.clearRanges(tabs.map(t => range(t.key, 'A2:Z')));
    const data = tabs.filter(t => t.rows.length).map(t => ({ range: range(t.key, 'A2'), values: t.rows }));
    if (data.length) await client.writeRanges(data);
  }

  async function writeSnapshot() {
    await ensureSetup();
    await replaceTabs(await snapshotData());
  }

  // ---------- Full rebuild of every tab from the database ----------

  async function fullSync() {
    clearTimeout(appendTimer);
    clearTimeout(snapshotTimer);
    appendTimer = snapshotTimer = null;
    pending.visitors.length = 0; // these rows are already in the database
    pending.clicks.length = 0;

    await ensureSetup();
    const [visitors, events, snapshot] = await Promise.all([
      tracking.exportVisitors(),
      tracking.exportEvents(),
      snapshotData()
    ]);
    await replaceTabs([
      {
        key: 'visitors',
        rows: visitors.map(v => visitorRow({ visitedAt: v.visited_at, label: v.visitor, page: v.page, source: v.source, device: v.device }))
      },
      {
        key: 'clicks',
        rows: events.map(e => clickRow({ createdAt: e.created_at, label: e.visitor, type: e.event_type, page: e.page, source: e.source, device: e.device }))
      },
      ...snapshot
    ]);
    lastSnapshotAt = Date.now();
  }

  // ---------- Event wiring ----------

  function subscribe(events) {
    events.on('visitor.created', ({ visitor }) => {
      queueRow('visitors', visitorRow({ ...visitor, visitedAt: visitor.firstVisitAt }));
    });
    events.on('event.recorded', ({ event, visitor }) => {
      if (event.type !== 'page_view') {
        queueRow('clicks', clickRow({ ...event, label: visitor.label, source: visitor.source, device: visitor.device }));
      }
      scheduleSnapshot();
    });
    events.on('registration.created', ({ registration, sessionId, page, device }) => {
      if (sessionId) {
        queueRow('clicks', clickRow({
          createdAt: registration.createdAt, label: visitorLabel(sessionId), type: 'registration_submitted',
          page: page || '/', source: registration.source, device: device || 'unknown'
        }));
      }
      scheduleSnapshot();
    });
    events.on('registration.deleted', scheduleSnapshot);
  }

  const status = () => ({ enabled: true, ...state });

  return {
    enabled: true,
    subscribe,
    status,

    /** Rebuilds every tab now. Throws with Google's message if it fails. */
    async syncNow() {
      const error = await run(FULL_SYNC, fullSync);
      if (error) throw new ApiError(502, `Google Sheets sync failed: ${error}`);
      return status();
    },

    /** Creates tabs/formatting on startup so configuration problems show up early */
    checkSetup: () => run('setup', ensureSetup),

    /** Writes anything still waiting (used on shutdown and in tests) */
    async flush() {
      const hadAppends = Boolean(appendTimer);
      const hadSnapshot = Boolean(snapshotTimer);
      clearTimeout(appendTimer);
      clearTimeout(snapshotTimer);
      appendTimer = snapshotTimer = null;
      if (hadAppends) run(APPEND, flushAppends);
      if (hadSnapshot) run('update registrations and summary', writeSnapshot);
      await queue;
    }
  };
}

module.exports = { createSheetsService, TABS, formatDate };
