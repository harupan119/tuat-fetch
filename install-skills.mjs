// install-skills.mjs — skills/ の各スキルを Claude Code / Codex のスキルフォルダへリンクする（macOS / Windows 共通）
//   使い方:
//     node install-skills.mjs                    # 既定の置き場所へリンク（下記）
//     node install-skills.mjs --target <dir>     # 置き場所を指定（複数可）
//     node install-skills.mjs --dry-run          # 何をするかだけ表示
//   既定の置き場所: ~/.claude/skills と ~/.codex/skills（存在するもの）。~/.ai/skills があればそこにも張る。
//   リンク: macOS/Linux は symlink、Windows はジャンクション（管理者権限・開発者モード不要）。
//   既にある実フォルダや、別の場所を指すリンクは上書きしない（--force で別の場所を指すリンクだけ張り直す）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const targets = args.flatMap((a, i) => (a === '--target' ? [path.resolve(args[i + 1])] : []));
if (!targets.length) {
  for (const d of ['.claude/skills', '.codex/skills', '.ai/skills'].map((p) => path.join(os.homedir(), p))) {
    if (fs.existsSync(d)) targets.push(d);
  }
  if (!targets.length) targets.push(path.join(os.homedir(), '.claude/skills'));
}

const SRC = path.join(import.meta.dirname, 'skills');
const skills = fs.readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(SRC, d.name, 'SKILL.md'))).map((d) => d.name);
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

let made = 0, skipped = 0;
for (const dir of targets) {
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  console.log(`▶ ${dir}`);
  for (const name of skills) {
    const src = path.join(SRC, name), dst = path.join(dir, name);
    const st = fs.lstatSync(dst, { throwIfNoEntry: false });
    if (st && real(dst) === real(src)) { console.log(`  = ${name}`); continue; }
    if (st && !st.isSymbolicLink()) { console.log(`  ⚠ ${name}: 実フォルダがあるので飛ばした（中身を確かめてから手で退避して）`); skipped++; continue; }
    if (st && !FORCE) { console.log(`  ⚠ ${name}: 別の場所(${fs.readlinkSync(dst)})へのリンクがあるので飛ばした（--force で張り直す）`); skipped++; continue; }
    console.log(`  + ${name}`);
    if (DRY) continue;
    if (st) fs.unlinkSync(dst);
    fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
    made++;
  }
}
console.log(`${DRY ? '（dry-run）' : ''}✓ 作成 ${made} / 飛ばした ${skipped} / 対象スキル ${skills.length}`);
