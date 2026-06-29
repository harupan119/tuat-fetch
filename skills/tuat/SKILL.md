---
name: tuat
description: "東京農工大(TUAT/SIRIUS)の時間割・休講補講・お知らせ・未提出課題・教材(Sakai LMS／Google Classroom)を一括取得し、TUAT正本フォルダへ整理する統括スキル。『シリウス取得』『大学の課題/教材を取りに行く』『SIRIUS/Sakai/Classroomから落とす』『TUATに振り分け/再配置』『大学の最新情報を更新』等で使う。課題の提出(添付＋ドラフト保存、最終ボタンは本人)も束ねる。実体ツールは ~/Projects/sirius-fetch/。下位スキル sirius-session / sirius-portal / sirius-lms / classroom-fetch / tuat-organize / sirius-reminder / sirius-submit / classroom-submit を束ねる。"
---

# TUAT（統括スキル）

東京農工大の学務情報を自動取得して整理するための上位スキル。実装は `~/Projects/sirius-fetch/`（Playwright/Node）。秘密情報は macOS Keychain のみに置く。

## 全体パイプライン

```
①ログイン/セッション (sirius-session)
        ↓
②ポータル取得      ③教材取得(Sakai)      ④教材取得(Classroom)
 sirius-portal      sirius-lms            classroom-fetch
 時間割/休講/お知らせ  → 新規だけ直下へ        → 新規だけ直下へ
 +未提出課題リマインド
        ↓
⑤整理 (tuat-organize) … migrate.mjs
   新規 → ~/Documents/TUAT/<年度学期>/<科目>/<講義回>/（正本）
   既存重複+メタ → ~/Downloads/sirius-materials/_アーカイブ/<学期>/
   → 直下クリーン

⑥提出（取得とは独立した別アクション）
   Sakai(LMS) → sirius-submit ／ Classroom → classroom-submit
   いずれも 添付＋ドラフト保存まで自動、最終の「提出」ボタンは本人が押す
```

## 使い分け（下位スキルを Skill で呼ぶ）

| やりたいこと | 呼ぶスキル |
|---|---|
| ログインできない/セッション切れ | `sirius-session` |
| 時間割・休講・お知らせ・締切リマインド | `sirius-portal` |
| Sakai(LMS)の教材ファイル・課題を落とす | `sirius-lms` |
| Google Classroomの教材・課題を落とす | `classroom-fetch` |
| 取得物をTUATへ振り分け/学期アーカイブ | `tuat-organize` |
| 未提出課題をデイリーノートに反映 | `sirius-reminder`（morning/task-syncと共有） |
| Sakai(LMS)課題を提出（添付＋ドラフト保存・提出は本人） | `sirius-submit` |
| Classroom課題を提出（添付自動・提出は本人） | `classroom-submit` |
| レポートを作成（本文.md→DOCX/PDF出力） | `tuat-report`（Claude/本文）・`tuat-report-writing`（Codex/整形・出力） |

※レポート作成は取得パイプラインとは別系統（前提・実体ツールが異なる）。発見性のため参照のみ。

## ワンショット実行（全部まとめて）

```bash
cd ~/Projects/sirius-fetch
./fetch-all.sh          # ②③④＋リマインドを順次（取得のみ）
node migrate.mjs        # ⑤の計画(dry-run)を確認
node migrate.mjs --apply  # 整理を実行
```
- ダブルクリック起動: Finder で `~/Projects/sirius-fetch/取得.command`
- 定期実行(launchd): `com.example.sirius-fetch`（毎日7:00/19:00、`fetch-all.sh`）。migrate は手動（新規を直下で確認してから整理する設計）。

## 重要な場所

- ツール: `~/Projects/sirius-fetch/`
- セッション/状態: `~/.local/share/sirius-fetch/`（`state.json` / `classroom_state.json` / `ledger.json`(取得台帳) / `output/`(リマインドmd) / `migrate-log-*.json`）
- 取得の一時置き場: `~/Downloads/sirius-materials/`（直下＝新規取得、`_アーカイブ/<2025前期|2025後期|2026前期>/`＝過去分）
- 正本: `~/Documents/TUAT/<TUAT_1_前期|TUAT_1_後期|TUAT_2_前期>/<科目>/<講義回>/`

## 設計の肝（必ず踏まえる）

- **台帳(ledger.json)が再DLを防ぐ**: 保存場所でなく安定ID(Sakaiリソースパス/Drive fileId/外部URL)で取得済みを記録。TUATへ移動しても再取得されない。詳細は `tuat-organize` / `sirius-lms`。
- **直下は新規だけ**: 取得スクリプトはフォルダを遅延作成するので、新規が無ければ直下は汚れない（`_アーカイブ`と`INDEX.md`のみ）。
- **正本はTUAT、Downloadsは一時置き場＋生アーカイブ**（ユーザー決定「TUATを正本に一本化」）。
- 認証・年度学期判定・科目→講義回の判定など各論は下位スキル参照。
