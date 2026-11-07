const axios  = require('axios');
const logger = require('../utils/logger');

// v21.0 — released August 2024. Supported for 2 years (through ~August 2026).
// If Graph API calls start returning "version deprecated" errors, bump this value.
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Fetch the full lead record from Meta Graph API.
 *
 * Meta Lead Ads webhooks only deliver a leadgen_id — actual form field values
 * (name, phone, delivery area…) are behind a separate Graph API call.
 *
 * Requires META_PAGE_ACCESS_TOKEN in env.
 */
async function fetchAndNormalizeLead(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;

  // Treat missing, placeholder, or obviously-invalid tokens as unconfigured
  if (!token || token === 'REPLACE_ME' || token.length < 20) {
    logger.warn(
      'META_PAGE_ACCESS_TOKEN not configured — skipping Graph API fetch. ' +
      'Set a valid Page Access Token on Railway to auto-retrieve lead phone numbers.',
      { leadgenId }
    );
    return null;
  }

  try {
    const { data } = await axios.get(`${GRAPH_BASE}/${leadgenId}`, {
      params:  { access_token: token },
      timeout: 10_000,
    });
    logger.debug('Graph API lead response', { leadgenId, fieldCount: data.field_data?.length ?? 0 });
    return normalizeLead(data);
  } catch (err) {
    // Surface the actual Graph API error code so it's actionable in Railway logs
    const status  = err.response?.status;
    const errCode = err.response?.data?.error?.code;
    const errMsg  = err.response?.data?.error?.message ?? err.message;
    logger.warn('Graph API lead fetch failed', { leadgenId, httpStatus: status, errorCode: errCode, error: errMsg });
    return null;
  }
}

/**
 * Convert Meta's field_data array into a flat, typed lead object.
 * field_data: [{ name: "full_name", values: ["John Doe"] }, ...]
 */
function normalizeLead(raw) {
  const f = {};
  for (const field of raw.field_data ?? []) {
    f[field.name] = field.values?.[0] ?? null;
  }

  // Normalise phone to E.164 Israel format without + (e.g. 972541234567).
  // Try every field name that Meta Lead Ads forms commonly use — the exact name
  // depends on how the advertiser configured the form in Meta Ads Manager.
  const rawPhone =
    f['phone_number']    ??   // Meta's default system name
    f['phone']           ??   // common short alias
    f['mobile_phone']    ??   // some form templates
    f['mobile']          ??   // another common variant
    f['phone_number_v2'] ??   // occasionally used in newer templates
    null;

  const phone = rawPhone
    ? rawPhone.replace(/[\s\-+()]/g, '').replace(/^0/, '972')
    : null;

  // Log the raw fields when phone is still null so the actual field names are
  // visible in Railway logs and can be added to the lookup list above.
  if (!phone && Object.keys(f).length) {
    logger.warn('normalizeLead: phone not found in field_data', {
      availableFields: Object.keys(f),
      rawFields:       f,
    });
  }

  const nameParts = [f['first_name'], f['last_name']].filter(Boolean).join(' ');

  return {
    id:           raw.id,
    createdTime:  raw.created_time,
    formId:       raw.form_id   ?? null,
    adId:         raw.ad_id     ?? null,
    pageId:       raw.page_id   ?? null,
    phone,
    name:         f['full_name'] ?? (nameParts || null),
    email:        f['email']         ?? null,
    // Shape Studio / Lead Ads specific fields
    deliveryArea: f['delivery_area'] ?? f['area']         ?? f['city']     ?? null,
    vehicleType:  f['vehicle_type']  ?? f['vehicle']      ?? null,
    brand:        f['campaign_brand']?? f['brand']        ?? null,
    rawFields:    f,
  };
}

module.exports = { fetchAndNormalizeLead };
