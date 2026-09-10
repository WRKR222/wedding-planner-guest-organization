-- ============================================================
-- Wedding Guest, RSVP & Seating System — Supabase schema
-- Matches ARCHITECTURE_wedding_guest_rsvp_seating_system.md §3
-- Run this in the Supabase SQL editor on a fresh project.
-- ============================================================

create extension if not exists "pgcrypto";

-- One row per wedding event
create table if not exists weddings (
  id uuid primary key default gen_random_uuid(),
  couple_names text not null,
  event_date date not null,
  venue text,
  rsvp_cutoff date not null,
  reminder_interval_days int default 21,
  seat_granularity text check (seat_granularity in ('table_only','seat_only','table_and_seat')) default 'table_and_seat',
  invite_template text,
  created_at timestamptz default now()
);

-- Who can manage a wedding (couple + planner + co-owners) — FR23/FR28
create table if not exists wedding_members (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text check (role in ('owner','planner')) default 'owner',
  created_at timestamptz default now(),
  unique (wedding_id, user_id)
);

-- Guests
create table if not exists guests (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  full_name text not null,
  phone_number text not null,
  category text,
  is_plus_one boolean default false,
  linked_guest_id uuid references guests(id),
  status text check (status in ('invited','confirmed','unconfirmed','no_response')) default 'invited',
  invite_channel text,
  invite_sent_at timestamptz,
  last_reminder_at timestamptz,
  ticket_number int,
  created_at timestamptz default now()
);
create index if not exists idx_guests_wedding on guests(wedding_id);
create unique index if not exists uq_guest_ticket_per_wedding on guests(wedding_id, ticket_number) where ticket_number is not null;

-- Full audit trail of every status change — FR13, NFR4
create table if not exists rsvp_status_history (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid references guests(id) on delete cascade,
  old_status text,
  new_status text,
  changed_by text, -- 'guest_whatsapp' | 'guest_call' | 'couple' | 'planner' | 'system'
  changed_at timestamptz default now()
);

-- Venue layout
create table if not exists tables (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  table_number int not null,
  seat_count int
);

create table if not exists seat_assignments (
  id uuid primary key default gen_random_uuid(),
  wedding_id uuid references weddings(id) on delete cascade,
  guest_id uuid references guests(id) on delete cascade,
  table_id uuid references tables(id),
  seat_number int,
  assigned_by text,
  assigned_at timestamptz default now(),
  unique (guest_id)
);

-- Message delivery log — NFR2 cost tracking, FR8
create table if not exists message_log (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid references guests(id) on delete cascade,
  message_type text, -- 'invite' | 'reminder' | 'ticket'
  channel text,       -- 'whatsapp' | 'sms'
  status text,        -- 'sent' | 'delivered' | 'failed'
  provider_message_id text,
  sent_at timestamptz default now()
);

-- ============================================================
-- Atomic ticket numbering (NFR1) — same pattern as claim_next_invite()
-- Call this from ticket-generate.js inside a transaction, per guest.
-- ============================================================
create or replace function next_ticket_number(p_wedding_id uuid)
returns int
language plpgsql
as $$
declare
  v_next int;
begin
  select coalesce(max(ticket_number), 0) + 1 into v_next
  from guests
  where wedding_id = p_wedding_id
  for update;

  return v_next;
end;
$$;

-- ============================================================
-- Row-Level Security — per-wedding data isolation (NFR3)
-- ============================================================
alter table weddings enable row level security;
alter table wedding_members enable row level security;
alter table guests enable row level security;
alter table rsvp_status_history enable row level security;
alter table tables enable row level security;
alter table seat_assignments enable row level security;
alter table message_log enable row level security;

create policy "members see their weddings" on weddings
  for select using (
    id in (select wedding_id from wedding_members where user_id = auth.uid())
  );

create policy "members manage their guests" on guests
  for all using (
    wedding_id in (select wedding_id from wedding_members where user_id = auth.uid())
  );

create policy "members manage their tables" on tables
  for all using (
    wedding_id in (select wedding_id from wedding_members where user_id = auth.uid())
  );

create policy "members manage their seat assignments" on seat_assignments
  for all using (
    wedding_id in (select wedding_id from wedding_members where user_id = auth.uid())
  );

-- NOTE: super-admin (system owner, FR29) should use the Supabase
-- service_role key from within Netlify Functions only — never
-- expose service_role to the browser. That role bypasses RLS.
