// Demo-only "customer phone" preview: choose where a code goes, enter it,
// upload an ID photo, done. Nothing here is a real identity check — the code
// is generated and shown right on this page (there's no real SMS/email
// delivery to demo), and the uploaded photo is never sent anywhere, just
// previewed in the browser. The one real effect: on completion, if this page
// was opened from the kiosk's QR code (a transactionId is in the URL), it
// calls the same dev-only force-clear endpoint the kiosk's own "simulate
// verified" button uses, so the kiosk auto-advances exactly like a real
// verification would. That endpoint 404s unless the server was started with
// DEV_ALLOW_MOCK_VERIFICATION=true, so this can't do anything on a real
// deployment even if someone found this page's URL.
const screens = document.querySelectorAll('.screen');
const dots = document.querySelectorAll('.progress-dots .dot');

document.getElementById('brand-logo').addEventListener('error', () => {
  document.querySelector('.brand-header').classList.add('is-empty');
});

function show(id) {
  screens.forEach((s) => s.classList.toggle('active', s.id === id));
  const step = Number(document.getElementById(id).dataset.step || 1);
  dots.forEach((d) => {
    const n = Number(d.dataset.step);
    d.classList.toggle('active', n === step);
    d.classList.toggle('done', n < step);
  });
}

document.querySelectorAll('.btn-back').forEach((b) => {
  b.addEventListener('click', () => show(b.dataset.target));
});

const transactionId = new URLSearchParams(window.location.search).get('transactionId');

function randomDemoCode() {
  const chars = '0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ---------- Step 1: choose where the code goes ----------
let contactMethod = null;
let generatedCode = null;

document.getElementById('btn-choose-sms').addEventListener('click', () => {
  contactMethod = 'sms';
  document.getElementById('contact-input-title').textContent = 'Enter your phone number';
  document.getElementById('contact-input-label').textContent = 'Phone number';
  document.getElementById('contact-input').setAttribute('type', 'tel');
  show('screen-contact-input');
});

document.getElementById('btn-choose-email').addEventListener('click', () => {
  contactMethod = 'email';
  document.getElementById('contact-input-title').textContent = 'Enter your email';
  document.getElementById('contact-input-label').textContent = 'Email';
  document.getElementById('contact-input').setAttribute('type', 'email');
  show('screen-contact-input');
});

document.getElementById('btn-send-code').addEventListener('click', () => {
  const value = document.getElementById('contact-input').value.trim();
  const errorEl = document.getElementById('contact-input-error');
  if (!value) {
    errorEl.textContent = contactMethod === 'sms' ? 'Enter a phone number.' : 'Enter an email address.';
    return;
  }
  errorEl.textContent = '';
  generatedCode = randomDemoCode();
  // No real SMS/email is sent — this is the demo "delivery": the code is
  // shown right here instead of arriving on a separate device.
  document.getElementById('code-sent-note').textContent =
    `Demo: since nothing is really sent, here's the code that would have gone to ${value} — ${generatedCode}`;
  show('screen-code');
  document.querySelector('#otp-row .otp-box').focus();
});

// ---------- Step 2: enter the code ----------
const otpBoxes = [...document.querySelectorAll('#otp-row .otp-box')];
const codeContinueBtn = document.getElementById('btn-code-continue');

function currentOtp() {
  return otpBoxes.map((b) => b.value).join('');
}

otpBoxes.forEach((box, idx) => {
  box.addEventListener('input', () => {
    box.value = box.value.replace(/\D/g, '').slice(-1);
    if (box.value && idx < otpBoxes.length - 1) otpBoxes[idx + 1].focus();
    box.classList.toggle('filled', !!box.value);
    codeContinueBtn.disabled = currentOtp().length !== 6;
    document.getElementById('code-error').textContent = '';
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && idx > 0) otpBoxes[idx - 1].focus();
  });
});

codeContinueBtn.addEventListener('click', () => {
  if (currentOtp() !== generatedCode) {
    document.getElementById('code-error').textContent = 'That code doesn’t match — check the demo code above and try again.';
    return;
  }
  show('screen-upload-id');
});

// ---------- Step 3: upload an ID photo ----------
const idFileInput = document.getElementById('id-file-input');
const idPhoto = document.getElementById('id-photo');
const idUploadPlaceholder = document.getElementById('id-upload-placeholder');
const idSubmitBtn = document.getElementById('btn-id-submit');

document.getElementById('btn-choose-id-photo').addEventListener('click', () => idFileInput.click());

idFileInput.addEventListener('change', () => {
  const file = idFileInput.files[0];
  const errorEl = document.getElementById('id-upload-error');
  errorEl.textContent = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    errorEl.textContent = 'Please choose an image file.';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    idPhoto.src = reader.result;
    idPhoto.classList.remove('hidden');
    idUploadPlaceholder.classList.add('hidden');
    idSubmitBtn.disabled = false;
  };
  reader.readAsDataURL(file);
});

idSubmitBtn.addEventListener('click', runProcessing);

function runProcessing() {
  show('screen-processing');
  setTimeout(finishVerification, 1800);
}

// ---------- Step 4: done — clear the kiosk's transaction if we have one ----------
async function finishVerification() {
  const doneMessage = document.getElementById('done-message');
  if (!transactionId) {
    doneMessage.textContent = 'Preview complete. (No kiosk session was linked — this page was opened on its own.)';
    show('screen-done');
    return;
  }
  try {
    const res = await fetch('/api/kiosk/dev/force-clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionId }),
    });
    if (res.ok) {
      doneMessage.textContent = 'You’re verified — taking you to the store…';
      show('screen-done');
      setTimeout(() => {
        window.location.href = `/?transactionId=${encodeURIComponent(transactionId)}&openStore=1`;
      }, 1200);
      return;
    } else {
      doneMessage.textContent = 'Preview complete, but the kiosk session couldn’t be updated (dev mode may be off on the server).';
    }
  } catch {
    doneMessage.textContent = 'Preview complete, but couldn’t reach the kiosk server to update the session.';
  }
  show('screen-done');
}

document.getElementById('btn-restart').addEventListener('click', () => {
  contactMethod = null;
  generatedCode = null;
  document.getElementById('contact-input').value = '';
  document.getElementById('contact-input-error').textContent = '';
  otpBoxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
  codeContinueBtn.disabled = true;
  idPhoto.classList.add('hidden');
  idUploadPlaceholder.classList.remove('hidden');
  idFileInput.value = '';
  idSubmitBtn.disabled = true;
  show('screen-contact-choice');
});

show('screen-contact-choice');
