'use strict';

/**
 * conversion_detector.js — Cross-reference lead_store against live Arbox to
 * find leads that have converted to members without the system knowing.
 *
 * Problem: when Eden enrolls a WhatsApp lead in Arbox, the system learns about
 * it only when the person sends their next message. In the gap, Tomer's daily
 * re-engagement cron may send a cold lead message to a paying member.
 *
 * This module runs as part of the daily check and before every re-engagement
 * send to prevent that scenario.
 *
 * Usage:
 *   const { detectAndMarkConversions } = require('./utils/conversion_detector');
 *   await detectAndMarkConversions(store, memberCache, normalizeToE164, _autoAddKnownMember);
 */

const logger = require('./logger');

/**
 * Compare every lead in lead_store against the current Arbox member list.
 * Leads whose phone appears in Arbox as an active member are:
 *   1. Marked in memberCache as confirmed
 *   2. Added to known_members.json
 *   3. Removed from lead_store (so Tomer's queue never touches them)
 *
 * @param {LeadStore}  store
 * @param {object}     memberCache   - the member_cache module
 * @param {function}   normalizeToE164
 * @param {function}   _autoAddKnownMember
 * @returns {Promise<{ converted: number, checked: number, errors: number }>}
 */
async function detectAndMarkConversions(store, memberCache, normalizeToE164, _autoAddKnownMember) {
  let arboxSvc;
  try { arboxSvc = require('../services/arbox.service'); } catch {
    logger.warn('[conversion-detector] arbox.service unavailable — skipping');
    return { converted: 0, checked: 0, errors: 1 };
  }

  // Fetch all active Arbox members once — reuse across all leads
  let arboxMembers = [];
  try {
    arboxMembers = await arboxSvc.getAllUsers({ limit: 1000 });
  } catch (err) {
    logger.warn('[conversion-detector] Arbox fetch failed', { error: err.message });
    return { converted: 0, checked: 0, errors: 1 };
  }

  // Build a normalized phone → arbox user index for O(1) lookup per lead
  const arboxByPhone = new Map();
  for (const u of arboxMembers) {
    if (!u.phone) continue;
    const norm = normalizeToE164(u.phone);
    if (norm && (u.active === 1 || u.user_role === 'aggregatorMember')) {
      arboxByPhone.set(norm, u);
    }
  }

  const leads   = store.getAllLeads();
  let converted = 0, checked = 0;

  for (const lead of leads) {
    if (lead.status === 'crisis') continue;  // never auto-convert crisis records
    if (lead.meta?.isClient)      continue;  // already flagged

    checked++;
    const norm = normalizeToE164(lead.phone);
    if (!norm) continue;

    const arboxUser = arboxByPhone.get(norm);
    if (!arboxUser) continue;  // not found in Arbox members — genuine lead

    // This lead has become an active Arbox member — convert them
    const name = `${arboxUser.first_name ?? ''} ${arboxUser.last_name ?? ''}`.trim()
                 || lead.name || null;

    logger.info('[conversion-detector] Lead converted to member — removing from lead funnel', {
      phone: norm, name, arboxId: arboxUser.user_id,
    });

    // 1. Stamp the memberCache so future routing is instant
    memberCache.markConfirmed(norm, {
      name,
      role:   arboxUser.user_role ?? 'client',
      source: 'conversion_detector',
    });

    // 2. Stamp known_members.json as the durable file-backed override
    _autoAddKnownMember(norm, name);

    // 3. Remove from lead_store so Tomer's cron never touches this person
    store.deleteLead(lead.phone);
    store.logEvent('lead_converted_detected', norm, {
      name,
      arboxId:   String(arboxUser.user_id),
      arboxRole: arboxUser.user_role,
      source:    'conversion_detector',
    });

    converted++;
  }

  if (converted > 0) {
    logger.info('[conversion-detector] Conversion pass complete', { converted, checked });
  }
  return { converted, checked, errors: 0 };
}

/**
 * Quick guard for Tomer's re-engagement send loop.
 * Returns true if this phone is already a confirmed member — stop, don't send.
 * Cheap synchronous check; call before every sendReEngagement().
 *
 * @param {string}  phone
 * @param {object}  memberCache
 * @param {function} isKnownMember - server.js helper
 */
function isMemberPhoneSync(phone, memberCache, isKnownMember) {
  if (!phone) return false;
  return memberCache.isConfirmed(phone) || isKnownMember(phone);
}

module.exports = { detectAndMarkConversions, isMemberPhoneSync };
