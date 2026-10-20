---
name: classroom-forms
description: "Google Classroomの投稿からGoogle Formsを発見し、中身（質問・選択肢）を取得し、自動入力する（送信は本人）。『Classroomのフォーム確認して』『学内イベントのフォーム出して』『フォームに入力して』、Classroom外の forms.gle リンクを貼られて『これ入力して』等で使う。複数ページ・グリッド形式の質問にも対応。実体は ~/Projects/sirius-fetch/classroom/{scan-forms,form-contents,fill-form}.mjs。①発見はClassroom API、②中身取得と③入力はスクレイプ。前提: ①は classroom/auth.mjs、②③は sirius-session。"
---

# Classroom フォーム操作（スキャン・閲覧・入力）

Classroomの投稿に埋め込まれたGoogle Formsを**発見→中身確認→自動入力**するワークフロー。送信ボタンは絶対に自動で押さない。

**方式が①と②③で違う**。①はClassroom APIに移行済み（Playwright不要）。②③はスクレイプのまま。

理由: フォームURLの `/forms/d/e/1FAIpQL…` は**回答用ID**で、Forms APIが要求するフォームIDではない。しかも他人（教員・実行委員）所有のフォームなので `forms.get` の権限も無い。よって中身の取得と入力はブラウザ経由しか手が無い。

## コマンド

```bash
cd ~/Projects/sirius-fetch

# ① 投稿からフォームリンクを抽出（Classroom API。前提: node classroom/auth.mjs）
node classroom/scan-forms.mjs                       # 全ACTIVEコース
node classroom/scan-forms.mjs 123456789012          # 数値コースID
node classroom/scan-forms.mjs MTIzNDU2Nzg5MDEy      # URL由来のコースID
node classroom/scan-forms.mjs https://classroom.google.com/u/0/c/MTIzNDU2Nzg5MDEy

# ② フォームの質問・選択肢・受付状態を取得（全ページ分。前提: sirius-session）
node classroom/form-contents.mjs <フォームURL> [<URL2> ...]
node classroom/form-contents.mjs --from <①の出力JSON>
# 例: node classroom/form-contents.mjs --from ~/.local/share/sirius-fetch/output/classroom-forms-123456789012.json

# ③ フォームに自動入力（「次へ」で全ページ進み、「送信」の手前で止まる。送信は本人）
node classroom/fill-form.mjs <フォームURL> --data '<JSON>' [--open]
node classroom/fill-form.mjs <フォームURL> --file <data.json> [--open]
```

## 出力先

- `~/.local/share/sirius-fetch/output/classroom-forms-<数値courseId|all>.json` — ①のフォーム一覧。各要素は `{name, url, formId, course, courseId, postUrl, postKind}`（`postKind` は courseWork / material / announcement）
- `~/.local/share/sirius-fetch/output/form-contents.json` — ②の質問詳細。各質問は `{page, label, required, type, options, rows?, entryId|entryIds}`。`type` は short_text / long_text / radio / select / checkbox / radio_grid / checkbox_grid / date / time / file_upload 等。`rows` はグリッドの行名（③の `grid:` にそのまま使う）。回答済みなら `alreadyResponded: true`、受付終了なら `closed: true`
- `~/.local/share/sirius-fetch/output/form-filled-<timestamp>.png` — ③の入力後スクリーンショット

## ③ fill-form.mjs の data JSON 仕様

テキストはキーと質問ラベルの**完全一致を優先し、無ければ部分一致**で入力先を決める。特殊プレフィックスで入力種別を指定：

```json
{
  "団体名": "<団体名>",
  "代表者": "<氏名>",
  "check:乳": true,
  "radio:2年": true,
  "grid:学研災": "加入",
  "grid:バレーボール": ["経験なし"],
  "補足": "自由記述テキスト"
}
```

| プレフィックス | 動作 |
|---|---|
| (なし) | テキスト入力（`input[type=text]`, `textarea`） |
| `check:<値>` | チェックボックスを選択（値が `true` のとき。グリッド以外） |
| `radio:<値>` | ラジオボタンを選択（グリッド以外） |
| `grid:<行名>` | グリッドの行（部分一致）で、値の列を選択。配列なら複数列（チェックボックスグリッド） |

- 選択済みの選択肢はクリックしない（再実行でチェックが外れない）。
- 各ページの入力値を読み戻して `— Nページ目の入力値: {...}` と表示し、どの質問にも当たらなかったキーを `⚠️` で警告する。**報告前にこの出力で全項目が入ったか確かめる**。
- プルダウン（`select`）、日付・時刻、ファイル欄は未対応。
- 回答済みのフォーム（1回のみ回答）は exit 3 で止まる。
- `--open` を付けるとheadedモードで起動し、入力後にブラウザを10分間開いたままにする（本人が確認して送信）。

## 典型的なワークフロー

```
1. scan-forms.mjs でコースのフォーム一覧を取得
2. form-contents.mjs で中身を確認（質問・選択肢・受付状態）
3. 本人情報はSIRIUSから取る（下記）。本人にしか分からない項目だけユーザーに聞く
4. ユーザーに回答内容を確認
5. fill-form.mjs --open で入力 → 本人が送信
```

## 仕組み・注意点

- **①の抽出元は courseWork / courseWorkMaterials / announcements の3つ**（フォームは課題にも、お知らせにも貼られる）。`materials[].form.formUrl`、`materials[].link.url`、本文(`description`/`text`)のベタ貼りURL、の3経路から拾う。旧版の「2タブをスクロールして展開クリック」は**展開漏れで取りこぼす事故があったが、APIには展開の概念が無いので消滅した**。
- 重複判定は `/d/e/<回答用ID>/` が同一かどうか。取れない場合はURLそのものを鍵にする。
- ②は画面のDOMではなく、ページに埋め込まれた `FB_PUBLIC_LOAD_DATA_` を解析する。旧版はDOMを読んでいたため、**「メール収集だけの1ページ目＋本体の2ページ目」型のフォームで0問と出た**（2026-10-01）。
- ③のチェックボックス/ラジオは `data-value` 属性で照合する。グリッドのセルは aria-label「<列> は <行> に対する応答です」で行と列を判定する。
- **事前入力URL（`viewform?usp=pp_url&entry.N=値`）は学内限定フォームでは効かない**。開いた直後に `?pli=1` へのリダイレクトが入り、`entry.` パラメータが落ちる（2026-10-01に実測）。必ず③の画面操作で入れる。
- 開いた直後のリダイレクトや「下書きで続行しますか？」ダイアログは③が待って処理する（ダイアログでは「続行」を押す）。
- 入力内容はGoogleの下書きとしてアカウントに自動保存される。本人が普段のChromeで開くと「以前の下書きを使用」で同じ内容を呼び出せる。

## 本人情報の取得元（SIRIUS）

フォームで聞かれる本人情報は、SIRIUS「学生生活 > 学生ポートフォリオ」（`campussquare.do?_flowId=CHW0001000-flow`、`lib.mjs` の `getSession()` で開ける）にある。

- 学籍情報タブ: 学籍番号・氏名（カナ・英字）・所属（学科・コース）・学年・大学メール
- 学研災・学研賠情報タブ: 加入している保険（保険名称・保険期間）。表に無い保険は未加入
- **ファイルアップロード欄は自動化非対応**（Drive PickerのCSP制約）。ファイル添付が必要な場合は `classroom-submit` スキル（attach.mjs）か手動。
- **送信ボタンは絶対に自動で押さない**（classroom-submit と同じ安全原則）。

## 授業内課題とフォームの設問が食い違う時

授業中に示された課題と、宿題フォームの設問が別物だったことがある。その課題の提出先は Sakai に無く、本人の指示で、回答をフォームの自由記述欄（「コメントや質問」）に「課題2：」と見出しを付けて入れた。
- このように、指示された内容の入れ先がフォームに無い時は、**どの欄に入れたかを前提として本文の先頭に書き**、「別に提出するなら書き換えて」と添える。
- 内容の指定が無い設問は、講義資料から下書きし、入れた文面と、スライドに無い推論・未検証の出典を報告で明示する。
- 長い文面は `--data` ではなく `--file`（JSON、改行は `\n`）で渡す。`--open` で開いたままにし、読み戻しの `— Nページ目の入力値` と ⚠️ が0件であることを報告に貼る。

## 安全原則

- **送信は必ず本人**。入力内容をスクリーンショットで確認してから。
- フォームが「回答の受け付けは終了しました」の場合は form-contents.mjs が `closed: true` を返す。
- メールアドレス欄はスキップ（Classroomアカウントで自動入力される場合が多い。されない場合は本人が入力）。
