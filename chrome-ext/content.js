// content.js — tuat.ex-tic.com のログイン画面で自動ログインを実行。
//   ①ユーザー名 ②パスワード ③2FA(アプリOTP/TOTP)。認証情報はbackground経由でNative host(Keychain)から取得。
//   AJAX同一ページ・画面遷移どちらにも対応（毎ロード実行＋DOM変化監視の再入可能ステートマシン）。
//   TOTP拒否時はExticがログイン先頭に戻り、自動で新コード再試行（自然な再ロードで）。
//   安全: 連続失敗でのアカウントロックを避けるため、タブ単位で試行上限。
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => el && el.offsetParent !== null;
  const $ = (s) => document.querySelector(s);
  const MAX_ATTEMPTS = 3;
  const KEY = 'sirius_autologin_attempts';
  const attempts = () => +(sessionStorage.getItem(KEY) || 0);

  let creds = null;
  const getCreds = () => new Promise((res) => chrome.runtime.sendMessage({ action: 'getCreds' }, (r) => res(r || { ok: false, error: 'no response' })));

  const clickSubmit = (scope) => {
    const btns = [...document.querySelectorAll(`${scope} button[type=submit], ${scope} input[type=submit]`)];
    const b = btns.find((x) => x.offsetParent !== null) || btns[0];
    if (b) b.click();
  };
  const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };

  const done = new Set();
  let busy = false;

  async function tick() {
    if (busy) return; busy = true;
    try {
      // ① ユーザー名
      const id = $('#login input#identifier');
      if (vis(id) && !id.value && !done.has('id')) {
        if (attempts() >= MAX_ATTEMPTS) { console.warn('[sirius-autologin] 試行上限に達したため停止（手動でログインしてください）'); return; }
        if (!creds) creds = await getCreds();
        if (!creds.ok) { console.warn('[sirius-autologin]', creds.error); return; }
        done.add('id');
        sessionStorage.setItem(KEY, attempts() + 1);
        setVal(id, creds.user);
        clickSubmit('#login');
        return;
      }
      // ② パスワード
      const pw = $('#login input#password');
      if (vis(pw) && !pw.value && !done.has('pw')) {
        if (!creds) creds = await getCreds();
        if (!creds.ok) return;
        done.add('pw');
        setVal(pw, creds.pass);
        clickSubmit('#login');
        return;
      }
      // ③ 2FA: アプリOTP を選択 → #totp に新コード → 送信
      const sel = $('#totp-form-selector');
      if (vis(sel) && !done.has('sel')) { done.add('sel'); sel.click(); await sleep(300); }
      const totp = $('#totp');
      if (vis(totp) && !totp.value && !done.has('totp')) {
        const fresh = await getCreds(); // 直前に現在コードを取得（使い回し回避）
        if (!fresh.ok) return;
        done.add('totp');
        setVal(totp, fresh.code);
        clickSubmit('#totp-form-wrapper');
        return;
      }
    } finally { busy = false; }
  }

  tick();
  const mo = new MutationObserver(() => tick());
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
})();
