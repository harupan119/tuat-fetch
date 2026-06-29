// find-assignment.mjs — Sakai課題の提出ページURLを特定して(任意で)Chromeで開く。
//   使い方: node find-assignment.mjs "<課題タイトルの一部>" ["<科目名の一部>"] [--open]
//   例:     node find-assignment.mjs "08 課題" "Academic" --open
import { getSession, openSakai, saveState, LMS } from './lib.mjs';
import { execFile } from 'node:child_process';

const titleQ = process.argv[2] || '';
const courseQ = process.argv.find((a, i) => i >= 3 && !a.startsWith('--')) || '';
const OPEN = process.argv.includes('--open');

const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakaiに入れません'); await browser.close(); process.exit(1); }
const j = async (p) => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

const sj = await j('/direct/site.json?_limit=999');
let sites = (sj?.site_collection || []).map((s) => ({ id: s.id, title: s.title })).filter((s) => /^\d{4}_\d{2}/.test(s.id));
const curTerm = sites.map((s) => s.id.slice(0, 7)).sort().reverse()[0];
sites = sites.filter((s) => s.id.startsWith(curTerm));
if (courseQ) sites = sites.filter((s) => s.title.includes(courseQ));
console.log(`▶ 対象サイト候補: ${sites.map((s) => s.title).join(' / ') || '(なし)'}`);

let found = null, toolUrlAny = null;
for (const site of sites) {
  const pages = await j(`/direct/site/${site.id}/pages.json`);
  let toolUrl = null;
  for (const pg of pages || []) for (const t of pg.tools || []) if (/assignment/i.test(t.toolId || '')) { toolUrl = t.url || `${LMS}/portal/site/${site.id}/page/${pg.id}`; break; }
  if (!toolUrl) continue;
  toolUrlAny = toolUrl;
  await page.goto(toolUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000); // 遷移/iframe読み込みを待つ
  // メイン＋iframe から課題タイトルに一致するリンクの絶対URLを探す
  let href = null;
  for (let attempt = 0; attempt < 3 && !href; attempt++) {
    href = await page.evaluate((q) => {
      const scan = (doc) => {
        for (const a of doc.querySelectorAll('a[href]')) {
          const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
          if (q && t.includes(q)) return a.href;
        }
        return null;
      };
      let h = scan(document);
      if (!h) for (const f of document.querySelectorAll('iframe')) { try { h = scan(f.contentDocument); if (h) break; } catch {} }
      return h;
    }, titleQ).catch(() => null);
    if (!href) await page.waitForTimeout(2000);
  }
  if (href) { found = { site: site.title, toolUrl, href }; break; }
  if (!found) found = { site: site.title, toolUrl, href: null };
}

await saveState(context);
await browser.close();

if (!found) { console.error('✗ サイト/課題ツールが見つかりませんでした'); process.exit(2); }
const openUrl = found.href || found.toolUrl;
console.log(`■ サイト: ${found.site}`);
console.log(`▶ 課題ツールページ: ${found.toolUrl}`);
console.log(`▶ 「${titleQ}」の直接リンク: ${found.href || '(個別リンク取れず→ツールページを開く)'}`);
console.log(`▶ 開くURL: ${openUrl}`);
if (OPEN) {
  execFile('open', ['-a', 'Google Chrome', openUrl], (e) => e && console.log('Chrome起動失敗:', e.message));
  console.log('▶ Chromeで開きました（Sakaiのログインが要求されたらSSOでログインしてください）');
}
