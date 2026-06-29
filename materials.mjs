// materials.mjs — Sakai(LMS)から教材ファイルと課題を取得する。
//   SIRIUSのSSOセッションでSakaiの /direct REST API を叩く。
//   ファイルは差分DL（既存で同サイズならスキップ）。
//   出力: 既定 ~/Downloads/sirius-materials/<科目>/ （環境変数 SIRIUS_MAT_DIR で変更可）
import { getSession, openSakai, saveState, LMS } from './lib.mjs';
import { Ledger, keySakai } from './ledger.mjs';
import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ledger = new Ledger();

const MAT_DIR = process.env.SIRIUS_MAT_DIR || path.join(os.homedir(), 'Downloads/sirius-materials');
const sanitize = s => (s || '').replace(/[\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();

const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakai(LMS)に入れませんでした。'); await browser.close(); process.exit(1); }

const api = async p => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// URLからファイル本文を取得。著作権警告ページが返ったら /access/accept を踏んで実体を取る。
// 戻り: { ok:true, body } / { ok:false, status } / { ok:false, html:true }
async function fetchBody(url) {
  // 大容量動画などでデフォルト30sを超えると例外で全体が落ちるため、
  // タイムアウトを延長しつつ try/catch で1ファイルの失敗を握り潰して継続する。
  const TIMEOUT = 180000;
  try {
    const res = await context.request.get(url, { timeout: TIMEOUT });
    if (!res.ok()) return { ok: false, status: res.status() };
    let body = Buffer.from(await res.body());
    if (/text\/html/.test(res.headers()['content-type'] || '') && body.includes(Buffer.from('著作権'))) {
      const m = body.toString('utf8').match(/href="([^"]*\/access\/accept\?[^"]*)"/);
      if (m) { const r2 = await context.request.get(m[1].replace(/&amp;/g, '&'), { timeout: TIMEOUT }); if (r2.ok()) body = Buffer.from(await r2.body()); }
    }
    if (body.includes(Buffer.from('<!DOCTYPE'))) return { ok: false, html: true };
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e.name || String(e) };
  }
}

// 重要: _limit を付けないとデフォルト件数上限で現学期サイトが隠れる
const mem = await api('/direct/membership.json?_limit=999');
let sites = (mem?.membership_collection || []).map(m => ({ id: m.locationReference.replace('/site/', ''), role: m.memberRole })).filter(s => s.id);
// 学期フィルタ: SIRIUS_TERM(例 2026_02)を指定すると該当学期のみ。未指定なら全サイト
const term = process.env.SIRIUS_TERM;
if (term) sites = sites.filter(s => s.id.startsWith(term));
console.log(`▶ 履修サイト ${sites.length}件 を走査${term ? ` (学期=${term})` : ''}`);

let dl = 0, skip = 0, asgTotal = 0;
const index = [];

for (const { id } of sites) {
  const content = await api(`/direct/content/site/${id}.json?_limit=9999`);
  const items = content?.content_collection || [];
  const title = sanitize(items[0]?.title || id);
  const files = items.filter(i => i.type !== 'collection' && i.url);
  const assign = (await api(`/direct/assignment/site/${id}.json?_limit=999`))?.assignment_collection || [];
  asgTotal += assign.length;
  if (!files.length && !assign.length) continue;

  // 直下を新規取得用に保つため siteDir は先行作成しない（新規DL時に dest の親だけ遅延作成）
  const siteDir = path.join(MAT_DIR, title);
  let courseDl = 0;
  console.log(`\n■ ${title}  (ファイル${files.length} / 課題${assign.length})`);

  for (const f of files) {
    // /access/content/group/<siteId>/ より後ろを相対パスに
    const rel = decodeURIComponent(new URL(f.url).pathname.split(`/access/content/group/${id}/`)[1] || (f.title || 'file'));
    const dest = path.join(siteDir, rel);
    const key = keySakai(id, rel);
    const existsHere = existsSync(dest) && statSync(dest).size === Number(f.size);
    // 台帳に取得済み、または現在地に正しいサイズで存在するならスキップ。
    // 後者は初回バックフィル（既存ファイルを台帳へ登録 → 以降は移動しても再DLしない）。
    if (ledger.has(key) || existsHere) {
      if (!ledger.has(key) && existsHere) ledger.record(key, { status: 'done', dest, bytes: Number(f.size), source: 'sakai' });
      skip++; continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let res, body;
    try {
      // 大容量ファイルでデフォルト30sを超えると例外で全体が落ちるため延長＋握り潰し
      res = await context.request.get(f.url, { timeout: 180000 });
      if (!res.ok()) { console.log(`  ✗ DL失敗 ${rel} (${res.status()})`); continue; }
      body = Buffer.from(await res.body());
      // 著作権制限付きダウンロード警告ページが返ったら /access/accept を叩いて実ファイルを取得
      if (/text\/html/.test(res.headers()['content-type'] || '') && body.includes(Buffer.from('著作権'))) {
        const m = body.toString('utf8').match(/href="([^"]*\/access\/accept\?[^"]*)"/);
        if (m) { res = await context.request.get(m[1].replace(/&amp;/g, '&'), { timeout: 180000 }); if (res.ok()) body = Buffer.from(await res.body()); }
      }
    } catch (e) { console.log(`  ✗ DL失敗 ${rel} (${e.name || e})`); continue; }
    if (/text\/html/.test(res.headers()['content-type'] || '') && body.includes(Buffer.from('<!DOCTYPE'))) { console.log(`  ✗ HTML応答(取得失敗) ${rel}`); continue; }
    await fs.writeFile(dest, body);
    ledger.record(key, { status: 'done', dest, bytes: body.length, source: 'sakai' });
    console.log(`  ✓ ${rel}`);
    dl++; courseDl++;
  }

  // 課題の添付ファイルを取得。教材と分離して _課題添付/ に集約（差分は台帳＋サイズ）。
  // 後段 migrate.mjs はこの配下を講義回ではなく専用「課題」フォルダへ振り分ける。
  for (const a of assign) {
    for (const att of (a.attachments || [])) {
      if (!att.url) continue;
      const name = sanitize(att.name || decodeURIComponent(new URL(att.url).pathname.split('/').pop() || 'attachment'));
      const rel = path.join('_課題添付', name);
      const dest = path.join(siteDir, rel);
      const key = keySakai(id, rel);
      const existsHere = existsSync(dest) && (!att.size || statSync(dest).size === Number(att.size));
      if (ledger.has(key) || existsHere) {
        if (!ledger.has(key) && existsHere) ledger.record(key, { status: 'done', dest, bytes: statSync(dest).size, source: 'sakai-assign' });
        skip++; continue;
      }
      const r = await fetchBody(att.url);
      if (!r.ok) { console.log(`  ✗ 添付DL失敗 ${name}${r.status ? ` (${r.status})` : r.html ? ' (HTML応答)' : r.error ? ` (${r.error})` : ''}`); continue; }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, r.body);
      ledger.record(key, { status: 'done', dest, bytes: r.body.length, source: 'sakai-assign' });
      console.log(`  ✓ [課題添付] ${name}`);
      dl++; courseDl++;
    }
  }

  // _課題.md は新規DLがあった科目だけ直下に出す（毎回の再生成で直下を汚さない）
  if (assign.length && courseDl > 0) {
    const md = ['# 課題: ' + title, ''];
    for (const a of assign) {
      const due = a.dueTimeString || (a.dueTime?.display) || '';
      md.push(`- **${a.title}**${due ? `  〆${due}` : ''}${a.status ? `  [${a.status}]` : ''}`);
      if (a.instructions) md.push(`  - ${String(a.instructions).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
    }
    await fs.mkdir(siteDir, { recursive: true });
    await fs.writeFile(path.join(siteDir, '_課題.md'), md.join('\n') + '\n');
  }
  index.push({ title, files: files.length, assignments: assign.length });
}

await saveState(context);
await browser.close();
ledger.save();

const idxMd = ['# Sakai教材インデックス  (' + new Date().toLocaleString('ja-JP') + ')', '',
  `DL ${dl} / スキップ${skip} / 課題${asgTotal}`, ''].concat(index.map(s => `- ${s.title} — ファイル${s.files}・課題${s.assignments}`));
await fs.writeFile(path.join(MAT_DIR, 'INDEX.md'), idxMd.join('\n') + '\n');

console.log(`\n✓ 完了: 新規DL ${dl} / スキップ ${skip} / 課題 ${asgTotal}`);
console.log(`  保存先: ${MAT_DIR}`);
