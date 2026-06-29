// classroom/login.mjs — Google Classroom を自動ログイン。
//   classroom.google.com → Googleで大学メール入力→次へ → Extic(統合認証)に飛ぶ →
//   driveExticLogin が ID/パスワード/TOTP を自動処理 → Classroom到達 → cookie保存。
//   Googleは自動操作を弾くことがあるため既定は headed。--headless で無人。
import { chromium } from 'playwright';
import { driveExticLogin, keychain } from '../lib.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
fs.mkdirSync(path.dirname(STATE), { recursive: true });
const email = keychain('sirius-gmail');
if (!email) { console.error('✗ Keychainに sirius-gmail がありません。'); process.exit(1); }
const dbg = (m) => console.error('  [classroom-login]', m);

const headless = process.argv.includes('--headless');
// 本物のChromeで起動するとGoogleのbot判定(CAPTCHA)を受けにくい
let browser;
try { browser = await chromium.launch({ headless, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless }); }
const ctx = await browser.newContext(fs.existsSync(STATE) ? { storageState: STATE } : {});
const page = await ctx.newPage();

const inClassroom = () => /classroom\.google\.com/.test(page.url()) && !/accounts\.google|signin|ServiceLogin/i.test(page.url());
// 未ログインだとマーケ(edu.google.com)に飛ぶので、サインイン画面へ直接入る
const SIGNIN = 'https://accounts.google.com/AccountChooser?service=classroom&continue=' + encodeURIComponent('https://classroom.google.com/');

await page.goto(SIGNIN, { waitUntil: 'domcontentloaded' });

const deadline = Date.now() + 3 * 60 * 1000;
let lastU = '';
while (Date.now() < deadline && !inClassroom()) {
  const u = page.url();
  if (u !== lastU) { dbg('url=' + u); lastU = u; }
  try {
    if (/edu\.google\.com|workspace-for-education/i.test(u)) { dbg('マーケへ飛ばされた→サインインへ'); await page.goto(SIGNIN, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); continue; }
    if (/ex-tic\.com\/auth/i.test(u)) { dbg('Extic→自動ログイン'); await driveExticLogin(page); await page.waitForTimeout(2000); continue; }
    if (/accounts\.google\.com/i.test(u)) {
      // 別アカウント選択画面なら「別のアカウントを使用」
      const another = page.locator('text=/別のアカウントを使用|Use another account/').first();
      if (await another.isVisible().catch(() => false)) { dbg('別アカウント選択'); await another.click().catch(() => {}); await page.waitForTimeout(2000); continue; }
      // メール入力（#identifierId は type=text）。空なら自動で埋める
      const em = page.locator('#identifierId, input[name=identifier]').first();
      const emVisible = await em.isVisible().catch(() => false);
      if (emVisible && !(await em.inputValue().catch(() => 'x'))) { dbg('メール自動入力'); await em.fill(email); }
      // CAPTCHAが出ていたら自動では解けない→画面で文字入力＋次へを押してもらう
      const captcha = page.locator('#ca, input[name="ca"]').first();
      if (await captcha.isVisible().catch(() => false)) { dbg('⚠ CAPTCHA表示中。メールは入力済み。画面の文字を入れて「次へ」を押して（その後は全自動）。'); await page.waitForTimeout(3000); continue; }
      // CAPTCHA無し → 次へを自動クリック
      if (emVisible) {
        await page.locator('#identifierNext button, #identifierNext, button:has-text("次へ"), button:has-text("Next")').first().click().catch(() => {});
        await page.waitForTimeout(2800); continue;
      }
    }
  } catch (e) { dbg('err: ' + e.message); }
  await page.waitForTimeout(1500);
}

if (!inClassroom()) {
  console.error('✗ Classroom到達できず。url=' + page.url());
  const d = path.join(os.homedir(), '.local/share/sirius-fetch/inspect'); fs.mkdirSync(d, { recursive: true });
  await page.screenshot({ path: path.join(d, 'classroom-login-fail.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(d, 'classroom-login-fail.html'), await page.content().catch(() => ''));
  console.error('  画面を保存: ' + d + '/classroom-login-fail.{png,html}');
  await browser.close(); process.exit(2);
}

await ctx.storageState({ path: STATE });
console.log('✓ Classroomログイン成功・セッション保存:', STATE);
await browser.close();
