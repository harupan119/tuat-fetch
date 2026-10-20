#!/usr/bin/env node
// google-auth.mjs — Google Calendar API の OAuth 認証セットアップ
//
// 事前準備:
//   1. Google Cloud Console でプロジェクト作成 → Calendar API 有効化
//   2. OAuth 2.0 クライアントID（デスクトップアプリ）を作成
//   3. Keychain / 資格情報マネージャーに登録:
//      node secret.mjs set gcal-client-id
//      node secret.mjs set gcal-client-secret
//   4. node google-auth.mjs → ブラウザで認証
import { google } from 'googleapis';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { keychain } from './lib.mjs';
import { openUrl, secretHint, secretStoreName } from './platform.mjs';

const DATA = path.join(os.homedir(), '.local/share/sirius-fetch');
const TOKEN_PATH = path.join(DATA, 'google-token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

const clientId = keychain('gcal-client-id');
const clientSecret = keychain('gcal-client-secret');
if (!clientId || !clientSecret) {
  console.error(`✗ ${secretStoreName} に gcal-client-id / gcal-client-secret がありません。`);
  console.error(secretHint('gcal-client-id', 'gcal-client-secret'));
  process.exit(1);
}

const server = http.createServer();
server.listen(0, 'localhost', () => {
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  // 同期先カレンダーを所有するアカウントでログインしている Chrome プロファイルで開く（CHROME_PROFILE で指定）。
  // 別のアカウントで同意すると、そのカレンダーに書き込めないトークンになる。
  const profile = process.env.CHROME_PROFILE || 'Default';
  console.log(`▶ Chrome プロファイル「${profile}」で開きます。同期先カレンダーを所有するアカウントで認証してください...`);
  openUrl(authUrl, { chrome: true, profile });

  server.on('request', async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✗ 認証コードがありません</h1>');
      return;
    }
    try {
      const { tokens } = await oauth2.getToken(code);
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✓ 認証成功</h1><p>このタブを閉じてOKです。</p>');
      console.log('✓ トークン保存完了: ' + TOKEN_PATH);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>✗ 認証失敗</h1><p>' + e.message + '</p>');
      console.error('✗ トークン取得失敗:', e.message);
    }
    server.close();
  });
});
