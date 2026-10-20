---
name: sirius-submit
description: "Sakai(SIRIUS-LMS, lms.sirius.tuat.ac.jp)の課題にファイルを半自動提出する（添付＋ドラフト保存まで自動、最終の『提出』ボタンは本人が押す）。『Sakaiに提出』『SIRIUS/LMSに課題出して』『シリウスの課題を提出』『〇〇回の課題を提出』等で使う。提出済みかの確認（『出したっけ?』『提出できてる?』『提出状況』『ちゃんと出てるか確認』）も担当し、実体は ~/Projects/sirius-fetch/status.mjs。提出そのものは submit.mjs。提出ボタン(Proceed)は絶対に自動で押さない。Classroom課題の提出は classroom-submit。前提: sirius-session。"
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
# 提出ページURLの特定だけして終了（添付もドラフト保存もしない。--file 不要）
node submit.mjs --title "第10回課題" --course "<科目名>" --dry-run
```

- `--title` は課題ツール内のリンク文字列に部分一致（例: `第10回課題`）。
- `--course` は当該学期のサイト名に部分一致（例: `<科目名>`）。同名課題の取り違え防止に推奨。
- 提出ページURLは `find-assignment.mjs "<課題タイトル>"` でも単独特定できる（`--open` で本人の Chrome に表示。macOS/Windows 共通）。
- `--file` は絶対パスで渡す。Windows でも `C:\Users\...` / `C:/Users/...` のどちらでもよい。
- **添付する前に `--dry-run` で対象を確かめる**のが安全。特に同じ科目で複数回提出する時（下記の罠2を踏むと別課題に添付しかねなかった）。
- デフォルトは提出画面を最大60分開いたまま。`--save-only` ならサーバーにドラフトだけ残して終了（別端末・自分のブラウザから開いても添付は残る）。

## 提出したか確認する（status.mjs）

「あの課題ちゃんと出したっけ?」に答える読み取り専用コマンド。**ボタンは一切押さない**。

```bash
cd ~/Projects/sirius-fetch
node status.mjs                                        # 今学期の全科目・全課題の提出状態
node status.mjs --course "<科目名の一部>"              # 科目名(サイト名)に部分一致で絞る
node status.mjs --course "<科目名の一部>" --title "<課題名の一部>" --detail   # 提出日時・添付ファイル名まで
```
出力: 標準出力 ＋ `~/.local/share/sirius-fetch/output/status.json`（今学期全科目で約30秒）

`--detail` は提出物の中身まで確認する。**空提出の検出用**に3種類を区別する。

| 表示 | 意味 |
|---|---|
| `添付: <ファイル名> (サイズ; 日時)` | ファイルを添付して提出済み |
| `本文提出: 「…」` | 添付なし・インラインテキストで提出済み |
| `⚠️添付も本文もなし` | 提出扱いだが中身が空。要対処 |

- `assignments.mjs` は**未提出だけ**を出すので「提出済みの確認」には使えない。**未提出0件は「全部提出済み」の証拠にならない**（後述の落とし穴で行が0件になっても同じ0件に見える）。確認は必ず `status.mjs`。
- 対象は Sakai のみ。Classroom は `classroom-fetch` / `classroom-submit` 側。

## 提出ファイルの自動判断（ヒューリスティック）

`~/Projects/TUAT/<科目>/<回>_work/` 配下に提出物がある（コード課題）。命名規則は **`<回番号>_<学籍番号>.c`**（例: `10_<学籍番号>.c`。テンプレ `NN_template.c` の "template" を学籍番号に置換）。レポート系は `~/Documents/TUAT/<学期>/<科目>/<回>/` の学籍番号入りPDF。

⚠️ **フォルダ番号とファイル名・課題回が食い違う場合は止めて確認**。誤提出は致命的。提出前に `check.sh`（コード課題）や中身を必ず検証してから添付する。

## 技術メモ（submit.mjs の攻略法）

- 提出ページは `?sakai_action=doView_submission` の Assignments ツール画面。フォームは `/tool/` を含むフレーム内。
- ファイル添付欄は `input#clonableUpload`（`name=upload`）。`setInputFiles` で直接セット（visible不問）。
- 保存ボタンは `input[name=save][value="ドラフトを保存"]`。**提出ボタンは `input[name=confirm][value=Proceed]` → 絶対に押さない**。
- ドラフト保存後の確認画面に「保存された添付ファイル: <ファイル名>」が出れば成功。スクリプトはこの文字列で検証する。
- ログインは保存セッション(storageState)を使用。切れていたら自動ログイン→対話ログインにフォールバック（詳細は `sirius-session`）。

### 課題一覧・提出状態を読むときの罠（実測で踏んだもの）

1. **REST APIは自分の提出を返さない**。`/direct/assignment/item/{id}.json` は学生ロールだと `submissions: 0` を返す（教員ロール用）。`/direct/assignment/site/{id}.json` も `status: OPEN/CLOSED`（課題の開閉）だけで提出有無は含まない。**提出状態は必ずツール画面のHTMLから読む**。
2. **Sakaiのツールは直前の画面状態を保持する**。一度 `sakai_action=doView_submission` を開くと、`/portal/site/{id}/page/{pageId}` を開き直しても提出画面が出続け、課題一覧テーブルが存在しなくなる。⚠️ **`submit.mjs` で提出するとこの状態になる**ので、同じ科目の2回目以降で顕在化する。

   → **`lib.mjs` の `assignmentPlacements(context, siteId)` と `assignmentListUrl(placementId)` を必ず使う**（2026-08-10 に共通化）。前者は課題ツールの placement を全部返し、後者は `doList_assignments` を明示したURLを返す。ページURLを自分で組み立てない。

   被害の実測: `assignments.mjs` は「未提出0件」と誤報告し、`submit.mjs` / `find-assignment.mjs` は提出ページを見失った。`submit.mjs` は貼り付いた画面に `--title` と部分一致するリンクがあれば**別課題の提出ページに添付する**危険もあった。4本とも修正済み。
3. **1サイトに課題ツールが複数置かれている**ことがある（例: 「課題」ページと「アウトライン」ページの2箇所に置く科目がある）。最初の1件で打ち切らず全placementを走査し、課題タイトルで重複除去する。
4. **提出済み課題のリンク先は2種類**。未返却は `doView_submission`（「課題が提出されました：<日時>」）、返却済みは `doView_grade`（「提出日時<TAB><日時>」＋「提出された添付」）。パースは両対応が要る。

## 安全原則

- **提出ボタン(Proceed)は自動で押さない**（必ず本人）。
- 添付前に対象ファイルを確認、フォルダ/ファイル名・課題回の不一致は要確認。
- ドラフトは可逆（課題ページで添付を外す・上書き再保存ができる）。
- コード課題は提出前に必ずビルド＆`check.sh`で全テスト通過を確認してから添付する。
