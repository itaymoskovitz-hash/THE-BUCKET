# Installs the daily price updater as a Windows scheduled task for the current user (no admin needed).
# Runs every day at 08:30 and also catches up after the computer was off ("start when available").
# Remove later with:  Unregister-ScheduledTask -TaskName 'TheBucket Prices' -Confirm:$false

$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:LOCALAPPDATA 'TheBucket'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Script = Join-Path $Dir 'update-prices.ps1'
Copy-Item -Force -Path (Join-Path $PSScriptRoot 'update-prices.ps1') -Destination $Script

$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
$triggers = @((New-ScheduledTaskTrigger -Daily -At '08:30'), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'TheBucket Prices' -Action $action -Trigger $triggers -Settings $settings -Description 'The Bucket: daily Victory price update' -Force | Out-Null
Write-Host "Installed. Script: $Script"
Write-Host "Running it once now..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script
