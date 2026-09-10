// scripts/generate-config.js
//
// Runs as Netlify's build command (see netlify.toml). Writes the two
// PUBLIC, safe-to-ship Supabase values into public/config.js so the
// frontend can open a Realtime Broadcast connection directly (see
// public/offline.js and README-DEPLOY.md "Why Broadcast"). The
// service_role key is intentionally never touched by this script — it
// only ever lives in the Netlify Functions environment.
const fs = require('fs');
const path = require('path');

const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.warn(
    '[generate-config] SUPABASE_URL / SUPABASE_ANON_KEY are not set — ' +
    'Realtime live-sync will be disabled and the app will fall back to ' +
    'polling only. Set these in Netlify → Site configuration → Environment ' +
    'variables, then redeploy.'
  );
}

const contents = `// Auto-generated at build time by scripts/generate-config.js — do not edit.
window.APP_CONFIG = ${JSON.stringify({ SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey }, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'config.js'), contents);
console.log('[generate-config] wrote public/config.js');
