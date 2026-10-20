---
name: sirius-portal
description: "TUAT/SIRIUSポータルの時間割・休講補講・お知らせ(掲示)・成績(単位修得状況・GPA)、未提出課題のリマインド、Sakaiメッセージ(英語科目の連絡)の新着を取得する。『休講ある?』『お知らせ確認』『時間割取って』『成績出た?』『成績取って』『GPAいくつ?』『未提出の課題/締切を出して』『大学の締切リマインド』『Sakaiのメッセージ来てる?』『英語の先生から連絡ある?』等で使う。実体は ~/Projects/sirius-fetch/。前提: sirius-session。"
---

# SIRIUS ポータル取得（時間割・休講・お知らせ・成績・課題リマインド）

ファイルDLではなく**学務情報とリマインド**の取得担当。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node fetch.mjs                 # 時間割＋休講補講＋お知らせを一括取得 → output/
node grades.mjs               # 成績: 最新学期を表示＋全学期を output/grades.json に保存（--all で全学期表示）
node assignments.mjs          # Sakaiの未提出課題を締切順に → output/assignments-todo.md ＋ デスクトップ通知
node classroom/fetch.mjs      # Classroomの未提出課題(API) → output/classroom-todo.md ＋ デスクトップ通知
node messages.mjs             # Sakaiメッセージの新着 → 科目フォルダの メッセージ.md ＋ 通知（任意機能。下記）
```
出力先: `~/.local/share/sirius-fetch/output/`。通知は macOS 通知センター / Windows トースト（`platform.mjs` の `notify()`）。

## Sakai メッセージ（messages.mjs）

**既定でオフの任意機能**（`fetch-all` には環境変数 `SIRIUS_ENABLE_MESSAGES=1` の時だけ入る。監視は README の手順で個別に有効化）。英語科目などで、先生が連絡・教材リンク・提出指示を「お知らせ」ではなく Sakai の**メッセージ**ツールで送ってくる場合に使う。お知らせAPI(`/direct/announcement`)には出ないので、受信箱を画面から読む。

```bash
node messages.mjs                   # 時間割にある英語科目(科目コード el)の受信箱を差分取得
node messages.mjs --all             # 今学期の全サイト
node messages.mjs --course Reading  # サイト名の部分一致で絞る
node messages.mjs --refetch         # 既知のメッセージも本文を取り直す
node messages.mjs --watch           # 英語の授業時間帯（開始15分前〜終了30分後）だけ取得。他の時間は即終了
```
- 出力: `output/messages.{json,md}`、科目フォルダ `~/Documents/TUAT/TUAT_<学年>_<前期|後期>/<科目>/メッセージ.md`（学年は環境変数 `SIRIUS_ENTRANCE_YEAR`＝入学年度から計算する） と `_メッセージ/`（1通1ファイル＋本文中の Drive リンクの実体。Docs/スライドはPDF化）。
- `--watch` の定期実行: macOS は launchd `com.example.sirius-messages-watch`（30秒周期）、Windows はタスク `sirius-fetch-messages-watch`（1分周期。`install-tasks.ps1 -WithMessages` で登録）。時間帯内でも受信箱の件数だけを cookie で見て（約0.3秒）、変化が無ければ exit 3 で打ち切る。
- ⚠️ 本文を開いたメッセージは Sakai 上で既読になる。

## 成績（grades.mjs）

- **手動実行専用**。成績公開日など特定のタイミングでだけ使う。通知・前回との差分検出・`fetch-all.mjs` への組み込みはしない。
- `grades.json` は氏名・学籍番号を持たない。成績はローカルにだけ置き、外部へ同期するフォルダに書き出さない。
- 画面は「単位修得状況照会」(`SIW0001300`)。表示範囲「過去を含めた全成績」(`#spanType1`)を選び「画面に表示する」を押す。「ファイルに出力する」はダウンロードイベントが発生しなかった（実測 2026-09-15）ので使わない。
- 結果の表: 成績表12列（No./科目大区分/科目中区分/科目小区分/科目/単位数/修得年度/修得学期/評語/合否/遠隔/主担当教員）、通算GPA表（`通算GPA <値> 通算GPT <値>` の横1行）、年度別GPA表（年度×前期/後期/年度のGPA・GPT）。ほかに氏名・学籍番号の表がある（保存しない）。
- 評語→GP は S=4/A=3/B=2/C=1。学期GPA = Σ(GP×単位)÷単位数 を小数第3位以下切り捨てで表示する。
- ⚠️ **結果画面は受信途中に「評語」の見出しが先に出る**。見出しの出現だけを待って読むと、表の後半とGPA表が欠ける（実測: 41件中31件で打ち切り）。`document.readyState !== 'loading'` まで待つ。末尾の通算GPA表が無い時は途中で切れたとみなし、保存せず exit 1 にしている。

## 仕組み・落とし穴

- 主要flowId: 掲示板`KJW0001100` / 履修時間割`RSW0001000` / 休講補講`KHW0001100` / 成績`SIW0001300` / シラバス`SBW3701300` / ダウンロードセンター`SDW0001000`。
- 掲示は Spring WebFlow(`_eventId`)で `_flowExecutionKey` が毎回変わる → **URL直打ち不可、DOMクリックで辿る**。
- 時間割はグリッド表(限ラベル＋月〜土6セル×6限)をパース。
- **Sakai未提出判定**: REST(`/direct/assignment/...`)は開閉`status`(OPEN/CLOSED)のみで自分の提出状態を返さない → Assignmentsツール画面(toolId `sakai.assignment.grades`、`/direct/site/{id}/pages.json`でURL取得)の「状態」列をスクレイプ:「提出日時 …」=提出済/「開始されていません」=未提出。
- **「未提出0件」は「全部提出済み」の証拠にならない**。一覧テーブルが取れずに行0件になった場合と出力が同じになる（下記の修正済みバグがまさにこれ）。提出済みを確かめたい時は `sirius-submit` の `node status.mjs` を使う。
- ✅ **修正済み(2026-08-10): `assignments.mjs` の課題取りこぼし**。かつて2つの原因で未提出を見落とした。(a) ツールURL選択の入れ子`break`が内側ループしか抜けないため、課題ツールを持つページが複数あると**最後の1つ**を掴む。(b) Sakaiのツールは直前の画面状態を保持するので、そのplacementで一度提出画面を開いていると一覧テーブルが描画されず**行0件**になる。**引き金は「そのplacementで提出画面を開くこと」＝ `submit.mjs` で課題を提出した直後**。つまり提出した科目こそ次回の未提出チェックが盲目になる。

実測（同一セッションで再現→復旧まで確認）:
```
# 提出画面を開いた状態
[dbg] ['26月4]科目A → rows=5
[dbg] ['26木3]科目B → rows=5
[dbg] ['26火1]科目C → rows=0   ← 一覧が消える
[dbg] ['26金6]科目D → rows=2
✓ 未提出 0件                                ← 見えていないのに0件と報告

# status.mjs を1回走らせると doList_assignments により状態が戻る
[dbg] ['26火1]科目C → rows=3
```
**修正内容**: 全placementを `${LMS}/portal/tool/{placementId}?panel=Main&sakai_action=doList_assignments` で走査し、課題タイトルで重複除去する（`status.mjs` と同じ方式）。修正後は壊れた状態でも `rows=3` を取得できることを確認済み。

**この構造自体は残る**ので、課題一覧を読む新しいコードでは `lib.mjs` の `assignmentPlacements()` / `assignmentListUrl()` を使う。ページURLを自分で組み立てない。同じ欠陥が `submit.mjs` / `find-assignment.mjs` にもあり、こちらも同時に修正済み（詳細は `sirius-submit`）。
- **Classroom未提出**: Classroom API（`classroom/api.mjs`。2026-08-11 にスクレイプから移行）で courseWork と自分の提出状態（TURNED_IN/RETURNED 以外）を突き合わせる。exit 1=未認証、exit 2=認証切れ → `node classroom/auth.mjs`。

## リマインド連携（実装済）

`output/assignments-todo.md` / `classroom-todo.md` を日付ごとのリマインドファイル（`.md` / `.txt`）に書き出す `reminder-daily.mjs` がある（`node reminder-daily.mjs`）。fetch-all から実行。詳細は **`sirius-reminder`** スキル。
