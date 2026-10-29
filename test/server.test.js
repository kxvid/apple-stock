import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { startServer } from '../src/server.js';

async function fixture(t, options = {}) {
  const calls = [];
  const checker = {
    snapshot: () => ({ settings: { country: 'us' }, checking: false }),
    updateSettings: async (body) => { calls.push(body); return true; },
    testNotifier: async () => { calls.push('notify'); },
  };
  const server = startServer(checker, { host: '127.0.0.1', port: 0, onSettingsChanged: () => calls.push('check'), ...options });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { calls, origin, request: (path, options) => fetch(`${origin}${path}`, options) };
}

const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('API snapshots are uncached and include runtime timing', async (t) => {
  const { request } = await fixture(t, { runtime: () => ({ intervalSeconds: 30, nextCheckAt: '2026-10-29T18:00:00Z', initializing: false }) });
  const result = await request('/api/state');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.json()).intervalSeconds, 30);
});

test('same-origin settings mutation works, empty manual check body remains supported', async (t) => {
  const { request, calls, origin } = await fixture(t);
  assert.equal((await request('/api/settings', post({ postalCode: '90210' }, { Origin: origin }))).status, 200);
  assert.equal((await request('/api/check', { method: 'POST' })).status, 200);
  assert.deepEqual(calls, [{ postalCode: '90210' }, 'check', 'check']);
});

test('cross-origin and cross-site mutation requests do not change settings', async (t) => {
  const { request, calls, origin } = await fixture(t);
  assert.equal((await request('/api/settings', post({}, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await request('/api/check', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', Origin: origin } })).status, 403);
  assert.deepEqual(calls, []);
});

test('untrusted Host names are rejected to prevent DNS rebinding', async (t) => {
  const { origin } = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}/api/state`, { headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('settings accepts only a bounded JSON object', async (t) => {
  const { request, calls } = await fixture(t);
  for (const body of [[], null, 23, 'hello']) {
    assert.equal((await request('/api/settings', post(body))).status, 400);
  }
  assert.equal((await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })).status, 400);
  assert.equal((await request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request('/api/settings', post({ value: 'x'.repeat(10_001) }))).status, 413);
  assert.deepEqual(calls, []);
});

test('initialization exposes state but defers mutations', async (t) => {
  const { request, calls } = await fixture(t, { runtime: () => ({ initializing: true }) });
  assert.equal((await request('/api/state')).status, 200);
  assert.equal((await request('/api/settings', post({}))).status, 503);
  assert.deepEqual(calls, []);
});
