// platform.mjs — OS 依存の処理（認証情報・通知・ブラウザ起動・外部コマンドの場所）をここに集める。
//   macOS(darwin) と Windows(win32) に対応。どの OS でも環境変数 SIRIUS_SECRET_<名前> があればそれを優先する
//   （例: sirius-user → SIRIUS_SECRET_SIRIUS_USER）。
//
//   認証情報の保存先:
//     macOS   … Keychain（account=sirius, service=<名前>）。`security` コマンドで読む
//     Windows … 資格情報マネージャー（PasswordVault, resource=<名前>, user=sirius）。Windows PowerShell 5.1 で読む
//   登録は `node secret.mjs set <名前>`（入力は伏せ字。本人が自分のターミナルで実行する）。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
const ACCOUNT = 'sirius';

// Windows の WinRT(PasswordVault・トースト)は Windows PowerShell 5.1 でしか読めない（pwsh 7 は不可）ので powershell.exe を使う
const POWERSHELL = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
function ps(script, env = {}, opts = {}) {
  // 値はスクリプト文字列に埋め込まず環境変数で渡す（クォート崩れと注入を避ける）
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + script],
  { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, ...opts });
}
const VAULT = "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];$v=New-Object Windows.Security.Credentials.PasswordVault;";

const envKey = (service) => 'SIRIUS_SECRET_' + service.toUpperCase().replace(/[^A-Z0-9]/g, '_');

// ── 認証情報 ─────────────────────────────────────────
const cache = new Map();
// 読めなければ null
export function getSecret(service) {
  if (process.env[envKey(service)]) return process.env[envKey(service)];
  if (cache.has(service)) return cache.get(service);
  let v = null;
  try {
    if (IS_MAC) v = execFileSync('security', ['find-generic-password', '-a', ACCOUNT, '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    else if (IS_WIN) v = ps(VAULT + "$c=$v.Retrieve($env:SF_RES,$env:SF_ACC);$c.RetrievePassword();[Console]::Out.Write($c.Password)",
      { SF_RES: service, SF_ACC: ACCOUNT }, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { v = null; }
  v = v || null;
  if (v) cache.set(service, v);
  return v;
}

// 伏せ字入力で登録する（端末が対話可能なときだけ使える）。成功で true
export function setSecretInteractive(service) {
  let r;
  if (IS_MAC) r = spawnSync('security', ['add-generic-password', '-U', '-a', ACCOUNT, '-s', service, '-w'], { stdio: 'inherit' });
  else if (IS_WIN) r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', VAULT +
    "$s=Read-Host -AsSecureString $env:SF_RES;$p=[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s));" +
    "if(-not $p){Write-Error 'empty';exit 1};try{$v.Remove($v.Retrieve($env:SF_RES,$env:SF_ACC))}catch{};" +
    "$v.Add((New-Object Windows.Security.Credentials.PasswordCredential($env:SF_RES,$env:SF_ACC,$p)))"],
  { stdio: 'inherit', env: { ...process.env, SF_RES: service, SF_ACC: ACCOUNT } });
  else { console.error(`この OS では保存先がありません。環境変数 ${envKey(service)} で渡してください`); return false; }
  cache.delete(service);
  return r.status === 0;
}

// 未登録時にユーザーへ見せる登録コマンド
export function secretHint(...services) {
  return services.map((s) => `  node secret.mjs set ${s}`).join('\n') +
    `\n  （リポジトリ直下で、本人が自分のターミナルで実行。または環境変数 ${envKey(services[0])} など）`;
}
export const secretStoreName = IS_MAC ? 'Keychain' : IS_WIN ? 'Windows 資格情報マネージャー' : '環境変数';

// ── 通知 ─────────────────────────────────────────────
// open: クリックで開くファイル/URL（macOS は terminal-notifier がある時、Windows はトーストのクリックで開く）
const NOTIFIERS = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];
export function notify({ title, subtitle = '', message = '', open, group } = {}) {
  try {
    if (IS_MAC) {
      const tn = NOTIFIERS.find((p) => fs.existsSync(p));
      if (tn && open) {
        // osascript の通知は「スクリプトエディタ」名義で、その通知許可がオフだと何も出ないため terminal-notifier を優先する
        spawnSync(tn, ['-title', title, '-subtitle', subtitle, '-message', message || ' ', '-sound', 'Glass',
          ...(group ? ['-group', group] : []), '-execute', `/usr/bin/open ${JSON.stringify(open)}`], { timeout: 15_000 });
      } else {
        const q = (s) => JSON.stringify(String(s));
        spawnSync('osascript', ['-e', `display notification ${q(message)} with title ${q(title)}${subtitle ? ` subtitle ${q(subtitle)}` : ''} sound name "Glass"`], { timeout: 15_000 });
      }
    } else if (IS_WIN) {
      const launch = open ? (/^[a-z]+:\/\//i.test(open) ? open : 'file:///' + open.replace(/\\/g, '/')) : '';
      ps("[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];" +
        "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];" +
        "$e={param($s)[Security.SecurityElement]::Escape($s)};" +
        "$a=if($env:SF_OPEN){\" activationType='protocol' launch='$(& $e $env:SF_OPEN)'\"}else{''};" +
        "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;" +
        "$x.LoadXml(\"<toast$a><visual><binding template='ToastGeneric'><text>$(& $e $env:SF_TITLE)</text><text>$(& $e $env:SF_SUB)</text><text>$(& $e $env:SF_MSG)</text></binding></visual></toast>\");" +
        "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';" +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show((New-Object Windows.UI.Notifications.ToastNotification $x))",
      { SF_TITLE: title, SF_SUB: subtitle, SF_MSG: message, SF_OPEN: launch }, { stdio: 'ignore', timeout: 15_000 });
    }
  } catch { /* 通知の失敗で本処理は止めない */ }
}

// ── ブラウザ ─────────────────────────────────────────
export function chromeUserDataDir() {
  if (IS_MAC) return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Google/Chrome/User Data');
  return path.join(os.homedir(), '.config/google-chrome');
}

export function findChrome() {
  if (!IS_WIN) return null;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  return roots.map((r) => path.join(r, 'Google/Chrome/Application/chrome.exe')).find((p) => fs.existsSync(p)) || null;
}

// URL（またはファイル）を開く。chrome=true なら Google Chrome で、profile 指定時はそのプロファイルで開く
export function openUrl(url, { chrome = false, profile, newInstance = false } = {}) {
  const fail = (e) => e && console.log('  ブラウザ起動失敗:', e.message);
  let cmd, args;
  if (IS_MAC) {
    cmd = 'open';
    if (!chrome) args = [url];
    else if (profile) args = ['-na', 'Google Chrome', '--args', `--profile-directory=${profile}`, url];
    else args = [newInstance ? '-na' : '-a', 'Google Chrome', url];
  } else if (IS_WIN) {
    const exe = chrome ? findChrome() : null;
    if (exe) { cmd = exe; args = [...(profile ? [`--profile-directory=${profile}`] : []), url]; }
    else { cmd = 'rundll32.exe'; args = ['url.dll,FileProtocolHandler', url]; } // 既定ブラウザ（cmd の start は & を含むURLで壊れるため使わない）
  } else { cmd = 'xdg-open'; args = [url]; }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', fail);
  child.unref();
}

// ── 外部コマンド ─────────────────────────────────────
// Python（pypdf 等を入れたもの）。launchd/タスクスケジューラ下でも見つかるよう macOS は Homebrew を優先
export function pythonBin() {
  if (process.env.SIRIUS_PYTHON) return process.env.SIRIUS_PYTHON;
  if (IS_MAC) return ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => fs.existsSync(p)) || 'python3';
  return IS_WIN ? 'python' : 'python3';
}
