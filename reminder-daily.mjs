// reminder-daily.mjs — Sakai/Classroomの未提出課題を Obsidian デイリーノートの
//   「## 📚 課題」セクションに冪等で反映する（morning/task-sync/sirius-reminder で共有利用）。
//   元データ: ~/.local/share/sirius-fetch/output/{assignments-todo.md, classroom-todo.md}
//     （無ければ assignments.mjs / classroom/fetch.mjs を先に実行しておく）
//   デイリーノートが無ければ何もしない（morning がノート作成時に本スクリプトを呼ぶ想定）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const OUT = path.join(HOME, '.local/share/sirius-fetch/output');
// Obsidianのデイリーノート格納先。自分のVault構造に合わせて環境変数 SIRIUS_DIARY_DIR で指定する。
const DIARY = process.env.SIRIUS_DIARY_DIR || path.join(HOME, 'Documents/Obsidian/Diary');
const HEAD = '## 📚 課題';

const arg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const today = arg || new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (ローカル)
const note = path.join(DIARY, `${today}.md`);

// --- 未提出課題を todo md から抽出 ---
function parseTodos(file, source) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[ \] (.+)$/);
    if (!m) continue;
    let item = m[1].trim();
    // 直後のインデント行に URL があれば拾う（Classroom）
    const url = (lines[i + 1] || '').trim().match(/^https?:\/\/\S+/);
    out.push({ text: item, source, url: url ? url[0] : null });
  }
  return out;
}

// 課題ではない/追跡不要なものを除外（部分一致）。希望制の募集フォーム等。
//   環境変数 SIRIUS_IGNORE_KEYWORDS にカンマ区切りで指定（例: "募集,アンケート"）。
const IGNORE = (process.env.SIRIUS_IGNORE_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const items = [
  ...parseTodos(path.join(OUT, 'assignments-todo.md'), 'Sakai'),
  ...parseTodos(path.join(OUT, 'classroom-todo.md'), 'Classroom'),
].filter((it) => !IGNORE.some((kw) => it.text.includes(kw)));

const now = new Date().toLocaleTimeString('ja-JP', { hour12: false });
const body = items.length
  ? items.map((it) => `- [ ] ${it.text}  ｜${it.source}${it.url ? ` [開く](${it.url})` : ''}`).join('\n')
  : '(未提出なし)';
const section = `${HEAD} (同期済み ${now})\n${body}\n`;

if (!fs.existsSync(note)) {
  console.log(`デイリーノートが無いのでスキップ: ${today}.md (morning作成後に反映されます)`);
  process.exit(0);
}

let lines = fs.readFileSync(note, 'utf8').split('\n');
const isH2 = (l) => /^## /.test(l);
const sectionLines = section.replace(/\n+$/, '').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('## 📚 課題'));

if (startIdx !== -1) {
  // 既存セクションを次の見出し直前まで置換（行ベースで確実に）
  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) { if (isH2(lines[i])) { end = i; break; } }
  const tail = lines.slice(end);
  lines = [...lines.slice(0, startIdx), ...sectionLines, ...(tail.length ? [''] : []), ...tail];
} else {
  // 「## ⏳ タスク」の次見出し直前に挿入。無ければ 重要メール/学習/雑記 の前、なければ末尾
  const taskIdx = lines.findIndex((l) => l.startsWith('## ⏳ タスク'));
  let insertAt = -1;
  if (taskIdx !== -1) for (let i = taskIdx + 1; i < lines.length; i++) { if (isH2(lines[i])) { insertAt = i; break; } }
  if (insertAt === -1) insertAt = lines.findIndex((l) => /^## (📬 重要メール|📚学習|📝 雑記)/.test(l));
  if (insertAt === -1) lines = [...lines, '', ...sectionLines];
  else lines = [...lines.slice(0, insertAt), ...sectionLines, '', ...lines.slice(insertAt)];
}
fs.writeFileSync(note, lines.join('\n'));
console.log(`✓ ${today}.md の「## 📚 課題」を更新（未提出 ${items.length}件）`);
