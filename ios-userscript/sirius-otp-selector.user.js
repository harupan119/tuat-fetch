// ==UserScript==
// @name         SIRIUS OTP Selector
// @description  Extic(SIRIUS)ログインの「次へ」・2FA方式選択・OTP送信を自動化（値の入力はKeePassium。iPhone Safari + Userscripts用）
// @version      1.6
// @match        https://tuat.ex-tic.com/*
// @run-at       document-idle
// ==/UserScript==
// 秘密は一切持たない。ID/パスワード/TOTPの値は KeePassium の自動入力で入れ、入った時点でこのスクリプトが送信する。
// セレクタは chrome-ext/content.js と同じ（①#login #identifier ②#login #password ③#totp-form-selector → #totp）。
(() => {
  const vis = (el) => el && el.offsetParent !== null;
  const $ = (s) => document.querySelector(s);
  const MAX_ATTEMPTS = 3;            // 連続失敗でのアカウントロック防止（タブ単位）
  const KEY = 'sirius_ios_attempts';
  const attempts = () => +(sessionStorage.getItem(KEY) || 0);
  const MAX_SEL_CLICKS = 5;
  let selClicks = 0, selAt = 0;
  const sent = new Set();            // 同じ値で二重送信しない
  let status = '';

  const clickSubmit = (scope) => {
    const btns = [...document.querySelectorAll(`${scope} button[type=submit], ${scope} input[type=submit]`)];
    const b = btns.find(vis) || btns[0];
    if (b) { b.click(); return true; }
    return false;
  };

  // 診断用バッジ（iPhoneは開発者ツールが無いため画面に状態を出す）。値そのものは表示しない
  const DEBUG = true;
  let badge = null;
  function show() {
    if (!DEBUG || !document.body) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2147483647;background:#000c;color:#fff;font:11px/1.3 -apple-system;padding:4px 6px;border-radius:4px;max-width:90vw;white-space:pre-wrap;pointer-events:none';
      document.body.appendChild(badge);
    }
    const sel = $('#totp-form-selector'), totp = $('#totp');
    const text = `OTP Selector v1.6 試行:${attempts()}/${MAX_ATTEMPTS} ${status}\nselector:${sel ? (vis(sel) ? '表示' : '非表示') : 'なし'} totp:${totp ? (vis(totp) ? '表示' : '非表示') : 'なし'} 押下:${selClicks}\n${location.pathname}`;
    // 書き換え自体が MutationObserver を発火させるので、変化した時だけ更新する（無限ループ防止）
    if (badge.textContent !== text) badge.textContent = text;
  }

  // 値が入った欄を一度だけ送信する。手入力の途中で送らないよう、値が0.8秒変わらなくなってから送る
  const last = {};
  function submitOnce(tag, el, scope, ready) {
    if (!vis(el) || !ready(el.value)) return false;
    const now = Date.now();
    if (!last[tag] || last[tag].v !== el.value) { last[tag] = { v: el.value, t: now }; return false; }
    if (now - last[tag].t < 800) return false;
    const k = tag + ':' + el.value.length + ':' + location.pathname;
    if (sent.has(k)) return false;
    sent.add(k);
    status = `${tag}送信`;
    return clickSubmit(scope);
  }

  function tick() {
    show();
    // ① ID: KeePassiumで入ったら「次へ」
    const id = $('#login input#identifier');
    if (vis(id) && id.value) {
      if (attempts() >= MAX_ATTEMPTS) { status = '試行上限: 手動で'; return; }
      if (submitOnce('ID', id, '#login', (v) => v.length > 0)) { sessionStorage.setItem(KEY, attempts() + 1); return; }
    }
    // ② パスワード: 入ったら「次へ」
    const pw = $('#login input#password');
    if (submitOnce('PW', pw, '#login', (v) => v.length > 0)) return;
    // ③ 方式選択: 「アプリOTP」を #totp が出るまで押し直す（ハンドラ準備前の空振り対策）
    const sel = $('#totp-form-selector');
    const totp = $('#totp');
    if (vis(sel) && !vis(totp) && selClicks < MAX_SEL_CLICKS && Date.now() - selAt > 1000) {
      selClicks++; selAt = Date.now(); sel.click(); status = 'OTP方式選択';
      return;
    }
    // ④ TOTP: 6桁入ったら送信。入力欄へのフォーカスはしない（iOSはスクリプトからのフォーカスでキーボードを出さず、
    //    先にフォーカスするとタップ時にAutoFill候補が出なくなる。v1.4で実測）
    if (vis(totp)) {
      // iOSは autocomplete="one-time-code" の欄にだけ確認コード(OTP)のAutoFill候補を出す。属性だけ付け、フォーカスはしない
      if (totp.getAttribute('autocomplete') !== 'one-time-code') {
        totp.setAttribute('autocomplete', 'one-time-code');
        totp.setAttribute('inputmode', 'numeric');
      }
      submitOnce('OTP', totp, '#totp-form-wrapper', (v) => /^\d{6}$/.test(v.trim()));
    }
  }

  tick();
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  // AutoFill は input イベントを出さないことがあるので、値の変化はポーリングでも拾う（最大3分）
  document.addEventListener('input', tick, true);
  const poll = setInterval(tick, 700);
  setTimeout(() => clearInterval(poll), 180000);
})();
