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
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
// See lib/supabase.js for why this is required on Node < 22.
const ws = require('ws');

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

const DEMO_EMAIL = 'planner@demo.test';
const DEMO_PASSWORD = 'demo1234';

async function main() {
  console.log('Seeding demo data…');

  let plannerId;
  const { data: existingProfile } = await db.from('planner_profiles').select('*').eq('email', DEMO_EMAIL).maybeSingle();
  if (existingProfile) {
    console.log('Demo planner already exists — reusing it.');
    plannerId = existingProfile.id;
  } else {
    const { data: created, error } = await db.auth.admin.createUser({ email: DEMO_EMAIL, password: DEMO_PASSWORD, email_confirm: true });
    if (error) throw error;
    plannerId = created.user.id;
    const { count } = await db.from('planner_profiles').select('id', { count: 'exact', head: true });
    await db.from('planner_profiles').insert({ id: plannerId, email: DEMO_EMAIL, name: 'Amina (Demo Planner)', is_admin: (count || 0) === 0 });
    console.log('Created demo planner:', DEMO_EMAIL, '/', DEMO_PASSWORD);
  }

  const { data: existingWedding } = await db.from('weddings').select('*').eq('couple_site_slug', 'zawadi-and-kevin-demo').maybeSingle();
  if (existingWedding) {
    console.log('Demo wedding already exists — nothing more to do.');
    console.log(`Couple companion site: /couple/zawadi-and-kevin-demo`);
    return;
  }

  const { data: wedding, error: wErr } = await db.from('weddings').insert({
    couple_names: 'Zawadi & Kevin',
    event_date: '2026-12-12',
    venue: 'Hillside Gardens, Karen, Nairobi',
    rsvp_cutoff: '2026-11-20',
    automation_enabled: true,
    couple_site_enabled: true,
    seating_enabled: true,
    checkin_enabled: false,
    reminder_interval_days: 7,
    max_reminders: 3,
    seat_granularity: 'table_and_seat',
    theme: { primary: '#3c4f3e', accent: '#b8935a', font_pairing: 'alexbrush_plusjakarta' },
    couple_site_slug: 'zawadi-and-kevin-demo',
  }).select().single();
  if (wErr) throw wErr;

  await db.from('wedding_members').insert({ wedding_id: wedding.id, user_id: plannerId, role: 'owner' });
  await db.from('couple_site_access').insert({ wedding_id: wedding.id, access_code: 'AMBER-2026' });

  const names = [
    ['Wanjiru Kamau', '+254712000021', 'family'], ['David Otieno', '+254712000032', 'friend'],
    ['Grace Mwangi', '+254712000043', 'family'], ['Brian Kiptoo', '+254712000054', 'friend'],
    ['Fatuma Ali', '+254712000065', 'side_bride'], ['James Mutua', '+254712000076', 'side_groom'],
    ['Njeri Wambui', null, 'family'], ['Peter Njoroge', '+254712000098', 'friend'],
  ];
  const { data: guests, error: gErr } = await db.from('guests').insert(
    names.map(([full_name, phone_number, category]) => ({ wedding_id: wedding.id, full_name, phone_number, category }))
  ).select();
  if (gErr) throw gErr;

  await db.from('guests').update({ status: 'confirmed' }).eq('id', guests[0].id);
  await db.from('guests').update({ status: 'confirmed' }).eq('id', guests[2].id);
  await db.from('guests').update({ status: 'unconfirmed' }).eq('id', guests[3].id);

  const { data: tables } = await db.from('tables').insert([
    { wedding_id: wedding.id, table_number: 1, seat_count: 8 },
    { wedding_id: wedding.id, table_number: 2, seat_count: 8 },
  ]).select();
  await db.from('seat_assignments').insert({ wedding_id: wedding.id, guest_id: guests[0].id, table_id: tables[0].id, seat_number: 1, assigned_by: 'planner' });

  console.log('Done. Log in at /planner.html with', DEMO_EMAIL, '/', DEMO_PASSWORD);
  console.log('Couple companion site: /couple/zawadi-and-kevin-demo  (passcode AMBER-2026)');
}

main().catch((e) => { console.error(e); process.exit(1); });
