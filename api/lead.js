// ============================================================================
// POST /api/lead
// Handles website lead form submissions and sends SMS alerts via Telnyx.
//
// Required environment variables (Vercel > Project > Settings > Environment Variables):
//   TELNYX_API_KEY               Telnyx API v2 key
//   TELNYX_PHONE_NUMBER          Sending number in E.164, e.g. +14705551234
//   TELNYX_MESSAGING_PROFILE_ID  Telnyx messaging profile id
//   NOTIFY_PHONE_ADMIN           Admin mobile that receives lead alerts
//   NOTIFY_PHONE_OWNER           Owner mobile that receives lead alerts
//
// Optional:
//   NOTIFY_PHONE_EXTRA           Comma-separated additional recipients
//   LEAD_AUTOREPLY               "true" to text the submitter a confirmation.
//                                Only enable with consent language on the form
//                                and A2P 10DLC campaign coverage.
//
// Credentials are never hard-coded here and never logged.
// ============================================================================

const TELNYX_API_URL = 'https://api.telnyx.com/v2/messages';

const MAX = { name: 100, phone: 25, zip: 12, service: 60, message: 800 };

/**
 * Normalize a phone number to E.164. Returns null when it cannot be parsed.
 */
function formatPhoneE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

/** Trim, clamp length, and strip control characters. */
function clean(value, max) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Send one SMS through Telnyx.
 * Resolves to { success, messageId?, error? } and never throws.
 */
async function sendTelnyxSMS(to, text) {
  const apiKey = process.env.TELNYX_API_KEY;
  const from = process.env.TELNYX_PHONE_NUMBER;
  const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID;

  if (!apiKey || !from) {
    console.error('Telnyx not configured: missing TELNYX_API_KEY or TELNYX_PHONE_NUMBER');
    return { success: false, error: 'not_configured' };
  }

  const formattedTo = formatPhoneE164(to);
  if (!formattedTo) {
    console.warn('Skipping SMS, recipient could not be parsed to E.164');
    return { success: false, error: 'invalid_recipient' };
  }

  const payload = { from, to: formattedTo, text };
  if (profileId) payload.messaging_profile_id = profileId;

  try {
    const resp = await fetch(TELNYX_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const detail = (data && data.errors && data.errors[0] && data.errors[0].detail) || `HTTP ${resp.status}`;
      console.error('Telnyx send failed:', detail);
      return { success: false, error: detail };
    }

    return { success: true, messageId: (data && data.data && data.data.id) || null };
  } catch (err) {
    console.error('Telnyx request threw:', err.message);
    return { success: false, error: err.message };
  }
}

/** Build the de-duplicated recipient list from environment variables. */
function alertRecipients() {
  const raw = [
    process.env.NOTIFY_PHONE_ADMIN,
    process.env.NOTIFY_PHONE_OWNER,
  ].concat(
    String(process.env.NOTIFY_PHONE_EXTRA || '')
      .split(',')
      .map(function (n) { return n.trim(); })
  );

  const seen = new Set();
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const e164 = formatPhoneE164(raw[i]);
    if (e164 && !seen.has(e164)) {
      seen.add(e164);
      out.push(e164);
    }
  }
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Vercel parses JSON bodies automatically; fall back for string bodies.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Honeypot: real users never fill a hidden field.
  if (clean(body.company, 100)) {
    console.warn('Honeypot triggered, discarding submission');
    return res.status(200).json({ ok: true });
  }

  // Timing check: submissions completed in under 3 seconds are almost always bots.
  const elapsed = Number(body.elapsed || 0);
  if (elapsed > 0 && elapsed < 3000) {
    console.warn('Submission too fast, discarding');
    return res.status(200).json({ ok: true });
  }

  const lead = {
    name: clean(body.name, MAX.name),
    phone: clean(body.phone, MAX.phone),
    zip: clean(body.zip, MAX.zip),
    service: clean(body.service, MAX.service),
    message: clean(body.message, MAX.message),
  };

  if (!lead.name || !lead.phone) {
    return res.status(400).json({ ok: false, error: 'Name and phone are required.' });
  }

  const leadPhoneE164 = formatPhoneE164(lead.phone);
  if (!leadPhoneE164) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid phone number.' });
  }

  // ---- Build the alert ----
  const lines = [
    'NEW LEAD - Southern Beacon',
    'Name: ' + lead.name,
    'Phone: ' + lead.phone,
  ];
  if (lead.zip) lines.push('ZIP: ' + lead.zip);
  if (lead.service) lines.push('Service: ' + lead.service);
  if (lead.message) lines.push('Notes: ' + lead.message);
  const alertText = lines.join('\n');

  const recipients = alertRecipients();
  if (recipients.length === 0) {
    console.error('No alert recipients configured (NOTIFY_PHONE_ADMIN / NOTIFY_PHONE_OWNER)');
  }

  const results = await Promise.all(
    recipients.map(async function (to) {
      const r = await sendTelnyxSMS(to, alertText);
      return Object.assign({ to: to }, r);
    })
  );

  const delivered = results.filter(function (r) { return r.success; }).length;
  console.log('Lead received from ' + lead.name + '. SMS delivered to ' + delivered + '/' + recipients.length + ' recipients.');

  // ---- Optional confirmation text to the submitter ----
  if (String(process.env.LEAD_AUTOREPLY).toLowerCase() === 'true') {
    await sendTelnyxSMS(
      leadPhoneE164,
      'Thanks for contacting Southern Beacon Environmental. We received your request and will call you shortly. For anything urgent, call (470) 760-5249. Reply STOP to opt out.'
    );
  }

  // Always succeed for the visitor. A provider outage must not look like a
  // broken form; the submission is still captured in the function logs.
  return res.status(200).json({ ok: true });
};
