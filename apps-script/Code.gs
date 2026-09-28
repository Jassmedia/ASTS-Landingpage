/** @OnlyCurrentDoc */
/**
 * ASTS Free Demo: registrations, visitor tracking and the private admin dashboard.
 *
 * ONE Google Apps Script Web App + ONE Google Sheet (the single source of truth):
 *
 *   register.aststraining.com --POST {action: 'track' | 'register'}------> this script --> Google Sheet
 *   admin dashboard ----------POST {action: 'dashboard', adminKey}------> this script <-- Google Sheet
 *
 * Tabs (created by setup()):
 *   Events         one row per tracked action: page_view, demo_button_click,
 *                  form_started (sent by the website) and registration_submitted
 *                  (written here, only when a registration is saved)
 *   Registrations  one row per saved registration
 *
 * Deploy: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 * Admin key: Project Settings > Script properties > ADMIN_KEY (setup() creates one).
 * Full instructions: apps-script/README.md in the website project.
 */

// ---------------------------------------------------------------------------
// Sheet structure
// ---------------------------------------------------------------------------

const EVENTS_SHEET = 'Events';
const REGISTRATIONS_SHEET = 'Registrations';

const EVENT_HEADERS = [
  'Event ID', 'Event Type', 'Visitor ID', 'Session ID', 'Timestamp', 'Page URL',
  'UTM Source', 'UTM Medium', 'UTM Campaign', 'GCLID', 'Device', 'Browser'
];

const REGISTRATION_HEADERS = [
  'Registration ID', 'Visitor ID', 'Session ID', 'Name', 'Phone', 'Email', 'City', 'Course',
  'Country', 'Country Code', 'Consent', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Term',
  'GCLID', 'Page URL', 'Device', 'Browser', 'Submission ID', 'Submitted At'
];

// Sent by the website. registration_submitted is written by this script in the
// same request that saves the registration, so it never exists for a failed save.
const WEBSITE_EVENTS = ['page_view', 'demo_button_click', 'form_started'];
const REGISTRATION_EVENT = 'registration_submitted';

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY_CHARS = 20000;
const MIN_ADMIN_KEY_LENGTH = 24;
const MAX_EVENTS_RETURNED = 500;
const MAX_BREAKDOWN_ROWS = 50;

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------

/**
 * Health check only: opening the /exec URL in a browser shows {"success":true,...}.
 * No data is ever returned here. Dashboard reads use POST because Apps Script
 * cannot read request headers, and the admin key must never go in the URL.
 */
function doGet() {
  return json_({
    success: true,
    service: 'ASTS registrations and tracking',
    status: 'ok',
    time: new Date().toISOString()
  });
}

/**
 * Every write and every dashboard read. The body is JSON sent as plain text,
 * which browsers can POST cross-origin without a CORS pre-check.
 */
function doPost(e) {
  let request;
  try {
    const raw = e && e.postData ? String(e.postData.contents || '') : '';
    if (!raw) return json_(fail_('EMPTY', 'The request was empty.'));
    if (raw.length > MAX_BODY_CHARS) return json_(fail_('TOO_LARGE', 'The request is too large.'));
    request = JSON.parse(raw);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('not an object');
  } catch (err) {
    return json_(fail_('BAD_JSON', 'The request must be a JSON object.'));
  }

  try {
    switch (request.action) {
      case 'track': return json_(track_(request));
      case 'register': return json_(register_(request));
      case 'dashboard': return json_(dashboard_(request));
      default: return json_(fail_('UNKNOWN_ACTION', 'Unknown action.'));
    }
  } catch (err) {
    // Never log the request itself: it can hold personal details or the admin key
    console.error('doPost failed (' + request.action + '): ' + (err && err.stack ? err.stack : err));
    return json_(fail_('SERVER_ERROR', 'Something went wrong on our side. Please try again.'));
  }
}

// ---------------------------------------------------------------------------
// action: 'track'  (page_view, demo_button_click, form_started)
// ---------------------------------------------------------------------------

function track_(req) {
  const type = text_(req.event, 40);
  if (WEBSITE_EVENTS.indexOf(type) === -1) return fail_('BAD_EVENT', 'Unknown event type.');
  const t = trackingFields_(req);
  if (!t.visitorId) return fail_('BAD_VISITOR', 'A valid visitor ID is required.');

  appendRow_(sheetInfo_(EVENTS_SHEET, EVENT_HEADERS), eventRecord_(type, t, new Date()));
  return { success: true };
}

// ---------------------------------------------------------------------------
// action: 'register'
// ---------------------------------------------------------------------------

function register_(req) {
  // Honeypot: people never see this field, so anything in it means a bot
  if (text_(req.website, 200)) return fail_('REJECTED', 'This registration could not be accepted.');

  const t = trackingFields_(req);
  const name = text_(req.name, 80);
  const phone = String(req.phone === null || req.phone === undefined ? '' : req.phone).replace(/\D/g, '');
  const email = text_(req.email, 254);
  const city = text_(req.city, 50);
  const course = text_(req.course, 100);
  const country = text_(req.country, 60);
  const countryCode = text_(req.countryCode, 2).toUpperCase();

  // The same rules as the form on the website
  const errors = {};
  if (!/^[A-Za-z][A-Za-z\s.'-]{1,79}$/.test(name)) errors.name = 'Enter your full name';
  if (!/^\d{10,15}$/.test(phone) || (countryCode === 'IN' && !/^91[6-9]\d{9}$/.test(phone))) {
    errors.phone = 'Enter a valid WhatsApp number';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address';
  if (!/^[A-Za-z][A-Za-z\s.,-]{1,49}$/.test(city)) errors.city = 'Enter your city';
  if (!/^[\w .,&()+\/-]{2,100}$/.test(course)) errors.course = 'The course is missing';
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) errors.country = 'Choose your country';
  if (req.consent !== true) errors.consent = 'Tick the consent box';
  if (Object.keys(errors).length) return fail_('INVALID', 'Please check your details.', { errors: errors });

  const submissionId = id_(req.submissionId);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return fail_('BUSY', 'The registration system is busy. Please try again in a moment.');

  let registrationId;
  let savedAt;
  try {
    const regs = sheetInfo_(REGISTRATIONS_SHEET, REGISTRATION_HEADERS);

    // The same submission sent twice (double-click, or a retry after a slow
    // answer) returns the registration that was already saved
    const earlierRow = submissionId ? findRow_(regs, 'Submission ID', submissionId) : 0;
    if (earlierRow) {
      const earlierId = regs.sheet.getRange(earlierRow, regs.columns['Registration ID'] + 1).getValue();
      return { success: true, registrationId: String(earlierId), duplicate: true };
    }

    savedAt = new Date();
    registrationId = newRegistrationId_(regs, savedAt);
    appendRow_(regs, {
      'Registration ID': registrationId,
      'Visitor ID': t.visitorId,
      'Session ID': t.sessionId,
      'Name': name,
      'Phone': phone,
      'Email': email,
      'City': city,
      'Course': course,
      'Country': country,
      'Country Code': countryCode,
      'Consent': 'Yes',
      'UTM Source': t.utmSource,
      'UTM Medium': t.utmMedium,
      'UTM Campaign': t.utmCampaign,
      'UTM Term': t.utmTerm,
      'GCLID': t.gclid,
      'Page URL': t.pageUrl,
      'Device': t.device,
      'Browser': t.browser,
      'Submission ID': submissionId,
      'Submitted At': savedAt
    });
    SpreadsheetApp.flush(); // the row is written before the website is told "saved"
  } finally {
    lock.releaseLock();
  }

  // The matching tracking event. The registration is already saved, so a
  // problem here must not turn it into an error for the visitor.
  try {
    appendRow_(sheetInfo_(EVENTS_SHEET, EVENT_HEADERS), eventRecord_(REGISTRATION_EVENT, t, savedAt));
  } catch (err) {
    console.error('registration_submitted event not saved for ' + registrationId + ': ' + err);
  }

  return { success: true, registrationId: registrationId };
}

// ASTS-20260928-7F3A1C (the date uses the Sheet's time zone)
function newRegistrationId_(regs, when) {
  const day = Utilities.formatDate(when, sheetTimeZone_(), 'yyyyMMdd');
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = 'ASTS-' + day + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase();
    if (!findRow_(regs, 'Registration ID', id)) return id;
  }
  throw new Error('Could not create a unique registration ID');
}

// ---------------------------------------------------------------------------
// action: 'dashboard'  (admin only)
// ---------------------------------------------------------------------------

function dashboard_(req) {
  const denied = checkAdminKey_(req.adminKey);
  if (denied) return denied;

  const from = millisOrNull_(req.from);
  const to = millisOrNull_(req.to);
  if (from !== null && to !== null && from >= to) return fail_('BAD_RANGE', 'The start date must be before the end date.');
  const timeZone = timeZone_(req.timeZone);
  const bucket = req.bucket === 'hour' ? 'hour' : 'day';

  return { success: true, data: buildDashboard_(from, to, timeZone, bucket) };
}

/** Returns null when the key is right, otherwise the failure to send back. */
function checkAdminKey_(key) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || '';
  if (expected.length < MIN_ADMIN_KEY_LENGTH) {
    return fail_('NOT_CONFIGURED', 'The dashboard is locked. Run setup() in Apps Script, or set ADMIN_KEY ' +
      '(at least ' + MIN_ADMIN_KEY_LENGTH + ' characters) in Project Settings > Script properties.');
  }
  if (typeof key !== 'string' || !sameText_(key, expected)) return fail_('UNAUTHORIZED', 'Wrong admin key.');
  return null;
}

/**
 * Everything the dashboard shows, for the period [from, to) (null = no limit).
 * Days (or hours) are counted in the dashboard's own time zone.
 */
function buildDashboard_(from, to, timeZone, bucket) {
  const inRange = t => (from === null || t >= from) && (to === null || t < to);
  const bucketOf = bucketKey_(timeZone, bucket);
  const buckets = {};
  const sources = {};

  // Registrations. Status is decided by ALL registrations, not only this
  // period: someone who clicked last week and registered today is REGISTERED.
  const regInfo = sheetInfo_(REGISTRATIONS_SHEET, REGISTRATION_HEADERS);
  const R = regInfo.columns;
  const registeredVisitors = new Set();
  const registrations = [];
  rows_(regInfo).forEach(row => {
    const visitorId = cellText_(row, R['Visitor ID']);
    if (visitorId) registeredVisitors.add(visitorId);
    const t = millis_(row[R['Submitted At']]);
    if (t === null || !inRange(t)) return;
    registrations.push({
      t: t,
      registrationId: cellText_(row, R['Registration ID']),
      visitorId: visitorId,
      sessionId: cellText_(row, R['Session ID']),
      name: cellText_(row, R['Name']),
      phone: cellText_(row, R['Phone']),
      email: cellText_(row, R['Email']),
      city: cellText_(row, R['City']),
      course: cellText_(row, R['Course']),
      country: cellText_(row, R['Country']),
      countryCode: cellText_(row, R['Country Code']),
      utmSource: cellText_(row, R['UTM Source']),
      utmMedium: cellText_(row, R['UTM Medium']),
      utmCampaign: cellText_(row, R['UTM Campaign']),
      utmTerm: cellText_(row, R['UTM Term']),
      gclid: cellText_(row, R['GCLID']),
      pageUrl: cellText_(row, R['Page URL']),
      device: cellText_(row, R['Device']),
      browser: cellText_(row, R['Browser'])
    });
  });

  // Events
  const evInfo = sheetInfo_(EVENTS_SHEET, EVENT_HEADERS);
  const E = evInfo.columns;
  const evRows = rows_(evInfo);
  const eventCounts = { page_view: 0, demo_button_click: 0, form_started: 0, registration_submitted: 0 };
  const visitors = new Set();
  const clickers = new Set();
  const formStarters = new Set();
  const clicks = {};       // visitor ID -> their clicks in this period
  const recent = [];       // row indexes of events in this period, oldest first

  evRows.forEach((row, index) => {
    const t = millis_(row[E['Timestamp']]);
    if (t === null || !inRange(t)) return;
    const type = cellText_(row, E['Event Type']);
    if (!(type in eventCounts)) return;
    eventCounts[type]++;
    recent.push(index);

    const visitorId = cellText_(row, E['Visitor ID']);
    const b = bucket_(buckets, bucketOf(t));
    const src = source_(sources, cellText_(row, E['UTM Source']), cellText_(row, E['UTM Medium']), cellText_(row, E['UTM Campaign']));
    if (visitorId) {
      visitors.add(visitorId);
      b.visitors.add(visitorId);
      src.visitors.add(visitorId);
    }
    if (type === 'page_view') {
      b.pageViews++;
    } else if (type === 'demo_button_click') {
      b.clicks++;
      if (visitorId) {
        clickers.add(visitorId);
        b.clickers.add(visitorId);
        src.clickers.add(visitorId);
        noteClick_(clicks, visitorId, t, row, E);
      }
    } else if (type === 'form_started' && visitorId) {
      formStarters.add(visitorId);
      b.formStarts.add(visitorId);
    }
  });

  registrations.forEach(r => {
    bucket_(buckets, bucketOf(r.t)).registrations++;
    source_(sources, r.utmSource, r.utmMedium, r.utmCampaign).registrations++;
  });

  const clickedNotRegistered = Object.keys(clicks)
    .filter(visitorId => !registeredVisitors.has(visitorId))
    .map(visitorId => clicks[visitorId])
    .sort((a, b) => b.lastClick - a.lastClick)
    .map(c => ({
      visitorId: c.visitorId,
      firstClick: new Date(c.firstClick).toISOString(),
      lastClick: new Date(c.lastClick).toISOString(),
      clicks: c.clicks,
      utmSource: c.utmSource,
      utmMedium: c.utmMedium,
      utmCampaign: c.utmCampaign,
      gclid: c.gclid,
      device: c.device,
      browser: c.browser,
      pageUrl: c.pageUrl
    }));

  registrations.sort((a, b) => b.t - a.t);

  return {
    generatedAt: new Date().toISOString(),
    timeZone: timeZone,
    bucket: bucket,
    range: { from: from, to: to },
    metrics: {
      totalVisitors: eventCounts.page_view,
      uniqueVisitors: visitors.size,
      demoClicks: eventCounts.demo_button_click,
      uniqueClickers: clickers.size,
      formStarts: formStarters.size,
      registrations: registrations.length,
      conversionRate: visitors.size ? Math.round(registrations.length / visitors.size * 1000) / 10 : null,
      clickedNotRegistered: clickedNotRegistered.length
    },
    eventCounts: eventCounts,
    series: Object.keys(buckets).sort().map(key => {
      const b = buckets[key];
      return {
        key: key,
        pageViews: b.pageViews,
        visitors: b.visitors.size,
        clicks: b.clicks,
        clickers: b.clickers.size,
        formStarts: b.formStarts.size,
        registrations: b.registrations
      };
    }),
    breakdowns: {
      course: breakdown_(registrations, 'course'),
      city: breakdown_(registrations, 'city'),
      utmSource: breakdown_(registrations, 'utmSource'),
      utmCampaign: breakdown_(registrations, 'utmCampaign')
    },
    sources: Object.keys(sources).map(key => {
      const s = sources[key];
      return {
        source: s.source,
        medium: s.medium,
        campaign: s.campaign,
        visitors: s.visitors.size,
        clickers: s.clickers.size,
        registrations: s.registrations
      };
    }).sort((a, b) => b.registrations - a.registrations || b.visitors - a.visitors).slice(0, 100),
    registrations: registrations.map(r => {
      const out = Object.assign({}, r, { submittedAt: new Date(r.t).toISOString() });
      delete out.t;
      return out;
    }),
    clickedNotRegistered: clickedNotRegistered,
    eventsInRange: recent.length,
    events: recent.slice(-MAX_EVENTS_RETURNED).reverse().map(index => {
      const row = evRows[index];
      return {
        eventId: cellText_(row, E['Event ID']),
        type: cellText_(row, E['Event Type']),
        visitorId: cellText_(row, E['Visitor ID']),
        sessionId: cellText_(row, E['Session ID']),
        time: new Date(millis_(row[E['Timestamp']])).toISOString(),
        pageUrl: cellText_(row, E['Page URL']),
        utmSource: cellText_(row, E['UTM Source']),
        utmMedium: cellText_(row, E['UTM Medium']),
        utmCampaign: cellText_(row, E['UTM Campaign']),
        gclid: cellText_(row, E['GCLID']),
        device: cellText_(row, E['Device']),
        browser: cellText_(row, E['Browser'])
      };
    })
  };
}

function bucket_(buckets, key) {
  return buckets[key] || (buckets[key] = {
    pageViews: 0, visitors: new Set(), clicks: 0, clickers: new Set(), formStarts: new Set(), registrations: 0
  });
}

// Traffic source = UTM source / medium / campaign, grouped ignoring upper/lower case
function source_(sources, source, medium, campaign) {
  const key = [source, medium, campaign].map(v => v.toLowerCase()).join('␟');
  return sources[key] || (sources[key] = {
    source: source, medium: medium, campaign: campaign, visitors: new Set(), clickers: new Set(), registrations: 0
  });
}

// Keeps each clicker's first/last click and the attribution of their latest click
function noteClick_(clicks, visitorId, t, row, E) {
  const c = clicks[visitorId] || (clicks[visitorId] = {
    visitorId: visitorId, firstClick: t, lastClick: t, clicks: 0,
    utmSource: '', utmMedium: '', utmCampaign: '', gclid: '', device: '', browser: '', pageUrl: ''
  });
  c.clicks++;
  if (t < c.firstClick) c.firstClick = t;
  const latest = t >= c.lastClick;
  if (latest) c.lastClick = t;
  [['utmSource', 'UTM Source'], ['utmMedium', 'UTM Medium'], ['utmCampaign', 'UTM Campaign'], ['gclid', 'GCLID'],
    ['device', 'Device'], ['browser', 'Browser'], ['pageUrl', 'Page URL']].forEach(pair => {
    const value = cellText_(row, E[pair[1]]);
    if (value && (latest || !c[pair[0]])) c[pair[0]] = value;
  });
}

// Registrations counted per value (e.g. per city), biggest first. "" = not set.
function breakdown_(registrations, field) {
  const groups = {};
  registrations.forEach(r => {
    const label = r[field];
    const key = label.toLowerCase();
    (groups[key] || (groups[key] = { label: label, count: 0 })).count++;
  });
  return Object.keys(groups).map(k => groups[k])
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, MAX_BREAKDOWN_ROWS);
}

/**
 * Local day ("2026-09-28") or hour ("2026-09-28T14") of a timestamp in the
 * given time zone. The zone's UTC offset is looked up once per hour of data.
 */
function bucketKey_(timeZone, bucket) {
  const offsets = {};
  const length = bucket === 'hour' ? 13 : 10;
  return t => {
    const hour = Math.floor(t / 3600000);
    let offset = offsets[hour];
    if (offset === undefined) {
      const start = new Date(hour * 3600000);
      const local = Utilities.formatDate(start, timeZone, "yyyy-MM-dd'T'HH:mm:ss");
      offset = offsets[hour] = Date.parse(local + 'Z') - start.getTime();
    }
    return new Date(t + offset).toISOString().slice(0, length);
  };
}

// ---------------------------------------------------------------------------
// One-time setup (run from the Apps Script editor)
// ---------------------------------------------------------------------------

/**
 * Run once: select "setup" in the toolbar and click Run. Creates the Events and
 * Registrations tabs with their headers and, if there is none yet, a random
 * ADMIN_KEY in Script properties. Safe to run again: it never deletes data and
 * never replaces an existing key.
 */
function setup() {
  formatSheet_(sheetInfo_(EVENTS_SHEET, EVENT_HEADERS), 'Timestamp');
  formatSheet_(sheetInfo_(REGISTRATIONS_SHEET, REGISTRATION_HEADERS), 'Submitted At');

  const props = PropertiesService.getScriptProperties();
  if ((props.getProperty('ADMIN_KEY') || '').length >= MIN_ADMIN_KEY_LENGTH) {
    console.log('ADMIN_KEY already exists and was not changed.');
  } else {
    props.setProperty('ADMIN_KEY', newAdminKey_());
    console.log('Created ADMIN_KEY. Copy it from Project Settings > Script properties.');
  }
  console.log('Setup complete. The Sheet\'s time zone is ' + sheetTimeZone_() + '.');
}

/** Replaces the admin key (e.g. if it was shared by mistake). The old key stops working at once. */
function rotateAdminKey() {
  PropertiesService.getScriptProperties().setProperty('ADMIN_KEY', newAdminKey_());
  console.log('Replaced ADMIN_KEY. Copy the new key from Project Settings > Script properties.');
}

// 64 random hex characters
function newAdminKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function formatSheet_(info, timeHeader) {
  const sheet = info.sheet;
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, info.width).setFontWeight('bold');
  if (sheet.getMaxRows() > 1) {
    sheet.getRange(2, info.columns[timeHeader] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

const SHEET_CACHE_ = {};

/**
 * The tab plus a header -> column map. Creates the tab if it is missing and
 * adds any missing header at the end, so columns can be reordered safely.
 */
function sheetInfo_(name, headers) {
  if (SHEET_CACHE_[name]) return SHEET_CACHE_[name];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Google Sheet: Extensions > Apps Script.');

  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    try {
      sheet = ss.insertSheet(name);
    } catch (err) {
      sheet = ss.getSheetByName(name); // created at the same moment by another request
      if (!sheet) throw err;
    }
  }

  let current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(h => String(h).trim());
  if (current.every(h => h === '')) current = [];
  const missing = headers.filter(h => current.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    current = current.concat(missing);
    sheet.getRange(1, 1, 1, current.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  const columns = {};
  current.forEach((h, i) => { if (h && !(h in columns)) columns[h] = i; });
  return (SHEET_CACHE_[name] = { sheet: sheet, columns: columns, width: current.length });
}

function appendRow_(info, record) {
  const row = new Array(info.width).fill('');
  Object.keys(record).forEach(header => {
    const i = info.columns[header];
    if (i !== undefined) row[i] = cell_(record[header]);
  });
  info.sheet.appendRow(row);
}

/**
 * Text is stored as plain text: the leading apostrophe stops Sheets from
 * running "=..." as a formula or turning "919876543210" into a number.
 * The apostrophe is not part of the stored value. Dates stay real dates.
 */
function cell_(value) {
  if (value instanceof Date) return value;
  if (value === null || value === undefined || value === '') return '';
  return "'" + String(value);
}

function rows_(info) {
  const last = info.sheet.getLastRow();
  if (last < 2) return [];
  return info.sheet.getRange(2, 1, last - 1, info.width).getValues();
}

// Row number (2+) whose cell under `header` equals `value` exactly, or 0
function findRow_(info, header, value) {
  const last = info.sheet.getLastRow();
  if (last < 2 || !value) return 0;
  const match = info.sheet.getRange(2, info.columns[header] + 1, last - 1, 1)
    .createTextFinder(value).matchCase(true).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}

function sheetTimeZone_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
}

// ---------------------------------------------------------------------------
// Input and value helpers
// ---------------------------------------------------------------------------

function trackingFields_(req) {
  return {
    visitorId: id_(req.visitorId),
    sessionId: id_(req.sessionId),
    pageUrl: url_(req.pageUrl),
    utmSource: text_(req.utmSource, 200),
    utmMedium: text_(req.utmMedium, 200),
    utmCampaign: text_(req.utmCampaign, 200),
    utmTerm: text_(req.utmTerm, 200),
    gclid: text_(req.gclid, 300),
    device: ['desktop', 'mobile', 'tablet'].indexOf(req.device) === -1 ? '' : req.device,
    browser: text_(req.browser, 40)
  };
}

function eventRecord_(type, t, when) {
  return {
    'Event ID': Utilities.getUuid(),
    'Event Type': type,
    'Visitor ID': t.visitorId,
    'Session ID': t.sessionId,
    'Timestamp': when,
    'Page URL': t.pageUrl,
    'UTM Source': t.utmSource,
    'UTM Medium': t.utmMedium,
    'UTM Campaign': t.utmCampaign,
    'GCLID': t.gclid,
    'Device': t.device,
    'Browser': t.browser
  };
}

// One line of text: control characters removed, spaces collapsed, length capped
function text_(value, max) {
  if (value === null || value === undefined || typeof value === 'object') return '';
  return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function id_(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return ID_PATTERN.test(s) ? s : '';
}

function url_(value) {
  const s = text_(value, 500);
  return /^https?:\/\//i.test(s) ? s : '';
}

function cellText_(row, index) {
  if (index === undefined) return '';
  const value = row[index];
  return value === null || value === undefined ? '' : String(value).trim();
}

function millis_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return isNaN(t) ? null : t;
  }
  return null;
}

function millisOrNull_(value) {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

// An IANA name such as Asia/Kolkata; anything else falls back to the Sheet's zone
function timeZone_(value) {
  return typeof value === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value) ? value : sheetTimeZone_();
}

// Compares SHA-256 digests so the time taken does not reveal how much matched
function sameText_(a, b) {
  const digest = s => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  const x = digest(a);
  const y = digest(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function fail_(code, message, extra) {
  return Object.assign({ success: false, code: code, error: message }, extra || {});
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
