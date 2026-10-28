/* =====================================================================
 * Ramli-Geomancy :: Auth + Payment gate + Private history
 * Loaded by geomancy_dream_app_gwaji.html.
 * NOTE: no secret keys are used here. Payment verification happens
 * exclusively on the server.
 * ===================================================================== */
(function () {
  'use strict';

  const SESSION_KEY = 'ramli_session_token';
  const HISTORY_KEY = 'ramli_show_history';

  const state = {
    token: localStorage.getItem(SESSION_KEY) || null,
    user: null,
    config: { registration_fee_display: '₦15,000' }
  };

  const $ = (id) => document.getElementById(id);

  /* ------------------------------- API ------------------------------- */

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;

    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }

    const rotated = res.headers.get('X-Session-Token');
    if (rotated) {
      state.token = rotated;
      localStorage.setItem(SESSION_KEY, rotated);
    }
    if (res.status === 401 && state.token) {
      setToken(null);
      state.user = null;
      showAuthGate();
    }
    return { status: res.status, data };
  }

  function setToken(token) {
    state.token = token;
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  }

  /* ------------------------------- UI ------------------------------- */

  function shell() {
    let el = $('ramliGate');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ramliGate';
      el.className = 'fixed inset-0 z-[100] overflow-y-auto bg-gray-100 flex items-start justify-center p-4';
      document.body.appendChild(el);
    }
    return el;
  }

  function hideGates() {
    const g = $('ramliGate');
    if (g) g.remove();
    document.querySelectorAll('[data-ramli-locked]').forEach((n) => n.remove());
  }

  function lockApp() {
    const app = document.querySelector('body > div.w-full.max-w-lg');
    if (app && !app.hasAttribute('data-ramli-locked')) {
      app.setAttribute('data-ramli-locked', '1');
      app.style.filter = 'blur(6px)';
      app.style.pointerEvents = 'none';
      app.style.userSelect = 'none';
    }
  }

  function unlockApp() {
    const app = document.querySelector('body > div.w-full.max-w-lg');
    if (app && app.hasAttribute('data-ramli-locked')) {
      app.removeAttribute('data-ramli-locked');
      app.style.filter = '';
      app.style.pointerEvents = '';
      app.style.userSelect = '';
    }
  }

  function message(text, isError) {
    const box = $('ramliGateMsg');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'mt-3 text-xs rounded-lg px-3 py-2 ' +
      (isError ? 'bg-red-50 text-red-700 border border-red-200'
               : 'bg-emerald-50 text-emerald-700 border border-emerald-200');
    box.style.display = text ? 'block' : 'none';
  }

  /* --------------------------- Auth screen -------------------------- */

  function showAuthGate(messageText) {
    lockApp();
    shell().innerHTML = `
      <div class="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 mt-6 mb-6">
        <div class="text-center mb-5">
          <div class="w-14 h-14 rounded-full bg-tealHeader text-white flex items-center justify-center mx-auto mb-2">
            <i class="fa-solid fa-star-half-stroke text-2xl"></i>
          </div>
          <h1 class="text-lg font-bold text-gray-800">Ilmin Ramli &amp; Fassarar Mafarki</h1>
          <p class="text-xs text-gray-500 mt-1">Danna don halitta ko shiga. Bambancin rajista ₦${(state.config.registration_fee_display || '').replace('₦', '')} za a iya zai wannan karon kawai.</p>
        </div>

        <div class="flex gap-2 mb-4">
          <button id="btnTabRegister" onclick="ramliAuth.switchAuthTab('register')"
            class="flex-1 py-2 text-xs font-bold rounded-lg bg-tealHeader text-white">Halitta (Register)</button>
          <button id="btnTabLogin" onclick="ramliAuth.switchAuthTab('login')"
            class="flex-1 py-2 text-xs font-bold rounded-lg bg-gray-100 text-gray-600">Shiga (Sign in)</button>
        </div>

        <form id="ramliAuthForm" onsubmit="return ramliAuth.submitAuth(event)">
          <div id="fieldFullName" class="mb-3">
            <label class="block text-xs font-bold text-gray-600 mb-1">Sunaye babba</label>
            <input id="authFullName" type="text" placeholder="Musa Ibrahim Musa"
              class="w-full text-sm p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tealHeader focus:outline-none">
          </div>
          <div class="mb-3">
            <label class="block text-xs font-bold text-gray-600 mb-1">Imail</label>
            <input id="authEmail" type="email" placeholder="namijikimail@example.com"
              class="w-full text-sm p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tealHeader focus:outline-none">
          </div>
          <div class="mb-4">
            <label class="block text-xs font-bold text-gray-600 mb-1">Kalmar sirri</label>
            <input id="authPassword" type="password" placeholder="Kamfe 8 harfi ko sama"
              class="w-full text-sm p-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tealHeader focus:outline-none">
          </div>
          <div id="ramliGateMsg" class="mt-3 text-xs rounded-lg px-3 py-2" style="display:none"></div>
          <button type="submit" id="authSubmitBtn"
            class="w-full mt-4 bg-tealHeader hover:bg-tealDark text-white font-bold py-3 rounded-lg shadow-md">
            Ci gaba
          </button>
        </form>

        <p class="text-[11px] text-gray-400 text-center mt-4">
          Bayan ka yi rajista, za ka iya biyan bambancin rajista ₦${(state.config.registration_fee_display || '').replace('₦', '')} ta Paystack don samu damar da amfani.
        </p>
      </div>`;
    if (messageText) message(messageText, false);
    switchAuthTab(localStorage.getItem('ramli_auth_tab') || 'register');
  }

  function switchAuthTab(tab) {
    localStorage.setItem('ramli_auth_tab', tab);
    const isReg = tab === 'register';
    const fn = $('fieldFullName');
    if (fn) fn.style.display = isReg ? 'block' : 'none';
    const b1 = $('btnTabRegister'); const b2 = $('btnTabLogin');
    if (b1) b1.className = 'flex-1 py-2 text-xs font-bold rounded-lg ' + (isReg ? 'bg-tealHeader text-white' : 'bg-gray-100 text-gray-600');
    if (b2) b2.className = 'flex-1 py-2 text-xs font-bold rounded-lg ' + (isReg ? 'bg-gray-100 text-gray-600' : 'bg-tealHeader text-white');
  }

  async function submitAuth(event) {
    event.preventDefault();
    const email = ($('authEmail').value || '').trim();
    const password = $('authPassword').value || '';
    const fullName = ($('authFullName').value || '').trim();
    const mode = localStorage.getItem('ramli_auth_tab') || 'register';

    if (!email || !password) { message('Imail da kalmar sirri sune a buƙata.', true); return; }
    if (mode === 'register' && fullName.length < 2) { message('Shigar da sunaye babba.', true); return; }
    if (mode === 'register' && password.length < 8) { message('Kalmar sirri ya kamfe 8 harfi ko sama.', true); return; }

    const btn = $('authSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Ana jira...'; }
    try {
      const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body = mode === 'register'
        ? { full_name: fullName, email, password }
        : { email, password };
      const { status, data } = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (!data.ok) {
        message(data.message || 'An samu kuskure. Ka sake gwada.', true);
        return;
      }
      setToken(data.token);
      state.user = data.user;
      await afterLogin();
    } catch (err) {
      message('Ba a iya tura ba. Ka duba internetin ka.', true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Ci gaba'; }
    }
  }

  /* -------------------------- Payment screen ------------------------ */

  function showPaymentGate() {
    lockApp();
    const fee = state.config.registration_fee_display || '₦15,000';
    shell().innerHTML = `
      <div class="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 mt-6 mb-6">
        <div class="text-center mb-5">
          <div class="w-14 h-14 rounded-full bg-amber-500 text-white flex items-center justify-center mx-auto mb-2">
            <i class="fa-solid fa-credit-card text-2xl"></i>
          </div>
          <h2 class="text-lg font-bold text-gray-800">Bambancin Rajista</h2>
          <p class="text-xs text-gray-500 mt-1">Danna wannan karon kawai. Bayan an biya, za ka iya amfani da app ɗin ba tare da kowane biya ko credit ba.</p>
        </div>

        <div class="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-4">
          <div class="flex items-center justify-between text-sm">
            <span class="text-gray-600">Maƙarfoɗi rajista (one-time)</span>
            <span class="font-bold text-gray-900">${fee}</span>
          </div>
          <div class="flex items-center justify-between text-sm mt-2">
            <span class="text-gray-600">Maƙarfoɗi bayan kai</span>
            <span class="font-bold text-emerald-700">KADAI</span>
          </div>
        </div>

        <div id="ramliGateMsg" class="text-xs rounded-lg px-3 py-2" style="display:none"></div>

        <button onclick="ramliAuth.startPayment()" id="payBtn"
          class="w-full bg-tealHeader hover:bg-tealDark text-white font-bold py-3 rounded-lg shadow-md flex items-center justify-center gap-2">
          <i class="fa-solid fa-lock-open"></i> Biya da Paystack
        </button>
        <button onclick="ramliAuth.checkPaymentStatus()" id="payCheckBtn"
          class="w-full mt-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-2.5 rounded-lg text-xs">
          Na biya da yi — duba ba tare da sake biya
        </button>
        <button onclick="ramliAuth.logout()" class="w-full mt-3 text-xs text-gray-500 hover:text-gray-700">
          Fita (Sign out)
        </button>
      </div>`;
  }

  async function startPayment() {
    const btn = $('payBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Ana tafi...'; }
    try {
      const { status, data } = await api('/api/payments/initialize', { method: 'POST' });
      if (!data.ok) {
        message(data.message || 'An samu kuskure yayin shigar da maƙarfoɗi.', true);
        return;
      }
      if (data.already_paid) { await refreshUser(); return; }
      if (data.authorization_url) {
        window.location.href = data.authorization_url;
        return;
      }
      message('An samu kuskure. Ka sake gwada.', true);
    } catch (err) {
      message('Ba a iya tura ba. Ka duba internetin ka.', true);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-lock-open"></i> Biya da Paystack'; }
    }
  }

  async function checkPaymentStatus() {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get('reference') || params.get('trxref');
    const btn = $('payCheckBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Ana duba...'; }
    try {
      if (reference) {
        const { data } = await api('/api/payments/verify', {
          method: 'POST', body: JSON.stringify({ reference })
        });
        if (data.ok && data.status === 'paid') {
          state.user = data.user || state.user;
          await enterApp();
          return;
        }
      }
      await refreshUser();
      if (state.user && state.user.payment_status === 'paid') {
        await enterApp();
        return;
      }
      message('An karɓi saƙo amma ban gane cewa an biya. Idan ka biya, ka jira taƩaya sannan ka duba.', true);
    } catch (err) {
      message('Ba a iya duba ba.', true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Na biya da yi — duba ba tare da sake biya'; }
    }
  }

  /* ----------------------------- History ---------------------------- */

  async function loadHistory() {
    const { data } = await api('/api/history');
    if (!data.ok) return [];
    return data.history || [];
  }

  async function saveHistory(entry) {
    try {
      await api('/api/history', { method: 'POST', body: JSON.stringify(entry) });
      if (localStorage.getItem(HISTORY_KEY) === '1') renderHistory();
    } catch (e) { /* history is best-effort; never block the reading */ }
  }

  async function renderHistory() {
    const entries = await loadHistory();
    let modal = $('ramliHistoryModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ramliHistoryModal';
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 hidden items-center justify-center z-[90] p-3';
      modal.innerHTML = `
        <div class="bg-white rounded-lg w-full max-w-lg max-h-[85vh] overflow-y-auto p-4">
          <div class="flex justify-between items-center mb-3">
            <b class="text-sm text-gray-800">Binciken Sacye (Tarihin Ramli)</b>
            <button onclick="ramliAuth.closeHistory()" class="text-gray-500 px-2">✕</button>
          </div>
          <div id="ramliHistoryList" class="text-xs space-y-2"></div>
        </div>`;
      document.body.appendChild(modal);
    }
    const list = $('ramliHistoryList');
    if (!entries.length) {
      list.innerHTML = '<p class="text-gray-500 text-center py-6">Babu komai a cikin tarihi.</p>';
    } else {
      list.innerHTML = entries.map((e) => `
        <div class="border border-gray-200 rounded-lg p-2">
          <div class="flex justify-between text-[11px] text-gray-500 mb-1">
            <span>${e.kind === 'dream' ? 'Fassarar Mafarki' : 'Ramli'}</span>
            <span>${new Date(e.created_at).toLocaleString()}</span>
          </div>
          ${e.question ? `<div class="font-semibold text-gray-800 mb-1">${escapeHtml(e.question)}</div>` : ''}
          <div class="text-gray-600 leading-relaxed">${escapeHtml((e.interpretation || '').slice(0, 400))}${(e.interpretation || '').length > 400 ? '…' : ''}</div>
          <button onclick="ramliAuth.deleteHistory('${e.id}')" class="mt-1 text-[11px] text-red-600">Soke</button>
        </div>`).join('');
    }
    modal.style.display = 'flex';
    localStorage.setItem(HISTORY_KEY, '1');
  }

  function closeHistory() {
    const modal = $('ramliHistoryModal');
    if (modal) modal.style.display = 'none';
    localStorage.removeItem(HISTORY_KEY);
  }

  async function deleteHistory(id) {
    await api('/api/history?id=' + encodeURIComponent(id), { method: 'DELETE' });
    renderHistory();
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------------------- Lifecycle --------------------------- */

  async function refreshUser() {
    const { data } = await api('/api/me');
    if (data && data.ok) { state.user = data.user; return state.user; }
    return null;
  }

  async function enterApp() {
    hideGates();
    unlockApp();
    updateHeaderUser();
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment')) {
      const url = window.location.pathname;
      window.history.replaceState({}, '', url);
    }
  }

  function updateHeaderUser() {
    if (!state.user) return;
    const header = document.getElementById('headerTitle');
    if (header && !header.dataset.locked) header.innerText = 'Ilmin Ramli & Fassarar Mafarki';
    let btn = $('ramliHeaderUser');
    if (!btn) {
      const headerRow = document.querySelector('header .flex.items-center.gap-4');
      if (!headerRow) return;
      btn = document.createElement('div');
      btn.id = 'ramliHeaderUser';
      btn.className = 'flex items-center gap-2';
      headerRow.prepend(btn);
    }
    btn.innerHTML = `
      <button onclick="ramliAuth.openHistory()" title="Tarihin binciken" class="text-white hover:opacity-80">
        <i class="fa-solid fa-clock-rotate-left text-lg"></i>
      </button>
      <button onclick="ramliAuth.logout()" title="Fita" class="text-white hover:opacity-80">
        <i class="fa-solid fa-right-from-bracket text-lg"></i>
      </button>`;
  }

  async function afterLogin() {
    const user = await refreshUser();
    if (!user) { showAuthGate(); return; }
    if (user.payment_status === 'paid') { await enterApp(); return; }
    showPaymentGate();
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment') || params.get('reference') || params.get('trxref')) {
      checkPaymentStatus();
    }
  }

  function logout() {
    setToken(null);
    state.user = null;
    window.location.href = window.location.pathname;
  }

  async function init() {
    try {
      const { data } = await api('/api/config');
      if (data && data.ok) state.config = data;
      if (!data.supabase_configured) {
        lockApp();
        shell().innerHTML = `
          <div class="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 mt-6">
            <h2 class="text-base font-bold text-gray-800 mb-2">Babbancin app ɗin bai cika ba</h2>
            <p class="text-xs text-gray-600">Ana buƙatar saita Supabase da Paystack kafin app ɗin ya fida. Ka tuntuɓi mai gudanar.</p>
          </div>`;
        return;
      }
    } catch (e) { /* continue; /api/me decides */ }

    if (!state.token) { showAuthGate(); return; }
    const user = await refreshUser();
    if (!user) { showAuthGate(); return; }
    if (user.payment_status === 'paid') {
      await enterApp();
      const params = new URLSearchParams(window.location.search);
      if (params.get('payment') || params.get('reference')) checkPaymentStatus();
    } else {
      showPaymentGate();
      const params = new URLSearchParams(window.location.search);
      if (params.get('payment') || params.get('reference') || params.get('trxref')) checkPaymentStatus();
    }
  }

  window.ramliAuth = {
    switchAuthTab, submitAuth, startPayment, checkPaymentStatus, logout,
    openHistory: renderHistory, closeHistory, deleteHistory, saveHistory,
    state
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
