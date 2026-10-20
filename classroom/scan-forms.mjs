// classroom/scan-forms.mjs — Classroomの投稿からGoogle Formsリンクを抽出（Classroom API 版）
//   旧: ストリーム/授業の2タブを Playwright で開き、最大20回スクロール＋全展開してから
//       a[href] を走査。展開漏れがあるとフォームを取りこぼした。
//   新: courseWork / courseWorkMaterials / announcements の materials[].form と link、
//       および本文(description/text)のベタ貼りURLから抽出。展開の概念自体が無くなる。
//
//   使い方:
//     node classroom/scan-forms.mjs                       # 全コース
//     node classroom/scan-forms.mjs 123456789012          # 数値コースID
//     node classroom/scan-forms.mjs MTIzNDU2Nzg5MDEy      # URL由来のコースID
//     node classroom/scan-forms.mjs https://classroom.google.com/u/0/c/MTIzNDU2Nzg5MDEy
//   出力: stdout に JSON + ~/.local/share/sirius-fetch/output/classroom-forms-<id|all>.json
//
//   前提: 一度だけ `node classroom/auth.mjs`
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { authorized, listCourses, listAllPosts, normalizeMaterials, courseLabel, pool } from './api.mjs';

const arg = process.argv[2];

function normalizeCourseId(v) {
  if (!v) return null;
  const raw = v.includes('/c/') ? (v.match(/\/c\/([^/?]+)/) || [])[1] : v;
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  try {
    const d = Buffer.from(raw, 'base64').toString('utf8');
    if (/^\d+$/.test(d)) return d;
  } catch {}
  return raw;
}

const auth = authorized();
const targetId = normalizeCourseId(arg);

let courses = await listCourses(auth, { states: ['ACTIVE'] });
if (targetId) {
  courses = courses.filter((c) => c.id === targetId);
  if (!courses.length) { console.error(`✗ コース ${targetId} が見つかりません（ACTIVEのみ対象）`); process.exit(1); }
}
console.error(`対象コース: ${courses.length}件`);

const seen = new Set();
const allForms = [];

await pool(courses, 5, async (course) => {
  const posts = await listAllPosts(auth, course.id);
  for (const p of posts) {
    const { forms } = normalizeMaterials(p);
    for (const f of forms) {
      // /d/e/<responderId>/ が同一なら同じフォーム。取れない場合はURLそのものを鍵にする。
      const id = (f.url.match(/\/d\/e\/([^/?]+)/) || [])[1] || f.url;
      if (seen.has(id)) continue;
      seen.add(id);
      allForms.push({
        name: f.title || p.title || '(無題)',
        url: f.url,
        formId: id,
        course: courseLabel(course),
        courseId: course.id,
        postUrl: p.alternateLink || null,
        postKind: p.kind,
      });
    }
  }
});

const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
fs.mkdirSync(OUT, { recursive: true });
const outPath = path.join(OUT, `classroom-forms-${targetId || 'all'}.json`);
fs.writeFileSync(outPath, JSON.stringify(allForms, null, 2));

console.error(`✓ ${allForms.length}件のフォームを検出 → ${outPath}`);
console.log(JSON.stringify(allForms, null, 2));
