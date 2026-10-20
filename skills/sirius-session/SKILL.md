---
name: sirius-session
description: "TUAT/SIRIUS・Sakai(LMS)・Google Classroom へのログインとセッション維持、認証情報(ID/パス/TOTP/OAuthクライアント)の登録。『シリウスにログインできない』『セッション切れ』『MFA/OTPで弾かれる』『keepaliveが動かない』『再ログインして』『Classroomの認証切れ』『Windowsでセットアップ』等で使う。macOS / Windows 両対応。tuat 系の前提。実体は ~/Projects/sirius-fetch/。"
---

# SIRIUS セッション/ログイン（macOS / Windows）

全取得スキルの前提。認証情報は **OS の資格情報ストアだけ**に置く（コード・拡張・チャットに秘密を出さない）。

## OS ごとの違い（他の tuat 系スキルもここを参照）

| 項目 | macOS | Windows |
|---|---|---|
| 認証情報の保存先 | Keychain（account=`sirius`, service=<名前>） | 資格情報マネージャー（PasswordVault, resource=<名前>, user=`sirius`） |
| 登録コマンド | `node secret.mjs set <名前>`（共通。入力は伏せ字） | 同左 |
| 定期実行 | launchd（`launchd/*.plist.example` から作る） | タスクスケジューラ（`windows\install-tasks.ps1`） |
| ダブルクリック実行 | `取得.command` | `取得.cmd` |
| 通知 | 通知センター（terminal-notifier があればクリックで開く） | トースト通知（クリックで開く） |
| Chrome 拡張の自動ログイン | `chrome-ext/native-host.sh` | `chrome-ext\native-host.cmd`（`windows\install-native-host.ps1` で登録） |
| データ・状態 | `~/.local/share/sirius-fetch/` | `%USERPROFILE%\.local\share\sirius-fetch\`（同じ相対位置） |

- OS で分かれる処理は `platform.mjs` に集約してある。各スクリプトは OS を意識しない。
- どの OS でも環境変数 `SIRIUS_SECRET_<名前>`（例 `SIRIUS_SECRET_SIRIUS_USER`）があればそれを優先する。
- **Windows の Claude Code は Git Bash でコマンドを実行する**ので、スキル内の `cd ~/Projects/sirius-fetch` や `node ...` はそのまま使える。PowerShell（Codex など）では環境変数の書き方だけ違う: `SIRIUS_TERM=2026_02 node materials.mjs` → `$env:SIRIUS_TERM='2026_02'; node materials.mjs`。Python は `python3` ではなく `python`。

## 初回セットアップ（新しい PC。本人が自分のターミナルで行う）

```bash
cd ~/Projects/sirius-fetch          # Windows も同じ場所に clone する
npm install
npx playwright install chromium
# 認証情報（値は聞かれたら本人が入力。AI に入力させない・チャットに貼らない）
node secret.mjs set sirius-user     # SSO ログインID（s から始まる。8桁の学籍番号ではない）
node secret.mjs set sirius-pass
node secret.mjs set sirius-totp     # TOTP シード（Base32）
node secret.mjs set sirius-gmail    # 大学 Google アカウント
node secret.mjs set classroom-client-id      # Classroom API の OAuth クライアント（自分の Google Cloud プロジェクトで作る。README 参照）
node secret.mjs set classroom-client-secret
node secret.mjs check               # 登録済みかだけ確認（値は出ない）
node login.mjs                      # SIRIUS/Sakai のセッション保存
node classroom/auth.mjs             # Classroom/Drive API の同意（ブラウザで大学アカウントを選ぶ）
node classroom/login.mjs            # Google のブラウザセッション（フォーム・提出用）
```
定期実行: macOS は `launchd/*.plist.example` のパスを置換して `~/Library/LaunchAgents/` に置き、`launchctl load`（手順は README）。Windows は `powershell -ExecutionPolicy Bypass -File windows\install-tasks.ps1`（削除は `-Uninstall`）。

**Claude/Codex は `secret.mjs set` を実行しない**。秘密の入力が要る場面ではコマンドを示して本人に任せる（`node secret.mjs check` は値を出さないので実行してよい）。

## ログインの仕組み

- SIRIUS = CampusSquare + **Extic SSO**(`tuat.ex-tic.com`)。3段フロー: ①ID(`#login input#identifier`)→ ②PW(`#password`)→ ③2FA(`#totp-form-selector`「OTP(App)」ボタン→`#totp`)。
- **完全自動ログイン**: `autoLogin()`(lib.mjs) が資格情報ストアの `sirius-user`/`sirius-pass`/`sirius-totp` を読み、`genTOTP()` でコード生成して全工程を最大2回試行（TOTPは使い捨てのため拒否時は新コードでやり直し）。
- **ログインIDは `<ログインID>`**（sから始まる。8桁学籍番号ではない）。
- セッション切れ時は `getSession()` が自動ログイン→失敗時のみ headed 対話 `interactiveLogin()` にフォールバック。スリープでセッションが死んでも次回実行で無人復帰するので **強制起床は不要**。
- **Sakai は SIRIUS と別SSO** → 開くと Extic に戻されるので `openSakai()` が `driveExticLogin()` で自動再ログイン。

## Google Classroom は2系統ある（2026-08-11 に取得系を API へ移行）

| 系統 | 保存先 | 使うもの | 切れた時 |
|---|---|---|---|
| **API**（OAuth、読み取り専用スコープ） | `classroom-token.json` | 教材取得 `classroom/materials.mjs`・未提出 `classroom/fetch.mjs`・フォーム発見 `classroom/scan-forms.mjs`・提出ゲート `classroom/gate.mjs` | exit 1/2 → `node classroom/auth.mjs` |
| **ブラウザセッション**（Playwright） | `classroom_state.json` | フォームの中身と入力 `form-contents.mjs`/`fill-form.mjs`・添付 `classroom/attach.mjs` | `node classroom/login.mjs` |

- API は 2026-08-11 以降、学生アカウントで読み取りが通っている（それ以前の版はスクレイプ方式だった）。提出・添付の権限は持たせていないので、添付だけはブラウザ系統で行う。
- `classroom/auth.mjs` は Chrome の `Local State` から大学アカウント(@st.go.tuat.ac.jp)のプロファイルを探して開く（`CHROME_PROFILE` で明示可）。`redirect_uri_mismatch` は `--port <登録済みポート>`。
- `classroom/login.mjs` は大学メール(`sirius-gmail`)→Extic統合認証を自動突破する。**bundled Chromium は CAPTCHA で弾かれるので `channel:'chrome'`（本物の Chrome）で起動**する。Windows も Chrome のインストールが要る。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node login.mjs              # SIRIUS/Sakai の初回/再ログイン(対話)
node classroom/login.mjs    # Classroom ブラウザセッションの初回/再ログイン
node classroom/auth.mjs     # Classroom/Drive API の再同意
node keepalive.mjs          # セッション延命の単発ping
node secret.mjs check       # 認証情報が揃っているか
SIRIUS_DEBUG=1 node ...     # デバッグ（PowerShell は $env:SIRIUS_DEBUG='1'）
```

## セッション延命

- maxInactiveInterval=7200s(120分)の**アイドル制**。SIRIUS側`extendSession()`、Sakai側`/direct/session/current.json` ping でリセット。
- 60分ごとに `keepalive.mjs` を実行: macOS は launchd `com.example.sirius-keepalive`、Windows はタスク `sirius-fetch-keepalive`（ログオン時にも1回）。
- 状態ファイル: `~/.local/share/sirius-fetch/state.json`(SIRIUS/Sakai)・`classroom_state.json`(Classroom ブラウザ)・`classroom-token.json`(Classroom API)。

## トラブル時

- 「Sakaiに入れない/Exticに戻る」→ `openSakai`の再ログインが効いているか、`SIRIUS_DEBUG=1`で確認。
- 「ClassroomでCAPTCHA」→ `channel:'chrome'`になっているか（実Chrome必須）。
- 「Classroom の取得が exit 2」→ API の認証切れ。`node classroom/auth.mjs`（`classroom/login.mjs` では直らない）。
- TOTP拒否が続く → `sirius-totp` のシードを確認し、本人が `node secret.mjs set sirius-totp` で再登録。
- Windows で `secret.mjs` が読めない → Windows PowerShell 5.1（`powershell.exe`）が要る。PowerShell 7 だけの環境では PasswordVault を読めない。タスクスケジューラ実行はログオン中のユーザーでのみ資格情報を読める。
- 認証情報の更新は本人が自分のターミナルで行う（秘密はチャットに出さない）。
