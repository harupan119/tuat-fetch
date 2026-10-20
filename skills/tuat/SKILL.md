---
name: tuat
description: "東京農工大(TUAT/SIRIUS)の時間割・休講補講・お知らせ・成績(GPA)・未提出課題・教材(Sakai LMS／Google Classroom)・Sakaiメッセージを一括取得し、TUAT正本フォルダへ整理する統括スキル。『シリウス取得』『大学の課題/教材を取りに行く』『SIRIUS/Sakai/Classroomから落とす』『成績取って』『成績出た?』『TUATに振り分け/再配置』『大学の最新情報を更新』等で使う。課題の提出(添付＋ドラフト保存、最終ボタンは本人)・提出済みの確認(『出したっけ?』)・出席・履修登録・フォーム入力も束ねる。実体ツールは ~/Projects/sirius-fetch/（スキルの正本も同リポの skills/）。下位スキル sirius-session / sirius-portal / sirius-lms / classroom-fetch / classroom-forms / tuat-organize / sirius-reminder / sirius-submit / classroom-submit / sirius-attend / sirius-register / lecture-feedback-form を束ねる。"
---

# TUAT（統括スキル）

東京農工大の学務情報を自動取得して整理するための上位スキル。実装は `~/Projects/sirius-fetch/`（Playwright/Node）。**macOS / Windows のどちらでも同じコマンドで動く**（OS の違いは `sirius-session` の「OS ごとの違い」）。秘密情報は OS の資格情報ストア（Keychain / 資格情報マネージャー）だけに置く。

スキルはリポジトリの `skills/` にある。`node install-skills.mjs` で `~/.claude/skills` / `~/.codex/skills` へリンクする（Windows ではジャンクション）。スキルを直す時はリポジトリ側を編集する。

## 全体パイプライン

```
①ログイン/セッション (sirius-session)
        ↓
②ポータル取得      ③教材取得(Sakai)        ④教材取得(Classroom)
 sirius-portal      sirius-lms              classroom-fetch
 時間割/休講/お知らせ  リソース＋OneDrive資料   → 新規だけ直下へ
 未提出課題・メッセージ → 新規だけ直下へ
        ↓
⑤整理 (tuat-organize) … migrate.mjs
   新規 → ~/Documents/TUAT/<年度学期>/<科目>/<講義回>/（正本）
   既存重複+メタ → ~/Downloads/sirius-materials/_アーカイブ/<学期>/
   → 直下クリーン
⑥連携: リマインドファイル(.md/.txt)・Google カレンダー (sirius-reminder)

⑦操作（取得とは独立した別アクション。最終ボタンはどれも本人）
   提出: Sakai → sirius-submit ／ Classroom → classroom-submit
   出席: sirius-attend   履修登録: sirius-register
   フォーム: Classroom 投稿のフォーム → classroom-forms ／ 講義PDF末尾の感想フォーム → lecture-feedback-form
```

## 使い分け（下位スキルを Skill で呼ぶ）

| やりたいこと | 呼ぶスキル |
|---|---|
| ログインできない/セッション切れ/新しい PC（Windows 含む）のセットアップ | `sirius-session` |
| 時間割・休講・お知らせ・締切リマインド・Sakai メッセージ | `sirius-portal` |
| 成績・GPAを見る（手動実行のみ、通知・定期実行なし） | `sirius-portal`（`node grades.mjs`） |
| Sakai(LMS)の教材ファイル・課題・授業ページの OneDrive 資料を落とす | `sirius-lms` |
| Google Classroomの教材・課題を落とす | `classroom-fetch` |
| Classroom 投稿のGoogleフォームを探す・中身を見る・入力する | `classroom-forms` |
| 講義PDF末尾の感想フォームに感想を送る | `lecture-feedback-form` |
| 取得物をTUATへ振り分け/学期アーカイブ | `tuat-organize` |
| 未提出課題をリマインドファイル（.md/.txt）・Google カレンダーに書き出す | `sirius-reminder` |
| 課題を提出したか確認する（提出日時・添付まで） | `sirius-submit`（`node status.mjs`） |
| Sakai(LMS)課題を提出（添付＋ドラフト保存・提出は本人） | `sirius-submit` |
| Classroom課題を提出（添付自動・提出は本人） | `classroom-submit` |
| 授業の出席を登録（出席クイズを開く・提出は本人） | `sirius-attend` |
| 履修登録（時間割コードで登録・「登録完了」は本人） | `sirius-register` |

レポートの作成・PDF 化は別リポジトリ [tuat-report-kit](https://github.com/harupan119/tuat-report-kit) のスキル（`tuat-report` / `tuat-report-pdf`）。取得パイプラインとは別系統。


## ワンショット実行（全部まとめて）

```bash
cd ~/Projects/sirius-fetch
node fetch-all.mjs            # ②〜⑥を順次（macOS/Windows 共通。1手順が失敗しても続ける）
node fetch-all.mjs --dry-run  # 実行する手順だけ表示
node migrate.mjs              # ⑤の計画(dry-run)を確認（fetch-all は --apply まで走らせる）
node migrate.mjs --apply
```
- ダブルクリック起動: macOS は Finder で `取得.command`、Windows はエクスプローラーで `取得.cmd`。
- 定期実行（毎日 7:00 / 19:00 に `fetch-all`）: macOS は launchd `com.example.sirius-fetch`（`launchd/*.plist.example` から作る。`fetch-all.sh` 経由）、Windows はタスク `sirius-fetch-fetch`（`windows\install-tasks.ps1`）。
- `fetch-all.mjs` の手順: fetch → materials → onedrive → classroom/materials → migrate --apply → assignments → classroom/fetch →（messages：`SIRIUS_ENABLE_MESSAGES=1` の時だけ）→ reminder-daily → sync-calendar。
- ログ: `~/.local/share/sirius-fetch/fetch.out.log`（launchd / タスクスケジューラ共通の場所）。

## 科目が Sakai か Classroom かを見分ける

**サイトの有無では判定できない。** 履修している全科目に Sakai サイトが存在する（実測: 時間割の科目数と Sakai サイト数が一致した）。判定するのは「課題がどこにあるか」「教材がどこにあるか」で、科目ごとに別々に見る。

### 課題がどこにあるか

```bash
cd ~/Projects/sirius-fetch
node status.mjs           # Sakaiに課題がある科目だけが並ぶ
node classroom/fetch.mjs  # Classroomの未提出課題
```

`status.mjs` に出ない科目は「Sakaiに課題ツールが無い or 空」であって、Classroom科目とは限らない（そもそも課題が無い科目もある）。断定する前に Classroom 側も見る。連絡・提出指示を Sakai の「メッセージ」で送ってくる科目もある（`messages.mjs`。既定でオフの任意機能）。

例: ある学期では、Sakai に課題がある科目は一部だけだった。Sakai サイトはあるが課題ツールは空で、課題は Classroom 側にある科目もあった。

### 教材がどこにあるか

取得台帳の `source` で分かる。`sakai`/`sakai-assign`=Sakai、`onedrive`=Sakai授業ページの OneDrive、`classroom-drive`/`classroom-ext`=Classroom。

```bash
node -e "
const d=require(require('os').homedir()+'/.local/share/sirius-fetch/ledger.json').entries, c={};
for (const v of Object.values(d)) { const m=(v.dest||'').replace(/\\\\/g,'/').match(/sirius-materials\/([^/]+)\//); const k=(v.source||'?')+'\t'+(m?m[1]:'(直下)'); c[k]=(c[k]||0)+1; }
for (const [k,n] of Object.entries(c).sort()) console.log(n+'\t'+k);"
```

### 科目コードとSakaiサイトIDの対応

時間割の `code`（例 `02xx0000`）は Sakaiサイトid `<年度>_02_02xx0000` の末尾と一致する。

```bash
node -e "const d=require(require('os').homedir()+'/.local/share/sirius-fetch/output/timetable.json');for(const c of d.courses)console.log(c['曜限'],c.code,c['科目担当'])"
```

Sakaiのサイト名は `['26火1]<科目名>` のように `[学期曜限]` 接頭辞が付く。`--course` は部分一致なので接頭辞を含めない語で指定する。

## 重要な場所（Windows では `~` = `%USERPROFILE%`）

- ツール: `~/Projects/sirius-fetch/`（スキルの正本は `skills/`）
- セッション/状態: `~/.local/share/sirius-fetch/`（`state.json` / `classroom_state.json` / `classroom-token.json`(Classroom API のOAuthトークン) / `ledger.json`(取得台帳) / `output/`(リマインドmd・各種json) / `migrate-log-*.json`）
- 取得の一時置き場: `~/Downloads/sirius-materials/`（直下＝新規取得、`_アーカイブ/<年度><前期|後期>/`＝過去分）
- 正本: `~/Documents/TUAT/TUAT_<学年>_<前期|後期>/<科目>/<講義回>/`

## 設計の肝（必ず踏まえる）

- **台帳(ledger.json)が再DLを防ぐ**: 保存場所でなく安定ID(Sakaiリソースパス/Drive fileId/外部URL/OneDrive共有リンク)で取得済みを記録。TUATへ移動しても再取得されない。詳細は `tuat-organize` / `sirius-lms`。
- **直下は新規だけ**: 取得スクリプトはフォルダを遅延作成するので、新規が無ければ直下は汚れない（`_アーカイブ`と`INDEX.md`のみ）。
- **正本はTUAT、Downloadsは一時置き場＋生アーカイブ**（設計方針「TUATを正本に一本化」）。
- **提出・出席・履修登録・フォーム送信の最終ボタンは本人**（`--go` 等の明示指定がある出席と、ユーザー確認後の感想フォーム送信を除く）。
- 認証・年度学期判定・科目→講義回の判定など各論は下位スキル参照。
