---
name: lecture-feedback-form
description: 講義スライドPDFの末尾にあるGoogleフォーム（感想・質問）に、講義内容を読んだ上で感想を生成して送信する。ユーザーが「感想フォーム入力して」「講義の感想送って」「○○のフォーム提出して」のように、PDF末尾の感想/質問フォームへの回答を依頼したときに使う。Classroom 投稿に貼られたフォームは classroom-forms。
---

# Lecture Feedback Form

講義スライドPDF（末尾に「感想と質問」＋Googleフォームのリンクがある形式）に対して、
講義内容に即した感想を生成し、Googleフォームへ送信するスキル。

東京農工大学の、毎回末尾に感想フォームが付く講義を想定している。
ログイン必須のフォームや Classroom の投稿に貼られたフォームは `classroom-forms`（入力まで。送信は本人）を使う。

## 前提・既定値

- **氏名・学籍番号** は `~/.local/share/sirius-fetch/identity.json`（`name` / `studentId`。`classroom-submit` と共通）から取る。
  個人情報なので、**読む前にユーザーへ許可を求める**。無ければユーザーに尋ねる。
- **感想** は講義スライド本文の実際の内容に即して書く（一般論で埋めない）。
  既定の長さは **4〜5文のしっかりめ**。ユーザー指定があればそれに従う。
- **質問欄は任意**。既定では空（送らない）。ユーザーが質問も入れたい場合のみ作成する。
- 文体はAIっぽさを避け、学生が書いた自然な日本語にする。
- 必要なもの: Node 18 以上、`pdftotext`（poppler。macOS: `brew install poppler`、Windows: `winget install oschwartz10612.Poppler`）。

## ワークフロー

ヘルパー: `scripts/form_tools.mjs`（スキルフォルダからの相対パス。macOS/Windows 共通。`scripts/form_tools.sh` は Mac 向けの互換入口で中身は同じ）。

### 1. フォームリンクを抽出
```bash
node scripts/form_tools.mjs link "<講義PDF>"
```
PDF末尾の `https://forms.gle/...` などを返す。

### 2. フォーム構造（項目・entry ID）を取得
```bash
node scripts/form_tools.mjs fields "<forms.gleまたはviewformのURL>"
```
各項目名と対応する `entry.<数字>`、および送信先 `formResponse` URLを表示する。
通常の構成は **氏名 / 学籍番号 / 感想（必須）/ 質問（任意）**。
項目順は固定ではないので、項目名とentry IDの対応を必ず確認すること。

### 3. 講義本文を読む
```bash
node scripts/form_tools.mjs text "<講義PDF>"
```
で本文を抽出し、その回の主要トピック（実験・人名・仕組み・歴史など具体例）を把握する。
出力が大きい場合はファイルに保存してReadで読む。

### 4. 感想を作成
講義の具体的な内容に触れた4〜5文の感想を書く。
**送信前にユーザーに内容（氏名・学籍番号・感想）を提示して最終確認を取る**こと
（外部送信＝取り消し不可のため）。

### 5. 送信
```bash
node scripts/form_tools.mjs submit \
  "<viewformURL>" <氏名entryID> <学籍entryID> <感想entryID> \
  "氏名" "学籍番号" "感想テキスト" \
  ["質問テキスト" <質問entryID>]   # 質問は任意
```
`HTTP 200` が返れば送信成功（それ以外は exit 1）。

### 6. 提出記録を保存
送信成功後、PDFと同じディレクトリに `submitted.txt` を作成する。

```
提出済み
方法: lecture-feedback-form スキル（自動送信）
日付: YYYY-MM-DD
感想: （送信した感想テキスト全文）
```

既に `submitted.txt` がある場合は上書きしない（二重提出防止の確認にも使える）。
複数回分をまとめて処理する場合は、各PDFについて 1→6 を繰り返す。
entry IDはフォームごとに異なるので、回ごとに `fields` で取り直すこと。

## 注意

- フォームはログイン不要の「リンクを知っている全員が回答可」形式である前提。
  ログイン必須フォームでは `fields` が「構造を読めません」で止まり、`submit` も通らない（その旨ユーザーに伝え、`classroom-forms` の `fill-form.mjs --open` で入力して本人が送信する）。
- `fvv=1` と `pageHistory=0` は単一ページフォーム向け。複数セクションのフォームでは
  `pageHistory=0,1,2,...` の調整が必要になることがある。
- 送信は取り消せない。必ずユーザー確認を経てから送ること。
