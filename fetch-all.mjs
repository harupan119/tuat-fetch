// fetch-all.mjs — 全ソースを一括取得（定期実行 と ダブルクリック起動 で共用。macOS / Windows 共通）
//   時間割/休講/お知らせ → Sakai教材 → Classroom教材 → 整理 → 未提出課題(通知付き) → 連携
//   使い方: node fetch-all.mjs            # 実行
//           node fetch-all.mjs --dry-run  # 実行する手順だけ表示
//   1手順が失敗しても残りは続ける（ログに ✗ を残す）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { IS_MAC } from './platform.mjs';

process.chdir(import.meta.dirname);
const DRY = process.argv.includes('--dry-run');
const log = (m) => console.log(`${new Date().toLocaleString('sv-SE')} ${m}`);

// classroom: Classroom系(API版)。exit 1=未認証 / exit 2=OAuth再同意で、どちらもブラウザ操作が要るので
//   無人では復旧できない。リトライせずログに対処法を残す。
// macOnly: macOS のアプリに依存する手順。quiet: stderr を捨てる
// optIn: その環境変数が 1 の時だけ実行する（使う人が限られる機能。既定はオフ）
const STEPS = [
  { script: 'fetch.mjs' },
  { script: 'materials.mjs' },
  { script: 'onedrive.mjs' },                       // Sakai授業ページ内のOneDrive資料(パスワードPDFは資格情報ストアで解除)
  { script: 'classroom/materials.mjs', classroom: true },
  { script: 'migrate.mjs', args: ['--apply'] },
  { script: 'assignments.mjs' },
  { script: 'classroom/fetch.mjs', classroom: true },
  { script: 'messages.mjs', optIn: 'SIRIUS_ENABLE_MESSAGES' }, // Sakaiメッセージの新着 → 科目フォルダ/_メッセージ と通知（任意）
  { script: 'reminder-daily.mjs' },                 // 当日のデイリーノートがあれば課題セクション更新
  { script: 'sync-calendar.mjs', args: ['--sync'] }, // Google Calendar に課題を同期（失敗理由をログに残すためstderrは捨てない）
];

log('▶ 取得開始');
for (const s of STEPS) {
  if (s.macOnly && !IS_MAC) continue;
  if (s.optIn && process.env[s.optIn] !== '1') continue;
  if (!fs.existsSync(s.script)) continue;         // 公開版など、手順の一部を持たない構成でも動くように
  const args = [s.script, ...(s.args || [])];
  if (DRY) { console.log(`  node ${args.join(' ')}`); continue; }
  const r = spawnSync(process.execPath, args, { stdio: ['inherit', 'inherit', s.quiet ? 'ignore' : 'inherit'] });
  const code = r.status ?? 1;
  if (code === 0) continue;
  if (s.classroom && code === 1) log(`✗ ${s.script}: 未認証/資格情報未設定 → 手動で \`node classroom/auth.mjs\``);
  else if (s.classroom && code === 2) log(`✗ ${s.script}: Classroom APIの認証切れ → 手動で \`node classroom/auth.mjs\``);
  else log(`✗ ${s.script} 失敗${s.classroom ? ` (exit ${code})` : ''}${s.hint ? `（${s.hint}）` : ''}`);
}
log('✓ 取得完了');
