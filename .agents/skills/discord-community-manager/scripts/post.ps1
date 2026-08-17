#Requires -Version 5.1
<#
.SYNOPSIS
    Post a message or embed to a Nika Code Discord channel through its webhook.

.DESCRIPTION
    Reads webhook URLs from the skill's .local/webhooks.json config and posts
    either a plain-text message (-Content) or a rich embed (-Title/-Description).
    Never prints the webhook URL (it is a secret).

.EXAMPLE
    .\post.ps1 -Channel dev-chat -Content "Pushed the BYOK provider rewrite"

.EXAMPLE
    .\post.ps1 -Channel announcements -Title "NikaCode 1.1.0" `
        -Description "What's new." -Url "https://github.com/alive2/nika-code/releases" `
        -Color green -Footer "NikaCode team"
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Channel,

    [string]$Title,
    [string]$Description,
    [string]$Url,
    [string]$Content,

    [ValidateSet('blurple', 'purple', 'blue', 'green', 'orange', 'grey', 'red')]
    [string]$Color = 'blurple',

    [string]$Footer
)

$ErrorActionPreference = 'Stop'

# Config lives next to the skill: <skill-dir>\.local\webhooks.json
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillDir = Split-Path -Parent $scriptDir
$configPath = Join-Path $skillDir '.local\webhooks.json'

if (-not (Test-Path $configPath)) {
    Write-Error "Webhook config not found: $configPath. Copy webhooks.example.json next to the skill and fill in the URLs."
    exit 1
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$webhook = $config.$Channel
if (-not $webhook) {
    $known = $config.PSObject.Properties.Name -join ', '
    Write-Error "No webhook configured for channel '$Channel'. Known channels: $known"
    exit 1
}

$colorMap = @{
    blurple = 0x5865F2
    purple  = 0x9B59B6
    blue    = 0x3498DB
    green   = 0x2ECC71
    orange  = 0xE67E22
    grey    = 0x95A5A6
    red     = 0xE74C3C
}

$body = @{}
if ($Content) {
    $body['content'] = $Content
}
if ($Title -or $Description -or $Url) {
    $embed = @{}
    if ($Title) { $embed['title'] = $Title }
    if ($Description) { $embed['description'] = $Description }
    if ($Url) { $embed['url'] = $Url }
    $embed['color'] = $colorMap[$Color]
    if ($Footer) { $embed['footer'] = @{ text = $Footer } }
    $body['embeds'] = @($embed)
}

if (-not $body.ContainsKey('content') -and -not $body.ContainsKey('embeds')) {
    Write-Error 'Nothing to send. Provide -Content or -Title/-Description.'
    exit 1
}

$json = $body | ConvertTo-Json -Depth 5 -Compress
try {
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType 'application/json' -Body $json | Out-Null
    Write-Output "Posted to #$Channel"
    exit 0
}
catch {
    Write-Error "Discord webhook failed for #$Channel : $($_.Exception.Message)"
    exit 1
}
