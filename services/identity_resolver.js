'use strict';

/**
 * identity_resolver.js — the ONE place that decides who a phone number is.
 *
 * The phone registry, the member cache and the live lookup in the inbound pipeline all ask
 * here, so they cannot disagree. The answer is one category per phone:
 *
 *   member         a CLIENT row with a verified, currently valid membership        → Tomer
 *   aggregator     an aggregator member (ClassPass / Gympass …), identified apart  → existing member handling
 *   former_member  a CLIENT row with membership history but no valid membership    → Barak (renewal) / staff (service, billing)
 *   staff          an active staff row                                             → staff bypass (never Barak)
 *   lead           a lead row, or a client row that never had a membership         → Barak
 *   unknown        the phone is not in Arbox                                       → Barak
 *   unavailable    it could not be determined (Arbox unreadable, nothing usable)   → neither agent; hold + staff alert
 *
 * Rules
 *   • The Arbox `active` flag is NOT a membership. "member" needs a membership row that is
 *     active, not cancelled, of a plan / session kind, and whose dates include TODAY. The
 *     dates are kept and re-evaluated at every lookup, so a stored directory can never keep
 *     an expired membership alive.
 *   • A row merely existing proves nothing: a client row without any membership is a lead.
 *   • Complete data only: every page of /v3/users and /v3/users/memberships; phones are
 *     normalised to 972XXXXXXXXX before any comparison.
 *   • Shared phone (several Arbox users on one number): the strongest category wins
 *     (staff › member › aggregator › former_member › lead) and the result says `shared`,
 *     lists the other categories, and says `ambiguous` when two members share the number.
 *   • Unavailable data is explicit. If users cannot be read, the last good directory is used
 *     (marked `stale`, `refreshFailed`) for at most MAX_STALE_MS, then the answer is `unavailable`;
 *     the caller must not treat "lead / unknown" from such a copy as proof (new members). If only the
 *     memberships cannot be read, lead / staff / unknown answers stay valid, and a client is
 *     `unavailable` unless a usable earlier copy of their memberships exists.
 *
 * Read-only: GET requests through arbox_gateway. Nothing is written to Arbox.
 */

const fs   = require('fs');
const path = require('path');

const FRESH_MS     = 60 * 1000;             // a directory younger than this is used as is (the gateway caches the Arbox reads themselves)
const MAX_STALE_MS = 24 * 60 * 60 * 1000;   // an older copy may be used (marked stale) this long when Arbox cannot be read
const RANK = { staff: 5, member: 4, aggregator: 3, former_member: 2, lead: 1 };
const MEMBERSHIP_KINDS = new Set(['plan', 'session']);

function createIdentityResolver({ gateway, logger = console, now = () => new Date(), dataDir = null, todayIL = null } = {}) {
  const normalize = gateway.normalizePhone;
  const today = () => (todayIL ? todayIL(now()) : gateway.todayIL(now()));
  const file = () => (dataDir ? path.join(typeof dataDir === 'function' ? dataDir() : dataDir, 'identity_directory.json') : null);

  // directory = { at, membershipsAt, byPhone: Map(phone → [record]) }
  // record    = { userId, role, active, name, periods: [{ from, to }] | null, hadMembership: bool | null }
  //             periods === null → this user's memberships are not known
  let _dir = null, _inflight = null, _lastError = null;

  function build(users, memberships, types, prev, usersAt = null) {
    const kindByType = new Map((types ?? []).map(t => [String(t.typeId), t.kind]));
    const kindOf = m => kindByType.get(String(m.typeId)) ?? m.rowType ?? null;
    let byUser = null;
    if (memberships) {
      byUser = new Map();
      for (const m of memberships) {
        if (!MEMBERSHIP_KINDS.has(kindOf(m))) continue;          // items, trials, services are not a membership
        const k = String(m.userId);
        if (!byUser.has(k)) byUser.set(k, { periods: [], had: true, past: false });
        if (m.active && !m.cancelled) byUser.get(k).periods.push({ from: m.startDate ?? null, to: m.endDate ?? null });
        else byUser.get(k).past = true;                          // an ended / cancelled membership row = real history
      }
    }
    // Memberships unreadable now: reuse what the previous directory knew about each user (still date-checked at lookup).
    const prevByUser = new Map();
    if (!byUser && prev) for (const recs of prev.byPhone.values()) for (const r of recs) if (r.periods) prevByUser.set(String(r.userId), r);
    const byPhone = new Map();
    for (const u of users) {
      const phone = u.phone ?? normalize(u.phoneRaw);
      if (!phone) continue;
      const id = String(u.userId);
      const known = byUser ? (byUser.get(id) ?? { periods: [], had: false }) : null;
      const old = known ? null : prevByUser.get(id) ?? null;
      const rec = { userId: id, role: u.role ?? null, active: !!u.active, name: u.name ?? null,
        periods: known ? known.periods : old ? old.periods : null, hadMembership: known ? known.had : old ? old.hadMembership : null,
        hadPast: known ? known.past : old ? !!old.hadPast : false };
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(rec);
    }
    const at = usersAt ?? now().getTime();     // the age of the directory is the age of the USERS read (the gateway may serve a recent copy)
    return { at, epoch: typeof gateway.cacheEpoch === 'function' ? gateway.cacheEpoch() : 0, membershipsAt: byUser ? at : (prev?.membershipsAt ?? null), membershipsFresh: !!byUser, byPhone };
  }

  /** Read Arbox completely and replace the directory. Throws when the USERS cannot be read. */
  async function refresh() {
    if (_inflight) return _inflight;
    _inflight = (async () => {
      const ur = await gateway.getAllUsers();                                // every page; throws → caller keeps the old directory
      const users = ur.users;
      let memberships = null, types = null;
      try { memberships = (await gateway.getAllMemberships()).memberships; }
      catch (err) { _lastError = `memberships: ${err.message}`; logger.warn('[identity] memberships could not be read — clients cannot be verified from this refresh', { error: err.message }); }
      try { types = (await gateway.getMembershipTypes()).types; } catch { types = null; }   // deleted / unreadable types: the row's own kind is used
      // Directory age = age of the users read (the gateway may hand back a copy up to a few minutes old).
      const copyAgeMs = ur.fetchedAt ? Math.max(0, Date.now() - ur.fetchedAt) : 0;
      _dir = build(users, memberships, types, _dir, now().getTime() - copyAgeMs);
      if (memberships) _lastError = null;
      save();
      return summary();
    })();
    try { return await _inflight; } finally { _inflight = null; }
  }

  function save() {
    const f = file(); if (!f || !_dir) return;
    try {
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ at: _dir.at, membershipsAt: _dir.membershipsAt, membershipsFresh: _dir.membershipsFresh, phones: [..._dir.byPhone.entries()] }), 'utf8');
      fs.renameSync(tmp, f);
    } catch (err) { logger.warn('[identity] directory not saved', { error: err.message }); }
  }
  /** Load the last saved directory (used only as a stale fallback until the first successful refresh). */
  function load() {
    const f = file(); if (!f) return false;
    try {
      if (!fs.existsSync(f)) return false;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!j?.at || !Array.isArray(j.phones)) return false;
      _dir = { at: j.at, membershipsAt: j.membershipsAt ?? null, membershipsFresh: false, byPhone: new Map(j.phones) };
      return true;
    } catch (err) { logger.warn('[identity] saved directory unreadable — ignored', { error: err.message }); return false; }
  }

  const covers = (p, day) => (!p.from || p.from <= day) && (!p.to || p.to >= day);

  /** Category of ONE Arbox row on a given day. */
  function categoryOf(rec, day) {
    if (rec.role === 'staffMember') return rec.active ? 'staff' : null;      // a former staff row says nothing
    if (rec.role === 'aggregatorMember') return 'aggregator';
    if (rec.role === 'client') {
      if (rec.periods === null) return 'unverified';
      if (rec.periods.some(p => covers(p, day))) return 'member';
      // Bought, not started yet: no valid membership TODAY and no past one either — not a member, not "former".
      if (rec.periods.some(p => p.from && p.from > day) && !rec.periods.some(p => p.to && p.to < day) && !rec.hadPast) return 'lead';
      return rec.hadMembership ? 'former_member' : 'lead';                   // a client row with no membership ever is not a member
    }
    if (rec.role === 'lead') return 'lead';
    return null;
  }

  function classify(recs, { stale = false, ageMs = 0 } = {}) {
    const day = today();
    const cats = recs.map(r => ({ r, c: categoryOf(r, day) })).filter(x => x.c);
    const base = { stale, ageMs, shared: new Set(recs.map(r => r.userId)).size > 1, rows: recs.length };
    if (!cats.length) return { category: 'unknown', ...base, shared: false, userIds: [], name: null, others: [], ambiguous: false, reason: recs.length ? 'no_usable_row' : 'not_in_arbox' };
    const known = cats.filter(x => x.c !== 'unverified');
    const top = known.sort((a, b) => RANK[b.c] - RANK[a.c])[0] ?? null;
    // A client whose memberships are unknown could be a member: nothing weaker than "member" may be concluded.
    if (cats.some(x => x.c === 'unverified') && (!top || RANK[top.c] < RANK.member)) {
      return { category: 'unavailable', ...base, userIds: cats.filter(x => x.c === 'unverified').map(x => x.r.userId), name: null, others: [...new Set(known.map(x => x.c))], ambiguous: false, reason: 'memberships_unavailable' };
    }
    const same = known.filter(x => x.c === top.c);
    return {
      category: top.c, ...base, userIds: same.map(x => x.r.userId), name: same[0].r.name ?? null,
      others: [...new Set(known.filter(x => x.c !== top.c).map(x => x.c))],
      ambiguous: top.c === 'member' && new Set(same.map(x => x.r.userId)).size > 1,
      reason: top.c === 'lead' && same.some(x => x.r.role === 'client') ? (same.some(x => (x.r.periods ?? []).length) ? 'membership_not_started_yet' : 'client_row_without_membership') : null,
    };
  }

  /** Synchronous answer from the directory in memory (no network). */
  function peek(rawPhone) {
    const phone = normalize(rawPhone);
    if (!phone) return { category: 'unknown', phone: null, stale: false, shared: false, userIds: [], name: null, others: [], ambiguous: false, reason: 'bad_phone' };
    if (!_dir) return { category: 'unavailable', phone, stale: false, shared: false, userIds: [], name: null, others: [], ambiguous: false, reason: _lastError ?? 'no_directory' };
    const ageMs = now().getTime() - _dir.at;
    if (ageMs > MAX_STALE_MS) return { category: 'unavailable', phone, stale: true, ageMs, shared: false, userIds: [], name: null, others: [], ambiguous: false, reason: 'directory_too_old' };
    return { phone, ...classify(_dir.byPhone.get(phone) ?? [], { stale: ageMs > FRESH_MS || !_dir.membershipsFresh, ageMs }) };
  }

  /** Fresh answer: refreshes the directory when it is old; falls back to the stale copy when Arbox cannot be read. */
  async function resolve(rawPhone) {
    const ageMs = _dir ? now().getTime() - _dir.at : Infinity;
    const dropped = _dir && typeof gateway.cacheEpoch === 'function' && gateway.cacheEpoch() !== _dir.epoch;   // cached Arbox data was invalidated
    if (ageMs > FRESH_MS || !_dir?.membershipsFresh || dropped) {
      try { await refresh(); }
      catch (err) {
        _lastError = `users: ${err.message}`;
        logger.warn('[identity] Arbox could not be read — using the last directory if it is recent enough', { error: err.message, haveDirectory: !!_dir });
        // refreshFailed: the answer rests on an older copy. A POSITIVE identification (member, staff …)
        // from it is still usable; "not a member" is not proven — the person may have joined since.
        return { ...peek(rawPhone), stale: true, refreshFailed: true };
      }
    }
    return peek(rawPhone);
  }

  /** Phones in a category (for the registry and the cache). */
  function phonesIn(categories) {
    const want = new Set(categories), out = [];
    if (!_dir) return out;
    for (const [phone, recs] of _dir.byPhone) { const c = classify(recs); if (want.has(c.category)) out.push({ phone, category: c.category, name: c.name }); }
    return out;
  }

  function summary() {
    const counts = { member: 0, aggregator: 0, former_member: 0, staff: 0, lead: 0, unknown: 0, unavailable: 0 };
    let shared = 0, ambiguous = 0, conflicts = 0;
    if (_dir) for (const recs of _dir.byPhone.values()) { const c = classify(recs); counts[c.category]++; if (c.shared) shared++; if (c.ambiguous) ambiguous++; if (c.others.length) conflicts++; }
    return { at: _dir?.at ?? null, membershipsFresh: !!_dir?.membershipsFresh, phones: _dir?.byPhone.size ?? 0, counts, sharedPhones: shared, sharedWithDifferentCategories: conflicts, ambiguousMembers: ambiguous, lastError: _lastError };
  }

  return { resolve, peek, refresh, load, phonesIn, summary, _reset() { _dir = null; _inflight = null; _lastError = null; },
    get ready() { return !!_dir; }, FRESH_MS, MAX_STALE_MS };
}

// One shared instance for the server process.
let _shared = null;
function shared() {
  if (!_shared) {
    _shared = createIdentityResolver({
      gateway: require('./arbox_gateway'), logger: require('../utils/logger'),
      dataDir: () => (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''),
    });
  }
  return _shared;
}

module.exports = { createIdentityResolver, shared, FRESH_MS, MAX_STALE_MS };
