// lib/supabase.js
// Server-side only. The service_role key must NEVER reach the browser —
// it bypasses Row Level Security entirely, which is exactly why RLS is
// enabled-with-no-policies in schema.sql: every table is reachable ONLY
// from here, not from anon/authenticated keys in the browser.
const { createClient } = require('@supabase/supabase-js');
// @supabase/realtime-js (pulled in by supabase-js) always constructs a
// RealtimeClient when createClient() runs, even though this file never
// opens a realtime connection (see broadcast.js for the only place that
// does, in the browser). On Node < 22 there's no native WebSocket global,
// so that constructor throws immediately unless we hand it one explicitly.
// Netlify's function runtime isn't guaranteed to be Node 22, so this must
// be fixed here rather than by assuming a newer Node version.
const ws = require('ws');

// Turns whatever cryptic "Invalid URL" / "invalid path" error the
// supabase-js client throws for a malformed SUPABASE_URL into something a
// planner setting up a fresh deploy can actually act on. The most common
// mistake is pasting the Supabase Studio dashboard link (which has a
// /project/xxxx path) instead of the Project URL from Settings → API.
function assertValidSupabaseUrl(url, varName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(
      `${varName} ("${url}") is not a valid URL. In Supabase Studio, go to Project Settings → API and copy the ` +
      `"Project URL" value exactly (it looks like https://xxxxxxxx.supabase.co, no trailing slash or extra path), ` +
      `then update it in Netlify → Site configuration → Environment variables and redeploy.`
    );
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.pathname.replace(/\/$/, '') !== '') {
    throw new Error(
      `${varName} ("${url}") doesn't look like a Supabase Project URL — it should be just ` +
      `"https://xxxxxxxx.supabase.co" with no extra path (a common mistake is pasting the Studio dashboard link ` +
      `instead of the Project URL from Settings → API). Fix it in Netlify → Site configuration → Environment ` +
      `variables and redeploy.`
    );
  }
}

let adminClient = null;
function admin() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables');
  }
  assertValidSupabaseUrl(url, 'SUPABASE_URL');
  adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
  });
  return adminClient;
}

// A lightweight client using the anon key, used ONLY to verify a planner's
// JWT (supabase.auth.getUser(token)) — never to read/write tables.
let anonClient = null;
function anon() {
  if (anonClient) return anonClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  assertValidSupabaseUrl(url, 'SUPABASE_URL');
  anonClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
  });
  return anonClient;
}

module.exports = { admin, anon };
