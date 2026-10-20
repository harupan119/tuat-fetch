// classroom/materials.mjs — Google Classroom 各コースの添付を差分ダウンロード（Classroom/Drive API 版）
//   旧: 全コース×2タブを Playwright で開き、[aria-expanded=false] を全click して DOM から添付を推測。
//       Driveフォルダは Drive の画面を20回スクロールして行を数えていた。
//   新: courseWork / courseWorkMaterials / announcements の materials[] を構造化取得し、
//       Drive API でメタ情報→本体を取得。フォルダは files.list、ショートカットは targetId で解決。
//   出力: ~/Downloads/sirius-materials/classroom/<コース>/
//
//   使い方:
//     node classroom/materials.mjs               # 全コース(差分DL)
//     node classroom/materials.mjs --year 2026   # コース名に2026を含むcoursesのみ
//     node classroom/materials.mjs --course <id> # 指定コースのみ(複数可。数値ID/URLのID どちらでも)
//
//   前提: 一度だけ `node classroom/auth.mjs`
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Ledger, keyDrive, keyExternal } from '../ledger.mjs';
import {
  authorized, listCourses, listAllPosts, normalizeMaterials,
  driveApi, sanitize, courseLabel,
} from './api.mjs';

const ledger = new Ledger();
const DEST = path.join(os.homedir(), 'Downloads/sirius-materials/classroom');

const args = process.argv.slice(2);
const yearFilter = (() => { const i = args.indexOf('--year'); return i >= 0 ? args[i + 1] : null; })();
// --course A B / --course A --course B / --course A,B のいずれも受ける（次の --xxx までを ID とみなす）
const courseFilter = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--course') continue;
  for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) courseFilter.push(...args[j].split(',').filter(Boolean));
}

// URL 由来のコースID(MTIzNDU2Nzg5MDEy) は数値ID(123456789012) の base64。どちらの指定も受ける。
function normalizeCourseId(v) {
  if (/^\d+$/.test(v)) return v;
  try {
    const d = Buffer.from(v, 'base64').toString('utf8');
    if (/^\d+$/.test(d)) return d;
  } catch {}
  return v;
}
const wanted = new Set(courseFilter.map(normalizeCourseId));

const auth = authorized();
const drive = driveApi(auth);

let totalNew = 0, totalSkip = 0, totalFail = 0, totalBlocked = 0;
const manifest = [];

// Googleネイティブ形式のエクスポート先。ここに無いものはDL対象外。
const EXPORT = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx',
  },
};
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

// files.export は 10MB 上限がある。大きい講義スライドはこれに引っかかるので、
// 旧版と同じ docs.google.com のエクスポートURL（上限なし）へ Bearer 付きで逃がす。
const DOCS_EXPORT_URL = {
  'application/vnd.google-apps.document': (id) => `https://docs.google.com/document/d/${id}/export?format=pdf`,
  'application/vnd.google-apps.presentation': (id) => `https://docs.google.com/presentation/d/${id}/export/pdf`,
  'application/vnd.google-apps.drawing': (id) => `https://docs.google.com/drawings/d/${id}/export?format=pdf`,
  'application/vnd.google-apps.spreadsheet': (id) => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
};

async function exportViaDocs(meta) {
  const url = DOCS_EXPORT_URL[meta.mimeType]?.(meta.id);
  if (!url) throw new Error('docs export 非対応の形式');
  const { token } = await auth.getAccessToken();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  const ctype = resp.headers.get('content-type') || '';
  if (!resp.ok) throw new Error(`docs export HTTP ${resp.status}`);
  if (/text\/html/.test(ctype)) throw new Error('docs export がHTMLを返した');
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('docs export 空応答');
  return buf;
}

const META_FIELDS = 'id,name,mimeType,size,shortcutDetails(targetId,targetMimeType),capabilities(canDownload)';

async function getMeta(fileId) {
  const res = await drive.files.get({ fileId, fields: META_FIELDS, supportsAllDrives: true });
  return res.data;
}

async function listFolder(folderId) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${META_FIELDS})`,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

function markBlocked(meta, dir, note) {
  totalBlocked++;
  console.log(`    ⊘ ${meta.name}: ${note}`);
  ledger.record(keyDrive(meta.id), { status: 'blocked', source: 'classroom-drive', note });
  manifest.push({ dir, file: meta.name, fileId: meta.id, status: 'blocked' });
}

// --- Driveファイル1件をDL（メタ情報は取得済み前提） ---
async function downloadFile(meta, dir) {
  const key = keyDrive(meta.id);
  const exp = EXPORT[meta.mimeType];
  if (!exp && meta.mimeType.startsWith('application/vnd.google-apps.')) {
    // フォーム/サイト/スクリプト等。ファイルとして落とせないので対象外。
    return;
  }

  let fname = sanitize(meta.name);
  if (exp && !fname.toLowerCase().endsWith(exp.ext)) fname += exp.ext;
  const out = path.join(dir, fname);

  const existsHere = fs.existsSync(out) && fs.statSync(out).size > 0;
  if (ledger.has(key) || existsHere) {
    // 台帳に無いが現地にある＝初回バックフィル
    if (!ledger.has(key) && existsHere) {
      ledger.record(key, { status: 'done', dest: out, bytes: fs.statSync(out).size, source: 'classroom-drive' });
    }
    totalSkip++; console.log(`    = ${fname}`);
    manifest.push({ dir, file: fname, fileId: meta.id, status: 'skip' });
    return;
  }

  // 教員がDLを禁止している場合は取りに行かずに blocked（旧版のHTML本文検知の置き換え）
  if (meta.capabilities && meta.capabilities.canDownload === false) {
    return markBlocked(meta, dir, 'DL制限(教員設定)');
  }

  try {
    let buf;
    if (exp) {
      try {
        const res = await drive.files.export({ fileId: meta.id, mimeType: exp.mime }, { responseType: 'arraybuffer' });
        buf = Buffer.from(res.data);
      } catch (e) {
        const reason = String(e?.errors?.[0]?.reason || e?.message || '');
        if (!/exportSizeLimitExceeded|too large/i.test(reason)) throw e;
        console.log(`    … ${fname}: files.export の10MB上限超え → docs.google.com 経由で再取得`);
        buf = await exportViaDocs(meta);
      }
    } else {
      const res = await drive.files.get(
        { fileId: meta.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      buf = Buffer.from(res.data);
    }
    if (!buf.length) throw new Error('空応答');
    fs.mkdirSync(path.dirname(out), { recursive: true });  // 新規DL時のみ遅延作成
    fs.writeFileSync(out, buf);
    ledger.record(key, { status: 'done', dest: out, bytes: buf.length, source: 'classroom-drive' });
    totalNew++; console.log(`    ↓ ${fname} (${(buf.length / 1024).toFixed(0)}KB)`);
    manifest.push({ dir, file: fname, fileId: meta.id, status: 'new', bytes: buf.length });
  } catch (e) {
    const code = e?.code || e?.response?.status;
    const reason = String(e?.errors?.[0]?.reason || e?.message || '');
    if (code === 403 && /cannotDownload|fileNotDownloadable|abusive/i.test(reason)) {
      return markBlocked(meta, dir, 'DL制限');
    }
    totalFail++; console.log(`    ✗ ${fname}: ${String(e.message).slice(0, 120)}`);
    manifest.push({ dir, file: fname, fileId: meta.id, status: 'fail', error: String(e.message).slice(0, 200) });
  }
}

// --- Drive添付1件を解決してDL（ショートカット/フォルダを再帰で畳む） ---
async function handleDrive(fileId, dir, depth = 0, seen = new Set()) {
  if (seen.has(fileId) || depth > 4) return;
  seen.add(fileId);
  let meta;
  try { meta = await getMeta(fileId); }
  catch (e) {
    totalFail++; console.log(`    ✗ ${fileId}: メタ取得失敗 ${String(e.message).slice(0, 100)}`);
    manifest.push({ dir, fileId, status: 'fail', error: 'metadata' });
    return;
  }

  if (meta.mimeType === SHORTCUT) {
    const target = meta.shortcutDetails?.targetId;
    if (target) return handleDrive(target, dir, depth, seen);
    return;
  }

  if (meta.mimeType === FOLDER) {
    let children;
    try { children = await listFolder(meta.id); }
    catch (e) { console.log(`    ✗ フォルダ ${meta.name}: ${String(e.message).slice(0, 100)}`); return; }
    // 添付フォルダは中身が提出物のことがあるので、旧版どおり別サブフォルダに分離する
    const sub = depth === 0
      ? path.join(dir, '_リンクフォルダ_' + sanitize(meta.name))
      : path.join(dir, sanitize(meta.name));
    console.log(`    📁 ${meta.name} — ${children.length}件`);
    for (const c of children) {
      if (c.mimeType === FOLDER || c.mimeType === SHORTCUT) await handleDrive(c.id, sub, depth + 1, seen);
      else await downloadFile(c, sub);
    }
    return;
  }

  await downloadFile(meta, dir);
}

// --- 外部リンク(Dropbox等)を1件DL ---
async function downloadExternal(rawUrl, dir) {
  const key = keyExternal(rawUrl);
  if (ledger.has(key)) {
    totalSkip++; console.log(`    = (台帳) ${rawUrl.slice(0, 60)}`);
    manifest.push({ dir, url: rawUrl, status: 'skip' });
    return;
  }
  let url = rawUrl.replace(/&amp;/g, '&');
  if (/dropbox\.com/.test(url)) {
    url = /[?&]dl=/.test(url) ? url.replace(/([?&])dl=0/, '$1dl=1') : url + (url.includes('?') ? '&dl=1' : '?dl=1');
  }

  let base = '';
  try { base = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {}
  const goodName = base && base !== '.pdf' && /^.+\.[a-z0-9]{2,5}$/i.test(base);
  if (goodName) {
    const out = path.join(dir, sanitize(base));
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      ledger.record(key, { status: 'done', dest: out, bytes: fs.statSync(out).size, source: 'classroom-ext' });
      totalSkip++; console.log(`    = ${sanitize(base)}`);
      manifest.push({ dir, file: sanitize(base), url: rawUrl, status: 'skip' });
      return;
    }
  }

  try {
    const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
    const ctype = resp.headers.get('content-type') || '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!resp.ok || !buf.length || /text\/html/.test(ctype)) {
      throw new Error(`HTTP ${resp.status} ctype=${ctype} len=${buf.length}`);
    }
    if (!goodName) {
      const cd = resp.headers.get('content-disposition') || '';
      const star = (cd.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
      const plain = (cd.match(/filename="?([^";]+)"?/i) || [])[1];
      let nm = '';
      try { nm = star ? decodeURIComponent(star) : (plain || ''); } catch { nm = plain || ''; }
      if (nm && /\.[a-z0-9]{2,5}$/i.test(nm)) base = nm;
      if (!base || !/\.[a-z0-9]{2,5}$/i.test(base)) {
        const fi = (rawUrl.match(/\/fi\/([A-Za-z0-9]+)/) || rawUrl.match(/\/s\/([A-Za-z0-9]+)/) || [])[1]
          || Math.random().toString(36).slice(2, 8);
        base = `dropbox_${fi}.${(rawUrl.match(/\.([a-z0-9]{2,5})(\?|$)/i) || [])[1] || 'pdf'}`;
      }
    }
    const fname = sanitize(base);
    const out = path.join(dir, fname);
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      ledger.record(key, { status: 'done', dest: out, bytes: fs.statSync(out).size, source: 'classroom-ext' });
      totalSkip++; console.log(`    = ${fname}`);
      manifest.push({ dir, file: fname, url: rawUrl, status: 'skip' });
      return;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buf);
    ledger.record(key, { status: 'done', dest: out, bytes: buf.length, source: 'classroom-ext' });
    totalNew++; console.log(`    ⇩ ${fname} (${(buf.length / 1024).toFixed(0)}KB) [外部]`);
    manifest.push({ dir, file: fname, url: rawUrl, status: 'new', bytes: buf.length });
  } catch (e) {
    totalFail++; console.log(`    ✗ ${base || rawUrl} [外部]: ${String(e.message).slice(0, 120)}`);
    manifest.push({ dir, file: base || '', url: rawUrl, status: 'fail', error: String(e.message).slice(0, 200) });
  }
}

// --- 本体 ---
let courses = await listCourses(auth, { states: ['ACTIVE'] });
if (wanted.size) courses = courses.filter((c) => wanted.has(c.id));
else if (yearFilter) courses = courses.filter((c) => courseLabel(c).includes(yearFilter));
console.log(`対象コース: ${courses.length}件`);

for (const course of courses) {
  const label = courseLabel(course);
  process.stdout.write(`\n■ ${label}\n`);

  let posts;
  try { posts = await listAllPosts(auth, course.id); }
  catch (e) { console.log(`  ✗ 投稿取得失敗: ${String(e.message).slice(0, 120)}`); continue; }

  const driveIds = new Map();   // id -> title（重複排除）
  const extUrls = new Set();
  for (const p of posts) {
    const { driveFiles, links } = normalizeMaterials(p);
    for (const f of driveFiles) if (!driveIds.has(f.id)) driveIds.set(f.id, f.title);
    for (const l of links) extUrls.add(l.url);
  }
  console.log(`  投稿: ${posts.length} / Drive添付: ${driveIds.size} / 外部リンク: ${extUrls.size}`);

  // dir は各DL関数が新規DL時に遅延作成する（新規が無ければ直下を汚さない）
  const dir = path.join(DEST, sanitize(label));
  const seen = new Set();
  for (const id of driveIds.keys()) await handleDrive(id, dir, 0, seen);
  for (const url of extUrls) await downloadExternal(url, dir);
}

ledger.save();

const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'classroom-materials.json'), JSON.stringify(manifest, null, 2));
console.log(`\n✓ 完了  新規${totalNew} / スキップ${totalSkip} / 失敗${totalFail} / DL不可${totalBlocked}  → ${DEST}`);
