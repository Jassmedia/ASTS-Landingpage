const { toIso, filterArgs } = require('./mappers');

/**
 * Visitors, events and the analytics built on them. All counting logic
 * lives in the SQL functions in supabase/schema.sql.
 */
function createTrackingRepository(db) {
  return {
    /**
     * Records page_view, demo_button_click or form_started.
     * @returns {{ recorded, newVisitor, event, visitor }}
     *   recorded   - false when a duplicate form_started was ignored
     *   newVisitor - true the first time this session is seen
     *   visitor    - { label, source, device } for reporting
     */
    async recordEvent({ sessionId, eventType, page, source, device }) {
      const result = await db.rpc('asts_track_event', {
        p_session_id: sessionId,
        p_event_type: eventType,
        p_page: page,
        p_source: source,
        p_device: device
      });
      return {
        recorded: result.recorded,
        newVisitor: Boolean(result.newVisitor),
        event: result.event && {
          type: result.event.event_type,
          page: result.event.page,
          createdAt: toIso(result.event.created_at)
        },
        visitor: result.visitor && {
          ...result.visitor,
          firstVisitAt: toIso(result.newVisitor ? result.newVisitor.visited_at : null),
          page: result.newVisitor ? result.newVisitor.page : null
        }
      };
    },

    /** Filters: from, to, course, city, source, tz */
    async getStats(filters = {}) {
      return db.rpc('asts_dashboard_stats', filterArgs(filters, ['from', 'to', 'course', 'city', 'source', 'tz']));
    },

    /** Filters: from, to, source, limit */
    async getClickedNotRegistered(filters = {}) {
      const rows = await db.rpc('asts_clicked_not_registered', filterArgs(filters, ['from', 'to', 'source', 'limit']));
      return rows.map(row => ({
        visitor: row.visitor,
        firstClickedAt: toIso(row.first_clicked_at),
        lastClickedAt: toIso(row.last_clicked_at),
        clicks: row.clicks,
        source: row.source,
        device: row.device
      }));
    },

    async getFilterOptions() {
      return db.rpc('asts_filter_options');
    },

    async exportVisitors(limit) {
      const rows = await db.rpc('asts_export_visitors', filterArgs({ limit }, ['limit']));
      return rows.map(row => ({ ...row, visited_at: toIso(row.visited_at) }));
    },

    /** Clicks, form starts and submissions (no page views) */
    async exportEvents(limit) {
      const rows = await db.rpc('asts_export_events', filterArgs({ limit }, ['limit']));
      return rows.map(row => ({ ...row, created_at: toIso(row.created_at) }));
    }
  };
}

module.exports = { createTrackingRepository };
