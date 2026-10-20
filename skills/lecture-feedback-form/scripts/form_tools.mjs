#!/usr/bin/env node
// 講義PDF末尾のGoogleフォーム（感想・質問）を扱うヘルパー（macOS / Windows 共通。Node 18+ と pdftotext が必要）
// 使い方:
//   node form_tools.mjs link   <pdf>                         … PDFからフォームURLを抽出
//   node form_tools.mjs fields <forms.gle or viewform URL>   … フォームの項目とentry IDを表示
//   node form_tools.mjs text   <pdf>                         … PDF本文をプレーンテキストで出力
//   node form_tools.mjs submit <viewformURL> <name_id> <id_id> <kansou_id> "氏名" "学籍番号" "感想" ["質問" question_id]
import { execFileSync } from 'node:child_process';

const [cmd, ...a] = process.argv.slice(2);

function pdftotext(file, layout = false) {
  try {
    return execFileSync('pdftotext', [...(layout ? ['-layout'] : []), file, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('✗ pdftotext がありません（poppler）。macOS: brew install poppler / Windows: winget install oschwartz10612.Poppler');
      process.exit(2);
    }
    throw e;
  }
}
const toResponseUrl = (u) => u.replace(/\/viewform.*$/, '/formResponse');

switch (cmd) {
  case 'link': {
    const urls = pdftotext(a[0]).match(/https?:\/\/[a-zA-Z0-9./_-]+/g) || [];
    for (const u of [...new Set(urls)].filter((u) => /forms\.gle|forms\/d/i.test(u)).sort()) console.log(u);
    break;
  }
  case 'text':
    process.stdout.write(pdftotext(a[0], true).split(/\r?\n/).filter((l) => l.trim()).join('\n') + '\n');
    break;
  case 'fields': {
    // forms.gle を実URLへ解決し、FB_PUBLIC_LOAD_DATA_ から項目名・entry IDを抽出
    const res = await fetch(a[0], { redirect: 'follow' });
    const html = await res.text();
    const m = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(.*?);\s*<\/script>/s);
    if (!m) { console.error('✗ フォームの構造を読めません（ログイン必須のフォームかもしれません）'); process.exit(1); }
    for (const item of JSON.parse(m[1])?.[1]?.[1] || []) {
      const entry = item?.[4]?.[0]?.[0];
      if (entry) console.log(`項目: ${item[1]}  entry.${entry}`);
    }
    console.log('---');
    console.log(`formResponse URL: ${toResponseUrl(/forms\/d\/e\//.test(a[0]) ? a[0] : res.url)}`);
    break;
  }
  case 'submit': {
    // a: viewformURL nameId idId kansouId 氏名 学籍 感想 [質問 questionId]
    const [url, nameId, idId, kansouId, name, sid, kansou, question, qid] = a;
    const body = new URLSearchParams({ [`entry.${nameId}`]: name, [`entry.${idId}`]: sid, [`entry.${kansouId}`]: kansou, fvv: '1', pageHistory: '0' });
    if (question && qid) body.set(`entry.${qid}`, question);
    const res = await fetch(toResponseUrl(url), { method: 'POST', body });
    console.log(`HTTP ${res.status}`);
    if (res.status !== 200) process.exit(1);
    break;
  }
  default:
    console.error('usage: node form_tools.mjs {link|text|fields|submit} ...');
    process.exit(2);
}
