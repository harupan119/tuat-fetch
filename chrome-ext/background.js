// background.js (service worker) — content scriptからの要求でNative hostを呼ぶ。
//   任意: keepalive（Chromeが起きている間だけ）でセッションを延命。
const NATIVE_HOST = 'com.example.sirius_login';
const KEEPALIVE = true;           // ← 不要ならこれを false に
const KEEPALIVE_MIN = 100;        // 延命ping間隔（分）。120分のidle未満で。

// content script → 認証情報（Keychain由来＋現在のTOTP）を返す
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === 'getCreds') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { action: 'creds' }, (resp) => {
      if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      else sendResponse(resp);
    });
    return true; // 非同期応答
  }
});

// ---- keepalive（任意） ----
async function ping() {
  if (!KEEPALIVE) return;
  // 認証済みリクエストでサーバのidleタイマーをリセット
  try { await fetch('https://web.sirius.tuat.ac.jp/campusweb/portal.do?page=main', { credentials: 'include', cache: 'no-store' }); } catch {}
  try { await fetch('https://lms.sirius.tuat.ac.jp/direct/session/current.json', { credentials: 'include', cache: 'no-store' }); } catch {}
}
if (KEEPALIVE) {
  chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('sirius-keepalive', { periodInMinutes: KEEPALIVE_MIN }));
  chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('sirius-keepalive', { periodInMinutes: KEEPALIVE_MIN }); ping(); });
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sirius-keepalive') ping(); });
}
