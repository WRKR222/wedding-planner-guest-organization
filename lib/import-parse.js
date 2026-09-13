// lib/import-parse.js
//
// Implements the "extraction" half of guest-list import for the
// formats that can be parsed deterministically offline with zero external
// services: plain text, CSV, and pasted free text. Every row always comes
// back through the same shape the planner reviews before anything is
// committed: { name, phone, category, confidence, raw_source_line, include }
//
// XLSX/DOCX/PDF/photo formats genuinely need a document/vision extraction
// service in production — this demo
// does not call out to one (no network/API keys available in this
// environment), so those uploads are accepted and logged as a batch, but
// come back asking the planner to paste/retype the text instead of silently
// pretending to read a scanned image. That's a deliberate, honest limitation
// documented in README.md rather than a fake OCR result.

const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/;

// crude confidence heuristic: a line that cleanly splits into
// "name  <tab/comma/2+spaces>  phone" is high confidence; a name-only line
// is medium; anything with stray punctuation/short tokens is low.
function scoreLine(line, name, phone) {
  if (!name) return 0;
  let score = 0.9;
  if (name.length < 3) score -= 0.3;
  if (/[0-9]/.test(name)) score -= 0.3; // digits inside a name field are suspicious
  if (phone && !/^\+?\d[\d\s().-]{6,}\d$/.test(phone)) score -= 0.2;
  if (/[^a-zA-Z\s'.\-]/.test(name.replace(/,/g, ''))) score -= 0.15;
  return Math.max(0.05, Math.min(0.99, score));
}

function splitNamePhone(line) {
  const phoneMatch = line.match(PHONE_RE);
  let phone = phoneMatch ? phoneMatch[1].trim() : null;
  let namePart = phone ? line.replace(phone, '') : line;
  // strip common separators / list bullets / trailing commas
  namePart = namePart
    .replace(/^[\s*\-•\d.)]+/, '')
    .replace(/[,;:\t-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (phone) phone = phone.replace(/[.\-\s]/g, (m) => (m === ' ' ? ' ' : '')).trim();
  return { name: namePart, phone: phone || null };
}

function parseFreeText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return lines.map((line) => {
    // CSV-style line: "Name, Phone, Category"
    if (line.includes(',') && line.split(',').length <= 4) {
      const parts = line.split(',').map((p) => p.trim());
      const name = parts[0];
      const maybePhone = parts.find((p, i) => i > 0 && PHONE_RE.test(p));
      const category = parts.find((p, i) => i > 0 && p !== maybePhone) || null;
      const confidence = scoreLine(line, name, maybePhone);
      return {
        name,
        phone: maybePhone ? maybePhone.replace(/\s+/g, ' ').trim() : null,
        category: category || null,
        confidence,
        raw_source_line: line,
        include: !!name,
      };
    }
    const { name, phone } = splitNamePhone(line);
    return {
      name,
      phone,
      category: null,
      confidence: scoreLine(line, name, phone),
      raw_source_line: line,
      include: !!name,
    };
  }).filter((r) => r.name);
}

function parseCSV(text) {
  // minimal CSV parser: handles quoted fields with commas, no external dep
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];

  // detect header row
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const looksLikeHeader = header.some((h) => ['name', 'full_name', 'guest', 'guest name'].includes(h));
  const nameIdx = looksLikeHeader
    ? header.findIndex((h) => h.includes('name'))
    : 0;
  const phoneIdx = looksLikeHeader
    ? header.findIndex((h) => h.includes('phone') || h.includes('number') || h.includes('tel'))
    : 1;
  const catIdx = looksLikeHeader
    ? header.findIndex((h) => h.includes('categ') || h.includes('side') || h.includes('group'))
    : 2;

  const dataRows = looksLikeHeader ? rows.slice(1) : rows;

  return dataRows.map((r) => {
    const name = (r[nameIdx] || '').trim();
    const phone = (phoneIdx >= 0 ? (r[phoneIdx] || '').trim() : '') || null;
    const category = (catIdx >= 0 ? (r[catIdx] || '').trim() : '') || null;
    return {
      name,
      phone,
      category,
      confidence: scoreLine(r.join(' '), name, phone),
      raw_source_line: r.join(', '),
      include: !!name,
    };
  }).filter((r) => r.name);
}

module.exports = { parseFreeText, parseCSV };
