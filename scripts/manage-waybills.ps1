param(
    [string[]]$Add,
    [string[]]$Remove,
    [switch]$List,
    [switch]$Interactive
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
$watchlistPath = Join-Path $skillDirectory '.kuayue-watchlist.json'
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'KyeDeliveryAlert') 'sandbox-credentials.dpapi.json'
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    throw 'Python 3 was not found on PATH.'
}
else {
    $pythonExecutable = $pythonCommand.Source
}

if ($Interactive -and -not $Add -and -not $Remove -and -not $List) {
    $entered = (Read-Host 'Enter KYE waybill number').Trim().ToUpperInvariant()
    if ([string]::IsNullOrWhiteSpace($entered)) {
        throw 'Waybill cannot be empty.'
    }
    $entered = $entered.Replace([char]0xFF0C, ' ')
    $Add = @($entered -split '[\s,]+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

$selected = @([bool]$Add, [bool]$Remove, [bool]$List).Where({ $_ }).Count
if ($selected -ne 1) {
    throw 'Choose exactly one action: -Add, -Remove, or -List.'
}

if ($List) {
    & $pythonExecutable (Join-Path $scriptDirectory 'waybill_manager.py') `
        '--watchlist-file' $watchlistPath 'list'
    exit $LASTEXITCODE
}
if ($Remove) {
    & $pythonExecutable (Join-Path $scriptDirectory 'waybill_manager.py') `
        '--watchlist-file' $watchlistPath 'remove' $Remove
    exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $credentialPath)) {
    throw 'Saved KYE credentials were not found. Run run-sandbox-test.ps1 first.'
}
$saved = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
if (-not ($saved.PSObject.Properties.Name -contains 'prodCustomerCode')) {
    throw 'Saved production customerCode was not found.'
}

try {
    $env:KYE_APP_KEY = ConvertTo-PlainValue (ConvertTo-SecureString $saved.appKey)
    $env:KYE_APP_SECRET = ConvertTo-PlainValue (ConvertTo-SecureString $saved.appSecret)
    $env:KYE_CUSTOMER_CODE = ConvertTo-PlainValue (ConvertTo-SecureString $saved.prodCustomerCode)
    $env:KYE_PLATFORM_FLAG = ConvertTo-PlainValue (ConvertTo-SecureString $saved.platformFlag)
    & $pythonExecutable (Join-Path $scriptDirectory 'waybill_manager.py') `
        '--watchlist-file' $watchlistPath 'add' $Add
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:KYE_APP_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_APP_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_CUSTOMER_CODE -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_PLATFORM_FLAG -ErrorAction SilentlyContinue
}
