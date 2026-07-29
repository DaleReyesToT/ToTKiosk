# Project Notes — Token of Trust Kiosk Demo

## What this is

A self-service kiosk demo built on Token of Trust's `kiosk-verification` recipe:
customers verify their age/identity on their own phone (via SMS link or QR
code) while the shared kiosk device never touches their ID, then continue
straight into a gated storefront ("The Candy Counter") to shop and check out.

- **Live demo:** https://xtot-kiosk-demo-eum8.onrender.com
- **Repo:** https://github.com/DaleReyesToT/ToTKiosk

## What's built

**Verification**
- Three entry points: text a verification link, show a QR code, or enter a
  code manually if the customer already has one.
- Before generating the QR (or sending the SMS), the kiosk asks the customer
  where to send a confirmation code (their own email or phone) instead of
  using a hardcoded address — Token of Trust's hosted confirmation-code step
  is locked to whatever contact is supplied at invite time, so it has to be
  something the actual customer can reach.
- Status is resolved both by polling `GET /person` and by real-time webhook
  push (SSE to the browser), whichever arrives first.
- The result screen shows Verified / Not Verified / Still Pending based on
  live `gates.isCleared` / `isRejected` / `isSubmitted`, always re-checked
  server-side — never trusted from the client.

**Storefront (unlocked only after a genuinely cleared verification)**
- Full-width two-pane layout: catalog on the left, live order summary +
  Checkout on the lower-right.
- Cart with per-item quantity steppers.
- Checkout: split name (first/middle/last), split address (house number,
  street, town, state, ZIP), Credit/Debit Card (with a card sub-form — only
  the last 4 digits + expiry ever reach the server, never the full number or
  CVV) or Cash on Delivery, and a promo-code field (demo codes: `CANDY10`,
  `SWEET20`, `WELCOME15`) with the discount applied and verified server-side.
- Itemized receipt with subtotal, discount, total, and a receipt ID.
- The store/purchase endpoints re-verify the transaction's status live,
  server-side, on every single call — the gate is enforced there, not by
  hiding a button in the UI.

**Staff view** — PIN-gated (sliding 1-hour session), lists recent sessions,
lets staff re-check any one's status independently.

## Bugs found in our own integration (fixed)

Two real bugs were found and fixed in the server's status-checking code,
independent of anything on Token of Trust's side:

1. **Wrong response path.** `GET /person`'s actual response nests everything
   under `content` (`data.content.transaction.report`) — the code read
   `data.transaction.report`, one level too shallow. `report` was always
   `undefined`, so every real check silently fell back to `"not_found"`
   regardless of the actual status.
2. **Wrong gate comparison.** `GET /person` returns each gate as an object
   (`{ value: "fullMatch", dependsOn: [...] }`), not a plain string — the code
   compared it directly against `'fullMatch'`, which can never match an
   object. This is documented in Token of Trust's own recipe as the most
   common integration bug seen in submissions.

Together, these meant a customer who actually completed real verification
would never have been recognized as cleared. Both are fixed now, using a
gate-unwrapping helper that handles both the object and plain-string shapes.

## Known issues — Token of Trust platform (not this codebase)

Reported via `feedback_submit`, reproduced multiple times across separate
sessions and real devices:

| Issue | Feedback ID |
|---|---|
| SMS invites to non-US phone numbers fail with an opaque `EmailService:problemWhileSendingSms` error, no diagnostic | `fb-1785322770682-fzoyeh` |
| QR/`urlOnly` invite's hosted confirmation-code step loops instead of advancing, even with a real, reachable invitee | `fb-1785322775051-d1nqzt` (linked to existing issue `fb-1784300430371-an5g9k`) |
| The hosted verification page's ID-upload step hangs indefinitely | `fb-1785322778224-8xtvue` |
| The short link actually delivered via SMS (`qa.tokenoftrust.com/u/...`) 404s immediately — separate bug from the working direct `urlOnly` links | `fb-1785322781299-ckr4fu` |

Because of these, we were not able to complete a real, end-to-end hosted
verification during this build. To still demonstrate and test the
storefront/checkout pipeline, we added:

## Dev-only testing path (never active in production)

Gated entirely behind `DEV_ALLOW_MOCK_VERIFICATION=true` (unset on the live
deployment and in `render.yaml`):

- A mock "customer phone" flow (`public/demo-verify.html`) that walks through
  choosing a contact method, entering a code, and "uploading" an ID photo,
  then continues straight to the store — for demoing the shape of the full
  flow.
- Its "verified" step, and the kiosk's own "Dev: simulate verified" buttons,
  call Token of Trust's **real** sandbox-only diagnostic endpoint
  (`POST /diagnostic/evaluate`, `simulateClearedVerification`) rather than
  faking anything locally — so even dev-mode testing exercises the actual,
  now-fixed status-check code path, not a shortcut around it.
- When this flag is off, `/api/kiosk/dev/force-clear` 404s and all dev UI is
  hidden — confirmed via testing that no dev-only affordance is reachable in
  a production-configured instance.

## Running it locally

```
npm install
cp .env.example .env   # fill in your own Token of Trust sandbox credentials
npm start
```

Open http://localhost:3000. See `KIOSK_DEPLOYMENT.md` for hardening notes
(Chrome kiosk mode, watchdog scripts, DevTools lockdown) when running on real
kiosk hardware — note the idle-reset, attract-loop, and result-auto-return
timers are currently flagged off in `public/kiosk.js` (they were disabling
during active manual testing) and should be re-enabled before a real
deployment.
