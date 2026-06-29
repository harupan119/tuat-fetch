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
- `--open` を付けると添付確認後に `open -a "Google Chrome" <URL>` で本人のChromeに表示（あなたは提出を押すだけ）。

## 提出ファイルの自動判断（ヒューリスティック）

`~/Documents/TUAT/<学期>/<科目>/<回>/` の中で、提出物は次で一意特定できることが多い:
- **DL教材ではない**（台帳`ledger.json`に載っていない／`MathStat`等の講義資料名でない）
- **学籍番号 `<学籍番号>` を含むPDF**（本人の成果物。`-rw-------`権限・最近作成も手掛かり）

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
