// migrate.mjs — ダウンロード(取得の一時置き場)から TUAT(正本) へ教材を再配置する。
//   ・AY(年度)で TUAT_1/TUAT_2 に振り分け、前期/後期フォルダへ
//   ・md5で内容重複を判定（TUATに既存なら重複＝移動しない）
//   ・新規はTUATの講義回フォルダへ「移動」(=正本)、既存と重複/除外メタは Downloads/_アーカイブ/<学期>/ へ退避
//   ・Downloads直下は新規取得用に空ける。全操作を移動ログに記録（可逆）。台帳が再DLを防ぐ前提。
//
//   使い方:
//     node migrate.mjs            # dry-run（何も動かさず計画だけ表示）
//     node migrate.mjs --apply    # 実行
//     node migrate.mjs --ay 2026  # AY2026のみ（2025も可）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
const DL = path.join(HOME, 'Downloads/sirius-materials');
const CR = path.join(DL, 'classroom');
const TUAT = path.join(HOME, 'Documents/TUAT');
const ARCH = path.join(DL, '_アーカイブ');               // 学期別アーカイブ(取得済みの退避先)。直下は新規取得用に空けておく
const termOf = (job) => `${job.ay}${job.sem.includes('後期') ? '後期' : '前期'}`;
const APPLY = process.argv.includes('--apply');
const AYFILTER = (() => { const i = process.argv.indexOf('--ay'); return i >= 0 ? process.argv[i + 1] : null; })();

// 配置ジョブ(履修科目)と回判定ロジックは個人の履修内容に依存するため外部設定に分離。
//   private/migrate-config.mjs があればそれを、無ければ同梱の migrate-config.example.mjs を使う。
//   自分用の設定は private/migrate-config.mjs にコピーして編集する（gitignore対象）。
const here = path.dirname(new URL(import.meta.url).pathname);
const cfgFile = ['private/migrate-config.mjs', 'migrate-config.example.mjs']
  .map((p) => path.join(here, p)).find((p) => fs.existsSync(p));
const { buildJobs, classify } = await import(pathToFileURL(cfgFile).href);
const JOBS = buildJobs({ DL, CR });

// 教材以外の除外メタ（汎用。個人情報なし）
const EXCLUDE = (rel, base) =>
  base === '.DS_Store' || base === '_課題.md' || base === 'INDEX.md' || base.endsWith('.URL') || /_提出物_誤取得/.test(rel);

function md5(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(file);
    s.on('error', rej); s.on('data', (d) => h.update(d)); s.on('end', () => res(h.digest('hex')));
  });
}
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}

const destHashCache = new Map();
async function destHashes(destDir) {
  if (destHashCache.has(destDir)) return destHashCache.get(destDir);
  const set = new Set();
  for (const f of walk(destDir)) { if (path.basename(f) === '.DS_Store') continue; set.add(await md5(f)); }
  destHashCache.set(destDir, set);
  return set;
}
const movedHashes = new Set(); // この実行で既にTUATへ入れた内容

const log = [];
let nNew = 0, nDup = 0, nFlag = 0;
const flags = [];

const jobs = AYFILTER ? JOBS.filter((j) => j.ay === AYFILTER) : JOBS;

for (const job of jobs) {
  if (!fs.existsSync(job.src)) { console.log(`!! 元なし: ${job.src}`); continue; }
  const destDir = path.join(TUAT, job.sem, job.subj);
  const dset = await destHashes(destDir);
  const files = walk(job.src).filter((f) => {
    const rel = path.relative(job.src, f); return !EXCLUDE(rel, path.basename(f));
  });
  if (!files.length) continue;
  console.log(`\n■ [${job.ay}] ${job.sem}/${job.subj}${job.note ? `  〔${job.note}〕` : ''}`);
  let jn = 0, jd = 0; const subUsed = {};
  for (const f of files) {
    const rel = path.relative(job.src, f);
    const base = path.basename(f);
    const h = await md5(f);
    if (dset.has(h) || movedHashes.has(h)) {
      // 重複(TUATに既存) → 学期アーカイブへ退避
      const q = path.join(ARCH, termOf(job), path.basename(job.src), rel);
      log.push({ action: 'archive', from: f, to: q, md5: h });
      jd++; nDup++;
      if (APPLY) { fs.mkdirSync(path.dirname(q), { recursive: true }); fs.renameSync(f, q); }
      continue;
    }
    // 新規 → 配置
    const sub = classify(job.mode, rel, base);
    subUsed[sub] = (subUsed[sub] || 0) + 1;
    if (sub === '_sirius' || sub === '_要確認') { nFlag++; flags.push(`${job.subj}/${sub}/${base}`); }
    let to = path.join(destDir, sub, base);
    if (fs.existsSync(to)) { const ext = path.extname(base); to = path.join(destDir, sub, base.slice(0, -ext.length || undefined) + ' (sirius)' + ext); }
    log.push({ action: 'move', from: f, to, md5: h });
    movedHashes.add(h);
    jn++; nNew++;
    if (APPLY) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(f, to); }
  }
  // 残った除外メタ(_課題.md/.URL/誤取得提出物等)も学期アーカイブへ送り、直下を空ける
  let jm = 0;
  for (const f of walk(job.src)) {
    const base = path.basename(f);
    if (base === '.DS_Store') { if (APPLY) fs.rmSync(f, { force: true }); continue; }
    const rel = path.relative(job.src, f);
    if (!EXCLUDE(rel, base)) continue; // 教材は上で新規/重複として処理済み
    const to = path.join(ARCH, termOf(job), path.basename(job.src), rel);
    log.push({ action: 'archive-meta', from: f, to });
    jm++;
    if (APPLY) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(f, to); }
  }
  console.log(`   新規 ${jn} → [${Object.entries(subUsed).map(([k, v]) => `${k}:${v}`).join(', ')}] / アーカイブ ${jd + jm}(重複${jd}+メタ${jm}) → _アーカイブ/${termOf(job)}/`);
}

// 空ディレクトリの掃除(apply時のみ、元フォルダ配下)
function pruneEmpty(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir)) { const p = path.join(dir, e); if (fs.statSync(p).isDirectory()) pruneEmpty(p); }
  const left = fs.readdirSync(dir).filter((x) => x !== '.DS_Store');
  if (!left.length) { try { fs.rmSync(path.join(dir, '.DS_Store'), { force: true }); fs.rmdirSync(dir); } catch {} }
}

if (APPLY) {
  for (const job of jobs) pruneEmpty(job.src);
  const logPath = path.join(HOME, `.local/share/sirius-fetch/migrate-log-${Date.now()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  console.log(`\n✓ 実行完了  新規移動 ${nNew} → ${TUAT}(正本) / アーカイブ ${nDup}+メタ`);
  console.log(`  取得済みの退避先(学期別): ${ARCH}`);
  console.log(`  移動ログ(復元用): ${logPath}`);
} else {
  console.log(`\n— DRY-RUN —  新規予定 ${nNew} / アーカイブ予定(重複) ${nDup}`);
  console.log(`  実行するには: node migrate.mjs --apply`);
}
if (flags.length) { console.log(`\n⚠ 回が曖昧で _sirius//_要確認 へ入れる予定 (${flags.length}件):`); for (const x of flags.slice(0, 40)) console.log(`   - ${x}`); }
