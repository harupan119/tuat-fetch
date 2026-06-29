# sirius-fetch

東京農工大（TUAT）の学習環境 **SIRIUS / Sakai(LMS) / Google Classroom** から、
時間割・休講補講・お知らせ・未提出課題・教材を **無人で取得** するための個人用ツール群です。

- ログインは Extic SSO（ID / パスワード / TOTP 2段階認証）を **macOS Keychain + TOTP自動生成** で突破
- セッションは `keepalive` で延命、切れたら自動再ログイン
- 取得結果は Obsidian のデイリーノートにも連携可能（`reminder-daily.mjs`）
- 付属の Chrome 拡張でブラウザ操作中の自動ログインも可能

> ⚠️ 本リポジトリには **認証情報・個人を特定する情報を置きません**。
> - 認証情報（ID/パス/TOTP/メール）は実行時に macOS Keychain から取得。
> - 鍵・実 plist などの個人物は gitignore された `private/` フォルダに隔離。
> - 学籍番号・ログインIDはスキル内で `<学籍番号>` `<ログインID>` のプレースホルダ。
> - 履修科目・整理ルールは `private/migrate-config.mjs`（非公開）に分離し、公開側は架空サンプル `migrate-config.example.mjs` のみ。
> - Obsidian のパス等は環境変数で指定（下記）。

---

## 構成

```
.
├── *.mjs                  # SIRIUS/Sakai 取得スクリプト（lib.mjs が共通処理）
├── classroom/*.mjs        # Google Classroom 取得・提出
├── chrome-ext/            # 自動ログイン Chrome 拡張（Native Messaging で Keychain 連携）
├── launchd/*.example      # 定期実行 plist のテンプレート（要・パス置換）
├── skills/                # Claude / Codex 用スキル（tuat ほか。morning は非公開）
├── fetch-all.sh           # 全ソース一括取得（launchd / ダブルクリック共用）
└── private/               # ← gitignore。鍵・実 plist など個人物をここに置く
```

`private/` に置くもの（**コミットされません**）:
- `private/ext-keys/` … Chrome 拡張の鍵（`ext_private.pem` など。各自生成）
- `private/launchd/` … パス置換済みの実 plist（任意。バックアップ用）
- `private/migrate-config.mjs` … 自分の履修科目・整理ルール（`migrate-config.example.mjs` をコピーして編集）

実行時の状態（cookie 等）は `~/.local/share/sirius-fetch/` に保存され、リポジトリ外です。

---

## セットアップ（Claude / 人間どちらでも実行可）

前提: macOS（Apple Silicon 想定）、Homebrew、Node.js（`/opt/homebrew/bin/node`）、Google Chrome。

### 1. 依存インストール
```bash
npm install
npx playwright install chromium   # 拡張なし運用なら chromium、Classroom は実 Chrome 推奨
```

### 2. 認証情報を Keychain に登録
account は固定で `sirius`、service ごとに値を登録する（入力は伏せ字 `-w`）:
```bash
security add-generic-password -U -a sirius -s sirius-user  -w   # SSO ログインID（例: s実数字英字）
security add-generic-password -U -a sirius -s sirius-pass  -w   # SSO パスワード
security add-generic-password -U -a sirius -s sirius-totp  -w   # TOTP のシード（Base32）※取得方法は下記
security add-generic-password -U -a sirius -s sirius-gmail -w   # 大学 Google アカウント(メール)
```

> **TOTPシードの取得**: TUAT の MFA 設定ページ
> （[多要素認証(MFA)の設定](https://www.imc.tuat.ac.jp/info-system0/tuat-gateway/setup-mfa.html)）で
> 認証アプリを登録する際に表示される手動入力用キー（Base32文字列）が `sirius-totp` のシード。
> 登録済みで再表示できない場合は、一度認証アプリを登録し直すとキーを取得できる。

### 3. 初回ログイン（セッション保存）
```bash
node login.mjs                 # SIRIUS / Sakai。state.json を保存
node classroom/login.mjs       # Google Classroom。classroom_state.json を保存（既定 headed）
```
Google が CAPTCHA を出したら、その文字だけ手入力 → 以降は自動。

### 4. 取得
```bash
./fetch-all.sh                 # 全ソース一括
# 個別: node fetch.mjs / materials.mjs / assignments.mjs / classroom/fetch.mjs / reminder-daily.mjs
```

### 5. 定期実行（launchd・任意）
```bash
mkdir -p "$HOME/.local/share/sirius-fetch"
for f in launchd/*.plist.example; do
  out="$HOME/Library/LaunchAgents/$(basename "${f%.example}")"
  sed -e "s#__INSTALL_DIR__#$PWD#g" -e "s#__HOME__#$HOME#g" "$f" > "$out"
  launchctl load "$out"
done
```
既定スケジュール: 取得=7:00/12:00/19:00、keepalive=60分ごと。

### 6. 個人設定（任意）
- 履修科目の整理を使うなら、`migrate-config.example.mjs` を `private/migrate-config.mjs` にコピーして編集。
- Obsidian 連携を使うなら環境変数を設定（`reminder-daily.mjs`）:
  ```bash
  export SIRIUS_DIARY_DIR="$HOME/Documents/Obsidian/<自分のVault>/Diary"  # デイリーノート格納先
  export SIRIUS_IGNORE_KEYWORDS="募集,アンケート"                          # 課題扱いしない見出し（任意・カンマ区切り）
  ```

### 7. Chrome 拡張（ブラウザ操作中の自動ログイン・任意）
1. `chrome-ext/manifest.json` には `key` を含めていない（拡張IDは読み込み時に自動採番）。
   固定IDが必要なら自分の鍵を生成し `private/ext-keys/` に保存、`key`(公開鍵) を manifest に追記。
2. `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `chrome-ext/` を指定。
   表示された拡張IDを控える。
3. Native Messaging host を登録: `chrome-ext/com.example.sirius_login.json.example` をコピーし、
   `__INSTALL_DIR__`（このリポの絶対パス）と `__EXTENSION_ID__`（上で控えたID）を置換して、
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.example.sirius_login.json` に置く。
   ```bash
   dst="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
   mkdir -p "$dst"
   sed -e "s#__INSTALL_DIR__#$PWD#g" -e "s#__EXTENSION_ID__#<拡張ID>#g" \
     chrome-ext/com.example.sirius_login.json.example > "$dst/com.example.sirius_login.json"
   ```
   ホスト名（`com.example.sirius_login`）は `chrome-ext/background.js` の `NATIVE_HOST` と一致させること。

---

## スキル（`skills/`）

Claude Code / Codex 用のワークフロースキル。`tuat` が統括で、以下を束ねる:
`sirius-session` / `sirius-portal` / `sirius-lms` / `sirius-reminder` /
`classroom-fetch` / `classroom-submit` / `sirius-submit` / `tuat-organize`。
利用するには各自の環境のスキルディレクトリ（例 `~/.claude/skills/`）へコピーし、
`<学籍番号>` `<ログインID>` を自分の値に置換する。

> 提出系スキル（`*-submit`）の最終「提出」ボタンは安全のため自動では押さない設計。

---

## セキュリティ方針

- 認証情報はコード・リポジトリに置かない（実行時に Keychain から取得）。
- 個人情報・鍵・cookie は `private/` と `~/.local/share/` に隔離し gitignore 済み。
- `*.pem` / `*_state.json` / `ext-keys/` は二重で gitignore。

## 免責
個人利用・学習目的のツールです。利用は各自の責任で、所属機関の規約に従ってください。
