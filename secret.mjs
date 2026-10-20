// secret.mjs — 認証情報を OS の資格情報ストアに登録・確認する（macOS Keychain / Windows 資格情報マネージャー）
//   使い方:
//     node secret.mjs set sirius-user      # 伏せ字で入力して登録（既存は上書き）
//     node secret.mjs check                # 主要な項目が登録済みかだけ表示（値は出さない）
//     node secret.mjs check gcal-client-id # 指定した項目だけ確認
//   秘密を扱うので、AI エージェントや他人に実行させず、本人が自分のターミナルで実行すること。
import { getSecret, setSecretInteractive, secretStoreName } from './platform.mjs';

const KNOWN = ['sirius-user', 'sirius-pass', 'sirius-totp', 'sirius-gmail', 'classroom-client-id', 'classroom-client-secret', 'gcal-client-id', 'gcal-client-secret'];
const [cmd, ...names] = process.argv.slice(2);

if (cmd === 'set' && names.length === 1) {
  console.log(`▶ ${secretStoreName} に「${names[0]}」を登録します（入力は表示されません）`);
  const ok = setSecretInteractive(names[0]);
  console.log(ok && getSecret(names[0]) ? '✓ 登録しました' : '✗ 登録できませんでした');
  process.exit(ok ? 0 : 1);
} else if (cmd === 'check') {
  let missing = 0;
  for (const n of names.length ? names : KNOWN) {
    const has = !!getSecret(n);
    if (!has) missing++;
    console.log(`${has ? '✓' : '·'} ${n}${has ? '' : '（未登録）'}`);
  }
  process.exit(names.length && missing ? 1 : 0);
} else {
  console.error('使い方: node secret.mjs set <名前> | node secret.mjs check [名前...]');
  process.exit(1);
}
