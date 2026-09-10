# Deploying Callsheet to Supabase + Netlify

This is the real deployment procedure — follow it top to bottom for a fresh
project. Everything here has been logic-tested against a full mock of the
Supabase client (27 scenarios: auth, every module, offline sync, RLS-style
scoping, the scheduled reminder sweep) — see "How this was tested" at the
bottom. It has not been run against a live Supabase project from this
environment, since this sandbox has no outbound network access — you're the
first live run, so budget 20–30 minutes and read each step before running it.

## 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) → New project. Pick a region
   close to your guests/planners.
2. Once it's provisioned, open **Project Settings → API** and note down three
   values — you'll need all three in step 4:
   - **Project URL** (`SUPABASE_URL`)
   - **anon / public key** (`SUPABASE_ANON_KEY`) — safe to ship to the browser
   - **service_role key** (`SUPABASE_SERVICE_ROLE_KEY`) — **secret, server-only, never put this in Netlify's "public" build settings or in any frontend file**

## 2. Run the schema

1. Open **SQL Editor** in Supabase Studio.
2. Paste in the entire contents of `schema/schema.sql` from this repo and run it.
3. You should see 13 new tables (`weddings`, `guests`, `seat_assignments`,
   `venue_layouts`, `layout_markers`, etc.) under **Table Editor**, all with
   a "RLS enabled" badge, plus a `venue-layouts` bucket under **Storage**
   (public — this is where uploaded venue floor-plan images live).

Read the comment block near the bottom of `schema.sql` if you're wondering
why there are no `CREATE POLICY` statements — it's intentional (see
"Why Broadcast, not Realtime table subscriptions" below for the same
reasoning applied to live sync).

## 3. Push the code to a Git repo

Netlify deploys from a Git repository (GitHub/GitLab/Bitbucket).

```bash
cd wedding-app-netlify
git init
git add .
git commit -m "Initial deploy"
git remote add origin <your-empty-repo-url>
git push -u origin main
```

## 4. Connect the repo to Netlify

1. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → pick your repo.
2. Build settings are already declared in `netlify.toml` (publish `public`,
   functions `netlify/functions`, build command runs `scripts/generate-config.js`)
   — you shouldn't need to change anything in the UI here.
3. Before the first deploy, go to **Site configuration → Environment variables**
   and add:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | from step 1 |
   | `SUPABASE_ANON_KEY` | from step 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 1 — **mark it "sensitive"/server-only if Netlify offers that toggle** |
   | `PLANNER_FALLBACK_PHONE` | optional — the phone number templated into every invite message as the voice-call fallback (FR8.1) |

4. Deploy. The build runs `scripts/generate-config.js`, which writes
   `public/config.js` from `SUPABASE_URL`/`SUPABASE_ANON_KEY` — this is what
   lets the browser open a Realtime connection directly (see below).
   `SUPABASE_SERVICE_ROLE_KEY` is never touched by that script; it only ever
   loads inside `netlify/functions/*.js`, which run server-side.

## 5. Seed a demo wedding (optional, recommended for a demo)

Run this once from your own machine, against your live project:

```bash
npm install
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ... node scripts/seed-demo.js
```

This creates the same "Zawadi & Kevin" demo wedding as the local
zero-dependency build: a planner login (`planner@demo.test` / `demo1234`),
8 guests in a mix of RSVP states, 2 tables with one guest seated, and a
couple companion site at `/couple/zawadi-and-kevin-demo` (passcode
`AMBER-2026`). Safe to re-run — it detects the existing demo account/wedding
and skips.

For your own real weddings, just sign up a real planner account at
`/planner.html` and click "+ New wedding" — no script needed.

## 6. Smoke-test the live deployment

1. Visit `https://<your-site>.netlify.app/planner.html`, sign up or log in.
2. Create a wedding, add a guest, toggle a module. If anything 404s, check
   **Netlify → Functions → api** logs — the most common first-deploy issue is
   a typo'd environment variable (function logs will show a Supabase auth
   error immediately).
3. Open the couple link in a second browser/incognito window and confirm a
   guest edit shows up on the planner's screen within a few seconds without
   refreshing — that's Realtime Broadcast working (see below). If it doesn't
   appear within ~15 seconds, `public/config.js` likely wasn't generated
   correctly — check the Netlify build log for the `[generate-config]` line.

## 7. Turn on the scheduled reminder sweep

Already configured in `netlify.toml` ([functions."cron-reminders"] schedule
= "@hourly") — Netlify picks this up automatically on deploy for accounts
with Scheduled Functions available (all plans as of this writing). Confirm
it's registered under **Netlify → Functions → cron-reminders** — it'll show
a "Scheduled" badge and next-run time.

---

## WhatsApp automation — connecting the real thing

The app ships with WhatsApp/SMS sending **already implemented for real**
(`lib/whatsapp.js`, `lib/sms.js`, `netlify/functions/whatsapp-webhook.js`) —
what's missing before it goes live is your own Meta credentials and two
approved message templates. Until you add those environment variables, the
app automatically falls back to a simulator so it's fully clickable as a
demo; the moment you set them, sending flips to real without touching code.
The planner's "Invites & messages" tab shows a banner telling you which mode
you're in.

### Why you can't just send plain text messages

WhatsApp's Cloud API only allows **free-form text** replies to a guest who
messaged your business number in the last 24 hours. An invite or a reminder
is *business-initiated* — the guest hasn't messaged you — so it must be sent
as a **pre-approved template message**, every time, no exceptions. This is a
WhatsApp platform rule, not something this app can work around.

### Step 1 — Create a Meta app and WhatsApp sender

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App** → choose **Business** as the app type.
2. Inside the app, add the **WhatsApp** product.
3. Meta gives you a **free test phone number** automatically — good enough for development. For a real launch, go to **WhatsApp → API Setup** and add your own business phone number instead (a number that isn't already active on personal WhatsApp).
4. From **WhatsApp → API Setup**, note down:
   - **Phone number ID**
   - **WhatsApp Business Account ID**
   - **Temporary access token** (24h — fine for testing). For production, create a **System User** under **Business Settings → Users → System Users**, generate a token for it with `whatsapp_business_messaging` permission, and set it to never expire.

### Step 2 — Create your two message templates

Go to **WhatsApp Manager → Message Templates → Create Template** and create
exactly these two (names must match what you put in your environment
variables in Step 4 — the defaults below match the code's defaults, so you
can skip the env vars if you use these names):

**Template 1 — `wedding_invite`** (category: Marketing or Utility, your call — see note below)
```
Hi {{1}}! {{2}} would love for you to join their wedding on {{3}} at {{4}}. Confirm your attendance by {{5}}, or call {{6}} to confirm by voice. Reply YES or NO.
```
Variables in order: guest name, couple names, date, venue, RSVP deadline, planner's fallback phone.

**Template 2 — `wedding_reminder`**
```
Hi {{1}}, just a friendly reminder — {{2}} still hasn't heard from you about their wedding on {{3}}. Reply YES or NO, or call {{4}} to confirm by voice.
```
Variables in order: guest name, couple names, date, planner's fallback phone.

Submit both for approval. Approval is usually minutes to a few hours for
straightforward templates like these, but can take longer — do this early.
*(A note on category: Meta classifies templates as Marketing, Utility, or
Authentication, each with different pricing/rate rules that change from time
to time — check Meta's current template category guidance when you submit,
since a wedding invite could reasonably be classified either way depending
on their latest rules.)*

### Step 3 — Register the webhook (for delivery receipts and YES/NO replies)

This is what lets a guest's WhatsApp reply of "YES" or "NO" automatically
update their RSVP status in the app — no planner action needed.

1. Deploy the app first (steps 1–7 above), so you have a live URL.
2. Pick a random secret string for `WHATSAPP_VERIFY_TOKEN` (anything — it's just used once, to prove you own the URL you're registering).
3. In your Meta app → **WhatsApp → Configuration → Webhook**, set:
   - **Callback URL**: `https://<your-site>.netlify.app/webhooks/whatsapp`
   - **Verify token**: the same string you picked above
4. Click **Verify and save** — Netlify's function replies to Meta's challenge automatically (`netlify/functions/whatsapp-webhook.js`), so this should go green immediately if your env vars are already deployed.
5. Under **Webhook fields**, subscribe to **messages**.

### Step 4 — Set the environment variables

Add these in Netlify → **Site configuration → Environment variables**, then redeploy:

| Key | Value |
|---|---|
| `WHATSAPP_TOKEN` | the access token from Step 1 |
| `WHATSAPP_PHONE_NUMBER_ID` | from Step 1 |
| `WHATSAPP_VERIFY_TOKEN` | the string you picked in Step 3 |
| `WHATSAPP_INVITE_TEMPLATE_NAME` | only needed if you named it something other than `wedding_invite` |
| `WHATSAPP_REMINDER_TEMPLATE_NAME` | only needed if you named it something other than `wedding_reminder` |
| `WHATSAPP_TEMPLATE_LANG` | only needed if your templates use a language other than `en_US` |

### Step 5 — SMS fallback (optional but recommended)

When a WhatsApp send fails (undelivered number, guest never opened
WhatsApp, template rejected), the app automatically falls back to SMS via
Africa's Talking:

1. Sign up at [africastalking.com](https://africastalking.com). Start in **Sandbox** mode (free, works with test numbers) before moving to a paid live app.
2. From your app dashboard, get your **username** and **API key**.
3. Add to Netlify env vars:

| Key | Value |
|---|---|
| `AFRICASTALKING_USERNAME` | `sandbox` while testing, or your live app's username |
| `AFRICASTALKING_API_KEY` | from your dashboard |
| `AFRICASTALKING_SENDER_ID` | optional — a registered short code/sender name, if you have one |

Using a different SMS provider (Twilio, Vonage, etc.) instead? Only
`lib/sms.js` needs to change — rewrite `sendSms()` to call your provider's
API and everything else (the fallback logic, `message_log` writes, retry
behavior) stays the same.

### Step 6 — Test it

1. Add yourself as a guest with your real WhatsApp number.
2. Go to Invites & messages → the banner should now say "Live sending: WhatsApp connected". If it still says "Demo mode", double check the env var names exactly match and that you redeployed after adding them.
3. Click **Send invite** next to your own guest row. You should receive the real WhatsApp template message within seconds.
4. Reply **YES** from your phone. Within a few seconds (Meta's webhook delivery time, typically under 5s), your guest row should flip to "Confirmed" automatically — no page refresh needed, since it comes through the same Realtime Broadcast as every other live update.
5. Check **Netlify → Functions → whatsapp-webhook → logs** if step 4 doesn't work — this is the fastest way to see exactly what Meta sent and where it didn't match.

### Common failure modes

| Symptom | Likely cause |
|---|---|
| Send fails with "template not approved" | Check WhatsApp Manager — approval is still pending, or the name doesn't exactly match your env var |
| Send fails with a 401/403 | Access token expired (temporary tokens last 24h) — generate a System User token instead |
| Webhook verify fails | `WHATSAPP_VERIFY_TOKEN` in Netlify doesn't exactly match what you typed into Meta's dashboard, or you deployed the env var change after trying to verify |
| YES/NO reply doesn't update status | Check the guest's stored phone number format — the webhook matches on the last 9 digits, so wildly different formats (missing country code entirely) can miss. Check **Functions → whatsapp-webhook → logs** to see the raw inbound `from` number |
| Everything works except delivery status never updates | You only subscribed to the `messages` webhook field — also fine to leave as-is, delivery status is a nice-to-have, not required for RSVP automation |

## Document/photo guest-list import

The other piece worth knowing about: plain text, pasted text, `.txt`, and
`.csv` all parse for real today (`lib/import-parse.js`). `.xlsx`/`.docx`/
scanned `.pdf`/photos need a real document or vision-extraction service
wired into `routes/import.js`'s `markNeedsExternalService` path (see the
architecture doc's open question #9 for provider options) — until then the
app tells the planner exactly that and asks them to paste text or export to
CSV instead, rather than guessing at a photo.

## Why Broadcast, not Realtime table subscriptions

You'll notice `schema.sql` enables Row Level Security on every table but adds
**no policies**. That's deliberate: every read and write in this app goes
through a Netlify Function using the `service_role` key, which bypasses RLS
by design — so a locked-down table with zero policies means the `anon` key
(the only key that ever reaches the browser) can't read or write a single
row directly, full stop.

The tradeoff: that also blocks the normal Supabase Realtime pattern of
subscribing to `postgres_changes` directly from the browser, since that
requires the browser's key to have SELECT access. Instead, `lib/broadcast.js`
sends a Realtime **Broadcast** message (not tied to any table) after every
mutation, and both frontends listen on a channel named after the wedding's
ID (`public/offline.js`, `startRealtime`). Broadcast is closer to "ring a
bell telling you to refetch" than "stream me the actual row" — the client
never receives guest data over the socket, only a nudge, and the real data
still comes back through the authenticated function call that follows. It's
a smaller trust surface at the cost of one extra round trip, which is the
right tradeoff for guest/RSVP data. If you'd rather open that up later,
enabling Realtime Authorization + private channels with actual RLS policies
is the natural next step — noted here rather than built, since it's a real
security decision for you to make deliberately, not a default to inherit.

## How this was tested

This code was exercised end-to-end against an in-memory mock of the
`@supabase/supabase-js` client (same method chains — `.from().select().eq()`,
`.insert().select().single()`, `.auth.signInWithPassword()`, etc.) across two
rounds of checks, all passing:

- Core flow (27 checks): planner signup/login and wrong-password rejection,
  wedding creation, every module toggle, guest CRUD, RSVP history, seating an
  unconfirmed guest, check-in, paste-to-import end to end, the offline-sync
  batch endpoint, invite sending with the WhatsApp→SMS fallback, couple-site
  login/scoping/revocation, the admin cross-wedding view, and the scheduled
  reminder sweep.
- WhatsApp automation (11 checks): the `declined` status end-to-end, the
  webhook's verification handshake (correct and incorrect tokens), a YES
  reply auto-confirming the right guest, a NO reply auto-declining it,
  unrecognized replies being logged without guessing at a status, and a
  delivery-status callback updating `message_log`.

That verifies every query's logic and every route's behavior; it does not
substitute for the live tests in "WhatsApp automation" step 6 and the
Supabase smoke test in step 6 above, since real Postgres constraint
behavior, real Meta API responses, and real webhook delivery latency can
only be verified against live services.
