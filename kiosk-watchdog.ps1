# Launches Chrome in kiosk mode pointed at the local kiosk app, and relaunches
# it automatically whenever the process exits for any reason (crash, closed,
# killed). A web page cannot restart its own crashed tab/browser process -
# that has to happen at the OS level, which is what this script is for.
#
# Usage: run this script itself under a Scheduled Task set to start at logon,
# so the watchdog survives a reboot too. See KIOSK_DEPLOYMENT.md.

$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$KioskUrl = "http://localhost:3000"
$UserDataDir = "$env:LOCALAPPDATA\KioskChromeProfile"

if (-not (Test-Path $ChromePath)) {
    $ChromePath = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}

while ($true) {
    Write-Host "$(Get-Date -Format o) Starting kiosk browser..."
    Start-Process -FilePath $ChromePath -ArgumentList @(
        "--kiosk",
        "--noerrdialogs",
        "--disable-session-crashed-bubble",
        "--disable-infobars",
        "--no-first-run",
        "--overscroll-history-navigation=0",
        "--user-data-dir=`"$UserDataDir`"",
        "$KioskUrl"
    ) -Wait

    Write-Host "$(Get-Date -Format o) Chrome exited (crash or manual close) - relaunching in 2s..."
    Start-Sleep -Seconds 2
}
