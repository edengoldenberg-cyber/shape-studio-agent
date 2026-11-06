const crypto = require('crypto');
const logger  = require('../utils/logger');

/**
 * Verify the X-Hub-Signature-256 header on inbound Meta webhook payloads.
 * Attach this middleware BEFORE body parsing with express.json() so we can
 * access the raw buffer.
 */
function verifyMetaSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    logger.warn('Missing X-Hub-Signature-256 header');
    return res.sendStatus(401);
  }

  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('META_APP_SECRET not set — skipping signature check (dev only)');
      return next();
    }
    logger.error('META_APP_SECRET required in production');
    return res.sendStatus(500);
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(req.rawBody ?? '')
    .digest('hex')}`;

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    logger.warn('Invalid webhook signature');
    return res.sendStatus(401);
  }

  next();
}

/**
 * Express middleware to capture raw body for signature verification.
 * Use BEFORE express.json().
 */
function captureRawBody(req, res, next) {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
}

module.exports = { verifyMetaSignature, captureRawBody };
