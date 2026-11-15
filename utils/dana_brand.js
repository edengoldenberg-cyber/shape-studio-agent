'use strict';

/**
 * dana_brand.js — brand settings for Dana, with EXPLICIT missing states.
 *
 * Nothing here is invented. A setting is either stated by the owner (stored in
 * DATA_DIR/dana/brand.json, or one of the four base facts below) or it is "missing".
 * Code and prompts must show a missing setting as missing — never fill it in.
 */

const fs   = require('fs');
const path = require('path');

// Stated by the owner on 2026-11-15 (see ~/.claude/instagram/business-context.md).
const STATED = { studio_name: 'Shape Studio', business_type: 'כושר ופילאטיס מכשירים', location: 'פרדס חנה', content_language: 'עברית' };

// Everything else must come from the owner.
const FIELDS = {
  studio_name:       'שם העסק',
  business_type:     'סוג העסק',
  location:          'מיקום',
  content_language:  'שפת התוכן',
  instagram_account: 'חשבון האינסטגרם ליעד הפרסום',
  voice_profile:     'פרופיל קול (נבנה רק מדוגמאות של הבעלים)',
  audience_strength: 'קהל היעד — אימוני כוח',
  audience_pilates:  'קהל היעד — פילאטיס מכשירים',
  current_offer:     'הצעה נוכחית (ניסיון / מחיר) — מאומתת',
  cta_default:       'קריאה לפעולה (CTA) מאושרת',
  active_classes:    'רשימת שיעורים פעילים',
};

const file = () => path.join((process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''), 'dana', 'brand.json');

function stored() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}

/** { field: { label, value, status: 'set' | 'missing', source } } */
function get() {
  const s = stored(), out = {};
  for (const [k, label] of Object.entries(FIELDS)) {
    const own = s[k]?.value;
    const value = own != null && String(own).trim() !== '' ? own : (STATED[k] ?? null);
    out[k] = { label, value, status: value == null ? 'missing' : 'set',
               source: own != null ? `owner (${s[k].by ?? '?'}, ${s[k].at ?? '?'})` : (STATED[k] ? 'owner statement 2026-11-15' : null) };
  }
  return out;
}

function set(field, value, by) {
  if (!FIELDS[field]) throw Object.assign(new Error(`unknown brand field: ${field}`), { status: 400 });
  if (!by || !String(by).trim()) throw Object.assign(new Error('נדרש שם מי שמעדכן/ת'), { status: 400 });
  const s = stored();
  if (value == null || String(value).trim() === '') delete s[field];
  else s[field] = { value: typeof value === 'string' ? value.trim().slice(0, 4000) : value, by: String(by).slice(0, 80), at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8');
  fs.renameSync(tmp, file());
  return get();
}

const missing = () => Object.entries(get()).filter(([, v]) => v.status === 'missing').map(([k, v]) => ({ field: k, label: v.label }));

/** Prompt block: verified facts, and an explicit list of what is NOT known. */
function promptBlock() {
  const b = get();
  const known = Object.values(b).filter(v => v.status === 'set').map(v => `- ${v.label}: ${typeof v.value === 'string' ? v.value : JSON.stringify(v.value)}`);
  const unknown = Object.values(b).filter(v => v.status === 'missing').map(v => `- ${v.label}`);
  return [
    '## עובדות מותג מאומתות (נמסרו על ידי הבעלים)', ...known, '',
    '## לא הוגדר — אסור להמציא או לנחש',
    ...(unknown.length ? unknown : ['- (הכול הוגדר)']), '',
    'כשפרט חסר נדרש לטקסט: השאירי `{{placeholder}}` וצייני שהוא ממתין לאישור הבעלים.',
  ].join('\n');
}

module.exports = { get, set, missing, promptBlock, FIELDS };
