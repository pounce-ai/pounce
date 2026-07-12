# Install the Pounce bridge from THIS bundle as a per-user Windows service via a
# Scheduled Task that runs at logon and restarts on crash. Self-contained: runs
# the launcher.mjs next to this script (only a Node.js runtime is required).
# Reversible with .\uninstall.ps1.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Optional env overrides: $env:BRIDGE_TOKEN, $env:BRIDGE_PORT
$ErrorActionPreference = "Stop"

$Dir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$Launcher = Join-Path $Dir "launcher.mjs"
$TaskName = "PounceBridge"
$Token    = if ($env:BRIDGE_TOKEN) { $env:BRIDGE_TOKEN } else { "pounce-bridge-local" }
$Port     = if ($env:BRIDGE_PORT)  { $env:BRIDGE_PORT }  else { "8099" }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Error "Node.js not found on PATH. Install it from https://nodejs.org (or 'winget install OpenJS.NodeJS.LTS'), then re-run."
  exit 1
}
$NodeExe = $node.Source
if (-not (Test-Path $Launcher)) { Write-Error "launcher.mjs not next to this script ($Launcher)"; exit 1 }

$LogDir = Join-Path $env:LOCALAPPDATA "Pounce"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir "pounce-bridge.log"

# A wrapper .cmd sets the env and self-restarts the bridge on crash (a Scheduled
# Task action can't set environment variables, and the loop keeps it alive).
$Cmd = Join-Path $Dir "run-bridge.cmd"
@"
@echo off
set "BRIDGE_TOKEN=$Token"
set "BRIDGE_PORT=$Port"
cd /d "%~dp0"
:loop
"$NodeExe" "%~dp0launcher.mjs" >> "$Log" 2>&1
timeout /t 2 /nobreak >nul
goto loop
"@ | Set-Content -Path $Cmd -Encoding ASCII

# Replace any prior task, then register: run hidden at logon, keep running.
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Cmd`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description "Pounce bridge (LAN HTTP bridge for the Pounce app)" | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed scheduled task '$TaskName'"
Write-Host "  - logs: $Log"
Write-Host "  - starts at logon, restarts on crash"
Write-Host "  - port $Port, token $Token"
Write-Host "  - pair your phone: open Pounce on the same Wi-Fi and enter this PC's LAN address"
Write-Host "  - uninstall: powershell -ExecutionPolicy Bypass -File uninstall.ps1"
