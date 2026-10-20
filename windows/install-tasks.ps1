# install-tasks.ps1 — macOS の launchd 定期実行に相当するタスクを、Windows のタスクスケジューラに登録する
#   使い方（リポジトリ直下で。管理者権限は不要）:
#     powershell -ExecutionPolicy Bypass -File windows\install-tasks.ps1             # 登録（既存は上書き）
#     powershell -ExecutionPolicy Bypass -File windows\install-tasks.ps1 -Uninstall  # 削除
#     -WithMessages を付けると Sakai メッセージの監視も登録する（既定はオフ。使う科目がある人だけ）
#   ログは ~\.local\share\sirius-fetch\<タスク名>.{out,err}.log に追記する（macOS と同じ場所）。
#   資格情報マネージャーはログオン中のユーザーでしか読めないため、タスクは「ユーザーがログオンしているときのみ実行」で登録する。
param([switch]$Uninstall, [switch]$WithMessages, [string]$Prefix = 'sirius-fetch')
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  Get-ScheduledTask -TaskName "$Prefix-*" -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false
  Write-Host "✓ $Prefix-* のタスクを削除しました"
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$data = Join-Path $HOME '.local\share\sirius-fetch'
New-Item -ItemType Directory -Force $data | Out-Null
# conhost --headless でコンソール窓を出さずに走らせる（Windows 10 21H2 以降 / 11）
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'

function Register-SiriusTask([string]$Name, [string]$ScriptArgs, $Triggers, [string]$EnvSet = '') {
  $prefixEnv = if ($EnvSet) { "set $EnvSet&& " } else { '' }
  $cmd = "/c $prefixEnv`"$node`" $ScriptArgs >> `"$data\$Name.out.log`" 2>> `"$data\$Name.err.log`""
  $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless cmd.exe $cmd" -WorkingDirectory $root
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
  Register-ScheduledTask -TaskName "$Prefix-$Name" -Action $action -Trigger $Triggers -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "✓ $Prefix-$Name"
}
function Every([int]$Minutes) { New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes $Minutes) }

# 全取得: 毎日 7:00 / 19:00（launchd の com.*.sirius-fetch と同じ）
Register-SiriusTask 'fetch' 'fetch-all.mjs' @((New-ScheduledTaskTrigger -Daily -At 7:00), (New-ScheduledTaskTrigger -Daily -At 19:00))
# セッション延命: 60分ごと＋ログオン時
Register-SiriusTask 'keepalive' 'keepalive.mjs' @((Every 60), (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"))
# 出席クイズの監視: 15分ごと（平日 8:00-18:30 以外は attend.mjs 側ですぐ終わる）
Register-SiriusTask 'attend-watch' 'attend.mjs --notify' @(Every 15) 'SIRIUS_WATCH=1'
# Sakai メッセージの監視: 1分ごと（タスクスケジューラの最小間隔。英語の授業時間帯以外は messages.mjs 側ですぐ終わる）
if ($WithMessages) { Register-SiriusTask 'messages-watch' 'messages.mjs --watch' @(Every 1) }

Write-Host "登録済みのタスク: Get-ScheduledTask -TaskName '$Prefix-*'"
