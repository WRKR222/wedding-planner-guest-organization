// lib/supabase.js
// Server-side only. The service_role key must NEVER reach the browser —
// it bypasses Row Level Security entirely, which is exactly why RLS is
// enabled-with-no-policies in schema.sql: every table is reachable ONLY
// from here, not from anon/authenticated keys in the browser.
const { createClient } = require('@supabase/supabase-js');

let adminClient = null;
function admin() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables');
  }
  adminClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
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
  anonClient = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return anonClient;
}

module.exports = { admin, anon };
