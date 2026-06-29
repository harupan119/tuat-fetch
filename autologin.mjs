// autologin.mjs — Keychainの認証情報＋TOTP自動生成で人手なしログイン（単体実行用）。
//   通常は fetch/materials/keepalive がセッション切れ時に自動で呼ぶので手動実行は不要。
//   --headed で画面表示してデバッグ。
import { autoLogin } from './lib.mjs';
const headed = process.argv.includes('--headed');
const ok = await autoLogin({ headless: !headed });
console.log(ok ? '✓ 自動ログイン成功' : '✗ 自動ログイン失敗');
process.exit(ok ? 0 : 1);
