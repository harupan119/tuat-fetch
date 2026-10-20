// onedrive.mjs — Sakai「授業(Lessons)」ページに貼られた OneDrive/SharePoint の資料リンクを差分取得する
//   例: 教材をSakaiリソースに置かず、Lessonsページ本文から OneDrive にリンクしている。
//   materials.mjs は Sakai リソースしか見ないので、こちらで拾う。
//
//   流れ: Sakai REST で Lessons の本文HTMLを読む → metuat-my.sharepoint.com のリンクを抽出
//         → Microsoft(@st.me.tuat.ac.jp)にログイン(大学SSO経由) → 共有リンク+download=1 で取得
//         → パスワード付きPDFは 資格情報ストア(Keychain/資格情報マネージャー)の sirius-pdfpass-<siteId> で解除して保存
//   出力: ~/Downloads/sirius-materials/<科目>/第N回/<ファイル>  (Nは本文中の直前の「#NN」見出し。無ければ科目直下)
//         「第N回」を含むパスにするのは migrate.mjs の mode:'path' で講義回フォルダへ振り分けるため。
//   台帳キー: onedrive:<共有リンクの origin+pathname>（?e= 等のクエリは毎回変わり得るので除く）
//   学期: 既定は今年度(4月始まり)のサイトのみ。SIRIUS_TERM=2026_02 等で上書き可。
import { getSession, openSakai, saveState, creds, driveExticLogin, keychain, LMS } from './lib.mjs';
import { Ledger } from './ledger.mjs';
import { execFileSync } from 'node:child_process';
import { pythonBin } from './platform.mjs';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAT_DIR = process.env.SIRIUS_MAT_DIR || path.join(os.homedir(), 'Downloads/sirius-materials');
const PY = pythonBin();   // pypdf + cryptography を入れた Python（SIRIUS_PYTHON で上書き可）
const SP_HOST = 'metuat-my.sharepoint.com';
const sanitize = s => (s || '').replace(/[\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
const unent = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const keyOneDrive = (u) => { const x = new URL(u); return `onedrive:${x.origin}${x.pathname}`; };

const now = new Date();
const term = process.env.SIRIUS_TERM || `${now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear()}_`;

const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakai(LMS)に入れませんでした。'); await browser.close(); process.exit(1); }
const api = async p => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// Lessons ページ(サブページ含む)の本文HTMLを全部集める
async function lessonHtml(siteId) {
  const top = (await api(`/direct/lessons/site/${siteId}.json`))?.lessons_collection || [];
  const seen = new Set(), htmls = [];
  const visit = async (pageId) => {
    if (seen.has(pageId)) return; seen.add(pageId);
    const items = (await api(`/direct/lessons/lesson/${pageId}.json`))?.contentsList || [];
    for (const it of items) {
      if (it.html) htmls.push(it.html);
      if (it.type === 2 && it.sakaiId) await visit(it.sakaiId);   // type 2 = サブページ
    }
  };
  for (const l of top) await visit(l.id);
  return htmls;
}

// HTMLから SharePoint リンクと、その直前の「#NN」(講義回)を取り出す
function extractLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = unent(m[1]);
    let host; try { host = new URL(href).host; } catch { continue; }
    if (host !== SP_HOST) continue;
    const before = html.slice(0, m.index).replace(/<[^>]+>/g, ' ').replace(/&#x?[0-9a-f]+;/gi, ' ');   // &#39; 等を「#39」と誤認しない
    const nums = [...before.matchAll(/#\s*(\d{1,2})\b/g)];
    out.push({ href, text: sanitize(unent(m[2].replace(/<[^>]+>/g, ''))), lecture: nums.length ? Number(nums.at(-1)[1]) : null });
  }
  return out;
}

// SharePoint 側のログイン。Microsoftのサインイン画面ならメール入力→(大学SSO)→「サインインの状態を維持」
let msReady = false;
async function ensureMicrosoft(sampleUrl) {
  if (msReady) return true;
  await page.goto(sampleUrl, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 8 && !page.url().includes(SP_HOST); i++) {
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
    const u = page.url();
    if (/ex-tic\.com\/auth/i.test(u)) { await driveExticLogin(page).catch(() => {}); continue; }
    if (/login\.microsoftonline\.com/.test(u)) {
      const email = page.locator('#i0116');
      if (await email.isVisible().catch(() => false) && !(await email.inputValue())) {
        await email.fill(creds().user.split('@')[0] + '@st.me.tuat.ac.jp');
      }
      await page.locator('#idSIButton9').click().catch(() => {});   // 「次へ」/「はい(サインイン維持)」
      await page.waitForTimeout(3000);
      continue;
    }
    await page.waitForTimeout(2000);
  }
  msReady = page.url().includes(SP_HOST);
  if (!msReady) console.error('✗ Microsoft(OneDrive)にログインできませんでした:', new URL(page.url()).host);
  return msReady;
}

// パスワード付きPDFを解除。戻り: 'plain'(元々なし) / 'decrypted' / 'failed'
function decryptPdf(file, password) {
  const code = `
import os,sys,warnings,logging
logging.disable(logging.CRITICAL); warnings.filterwarnings('ignore')
from pypdf import PdfReader,PdfWriter
src,dst=sys.argv[1],sys.argv[2]
r=PdfReader(src)
if not r.is_encrypted or r.decrypt(''): print('plain'); sys.exit(0)   # 空パスで開ける=閲覧制限だけのPDFは原本のまま
pw=os.environ.get('PDF_PASS','')
r=PdfReader(src)
if not pw or not r.decrypt(pw): print('failed'); sys.exit(0)
w=PdfWriter(clone_from=r); w.write(dst); print('decrypted')`;
  const tmp = file + '.dec';
  try {
    const res = execFileSync(PY, ['-c', code, file, tmp], { env: { ...process.env, PDF_PASS: password || '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (res === 'decrypted') renameSync(tmp, file);
    return res;
  } catch { if (existsSync(tmp)) rmSync(tmp); return 'failed'; }
}

const ledger = new Ledger();
const mem = await api('/direct/membership.json?_limit=999');   // _limit 必須(既定件数上限で現学期が隠れる)
const sites = (mem?.membership_collection || []).map(m => m.locationReference.replace('/site/', '')).filter(id => id.startsWith(term));
console.log(`▶ OneDriveリンク走査: ${sites.length}サイト (学期=${term})`);

let dl = 0, skip = 0, fail = 0;
for (const siteId of sites) {
  const links = (await lessonHtml(siteId)).flatMap(extractLinks);
  if (!links.length) continue;
  const content = await api(`/direct/content/site/${siteId}.json?_limit=9999`);
  const title = sanitize(content?.content_collection?.[0]?.title || siteId);   // materials.mjs と同じ科目フォルダ名
  const password = keychain(`sirius-pdfpass-${siteId}`);
  console.log(`\n■ ${title}  (OneDriveリンク${links.length})`);

  for (const { href, text, lecture } of links) {
    const key = keyOneDrive(href);
    if (ledger.has(key)) { skip++; continue; }
    if (!(await ensureMicrosoft(href))) { fail++; break; }
    const u = new URL(href); u.searchParams.delete('web'); u.searchParams.set('download', '1');   // web=1 が付くと download=1 より優先されHTMLが返る
    let res;
    try { res = await context.request.get(u.toString(), { timeout: 180000 }); }
    catch (e) { console.log(`  ✗ ${text}: ${e.name || e}`); fail++; continue; }
    if (!res.ok()) { console.log(`  ✗ ${text}: HTTP ${res.status()}`); fail++; continue; }
    const type = res.headers()['content-type'] || '';
    const body = Buffer.from(await res.body());
    if (/text\/html/.test(type)) {
      // ログイン済みでHTMLが返る＝フォルダ共有などファイルでないリンク。毎回再試行しないよう blocked で記録
      console.log(`  - ${text}: ファイルでないリンク(HTML)のためスキップ`);
      ledger.record(key, { status: 'blocked', reason: 'html', url: href, source: 'onedrive' });
      continue;
    }
    let name = text || path.basename(decodeURIComponent(u.pathname));
    if (!path.extname(name) && /pdf/.test(type)) name += '.pdf';
    const dir = lecture ? path.join(MAT_DIR, title, `第${lecture}回`) : path.join(MAT_DIR, title);
    mkdirSync(dir, { recursive: true });   // 新規DL時のみ作成（直下を汚さない）
    const dest = path.join(dir, name);
    writeFileSync(dest, body);
    let pdf = '';
    if (body.subarray(0, 5).toString() === '%PDF-') {
      pdf = decryptPdf(dest, password);
      if (pdf === 'failed') console.log(`  ⚠ ${name}: パスワード付きPDFを解除できず暗号化のまま保存（Keychain sirius-pdfpass-${siteId} を確認）`);
    }
    ledger.record(key, { status: 'done', dest, bytes: body.length, source: 'onedrive', url: href, ...(pdf === 'failed' ? { encrypted: true } : {}) });
    console.log(`  ✓ ${path.relative(path.join(MAT_DIR, title), dest)}${pdf === 'decrypted' ? '（パスワード解除済み）' : ''}`);
    dl++;
  }
}

ledger.save();
await saveState(context);   // Microsoft の cookie も state に残して次回のログインを省く
await browser.close();
console.log(`\n✓ OneDrive: DL ${dl} / スキップ${skip} / 失敗${fail}`);
process.exit(fail ? 1 : 0);
