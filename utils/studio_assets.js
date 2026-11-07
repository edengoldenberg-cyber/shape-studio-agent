'use strict';

/**
 * studio_assets.js — Persistent storage for Barak's static studio assets.
 *
 * All files are written to DATA_DIR (env var) so they survive Railway deploys.
 * Set DATA_DIR=/data in Railway Variables and mount a Volume at /data.
 * Without that env var the files fall back to data/ inside the app directory
 * (useful for local dev; not deploy-safe on Railway).
 *
 * Fields in studio_assets.json:
 *   wazeUrl              — Waze deep link, empty = not configured
 *   timetableUrl         — External timetable URL (optional fallback)
 *   timetableImageExt       — Extension of the uploaded timetable image (jpg/png/webp…)
 *   timetableImageUploaded  — true when image 1 has been saved to DATA_DIR
 *   timetable2ImageExt      — Extension of the second timetable image
 *   timetable2ImageUploaded — true when image 2 has been saved to DATA_DIR
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_DIR = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/\/$/, '');
const FILE     = path.join(DATA_DIR, 'studio_assets.json');

const DEFAULTS = {
  wazeUrl: 'https://waze.com/ul?q=דרך+השדה+12,+פרדס+חנה-כרכור&navigate=yes',
  timetableUrl:           '',
  timetableImageExt:      '',
  timetableImageUploaded: false,
  timetable2ImageExt:      '',
  timetable2ImageUploaded: false,
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Returns the current assets merged over defaults.
 * Reads from disk on every call so dashboard edits take effect immediately.
 */
function getAssets() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const merged = { ...DEFAULTS };
    for (const [k, v] of Object.entries(raw)) {
      // Booleans always win; strings only override when non-empty
      if (typeof v === 'boolean') { merged[k] = v; }
      else if (v !== '' && v !== null && v !== undefined) { merged[k] = v; }
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Saves text asset values (wazeUrl, timetableUrl) to disk.
 * Wazeurl is stored as-is — empty string means "not configured".
 * Never overwrites timetableImageUploaded/timetableImageExt set by saveTimetableImage.
 */
function saveAssets(data) {
  const current = getAssets();
  const toSave  = {
    ...current,
    wazeUrl:      String(data.wazeUrl      ?? '').trim(),
    timetableUrl: String(data.timetableUrl ?? '').trim(),
  };
  ensureDir();
  atomicWrite(FILE, toSave);
  logger.info('[studio-assets] Text assets saved', {
    wazeSet:      !!toSave.wazeUrl,
    timetableSet: !!toSave.timetableUrl,
  });
  return toSave;
}

/**
 * Saves a binary image buffer as the timetable image.
 * @param {Buffer} buffer  — raw image bytes
 * @param {string} ext     — file extension without dot (e.g. "jpg", "png")
 */
function saveTimetableImage(buffer, ext) {
  ensureDir();
  const safeExt  = (ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const filename = `timetable.${safeExt}`;
  const imgPath  = path.join(DATA_DIR, filename);

  fs.writeFileSync(imgPath, buffer);
  logger.info('[studio-assets] Timetable image saved', { path: imgPath, sizeKb: Math.round(buffer.length / 1024) });

  const current = getAssets();
  const toSave  = { ...current, timetableImageUploaded: true, timetableImageExt: safeExt };
  atomicWrite(FILE, toSave);

  return { timetableImageUploaded: true, timetableImageExt: safeExt };
}

/**
 * Returns the filesystem path of the uploaded timetable image 1, or null if none.
 */
function getTimetableImagePath() {
  const assets = getAssets();
  if (!assets.timetableImageUploaded || !assets.timetableImageExt) return null;
  return path.join(DATA_DIR, `timetable.${assets.timetableImageExt}`);
}

/**
 * Saves a binary image buffer as the second timetable image.
 * @param {Buffer} buffer  — raw image bytes
 * @param {string} ext     — file extension without dot (e.g. "jpg", "png")
 */
function saveTimetable2Image(buffer, ext) {
  ensureDir();
  const safeExt  = (ext || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  const filename = `timetable2.${safeExt}`;
  const imgPath  = path.join(DATA_DIR, filename);

  fs.writeFileSync(imgPath, buffer);
  logger.info('[studio-assets] Timetable2 image saved', { path: imgPath, sizeKb: Math.round(buffer.length / 1024) });

  const current = getAssets();
  const toSave  = { ...current, timetable2ImageUploaded: true, timetable2ImageExt: safeExt };
  atomicWrite(FILE, toSave);

  return { timetable2ImageUploaded: true, timetable2ImageExt: safeExt };
}

/**
 * Returns the filesystem path of the uploaded timetable image 2, or null if none.
 */
function getTimetable2ImagePath() {
  const assets = getAssets();
  if (!assets.timetable2ImageUploaded || !assets.timetable2ImageExt) return null;
  return path.join(DATA_DIR, `timetable2.${assets.timetable2ImageExt}`);
}

module.exports = {
  getAssets, saveAssets,
  saveTimetableImage,  getTimetableImagePath,
  saveTimetable2Image, getTimetable2ImagePath,
  DATA_DIR,
};
