# install-native-host.ps1 — 自動ログイン Chrome 拡張の Native Messaging host を Windows に登録する
#   使い方（リポジトリ直下で。管理者権限は不要）:
#     powershell -ExecutionPolicy Bypass -File windows\install-native-host.ps1 -ExtensionId <chrome://extensions に出る拡張ID>
#   ホスト名は chrome-ext/background.js の NATIVE_HOST から読む（-HostName で上書き可）。
#   Windows の Chrome は HKCU\Software\Google\Chrome\NativeMessagingHosts\<ホスト名> の既定値に書いたマニフェストを読む。
param([Parameter(Mandatory = $true)][string]$ExtensionId, [string]$HostName = '')
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$ext = Join-Path $root 'chrome-ext'
if (-not $HostName) {
  $m = Select-String -Path (Join-Path $ext 'background.js') -Pattern "NATIVE_HOST\s*=\s*'([^']+)'" | Select-Object -First 1
  if (-not $m) { throw 'background.js から NATIVE_HOST を読めません。-HostName を指定してください' }
  $HostName = $m.Matches[0].Groups[1].Value
}

$dir = Join-Path $env:LOCALAPPDATA 'sirius-fetch'
New-Item -ItemType Directory -Force $dir | Out-Null
$manifest = Join-Path $dir "$HostName.json"
$json = [ordered]@{
  name            = $HostName
  description     = 'SIRIUS login credential provider (Credential Manager + TOTP)'
  path            = (Join-Path $ext 'native-host.cmd')
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
# Chrome は BOM 付き JSON を読めないことがあるので BOM なし UTF-8 で書く
[IO.File]::WriteAllText($manifest, $json, (New-Object Text.UTF8Encoding $false))

$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "✓ $HostName を登録しました → $manifest"
Write-Host '  Chrome を再起動してから、拡張の自動ログインを試してください。'
