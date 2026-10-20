# sirius-fetch

東京農工大（TUAT）の学習環境 **SIRIUS / Sakai(LMS) / Google Classroom** から、
時間割・休講補講・お知らせ・成績・未提出課題・教材を **無人で取得** し、
提出・出席・履修登録・フォーム入力を **最終ボタンの手前まで** 自動化する個人用ツール群です。
**macOS と Windows のどちらでも同じコマンドで動きます。**

- ログインは Extic SSO（ID / パスワード / TOTP 2段階認証）を **OS の資格情報ストア + TOTP自動生成** で突破
  （macOS は Keychain、Windows は資格情報マネージャー）
- セッションは `keepalive` で延命、切れたら自動再ログイン
- Classroom の取得は **Classroom API / Drive API**（読み取り専用スコープ）
- 未提出課題を日付ごとのリマインドファイル（.md / .txt）と Google カレンダーにも書き出せる
- 付属の Chrome 拡張でブラウザ操作中の自動ログインも可能
- Claude Code / Codex 用のスキル（`skills/`）同梱

> ⚠️ 本リポジトリには **認証情報・個人を特定する情報を置きません**。
> - 認証情報（ID/パス/TOTP/OAuth クライアント）は実行時に OS の資格情報ストアから取得。
> - 鍵・実 plist・履修科目の整理ルールなどの個人物は gitignore された `private/` フォルダに隔離。
> - 学籍番号・ログインIDはスキル内で `<学籍番号>` `<ログインID>` のプレースホルダ。
> - 履修科目・整理ルールは `private/migrate-config.mjs`（非公開）に分離し、公開側は架空サンプル `migrate-config.example.mjs` のみ。
> - リマインドの出力先・同期先カレンダー・入学年度などは環境変数で指定（下記）。

---

## できること

| 分類 | 内容 | 主なスクリプト |
|---|---|---|
| 取得 | 時間割・休講補講・お知らせ | `fetch.mjs` |
| 取得 | 成績・GPA（手動実行のみ） | `grades.mjs` |
| 取得 | Sakai の教材・課題定義（差分。著作権制限の確認画面も自動で通過） | `materials.mjs` |
| 取得 | Sakai 授業ページ内の OneDrive 資料（パスワード付き PDF の解除つき） | `onedrive.mjs` |
| 取得 | Classroom の教材（Drive / Drive フォルダ / Dropbox などの外部リンク） | `classroom/materials.mjs` |
| 取得 | 未提出課題（Sakai / Classroom）とデスクトップ通知 | `assignments.mjs` / `classroom/fetch.mjs` |
| 取得（任意・既定オフ） | Sakai メッセージの新着と通知（メッセージ機能で連絡する科目がある人向け） | `messages.mjs` |
| 整理 | 取得物を年度・学期・科目・講義回のフォルダへ振り分け | `migrate.mjs` |
| 連携 | 日付ごとのリマインドファイル（.md / .txt）/ Google カレンダー | `reminder-daily.mjs` / `sync-calendar.mjs` |
| 操作 | Sakai 課題の提出（添付＋ドラフト保存まで）・提出状況の確認 | `submit.mjs` / `status.mjs` |
| 操作 | Classroom 課題への添付（提出前の検査つき） | `classroom/attach.mjs` |
| 操作 | 出席クイズを開く・コード入力（既定は提出を本人が押す） | `attend.mjs` |
| 操作 | 履修登録（コード指定登録まで。「登録完了」は本人） | `register.mjs` |
| 操作 | Google フォームの発見・中身の取得・自動入力（送信は本人） | `classroom/{scan-forms,form-contents,fill-form}.mjs` |

**提出・出席・履修登録・フォーム送信の最終ボタンは、安全のため自動では押しません**（出席の `--go` を明示した場合を除く）。

---

## 構成

```
.
├── *.mjs                  # SIRIUS/Sakai 取得・操作スクリプト（lib.mjs が共通処理）
├── platform.mjs           # OS で分かれる処理（資格情報・通知・ブラウザ起動）をここに集約
├── secret.mjs             # 資格情報の登録・確認（node secret.mjs set <名前> / check）
├── fetch-all.mjs          # 全ソース一括取得（macOS / Windows 共通の本体）
├── classroom/*.mjs        # Google Classroom 取得・フォーム・提出
├── chrome-ext/            # 自動ログイン Chrome 拡張（Native Messaging で資格情報ストアと連携）
├── ios-userscript/        # iPhone Safari（Userscripts）用のログイン補助（秘密は持たない）
├── launchd/*.example      # macOS の定期実行 plist テンプレート（要・パス置換）
├── windows/               # Windows のタスクスケジューラ登録・Native Messaging 登録
├── skills/                # Claude / Codex 用スキル（tuat が統括）
├── install-skills.mjs     # skills/ を ~/.claude/skills などへリンク
├── fetch-all.sh / 取得.command   # macOS の入口（launchd / ダブルクリック）
├── 取得.cmd               # Windows のダブルクリック入口
└── private/               # ← gitignore。鍵・実 plist・履修科目の設定など個人物をここに置く
```

`private/` に置くもの（**コミットされません**）:
- `private/ext-keys/` … Chrome 拡張の鍵（`ext_private.pem` など。各自生成）
- `private/launchd/` … パス置換済みの実 plist（任意。バックアップ用）
- `private/migrate-config.mjs` … 自分の履修科目・整理ルール（`migrate-config.example.mjs` をコピーして編集）

実行時の状態（cookie・トークン・台帳）は `~/.local/share/sirius-fetch/`（Windows は `%USERPROFILE%\.local\share\sirius-fetch\`）に保存され、リポジトリ外です。

---

## セットアップ（Claude / 人間どちらでも実行可。秘密の入力だけは本人）

前提:
- **macOS**: Apple Silicon 想定、Homebrew、Node.js 20 以上、Google Chrome
- **Windows**: Windows 10 21H2 以降 / 11、Node.js 20 以上（`winget install OpenJS.NodeJS.LTS`）、Google Chrome、Windows PowerShell 5.1（標準搭載）
- 任意: `pdftotext`（提出前検査・感想フォーム。macOS `brew install poppler` / Windows `winget install oschwartz10612.Poppler`）、
  Python + `pypdf` `cryptography`（パスワード付き PDF の解除。Python の場所は `SIRIUS_PYTHON` で指定可）

スキルは `~/Projects/sirius-fetch` に clone した前提で書いてある（Windows も `%USERPROFILE%\Projects\sirius-fetch`）。

### 1. 依存インストール
```bash
npm install
npx playwright install chromium
```

### 2. 認証情報を登録

> ⚠️ **このステップは自分の手元のターミナルで自分で実行すること。**
> パスワード・TOTPシード等の秘密を入力するため、**AIエージェント（Claude/Codex等）や他人に実行させない・貼り付けさせない**。
> 入力は伏せ字で、履歴にも残らない。

```bash
node secret.mjs set sirius-user    # SSO ログインID（例: s+数字英字）
node secret.mjs set sirius-pass    # SSO パスワード
node secret.mjs set sirius-totp    # TOTP のシード（Base32）※取得方法は下記
node secret.mjs set sirius-gmail   # 大学 Google アカウント(メール)
node secret.mjs check              # 登録済みかだけ表示（値は出ない）
```
保存先は macOS が Keychain（account=`sirius`）、Windows が資格情報マネージャー（Windows 資格情報 → 汎用資格情報ではなく PasswordVault。user=`sirius`）。
どの OS でも環境変数 `SIRIUS_SECRET_<名前>`（例 `SIRIUS_SECRET_SIRIUS_USER`）があればそちらを優先する。

> **TOTPシードの取得**: TUAT の MFA 設定ページ
> （[多要素認証(MFA)の設定](https://www.imc.tuat.ac.jp/info-system0/tuat-gateway/setup-mfa.html)）で
> 認証アプリを登録する際に表示される手動入力用キー（Base32文字列）が `sirius-totp` のシード。
> 登録済みで再表示できない場合は、一度認証アプリを登録し直すとキーを取得できる。

### 3. Classroom API の準備（Classroom を使う場合）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作り、**Google Classroom API** と **Google Drive API** を有効にする
   （カレンダー同期も使うなら **Google Calendar API** も）。
2. OAuth 同意画面を作り（テスト中のままでよい）、テストユーザーに大学アカウントを追加する。
3. 認証情報 → OAuth クライアント ID →「デスクトップ アプリ」で作成し、ID とシークレットを登録する:
   ```bash
   node secret.mjs set classroom-client-id
   node secret.mjs set classroom-client-secret
   # カレンダー同期を使うなら（同じクライアントでもよい）
   node secret.mjs set gcal-client-id
   node secret.mjs set gcal-client-secret
   ```
   要求するスコープは読み取り専用（`classroom.*.readonly` / `drive.readonly`）と、カレンダーの `calendar.events` だけ。

### 4. 初回ログイン（セッション・トークン保存）
```bash
node login.mjs                 # SIRIUS / Sakai。state.json を保存
node classroom/auth.mjs        # Classroom / Drive API の同意（大学アカウントを選ぶ）→ classroom-token.json
node classroom/login.mjs       # Google のブラウザセッション（フォーム・添付用）→ classroom_state.json
node google-auth.mjs           # カレンダー同期を使う場合のみ（同期先カレンダーを持つアカウントで）
```
Google が CAPTCHA を出したら、その文字だけ手入力 → 以降は自動。

### 5. 取得
```bash
node fetch-all.mjs             # 全ソース一括（macOS は ./fetch-all.sh でも同じ）
node fetch-all.mjs --dry-run   # 実行する手順だけ表示
# 個別: node fetch.mjs / materials.mjs / assignments.mjs / classroom/fetch.mjs / reminder-daily.mjs
```
ダブルクリックでも動く: macOS は `取得.command`、Windows は `取得.cmd`。

### 6. 定期実行（任意）

**macOS（launchd）**
```bash
mkdir -p "$HOME/.local/share/sirius-fetch"
for f in launchd/*.plist.example; do
  case "$f" in *messages-watch*) continue ;; esac   # メッセージ監視は任意（下記）
  out="$HOME/Library/LaunchAgents/$(basename "${f%.example}")"
  sed -e "s#__INSTALL_DIR__#$PWD#g" -e "s#__HOME__#$HOME#g" -e "s#__NODE__#$(command -v node)#g" "$f" > "$out"
  launchctl load "$out"
done
```

**Windows（タスクスケジューラ。管理者権限は不要）**
```powershell
powershell -ExecutionPolicy Bypass -File windows\install-tasks.ps1             # 登録
powershell -ExecutionPolicy Bypass -File windows\install-tasks.ps1 -Uninstall  # 削除
```

既定スケジュール:

| 処理 | macOS（launchd） | Windows（タスク名） |
|---|---|---|
| 全取得 `fetch-all` | 7:00 / 12:00 / 19:00 | 7:00 / 19:00（`sirius-fetch-fetch`） |
| セッション延命 `keepalive` | 60分ごと | 60分ごと＋ログオン時（`sirius-fetch-keepalive`） |
| 出席クイズの監視 `attend --notify` | 15分ごと | 15分ごと（`sirius-fetch-attend-watch`） |
| Sakai メッセージの監視 `messages --watch`（任意） | 30秒ごと | 1分ごと（`sirius-fetch-messages-watch`。`-WithMessages` を付けた時だけ） |

**Sakai メッセージの取得は既定でオフ**。メッセージ機能で連絡・提出指示を送ってくる科目がある人だけ有効にする:
- 全取得に含める: 環境変数 `SIRIUS_ENABLE_MESSAGES=1`（launchd なら fetch の plist の `EnvironmentVariables` に足す）
- 監視も使う: macOS は `launchd/com.example.sirius-messages-watch.plist.example` を上と同じ置換で置いて `launchctl load`、Windows は `install-tasks.ps1 -WithMessages`
- 対象は時間割にある英語科目（科目コード `el`）。`node messages.mjs --course <科目名の一部>` や `--all` で手動実行もできる

出席・メッセージの監視は、スクリプト側で授業時間帯以外はすぐ終了する。出席は **通知だけ** で、自動提出は定期実行に組み込まない。
Windows のタスクは「ユーザーがログオンしているときのみ実行」で登録する（資格情報マネージャーはログオン中のユーザーでしか読めないため）。

### 7. 個人設定（任意）

- 履修科目の整理を使うなら、`migrate-config.example.mjs` を `private/migrate-config.mjs` にコピーして編集。
- 環境変数（PowerShell では `$env:名前='値'`、恒久的に設定するならシステムの環境変数に）:

| 変数 | 用途 | 既定 |
|---|---|---|
| `SIRIUS_REMINDER_DIR` | リマインドファイルの出力先（`reminder-daily.mjs`） | `~/Documents/TUAT/_リマインド` |
| `SIRIUS_REMINDER_FORMAT` | リマインドファイルの形式 `md` / `txt` | `md` |
| `SIRIUS_REMINDER_AFTER` | 既存のファイルに課題の節を入れる位置（この見出しの節の直後） | ファイルの末尾 |
| `SIRIUS_IGNORE_KEYWORDS` | 課題扱いしない見出し（カンマ区切り） | なし |
| `SIRIUS_GCAL_ID` | 課題を同期する Google カレンダーの ID | `primary` |
| `SIRIUS_ENTRANCE_YEAR` | 入学年度（科目フォルダ `TUAT_<学年>_<学期>` の学年を決める） | 今年 |
| `SIRIUS_ENABLE_MESSAGES` | `1` で全取得に Sakai メッセージを含める | オフ |
| `SIRIUS_TERM` | Sakai サイトを学期で絞る（例 `2026_02`） | 全サイト / 今年度 |
| `SIRIUS_MAT_DIR` | 教材の一時置き場 | `~/Downloads/sirius-materials` |
| `SIRIUS_PYTHON` | パスワード付き PDF の解除に使う Python | macOS: Homebrew の python3 / Windows: `python` |
| `CHROME_PROFILE` | OAuth 同意を開く Chrome プロファイル | 自動判定 / `Default` |
| `SIRIUS_DEBUG` | ログイン処理のデバッグ出力 | なし |

### 8. Chrome 拡張（ブラウザ操作中の自動ログイン・任意）
1. `chrome-ext/manifest.json` には `key` を含めていない（拡張IDは読み込み時に自動採番）。
   固定IDが必要なら自分の鍵を生成し `private/ext-keys/` に保存、`key`(公開鍵) を manifest に追記。
2. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `chrome-ext/` を指定。
   表示された拡張IDを控える。
3. Native Messaging host を登録する。ホスト名（`com.example.sirius_login`）は `chrome-ext/background.js` の `NATIVE_HOST` と一致させること。
   - **macOS**: `chrome-ext/com.example.sirius_login.json.example` の `__INSTALL_DIR__` と `__EXTENSION_ID__` を置換して置く。
     ```bash
     dst="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
     mkdir -p "$dst"
     sed -e "s#__INSTALL_DIR__#$PWD#g" -e "s#__EXTENSION_ID__#<拡張ID>#g" \
       chrome-ext/com.example.sirius_login.json.example > "$dst/com.example.sirius_login.json"
     ```
   - **Windows**: マニフェストの作成とレジストリ登録をスクリプトで行う。
     ```powershell
     powershell -ExecutionPolicy Bypass -File windows\install-native-host.ps1 -ExtensionId <拡張ID>
     ```

---

## スキル（`skills/`）

Claude Code / Codex 用のワークフロースキル。`tuat` が統括で、以下を束ねる:
`sirius-session` / `sirius-portal` / `sirius-lms` / `sirius-reminder` / `sirius-submit` / `sirius-attend` / `sirius-register` /
`classroom-fetch` / `classroom-forms` / `classroom-submit` / `tuat-organize` / `lecture-feedback-form`。

```bash
node install-skills.mjs            # ~/.claude/skills と ~/.codex/skills（あるもの）へリンク
node install-skills.mjs --dry-run  # 何をするかだけ表示
node install-skills.mjs --target <dir>
```
macOS は symlink、Windows はジャンクション（管理者権限・開発者モード不要）で張る。既にある実フォルダは上書きしない。
スキル内の `<学籍番号>` `<ログインID>` は自分の値に読み替える。本人情報は `~/.local/share/sirius-fetch/identity.json`
（`{"studentId": "...", "name": "..."}`）に置くと、提出前の検査と感想フォームが使う。

> 提出系スキル（`*-submit`）・出席・履修登録・フォームの最終ボタンは、安全のため自動では押さない設計。

---

## 関連リポジトリ

- [tuat-report-kit](https://github.com/harupan119/tuat-report-kit) — 演習・実験レポートを設計図（spec）→ 執筆 → 機械検査 → PDF の順で作るスキル集（`tuat-report` / `tuat-report-pdf`）。取得した教材・課題PDFを入力に使える。

## セキュリティ方針

- 認証情報はコード・リポジトリに置かない（実行時に Keychain / 資格情報マネージャーから取得）。
- 個人情報・鍵・cookie・トークンは `private/` と `~/.local/share/` に隔離し gitignore 済み。
- `*.pem` / `*_state.json` / `ext-keys/` は二重で gitignore。
- Classroom / Drive の OAuth スコープは読み取り専用。提出系は本人のブラウザセッションで行い、最終ボタンは本人が押す。

## 法的・規約上の適法性

TUAT の公式規程（情報システム管理規程、IMC 利用条件、情報システム利用ガイド等）を調査し、自動化・スクレイピング・bot アクセスを明示的に禁じる条項がないことを確認済み。不正アクセス禁止法についても、自分のアカウントへのプログラムによるログインは該当しない。詳細は **[LEGAL.md](LEGAL.md)** を参照。

## 免責
個人利用・学習目的のツールです。利用は各自の責任で、所属機関の規約に従ってください。
