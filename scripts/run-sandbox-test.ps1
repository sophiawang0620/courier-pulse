param(
    [ValidateSet('sandbox', 'prod')]
    [string]$Environment = 'sandbox',
    [switch]$Subscribe,
    [switch]$UpdateProductionCustomerCode,
    [switch]$ResetCredentials
)

$ErrorActionPreference = 'Stop'

function Read-PrivateClipboardValue {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    Write-Host $Prompt
    Read-Host 'After copying the value, press Enter here (do not paste)' | Out-Null
    $clipboardValue = $null
    try {
        $clipboardValue = Get-Clipboard -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($clipboardValue)) {
            throw "$Prompt clipboard value cannot be empty."
        }

        $clipboardValue = $clipboardValue.Trim()
        if ($clipboardValue -match "`r|`n") {
            throw "$Prompt clipboard contains multiple lines. Copy only the value."
        }
        if ($clipboardValue -match '\s') {
            throw "$Prompt clipboard contains whitespace. Copy only the value, not a command or label."
        }

        return ConvertTo-SecureString -String $clipboardValue -AsPlainText -Force
    }
    finally {
        $clipboardValue = $null
    }
}

function ConvertTo-PlainValue {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        return $plainValue
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'KyeDeliveryAlert'
$credentialPath = Join-Path $credentialDirectory 'sandbox-credentials.dpapi.json'
$exitCode = 1
$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $pythonCommand) {
    throw 'Python 3 was not found on PATH.'
}
else {
    $pythonExecutable = $pythonCommand.Source
}

try {
    if ($ResetCredentials -and (Test-Path -LiteralPath $credentialPath)) {
        Remove-Item -LiteralPath $credentialPath -Force
    }

    if (Test-Path -LiteralPath $credentialPath) {
        $saved = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json
        $appKeySecure = ConvertTo-SecureString $saved.appKey
        $appSecretSecure = ConvertTo-SecureString $saved.appSecret
        $platformFlagSecure = ConvertTo-SecureString $saved.platformFlag
        if ($Environment -eq 'prod') {
            $hasProductionCustomerCode =
                $saved.PSObject.Properties.Name -contains 'prodCustomerCode' -and
                -not [string]::IsNullOrWhiteSpace($saved.prodCustomerCode)
            if ($UpdateProductionCustomerCode -or -not $hasProductionCustomerCode) {
                Write-Host 'A separate production customerCode is required.'
                $customerCodeSecure = Read-PrivateClipboardValue 'Copy production customerCode now.'
                $encryptedProductionCustomerCode = ConvertFrom-SecureString $customerCodeSecure
                if ($saved.PSObject.Properties.Name -contains 'prodCustomerCode') {
                    $saved.prodCustomerCode = $encryptedProductionCustomerCode
                }
                else {
                    $saved | Add-Member -NotePropertyName prodCustomerCode -NotePropertyValue $encryptedProductionCustomerCode
                }
                $saved | ConvertTo-Json | Set-Content -LiteralPath $credentialPath -Encoding UTF8
                Write-Host 'Production customerCode saved with Windows DPAPI.'
            }
            else {
                $customerCodeSecure = ConvertTo-SecureString $saved.prodCustomerCode
            }
        }
        else {
            $customerCodeSecure = ConvertTo-SecureString $saved.customerCode
        }
        Write-Host 'Using credentials encrypted for the current Windows user.'
    }
    else {
        Write-Host 'For each field: copy only its value, return here, and press Enter. Do not paste.'
        $appKeySecure = Read-PrivateClipboardValue 'Copy AppKey now.'
        $appSecretSecure = Read-PrivateClipboardValue 'Copy AppSecret now.'
        $customerCodeSecure = Read-PrivateClipboardValue 'Copy sandbox customerCode now.'
        $platformFlagSecure = Read-PrivateClipboardValue 'Copy sandbox platformFlag now.'

        New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
        [ordered]@{
            version = 1
            appKey = ConvertFrom-SecureString $appKeySecure
            appSecret = ConvertFrom-SecureString $appSecretSecure
            customerCode = ConvertFrom-SecureString $customerCodeSecure
            platformFlag = ConvertFrom-SecureString $platformFlagSecure
        } | ConvertTo-Json | Set-Content -LiteralPath $credentialPath -Encoding UTF8
        Write-Host 'Credentials saved with Windows DPAPI for this Windows user only.'
    }

    $env:KYE_APP_KEY = ConvertTo-PlainValue $appKeySecure
    $env:KYE_APP_SECRET = ConvertTo-PlainValue $appSecretSecure
    $env:KYE_CUSTOMER_CODE = ConvertTo-PlainValue $customerCodeSecure
    $env:KYE_PLATFORM_FLAG = ConvertTo-PlainValue $platformFlagSecure

    $pythonArguments = @(
        (Join-Path $scriptDirectory 'kye_sandbox_test.py'),
        '--from-env',
        '--environment',
        $Environment
    )
    if ($Subscribe) {
        $pythonArguments += '--subscribe'
    }
    & $pythonExecutable $pythonArguments
    $exitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:KYE_APP_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_APP_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_CUSTOMER_CODE -ErrorAction SilentlyContinue
    Remove-Item Env:KYE_PLATFORM_FLAG -ErrorAction SilentlyContinue
}

Write-Host ''
Read-Host 'Test finished. Press Enter to close'
exit $exitCode
