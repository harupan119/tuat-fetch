---
name: sirius-session
description: "TUAT/SIRIUS・Sakai(LMS)・Google Classroom へのログインとセッション維持。『シリウスにログインできない』『セッション切れ』『MFA/OTPで弾かれる』『keepaliveが動かない』『再ログインして』等で使う。tuat 系の前提。実体は ~/Projects/sirius-fetch/。"
---

# SIRIUS セッション/ログイン

全取得スキルの前提。認証情報は **macOS Keychain のみ**（コード・拡張に秘密を置かない）。

## ログインの仕組み

- SIRIUS = CampusSquare(NTTデータ九州) + **Extic SSO**(`tuat.ex-tic.com`)。3段フロー: ①ID(`#login input#identifier`)→ ②PW(`#password`)→ ③2FA(`#totp-form-selector`「OTP(App)」ボタン→`#totp`)。
- **完全自動ログイン**: `autoLogin()`(lib.mjs) が Keychain の `sirius-user`/`sirius-pass`/`sirius-totp` を読み、`genTOTP()` でコード生成して全工程を最大2回試行（TOTPは使い捨てのため拒否時は新コードでやり直し）。
- **ログインIDは `<ログインID>`**（sから始まる。8桁学籍番号ではない）。
- セッション切れ時は `getSession()` が自動ログイン→失敗時のみ headed 対話 `interactiveLogin()` にフォールバック。スリープでセッションが死んでも次回実行で無人復帰するので **pmset強制起床は不要**。
- **Sakai は SIRIUS と別SSO** → 開くと Extic に戻されるので `openSakai()` が `driveExticLogin()` で自動再ログイン。
- **Google Classroom**: APIは大学Workspaceが学生に不許可 → スクレイプ方式。`classroom/login.mjs` が大学メール(Keychain `sirius-gmail`)→Extic統合認証を自動突破→ `classroom_state.json` 保存。**重要: bundled Chromiumは必ずCAPTCHAで弾かれる→`channel:'chrome'`(本物のChrome)で起動**。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node login.mjs              # SIRIUS/Sakai の初回/再ログイン(対話)
node classroom/login.mjs    # Classroom の初回/再ログイン
node keepalive.mjs          # セッション延命の単発ping
SIRIUS_DEBUG=1 node ...     # デバッグ
```

## セッション延命

- maxInactiveInterval=7200s(120分)の**アイドル制**。SIRIUS側`extendSession()`、Sakai側`/direct/session/current.json` ping でリセット。
- launchd `com.example.sirius-keepalive`(StartInterval 3600s)が `keepalive.mjs` を定期実行。
- 状態ファイル: `~/.local/share/sirius-fetch/state.json`(SIRIUS/Sakai)・`classroom_state.json`(Classroom)。

## トラブル時

- 「Sakaiに入れない/Exticに戻る」→ `openSakai`の再ログインが効いているか、`SIRIUS_DEBUG=1`で確認。
- 「ClassroomでCAPTCHA」→ `channel:'chrome'`になっているか（実Chrome必須）。
- TOTP拒否が続く → Keychainの `sirius-totp` シードを確認・再登録（`security add-generic-password -U -a sirius -s sirius-totp -w`、入力は伏せ字）。
- 認証情報の更新はユーザー自身が自分のTerminalでKeychainに対して行う（秘密はチャットに出さない）。
