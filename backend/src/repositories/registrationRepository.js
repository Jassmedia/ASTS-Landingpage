const { toIso, filterArgs } = require('./mappers');

// Database row -> API shape. session_id and submission_id stay internal.
// There is no status field: every registration is REGISTERED by definition.
function toRegistration(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    course: row.course,
    source: row.source,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

/**
 * Registrations storage. Works with any database from src/db (Supabase or
 * the local development database), which all expose rpc(fn, args).
 */
function createRegistrationRepository(db) {
  return {
    /** @returns {{ created: boolean, registration: object, sessionId: string|null }} */
    async create({ submissionId, sessionId, name, phone, email, city, course, source, page, device }) {
      const result = await db.rpc('asts_create_registration', {
        p_submission_id: submissionId ?? null,
        p_session_id: sessionId ?? null,
        p_name: name,
        p_phone: phone,
        p_email: email ?? null,
        p_city: city,
        p_course: course,
        p_source: source ?? null,
        p_page: page ?? '/',
        p_device: device ?? 'unknown'
      });
      return {
        created: result.created,
        registration: toRegistration(result.registration),
        sessionId: result.registration.session_id
      };
    },

    /** Newest first. Filters: from, to, course, city, source, limit */
    async findAll(filters = {}) {
      const rows = await db.rpc('asts_list_registrations', filterArgs(filters, ['from', 'to', 'course', 'city', 'source', 'limit']));
      return rows.map(toRegistration);
    },

    async findById(id) {
      return toRegistration(await db.rpc('asts_get_registration', { p_id: id }));
    },

    /** @returns true if deleted, false if the id doesn't exist */
    async deleteById(id) {
      return db.rpc('asts_delete_registration', { p_id: id });
    }
  };
}

module.exports = { createRegistrationRepository };
