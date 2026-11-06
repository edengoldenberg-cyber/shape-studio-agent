const axios  = require('axios');
const logger = require('../utils/logger');

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

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
  if (!token) {
    logger.warn('META_PAGE_ACCESS_TOKEN not set — cannot fetch lead from Graph API', { leadgenId });
    return null;
  }

  const { data } = await axios.get(`${GRAPH_BASE}/${leadgenId}`, {
    params:  { access_token: token },
    timeout: 10_000,
  });

  logger.debug('Graph API lead response', { leadgenId, fieldCount: data.field_data?.length ?? 0 });
  return normalizeLead(data);
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

  // Normalise phone to E.164 (Israel) without +
  const rawPhone = f['phone_number'] ?? f['phone'] ?? null;
  const phone    = rawPhone
    ? rawPhone.replace(/[\s\-+()]/g, '').replace(/^0/, '972')
    : null;

  return {
    id:           raw.id,
    createdTime:  raw.created_time,
    formId:       raw.form_id   ?? null,
    adId:         raw.ad_id     ?? null,
    pageId:       raw.page_id   ?? null,
    phone,
    name:         f['full_name'] ?? ([f['first_name'], f['last_name']].filter(Boolean).join(' ') || null),
    email:        f['email']         ?? null,
    // Courier-recruitment specific fields (match your actual Meta form field names)
    deliveryArea: f['delivery_area'] ?? f['area']         ?? f['city']     ?? null,
    vehicleType:  f['vehicle_type']  ?? f['vehicle']      ?? null,
    brand:        f['campaign_brand']?? f['brand']        ?? null, // e.g. PICKUP / Solo
    rawFields:    f,
  };
}

module.exports = { fetchAndNormalizeLead };
