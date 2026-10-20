// classroom/fetch.mjs — Google Classroom の未提出課題を取得（Classroom API 版）
//   旧: not-turned-in ページを Playwright でスクレイプし、締切を「今日/明日/7月11日」から推測。
//   新: courseWork.list + studentSubmissions.list(userId=me) で提出状態と締切を構造化取得。
//   出力: ~/.local/share/sirius-fetch/output/classroom-todo.{md,json}
//
//   使い方:
//     node classroom/fetch.mjs               # 未提出（締切があり、まだ締切が来ていないもの）
//     node classroom/fetch.mjs --since 30    # 期限超過も30日ぶん遡って含める
//     node classroom/fetch.mjs --all         # 窓も締切なしの制限も外して全件
//     node classroom/fetch.mjs --quiet       # macOS通知を出さない
//
//   なぜ窓が要るか: APIは終了した科目や締切を過ぎた未提出も全部返す。旧スクレイプは
//   Classroomの not-turned-in 画面が絞った結果しか見えず、実測では「まだ締切が来て
//   いないもの」だけが並んでいた。窓を外すと年度をまたいだ未提出がリマインドと
//   カレンダー同期に流れ込むため、既定はその旧挙動に合わせている。
//   期限超過の件数は実行時に必ず表示するので、必要なら --since で遡ること。
//
//   前提: 一度だけ `node classroom/auth.mjs`
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { notify } from '../platform.mjs';
import { authorized, listCourses, listCourseWork, listMySubmissions, dueToJst, pool, courseLabel, pad } from './api.mjs';

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const QUIET = args.includes('--quiet');
// 期限超過をどこまで遡って未提出として扱うか。既定0＝本日締切以降のみ（旧挙動）。
const SINCE_DAYS = (() => {
  const i = args.indexOf('--since');
  return i >= 0 ? Number(args[i + 1]) : 0;
})();
const cutoff = (() => {
  const d = new Date();
  d.setDate(d.getDate() - SINCE_DAYS);
  return d.toLocaleDateString('sv-SE');
})();

const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');

// 未提出とみなす提出状態。TURNED_IN / RETURNED は提出済み。
const PENDING = new Set(['NEW', 'CREATED', 'RECLAIMED_BY_STUDENT']);

const auth = authorized();
const courses = await listCourses(auth, { states: ['ACTIVE'], asStudent: true });

const items = [];
let overdue = 0;  // 締切を過ぎている未提出（窓の外）
let noDue = 0;    // 締切が設定されていない未提出
await pool(courses, 5, async (course) => {
  const [work, subs] = await Promise.all([
    listCourseWork(auth, course.id),
    listMySubmissions(auth, course.id),
  ]);
  if (!work.length) return;

  const subByWork = new Map();
  for (const s of subs) subByWork.set(s.courseWorkId, s);

  for (const w of work) {
    if (w.state && w.state !== 'PUBLISHED') continue;
    const sub = subByWork.get(w.id);
    // 提出物が存在しない課題（アンケート等）は追跡対象外
    if (!sub) continue;
    if (!PENDING.has(sub.state)) continue;

    const due = dueToJst(w.dueDate, w.dueTime);
    if (!ALL) {
      if (!due) { noDue++; continue; }             // 締切なしは従来どおり対象外
      if (due.iso.slice(0, 10) < cutoff) { overdue++; continue; }
    }

    // 従来の due 文字列（"M月D日 H:MM"）を維持する。
    // 下流の sync-calendar.mjs などがこの形をパースしているため。
    const dueJa = due ? `${due.m}月${due.d}日${due.timed ? ` ${due.hh}:${pad(due.mm)}` : ''}` : '';

    items.push({
      title: w.title || '(無題)',
      course: courseLabel(course),
      due: dueJa,
      href: w.alternateLink,
      // --- 以下は API 版で増えた情報（従来キーは上の4つで不変） ---
      dueISO: due ? due.iso : null,
      late: !!sub.late,
      state: sub.state,
      workType: w.workType || null,
      courseId: course.id,
      courseWorkId: w.id,
    });
  }
});

// 締切が近い順。締切なしは末尾。
items.sort((a, b) => (a.dueISO || '9999').localeCompare(b.dueISO || '9999'));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'classroom.json'), JSON.stringify(items, null, 2));

const lines = [`# Classroom 未提出課題  (${new Date().toLocaleString('ja-JP')})`, '', `未提出: ${items.length}件`, ''];
for (const t of items) lines.push(`- [ ] **${t.title}**（${t.course}）〆${t.due || '?'}${t.late ? ' ⚠期限超過' : ''}\n      ${t.href}`);
fs.writeFileSync(path.join(OUT, 'classroom-todo.md'), lines.join('\n') + '\n');

console.log(`✓ Classroom未提出 ${items.length}件 / ${courses.length}コース → ${OUT}/classroom-todo.md`);
for (const t of items) console.log(`  ・${t.title}（${t.course}）〆${t.due || '?'}${t.late ? ' ⚠' : ''}`);
if (overdue || noDue) {
  const parts = [];
  if (overdue) parts.push(`期限超過 ${overdue}件`);
  if (noDue) parts.push(`締切なし ${noDue}件`);
  console.log(`  （非表示: ${parts.join(' / ')}  →  --since <日数> で遡る / --all で全件）`);
}

if (items.length && !QUIET) {
  const msg = items.slice(0, 5).map((t) => t.title).join(', ');
  notify({ title: `Classroom未提出 ${items.length}件`, message: msg });
}
