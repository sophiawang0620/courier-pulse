param(
    [Parameter(Mandatory = $true)]
    [string]$Waybill
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
$credentialPath = Join-Path (Join-Path $env:LOCALAPPDATA 'KyeDeliveryAlert') 'sandbox-credentials.dpapi.json'
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
$pythonExecutable = if ($null -ne $pythonCommand) { $pythonCommand.Source } else { $null }

if (-not (Test-Path -LiteralPath $credentialPath)) {
    throw 'Saved KYE credentials were not found.'
}
if ([string]::IsNullOrWhiteSpace($pythonExecutable)) {
    throw 'Python 3 was not found on PATH.'
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
    & $pythonExecutable (Join-Path $scriptDirectory 'diagnose_route.py') $Waybill
    exit $LASTEXITCODE
}
finally {
    Remove-Item Env:KYE_APP_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_APP_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_CUSTOMER_CODE -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_PLATFORM_FLAG -ErrorAction SilentlyContinue
}
