$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'KYE Delivery Dashboard' -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Dashboard startup has been removed.'
