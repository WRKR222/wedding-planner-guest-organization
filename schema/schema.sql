-- ============================================================
-- Wedding Guest, RSVP & Seating System — v3 Supabase schema
-- Matches ARCHITECTURE_wedding_guest_rsvp_seating_system.md §3
-- and the modular design in PRD §3.
--
-- Run this once in Supabase Studio → SQL Editor on a fresh project.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Planner accounts — Supabase Auth (auth.users) holds the actual
-- credential; this table holds the profile fields the app needs
-- (display name, super-admin flag) that auth.users doesn't.
-- ------------------------------------------------------------
create table if not exists planner_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  is_admin boolean default false,
  created_at timestamptz default now()
);

-- One row per wedding — carries module config, lifecycle, and branding.
create table if not exists weddings (
  id uuid primary key default gen_random_uuid(),
  couple_names text not null,
  event_date date not null,
  venue text,
  rsvp_cutoff date not null,

  wedding_status text check (wedding_status in ('active','postponed','cancelled')) default 'active',

  -- module flags (planner-controlled). Guest List itself is not a
  -- flag — it's the always-on foundation every wedding uses.
  automation_enabled boolean default false,
  couple_site_enabled boolean default false,
  seating_enabled boolean default false,
  checkin_enabled boolean default false,

  reminder_interval_days int default 21,
  max_reminders int,                       -- null = unlimited (until cutoff)

  seat_granularity text check (seat_granularity in ('table_only','seat_only','table_and_seat')) default 'table_and_seat',
  invite_template text default 'Hi {guest_name}! {couple_names} would love for you to join their wedding on {date} at {venue}. Confirm your attendance by {deadline}. Reply YES/NO, or call {contact_phone} to confirm by voice.',

  theme jsonb default '{"primary":"#3c4f3e","accent":"#b8935a","font_pairing":"alexbrush_plusjakarta"}'::jsonb,
  couple_site_slug text unique,

  seating_locked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Who can manage a wedding as a planner-level user.
create table if not exists wedding_members (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text check (role in ('owner','planner')) default 'owner',
  created_at timestamptz default now(),
  unique (wedding_id, user_id)
);

-- Separate, lower-trust access record for the couple companion site.
-- Deliberately not the same mechanism as planner auth,
-- so a leaked passcode can never reach planner-level access or any other
-- wedding's data.
create table if not exists couple_site_access (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade unique,
  access_code text not null,
  revoked boolean default false,
  created_at timestamptz default now(),
  last_used_at timestamptz
);

-- Couple-site sessions issued after a correct passcode. Short-lived opaque
-- tokens, checked server-side on every couple-site request.
create table if not exists couple_sessions (
  token text primary key,
  wedding_id uuid references weddings(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

-- Guests. phone_number is nullable — a names-only paper import is
-- valid. updated_at + is_deleted + client_generated_id support the
-- offline-first sync model (architecture §7).
create table if not exists guests (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  full_name text not null,
  phone_number text,
  category text,
  is_plus_one boolean default false,
  linked_guest_id uuid references guests(id),
  status text check (status in ('invited','confirmed','unconfirmed','declined','no_response')) default 'invited',
  invite_channel text,
  invite_sent_at timestamptz,
  last_reminder_at timestamptz,
  reminder_count int default 0,
  checked_in_at timestamptz,
  checked_in_by text,
  import_batch_id uuid,
  client_generated_id text,
  updated_at timestamptz default now(),
  is_deleted boolean default false,
  deleted_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_guests_wedding_active on guests(wedding_id) where is_deleted = false;
-- lets a retried offline-queue flush upsert instead of double-inserting
create unique index if not exists uq_guest_client_id on guests(wedding_id, client_generated_id) where client_generated_id is not null;

-- Full audit trail of every status change.
create table if not exists rsvp_status_history (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid references guests(id) on delete cascade,
  old_status text,
  new_status text,
  changed_by text, -- 'planner' | 'couple_site' | 'planner_phone_call' | 'couple_phone_call' | 'guest_whatsapp' | 'system'
  changed_at timestamptz default now()
);

-- Venue layout. Extended with a real spatial position so a table
-- can be placed on a floor plan the way a planner would actually sketch one
-- (round vs rectangular, positioned relative to the head table/dance floor/
-- entrance) — not just an abstract numbered card.
create table if not exists tables (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  table_number int not null,
  seat_count int,
  shape text check (shape in ('round','rectangle')) default 'round',
  pos_x numeric,       -- percentage (0-100) across the floor plan canvas; null = not yet placed
  pos_y numeric,       -- percentage (0-100) down the floor plan canvas
  width numeric,        -- canvas units; diameter for round, width for rectangle
  height numeric,         -- canvas units; ignored for round, height for rectangle
  reserved_for text        -- e.g. "Family", "Bride's side", "VIP" — a label/hint, not an enforced rule
);

-- The floor plan itself: an optional uploaded reference image (the venue's
-- own layout diagram, or a photo of a hand-drawn sketch) that table markers
-- are positioned on top of, plus the canvas dimensions the pos_x/pos_y
-- percentages above are relative to.
create table if not exists venue_layouts (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade unique,
  background_image_url text,
  canvas_width int default 1000,
  canvas_height int default 700,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Non-seatable landmarks placed on the same floor plan for orientation —
-- "Dance Floor", "Head Table", "Entrance", "Bar", "Stage" — matching what a
-- planner would actually sketch on a venue diagram (see the reference photo
-- this feature was built from: an arch labeled "Head table", a "Dance
-- Floor" box, and "Entrance" at the bottom of a hand-drawn table grid).
create table if not exists layout_markers (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  label text not null,
  icon text check (icon in ('dance_floor','head_table','entrance','stage','bar','custom')) default 'custom',
  pos_x numeric not null,
  pos_y numeric not null,
  width numeric default 14,
  height numeric default 8,
  created_at timestamptz default now()
);

-- No requirement that the guest be 'confirmed' before seating — any
-- guest_id valid for the wedding may be seated.
create table if not exists seat_assignments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  guest_id uuid references guests(id) on delete cascade,
  table_id uuid references tables(id) on delete set null,
  seat_number int,
  assigned_by text,
  assigned_at timestamptz default now(),
  unique (guest_id)
);

-- Message delivery log — only populated for weddings with automation_enabled.
create table if not exists message_log (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid references guests(id) on delete cascade,
  message_type text,     -- 'invite' | 'reminder'
  channel text,           -- 'whatsapp' | 'sms'
  status text,             -- 'sent' | 'failed'
  provider_message_id text,
  sent_at timestamptz default now()
);

-- Staging area for document/photo guest-list imports. A
-- batch always starts here and only becomes real guests rows once the
-- planner reviews and confirms it.
create table if not exists guest_import_batches (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  source_type text check (source_type in ('csv','xlsx','docx','txt','pdf_text','pdf_scanned','image')),
  original_filename text,
  status text check (status in ('processing','ready_for_review','confirmed','discarded','failed')) default 'processing',
  parsed_rows jsonb,
  error_message text,
  uploaded_by text,  -- 'planner' | 'couple_site'
  created_at timestamptz default now(),
  confirmed_at timestamptz
);

-- ============================================================
-- Row-Level Security — enabled as a hard backstop on every table.
--
-- Deliberately NO permissive policies are added. Every read and write in
-- this app goes through Netlify Functions using the service_role key
-- (server-side only, never shipped to the browser — see netlify/functions/
-- api.js), which bypasses RLS by design. Enabling RLS with zero policies
-- means the anon and authenticated keys — the only keys ever present in
-- the browser — cannot read or write ANY row directly, even if a Supabase
-- URL/anon key were somehow exposed or misused. This is intentionally
-- stricter than the per-wedding policies in the original starter schema,
-- because this app never queries Postgres directly from the browser (live
-- sync uses Realtime Broadcast channels, not table subscriptions — see
-- README-DEPLOY.md "Why Broadcast, not Realtime table subscriptions").
-- ============================================================
alter table planner_profiles enable row level security;
alter table weddings enable row level security;
alter table wedding_members enable row level security;
alter table couple_site_access enable row level security;
alter table couple_sessions enable row level security;
alter table guests enable row level security;
alter table rsvp_status_history enable row level security;
alter table tables enable row level security;
alter table venue_layouts enable row level security;
alter table layout_markers enable row level security;
alter table seat_assignments enable row level security;
alter table message_log enable row level security;
alter table guest_import_batches enable row level security;

-- ============================================================
-- Housekeeping: keep weddings.updated_at current automatically.
-- ============================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_weddings_updated_at on weddings;
create trigger trg_weddings_updated_at
  before update on weddings
  for each row execute function set_updated_at();

-- ============================================================
-- Storage bucket for uploaded venue floor-plan reference images
-- (routes/venue.js uploads here via the service_role key; public:true
-- means the resulting image URL is directly viewable in <img src="...">
-- on both the planner console and the couple site without needing a
-- signed-URL round trip — the same public-read tradeoff already made for
-- guest-list import files, appropriate here since a venue floor plan isn't
-- sensitive guest data).
-- ============================================================
insert into storage.buckets (id, name, public)
values ('venue-layouts', 'venue-layouts', true)
on conflict (id) do nothing;

-- ============================================================
-- Migration note: if you ran an earlier version of this schema that only
-- had ('invited','confirmed','unconfirmed','no_response'), run this once
-- to add the 'declined' status (needed so a guest's explicit "No" reply
-- via WhatsApp can be recorded distinctly from silence):
--
--   alter table guests drop constraint guests_status_check;
--   alter table guests add constraint guests_status_check
--     check (status in ('invited','confirmed','unconfirmed','declined','no_response'));
-- ============================================================

-- ============================================================
-- Migration note: if your `tables` table predates the venue floor-plan
-- feature, run this once to add the new columns (existing rows get
-- shape='round' and no position — they'll show up in the "unplaced"
-- list in the floor plan view until dragged onto the canvas):
--
--   alter table tables add column if not exists shape text check (shape in ('round','rectangle')) default 'round';
--   alter table tables add column if not exists pos_x numeric;
--   alter table tables add column if not exists pos_y numeric;
--   alter table tables add column if not exists width numeric;
--   alter table tables add column if not exists height numeric;
--   alter table tables add column if not exists reserved_for text;
--
-- Then create the two new tables (venue_layouts, layout_markers) and the
-- storage bucket by re-running the `create table if not exists` and
-- `insert into storage.buckets` statements above — both are safe to re-run.
-- ============================================================
