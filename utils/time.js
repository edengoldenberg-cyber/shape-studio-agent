const TIMEZONE = 'Asia/Jerusalem';
const QUIET_START = parseInt(process.env.QUIET_HOUR_START ?? '22', 10);
const QUIET_END   = parseInt(process.env.QUIET_HOUR_END   ?? '8',  10);

function nowInIsrael() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

/**
 * Returns true if the current Israel time is within quiet hours.
 * Quiet window: QUIET_START (inclusive) → midnight → QUIET_END (exclusive).
 */
function isQuietHours() {
  // ── QUIET HOURS DISABLED FOR TESTING ──────────────────────────────────────
  // Re-enable by removing this line and uncommenting the original logic below.
  return false;

  // const hour = nowInIsrael().getHours();
  // if (QUIET_START > QUIET_END) {
  //   return hour >= QUIET_START || hour < QUIET_END;
  // }
  // return hour >= QUIET_START && hour < QUIET_END;
}

/**
 * Returns a Date object representing the next 08:30 Israel time.
 */
function nextMorningRelease() {
  const now = nowInIsrael();
  const release = new Date(now);
  release.setHours(8, 30, 0, 0);
  if (now >= release) release.setDate(release.getDate() + 1);
  return release;
}

module.exports = { isQuietHours, nextMorningRelease, nowInIsrael };
