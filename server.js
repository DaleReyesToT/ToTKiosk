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
} = process.env;

if (!TOT_API_KEY || !TOT_SECRET_KEY || !TOT_APP_DOMAIN) {
  console.warn('Missing TOT_API_KEY / TOT_SECRET_KEY / TOT_APP_DOMAIN in .env — API calls will fail.');
}

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
  const { phoneNumber, givenName, mode } = req.body || {};
  const appTransactionId = `kiosk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
    // true, though nothing is ever delivered to it. A placeholder phone
    // number previously caused the hosted verification page to surface it
    // back to the customer (e.g. "confirm the last 4 digits: 0000") — a
    // placeholder email avoids that specific confusing prompt.
    inviteOptions.invitee = { email: 'kiosk-qr-noreply@tokenoftrust.kiosk.com' };
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
    res.status(502).json({ error: 'Could not reach Token of Trust', detail: String(err) });
  }
});

app.get('/api/kiosk/status', async (req, res) => {
  const { code, transactionId } = req.query;
  if (!code && !transactionId) {
    return res.status(422).json({ error: 'code or transactionId is required' });
  }

  try {
    const { status, raw } = await checkAndRecordStatus({ code, transactionId });
    // The raw Token of Trust response can include verification report detail
    // beyond what a customer-facing client should see — log it server-side
    // for debugging, but only ever send the derived status to the browser.
    console.debug('[status check]', { code, transactionId, status, raw });
    res.json({ status });
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

app.listen(PORT, () => {
  console.log(`Kiosk demo running at http://localhost:${PORT}`);
});
