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

let adminClient = null;
function admin() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables');
  }
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
  anonClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws },
  });
  return anonClient;
}

module.exports = { admin, anon };
