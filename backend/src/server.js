const config = require('./config');
const { createApp } = require('./app');
const { createDatabase } = require('./db');
const { buildServices } = require('./services');
const { createGoogleSheetsClientFromConfig } = require('./integrations/googleSheetsClient');

async function main() {
  const db = await createDatabase(config);
  const services = buildServices(db, {
    sheetsClient: createGoogleSheetsClientFromConfig(config.googleSheets),
    timeZone: config.reportTimeZone
  });
  const app = createApp({ services });

  const server = app.listen(config.port, err => {
    if (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${config.port} is already in use. Stop the other process or set PORT in backend/.env.`);
      } else {
        console.error('Failed to start server:', err);
      }
      process.exit(1);
    }

    console.log(`ASTS backend running on http://localhost:${config.port} (${config.env})`);
    console.log(`Dashboard: http://localhost:${config.port}/dashboard/`);
    console.log(`Allowed frontend origins: ${config.corsOrigins.join(', ')}`);
    if (db.kind === 'supabase') {
      console.log('Database: Supabase');
    } else {
      console.log('Database: LOCAL development database (in memory). Data is lost on restart.');
      console.log('          Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env to use Supabase.');
    }
    if (!config.adminApiKey) {
      console.warn('Admin key: NOT SET. Dashboard and registration admin endpoints are open (development only).');
    }
    console.log(`Google Sheets: ${services.sheets.enabled ? 'enabled' : 'off (not configured)'}`);
    if (services.sheets.enabled) services.sheets.checkSetup();
  });

  async function shutdown(signal) {
    console.log(`${signal} received, shutting down...`);
    setTimeout(() => process.exit(0), 5000).unref();
    server.close();
    await services.sheets.flush();
    await db.close();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
