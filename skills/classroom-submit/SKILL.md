---
name: classroom-submit
description: "Google Classroomの課題にレポート等を半自動で提出する（添付まで自動、最終の『提出』ボタンは本人が押す）。『Classroomに提出』『課題出して』『レポート提出して』『〇〇の課題を提出』等で使う。実体は ~/Projects/sirius-fetch/classroom/attach.mjs。提出ボタンは絶対に自動で押さない。Sakai(SIRIUS-LMS)課題の提出は sirius-submit を使う。"
---

# Classroom 課題 半自動提出

**添付までを自動化し、最終の「提出」は必ず本人が押す**フロー。誤提出防止のため `提出`/`Turn in` ボタンは絶対に自動クリックしない。

## 全体の流れ

```
①提出ファイルを特定（自動判断＋要確認）
②attach.mjs で課題に添付（ドラフト保存。提出は押さない）
③--open で本人のChromeに課題ページを表示
④本人が青い「提出」を押す
```

## コマンド

```bash
cd ~/Projects/sirius-fetch
# 提出ページの下調べ(閲覧のみ・ログイン状態/ボタン/スクショ)
node classroom/inspect-submit.mjs "<課題URL>"
# 添付＋本人のChromeで開く（提出は押さない）
node classroom/attach.mjs "<課題URL>" "<提出ファイルの絶対パス>" --open
```
- 課題URLは `sirius-portal`/`classroom-fetch` の未提出todo（`output/classroom-todo.md`）やデイリーノート `## 📚 課題` の「開く」リンクから取得。
- `--open` を付けると添付確認後に本人の Chrome で課題ページを表示（macOS は `open -a "Google Chrome"`、Windows は `chrome.exe` を直接起動。`platform.mjs` の `openUrl()`）。あなたは提出を押すだけ。
- 課題説明文の取得（提出ゲート）は Classroom API を使うので、`node classroom/auth.mjs` 済みであること。

## 提出ゲート（attach.mjs が添付前に必ず通す）

実体は `classroom/gate.mjs`。課題説明文（API）とファイルを突き合わせ、NG が1つでもあれば添付しない（終了コード3）。

| # | 見ること |
|---|---|
| 1 | ファイル名が説明文の「ファイル名は「…」とすること」と完全一致（学籍番号・氏名を当てはめる） |
| 2 | 回番号がフォルダ名・ファイル名・課題名で一致 |
| 3 | PDF の文字情報に学籍番号と氏名がある（文字情報なしは WARN） |
| 4 | 説明文が PDF を求めるなら PDF の実ファイル |
| 5 | 期限前で、まだ提出済み（TURNED_IN/RETURNED）でない |
| 6 | 教材の台帳 `ledger.json` に載った配布資料でない |

- 判定だけ: `node classroom/attach.mjs "<URL>" "<file>" --dry-run`（または `node classroom/gate.mjs "<URL>" "<file>"`）
- NG を承知で通す: `--force`（本人が理由を分かっている時だけ）
- 本人情報: `~/.local/share/sirius-fetch/identity.json`（`studentId` / `name`）
- 添付できたら科目フォルダの `提出ルール.md` の記録表に1行足す。リネームの規則もまずそのファイルを見る。

## 提出ファイルの自動判断（ヒューリスティック）

`~/Documents/TUAT/<学期>/<科目>/<回>/` の中で、提出物は次で一意特定できることが多い:
- **DL教材ではない**（台帳`ledger.json`に載っていない／講義資料の命名規則に当たらない）
- **学籍番号（`identity.json` の `studentId`）を含むPDF**（本人の成果物。`-rw-------`権限・最近作成も手掛かり）

⚠️ **フォルダ番号とファイル名が食い違う場合は止めて確認**（実例: 07フォルダに`08回.pdf`があった → リネームしてから添付）。誤提出は致命的なのでここは自動でも人間確認を挟む。

## 技術メモ（attach.mjsの攻略法）

- 「追加または作成」「ファイル」は**非表示の重複要素があるため `page.evaluate` 内で表示要素をJSクリック**（ロケータでは掴めない）。
- ファイルアップロードは **Driveピッカーのiframe(`drive.google.com/picker`)内の `input[type="file"]` に `setInputFiles` で直接セット**（filechooserは出ない）。
- 添付はアカウントにドラフト保存され、開き直しても残る。ボタンが「完了としてマーク」→「提出」に変化したら添付成功。
- ログインは保存セッション(`classroom_state.json`)を使用。切れていたら `node classroom/login.mjs`（詳細は `sirius-session`）。

## 安全原則

- **提出ボタンは自動で押さない**（必ず本人）。
- 添付前に対象ファイルを確認、フォルダ/ファイル名の不一致は要確認。
- やり直しは課題ページの × で添付を外せる。

Sakai(SIRIUS-LMS)課題の提出は `sirius-submit` スキル（`~/Projects/sirius-fetch/submit.mjs`）を使う。
