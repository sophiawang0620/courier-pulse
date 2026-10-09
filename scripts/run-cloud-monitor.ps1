param(
    [switch]$CreateToken,
    [switch]$SaveTokenFromClipboard,
    [switch]$EnableAutomation,
    [string]$AckAlertId,
    [string]$BaseUrl = $env:KYE_WORKER_BASE_URL
)

$ErrorActionPreference = 'Stop'

function ConvertTo-PlainValue {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillDirectory = Split-Path -Parent $scriptDirectory
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'KyeDeliveryAlert'
$tokenPath = Join-Path $credentialDirectory 'monitor-token.dpapi.txt'
$automationTokenPath = Join-Path $credentialDirectory 'monitor-token.machine.dpapi.txt'
$statePath = Join-Path $skillDirectory '.kuayue-push-state.json'
$watchlistPath = Join-Path $skillDirectory '.kuayue-watchlist.json'
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    throw 'Python 3 was not found on PATH.'
}
else {
    $pythonExecutable = $pythonCommand.Source
}

if (@($CreateToken, $SaveTokenFromClipboard, $EnableAutomation).Where({ $_ }).Count -gt 1) {
    throw 'Use only one token setup switch at a time.'
}

if ($CreateToken) {
    $randomBytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($randomBytes)
    }
    finally {
        $generator.Dispose()
    }
    $clipboardValue = [Convert]::ToBase64String($randomBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $secureToken = ConvertTo-SecureString -String $clipboardValue -AsPlainText -Force
    New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
    ConvertFrom-SecureString $secureToken | Set-Content -LiteralPath $tokenPath -Encoding UTF8
    Remove-Item -LiteralPath $automationTokenPath -Force -ErrorAction SilentlyContinue

    $copied = $false
    for ($attempt = 1; $attempt -le 10 -and -not $copied; $attempt += 1) {
        try {
            Set-Clipboard -Value $clipboardValue -ErrorAction Stop
            $copied = $true
        }
        catch {
            Start-Sleep -Milliseconds 100
        }
    }
    $clipboardValue = $null
    if (-not $copied) {
        throw 'The token was saved, but Windows could not copy it. Run -CreateToken again.'
    }
    Write-Host 'A new monitor token is encrypted locally and copied to the clipboard.'
    Write-Host 'Paste it once into the Cloudflare secret named MONITOR_TOKEN, then deploy.'
    exit 0
}

if ($SaveTokenFromClipboard) {
    $clipboardValue = Get-Clipboard -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($clipboardValue)) {
        throw 'Clipboard token cannot be empty.'
    }
    $clipboardValue = $clipboardValue.Trim()
    if ($clipboardValue.Length -lt 32 -or $clipboardValue -match '\s') {
        throw 'Copy only one random token of at least 32 characters, with no spaces.'
    }
    $secureToken = ConvertTo-SecureString -String $clipboardValue -AsPlainText -Force
    New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
    ConvertFrom-SecureString $secureToken | Set-Content -LiteralPath $tokenPath -Encoding UTF8
    Remove-Item -LiteralPath $automationTokenPath -Force -ErrorAction SilentlyContinue
    $clipboardValue = $null
    Write-Host 'Monitor token saved with Windows DPAPI for this Windows user.'
    exit 0
}

if ($EnableAutomation) {
    if (-not (Test-Path -LiteralPath $tokenPath)) {
        throw 'Create or save the monitor token first.'
    }
    $encryptedUserToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $userSecureToken = ConvertTo-SecureString $encryptedUserToken
    $plainToken = ConvertTo-PlainValue $userSecureToken
    try {
        $plainBytes = [Text.Encoding]::UTF8.GetBytes($plainToken)
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [Convert]::ToBase64String($protectedBytes) |
            Set-Content -LiteralPath $automationTokenPath -Encoding ASCII
    }
    finally {
        if ($null -ne $plainBytes) {
            [Array]::Clear($plainBytes, 0, $plainBytes.Length)
        }
        $plainToken = $null
    }
    Write-Host 'Automation access enabled with current-user DPAPI.'
    exit 0
}

if (-not (Test-Path -LiteralPath $tokenPath) -and -not (Test-Path -LiteralPath $automationTokenPath)) {
    throw 'Monitor token is not saved. Add MONITOR_TOKEN in Cloudflare, copy its value, then run this script with -SaveTokenFromClipboard.'
}

try {
    if (Test-Path -LiteralPath $automationTokenPath) {
        $protectedBytes = [Convert]::FromBase64String(
            (Get-Content -LiteralPath $automationTokenPath -Raw).Trim()
        )
        try {
            $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
                $protectedBytes,
                $null,
                [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
        }
        catch {
            # One-time migration for files created by releases that used machine scope.
            $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
                $protectedBytes,
                $null,
                [Security.Cryptography.DataProtectionScope]::LocalMachine
            )
            $migratedBytes = [Security.Cryptography.ProtectedData]::Protect(
                $plainBytes,
                $null,
                [Security.Cryptography.DataProtectionScope]::CurrentUser
            )
            [Convert]::ToBase64String($migratedBytes) |
                Set-Content -LiteralPath $automationTokenPath -Encoding ASCII
        }
        $env:KYE_MONITOR_TOKEN = [Text.Encoding]::UTF8.GetString($plainBytes)
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    else {
        $encryptedToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
        $secureToken = ConvertTo-SecureString $encryptedToken
        $env:KYE_MONITOR_TOKEN = ConvertTo-PlainValue $secureToken
    }
    if ([string]::IsNullOrWhiteSpace($AckAlertId)) {
        if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
            throw 'Set KYE_WORKER_BASE_URL or pass -BaseUrl with your Worker URL.'
        }
        $arguments = @(
            (Join-Path $scriptDirectory 'cloud_monitor.py'),
            'check',
            '--base-url',
            $BaseUrl,
            '--state-file',
            $statePath,
            '--watchlist-file',
            $watchlistPath
        )
    }
    else {
        $arguments = @(
            (Join-Path $scriptDirectory 'cloud_monitor.py'),
            'ack',
            '--alert-id',
            $AckAlertId,
            '--state-file',
            $statePath
        )
    }
    & $pythonExecutable $arguments
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:KYE_MONITOR_TOKEN -ErrorAction SilentlyContinue
}
