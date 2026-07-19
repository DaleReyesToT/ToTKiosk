# Token of Trust — Kiosk Demo

Self-service kiosk that verifies multiple customers on one shared device.
Each customer completes their ID/selfie flow on their own phone; the kiosk
only ever sends invites and looks up status by code — it never blocks
waiting on one customer, so the next person can start immediately.

## Setup

```
npm install
cp .env.example .env   # fill in your Token of Trust sandbox credentials
npm start
```

Open http://localhost:3000

## Flow

1. **Welcome screen** — customer picks "text me a link" or "show me a QR code".
2. **Invite sent** — kiosk calls `POST /api/invites` server-side, then
   immediately returns to idle. Free for the next customer right away.
3. **Customer verifies on their own phone** and receives a 6-character code.
4. **Customer returns**, enters the code — kiosk calls `GET /api/person`
   to resolve it and shows Verified / Not Verified / Still Pending.
5. **Staff view** (top-right link) lists recent sessions and lets staff
   check any one's status independently — showing several customers can be
   mid-verification at the same time without interfering with each other.

Built from Token of Trust's `kiosk-verification` integration recipe
(self-service + QR-code variants).
