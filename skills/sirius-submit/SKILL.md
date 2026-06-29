---
name: sirius-submit
description: "Sakai(SIRIUS-LMS, lms.sirius.tuat.ac.jp)の課題にファイルを半自動提出する（添付＋ドラフト保存まで自動、最終の『提出』ボタンは本人が押す）。『Sakaiに提出』『SIRIUS/LMSに課題出して』『シリウスの課題を提出』『〇〇回の課題を提出』等で使う。実体は ~/Projects/sirius-fetch/submit.mjs。提出ボタン(Proceed)は絶対に自動で押さない。Classroom課題の提出は classroom-submit。前提: sirius-session。"
---

# Sakai(SIRIUS-LMS) 課題 半自動提出

**ファイル添付＋ドラフト保存までを自動化し、最終の「提出(Proceed)」は必ず本人が押す**フロー。誤提出防止のため提出ボタンは絶対に自動クリックしない。

## 全体の流れ

```
①提出ファイルを特定（自動判断＋要確認）
②submit.mjs で 提出ページ特定 → 添付 → ドラフト保存（提出は押さない）
③同スクリプトが headed ブラウザで提出画面を開いたまま待機
④本人が添付を確認して「提出」を押す
```

## コマンド

```bash
cd ~/Projects/sirius-fetch
# 課題タイトルで特定して提出（科目名でサイトを絞ると確実）
node submit.mjs --title "第10回課題" --file "<提出ファイルの絶対パス>" [--course "<科目名>"]
# 提出ページURLが分かっているとき
node submit.mjs --url "<提出ページURL>" --file "<絶対パス>"
# ドラフト保存だけ（headedで開かず終了。後で自分のブラウザから提出）
node submit.mjs --title "第10回課題" --file "<絶対パス>" --save-only
```

- `--title` は課題ツール内のリンク文字列に部分一致（例: `第10回課題`）。
- `--course` は当該学期のサイト名に部分一致（例: 履修中の科目名の一部）。同名課題の取り違え防止に推奨。
- 提出ページURLは `find-assignment.mjs "<課題タイトル>"` でも単独特定できる。
- デフォルトは提出画面を最大60分開いたまま。`--save-only` ならサーバーにドラフトだけ残して終了（別端末・自分のブラウザから開いても添付は残る）。

## 提出ファイルの自動判断（ヒューリスティック）

`~/Projects/TUAT/<科目>/<回>_work/` 配下に提出物がある（コード課題）。命名規則は **`<回番号>_<学籍番号>.c`**（例: `10_<学籍番号>.c`。テンプレ `NN_template.c` の "template" を学籍番号に置換）。レポート系は `~/Documents/TUAT/<学期>/<科目>/<回>/` の学籍番号入りPDF。

⚠️ **フォルダ番号とファイル名・課題回が食い違う場合は止めて確認**。誤提出は致命的。提出前に `check.sh`（コード課題）や中身を必ず検証してから添付する（→ `c-programming-workflow`）。

## 技術メモ（submit.mjs の攻略法）

- 提出ページは `?sakai_action=doView_submission` の Assignments ツール画面。フォームは `/tool/` を含むフレーム内。
- ファイル添付欄は `input#clonableUpload`（`name=upload`）。`setInputFiles` で直接セット（visible不問）。
- 保存ボタンは `input[name=save][value="ドラフトを保存"]`。**提出ボタンは `input[name=confirm][value=Proceed]` → 絶対に押さない**。
- ドラフト保存後の確認画面に「保存された添付ファイル: <ファイル名>」が出れば成功。スクリプトはこの文字列で検証する。
- ログインは保存セッション(storageState)を使用。切れていたら自動ログイン→対話ログインにフォールバック（詳細は `sirius-session`）。

## 安全原則

- **提出ボタン(Proceed)は自動で押さない**（必ず本人）。
- 添付前に対象ファイルを確認、フォルダ/ファイル名・課題回の不一致は要確認。
- ドラフトは可逆（課題ページで添付を外す・上書き再保存ができる）。
- コード課題は提出前に必ずビルド＆`check.sh`で全テスト通過を確認してから添付する。
