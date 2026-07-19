const screens = document.querySelectorAll('.screen');
const dots = document.querySelectorAll('.progress-dots .dot');

document.getElementById('brand-logo').addEventListener('error', () => {
  document.querySelector('.brand-header').classList.add('is-empty');
});

function show(id) {
  screens.forEach((s) => s.classList.toggle('active', s.id === id));
  const active = document.getElementById(id);
  const step = Number(active.dataset.step || 1);
  dots.forEach((d) => {
    const n = Number(d.dataset.step);
    d.classList.toggle('active', n === step);
    d.classList.toggle('done', n < step);
  });
  stopIdleTimer();
  if (id !== 'screen-welcome' && id !== 'screen-result') startIdleTimer();
  if (id === 'screen-welcome') startLiveCounter();
  else stopLiveCounter();
}

document.querySelectorAll('.btn-back').forEach((b) => {
  b.addEventListener('click', () => {
    stopPolling();
    show(b.dataset.target);
  });
});

// ---------- Idle auto-reset ----------
// Kiosks can't afford a customer wandering off mid-flow and blocking the
// device for the next person, so any non-welcome/result screen resets itself.
let idleTimer = null;
const IDLE_MS = 45000;

function startIdleTimer() {
  stopIdleTimer();
  idleTimer = setTimeout(() => {
    stopPolling();
    show('screen-welcome');
  }, IDLE_MS);
}

function stopIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

// ---------- Attract-loop screen ----------
// Draws customers in with an eye-catching full-screen prompt after a longer
// stretch of nobody touching the kiosk at all (separate from the shorter
// per-screen idle-reset above, which only fires mid-flow).
const attractScreen = document.getElementById('attract-screen');
const ATTRACT_IDLE_MS = 3 * 60 * 1000;
let attractTimer = null;

function startAttractTimer() {
  clearTimeout(attractTimer);
  attractTimer = setTimeout(showAttractScreen, ATTRACT_IDLE_MS);
}

function showAttractScreen() {
  // Don't interrupt staff mid-task — just push the check further out.
  if (!staffPanel.classList.contains('hidden') || !staffPinModal.classList.contains('hidden')) {
    startAttractTimer();
    return;
  }
  attractScreen.classList.remove('hidden');
}

function hideAttractScreenIfShown() {
  if (attractScreen.classList.contains('hidden')) return false;
  attractScreen.classList.add('hidden');
  stopPolling();
  show('screen-welcome');
  return true;
}

attractScreen.addEventListener('pointerdown', hideAttractScreenIfShown);

['pointerdown', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, () => {
    if (idleTimer) startIdleTimer();
    if (!hideAttractScreenIfShown()) startAttractTimer();
  });
});

startAttractTimer();

// ---------- Kiosk lockdown ----------
// Deters casual right-click/devtools access from the page itself. This is
// NOT a real security boundary on its own — a determined user can still get
// around JS-level restrictions. Actual protection belongs in the Chrome
// deployment (kiosk mode + the DeveloperToolsDisabled enterprise policy) —
// see KIOSK_DEPLOYMENT.md.
document.addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('keydown', (e) => {
  const key = e.key.toUpperCase();
  const blockCombo =
    key === 'F12' ||
    (e.ctrlKey && e.shiftKey && (key === 'I' || key === 'J' || key === 'C')) ||
    (e.ctrlKey && key === 'U');
  if (blockCombo) e.preventDefault();
});

// ---------- Live "people verifying now" counter ----------
let liveCounterInterval = null;

function startLiveCounter() {
  stopLiveCounter();
  refreshLiveCounter();
  liveCounterInterval = setInterval(refreshLiveCounter, 6000);
}

function stopLiveCounter() {
  if (liveCounterInterval) clearInterval(liveCounterInterval);
  liveCounterInterval = null;
}

async function refreshLiveCounter() {
  const el = document.getElementById('live-counter');
  try {
    const res = await fetch('/api/kiosk/summary');
    const data = await res.json();
    el.textContent = data.pendingCount > 0
      ? `${data.pendingCount} customer${data.pendingCount === 1 ? '' : 's'} verifying right now`
      : '';
  } catch {
    el.textContent = '';
  }
}

// ---------- Background status polling + real-time push ----------
// Lets the kiosk auto-advance the moment a customer finishes on their phone,
// instead of forcing them to remember and retype their code. An SSE stream
// resolves instantly when Token of Trust's webhook can actually reach the
// server (i.e. it's running somewhere public, not bare localhost); polling
// underneath is the guaranteed fallback if that connection never fires.
let pollHandle = null;
let pollEventSource = null;

function startPolling(transactionId, { onElapsed } = {}) {
  stopPolling();
  const startedAt = Date.now();
  let settled = false;

  const settle = (status) => {
    if (settled) return;
    settled = true;
    stopPolling();
    showResult(status);
  };

  const es = new EventSource(`/api/kiosk/events?transactionId=${encodeURIComponent(transactionId)}`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.status === 'cleared' || data.status === 'rejected') settle(data.status);
    } catch {
      // Malformed push — polling below still covers this transaction.
    }
  };
  pollEventSource = es;

  const tick = async () => {
    if (settled) return;
    if (onElapsed) onElapsed(Math.floor((Date.now() - startedAt) / 1000));
    try {
      const res = await fetch(`/api/kiosk/status?transactionId=${encodeURIComponent(transactionId)}`);
      const data = await res.json();
      if (data.status === 'cleared' || data.status === 'rejected') settle(data.status);
    } catch {
      // Transient network hiccup — keep polling, the next tick will retry.
    }
  };
  tick();
  pollHandle = setInterval(tick, 5000);
}

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
  if (pollEventSource) {
    pollEventSource.close();
    pollEventSource = null;
  }
}

// ---------- Welcome screen ----------
document.getElementById('btn-start-sms').addEventListener('click', () => show('screen-phone'));
document.getElementById('btn-have-code').addEventListener('click', () => show('screen-code'));
document.getElementById('btn-start-qr').addEventListener('click', startQr);

// ---------- Floating-label name field ----------
const nameField = document.getElementById('field-name');
const nameInput = document.getElementById('input-name');
const nameError = document.getElementById('field-name-error');
const NAME_PATTERN = /^[A-Za-z' -]*$/;

function validateName() {
  const ok = NAME_PATTERN.test(nameInput.value);
  nameField.classList.toggle('is-error', !ok);
  nameError.textContent = ok ? '' : 'Letters only, please.';
  return ok;
}

function resetNameField() {
  nameInput.value = '';
  nameField.classList.remove('is-active', 'is-filled', 'is-error');
  nameError.textContent = '';
}

nameInput.addEventListener('focus', () => nameField.classList.add('is-active'));
nameInput.addEventListener('blur', () => {
  nameField.classList.remove('is-active');
  nameField.classList.toggle('is-filled', !!nameInput.value);
});
nameInput.addEventListener('input', () => {
  validateName();
  nameField.classList.toggle('is-filled', !!nameInput.value);
});

// ---------- Phone entry (on-screen keypad) ----------
let phoneDigits = '';
const phoneValueEl = document.getElementById('phone-value');
const sendSmsBtn = document.getElementById('btn-send-sms');

function formatPhoneDisplay(digits) {
  const area = digits.slice(0, 3);
  const mid = digits.slice(3, 6);
  const last = digits.slice(6, 10);
  return [area, mid, last].filter(Boolean).join(' ');
}

function renderPhone() {
  phoneValueEl.textContent = formatPhoneDisplay(phoneDigits);
  sendSmsBtn.disabled = phoneDigits.length !== 10;
}

document.getElementById('keypad-phone').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-key]');
  if (!btn) return;
  const key = btn.dataset.key;
  if (key === 'clear') phoneDigits = '';
  else if (key === 'back') phoneDigits = phoneDigits.slice(0, -1);
  else if (phoneDigits.length < 10) phoneDigits += key;
  renderPhone();
});

document.getElementById('btn-send-sms').addEventListener('click', async () => {
  if (phoneDigits.length !== 10) return;
  if (!validateName()) return;
  const givenName = nameInput.value.trim();
  const phoneNumber = `+1${phoneDigits}`;

  const btn = document.getElementById('btn-send-sms');
  btn.disabled = true;
  try {
    const res = await fetch('/api/kiosk/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, givenName, mode: 'sms' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send invite');

    show('screen-sent');
    const elapsedEl = document.getElementById('sent-elapsed');
    startPolling(data.appTransactionId, {
      onElapsed: (secs) => {
        const m = Math.floor(secs / 60);
        const s = String(secs % 60).padStart(2, '0');
        elapsedEl.textContent = `Watching for your verification… ${m}:${s}`;
      },
    });
  } catch (err) {
    alert(err.message);
  } finally {
    phoneDigits = '';
    renderPhone();
    resetNameField();
  }
});

document.getElementById('btn-sent-done').addEventListener('click', () => {
  stopPolling();
  show('screen-code');
});
document.getElementById('btn-sent-idle').addEventListener('click', () => {
  stopPolling();
  show('screen-welcome');
});

// ---------- QR flow ----------
let qrCountdownInterval = null;

async function startQr() {
  show('screen-qr');
  const box = document.getElementById('qr-canvas');
  box.innerHTML = '<p>Loading…</p>';
  try {
    const res = await fetch('/api/kiosk/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'qr' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create QR invite');
    box.innerHTML = `<img src="${data.qrDataUrl}" alt="Scan to verify" />`;

    startQrCountdown(data.ttlSeconds || 300);
    startPolling(data.appTransactionId);
  } catch (err) {
    box.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function startQrCountdown(totalSeconds) {
  stopQrCountdown();
  const fill = document.getElementById('qr-countdown-fill');
  const label = document.getElementById('qr-countdown-label');
  let remaining = totalSeconds;

  const render = () => {
    const m = Math.floor(remaining / 60);
    const s = String(remaining % 60).padStart(2, '0');
    label.textContent = remaining > 0 ? `Code expires in ${m}:${s}` : 'Code expired — go back and try again';
    fill.style.width = `${Math.max(0, (remaining / totalSeconds) * 100)}%`;
    fill.classList.toggle('urgent', remaining <= 30);
  };

  render();
  qrCountdownInterval = setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) stopQrCountdown();
  }, 1000);
}

function stopQrCountdown() {
  if (qrCountdownInterval) clearInterval(qrCountdownInterval);
  qrCountdownInterval = null;
}

// ---------- Code entry (OTP boxes) ----------
const otpBoxes = [...document.querySelectorAll('.otp-box')];
const checkCodeBtn = document.getElementById('btn-check-code');

function currentOtp() {
  return otpBoxes.map((b) => b.value).join('');
}

function refreshOtpState() {
  otpBoxes.forEach((b) => b.classList.toggle('filled', !!b.value));
  checkCodeBtn.disabled = currentOtp().length !== 6;
}

otpBoxes.forEach((box, idx) => {
  box.addEventListener('input', () => {
    box.value = box.value.toUpperCase().slice(-1);
    if (box.value && idx < otpBoxes.length - 1) otpBoxes[idx + 1].focus();
    refreshOtpState();
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) {
      otpBoxes[idx - 1].focus();
    }
  });
});

document.getElementById('btn-check-code').addEventListener('click', async () => {
  const code = currentOtp();
  if (code.length !== 6) return;

  const btn = document.getElementById('btn-check-code');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/kiosk/status?code=${encodeURIComponent(code)}`);
    const data = await res.json();
    showResult(res.ok ? data.status : 'error');
  } catch {
    showResult('error');
  } finally {
    otpBoxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
    refreshOtpState();
  }
});

// ---------- Result screen ----------
const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 3.5"/></svg>',
  question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.5 2.5 0 1 1 3.9 2.1c-.9.6-1.4 1-1.4 2.1"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l10 18H2L12 3z"/><line x1="12" y1="9" x2="12" y2="14" stroke-linecap="round"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/></svg>',
};

const RESULT_COPY = {
  cleared: ['Verified', 'Access granted. Welcome!', 'status-good', 'good', ICONS.check],
  rejected: ['Not Verified', 'This code did not pass verification.', 'status-bad', 'bad', ICONS.x],
  pending_review: ['Almost there', 'Your verification is still being reviewed. Please wait and try again shortly.', 'status-neutral', 'neutral', ICONS.clock],
  pending: ['Not yet complete', 'Finish the steps on your phone, then come back with your code.', 'status-neutral', 'neutral', ICONS.clock],
  not_found: ['Code not recognized', 'Double-check the 6-character code from your phone.', 'status-neutral', 'neutral', ICONS.question],
  error: ['Something went wrong', 'Please ask a staff member for help.', 'status-bad', 'bad', ICONS.warning],
};

let resultAutoResetTimer = null;

function showResult(status) {
  stopPolling();
  const [title, message, cls, iconCls, icon] = RESULT_COPY[status] || RESULT_COPY.error;
  const titleEl = document.getElementById('result-title');
  titleEl.textContent = title;
  titleEl.className = cls;
  document.getElementById('result-message').textContent = message;

  const iconEl = document.getElementById('result-icon');
  iconEl.innerHTML = icon;
  iconEl.className = `result-icon ${iconCls}`;

  show('screen-result');

  const noteEl = document.getElementById('result-auto-note');
  let secs = 8;
  if (resultAutoResetTimer) clearInterval(resultAutoResetTimer);
  const tick = () => {
    noteEl.textContent = `Returning to start in ${secs}s…`;
    if (secs <= 0) {
      clearInterval(resultAutoResetTimer);
      show('screen-welcome');
      return;
    }
    secs -= 1;
  };
  tick();
  resultAutoResetTimer = setInterval(tick, 1000);
}

document.getElementById('btn-result-done').addEventListener('click', () => {
  if (resultAutoResetTimer) clearInterval(resultAutoResetTimer);
  show('screen-welcome');
});

// ---------- Staff panel (PIN-gated) ----------
// Uses sessionStorage, not localStorage: sessionStorage is wiped when the
// browser window/tab is actually closed, so closing and reopening always
// re-prompts for the PIN. Within a still-open window, the token is a SLIDING
// 1-hour idle timeout (renewed on every authenticated call, both here and
// server-side) — switching tabs/windows or just leaving the staff view
// closed doesn't log you out as long as you're back within the hour.
const STAFF_AUTH_STORAGE_KEY = 'totKioskStaffAuth';
const DEFAULT_STAFF_IDLE_TTL_MS = 60 * 60 * 1000;

const staffPanel = document.getElementById('staff-panel');
const staffPinModal = document.getElementById('staff-pin-modal');
const staffPinError = document.getElementById('staff-pin-error');
const pinBoxes = [...document.querySelectorAll('.pin-box')];
const staffPinSubmitBtn = document.getElementById('btn-staff-pin-submit');

function loadStaffToken() {
  try {
    const raw = sessionStorage.getItem(STAFF_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.token || !parsed.expiresAt || Date.now() > parsed.expiresAt) {
      sessionStorage.removeItem(STAFF_AUTH_STORAGE_KEY);
      return null;
    }
    return parsed.token;
  } catch {
    return null;
  }
}

function saveStaffToken(token, idleTtlMs) {
  sessionStorage.setItem(
    STAFF_AUTH_STORAGE_KEY,
    JSON.stringify({ token, expiresAt: Date.now() + (idleTtlMs || DEFAULT_STAFF_IDLE_TTL_MS) })
  );
}

// Call after every successful authenticated request to slide the client-side
// expiry hint forward in step with the server's sliding renewal.
function touchStaffToken() {
  if (!staffToken) return;
  saveStaffToken(staffToken, DEFAULT_STAFF_IDLE_TTL_MS);
}

function clearStaffToken() {
  sessionStorage.removeItem(STAFF_AUTH_STORAGE_KEY);
  staffToken = null;
}

let staffToken = loadStaffToken();

document.getElementById('btn-staff-toggle').addEventListener('click', () => {
  if (staffToken) {
    staffPanel.classList.remove('hidden');
    refreshStaff();
  } else {
    resetPinEntry();
    staffPinModal.classList.remove('hidden');
    pinBoxes[0].focus();
  }
});

document.getElementById('btn-staff-close').addEventListener('click', () => {
  staffPanel.classList.add('hidden');
});

document.getElementById('btn-staff-pin-cancel').addEventListener('click', () => {
  staffPinModal.classList.add('hidden');
});

document.getElementById('btn-staff-refresh').addEventListener('click', refreshStaff);

function resetPinEntry() {
  pinBoxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
  staffPinError.textContent = '';
  staffPinSubmitBtn.disabled = true;
}

function currentPin() {
  return pinBoxes.map((b) => b.value).join('');
}

pinBoxes.forEach((box, idx) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(-1);
    box.classList.toggle('filled', !!box.value);
    if (box.value && idx < pinBoxes.length - 1) pinBoxes[idx + 1].focus();
    staffPinSubmitBtn.disabled = currentPin().length !== 4;
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) pinBoxes[idx - 1].focus();
    if (e.key === 'Enter' && currentPin().length === 4) staffPinSubmitBtn.click();
  });
});

document.getElementById('btn-staff-pin-submit').addEventListener('click', async () => {
  const pin = currentPin();
  if (pin.length !== 4) return;
  staffPinSubmitBtn.disabled = true;
  try {
    const res = await fetch('/api/kiosk/staff-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Incorrect PIN');

    staffToken = data.token;
    saveStaffToken(data.token, data.idleTtlMs);
    staffPinModal.classList.add('hidden');
    resetPinEntry();
    staffPanel.classList.remove('hidden');
    refreshStaff();
  } catch (err) {
    staffPinError.textContent = err.message;
    pinBoxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
    pinBoxes[0].focus();
  } finally {
    staffPinSubmitBtn.disabled = currentPin().length !== 4;
  }
});

async function refreshStaff() {
  const list = document.getElementById('staff-list');
  list.innerHTML = '<li>Loading…</li>';
  const res = await fetch('/api/kiosk/sessions', {
    headers: { 'X-Staff-Token': staffToken },
  });

  if (res.status === 401) {
    clearStaffToken();
    staffPanel.classList.add('hidden');
    resetPinEntry();
    staffPinModal.classList.remove('hidden');
    return;
  }

  touchStaffToken();
  const data = await res.json();

  if (!data.sessions.length) {
    list.innerHTML = '<li>No sessions yet.</li>';
    return;
  }

  list.innerHTML = data.sessions
    .map((s) => {
      const method = s.mode === 'qr' ? 'via QR code' : 'via SMS';
      const detail = s.phoneLast4 ? `, ***${s.phoneLast4}` : '';
      return `
    <li data-id="${s.appTransactionId}">
      <span>
        <strong>Customer ${s.customerNumber}</strong><br />
        ${method}${detail} —
        <span class="s-status">${s.status}</span> —
        ${new Date(s.createdAt).toLocaleTimeString()}
      </span>
      <button class="secondary btn-check-session">Check now</button>
    </li>`;
    })
    .join('');

  list.querySelectorAll('.btn-check-session').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const li = e.target.closest('li');
      const id = li.dataset.id;
      const res = await fetch(`/api/kiosk/status?transactionId=${encodeURIComponent(id)}`);
      const data = await res.json();
      li.querySelector('.s-status').textContent = data.status;
    });
  });
}

// ---------- Initial state ----------
show('screen-welcome');
