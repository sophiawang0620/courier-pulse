param(
    [Parameter(Mandatory = $true)]
    [string]$Waybill,
    [string]$BaseUrl = $env:KYE_WORKER_BASE_URL
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

$normalizedWaybill = $Waybill.Trim().ToUpperInvariant()
if ($normalizedWaybill -notmatch '^(KY|KYE)[A-Z0-9]{8,20}$') {
    throw 'Invalid KYE waybill format.'
}
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    throw 'Set KYE_WORKER_BASE_URL or pass -BaseUrl with your Worker URL.'
}
if ($BaseUrl -notmatch '^https://') {
    throw 'BaseUrl must use HTTPS.'
}

$tokenPath = Join-Path $env:LOCALAPPDATA 'KyeDeliveryAlert\monitor-token.machine.dpapi.txt'
if (-not (Test-Path -LiteralPath $tokenPath)) {
    throw 'Encrypted monitor token was not found.'
}

$protectedBytes = [Convert]::FromBase64String((Get-Content -LiteralPath $tokenPath -Raw).Trim())
try {
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
}
catch {
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
}

try {
    $token = [Text.Encoding]::UTF8.GetString($plainBytes)
    $headers = @{
        Authorization = 'Bearer ' + $token
        Accept = 'application/json'
    }
    $page = Invoke-RestMethod `
        -Uri ($BaseUrl.TrimEnd('/') + '/events') `
        -Headers $headers `
        -Method Get `
        -TimeoutSec 25

    $matchingEvents = @()
    foreach ($event in @($page.events)) {
        foreach ($item in @($event.payload)) {
            if (([string]$item.mailno).Trim().ToUpperInvariant() -eq $normalizedWaybill) {
                $matchingEvents += [ordered]@{
                    receivedAt = $event.receivedAt
                    environment = $event.environment
                    mailno = $item.mailno
                    time = $item.time
                    desc = $item.desc
                    step = $item.step
                    deliveryName = $item.deliveryName
                }
            }
        }
    }
    [ordered]@{
        matching_event_count = $matchingEvents.Count
        events = $matchingEvents
    } | ConvertTo-Json -Depth 6
}
finally {
    if ($null -ne $plainBytes) {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    $token = $null
}
