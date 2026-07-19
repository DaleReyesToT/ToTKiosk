# Starts the kiosk server as a standalone process, independent of any
# terminal window or Claude Code session. Run via the "TotKioskServer"
# Scheduled Task (see KIOSK_DEPLOYMENT.md), not directly.

$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
Set-Location "C:\Users\DennisVicky\tot-kiosk-demo"
node server.js
