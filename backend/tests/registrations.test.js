// Run with: npm test   (Node's built-in test runner; uses the local PostgreSQL database)
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let app;
const api = (...args) => app.request(...args);

before(async () => {
  app = await startTestServer();
});
after(() => app.close());

const validRegistration = {
  name: 'Rahul Kumar',
  phone: '9876543210',
  email: 'Rahul@Gmail.com',
  city: 'Hyderabad',
  course: 'Oracle EPBCS'
};
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('GET /api/health', () => {
  test('reports the backend is running', async () => {
    const res = await api('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: 'ASTS backend is running' });
  });
});

describe('registrations', () => {
  let created;

  test('POST creates a registration (no manual status)', async () => {
    const res = await api('POST', '/api/registrations', validRegistration);
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'Registration submitted successfully');
    created = res.body.data;
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    assert.equal('status' in created, false, 'a registration is REGISTERED by definition');
    assert.equal(created.email, 'rahul@gmail.com');
    assert.equal(created.source, 'direct');
    assert.match(created.createdAt, /Z$/);
    assert.equal(created.sessionId, undefined, 'session IDs stay internal');
  });

  test('POST ignores fields the client must not set', async () => {
    const res = await api('POST', '/api/registrations', {
      ...validRegistration, id: 'hacked', status: 'registered', isAdmin: true
    });
    assert.equal(res.status, 201);
    assert.notEqual(res.body.data.id, 'hacked');
    assert.equal(res.body.data.status, undefined);
    assert.equal(res.body.data.isAdmin, undefined);
  });

  test('POST accepts a missing email and formatted phone numbers', async () => {
    const res = await api('POST', '/api/registrations', {
      ...validRegistration, email: '', phone: '+91 98765-43210'
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.email, null);
    assert.equal(res.body.data.phone, '+919876543210');
  });

  test('POST accepts JSON sent as text/plain (how the landing page posts)', async () => {
    const res = await api('POST', '/api/registrations', JSON.stringify(validRegistration), {
      'Content-Type': 'text/plain;charset=UTF-8'
    });
    assert.equal(res.status, 201);
  });

  test('POST returns 400 with field errors for invalid input', async () => {
    const res = await api('POST', '/api/registrations', {
      name: '  ', phone: '12ab', email: 'not-an-email', city: '', course: ''
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, 'Validation failed');
    assert.deepEqual(Object.keys(res.body.errors).sort(), ['city', 'course', 'email', 'name', 'phone']);
    assert.equal(res.body.errors.phone, 'Invalid phone number');
  });

  test('POST returns 400 for an empty body', async () => {
    const res = await api('POST', '/api/registrations', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.errors.name, 'Name is required');
    assert.equal(res.body.errors.phone, 'Phone number is required');
    assert.equal(res.body.errors.email, undefined); // email is optional
  });

  test('POST returns 400 for malformed JSON', async () => {
    const res = await api('POST', '/api/registrations', '{"name": ');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, message: 'Invalid JSON in request body' });
  });

  test('POST returns 413 for an oversized body', async () => {
    const res = await api('POST', '/api/registrations', { ...validRegistration, name: 'a'.repeat(20000) });
    assert.equal(res.status, 413);
    assert.equal(res.body.success, false);
  });

  test('GET lists registrations, newest first', async () => {
    const res = await api('GET', '/api/registrations');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 4);
    assert.equal(res.body.data.at(-1).id, created.id);
  });

  test('GET /:id returns one registration', async () => {
    const res = await api('GET', `/api/registrations/${created.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, data: created });
  });

  test('GET /:id returns 404 for unknown or malformed ids', async () => {
    for (const id of [MISSING_ID, 'not-a-real-id']) {
      const res = await api('GET', `/api/registrations/${id}`);
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { success: false, message: 'Registration not found' });
    }
  });

  test('there is no manual status update endpoint', async () => {
    const res = await api('PATCH', `/api/registrations/${created.id}/status`, { status: 'contacted' });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: 'Route not found' });

    const after = await api('GET', `/api/registrations/${created.id}`);
    assert.deepEqual(after.body.data, created, 'nothing changed');
  });

  test('GET filters by city and source', async () => {
    await api('POST', '/api/registrations', { ...validRegistration, city: 'Chennai' });
    const res = await api('GET', '/api/registrations?city=chennai');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map(r => r.city), ['Chennai']);

    const none = await api('GET', '/api/registrations?source=nowhere');
    assert.deepEqual(none.body.data, []);
  });

  test('DELETE /:id removes the registration', async () => {
    const res = await api('DELETE', `/api/registrations/${created.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, message: 'Registration deleted successfully' });

    const again = await api('GET', `/api/registrations/${created.id}`);
    assert.equal(again.status, 404);
  });

  test('DELETE /:id returns 404 when already deleted', async () => {
    const res = await api('DELETE', `/api/registrations/${created.id}`);
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: 'Registration not found' });
  });
});

describe('duplicate submissions', () => {
  const submission = { ...validRegistration, name: 'Double Clicker', submission_id: 'sub-1234567890abcdef' };

  test('the same submission_id sent twice (or at once) creates one registration', async () => {
    const [first, second] = await Promise.all([
      api('POST', '/api/registrations', submission),
      api('POST', '/api/registrations', submission)
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(first.body.data.id, second.body.data.id);
    const duplicate = [first, second].find(r => r.status === 200);
    assert.equal(duplicate.body.duplicate, true);

    const third = await api('POST', '/api/registrations', submission);
    assert.equal(third.status, 200);

    const list = await api('GET', '/api/registrations');
    assert.equal(list.body.data.filter(r => r.name === 'Double Clicker').length, 1);
  });

  test('a new submission from the same person is a new registration', async () => {
    const res = await api('POST', '/api/registrations', { ...submission, submission_id: 'sub-another-submission' });
    assert.equal(res.status, 201);
    const list = await api('GET', '/api/registrations');
    assert.equal(list.body.data.filter(r => r.name === 'Double Clicker').length, 2);
  });

  test('an invalid session_id or submission_id never blocks a registration', async () => {
    const res = await api('POST', '/api/registrations', { ...validRegistration, session_id: '<bad>', submission_id: 42 });
    assert.equal(res.status, 201);
  });
});

describe('unknown routes', () => {
  test('return 404 JSON', async () => {
    const res = await api('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, message: 'Route not found' });
  });
});
