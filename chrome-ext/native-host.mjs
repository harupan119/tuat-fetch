// native-host.mjs — Chrome拡張からの要求でKeychainを読み、TOTPを生成して返す。
//   秘密は拡張側に一切持たせない。Chromeが allowed_origins の拡張からのみ起動できる。
//   Native Messaging: stdin=[4byte LE length][JSON], stdout=同形式。1メッセージ応答して終了。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

function kc(service) {
  try { return execFileSync('security', ['find-generic-password', '-a', 'sirius', '-s', service, '-w'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function genTOTP(secret, t = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) {
    const v = A.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  const ctr = Math.floor(t / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(ctr / 2 ** 32), 0); buf.writeUInt32BE(ctr >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | (h[o + 1] & 0xff) << 16 | (h[o + 2] & 0xff) << 8 | (h[o + 3] & 0xff)) % 1e6;
  return String(code).padStart(6, '0');
}

function send(obj) {
  const out = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = Buffer.alloc(4); hdr.writeUInt32LE(out.length, 0);
  process.stdout.write(Buffer.concat([hdr, out]));
}

// 1メッセージ受信したら応答して終了
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return;
  const user = kc('sirius-user'), pass = kc('sirius-pass'), totp = kc('sirius-totp');
  if (user && pass && totp) send({ ok: true, user, pass, code: genTOTP(totp) });
  else send({ ok: false, error: 'keychain entries missing (sirius-user/pass/totp)' });
  process.exit(0);
});
