const { once } = require('node:events');
const baseConfig = require('../src/config');
const { createApp } = require('../src/app');
const { createLocalDatabase } = require('../src/db/localDatabase');
const { buildServices } = require('../src/services');

/**
 * Starts the real app on a random port with a fresh local PostgreSQL
 * database (same schema as Supabase). Each call gets an empty database.
 */
async function startTestServer({ config = {}, sheetsClient = null, sheetsOptions } = {}) {
  const db = await createLocalDatabase();
  const services = buildServices(db, { sheetsClient, timeZone: 'Asia/Kolkata', sheetsOptions });
  const app = createApp({ services, config: { ...baseConfig, ...config }, rateLimit: false });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  async function close() {
    server.close();
    await services.sheets.flush();
    await db.close();
  }

  return { base, services, db, request, close };
}

// Browser-like user agents
const UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  mobile: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  bot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
};

module.exports = { startTestServer, UA };
