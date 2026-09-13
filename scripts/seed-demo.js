// scripts/seed-demo.js
//
// Creates one demo planner account and one fully-populated demo wedding,
// so a freshly deployed site has something to click through immediately —
// the same "Zawadi & Kevin" demo used in the local zero-dependency build.
// Safe to run more than once (checks for the demo account first).
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-demo.js
//
// (Both values are in Supabase Studio → Project Settings → API. Use the
// service_role key here, never the anon key — this script needs to bypass
// RLS to write the seed data.)
//
// Note: the running app can also do this itself — if the sign-in screen's
// demo login fails on a fresh deploy, it offers a "Set up the demo account
// now" link that calls the same logic via POST /api/auth/seed-demo, so this
// script is a convenience for local/CI use, not the only way to seed.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
// See lib/supabase.js for why this is required on Node < 22.
const ws = require('ws');
const { seedDemo, DEMO_EMAIL, DEMO_PASSWORD } = require('../lib/seed-demo');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the comment at the top of this file) and re-run.');
  process.exit(1);
}
const db = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: ws },
});

async function main() {
  console.log('Seeding demo data…');
  const result = await seedDemo(db);
  if (!result.created) {
    console.log('Demo planner and wedding already exist — nothing more to do.');
  } else {
    console.log('Created demo planner:', DEMO_EMAIL, '/', DEMO_PASSWORD);
  }
  console.log(`Log in at /planner.html with ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log('Couple companion site: /couple/zawadi-and-kevin-demo  (passcode AMBER-2026)');
}

main().catch((e) => { console.error(e); process.exit(1); });
