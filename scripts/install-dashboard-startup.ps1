$ErrorActionPreference = 'Stop'

$skillDirectory = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dashboardScript = Join-Path $skillDirectory 'local_app.py'
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    throw 'Python was not found on PATH.'
}

$taskName = 'KYE Delivery Dashboard'
$action = New-ScheduledTaskAction `
    -Execute $pythonCommand.Source `
    -Argument ('"' + $dashboardScript + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal `
    -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts the localhost-only KYE delivery dashboard after this Windows user logs in.' `
    -Force | Out-Null

Write-Host 'Dashboard startup is installed for this Windows user.'
Write-Host 'After the next login, open http://127.0.0.1:8765'
