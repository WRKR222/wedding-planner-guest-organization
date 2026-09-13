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

| Module | Where | Notes |
|---|---|---|
| Guest List & Status Tracking (always on) | Guest list tab | Offline-first — writes queue locally and sync once back online |
| Import from document/photo | Import list tab | Nothing is added until the planner reviews and confirms the parsed rows |
| Automated Invite & Reminder Sending | Invites & messages tab + scheduled function | Real WhatsApp Cloud API + SMS fallback, auto-falls back to demo mode without credentials |
| Seating & Table Arrangement | Seating tab — list view or a visual floor plan (upload the venue's own layout, place/reserve round or rectangular tables, label the dance floor/entrance/head table) | A guest can be assigned to a table without a specific seat number |
| Couple Companion Site | `/couple/:slug`, bespoke-themed | Curated color + Google Font picker per wedding, never a code change |
| Event-Day Check-In | Check-in tab | |
| Wedding setup & modules | Settings tab | |
| Admin cross-wedding view | Separate `/admin.html` — not part of a planner's own nav | Support & billing visibility across every planner/wedding, for the system owner only |

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

The planner console ("Callsheet") and the couple companion site share one
fixed visual language — a warm-charcoal surface with a brass accent and an
Alex Brush / Plus Jakarta Sans font pairing, with no separate dark/light
mode — so a planner moving between their own dashboard and a couple's
companion site sees one consistent product. Cursive stays reserved for the
couple's own name and each app's main titles; body text and guest names
use the plain sans-serif for readability. On top of that shared chrome,
each wedding still gets its own bespoke primary/accent color and Google
Font pairing on the couple site, picked from a curated list — never a code
change. See the comments at the top of `public/styles.css` and
`public/couple.css` for the reasoning behind the choices.

## Repo layout

See the tree in `README-DEPLOY.md`, or just:

```
schema/schema.sql            Run this once in Supabase SQL Editor
lib/                          Supabase client, auth, access scoping, broadcast
routes/                       One file per module
netlify/functions/api.js      Catch-all Netlify Function (routes every /api/*)
netlify/functions/cron-reminders.js   Scheduled function (see netlify.toml)
public/                       Planner dashboard + couple companion site
scripts/seed-demo.js           One-time demo data (optional)
scripts/generate-config.js     Build step — writes public/config.js
```
