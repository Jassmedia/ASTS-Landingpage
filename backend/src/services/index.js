const { EventEmitter } = require('events');
const { createRepositories } = require('../repositories');
const { createRegistrationService } = require('./registrationService');
const { createTrackingService } = require('./trackingService');
const { createAnalyticsService } = require('./analyticsService');
const { createSheetsService } = require('./sheetsService');

/**
 * Wires every service to one database connection.
 * @param {object} db            from src/db (Supabase or local)
 * @param {object} options
 * @param {object|null} options.sheetsClient   Google Sheets client, or null to disable
 * @param {string} options.timeZone            time zone for dates in Google Sheets
 * @param {object} [options.sheetsOptions]     timing overrides (tests)
 */
function buildServices(db, { sheetsClient = null, timeZone = 'UTC', sheetsOptions = {} } = {}) {
  const repositories = createRepositories(db);
  // Services announce changes here; the Sheets sync listens
  const events = new EventEmitter();

  const analytics = createAnalyticsService(repositories.tracking);
  const sheets = createSheetsService({
    client: sheetsClient,
    registrations: repositories.registrations,
    tracking: repositories.tracking,
    analytics,
    timeZone,
    ...sheetsOptions
  });
  sheets.subscribe(events);

  return {
    db,
    events,
    registrations: createRegistrationService(repositories.registrations, events),
    tracking: createTrackingService(repositories.tracking, events),
    analytics,
    sheets
  };
}

module.exports = { buildServices };
