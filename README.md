# Callsheet — Wedding Guest, RSVP & Seating System (Netlify + Supabase)

The production-ready version of the system in `PRD_wedding_guest_rsvp_seating_system.md`
and `ARCHITECTURE_wedding_guest_rsvp_seating_system.md`: real Supabase Auth for planners,
Postgres persistence, Realtime live-sync, and Netlify Functions/Scheduled Functions,
deployable as-is.

**→ See `README-DEPLOY.md` for the step-by-step Supabase + Netlify deployment
procedure, and the "WhatsApp automation" section for connecting real
WhatsApp/SMS sending (Meta app setup, message templates, webhook, env vars).**

If you want to click through the system locally first without setting up
Supabase, the companion zero-dependency build (plain Node.js, JSON-file
storage) runs with just `npm install && npm start` — ask for it again if you
don't still have it, or use this one with `netlify dev` once Supabase is
connected (see README-DEPLOY.md step 4 onward).

## What's here

| Module | Where | Key requirements |
|---|---|---|
| Guest List & Status Tracking (always on) | Guest list tab | FR1–FR4, offline-first (NFR11) |
| Import from document/photo | Import list tab | FR1.1–FR1.6 |
| Automated Invite & Reminder Sending | Invites & messages tab + scheduled function | FR5–FR10, NFR2, NFR6 — real WhatsApp Cloud API + SMS fallback, auto-falls back to demo mode without credentials |
| Seating & Table Arrangement | Seating tab — list view or a visual floor plan (upload the venue's own layout, place/reserve round or rectangular tables, label the dance floor/entrance/head table) | FR19–FR23 |
| Couple Companion Site | `/couple/:slug`, bespoke-themed | FR29a–FR29e, FR30, NFR9 |
| Event-Day Check-In | Check-in tab | FR31–FR34 |
| Wedding setup & modules | Settings tab | FR0.1–FR0.6 |
| Admin cross-wedding view | "Admin overview" nav | FR35–FR37 |

## Architecture at a glance

```
Browser (planner.html / couple.html)
   │ fetch('/api/...')                    │ Realtime Broadcast (anon key)
   ▼                                       ▼
Netlify redirect /api/* ──► netlify/functions/api.js (one catch-all function)
   │                                       ▲
   ▼                                       │ pingWedding() after every mutation
routes/*.js  (business logic, same shape   │
as the local demo — module gating, offline lib/broadcast.js
sync batch, RLS-equivalent scoping)
   │
   ▼
lib/supabase.js → Supabase Postgres (service_role key, server-side only)
```

Every route file matches the local zero-dependency demo's structure closely
on purpose — if you've already read that codebase, this one should feel
immediately familiar; only the data-access calls changed from synchronous
JSON-array operations to `await supabase.from(...)`.

## Design notes

The planner console ("Callsheet") and the couple companion site are two
deliberately different visual languages: the planner side is a typed
production-office run sheet (kraft/charcoal tones, monospace headers, ledger
tick-boxes standing in for status pills, a brass accent), and the couple
site is wedding stationery (ivory cardstock, botanical ink, a brass foil
accent, a pressed wax-seal mark for confirmed guests) — themeable per
wedding via a curated color + Google Font picker (NFR9), never a code
change. Neither reaches for the cream-background-plus-terracotta-accent
combination that shows up on most AI-generated wedding pages regardless of
brief, or the dark-dashboard-with-one-bright-accent look most AI-generated
consoles default to — see the comments at the top of `public/styles.css` and
`public/couple.css` for the reasoning behind each choice.

## Repo layout

See the tree in `README-DEPLOY.md`, or just:

```
schema/schema.sql            Run this once in Supabase SQL Editor
lib/                          Supabase client, auth, access scoping, broadcast
routes/                       One file per module — same shape as PRD §3
netlify/functions/api.js      Catch-all Netlify Function (routes every /api/*)
netlify/functions/cron-reminders.js   Scheduled function (see netlify.toml)
public/                       Planner dashboard + couple companion site
scripts/seed-demo.js           One-time demo data (optional)
scripts/generate-config.js     Build step — writes public/config.js
```
