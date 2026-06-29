// sirius-fetch 共通ユーティリティ
// 設計: MFA(パスキー/OTP)があるため完全自動ログイン不可。
//       ログイン後の cookie を storageState(JSON) に保存し、120分のセッション中は再ログイン不要。
//       実行のたびに state を保存し直すので「端末記憶」cookie もローリングで延命される。
//       セッション切れ時のみ headed ブラウザで人間がログインする。
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// macOS Keychain から認証情報を読む（無ければ null）
export function keychain(service) {
  try { return execFileSync('security', ['find-generic-password', '-a', 'sirius', '-s', service, '-w'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
export function creds() {
  return { user: keychain('sirius-user'), pass: keychain('sirius-pass'), totp: keychain('sirius-totp') };
}

// TOTP(RFC6238, SHA1/30s/6桁)を生成
export function genTOTP(secret, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) {
    const v = A.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const ctr = Math.floor(t / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(ctr / 2 ** 32), 0); buf.writeUInt32BE(ctr >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1e6;
  return String(code).padStart(6, '0');
}

export const ENTRY = 'https://web.sirius.tuat.ac.jp/campusweb/';
export const SIRIUS_HOST = 'web.sirius.tuat.ac.jp';   // ログイン後のホスト
export const SSO_HOST = 'tuat.ex-tic.com';            // Extic SSO のホスト
export const DATA_DIR = path.join(os.homedir(), '.local/share/sirius-fetch');
export const STATE = path.join(DATA_DIR, 'state.json'); // 保存済みcookie(storageState)

// ブラウザ+コンテキストを起動。保存済み state があれば読み込む。
export async function launch({ headless = true, fresh = false } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const browser = await chromium.launch({ headless });
  const ctxOpts = { viewport: { width: 1280, height: 900 }, acceptDownloads: true };
  if (!fresh && fs.existsSync(STATE)) ctxOpts.storageState = STATE;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  return { browser, context, page };
}

// cookie を保存（実行のたびに呼んでローリング更新）
export async function saveState(context) {
  await context.storageState({ path: STATE });
}

export function isLoginPage(page) { return page.url().includes(SSO_HOST); }
export function isLoggedIn(page) { return page.url().includes(SIRIUS_HOST); }

export const LMS = 'https://lms.sirius.tuat.ac.jp';

// TOTP使い回し防止のため、最後に使った時間枠をモジュール内で記憶
let lastTotpStep = -1;

// 現在 Extic のログイン画面にいる前提で、3段ログイン(①ID ②PW ③TOTP)を実行。
// SIRIUS/Sakai どちらのSSOにも使える。認証画面を抜けたら true。
export async function driveExticLogin(page) {
  const { user, pass, totp } = creds();
  if (!user || !pass || !totp) { console.error('✗ Keychainに sirius-user/pass/totp が揃っていません。'); return false; }
  const dbg = process.env.SIRIUS_DEBUG ? (m) => console.error('  [extic]', m) : () => {};
  const sub = () => page.locator('#login button[type=submit]:visible').first().click().catch(() => {});
  const deadline = Date.now() + 100000;
  const onAuth = () => /ex-tic\.com\/auth/i.test(page.url());
  const emptyVisible = async (sel) => {
    const l = page.locator(sel);
    if (!(await l.count())) return null;
    if (!(await l.first().isVisible().catch(() => false))) return null;
    const v = await l.first().inputValue().catch(() => 'x');
    return v ? null : l.first();
  };

  while (Date.now() < deadline) {
    if (!onAuth()) return true;                      // 認証画面を抜けた＝成功
    // ① ユーザー名
    const id = await emptyVisible('#login input#identifier');
    if (id) { await id.fill(user); dbg('id'); await sub(); await page.waitForTimeout(1600); continue; }
    // ② パスワード
    const pw = await emptyVisible('#login input#password');
    if (pw) { await pw.fill(pass); dbg('pw'); await sub(); await page.waitForTimeout(2600); continue; }
    // ③ 2FA: アプリOTP選択 → 新コード → 送信
    const selr = page.locator('#totp-form-selector');
    if (await selr.count() && await selr.first().isVisible().catch(() => false)) { await selr.first().click().catch(() => {}); await page.waitForTimeout(400); }
    const otp = await emptyVisible('#totp');
    if (otp) {
      let step = Math.floor(Date.now() / 1000 / 30);
      while (step === lastTotpStep) { await page.waitForTimeout(1500); step = Math.floor(Date.now() / 1000 / 30); }
      lastTotpStep = step;
      await otp.fill(genTOTP(totp)); dbg('totp');
      await page.locator('#totp-form-wrapper button[type=submit]:visible, #totp-form-wrapper input[type=submit]:visible').first().click().catch(() => otp.press('Enter'));
      await page.waitForTimeout(2600); continue;
    }
    await page.waitForTimeout(800);
  }
  return !onAuth();
}

// 認証情報＋TOTP自動生成で人手なしログイン（SIRIUS）。成功で true。
export async function autoLogin({ headless = true } = {}) {
  const dbg = process.env.SIRIUS_DEBUG ? (m) => console.error('  [autologin]', m) : () => {};
  const { browser, context, page } = await launch({ headless, fresh: true });
  try {
    let ok = false;
    for (let i = 0; i < 2 && !ok; i++) {
      dbg('=== ログイン試行 ' + (i + 1) + ' ===');
      await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      if (isLoggedIn(page) && !/auth|login/i.test(page.url())) { ok = true; break; }
      await driveExticLogin(page).catch((e) => dbg('err: ' + e.message));
      try { await page.waitForFunction(() => location.host.includes('web.sirius.tuat.ac.jp'), { timeout: 15000 }); } catch {}
      ok = isLoggedIn(page) && !/auth|login/i.test(page.url());
      dbg('結果 ok=' + ok + ' url=' + page.url());
    }
    if (ok) await saveState(context);
    await browser.close();
    return ok;
  } catch (e) {
    console.error('✗ 自動ログイン失敗:', e.message);
    await browser.close().catch(() => {});
    return false;
  }
}

// 有効セッションを取得。切れていたら自動ログイン→ダメなら対話ログイン。
export async function getSession() {
  let s = await launch({ headless: true });
  if (await ensureSession(s.page)) return s;
  await s.browser.close();
  // まず人手なし自動ログインを試す
  let ok = await autoLogin({ headless: true });
  // ダメなら headed 対話ログインにフォールバック
  if (!ok) ok = await interactiveLogin();
  if (!ok) { console.error('✗ ログインできませんでした。'); process.exit(1); }
  s = await launch({ headless: true });
  if (!(await ensureSession(s.page))) { console.error('✗ セッション確立に失敗。'); process.exit(1); }
  return s;
}

// SIRIUSのSSO経由でSakai(LMS)セッションを確立する。
// SakaiはSIRIUSと別SSOで、Exticのログイン画面に戻されることがある→その場合は自動ログインする。
export async function openSakai(page) {
  for (let i = 0; i < 2; i++) {
    await page.goto(ENTRY + 'campussquare.do?_flowId=PTW8201000-flow', { waitUntil: 'domcontentloaded' });
    try { await page.waitForFunction(() => location.host.includes('lms.sirius') || /ex-tic\.com\/auth/.test(location.href), { timeout: 12000 }); } catch {}
    if (page.url().includes('lms.sirius')) { await page.waitForTimeout(1000); return true; }
    if (/ex-tic\.com\/auth/i.test(page.url())) {
      await driveExticLogin(page).catch(() => {});
      try { await page.waitForFunction(() => location.host.includes('lms.sirius'), { timeout: 15000 }); } catch {}
      if (page.url().includes('lms.sirius')) { await page.waitForTimeout(1000); return true; }
    }
    await page.waitForTimeout(1500);
  }
  return page.url().includes('lms.sirius');
}

// headed ブラウザで人間にログインさせ、cookieを state に保存する。
// 既存セッションがあれば storageState 経由で「端末記憶」cookie も引き継ぐ。
export async function interactiveLogin() {
  const { browser, context, page } = await launch({ headless: false });
  console.log('▶ ログインが必要です。開いたブラウザでログインしてください（パスキー/OTP含む）。');
  await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (isLoggedIn(page) && !/auth|login/i.test(page.url())) {
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      break;
    }
    await page.waitForTimeout(1000);
  }
  const ok = isLoggedIn(page);
  if (ok) { await saveState(context); console.log('✓ ログイン成功・セッション保存'); }
  await browser.close();
  return ok;
}

// ポータルに入れるか検査（セッション有効性チェック）。有効なら true。
export async function ensureSession(page) {
  await page.goto(ENTRY + 'portal.do?page=main', { waitUntil: 'domcontentloaded' });
  try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
  return isLoggedIn(page) && !isLoginPage(page);
}
