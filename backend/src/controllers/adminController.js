// Dashboard and Google Sheets endpoints. All routes here require the admin key.
function createAdminController({ analytics, sheets, db }) {
  return {
    // Lets the dashboard check the admin key and show which database is in use
    getSession(req, res) {
      res.json({ success: true, data: { database: db.kind, sheets: sheets.enabled } });
    },

    async getDashboard(req, res) {
      res.json({ success: true, data: await analytics.getDashboard(res.locals.query) });
    },

    async getClickedNotRegistered(req, res) {
      res.json({ success: true, data: await analytics.getClickedNotRegistered(res.locals.query) });
    },

    getSheetsStatus(req, res) {
      res.json({ success: true, data: sheets.status() });
    },

    async syncSheets(req, res) {
      const status = await sheets.syncNow();
      res.json({ success: true, message: 'Google Sheet updated', data: status });
    }
  };
}

module.exports = { createAdminController };
