// lib/http.js — same small helpers as the local demo, minus password
// hashing (planner auth is now real Supabase Auth) and minus the raw
// Node body reader (Netlify hands us event.body directly).
const crypto = require('crypto');

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function accessCode() {
  const words = ['AMBER', 'ROSE', 'IVORY', 'PEARL', 'GOLD', 'BLOOM', 'VOWS', 'ALTAR', 'GLOW', 'LUME'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${w}-${n}`;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

module.exports = { sendJSON, token, accessCode, slugify };
