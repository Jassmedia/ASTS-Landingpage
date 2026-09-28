const { createRegistrationRepository } = require('./registrationRepository');
const { createTrackingRepository } = require('./trackingRepository');

// Builds every repository on top of one database connection (see src/db).
function createRepositories(db) {
  return {
    registrations: createRegistrationRepository(db),
    tracking: createTrackingRepository(db)
  };
}

module.exports = { createRepositories };
