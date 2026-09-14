// netlify/functions/api.js
//
// One Netlify Function handles every /api/* route (see netlify.toml's
// redirect). This keeps the route files identical in spirit to a normal
// Express app — same router, same handler signature — while adapting
// Netlify's (event, context) => response contract to the plain
// (req, res, params, body, query) shape lib/router.js expects.
const Router = require('../../lib/router');

const router = new Router();
require('../../routes/auth').register(router);
require('../../routes/weddings').register(router);
require('../../routes/couple').register(router);
require('../../routes/guests').register(router);
require('../../routes/seating').register(router);
require('../../routes/checkin').register(router);
require('../../routes/invites').register(router);
require('../../routes/import').register(router);
require('../../routes/venue').register(router);
require('../../routes/assistant').register(router);

function resolvePathname(event) {
  let p = event.path || '/';
  const marker = '/.netlify/functions/api';
  if (p.startsWith(marker)) {
    p = p.slice(marker.length) || '/';
    if (!p.startsWith('/')) p = '/' + p;
    return '/api' + (p === '/' ? '' : p);
  }
  if (p.startsWith('/api/') || p === '/api') return p;
  return '/api/' + p.replace(/^\/+/, '');
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: '',
    };
  }

  const pathname = resolvePathname(event);
  const match = router.match(event.httpMethod, pathname);
  if (!match) return { statusCode: 404, body: JSON.stringify({ error: 'Not found', pathname }) };

  // A tiny req/res shim so route handlers (written the same way as the
  // local zero-dependency demo) don't need to know they're running in a
  // Lambda-style environment.
  const req = { headers: {} };
  Object.entries(event.headers || {}).forEach(([k, v]) => { req.headers[k.toLowerCase()] = v; });

  let statusCode = 200, responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, responseBody = '';
  const res = {
    writeHead(status, headers) { statusCode = status; Object.assign(responseHeaders, headers || {}); },
    end(body) { responseBody = body || ''; },
  };

  const query = event.queryStringParameters || {};
  const body = (event.httpMethod === 'POST' || event.httpMethod === 'PATCH') ? parseBody(event) : {};

  try {
    await match.handler(req, res, match.params, body, query);
  } catch (e) {
    console.error(e);
    statusCode = 500;
    responseBody = JSON.stringify({ error: e.message || 'Internal server error' });
  }

  return { statusCode, headers: responseHeaders, body: responseBody };
};
