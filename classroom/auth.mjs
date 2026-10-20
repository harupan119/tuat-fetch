#!/usr/bin/env node
// classroom/auth.mjs — Classroom / Drive API の OAuth 同意フロー（初回1回だけ）
//
//   事前準備（自分の Google Cloud プロジェクトで Classroom API / Drive API を有効にし、OAuth クライアント（デスクトップアプリ）を作る）:
//     node secret.mjs set classroom-client-id
//     node secret.mjs set classroom-client-secret
//
//   実行:
//     node classroom/auth.mjs              # 空きポートでループバック受信
//     node classroom/auth.mjs --port 3000  # redirect_uri_mismatch が出る場合、
//                                          #   OAuthクライアントに登録済みのポートを指定
//
//   ブラウザでは **大学アカウント(@st.go.tuat.ac.jp)** を選ぶこと。
//   トークン: ~/.local/share/sirius-fetch/classroom-token.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { oauthClient, SCOPES, TOKEN_PATH } from './api.mjs';
import { chromeUserDataDir, openUrl } from '../platform.mjs';

const UNIV_DOMAIN = 'st.go.tuat.ac.jp';

// 大学アカウントでログイン済みのChromeプロファイル(例 "Profile 1")を Local State から探す。
// 見つからなければ null（既定ブラウザで開く）。環境変数 CHROME_PROFILE で明示指定も可。
export function univChromeProfile() {
  if (process.env.CHROME_PROFILE) return process.env.CHROME_PROFILE;
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(chromeUserDataDir(), 'Local State'), 'utf8'));
    const hit = Object.entries(ls.profile?.info_cache || {}).find(([, v]) => (v.user_name || '').endsWith(`@${UNIV_DOMAIN}`));
    return hit ? hit[0] : null;
  } catch { return null; }
}

function openAuthUrl(url) {
  const profile = univChromeProfile();
  if (!profile) { console.log('⚠ 大学アカウントのChromeプロファイルが見つからないため既定ブラウザで開きます'); openUrl(url); return; }
  console.log(`▶ Chrome プロファイル「${profile}」で開きます`);
  openUrl(url, { chrome: true, profile });
}

if (process.argv.includes('--which-profile')) { console.log(univChromeProfile()); process.exit(0); }

const args = process.argv.slice(2);
const portArg = (() => { const i = args.indexOf('--port'); return i >= 0 ? Number(args[i + 1]) : 0; })();

const server = http.createServer();
server.listen(portArg, 'localhost', () => {
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;
  const oauth2 = oauthClient(redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',          // refresh_token を確実に受け取る
    hd: UNIV_DOMAIN,            // アカウント選択で大学ドメインを優先
    // include_granted_scopes は付けない。google-multi と同じクライアントを使うため、
    // 付けると過去に許可した Gmail 等の権限までこのトークンに入ってしまう。
  });

  console.log(`▶ redirect_uri: ${redirectUri}`);
  console.log('▶ ブラウザで大学アカウント(@st.go.tuat.ac.jp)を選んで同意してください...');
  console.log('   要求スコープ:');
  for (const s of SCOPES) console.log(`     - ${s.replace('https://www.googleapis.com/auth/', '')}`);
  openAuthUrl(authUrl);

  server.on('request', async (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>✗ 拒否されました</h1><p>${err}</p>`);
      console.error('✗ 同意が拒否されました:', err);
      server.close(); process.exit(1);
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✗ 認証コードがありません</h1>');
      return;
    }
    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        console.error('⚠ refresh_token が返りませんでした。Googleアカウントの「サードパーティ アクセス」から');
        console.error('  このアプリを削除してやり直すと確実です（毎回の再同意を避けるため必須）。');
      }
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      fs.chmodSync(TOKEN_PATH, 0o600);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✓ 認証成功</h1><p>このタブを閉じてOKです。</p>');
      console.log('✓ トークン保存完了:', TOKEN_PATH);
      console.log('  確認: node classroom/fetch.mjs');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✗ 認証失敗</h1><p>' + e.message + '</p>');
      console.error('✗ トークン取得失敗:', e.message);
    }
    server.close();
  });
});
