import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const STATIC = {
  '/': ['ui.html', 'text/html; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.png': ['icon.png', 'image/png'],
};

export function startServer(checker, { host = '127.0.0.1', port = 4321, log = () => {}, onSettingsChanged,
  runtime = () => ({}), allowedHosts = [] }) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', host, ...allowedHosts]);
  const snapshot = () => ({ ...checker.snapshot(), ...runtime() });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const base = new URL(`http://${req.headers.host}`);
      if (!hosts.has(base.hostname)) return json(res, { error: 'Host is not allowed' }, 403);
      const url = new URL(req.url, base);
      if (url.origin !== base.origin) return json(res, { error: 'Invalid request URL' }, 400);
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' ||
          (origin && !sameOriginHost(origin, base.host))) {
          return json(res, { error: 'Cross-origin requests are not allowed' }, 403);
        }
        if (runtime().initializing) return json(res, { error: 'Loading the Apple catalog. Try again in a moment.' }, 503);
      }
      const file = req.method === 'GET' && STATIC[url.pathname];
      if (file) {
        const contents = await readFile(new URL(`./${file[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': file[1] });
        return res.end(contents);
      }
      // Consume every API POST body, including otherwise body-less action endpoints,
      // so large requests and non-JSON form posts never reach a mutation.
      const body = req.method === 'POST' && url.pathname.startsWith('/api/') ? await readJson(req) : null;
      const push = checker.push;
      if (push && url.pathname.startsWith('/api/push/')) {
        if (req.method === 'GET' && url.pathname === '/api/push/key') return json(res, { publicKey: push.publicKey });
        if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
          await push.add(body);
          return json(res, { devices: push.size });
        }
        if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
          await push.remove(body.endpoint);
          return json(res, { devices: push.size });
        }
        if (req.method === 'POST' && url.pathname === '/api/push/test') {
          await push.send({ subject: 'Notifications are on', text: 'You’ll get an alert here when it’s in stock.', url: '/' });
          return json(res, { devices: push.size });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/ntfy/test') {
        await checker.testNotifier('ntfy');
        return json(res, {});
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, snapshot());
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const changed = await checker.updateSettings(body);
        if (changed) onSettingsChanged?.();
        return json(res, snapshot());
      }
      if (req.method === 'POST' && url.pathname === '/api/check') {
        onSettingsChanged?.();
        return json(res, { ...snapshot(), checking: true });
      }
      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      json(res, { error: err.message }, err.statusCode || 400);
    }
  });
  server.listen(port, host, () => log(`ui on http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`));
  return server;
}

function sameOriginHost(origin, host) {
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === host;
  } catch {
    return false;
  }
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function readJson(req) {
  if (Number(req.headers['content-length']) > 10_000) throw requestError('Body too large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw requestError('Body too large', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw requestError('Use application/json for request bodies', 415);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw requestError('Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError('Expected a JSON object', 400);
  return body;
}
