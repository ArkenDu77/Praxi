require('dotenv').config();

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const Anthropic  = require('@anthropic-ai/sdk');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const helmet     = require('helmet');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'praxi-admin-dev';

// ── AUTH (JWT) ──
const JWT_SECRET     = process.env.JWT_SECRET || 'praxi-dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Fail fast en production si les secrets critiques ne sont pas définis
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET non défini — arrêt du serveur');
    process.exit(1);
  }
  if (!process.env.ADMIN_TOKEN) {
    console.error('[FATAL] ADMIN_TOKEN non défini — arrêt du serveur');
    process.exit(1);
  }
}

// ── CLIENT IA (Anthropic) ──
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const AI_MODEL = 'claude-sonnet-4-6';

// ── SMTP (Nodemailer — Gmail App Password) ──
// On nettoie les identifiants : les variables d'env (surtout sur Railway) peuvent
// contenir des espaces ou un retour à la ligne parasite. Un App Password Gmail est
// composé de 16 caractères sans espace : on retire donc tout blanc interne.
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').replace(/\s+/g, '');
const APP_URL   = (process.env.APP_URL   || 'http://localhost:3001').trim().replace(/\/+$/, '');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 587, secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  // Évite que la requête reste bloquée si le port SMTP est filtré par l'hébergeur.
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
});

function emailLayout(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#080C10;font-family:system-ui,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#080C10;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#0D1520;border:1px solid #1A2535;border-radius:12px;overflow:hidden;">
<tr><td style="padding:28px 36px 24px;border-bottom:1px solid #1A2535;">
  <span style="font-size:22px;color:#EDF2F7;font-weight:700;letter-spacing:-.02em;">Prax<span style="color:#38BDF8;">i</span></span>
</td></tr>
<tr><td style="padding:32px 36px 36px;">${bodyHtml}</td></tr>
<tr><td style="padding:18px 36px;border-top:1px solid #1A2535;text-align:center;">
  <p style="margin:0;font-size:12px;color:#3D5166;">© 2025 Praxi — Assistant médical IA</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

async function sendPasswordResetEmail(email, prenom, token) {
  if (!SMTP_USER || !SMTP_PASS) return;
  const url  = `${APP_URL}/reset-password.html?token=${token}`;
  const body = `
    <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#EDF2F7;">Bonjour Dr ${prenom},</p>
    <p style="margin:0 0 24px;font-size:14.5px;color:#6B8299;line-height:1.65;">Vous avez demandé la réinitialisation de votre mot de passe Praxi. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${url}" style="display:inline-block;background:#38BDF8;color:#050A10;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;">Réinitialiser mon mot de passe</a>
    </div>
    <p style="margin:0 0 8px;font-size:13px;color:#3D5166;text-align:center;">Ce lien est valable 1 heure.</p>
    <p style="margin:12px 0 0;font-size:13px;color:#3D5166;word-break:break-all;">Lien direct : <a href="${url}" style="color:#38BDF8;">${url}</a></p>
    <p style="margin:24px 0 0;font-size:13px;color:#3D5166;">Si vous n'avez pas demandé cette réinitialisation, ignorez cet email.</p>`;
  await transporter.sendMail({
    from: `"Praxi" <${SMTP_USER}>`,
    to: email,
    subject: 'Réinitialisation de votre mot de passe Praxi',
    html: emailLayout('Réinitialisation du mot de passe', body)
  });
}

// ── STOCKAGE JSON (MVP — migre vers SQLite sur VPS) ──
// DATA_DIR permet de pointer vers un volume persistant (ex. Railway : monte un
// volume sur /data puis définis DATA_DIR=/data). Sans volume, le système de
// fichiers de l'hébergeur est éphémère : comptes et tokens disparaissent à chaque
// redéploiement / redémarrage. Par défaut : dossier du projet (comportement local).
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
const DB_PATH = path.join(DATA_DIR, 'waitlist.json');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { entries: [], nextId: 1 }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── STOCKAGE UTILISATEURS (médecins) ──
const USERS_PATH = path.join(DATA_DIR, 'users.json');

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { return { users: [], nextId: 1 }; }
}
function writeUsers(data) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(data, null, 2));
}
function getUserById(id) {
  return readUsers().users.find(u => u.id === id) || null;
}
// Renvoie l'utilisateur sans les champs sensibles (pour réponses API)
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, emailVerificationCode, emailVerificationExpiry, resetToken, resetTokenExpiry, ...rest } = u;
  return rest;
}

// ── TOKEN DE RÉINITIALISATION SANS ÉTAT ──
// Le token est signé (HMAC) et auto-suffisant : il ne dépend d'aucune écriture sur
// disque. La clé de signature inclut le hash du mot de passe ACTUEL ; dès que le mot
// de passe change, les anciens tokens deviennent invalides (usage unique garanti).
// Cela règle le « lien invalide ou expiré » dû au stockage éphémère / multi-instance.
function resetSignature(id, exp, passwordHash) {
  return crypto
    .createHmac('sha256', JWT_SECRET + ':' + (passwordHash || ''))
    .update(`${id}.${exp}`)
    .digest('hex');
}
function makeResetToken(user) {
  const exp = Date.now() + 60 * 60 * 1000; // valable 1 heure
  const sig = resetSignature(user.id, exp, user.passwordHash);
  return Buffer.from(`${user.id}.${exp}.${sig}`).toString('base64url');
}
function verifyResetToken(token) {
  let decoded;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); }
  catch { return { error: 'invalid' }; }
  const parts = decoded.split('.');
  if (parts.length !== 3) return { error: 'invalid' };
  const id  = parseInt(parts[0], 10);
  const exp = parseInt(parts[1], 10);
  const sig = parts[2];
  if (!id || !exp || !sig) return { error: 'invalid' };
  if (Date.now() > exp)    return { error: 'expired' };
  const user = getUserById(id);
  if (!user) return { error: 'invalid' };
  const expected = resetSignature(id, exp, user.passwordHash);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'invalid' };
  return { user };
}

// ── HELPERS SÉCURITÉ ──
function maskEmail(email) {
  const [local, domain] = (email || '').split('@');
  if (!domain) return '***';
  return local.slice(0, 2) + '***@' + domain;
}

// ── MIDDLEWARE ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://unpkg.com",
        "https://cdnjs.cloudflare.com",
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS : autoriser uniquement l'origine de production + localhost dev
const ALLOWED_ORIGINS = [
  process.env.APP_URL || 'http://localhost:3001',
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit (mémoire) — chaque route a son propre compteur via le namespace `ns`
const rlMap = new Map();
function rateLimit(ip, max = 3, ns = 'default') {
  const key = ns + ':' + ip;
  const now = Date.now();
  const win = 60 * 60 * 1000;
  const r   = rlMap.get(key) || { n: 0, reset: now + win };
  if (now > r.reset) { r.n = 0; r.reset = now + win; }
  r.n++;
  rlMap.set(key, r);
  return r.n <= max;
}

// ── VALIDATION ──
const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SPECIALITES = [
  'Médecin généraliste','Algologue','Allergologue','Anatomopathologiste',
  'Anesthésiste-réanimateur','Angiologue','Cancérologue','Cardiologue',
  'Chirurgien cardiaque','Chirurgien digestif','Chirurgien orthopédiste',
  'Chirurgien plasticien','Chirurgien thoracique','Chirurgien urologue',
  'Chirurgien vasculaire','Dermatologue','Diabétologue','Endocrinologue',
  'Gastro-entérologue','Gériatre','Gynécologue','Hématologue','Hépatologue',
  'Infectiologue','Interniste','Médecin du sport','Médecin du travail',
  'Médecin nucléaire','Médecin physique et réadaptation','Néphrologue',
  'Neurologue','Neurochirurgien','Oncologue','Ophtalmologue','ORL',
  'Orthoptiste','Pédiatre','Pharmacologue','Pneumologue','Psychiatre',
  'Radiologue','Radiothérapeute','Rhumatologue','Stomatologue','Urgentiste',
  'Urologue'
];
const s = (v, max = 100) => typeof v === 'string' ? v.trim().slice(0, max).replace(/[<>]/g,'') : '';

// Récupère la liste des spécialités d'un compte.
// Accepte un tableau `specialites` (multi-sélection) ou une chaîne `specialite`
// (compat ascendante, éventuellement séparée par des virgules).
function parseSpecialites(body) {
  let list = [];
  if (Array.isArray(body.specialites)) {
    list = body.specialites;
  } else if (typeof body.specialite === 'string') {
    list = body.specialite.split(',');
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const v = s(item);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// ── ROUTES ──

// POST /api/waitlist
app.post('/api/waitlist', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (!rateLimit(ip, 3, 'waitlist')) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une heure.' });
  }

  const prenom     = s(req.body.prenom);
  const nom        = s(req.body.nom);
  const email      = s(req.body.email, 200).toLowerCase();
  const specialite = s(req.body.specialite);
  const ville      = s(req.body.ville);

  const errors = [];
  if (!prenom)                          errors.push('Prénom requis');
  if (!nom)                             errors.push('Nom requis');
  if (!EMAIL_RE.test(email))            errors.push('Email invalide');
  if (!SPECIALITES.includes(specialite)) errors.push('Spécialité invalide');
  if (!ville)                           errors.push('Ville requise');
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const db = readDB();

  // Doublon
  if (db.entries.some(e => e.email === email)) {
    return res.status(409).json({ error: 'Cet email est déjà inscrit.' });
  }

  const entry = {
    id: db.nextId++,
    prenom, nom, email, specialite, ville,
    status: 'pending',
    ip: ip.slice(0, 45),
    created_at: new Date().toISOString()
  };

  db.entries.unshift(entry); // plus récent en premier
  writeDB(db);

  console.log(`[waitlist] +1 : ${prenom} ${nom} — ${specialite} — ${ville}`);
  res.status(201).json({ ok: true, message: 'Inscription confirmée.' });
});

// GET /api/stats
app.get('/api/stats', (_req, res) => {
  const db = readDB();
  const bySpec = db.entries.reduce((acc, e) => {
    acc[e.specialite] = (acc[e.specialite] || 0) + 1;
    return acc;
  }, {});
  res.json({ total: db.entries.length, bySpecialite: bySpec });
});

// GET /api/admin/list
app.get('/api/admin/list', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Non autorisé.' });

  const db = readDB();
  res.json({ count: db.entries.length, waitlist: db.entries });
});

// PATCH /api/admin/status/:id
app.patch('/api/admin/status/:id', (req, res) => {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Non autorisé.' });

  const STATUSES = ['pending','invited','active','rejected'];
  const { status } = req.body;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Statut invalide.' });

  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID invalide.' });

  const db  = readDB();
  const idx = db.entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Introuvable.' });

  db.entries[idx].status = status;
  writeDB(db);
  res.json({ ok: true });
});

// ── AUTHENTIFICATION ──

// Middleware : vérifie le JWT présent dans l'en-tête Authorization: Bearer <token>
function authenticateJWT(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentification requise.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Compte introuvable.' });
    req.user = user;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Session expirée ou invalide. Reconnectez-vous.' });
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, prenom: user.prenom, specialite: user.specialite || '' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const ipReg = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!rateLimit(ipReg, 5, 'register')) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une heure.' });
  }
  console.log('[auth] register :', maskEmail(s(req.body.email, 200).toLowerCase()));
  const prenom     = s(req.body.prenom);
  const nom        = s(req.body.nom);
  const email      = s(req.body.email, 200).toLowerCase();
  const password    = typeof req.body.password === 'string' ? req.body.password : '';
  const specialites = parseSpecialites(req.body);
  const specialite  = specialites.join(', ');
  const ville       = s(req.body.ville);
  const rpps        = s(req.body.rpps, 20);

  const errors = [];
  if (!prenom)               errors.push('Prénom requis');
  if (!nom)                  errors.push('Nom requis');
  if (!EMAIL_RE.test(email)) errors.push('Email invalide');
  if (password.length < 8)   errors.push('Mot de passe : 8 caractères minimum');
  if (password.length >= 8 && !/[A-Z]/.test(password) && !/[0-9]/.test(password))
    errors.push('Mot de passe : doit contenir au moins une majuscule ou un chiffre');
  if (!specialites.length)   errors.push('Spécialité requise');
  if (!ville)                errors.push('Ville requise');
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const db = readUsers();
  if (db.users.some(u => u.email === email)) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: db.nextId++,
    prenom, nom, email, passwordHash,
    specialite, specialites, ville, rpps,
    adresse: '', telephone: '', emailPro: email,
    status: 'verified',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  writeUsers(db);

  console.log(`[auth] nouveau médecin : Dr ${prenom} ${nom} — ${specialite}`);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const ipLogin = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!rateLimit(ipLogin, 10, 'login')) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une heure.' });
  }
  console.log('[auth] login :', maskEmail(s(req.body.email, 200).toLowerCase()));
  const email    = s(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const db   = readUsers();
  const user = db.users.find(u => u.email === email);
  // Message identique pour éviter l'énumération des comptes
  const ok = user && await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// GET /api/auth/me
app.get('/api/auth/me', authenticateJWT, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// PATCH /api/auth/profile
app.patch('/api/auth/profile', authenticateJWT, (req, res) => {
  const db  = readUsers();
  const idx = db.users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Compte introuvable.' });

  const u = db.users[idx];
  // Champs modifiables (l'email de connexion reste fixe)
  if ('prenom' in req.body)     u.prenom     = s(req.body.prenom);
  if ('nom' in req.body)        u.nom        = s(req.body.nom);
  if ('specialites' in req.body || 'specialite' in req.body) {
    const list   = parseSpecialites(req.body);
    u.specialites = list;
    u.specialite  = list.join(', ');
  }
  if ('ville' in req.body)      u.ville      = s(req.body.ville);
  if ('adresse' in req.body)    u.adresse    = s(req.body.adresse, 200);
  if ('telephone' in req.body)  u.telephone  = s(req.body.telephone, 30);
  if ('emailPro' in req.body)   u.emailPro   = s(req.body.emailPro, 200);
  if ('rpps' in req.body)       u.rpps       = s(req.body.rpps, 20);

  db.users[idx] = u;
  writeUsers(db);
  res.json({ user: publicUser(u) });
});

// ── ROUTES IA (génération de documents) ──

// Texte libre, longueur généreuse mais bornée
const txt = (v, max = 20000) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

// Construit le bloc d'identité du médecin à injecter dans le system prompt.
// Garantit qu'aucun champ vide n'apparaît dans le document final.
function medecinContext(user) {
  if (!user) return '';
  const lignes = [];
  lignes.push(`Dr ${user.prenom} ${user.nom}`.trim());
  if (user.specialite) lignes.push(user.specialite);
  if (user.adresse)    lignes.push(user.adresse);
  if (user.telephone)  lignes.push(`Tél. ${user.telephone}`);
  if (user.emailPro)   lignes.push(user.emailPro);
  if (user.rpps)       lignes.push(`RPPS ${user.rpps}`);
  return lignes.join('\n');
}

// Consignes de mise en page de l'en-tête médecin, communes aux documents signés.
function enteteConsigne(user) {
  return (
    "Le document commence par un en-tête identifiant le médecin émetteur, " +
    "reprenant fidèlement et uniquement les informations suivantes (n'invente ni " +
    "n'ajoute aucune coordonnée, et n'écris aucun champ vide entre crochets) :\n" +
    medecinContext(user) + "\n"
  );
}

// Appel commun à l'API Anthropic. Renvoie le texte généré ou lève une erreur.
async function generateDocument({ system, user, maxTokens = 2000 }) {
  if (!anthropic) {
    const err = new Error('Clé API non configurée sur le serveur (ANTHROPIC_API_KEY).');
    err.status = 503;
    throw err;
  }
  const msg = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }]
  });
  const text = (msg.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  if (!text) throw new Error('Réponse vide du modèle.');
  return text;
}

// Transforme une erreur d'appel IA en réponse HTTP lisible.
function aiError(res, err) {
  console.error('[ia]', err.status || '', err.message);
  const status = err.status === 503 ? 503
    : err.status === 401 ? 502
    : err.status === 429 ? 429
    : (err.status >= 400 && err.status < 600) ? 502
    : 500;
  const message =
    status === 503 ? 'Service IA non configuré. Contactez l\'administrateur.'
    : status === 429 ? 'Trop de demandes en ce moment. Réessayez dans un instant.'
    : status === 502 ? 'Le service IA est momentanément indisponible. Réessayez.'
    : 'Une erreur est survenue lors de la génération. Réessayez.';
  res.status(status).json({ error: message });
}

// ─── PRAXI V2 : moteur clinique explicable ──────────────────────────────────
// Cette première passe est volontairement déterministe : elle reste disponible
// même si le service IA est indisponible et ne transforme jamais une suggestion
// en fait. L'IA rédige ensuite uniquement à partir de ce contrat clinique.
const CLINICAL_PROFILES = {
  cardiologue: {
    focus: ['symptômes et chronologie', 'ECG', 'facteurs de risque cardiovasculaire', 'traitements', 'syncope et dyspnée'],
    questions: ['Début, durée et fréquence des symptômes ?', 'Survenue à l’effort ou au repos ?', 'Syncope, douleur thoracique ou dyspnée associée ?', 'ECG et constantes disponibles ?', 'Facteurs de risque cardiovasculaire ?']
  },
  endocrinologue: {
    focus: ['HbA1c ou bilan hormonal', 'poids et IMC', 'traitements et observance', 'complications', 'évolution biologique'],
    questions: ['Dernier bilan biologique et date ?', 'Poids, taille ou IMC ?', 'Traitement actuel et observance ?', 'Complications déjà recherchées ?', 'Objectif thérapeutique attendu ?']
  },
  neurologue: {
    focus: ['chronologie', 'examen neurologique', 'imagerie', 'signes associés', 'traitements essayés'],
    questions: ['Chronologie précise et mode d’installation ?', 'Déficit moteur, sensitif ou trouble de la conscience ?', 'Examen neurologique réalisé ?', 'Imagerie ou bilan déjà disponible ?', 'Traitements essayés et réponse ?']
  },
  pneumologue: {
    focus: ['dyspnée et toux', 'tabagisme', 'SpO2', 'EFR et imagerie', 'traitements inhalés'],
    questions: ['Tabagisme actuel et cumulé ?', 'Dyspnée au repos ou à l’effort ?', 'SpO2 et auscultation ?', 'EFR ou imagerie disponibles ?', 'Traitement respiratoire actuel ?']
  },
  gastro: {
    focus: ['douleur et transit', 'signes d’alarme', 'biologie hépatique', 'endoscopie et imagerie', 'traitements essayés'],
    questions: ['Localisation et rythme des symptômes ?', 'Amaigrissement, saignement ou fièvre ?', 'Transit et alimentation ?', 'Biologie, endoscopie ou imagerie ?', 'Traitements déjà essayés ?']
  },
  nephrologue: {
    focus: ['créatinine et DFG', 'protéinurie', 'pression artérielle', 'ionogramme', 'médicaments néphrotoxiques'],
    questions: ['Créatinine, DFG et évolution ?', 'Protéinurie ou hématurie ?', 'Pression artérielle ?', 'Ionogramme disponible ?', 'Traitements potentiellement néphrotoxiques ?']
  },
  rhumatologue: {
    focus: ['topographie et rythme des douleurs', 'raideur', 'examen articulaire', 'syndrome inflammatoire', 'imagerie'],
    questions: ['Rythme mécanique ou inflammatoire ?', 'Raideur matinale et durée ?', 'Examen articulaire ?', 'CRP/VS disponibles ?', 'Imagerie déjà réalisée ?']
  },
  psychiatre: {
    focus: ['symptômes et durée', 'retentissement', 'risque suicidaire', 'addictions', 'traitements psychotropes'],
    questions: ['Durée et retentissement fonctionnel ?', 'Idées suicidaires ou mise en danger ?', 'Sommeil et appétit ?', 'Consommations ou addictions ?', 'Traitements et suivi antérieurs ?']
  },
  gynecologue: {
    focus: ['cycle et grossesse', 'douleur ou saignement', 'contraception', 'examen', 'imagerie et biologie'],
    questions: ['Date des dernières règles et possibilité de grossesse ?', 'Douleur ou saignement ?', 'Contraception ?', 'Examen clinique réalisé ?', 'Échographie ou biologie disponible ?']
  },
  pediatre: {
    focus: ['âge exact', 'croissance', 'développement', 'vaccinations', 'contexte familial'],
    questions: ['Âge, poids et courbe de croissance ?', 'Développement psychomoteur ?', 'Vaccinations à jour ?', 'Alimentation et sommeil ?', 'Signes de gravité rapportés ?']
  },
  oncologue: {
    focus: ['histologie et stade', 'imagerie', 'traitements reçus', 'tolérance', 'état général'],
    questions: ['Type histologique et stade ?', 'Dernière imagerie ?', 'Traitements reçus et dates ?', 'Tolérance et toxicités ?', 'Performance status ou autonomie ?']
  },
  default: {
    focus: ['motif', 'chronologie', 'antécédents', 'traitements', 'examen et résultats disponibles'],
    questions: ['Chronologie et évolution ?', 'Antécédents pertinents ?', 'Traitements et allergies ?', 'Examen clinique et constantes ?', 'Question précise posée au destinataire ?']
  }
};

function plainClinicalText(body = {}) {
  return ['patient','age','ddn','motif','notes','text','diagnostic','affection','type','medicaments','medicamentsAld']
    .map(k => typeof body[k] === 'string' ? body[k] : '').filter(Boolean).join('\n').trim();
}

function specialtyProfile(name = '') {
  const aliases = { gastro:'gastro', hepatologue:'gastro', nephrologue:'nephrologue', rhumatologue:'rhumatologue', psychiatre:'psychiatre', gynecologue:'gynecologue', pediatre:'pediatre', oncologue:'oncologue', cancerologue:'oncologue' };
  const normalized = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const alias = Object.keys(aliases).find(k => normalized.includes(k));
  const key = alias ? aliases[alias] : Object.keys(CLINICAL_PROFILES).find(k => k !== 'default' && normalized.includes(k));
  return CLINICAL_PROFILES[key || 'default'];
}

function hasAny(text, patterns) { return patterns.some(p => p.test(text)); }

function clinicalAnalysis(body = {}) {
  const source = plainClinicalText(body);
  const lower = source.toLowerCase();
  const profile = specialtyProfile(body.specialiste || body.specialty || '');
  const missing = [];
  const questions = [];
  const inconsistencies = [];
  const deductions = [];
  const suggestions = [];

  const checks = [
    ['chronologie', [/depuis|début|evolution|évolution|jour|semaine|mois|an(s)?\b/i], 'Depuis quand et avec quelle évolution ?'],
    ['traitements', [/traitement|sous\s|mg\b|comprim|médicament|therapie|thérapie/i], 'Quels sont les traitements actuels et leur tolérance ?'],
    ['allergies', [/allerg/i], 'Des allergies médicamenteuses sont-elles connues ?'],
    ['examen clinique ou constantes', [/examen|tension|\bpa\b|\bfc\b|spo2|saturation|poids|taille|imc|auscult/i], 'Quels éléments d’examen ou constantes sont disponibles ?']
  ];
  checks.forEach(([label, patterns, question]) => {
    if (!hasAny(source, patterns)) { missing.push(label); questions.push(question); }
  });
  if (!body.patient && !/patient|monsieur|madame|\bm\.|mme/i.test(source)) missing.push('identité ou repère patient');
  if (!body.motif && !/motif|adress|avis|pour\s/i.test(source) && body.documentType === 'liaison') {
    missing.push('motif d’adressage'); questions.push('Quelle est la question clinique précise posée au spécialiste ?');
  }

  if (/douleur(s)? thoracique/i.test(source)) {
    questions.push('Irradiation, effort/repos, durée et dyspnée associée ?');
    suggestions.push({ id: 'ecg', label: 'Discuter un ECG selon le contexte', rationale: 'Douleur thoracique rapportée', category: 'examen', confidence: 94 });
  }
  if (/palpitation/i.test(source)) {
    deductions.push('Un avis cardiologique est pertinent au regard des palpitations rapportées.');
    if (/ecg[^\n.]*normal|ecg\s*normal/i.test(source))
      deductions.push('Un ECG intercritique normal n’exclut pas un trouble rythmique intermittent.');
    if (/pas de syncope|sans syncope|absence de syncope/i.test(source))
      deductions.push('L’absence de syncope rapportée est un élément rassurant, sans exclure une cause rythmique.');
    suggestions.push({ id: 'holter', label: 'Discuter un Holter ECG', rationale: /ecg[^\n.]*normal|ecg\s*normal/i.test(source) ? 'Palpitations persistantes avec ECG intercritique normal' : 'Palpitations rapportées', category: 'examen', confidence: /depuis|mois|semaine/i.test(source) ? 96 : 86 });
    suggestions.push({ id: 'cardio', label: 'Discuter un avis cardiologique', rationale: 'Symptomatologie rythmique rapportée', category: 'orientation', confidence: 91 });
    suggestions.push({ id: 'echo', label: 'Discuter une échographie cardiaque', rationale: 'À apprécier selon l’examen clinique, les antécédents et les facteurs de risque', category: 'examen', confidence: 71 });
  }
  if (/diab[eè]te/i.test(source) && /hba1c\s*(?:[:=]?\s*)?(8(?:[.,]\d)?|9(?:[.,]\d)?|1\d)/i.test(source)) {
    deductions.push('L’HbA1c rapportée suggère un équilibre glycémique insuffisant.');
    suggestions.push({ id: 'diabeto', label: 'Discuter une réévaluation thérapeutique', rationale: 'HbA1c élevée rapportée', category: 'prise_en_charge', confidence: 92 });
  }
  if (/femme|enceinte|grossesse/i.test(source) && /hypertrophie\s+prostat|ad[eé]nome\s+prostat/i.test(source))
    inconsistencies.push('Sexe/contexte de grossesse incompatible avec une pathologie prostatique rapportée.');
  if (/allerg[^\n.]*p[eé]nicill|allerg[^\n.]*amoxicill/i.test(source) && /amoxicilline/i.test(source))
    inconsistencies.push('Amoxicilline mentionnée malgré une allergie rapportée aux pénicillines : vérifier avant prescription.');
  if (/enceinte|grossesse/i.test(source) && /isotr[eé]tino[iï]ne|valproate/i.test(source))
    inconsistencies.push('Traitement potentiellement incompatible avec une grossesse rapportée : vérification urgente requise.');
  if (/anticoagul|apixaban|rivaroxaban|warfarine|fluindione/i.test(source) && /ibuprof[eè]ne|k[eé]toprof[eè]ne|naprox[eè]ne|ains\b/i.test(source))
    inconsistencies.push('Association anticoagulant/AINS rapportée : risque hémorragique à vérifier.');
  const age = Number((String(body.age || '').match(/\d{1,3}/) || [])[0]);
  const infarctAge = Number((source.match(/infarctus[^\n.]*?(?:à|a)\s*(\d{1,3})\s*ans/i) || [])[1]);
  if (infarctAge && infarctAge < 15) inconsistencies.push(`Antécédent d’infarctus à ${infarctAge} ans : vérifier l’âge et la formulation.`);
  if (age && (age < 0 || age > 115)) inconsistencies.push('Âge impossible ou très improbable.');
  const dates = [...source.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)];
  dates.forEach(m => { if (+m[1] > 31 || +m[2] > 12) inconsistencies.push(`Date impossible détectée : ${m[0]}.`); });

  const alreadyAnswered = q => {
    if (source.toLowerCase().includes(q.toLowerCase())) return true;
    if (/ECG/i.test(q) && /\becg\b/i.test(source)) return true;
    if (/syncope/i.test(q) && /syncope/i.test(source)) return true;
    if (/début|durée|chronologie/i.test(q) && /depuis|début|jour|semaine|mois|an(s)?\b/i.test(source)) return true;
    if (/traitement/i.test(q) && /traitement|sous\s|mg\b|comprim|médicament/i.test(source)) return true;
    if (/allerg/i.test(q) && /allerg/i.test(source)) return true;
    if (/constante|SpO2|pression artérielle/i.test(q) && /tension|\bpa\b|\bfc\b|spo2|saturation/i.test(source)) return true;
    return false;
  };
  profile.questions.forEach(q => { if (questions.length < 7 && !questions.includes(q) && !alreadyAnswered(q)) questions.push(q); });
  const filteredQuestions = [...new Set(questions)].filter(q => !alreadyAnswered(q));
  const complexity = source.length > 1800 || inconsistencies.length > 0 || suggestions.length >= 3 ? 'detaille'
    : source.length < 450 && suggestions.length < 2 ? 'express' : 'standard';
  const confidenceBreakdown = [{ label: 'Dossier clinique initial', value: 45 }];
  if (body.motif || /palpitation|douleur|dyspn[eé]e|diab[eè]te|suivi|contr[oô]le/i.test(source)) confidenceBreakdown.push({ label: 'Motif ou symptômes décrits', value: 20 });
  if (/depuis|début|jour|semaine|mois|an(s)?\b/i.test(source)) confidenceBreakdown.push({ label: 'Chronologie disponible', value: 10 });
  if (/\becg\b|examen|tension|\bpa\b|\bfc\b|spo2|saturation/i.test(source)) confidenceBreakdown.push({ label: 'Examen ou résultat disponible', value: 15 });
  if (missing.includes('traitements')) confidenceBreakdown.push({ label: 'Traitements non précisés', value: -10 });
  if (missing.includes('allergies')) confidenceBreakdown.push({ label: 'Allergies non précisées', value: -7 });
  if (missing.includes('examen clinique ou constantes')) confidenceBreakdown.push({ label: 'Constantes ou examen incomplets', value: -10 });
  if (source.length < 40) confidenceBreakdown.push({ label: 'Informations très brèves', value: -10 });
  inconsistencies.forEach(() => confidenceBreakdown.push({ label: 'Incohérence à vérifier', value: -20 }));
  let confidence = confidenceBreakdown.reduce((sum, item) => sum + item.value, 0);
  confidence = Math.max(20, Math.min(98, confidence));

  const facts = source.split(/\n|(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length > 2).slice(0, 12);
  return {
    facts, deductions, suggestions, missing: [...new Set(missing)],
    questions: filteredQuestions.slice(0, 7), inconsistencies: [...new Set(inconsistencies)],
    confidence,
    confidenceBreakdown,
    recommendedLength: complexity,
    specialtyFocus: profile.focus
  };
}

function stripPraxiArtifacts(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\n-{2,}\s*\n\s*ANALYSE\s+DE\s+PRAXI[\s\S]*$/i, '')
    .replace(/\n\s*ANALYSE\s+DE\s+PRAXI[\s\S]*$/i, '')
    .trim();
}

function finalizeDocument(text) {
  return stripPraxiArtifacts(text);
}

function clinicalGenerationRules(req, documentType) {
  const mode = ['express','standard','detaille'].includes(req.body.mode) ? req.body.mode : 'standard';
  const lengths = { express: 'EXPRESS : 5 à 8 lignes, lecture en moins de 20 secondes', standard: 'STANDARD : 10 à 15 lignes', detaille: 'DÉTAILLÉ : complet mais sans répétition' };
  const style = s(req.body.stylePreference, 300) || 'professionnel, direct et sobre';
  const accepted = Array.isArray(req.body.acceptedSuggestions) ? req.body.acceptedSuggestions.map(x => s(x, 300)).filter(Boolean) : [];
  const analysis = req.body.clinicalAnalysis && typeof req.body.clinicalAnalysis === 'object' ? req.body.clinicalAnalysis : {};
  const focus = Array.isArray(analysis.specialtyFocus) ? analysis.specialtyFocus.map(x => s(x, 120)).filter(Boolean).slice(0, 8) : [];
  const deductions = Array.isArray(analysis.deductions) ? analysis.deductions.map(x => s(x, 300)).filter(Boolean).slice(0, 8) : [];
  const unresolved = Array.isArray(analysis.inconsistencies) ? analysis.inconsistencies.map(x => s(x, 300)).filter(Boolean).slice(0, 8) : [];
  return `\nCONTRAT DE SÉCURITÉ CLINIQUE PRAXI V2 (${documentType}) :\n` +
    `Longueur : ${lengths[mode]}. Style du praticien : ${style}.\n` +
    "Le document produit doit être exclusivement le document médical final, prêt à être signé et transmis. " +
    "N'écris JAMAIS de section 'ANALYSE DE PRAXI', de mention de Praxi, ni de méta-commentaire sur la génération, les suggestions non retenues ou les informations manquantes. " +
    "Sépare strictement les faits fournis des déductions : seuls les faits et déductions validées entrent dans le corps du document, en prose médicale continue. " +
    "Les suggestions explicitement validées par le médecin s'intègrent naturellement dans une ou deux phrases cliniques du texte (ex. 'Un Holter ECG pourrait être utile si vous le jugez indiqué'), jamais dans une rubrique séparée. " +
    "S'il n'y a aucune suggestion validée, n'ajoute strictement rien à ce sujet. " +
    "Ne transforme jamais une suggestion en prescription, diagnostic, examen réalisé ou résultat. N'invente jamais âge, sexe, poids, IMC, antécédent, traitement, constante, résultat, interprétation d'ECG, diagnostic ou examen. " +
    "Les jetons PATIENT_CONFIDENTIEL et AGE_PATIENT représentent des données disponibles mais masquées : recopie-les strictement à chaque emplacement naturel du nom et de l'âge, sans les reformuler et sans écrire 'Information non renseignée' à leur place. " +
    "Si une autre donnée manque, omets naturellement la phrase ou la rubrique au lieu de répéter 'Information non renseignée', sauf champ légal strictement obligatoire. N'utilise aucune valeur chiffrée absente des données source. " +
    `Éléments attendus par la spécialité destinataire : ${focus.length ? focus.join(' ; ') : 'non spécifiés'}. Ne les présente que s'ils figurent dans la source.\n` +
    `Déductions identifiées (à formuler comme interprétations cliniques dans le texte, jamais comme faits établis) : ${deductions.length ? deductions.join(' ; ') : 'aucune'}.\n` +
    `Incohérences non résolues : ${unresolved.length ? unresolved.join(' ; ') : 'aucune'}. Si elles sont présentes, signale qu'elles doivent être vérifiées sans choisir arbitrairement une version.\n` +
    `Suggestions validées par le médecin (à intégrer dans le corps du texte uniquement) : ${accepted.length ? accepted.join(' ; ') : 'aucune'}.\n`;
}

function documentSafety(document, source, user) {
  const allowed = `${source}\n${medecinContext(user)}\n${new Date().getFullYear()}`;
  const values = [...new Set((document.match(/\b\d+(?:[.,]\d+)?\b/g) || []))];
  const unsupportedNumbers = values.filter(n => !allowed.includes(n));
  return { checked: true, unsupportedNumbers, requiresReview: unsupportedNumbers.length > 0 };
}

app.post('/api/clinical/analyze', authenticateJWT, (req, res) => {
  const source = plainClinicalText(req.body);
  if (!source) return res.status(400).json({ error: 'Ajoutez des informations cliniques à analyser.' });
  res.json({ analysis: clinicalAnalysis(req.body) });
});

// POST /api/generate/liaison — lettre de liaison vers un spécialiste
app.post('/api/generate/liaison', authenticateJWT, async (req, res) => {
  const patient     = txt(req.body.patient, 500);
  const age         = s(req.body.age, 40);
  const motif       = txt(req.body.motif, 1000);
  const specialiste = s(req.body.specialiste, 100);
  const notes       = txt(req.body.notes);
  const complement  = txt(req.body.complement, 2000);

  if (!notes && !motif) {
    return res.status(400).json({ error: 'Renseignez au moins le motif ou les notes cliniques.' });
  }

  const specialiteRedacteur = (req.user && req.user.specialite) || 'médecine générale';
  const system =
    `Tu es un médecin expert en ${specialiteRedacteur}, exerçant en libéral en France. ` +
    "Tu rédiges une lettre de liaison confraternelle destinée à un confrère spécialiste, " +
    "comme tu l'écrirais toi-même dans ta pratique quotidienne. " +
    "Structure la lettre avec rigueur clinique : évoque uniquement les éléments sémiologiques fournis " +
    "pertinents pour la spécialité du destinataire, les comorbidités à signaler, les traitements " +
    "en cours et leur tolérance, les examens déjà réalisés et leurs résultats. " +
    "N'invente aucune information absente des notes — mais valorise et structure ce qui est fourni " +
    "avec la précision d'un médecin expérimenté. " +
    "Conserve systématiquement toutes les précisions utiles du motif et des notes : durée, évolution, circonstances, éléments positifs et négatifs, examens et résultats. Ne réduis jamais 'palpitations depuis trois mois, au repos' à la seule mention 'palpitations'. " +
    "Ajoute une unique phrase de synthèse clinique expliquant pourquoi l'avis spécialisé est pertinent, fondée seulement sur les faits et interprétations validées. Exemple de ton : 'Compte tenu de la persistance des symptômes malgré un ECG intercritique normal, je sollicite votre avis spécialisé afin de compléter le bilan si vous le jugez indiqué.' " +
    "Ne présente jamais l'absence d'un symptôme comme un résultat d'examen clinique : écris 'Aucune syncope n'est rapportée', pas 'L'examen clinique ne met pas en évidence de syncope'. " +
    "RÈGLE ABSOLUE SUR LE NOM DU PATIENT : utilise toujours le prénom et/ou nom exact fourni. " +
    "N'écris JAMAIS 'Monsieur' ou 'Madame' seul sans faire suivre immédiatement du nom complet. " +
    "N'écris JAMAIS 'le patient' ou 'la patiente' dans la lettre — remplace systématiquement " +
    "par le nom réel. " +
    enteteConsigne(req.user) +
    clinicalGenerationRules(req, 'lettre de liaison') +
    "FORMAT : prose fluide en paragraphes continus. N'utilise JAMAIS de Markdown : pas " +
    "d'astérisques (* ou **), pas de dièses (#), pas de tirets de liste, pas de puces. " +
    "Les titres (OBJET, etc.) s'écrivent en majuscules sans aucun caractère de formatage. " +
    "Sections séparées par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets comme [date] ou [nom]. " +
    "Si une information est absente, omets naturellement la phrase ou la rubrique. " +
    "Écris dans un style direct : 'Les palpitations évoluent depuis…', 'L’ECG réalisé au cabinet est normal'. Évite 'À l’anamnèse', 'est revenu dans les limites de la normale' et les périphrases. " +
    "INTERDICTION ABSOLUE : n'écris jamais 'ANALYSE DE PRAXI', ne sépare pas le document par '---', et n'ajoute aucun commentaire méta sur les suggestions ou informations manquantes. La lettre s'arrête à la formule de politesse et la signature. " +
    "N'ajoute aucun commentaire hors de la lettre.";

  const user =
    (specialiste ? `Spécialiste destinataire : ${specialiste}\n` : '') +
    (patient ? `Patient : ${patient}${age ? `, ${age}` : ''}\n` : '') +
    (motif ? `Motif d'adressage : ${motif}\n` : '') +
    `\nNotes cliniques du médecin :\n${notes || '(aucune)'}\n` +
    (complement ? `\nÉléments additionnels à intégrer : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system, user, maxTokens: 1500 }));
    res.json({ document, safety: documentSafety(document, plainClinicalText(req.body), req.user) });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/generate/compte-rendu — compte-rendu de consultation structuré
app.post('/api/generate/compte-rendu', authenticateJWT, async (req, res) => {
  const patient    = txt(req.body.patient, 500);
  const date       = s(req.body.date, 40);
  const notes      = txt(req.body.notes);
  const complement = txt(req.body.complement, 2000);

  if (!notes) {
    return res.status(400).json({ error: 'Renseignez les notes de consultation.' });
  }

  const specialiteRedacteurCR = (req.user && req.user.specialite) || 'médecine générale';
  const isAlgologie = /algologue|anesthésiste/i.test(specialiteRedacteurCR);

  const system = isAlgologie
    ? (`Tu es un médecin ${specialiteRedacteurCR}, expert en médecine de la douleur, ` +
       "exerçant en libéral en France. À partir des notes brutes, rédige un compte-rendu de " +
       "consultation douleur structuré selon les recommandations HAS 2024. " +
       "Style télégraphique médical concis — pas de phrases complètes, aller droit au but. " +
       enteteConsigne(req.user) +
       clinicalGenerationRules(req, 'compte-rendu de consultation') +
       "Sections dans cet ordre exact, chaque titre en MAJUSCULES suivi de deux-points :\n" +
       "MOTIF DE CONSULTATION : patient, âge, contexte d'adressage, type et topographie de douleur.\n" +
       "ÉVALUATION DE LA DOULEUR :\n" +
       "Intensité : EVA .../10 — EN .../10 — EVS .../5\n" +
       "Type de douleur : DN4 .../10 (neuropathique si score ≥ 4)\n" +
       "Retentissement : HAD-A .../21 — HAD-D .../21\n" +
       "Autres échelles si pertinentes : NPSI, QCD, POMI, Marshall\n" +
       "ANAMNÈSE : chronologie, facteurs déclenchants/aggravants/soulageants, traitements " +
       "antérieurs avec efficacité et tolérance.\n" +
       "EXAMEN CLINIQUE CIBLÉ : neurologique, musculo-squelettique, cutané — allodynie, " +
       "hyperpathie, points trigger.\n" +
       "DIMENSION PSYCHOSOCIALE : retentissement professionnel, familial, social — " +
       "catastrophisme (PCS si coté).\n" +
       "SYNTHÈSE DIAGNOSTIQUE : mécanisme dominant " +
       "(nociceptif / neuropathique / nociplastique / mixte) — diagnostic retenu.\n" +
       "PLAN MULTIMODAL :\n" +
       "Pharmacologique : paliers OMS, adjuvants avec posologie complète\n" +
       "Physique : kinésithérapie, mésothérapie si pertinent\n" +
       "Psychologique : TCC, EMDR, mindfulness si indiqué\n" +
       "Éducation : ETP, autogestion\n" +
       "SUIVI & COORDINATION : délai de réévaluation — critères d'adressage SDC/CETD — " +
       "lettre au médecin traitant : oui / non.\n" +
       "RÈGLES ABSOLUES : si des valeurs d'échelles sont mentionnées dans les notes " +
       "(ex. 'EVA 7', 'DN4 positif'), intègre-les dans la section ÉVALUATION. " +
       "Si une valeur n'est pas mentionnée, écris '— à coter' à la place. " +
       "Si une valeur manque, omets-la sans créer de rubrique artificielle. " +
       "FORMAT : n'utilise JAMAIS de Markdown (pas d'astérisques, pas de dièses). " +
       "Sections séparées par des sauts de ligne. N'ajoute aucun commentaire hors du compte-rendu.")
    : (`Tu es un médecin expert en ${specialiteRedacteurCR}, exerçant en libéral en France. ` +
       "À partir de notes brutes de consultation, rédige un compte-rendu structuré et cliniquement " +
       "enrichi, comme tu le ferais dans ta pratique. Mobilise tes connaissances de spécialité pour " +
       "expliciter le raisonnement clinique à partir des seuls faits fournis. Les hypothèses et " +
       "propositions validées doivent rester clairement étiquetées comme telles. " +
       "N'invente aucune donnée absente — structure uniquement ce qui est fourni. " +
       enteteConsigne(req.user) +
       clinicalGenerationRules(req, 'compte-rendu de consultation') +
       "Organise le compte-rendu avec exactement ces sections dans cet ordre, chaque titre en " +
       "MAJUSCULES suivi de deux-points : " +
       "MOTIF DE CONSULTATION :, " +
       "EXAMEN CLINIQUE ET CONSTANTES : (inclure les constantes si mentionnées : PA, FC, SpO2, poids, taille, IMC), " +
       "DIAGNOSTIC / IMPRESSION CLINIQUE :, " +
       "OBJECTIFS THÉRAPEUTIQUES :, " +
       "CONDUITE À TENIR : (traitements avec posologie complète si pertinent, examens complémentaires, orientations), " +
       "SURVEILLANCE :, " +
       "ÉDUCATION THÉRAPEUTIQUE / CONSEILS : (si applicable). " +
       "Omets toute rubrique sans donnée disponible. " +
       "Sous chaque titre, écris en prose (phrases continues), jamais sous forme de liste à puces. " +
       "FORMAT : n'utilise JAMAIS de Markdown : pas d'astérisques, pas de dièses, pas de tirets de liste. " +
       "Sépare les sections par des sauts de ligne. N'ajoute aucun commentaire hors du compte-rendu.");

  const user =
    (patient ? `Patient : ${patient}\n` : '') +
    (date ? `Date de consultation : ${date}\n` : '') +
    `\nNotes brutes de consultation :\n${notes}\n` +
    (complement ? `\nÉléments additionnels à intégrer : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system, user, maxTokens: 1800 }));
    res.json({ document, safety: documentSafety(document, plainClinicalText(req.body), req.user) });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/generate/resume — analyse / résumé d'un document
app.post('/api/generate/resume', authenticateJWT, async (req, res) => {
  const document   = txt(req.body.text);
  const complement = txt(req.body.complement, 2000);

  if (!document) {
    return res.status(400).json({ error: 'Aucun texte de document à analyser.' });
  }

  const specialiteRedacteurRes = (req.user && req.user.specialite) || 'médecine générale';
  const system =
    `Tu es un médecin expert en ${specialiteRedacteurRes}, exerçant en libéral en France. ` +
    "Analyse le document médical fourni et distingue strictement les informations dans trois sections : " +
    "FAITS :, DÉDUCTIONS :, SUGGESTIONS VALIDÉES :. " +
    "Sous FAITS : reprends uniquement les éléments explicitement présents dans le document. " +
    "Sous DÉDUCTIONS : indique uniquement les interprétations logiques, formulées avec prudence. " +
    "Sous SUGGESTIONS VALIDÉES : reprends exclusivement les propositions préalablement validées par le médecin. " +
    "Si aucune suggestion n'a été validée, écris 'Aucune suggestion validée'. " +
    "N'invente aucune donnée absente du document. " +
    medecinContext(req.user) +
    clinicalGenerationRules(req, 'analyse de document') +
    "FORMAT : n'utilise JAMAIS de Markdown : pas d'astérisques (* ou **), pas de dièses (#), " +
    "pas de tirets de liste. Sépare les sections par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets. " +
    "Omets toute information absente au lieu d'ajouter une mention artificielle.";

  const user = `Document médical à analyser :\n\n${document}\n` +
    (complement ? `\nÉléments additionnels à intégrer / actions retenues par le médecin : ${complement}\n` : '');

  try {
    const result = finalizeDocument(await generateDocument({ system, user, maxTokens: 1500 }));
    res.json({ document: result, safety: documentSafety(result, plainClinicalText(req.body), req.user) });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/auth/forgot-password — génère un token de réinitialisation et l'envoie par email
app.post('/api/auth/forgot-password', async (req, res) => {
  const ipFwd = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!rateLimit(ipFwd, 3, 'forgot-password')) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans une heure.' });
  }
  const email = s(req.body.email, 200).toLowerCase();
  console.log('[auth] forgot-password :', maskEmail(email));

  const user = readUsers().users.find(u => u.email === email);
  if (user) {
    // Token sans état : aucune écriture sur disque (robuste au stockage éphémère).
    const token = makeResetToken(user);
    try {
      await sendPasswordResetEmail(email, user.prenom, token);
      console.log('[auth] email de réinitialisation envoyé à', maskEmail(email));
    } catch (err) {
      // On loggue l'erreur réelle (visible dans les logs Railway) au lieu de la masquer.
      console.error('[auth] ÉCHEC envoi email réinitialisation :', err && err.message);
    }
  } else {
    console.log('[auth] forgot-password : aucun compte pour cet email (aucun envoi)');
  }
  // Réponse identique que l'email existe ou non (évite l'énumération)
  res.json({ ok: true });
});

// POST /api/auth/reset-password — applique le nouveau mot de passe via token
app.post('/api/auth/reset-password', async (req, res) => {
  // Extraction directe : pas de s() pour éviter toute troncature ou altération du token
  const token    = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!token)              return res.status(400).json({ error: 'Token manquant.' });
  if (password.length < 8) return res.status(400).json({ error: 'Mot de passe : 8 caractères minimum.' });
  if (password.length >= 8 && !/[A-Z]/.test(password) && !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Mot de passe : doit contenir au moins une majuscule ou un chiffre.' });

  console.log('[auth] reset-password : token', token.slice(0, 12) + '… (' + token.length + ' chars)');

  const { user, error } = verifyResetToken(token);
  if (error === 'expired') return res.status(400).json({ error: 'Lien expiré. Faites une nouvelle demande.' });
  if (error || !user)      return res.status(400).json({ error: 'Lien invalide ou expiré.' });

  const db  = readUsers();
  const idx = db.users.findIndex(u => u.id === user.id);
  if (idx === -1) return res.status(400).json({ error: 'Lien invalide ou expiré.' });

  // Changer le hash invalide automatiquement le token (signature liée à l'ancien hash).
  db.users[idx].passwordHash = await bcrypt.hash(password, 10);
  delete db.users[idx].resetToken;        // nettoyage d'éventuels anciens tokens stockés
  delete db.users[idx].resetTokenExpiry;
  writeUsers(db);

  console.log('[auth] mot de passe réinitialisé pour', maskEmail(user.email));
  res.json({ ok: true });
});


// POST /api/generate/mdph
app.post('/api/generate/mdph', authenticateJWT, async (req, res) => {
  const patient    = txt(req.body.patient, 500);
  const diagnostic = txt(req.body.diagnostic, 2000);
  const notes      = txt(req.body.notes);
  const complement = txt(req.body.complement, 2000);

  if (!diagnostic && !notes) {
    return res.status(400).json({ error: 'Renseignez le diagnostic ou les notes medicales.' });
  }

  const spec = (req.user && req.user.specialite) || 'médecine générale';
  const system =
    `Tu es un médecin expert en ${spec}, exerçant en libéral en France. ` +
    "Tu rédiges un certificat médical destiné à la MDPH, conforme au Cerfa 15695*01. " +
    "Sois précis sur le retentissement fonctionnel dans la vie quotidienne. " +
    "N'invente aucune information absente des notes — structure uniquement ce qui est fourni. " +
    enteteConsigne(req.user) +
    clinicalGenerationRules(req, 'certificat MDPH') +
    "Sections en MAJUSCULES suivi de deux-points :\n" +
    "DIAGNOSTIC PRINCIPAL :\n(Pathologie, éléments diagnostiques, CIM-10, facteurs de gravité)\n\n" +
    "PATHOLOGIES ASSOCIÉES :\n(Comorbidités pertinentes — omets si aucune)\n\n" +
    "RETENTISSEMENT FONCTIONNEL :\n(Impact dans les AVQ : mobilité, autonomie, communication, cognition, vie professionnelle/sociale. Sois exhaustif et concret.)\n\n" +
    "TRAITEMENTS EN COURS :\n(Médicaments, rééducation, hospitalisations)\n\n" +
    "PRONOSTIC :\n(Évolution, caractère permanent/temporaire)\n\n" +
    "BESOINS EN COMPENSATION :\n(Aide humaine, technique, aménagement — si applicable)\n\n" +
    "FORMAT : pas de Markdown. Omets les rubriques sans donnée disponible.";

  const user =
    (patient ? `Patient : ${patient}\n` : '') +
    (diagnostic ? `Diagnostic : ${diagnostic}\n` : '') +
    `\nNotes medicales :\n${notes || '(voir diagnostic)'}\n` +
    (complement ? `\nElements additionnels : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system, user, maxTokens: 2000 }));
    res.json({ document, safety: documentSafety(document, plainClinicalText(req.body), req.user) });
  } catch (err) { aiError(res, err); }
});

// POST /api/generate/ald
app.post('/api/generate/ald', authenticateJWT, async (req, res) => {
  const patient    = txt(req.body.patient, 500);
  const affection  = txt(req.body.affection, 500);
  const notes      = txt(req.body.notes);
  const complement = txt(req.body.complement, 2000);

  if (!affection && !notes) {
    return res.status(400).json({ error: "Renseignez l'affection longue duree ou les notes medicales." });
  }

  const spec = (req.user && req.user.specialite) || 'médecine générale';
  const system =
    `Tu es un médecin expert en ${spec}, exerçant en libéral en France. ` +
    "Tu rédiges le volet médecin traitant d'un protocole de soins ALD conforme au Cerfa 11626*07 et aux recommandations HAS. " +
    "Destiné au médecin conseil AM pour accord de prise en charge à 100%. Sois précis et exhaustif. " +
    "N'invente aucune information. Les recommandations HAS ne peuvent apparaître que comme suggestions validées par le médecin. " +
    enteteConsigne(req.user) +
    clinicalGenerationRules(req, 'protocole ALD') +
    "Sections en MAJUSCULES suivi de deux-points :\n" +
    "AFFECTION LONGUE DURÉE :\n(Numéro ALD si connu, intitulé exact selon liste ALD 30)\n\n" +
    "DIAGNOSTIC :\n(Diagnostic précis, éléments cliniques/paracliniques, CIM-10)\n\n" +
    "ACTES ET PRESTATIONS NÉCESSAIRES :\n" +
    "Consultations médicales : (spécialités et fréquence)\n" +
    "Examens biologiques : (bilans selon recommandations HAS)\n" +
    "Imagerie et explorations : (si applicable)\n" +
    "Médicaments de l'ALD : (DCI, indication)\n" +
    "Soins paramédicaux : (si applicable)\n" +
    "Matériel médical : (si applicable)\n\n" +
    "DURÉE DU PROTOCOLE :\n(1 à 5 ans selon évolution prévisible)\n\n" +
    "FORMAT : pas de Markdown. Sections séparées par sauts de ligne. Pas de champ vide.";

  const user =
    (patient ? `Patient : ${patient}\n` : '') +
    (affection ? `Affection longue duree : ${affection}\n` : '') +
    `\nNotes medicales :\n${notes || '(voir affection)'}\n` +
    (complement ? `\nElements additionnels : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system, user, maxTokens: 2000 }));
    res.json({ document, safety: documentSafety(document, plainClinicalText(req.body), req.user) });
  } catch (err) { aiError(res, err); }
});

// POST /api/generate/certificat
app.post('/api/generate/certificat', authenticateJWT, async (req, res) => {
  const patient    = txt(req.body.patient, 500);
  const type       = txt(req.body.type, 200);
  const notes      = txt(req.body.notes);
  const complement = txt(req.body.complement, 2000);

  if (!type && !notes) {
    return res.status(400).json({ error: 'Renseignez le type de certificat.' });
  }

  const spec = (req.user && req.user.specialite) || 'médecine générale';
  const typeLabel = type || 'médical';

  // Adapte les contraintes légales selon le type de certificat
  const typeLower = typeLabel.toLowerCase();
  let legalNote = '';
  if (/sport|aptitude/i.test(typeLower)) {
    legalNote = "Pour un certificat d'aptitude au sport, mentionner : l'absence de contre-indication clinique à la pratique sportive au vu de l'examen du jour, le sport concerné, et la durée de validité (1 an pour les fédérations agréées). Ne pas mentionner le diagnostic précis, seulement l'aptitude. ";
  } else if (/arr[eê]t|travail|incapacité/i.test(typeLower)) {
    legalNote = "Pour un certificat d'arrêt de travail/incapacité temporaire, préciser la durée et le motif médical général (sans détail diagnostique sauf accord patient), et mentionner si le patient peut sortir ou non. ";
  } else if (/décès|mort/i.test(typeLower)) {
    legalNote = "Pour un certificat de décès, respecter le formulaire Cerfa 7-78 : heure et lieu du décès, cause apparente, caractère naturel/non naturel/indéterminé, obstacle médico-légal (oui/non). ";
  } else if (/garde|divorce|justice|tribunal/i.test(typeLower)) {
    legalNote = "Ce certificat peut être produit en justice. Soyez particulièrement factuel et objectif, limité aux seuls constats cliniques vérifiables. Pas d'interprétation, pas de prise de position. ";
  }

  const system =
    `Tu es un médecin expert en ${spec}, exerçant en libéral en France. ` +
    `Tu rédiges un certificat médical (${typeLabel}) conforme au Code de déontologie médicale (art. 28 CNOM). ` +
    "Objectif, précis, limité aux éléments médicaux nécessaires. N'invente rien — base-toi uniquement sur les éléments fournis. " +
    legalNote +
    enteteConsigne(req.user) +
    clinicalGenerationRules(req, 'certificat médical') +
    "Structure exacte :\n" +
    "En-tête médecin\n" +
    "[Ville], le [date du jour]\n\n" +
    "CERTIFICAT MÉDICAL — [TYPE EN MAJUSCULES]\n\n" +
    "Je soussigné(e), Docteur [nom], [spécialité], certifie avoir examiné ce jour :\n" +
    "[Corps du certificat en prose professionnelle à la 3e personne]\n\n" +
    "Certificat établi à la demande de l'intéressé(e) et remis en main propre, pour valoir ce que de droit.\n\n" +
    "Signature\n\n" +
    "FORMAT : prose fluide, pas de Markdown. " +
    "Omets les champs absents, sauf mention légalement obligatoire.";

  const user =
    (patient ? `Patient : ${patient}\n` : '') +
    (type ? `Type de certificat : ${type}\n` : '') +
    `\nÉléments médicaux :\n${notes || '(voir type)'}\n` +
    (complement ? `\nÉléments additionnels : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system, user, maxTokens: 1200 }));
    res.json({ document, safety: documentSafety(document, plainClinicalText(req.body), req.user) });
  } catch (err) { aiError(res, err); }
});
// POST /api/generate/ordonnance — ordonnance médicale structurée (standard ou bizone ALD)
app.post('/api/generate/ordonnance', authenticateJWT, async (req, res) => {
  const patient     = txt(req.body.patient, 500);
  const ddn         = s(req.body.ddn, 20);
  const medicaments = txt(req.body.medicaments);
  const medicamentsAld = txt(req.body.medicamentsAld, 5000);
  const bizone      = req.body.bizone === true || req.body.bizone === 'true';
  const complement  = txt(req.body.complement, 2000);

  if (!medicaments && !medicamentsAld) {
    return res.status(400).json({ error: 'Renseignez les médicaments à prescrire.' });
  }

  const spec = (req.user && req.user.specialite) || 'médecine générale';

  const formatRules =
    "Pour chaque médicament : DCI (Dénomination Commune Internationale) + nom commercial entre parenthèses si pertinent, " +
    "forme galénique, dosage unitaire, posologie précise (fréquence, moment de prise), durée de traitement ou mention 'traitement continu'. " +
    "Stupéfiants ou liste I/II : quantité obligatoirement en toutes lettres. " +
    "N'invente aucune posologie non fournie — utilise uniquement ce que le médecin indique. " +
    "FORMAT : texte brut, aucun Markdown. " +
    "Omets les champs absents, sauf mention légalement obligatoire.";

  let system, userMsg;

  if (bizone) {
    system =
      `Tu es un médecin expert en ${spec}, exerçant en libéral en France. ` +
      "Tu rédiges une ORDONNANCE BIZONE conforme au format légal français pour patient en ALD (arrêté du 4 octobre 1985). " +
      "Une ordonnance bizone comporte deux zones distinctes : " +
      "ZONE HAUTE (en rapport avec l'ALD) : médicaments pris en charge à 100% par l'Assurance Maladie. " +
      "ZONE BASSE (sans rapport avec l'ALD) : médicaments à la charge habituelle du patient. " +
      enteteConsigne(req.user) +
      clinicalGenerationRules(req, 'ordonnance bizone') +
      "Structure EXACTE de l'ordonnance bizone :\n" +
      "ORDONNANCE BIZONE\n" +
      "Date : [date du jour]\n" +
      "Patient : [nom complet], né(e) le [date naissance si fournie]\n\n" +
      "─────────────────────────────────────────────────\n" +
      "PRESCRIPTIONS EN RAPPORT AVEC L'ALD\n" +
      "(Prise en charge à 100% — exonération du ticket modérateur)\n" +
      "─────────────────────────────────────────────────\n" +
      "[médicaments zone ALD numérotés 1., 2., ...]\n\n" +
      "─────────────────────────────────────────────────\n" +
      "PRESCRIPTIONS SANS RAPPORT AVEC L'ALD\n" +
      "(Remboursement au taux habituel)\n" +
      "─────────────────────────────────────────────────\n" +
      "[médicaments zone standard numérotés 1., 2., ...]\n\n" +
      "Signature : Dr [nom], [spécialité], RPPS [numéro si disponible]\n\n" +
      formatRules;

    userMsg =
      (patient ? `Patient : ${patient}\n` : '') +
      (ddn ? `Date de naissance : ${ddn}\n` : '') +
      (medicamentsAld ? `\nMédicaments en rapport avec l'ALD (zone haute) :\n${medicamentsAld}\n` : '') +
      (medicaments ? `\nMédicaments sans rapport avec l'ALD (zone basse) :\n${medicaments}\n` : '') +
      (complement ? `\nÉléments additionnels : ${complement}\n` : '');
  } else {
    system =
      `Tu es un médecin expert en ${spec}, exerçant en libéral en France. ` +
      "Tu rédiges une ordonnance médicale complète et conforme aux bonnes pratiques françaises (HAS, ANSM). " +
      enteteConsigne(req.user) +
      clinicalGenerationRules(req, 'ordonnance') +
      "Structure exacte :\n" +
      "ORDONNANCE MÉDICALE\n" +
      "Date : [date du jour]\n" +
      "Patient : [nom complet], né(e) le [date naissance si fournie]\n\n" +
      "[médicaments numérotés 1., 2., ... — un paragraphe par médicament]\n\n" +
      "[Conseils au patient si pertinents]\n\n" +
      "Signature : Dr [nom], [spécialité], RPPS [numéro si disponible]\n\n" +
      formatRules;

    userMsg =
      (patient ? `Patient : ${patient}\n` : '') +
      (ddn ? `Date de naissance : ${ddn}\n` : '') +
      `\nMédicaments à prescrire :\n${medicaments}\n` +
      (complement ? `\nÉléments additionnels : ${complement}\n` : '');
  }

  try {
    const document = finalizeDocument(await generateDocument({ system, user: userMsg, maxTokens: 1800 }));
    res.json({ document, safety: documentSafety(document, plainClinicalText(req.body), req.user) });
  } catch (err) { aiError(res, err); }
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START (uniquement si lancé directement, pas via require() en test) ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Praxi backend ✓`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  → Admin : x-admin-token: ${ADMIN_TOKEN}`);
    console.log(`  → Data  : waitlist.json · users.json`);
    console.log(`  → Auth  : JWT (${JWT_EXPIRES_IN})${process.env.JWT_SECRET ? '' : ' — ⚠ JWT_SECRET par défaut'}`);
    console.log(`  → IA    : ${anthropic ? `activée (${AI_MODEL})` : 'désactivée — ANTHROPIC_API_KEY manquante'}`);
    console.log(`  → Data  : ${DATA_DIR}${process.env.DATA_DIR ? '' : ' — ⚠ stockage éphémère (définis DATA_DIR + volume pour persister)'}`);

    // Vérifie la connexion SMTP au démarrage : le résultat apparaît dans les logs Railway.
    if (SMTP_USER && SMTP_PASS) {
      transporter.verify()
        .then(() => console.log(`  → SMTP  : connecté (${SMTP_USER})\n`))
        .catch(err => console.error(`  → SMTP  : ÉCHEC — ${err && err.message}\n`));
    } else {
      console.log('  → SMTP  : désactivé — SMTP_USER / SMTP_PASS manquants\n');
    }
  });
}

module.exports = app;
module.exports.finalizeDocument = finalizeDocument;
