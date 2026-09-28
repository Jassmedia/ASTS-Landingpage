const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, UA } = require('./helpers');
const { createRequireAdmin } = require('../src/middleware/requireAdmin');

const KEY = 'test-admin-key-0123456789abcdef';
let app;
const api = (...args) => app.request(...args);
const auth = key => ({ Authorization: `Bearer ${key}` });

before(async () => {
  app = await startTestServer({ config: { adminApiKey: KEY } });
});
after(() => app.close());

describe('with ADMIN_API_KEY set', () => {
  test('admin endpoints need the key', async () => {
    for (const path of ['/api/registrations', '/api/admin/dashboard', '/api/admin/clicked-not-registered', '/api/admin/session']) {
      const none = await api('GET', path);
      assert.equal(none.status, 401, path);
      assert.deepEqual(none.body, { success: false, message: 'Unauthorized' });

      const wrong = await api('GET', path, undefined, auth('wrong-key'));
      assert.equal(wrong.status, 401, path);

      const right = await api('GET', path, undefined, auth(KEY));
      assert.equal(right.status, 200, path);
    }
  });

  test('reading and deleting a registration need the key', async () => {
    const created = await api('POST', '/api/registrations', {
      name: 'Admin Test', phone: '9876543210', city: 'Hyderabad', course: 'Oracle EPBCS'
    });
    const id = created.body.data.id;
    assert.equal((await api('GET', `/api/registrations/${id}`)).status, 401);
    assert.equal((await api('DELETE', `/api/registrations/${id}`)).status, 401);
    assert.equal((await api('GET', `/api/registrations/${id}`, undefined, auth(KEY))).status, 200);
  });

  test('the landing page endpoints stay public', async () => {
    const reg = await api('POST', '/api/registrations', {
      name: 'Public Form', phone: '9876543210', city: 'Hyderabad', course: 'Oracle EPBCS'
    });
    assert.equal(reg.status, 201);
    const tracked = await api('POST', '/api/track', { session_id: 'public-session-01', event_type: 'page_view' }, { 'User-Agent': UA.desktop });
    assert.equal(tracked.status, 202);
    assert.equal((await api('GET', '/api/health')).status, 200);
  });

  test('the session endpoint reports the database in use', async () => {
    const res = await api('GET', '/api/admin/session', undefined, auth(KEY));
    assert.deepEqual(res.body.data, { database: 'local', sheets: false });
  });

  test('Sheets sync explains when Google Sheets is not configured', async () => {
    const res = await api('POST', '/api/admin/sheets/sync', undefined, auth(KEY));
    assert.equal(res.status, 400);
    assert.match(res.body.message, /not configured/);
  });

  test('the dashboard page is served, and its data is not in it', async () => {
    const res = await fetch(`${app.base}/dashboard/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>/);
    assert.ok(!html.includes('Admin Test'));
  });
});

describe('without ADMIN_API_KEY', () => {
  const run = middleware => new Promise(resolve => middleware({ get: () => '' }, {}, err => resolve(err)));

  test('admin endpoints are open in development', async () => {
    const err = await run(createRequireAdmin({ adminApiKey: '', env: 'development' }));
    assert.equal(err, undefined);
  });

  test('admin endpoints are refused in production', async () => {
    const err = await run(createRequireAdmin({ adminApiKey: '', env: 'production' }));
    assert.equal(err.statusCode, 503);
  });
});
