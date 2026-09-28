const ApiError = require('../utils/ApiError');

const NOT_FOUND = 'Registration not found';

// Business rules for registrations. Talks to storage only through the
// repository, and announces changes on `events` (used by the Google Sheets sync).
function createRegistrationService(repository, events) {
  const emit = (name, payload) => {
    try {
      events?.emit(name, payload);
    } catch (err) {
      console.error(`[events] ${name} listener failed:`, err.message);
    }
  };

  return {
    /**
     * Saves a completed registration, which automatically makes the visitor
     * REGISTERED. Resending the same submissionId returns the existing
     * registration instead of creating a duplicate.
     * @returns {{ created: boolean, registration: object }}
     */
    async createRegistration(input) {
      const { created, registration, sessionId } = await repository.create(input);
      if (created) {
        emit('registration.created', { registration, sessionId, page: input.page, device: input.device });
      }
      return { created, registration };
    },

    async listRegistrations(filters) {
      return repository.findAll(filters);
    },

    async getRegistration(id) {
      const registration = await repository.findById(id);
      if (!registration) throw ApiError.notFound(NOT_FOUND);
      return registration;
    },

    async deleteRegistration(id) {
      const deleted = await repository.deleteById(id);
      if (!deleted) throw ApiError.notFound(NOT_FOUND);
      emit('registration.deleted', { id });
    }
  };
}

module.exports = { createRegistrationService, REGISTRATION_NOT_FOUND: NOT_FOUND };
