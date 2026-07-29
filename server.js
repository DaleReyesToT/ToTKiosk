import express from 'express';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logSession, updateSessionStatus, getRecentSessions, getPendingCount } from './db.js';

dotenv.config();

const {
  TOT_API_KEY,
  TOT_SECRET_KEY,
  TOT_APP_DOMAIN,
  TOT_API_BASE_URL = 'https://qa.tokenoftrust.com/api',
  TOT_RETURN_URL = 'https://tokenoftrust.kiosk.com/thanks',
  PUBLIC_BASE_URL,
  STAFF_PIN = '0118',
  PORT = 3000,
  DEV_ALLOW_MOCK_VERIFICATION,
} = process.env;

if (!TOT_API_KEY || !TOT_SECRET_KEY || !TOT_APP_DOMAIN) {
  console.warn('Missing TOT_API_KEY / TOT_SECRET_KEY / TOT_APP_DOMAIN in .env — API calls will fail.');
}

// DEV-ONLY escape hatch: lets a local developer force a transaction to
// "cleared" without a real Token of Trust verification, for exercising the
// store/purchase gate when the hosted verification flow itself is unusable
// (e.g. sandbox outage). Off unless explicitly enabled — NEVER set this on a
// real deployment, since it lets anyone skip the actual age/identity gate.
const devMockVerificationEnabled = DEV_ALLOW_MOCK_VERIFICATION === 'true';
if (devMockVerificationEnabled) {
  console.warn('DEV_ALLOW_MOCK_VERIFICATION is enabled — verification can be faked via /api/kiosk/dev/force-clear. Do not enable this in production.');
}
const devForcedCleared = new Set();

if (!/^\d{4}$/.test(STAFF_PIN)) {
  console.warn('STAFF_PIN is not exactly 4 digits — the staff view will be unreachable until it is fixed in .env.');
}

// Staff auth: a fixed shared PIN (STAFF_PIN) traded for a session token.
// This is a SLIDING idle timeout, not a fixed session length — every
// authenticated request renews it, so staff switching windows/tabs (or just
// not touching the staff view for a while, as long as it's under an hour)
// never gets logged out. Only actual inactivity past the idle window does.
// Closing the browser window itself is handled client-side via sessionStorage
// instead of localStorage (see kiosk.js) — that's cleared on window close
// regardless of this server-side timer.
const STAFF_IDLE_TTL_MS = 60 * 60 * 1000; // 1 hour

const staffTokens = new Map(); // token -> lastUsedAt

function issueStaffToken() {
  const token = crypto.randomBytes(24).toString('hex');
  staffTokens.set(token, Date.now());
  return token;
}

function isValidStaffToken(token) {
  if (!token) return false;
  const lastUsedAt = staffTokens.get(token);
  if (!lastUsedAt) return false;
  if (Date.now() - lastUsedAt > STAFF_IDLE_TTL_MS) {
    staffTokens.delete(token);
    return false;
  }
  staffTokens.set(token, Date.now()); // sliding renewal
  return true;
}

function requireStaffAuth(req, res, next) {
  const token = req.get('X-Staff-Token');
  if (!isValidStaffToken(token)) {
    return res.status(401).json({ error: 'Staff authentication required' });
  }
  next();
}

// Token of Trust's servers need a publicly reachable URL to POST the
// verification-complete webhook to. localhost only works if it's tunneled
// (e.g. ngrok) — otherwise the webhook silently never arrives and the kiosk
// just relies on its polling fallback instead.
const publicBaseUrl = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
if (!PUBLIC_BASE_URL) {
  console.warn(
    `PUBLIC_BASE_URL not set — webhook URL defaults to ${publicBaseUrl}, which Token of Trust cannot reach unless tunneled. Falling back to polling only.`
  );
}

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

// Transaction id -> Set of open SSE responses waiting on that transaction.
const sseSubscribers = new Map();

function notifySubscribers(transactionId, status) {
  const subs = sseSubscribers.get(transactionId);
  if (!subs || subs.size === 0) return;
  const payload = JSON.stringify({ status });
  for (const res of subs) {
    res.write(`data: ${payload}\n\n`);
  }
  // Only tear down the subscription on a terminal status — Token of Trust may
  // ping the webhook more than once as verification progresses (e.g.
  // submitted, then cleared), and an intermediate ping shouldn't stop the
  // stream from delivering the final one.
  if (status === 'cleared' || status === 'rejected') {
    sseSubscribers.delete(transactionId);
  }
}

// Token of Trust doesn't document the webhook payload shape, so it's treated
// purely as a "something changed, go check" ping — the actual gates always
// come from this authoritative GET /person lookup, both here and when the
// kiosk polls directly.
async function checkAndRecordStatus({ code, transactionId }) {
  // DEV-ONLY: a transaction forced via /api/kiosk/dev/force-clear short-
  // circuits straight to "cleared" — no real Token of Trust lookup happens
  // for it. Every other transaction is unaffected and still goes through the
  // real check below.
  if (devMockVerificationEnabled && transactionId && devForcedCleared.has(transactionId)) {
    updateSessionStatus(transactionId, 'cleared');
    return { status: 'cleared', raw: { dev: 'mocked' }, resolvedTransactionId: transactionId };
  }

  const params = new URLSearchParams({
    totApiKey: TOT_API_KEY,
    totSecretKey: TOT_SECRET_KEY,
    appDomain: TOT_APP_DOMAIN,
  });
  if (code) params.set('verificationAttemptId', code);
  if (transactionId) params.set('appTransactionId', transactionId);

  const totRes = await fetch(`${TOT_API_BASE_URL}/person?${params.toString()}`);
  const data = await totRes.json();
  const report = data?.transaction?.report;

  let status = 'not_found';
  if (report) {
    const gates = report.gates || {};
    if (gates.isCleared === 'fullMatch') status = 'cleared';
    else if (gates.isRejected === 'fullMatch') status = 'rejected';
    else if (gates.isSubmitted === 'fullMatch') status = 'pending_review';
    else status = 'pending';
  }

  const resolvedTransactionId = transactionId || data?.content?.appTransactionId;
  if (resolvedTransactionId) updateSessionStatus(resolvedTransactionId, status);

  return { status, raw: data, resolvedTransactionId };
}

app.post('/api/kiosk/invite', async (req, res) => {
  const { phoneNumber, givenName, mode, contactMethod, contactValue } = req.body || {};
  const appTransactionId = `kiosk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // DEV-ONLY: route the QR flow to our own demo verification page instead of
  // Token of Trust's real hosted flow — a self-contained fake (choose
  // contact method, enter a code shown right on the page, "upload" an ID),
  // not a bypass of anything real. This is what lets the full "scan QR ->
  // verify -> upload an ID" shape be demoed when the real hosted flow can't
  // be completed. Only reachable when the server was started with
  // DEV_ALLOW_MOCK_VERIFICATION=true; production keeps the real flow below.
  if (mode === 'qr' && devMockVerificationEnabled) {
    logSession({
      appTransactionId,
      mode: 'qr',
      phoneLast4: null,
      createdAt: new Date().toISOString(),
      status: 'pending',
    });
    const demoUrl = `${publicBaseUrl}/demo-verify.html?transactionId=${encodeURIComponent(appTransactionId)}`;
    const qrDataUrl = await QRCode.toDataURL(demoUrl, { margin: 1, width: 320 });
    return res.json({ appTransactionId, qrDataUrl, ttlSeconds: 300 });
  }

  const inviteOptions = {
    type: 'getVerified',
    messageTemplate: 'invite',
    appTransactionId,
    ttl: { inMinutes: 30 },
  };

  // Lets Token of Trust push a real-time "verification complete" notice
  // instead of the kiosk having to poll — only reachable if publicBaseUrl is
  // actually public (see the PUBLIC_BASE_URL warning above).
  inviteOptions.webHookUrl = `${publicBaseUrl}/api/webhooks/tot`;

  if (mode === 'qr') {
    inviteOptions.urlOnly = true;
    inviteOptions.ttl = { inMinutes: 5 };
    // The sandbox schema requires a non-empty `invitee` even when urlOnly is
    // true, and the hosted verification page's confirmation-code step is
    // locked to this exact address — so it must be the actual customer's own
    // email/phone (collected on screen-qr-contact before we get here), never
    // an address we control, or they'd have no way to receive that code.
    if (contactMethod === 'sms') {
      if (!contactValue) return res.status(422).json({ error: 'contactValue (phone) is required for QR mode' });
      inviteOptions.invitee = { phoneNumber: contactValue };
    } else {
      if (!contactValue) return res.status(422).json({ error: 'contactValue (email) is required for QR mode' });
      inviteOptions.invitee = { email: contactValue };
    }
  } else {
    if (!phoneNumber) {
      return res.status(422).json({ error: 'phoneNumber is required for SMS mode' });
    }
    inviteOptions.invitee = { phoneNumber, ...(givenName ? { givenName } : {}) };
    // Required by the sandbox for delivered (non-urlOnly) invites, even though
    // the kiosk itself has nowhere meaningful to redirect back to.
    inviteOptions.onAfterInviteAcceptedUrl = TOT_RETURN_URL;
  }

  try {
    const totRes = await fetch(`${TOT_API_BASE_URL}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totApiKey: TOT_API_KEY,
        totSecretKey: TOT_SECRET_KEY,
        appDomain: TOT_APP_DOMAIN,
        inviteOptions,
      }),
    });
    const data = await totRes.json();

    if (!totRes.ok || (data?.content?.status && data.content.status >= 400)) {
      // DEV-ONLY: real SMS delivery can fail for reasons entirely outside this
      // app (e.g. the sandbox not supporting a given destination country).
      // When that's the point of testing — exercising the rest of the flow
      // via the dev "simulate verified" bypass — let the customer through to
      // the waiting screen anyway rather than dead-ending here. QR mode is
      // excluded: it needs a real verificationUrl to render a QR code at all.
      if (devMockVerificationEnabled && mode !== 'qr') {
        logSession({
          appTransactionId,
          mode: 'sms',
          phoneLast4: phoneNumber ? phoneNumber.slice(-4) : null,
          createdAt: new Date().toISOString(),
          status: 'pending',
        });
        return res.json({ appTransactionId, devSmsDeliveryFailed: true });
      }
      return res.status(totRes.status === 200 ? 502 : totRes.status).json({
        error: data?.content?.message || 'Invite failed',
        raw: data,
      });
    }

    const verificationUrl = data.content.verificationUrl;

    logSession({
      appTransactionId,
      mode: mode === 'qr' ? 'qr' : 'sms',
      phoneLast4: phoneNumber ? phoneNumber.slice(-4) : null,
      createdAt: new Date().toISOString(),
      status: 'pending',
    });

    const payload = { appTransactionId };

    if (mode === 'qr') {
      payload.qrDataUrl = await QRCode.toDataURL(verificationUrl, { margin: 1, width: 320 });
      payload.ttlSeconds = inviteOptions.ttl.inMinutes * 60;
    }

    res.json(payload);
  } catch (err) {
    if (devMockVerificationEnabled && mode !== 'qr') {
      logSession({
        appTransactionId,
        mode: 'sms',
        phoneLast4: phoneNumber ? phoneNumber.slice(-4) : null,
        createdAt: new Date().toISOString(),
        status: 'pending',
      });
      return res.json({ appTransactionId, devSmsDeliveryFailed: true });
    }
    res.status(502).json({ error: 'Could not reach Token of Trust', detail: String(err) });
  }
});

app.get('/api/kiosk/status', async (req, res) => {
  const { code, transactionId } = req.query;
  if (!code && !transactionId) {
    return res.status(422).json({ error: 'code or transactionId is required' });
  }

  try {
    const { status, raw, resolvedTransactionId } = await checkAndRecordStatus({ code, transactionId });
    // The raw Token of Trust response can include verification report detail
    // beyond what a customer-facing client should see — log it server-side
    // for debugging, but only ever send the derived status to the browser.
    console.debug('[status check]', { code, transactionId, status, raw });
    res.json({ status, transactionId: resolvedTransactionId || transactionId || null });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Token of Trust', detail: String(err) });
  }
});

// Demo storefront gated behind verification. The catalog and purchase routes
// both re-check status live against Token of Trust on every call — the kiosk
// never trusts a client-supplied "I'm cleared" claim, since that'd be trivial
// to fake from devtools. This is what actually gates access/purchase, as
// opposed to the result screen, which only ever displays that status.
const STORE_CATALOG = [
  { id: 'gummy-bears', name: 'Gummy Bears (bag)', price: '$2.99', emoji: '🐻' },
  { id: 'chocolate-bar', name: 'Chocolate Bar', price: '$1.99', emoji: '🍫' },
  { id: 'sour-belts', name: 'Sour Belts', price: '$2.49', emoji: '🍬' },
  { id: 'lollipop-assortment', name: 'Lollipop Assortment (6-pack)', price: '$3.49', emoji: '🍭' },
  { id: 'cotton-candy', name: 'Cotton Candy Tub', price: '$4.99', emoji: '🍥' },
  { id: 'soda-can', name: 'Soda (12oz can)', price: '$1.79', emoji: '🥤' },
  { id: 'novelty-mug', name: 'Novelty Mug', price: '$6.99', emoji: '☕' },
];

function priceToCents(priceStr) {
  return Math.round(parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) * 100);
}

function centsToPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

async function resolveGate(transactionId) {
  const { status } = await checkAndRecordStatus({ transactionId });
  return status;
}

app.get('/api/kiosk/store', async (req, res) => {
  const { transactionId } = req.query;
  if (!transactionId) return res.status(422).json({ error: 'transactionId is required' });

  try {
    const status = await resolveGate(transactionId);
    if (status !== 'cleared') {
      return res.status(403).json({ error: 'Verification not complete', status });
    }
    res.json({ catalog: STORE_CATALOG });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Token of Trust', detail: String(err) });
  }
});

const PAYMENT_METHODS = new Set(['card', 'cash']);

// Demo promo codes — flat percent off the subtotal. Validated fresh on both
// the /promo/validate preview call and again at purchase time, same
// "never trust a client-supplied number" pattern as the cart prices below.
const PROMO_CODES = { CANDY10: 10, SWEET20: 20, WELCOME15: 15 };

app.post('/api/kiosk/promo/validate', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const discountPercent = PROMO_CODES[code];
  // A code just not existing is a normal validation outcome, not a server
  // error — 200 with valid:false, not a 4xx that'd show up as a console error.
  if (!discountPercent) return res.json({ valid: false, error: 'Invalid promo code' });
  res.json({ valid: true, code, discountPercent });
});

function isValidCustomer(customer) {
  if (!customer) return false;
  const { firstName, lastName, email, phone, address, paymentMethod, card } = customer;
  if (!firstName || !lastName || !email || !phone) return false;
  if (!address || !address.houseNumber || !address.street || !address.town || !address.state || !address.zip) return false;
  if (!PAYMENT_METHODS.has(paymentMethod)) return false;
  if (paymentMethod === 'card') {
    if (!card || !/^\d{4}$/.test(card.last4) || !/^\d{2}\/\d{2}$/.test(card.expiry || '')) return false;
    const [mm, yy] = card.expiry.split('/').map(Number);
    if (mm < 1 || mm > 12) return false;
    const expiryDate = new Date(2000 + yy, mm); // first day of the month *after* expiry
    if (expiryDate <= new Date()) return false;
  }
  return true;
}

app.post('/api/kiosk/purchase', async (req, res) => {
  const { transactionId, items, customer, promoCode } = req.body || {};
  if (!transactionId || !Array.isArray(items) || items.length === 0) {
    return res.status(422).json({ error: 'transactionId and a non-empty items array are required' });
  }
  if (!isValidCustomer(customer)) {
    return res.status(422).json({ error: 'Complete name, address, contact, and payment details are required' });
  }

  try {
    const status = await resolveGate(transactionId);
    if (status !== 'cleared') {
      return res.status(403).json({ error: 'Verification not complete', status });
    }

    // Prices/totals are computed here, from the server's own catalog, never
    // from client-supplied amounts — the cart only ever tells us item + qty.
    const lines = [];
    for (const { itemId, quantity } of items) {
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 1) {
        return res.status(422).json({ error: `Invalid quantity for ${itemId}` });
      }
      const product = STORE_CATALOG.find((p) => p.id === itemId);
      if (!product) return res.status(404).json({ error: `Unknown item: ${itemId}` });
      const unitCents = priceToCents(product.price);
      lines.push({ id: product.id, name: product.name, quantity: qty, lineTotalCents: unitCents * qty });
    }
    const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);

    const normalizedPromo = promoCode ? String(promoCode).trim().toUpperCase() : null;
    const discountPercent = normalizedPromo ? PROMO_CODES[normalizedPromo] || 0 : 0;
    const discountCents = Math.round(subtotalCents * (discountPercent / 100));
    const totalCents = subtotalCents - discountCents;

    const fullName = [customer.firstName, customer.middleName, customer.lastName].filter(Boolean).join(' ');

    // Demo only — no real payment processor wired up behind this, and
    // customer/card details are only ever echoed back for the receipt, never
    // persisted (this is a candy counter demo, not a real order system). Only
    // the card's last 4 digits ever reach this endpoint — never a full PAN or
    // CVV, which the client never sends in the first place.
    res.json({
      receiptId: `rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      items: lines.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, lineTotal: centsToPrice(l.lineTotalCents) })),
      subtotal: centsToPrice(subtotalCents),
      discountPercent,
      discount: centsToPrice(discountCents),
      total: centsToPrice(totalCents),
      customer: {
        name: fullName,
        paymentMethod: customer.paymentMethod,
        cardLast4: customer.paymentMethod === 'card' ? customer.card.last4 : null,
      },
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Token of Trust', detail: String(err) });
  }
});

// Token of Trust POSTs here when a customer finishes verifying. The payload
// shape isn't documented, so this only uses it to figure out *which*
// transaction to recheck — the actual status always comes from the
// authoritative GET /person call in checkAndRecordStatus.
app.post('/api/webhooks/tot', async (req, res) => {
  res.status(200).json({ received: true });

  const body = req.body || {};
  const transactionId =
    body.appTransactionId || body.transactionId || body.content?.appTransactionId || body.data?.appTransactionId;

  if (!transactionId) {
    console.warn('Webhook payload had no recognizable transaction id, ignoring:', body);
    return;
  }

  try {
    const { status } = await checkAndRecordStatus({ transactionId });
    notifySubscribers(transactionId, status);
  } catch (err) {
    console.error('Webhook-triggered status recheck failed:', err);
  }
});

// Server-Sent Events push for a single transaction. The kiosk still polls as
// a fallback — this just resolves instantly when the webhook actually reaches
// this server (i.e. when publicBaseUrl is truly public).
app.get('/api/kiosk/events', (req, res) => {
  const { transactionId } = req.query;
  if (!transactionId) return res.status(422).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  if (!sseSubscribers.has(transactionId)) sseSubscribers.set(transactionId, new Set());
  sseSubscribers.get(transactionId).add(res);

  req.on('close', () => {
    sseSubscribers.get(transactionId)?.delete(res);
  });
});

app.post('/api/kiosk/staff-auth', (req, res) => {
  const { pin } = req.body || {};
  if (pin !== STAFF_PIN) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }
  res.json({ token: issueStaffToken(), idleTtlMs: STAFF_IDLE_TTL_MS });
});

app.get('/api/kiosk/sessions', requireStaffAuth, (req, res) => {
  res.json({ sessions: getRecentSessions() });
});

app.get('/api/kiosk/summary', (req, res) => {
  res.json({ pendingCount: getPendingCount() });
});

// Liveness check for external monitoring — e.g. a watchdog script deciding
// whether the server process itself needs restarting (separate concern from
// the browser/tab crash-recovery, which the OS/watchdog handles, not this app).
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) });
});

// DEV-ONLY. Lets the kiosk UI know whether it should offer the "simulate
// verified" shortcut at all — kept off the UI entirely unless the server was
// started with DEV_ALLOW_MOCK_VERIFICATION=true.
app.get('/api/kiosk/dev/config', (req, res) => {
  res.json({ mockVerificationEnabled: devMockVerificationEnabled });
});

// DEV-ONLY. Marks a transaction as "cleared" without any real verification.
// Disabled (404) unless DEV_ALLOW_MOCK_VERIFICATION=true — never enable that
// on a real deployment, since this would let anyone skip the actual gate.
app.post('/api/kiosk/dev/force-clear', (req, res) => {
  if (!devMockVerificationEnabled) return res.status(404).end();
  const { transactionId } = req.body || {};
  if (!transactionId) return res.status(422).json({ error: 'transactionId is required' });
  devForcedCleared.add(transactionId);
  updateSessionStatus(transactionId, 'cleared');
  notifySubscribers(transactionId, 'cleared');
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Kiosk demo running at http://localhost:${PORT}`);
});
