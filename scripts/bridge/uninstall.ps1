# Remove the Pounce bridge scheduled task installed by .\install.ps1.
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
$ErrorActionPreference = "SilentlyContinue"

$TaskName = "PounceBridge"
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

# Kill any bridge node process still holding the port (best-effort).
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*launcher.mjs*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Removed scheduled task '$TaskName'."
