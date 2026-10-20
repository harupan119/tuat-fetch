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
  const STEP_KEY = 'sirius_autologin_totp_step'; // 最後にTOTPを送った30秒枠
  const SENT_KEY = 'sirius_autologin_totp_sent'; // TOTP送信時刻（タブ横断の上限用）
  let warned = false;
  const warnOnce = (m) => { if (!warned) { warned = true; console.warn('[sirius-autologin] ' + m); } };

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
  const MAX_SEL_CLICKS = 5;
  let selClicks = 0, selAt = 0;

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
      //    Exticのハンドラ準備前に押すと空振りするので、#totp が出るまで間隔を空けて押し直す
      const sel = $('#totp-form-selector');
      if (vis(sel) && !vis($('#totp')) && selClicks < MAX_SEL_CLICKS && Date.now() - selAt > 1000) {
        selClicks++; selAt = Date.now(); sel.click(); await sleep(400);
      }
      const totp = $('#totp');
      if (vis(totp) && !totp.value && !done.has('totp')) {
        // Google(SAML)経由だと①を通らないので、TOTP送信でも試行回数を数える
        if (attempts() >= MAX_ATTEMPTS) { warnOnce('試行上限に達したため停止（手動でログインしてください）'); return; }
        // 同じ30秒枠のコードは二度送らない（再送は拒否される）。直近10分の送信回数もタブ横断で数える。
        // 複数タブが同時に判定すると localStorage だけでは競合するので、Web Locks で直列化し、
        // 書き込みが他タブへ伝わるまで1秒保持してから解放する
        done.add('totp');
        const go = await navigator.locks.request('sirius-autologin-totp', async () => {
          const step = Math.floor(Date.now() / 30000);
          if (+(localStorage.getItem(STEP_KEY) || 0) >= step) return false; // 次の枠まで待つ（poll / DOM変化で再判定）
          const recent = JSON.parse(localStorage.getItem(SENT_KEY) || '[]').filter((t) => Date.now() - t < 600000);
          if (recent.length >= MAX_ATTEMPTS) { warnOnce('直近10分のTOTP送信が上限のため停止（手動でログインしてください）'); return false; }
          localStorage.setItem(SENT_KEY, JSON.stringify([...recent, Date.now()]));
          localStorage.setItem(STEP_KEY, step);
          await sleep(1000);
          return true;
        });
        if (!go) { done.delete('totp'); return; }
        const fresh = await getCreds(); // 直前に現在コードを取得（使い回し回避）
        if (!fresh.ok) return;
        sessionStorage.setItem(KEY, attempts() + 1);
        setVal(totp, fresh.code);
        clickSubmit('#totp-form-wrapper');
        return;
      }
    } finally { busy = false; }
  }

  tick();
  const mo = new MutationObserver(() => tick());
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  // DOM変化が無いまま空振りした場合の再判定用（最大60秒）
  const poll = setInterval(tick, 1000);
  setTimeout(() => clearInterval(poll), 60000);
})();
