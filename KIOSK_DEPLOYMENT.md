# Deploying to real kiosk hardware

This covers the parts of kiosk hardening that can't live in the web app
itself — they're OS/browser-level concerns.

## 1. Launch Chrome in kiosk mode via the watchdog

Don't launch Chrome directly — run `kiosk-watchdog.ps1` instead. It starts
Chrome in `--kiosk` mode and relaunches it immediately if the process ever
exits, whether from a crash or someone accidentally closing it. A web page
can't restart its own crashed browser process — this has to happen one level
up, from something that's still running after the browser dies.

```powershell
powershell -ExecutionPolicy Bypass -File "C:\path\to\kiosk-watchdog.ps1"
```

**Set it up to survive a reboot too:** create a Scheduled Task that runs this
script at user logon (Task Scheduler → Create Task → Trigger: "At log on" →
Action: `powershell.exe -ExecutionPolicy Bypass -File "C:\path\to\kiosk-watchdog.ps1"`).
Set the kiosk Windows account to auto-logon so the whole chain — boot → logon →
watchdog → browser — recovers on its own after a power cycle.

**The Node server needs the same treatment.** If `server.js` crashes, the
watchdog will keep relaunching a browser that has nothing to load. Run it
under something that restarts it on failure — either a second Scheduled Task
with a restart-on-failure PowerShell loop (same pattern as the browser
watchdog), or a process manager like `pm2` (`pm2 start server.js --name
kiosk-server`, then `pm2 startup` to survive reboots).

Use `GET /api/health` from whatever's monitoring the server (the watchdog
script, an external uptime check, etc.) to confirm the app — not just the
process — is actually responding.

## 2. Disable DevTools access

The kiosk app itself blocks the common keyboard shortcuts (F12,
Ctrl+Shift+I/J/C, Ctrl+U) and right-click — but that's a deterrent, not real
security. Anyone with access to Chrome's menu, or who knows another way in,
can still get around page-level JavaScript restrictions. The actual
enforcement point is a Chrome enterprise policy, applied at the OS level.

**On the dedicated kiosk machine** (not your dev machine — this is a
machine-wide Chrome policy), create this registry value:

```
Path:  HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome
Name:  DeveloperToolsDisabled
Type:  REG_DWORD
Value: 1
```

Via PowerShell (run as Administrator, on the kiosk hardware):

```powershell
New-Item -Path "HKLM:\SOFTWARE\Policies\Google\Chrome" -Force
New-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome" -Name "DeveloperToolsDisabled" -Value 1 -PropertyType DWORD -Force
```

Restart Chrome after applying it. This disables DevTools for *all* Chrome
profiles on that machine — appropriate for a single-purpose kiosk box, not
something to apply on a shared or personal computer.

## 3. Recommended Chrome launch flags (already in the watchdog script)

- `--kiosk` — full-screen, no address bar/tabs/window chrome
- `--noerrdialogs` / `--disable-session-crashed-bubble` — no "Chrome didn't
  shut down correctly" prompts blocking the kiosk on restart
- `--disable-infobars` — no permission/notification bars stealing screen space
- `--no-first-run` — skip the first-run setup flow
- `--user-data-dir=...` — a dedicated profile, isolated from any other Chrome
  usage on the machine

## 4. What the app already handles on its own

- **Attract-loop screen** — after 3 minutes with no interaction anywhere in
  the app, a full-screen branded prompt takes over to draw customers in; any
  tap dismisses it and returns to the welcome screen.
- **Per-screen idle reset** — 45 seconds of inactivity on any in-progress
  screen (phone entry, QR, code entry) snaps back to welcome so an abandoned
  session doesn't block the next customer.
- **No text selection / right-click** — deterrents only, not a real security
  boundary (see §2 above for the actual enforcement point).
