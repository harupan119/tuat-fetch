// classroom/materials.mjs — Google Classroom 各コースの資料/課題の添付を差分ダウンロード。
//   保存セッション(classroom_state.json)を使い、各コースのClassworkで投稿を展開→
//   添付Driveファイル＋添付Driveフォルダ(中のファイル/ショートカットも)を収集→Drive直リンクでDL。
//   出力: ~/Downloads/sirius-materials/classroom/<コース>/
//
//   使い方:
//     node classroom/materials.mjs              # 全コース(差分DL)
//     node classroom/materials.mjs --year 2026  # タイトルに2026を含むコースのみ
//     node classroom/materials.mjs --course <id> # 指定コースのみ(複数可)
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Ledger, keyDrive, keyExternal } from '../ledger.mjs';

const ledger = new Ledger();

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
const DEST = path.join(os.homedir(), 'Downloads/sirius-materials/classroom');
if (!fs.existsSync(STATE)) { console.error('✗ 未ログイン。先に `node classroom/login.mjs`'); process.exit(1); }

const args = process.argv.slice(2);
const yearFilter = (() => { const i = args.indexOf('--year'); return i >= 0 ? args[i + 1] : null; })();
const courseFilter = args.filter((a, i) => args[i - 1] === '--course');

const sanitize = (s) => (s || 'untitled').replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless: true }); }
const ctx = await browser.newContext({ storageState: STATE });
const page = await ctx.newPage();

let totalNew = 0, totalSkip = 0, totalFail = 0, totalBlocked = 0;
const manifest = [];

// --- Driveバイナリを1件DL（確認ページ/新形式フォーム対応、DL禁止は blocked） ---
async function downloadDrive(fileId, fname, dir, docType = 'binary') {
  let url;
  if (docType === 'document') url = `https://docs.google.com/document/d/${fileId}/export?format=pdf`;
  else if (docType === 'presentation') url = `https://docs.google.com/presentation/d/${fileId}/export/pdf`;
  else if (docType === 'spreadsheets') url = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`;
  else url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

  const out = path.join(dir, fname);
  const key = keyDrive(fileId);
  const existsHere = fs.existsSync(out) && fs.statSync(out).size > 0;
  // 台帳に取得済み/取得不能、または現在地に存在ならスキップ（後者は初回バックフィル）
  if (ledger.has(key) || existsHere) {
    if (!ledger.has(key) && existsHere) ledger.record(key, { status: 'done', dest: out, bytes: fs.statSync(out).size, source: 'classroom-drive' });
    totalSkip++; console.log(`    = ${fname}`); manifest.push({ dir, file: fname, fileId, status: 'skip' }); return;
  }

  try {
    let resp = await ctx.request.get(url, { maxRedirects: 5, timeout: 180000 });
    let buf = Buffer.from(await resp.body());
    let ctype = resp.headers()['content-type'] || '';
    if (docType === 'binary' && /text\/html/.test(ctype)) {
      const html = buf.toString('utf8');
      if (/ダウンロードできません|can't be downloaded|アクセス権が必要/i.test(html)) {
        totalBlocked++; console.log(`    ⊘ ${fname}: DL不可(教員が制限/動画)`);
        ledger.record(key, { status: 'blocked', source: 'classroom-drive', note: 'DL制限/動画' });
        manifest.push({ dir, file: fname, fileId, status: 'blocked' }); return;
      }
      const action = (html.match(/action="([^"]+)"/) || [])[1];
      if (action) {
        const u = new URL(action.replace(/&amp;/g, '&'));
        for (const tag of html.match(/<input[^>]*>/g) || []) {
          const n = (tag.match(/name="([^"]*)"/) || [])[1];
          const v = (tag.match(/value="([^"]*)"/) || [])[1];
          if (n) u.searchParams.set(n, (v || '').replace(/&amp;/g, '&'));
        }
        resp = await ctx.request.get(u.toString(), { maxRedirects: 5, timeout: 180000 });
        buf = Buffer.from(await resp.body()); ctype = resp.headers()['content-type'] || '';
      }
    }
    if (/text\/html/.test(ctype)) { totalFail++; console.log(`    ✗ ${fname}: HTML応答`); manifest.push({ dir, file: fname, fileId, status: 'fail', error: 'html-response' }); return; }
    if (!resp.ok() || buf.length === 0) throw new Error('HTTP ' + resp.status() + ' len=' + buf.length);
    fs.mkdirSync(path.dirname(out), { recursive: true }); // 新規DL時のみ遅延作成（直下を汚さない）
    fs.writeFileSync(out, buf);
    ledger.record(key, { status: 'done', dest: out, bytes: buf.length, source: 'classroom-drive' });
    totalNew++; console.log(`    ↓ ${fname} (${(buf.length / 1024).toFixed(0)}KB)`);
    manifest.push({ dir, file: fname, fileId, status: 'new', bytes: buf.length });
  } catch (e) {
    totalFail++; console.log(`    ✗ ${fname}: ${e.message}`);
    manifest.push({ dir, file: fname, fileId, status: 'fail', error: e.message });
  }
}

// --- 添付Driveフォルダの中身を列挙→各ファイルをDL（ショートカットは実体へ解決） ---
async function downloadFolder(folderId, dir) {
  const fp = await ctx.newPage();
  try {
    await fp.goto(`https://drive.google.com/drive/folders/${folderId}`, { waitUntil: 'domcontentloaded' });
    await fp.waitForTimeout(5000);
    for (let i = 0; i < 6; i++) { await fp.mouse.wheel(0, 2500); await fp.waitForTimeout(700); }
    const rows = await fp.evaluate(() => {
      const out = []; const seen = new Set();
      for (const e of document.querySelectorAll('[data-id][role="row"]')) {
        const id = e.getAttribute('data-id'); if (!id || seen.has(id)) continue; seen.add(id);
        // 先頭テキスト＝ファイル名（メニュー語を除去）
        let name = (e.textContent || '').replace(/\s+/g, ' ').trim();
        name = name.replace(/\s*(共有|ダウンロード|名前を変更|スターを付ける|その他の操作|プレビュー|削除).*$/, '').trim();
        out.push({ id, name });
      }
      return out;
    });
    console.log(`    📁 フォルダ ${rows.length}件 → ${path.basename(dir)}/`);
    for (const r of rows) {
      // ショートカット/実体どちらでも /view を開いて実ファイルIDとタイトルを得る
      let realId = r.id, title = r.name;
      try {
        await fp.goto(`https://drive.google.com/file/d/${r.id}/view`, { waitUntil: 'domcontentloaded' });
        await fp.waitForTimeout(1500);
        const m = fp.url().match(/\/d\/([A-Za-z0-9_-]{20,})/);
        if (m) realId = m[1];
        const t = (await fp.title()).replace(/ - Google ドライブ$/, '').trim();
        if (t) title = t;
      } catch {}
      await downloadDrive(realId, sanitize(title), dir, 'binary');
    }
  } catch (e) { console.log(`    ✗ フォルダ ${folderId}: ${e.message}`); }
  finally { await fp.close(); }
}

// --- 1) コース一覧 ---
await page.goto('https://classroom.google.com/u/0/h', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
if (/accounts\.google|signin/i.test(page.url())) { console.error('✗ セッション切れ。`node classroom/login.mjs` で再ログインを。'); await browser.close(); process.exit(2); }

let courses = await page.evaluate(() => {
  const out = []; const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/c/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/c\/([A-Za-z0-9_-]+)/);
    if (!m || seen.has(m[1])) continue; seen.add(m[1]);
    out.push({ id: m[1], title: (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim() });
  }
  return out;
});
if (courseFilter.length) courses = courses.filter((c) => courseFilter.includes(c.id));
else if (yearFilter) courses = courses.filter((c) => c.title.includes(yearFilter));
console.log(`対象コース: ${courses.length}件`);

// --- 1タブ(授業 or ストリーム)を展開して添付を収集 ---
async function scanTab(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  for (let pass = 0; pass < 3; pass++) {
    const n = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('[role="button"][aria-expanded="false"]')];
      for (const b of btns) { try { b.click(); } catch {} }
      return btns.length;
    });
    await page.waitForTimeout(1500);
    if (!n) break;
  }
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const main = document.querySelector('[role=main]') || document.body;
    const files = []; const folders = []; const externals = [];
    const classFolderIds = new Set();
    for (const a of main.querySelectorAll('a[href*="drive.google.com/drive/folders/"]')) {
      if (/クラスのドライブ フォルダ/.test(a.getAttribute('aria-label') || '')) {
        const m = (a.getAttribute('href') || '').match(/folders\/([A-Za-z0-9_-]+)/); if (m) classFolderIds.add(m[1]);
      }
    }
    for (const a of main.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const aria = a.getAttribute('aria-label') || '';
      const fol = href.match(/drive\.google\.com\/drive\/folders\/([A-Za-z0-9_-]+)/);
      if (fol) { if (!classFolderIds.has(fol[1])) folders.push({ id: fol[1], name: aria.replace(/^添付ファイル:\s*/, '') }); continue; }
      const m = href.match(/(?:file|document|presentation|spreadsheets)\/d\/([A-Za-z0-9_-]+)/);
      if (m) {
        const mm = aria.match(/添付ファイル:\s*([^:]+):\s*(.+)$/);
        const name = mm ? mm[2].trim() : (a.textContent || m[1]).replace(/\s+/g, ' ').trim();
        let docType = 'binary';
        if (/document\/d\//.test(href)) docType = 'document';
        else if (/presentation\/d\//.test(href)) docType = 'presentation';
        else if (/spreadsheets\/d\//.test(href)) docType = 'spreadsheets';
        files.push({ fileId: m[1], name, docType });
        continue;
      }
      // 外部ストレージ/直リンク(Dropbox/OneDrive/Box/直.pdf等)。Google系は除外
      if (/^https?:/.test(href) && !/google\.com|gstatic|youtube/.test(href) &&
          /dropbox\.com|onedrive|1drv\.ms|box\.com|sharepoint|\.(pdf|docx?|pptx?|xlsx?|zip)(\?|$)/i.test(href)) {
        externals.push({ url: href });
      }
    }
    // お知らせ本文にテキストで貼られたURLも拾う
    const text = main.innerText || '';
    for (const mm of text.matchAll(/https?:\/\/[^\s「」（）()]+/g)) {
      const u = mm[0];
      if (!/google\.com|gstatic|youtube/.test(u) && /dropbox\.com|onedrive|1drv\.ms|box\.com|sharepoint|\.(pdf|docx?|pptx?|xlsx?|zip)(\?|$)/i.test(u)) externals.push({ url: u });
    }
    return { files, folders, externals };
  });
}

// --- 外部リンク(Dropbox等)を1件DL ---
async function downloadExternal(rawUrl, dir) {
  const key = keyExternal(rawUrl);
  if (ledger.has(key)) { totalSkip++; console.log(`    = (台帳) ${rawUrl.slice(0, 60)}`); manifest.push({ dir, url: rawUrl, status: 'skip' }); return; }
  let url = rawUrl.replace(/&amp;/g, '&');
  if (/dropbox\.com/.test(url)) url = url.replace(/([?&])dl=0/, '$1dl=1') + (/[?&]dl=/.test(url) ? '' : (url.includes('?') ? '&dl=1' : '?dl=1'));
  // URLパス末尾から仮の名前
  let base = '';
  try { base = decodeURIComponent((new URL(url).pathname.split('/').pop() || '')); } catch {}
  const goodName = base && base !== '.pdf' && /^.+\.[a-z0-9]{2,5}$/i.test(base);
  if (goodName) {
    const out = path.join(dir, sanitize(base));
    if (fs.existsSync(out) && fs.statSync(out).size > 0) { ledger.record(key, { status: 'done', dest: out, bytes: fs.statSync(out).size, source: 'classroom-ext' }); totalSkip++; console.log(`    = ${sanitize(base)}`); manifest.push({ dir, file: sanitize(base), url: rawUrl, status: 'skip' }); return; }
  }
  try {
    const resp = await ctx.request.get(url, { maxRedirects: 8, timeout: 180000 });
    const buf = Buffer.from(await resp.body());
    const ctype = resp.headers()['content-type'] || '';
    if (!resp.ok() || buf.length === 0 || /text\/html/.test(ctype)) throw new Error('HTTP ' + resp.status() + ' ctype=' + ctype + ' len=' + buf.length);
    // 名前未確定なら content-disposition から取得
    if (!goodName) {
      const cd = resp.headers()['content-disposition'] || '';
      const star = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
      const plain = (cd.match(/filename="?([^";]+)"?/i) || [])[1];
      let nm = '';
      try { nm = star ? decodeURIComponent(star) : (plain || ''); } catch { nm = plain || ''; }
      if (nm && /\.[a-z0-9]{2,5}$/i.test(nm)) base = nm;
      if (!base || !/\.[a-z0-9]{2,5}$/i.test(base)) {
        const fi = (rawUrl.match(/\/fi\/([A-Za-z0-9]+)/) || rawUrl.match(/\/s\/([A-Za-z0-9]+)/) || [])[1] || Math.random().toString(36).slice(2, 8);
        base = `dropbox_${fi}.${(rawUrl.match(/\.([a-z0-9]{2,5})(\?|$)/i) || [])[1] || 'pdf'}`;
      }
    }
    const fname = sanitize(base);
    const out = path.join(dir, fname);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) { ledger.record(key, { status: 'done', dest: out, bytes: fs.statSync(out).size, source: 'classroom-ext' }); totalSkip++; console.log(`    = ${fname}`); manifest.push({ dir, file: fname, url: rawUrl, status: 'skip' }); return; }
    fs.mkdirSync(path.dirname(out), { recursive: true }); // 新規DL時のみ遅延作成
    fs.writeFileSync(out, buf);
    ledger.record(key, { status: 'done', dest: out, bytes: buf.length, source: 'classroom-ext' });
    totalNew++; console.log(`    ⇩ ${fname} (${(buf.length / 1024).toFixed(0)}KB) [外部]`);
    manifest.push({ dir, file: fname, url: rawUrl, status: 'new', bytes: buf.length });
  } catch (e) {
    totalFail++; console.log(`    ✗ ${base || rawUrl} [外部]: ${e.message}`);
    manifest.push({ dir, file: base || '', url: rawUrl, status: 'fail', error: e.message });
  }
}

// --- 2) 各コースの添付を収集(授業＋ストリーム両タブ) ---
for (const course of courses) {
  process.stdout.write(`\n■ ${course.title}\n`);
  const files = []; const folders = []; const externals = [];
  const seenF = new Set(), seenD = new Set(), seenE = new Set();
  for (const url of [`https://classroom.google.com/u/0/w/${course.id}/t/all`, `https://classroom.google.com/u/0/c/${course.id}`]) {
    let r; try { r = await scanTab(url); } catch { continue; }
    for (const f of r.files) if (!seenF.has(f.fileId)) { seenF.add(f.fileId); files.push(f); }
    for (const d of r.folders) if (!seenD.has(d.id)) { seenD.add(d.id); folders.push(d); }
    for (const e of r.externals) if (!seenE.has(e.url)) { seenE.add(e.url); externals.push(e); }
  }
  console.log(`  Driveファイル: ${files.length} / フォルダ: ${folders.length} / 外部リンク: ${externals.length}`);

  // dir は新規DL時に各ダウンロード関数が遅延作成する（直下を新規取得用に保つ）
  const dir = path.join(DEST, sanitize(course.title));

  for (const f of files) {
    let fname = sanitize(f.name);
    const ext = f.docType === 'spreadsheets' ? '.xlsx' : f.docType !== 'binary' ? '.pdf' : '';
    if (ext && !fname.toLowerCase().endsWith(ext)) fname += ext;
    await downloadDrive(f.fileId, fname, dir, f.docType);
  }
  for (const e of externals) await downloadExternal(e.url, dir);
  // 添付フォルダ(中身が提出物の場合あり)は別サブフォルダに分離
  for (const fol of folders) await downloadFolder(fol.id, path.join(dir, '_リンクフォルダ' + (folders.length > 1 ? '_' + fol.id.slice(-4) : '')));
}

await browser.close();
ledger.save();

const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'classroom-materials.json'), JSON.stringify(manifest, null, 2));
console.log(`\n✓ 完了  新規${totalNew} / スキップ${totalSkip} / 失敗${totalFail} / DL不可${totalBlocked}  → ${DEST}`);
