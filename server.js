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

// ─── PRAXI V2 : moteur clinique explicable ────────────────────────────────────────────
// Déterministe, disponible même sans IA. Ne transforme jamais une suggestion en fait.
const CLINICAL_PROFILES = {
  cardiologue: {
    focus: ['symptômes et chronologie', 'ECG', 'facteurs de risque cardiovasculaire', 'traitements', 'syncope et dyspnée'],
    questions: ['Début, durée et fréquence des symptômes ?', 'Survenue à l’effort ou au repos ?', 'Syncope, douleur thoracique ou dyspnée associée ?', 'ECG et constantes disponibles ?', 'Facteurs de risque cardiovasculaire ?']
  },
  endocrinologue: {
    focus: ['HbA1c ou bilan hormonal', 'poids et IMC', 'traitements et observance', 'complications', 'évolution biologique'],
    questions: ['Dernier bilan biologique et date ?', 'Poids, taille ou IMC ?', 'Traitement actuel et observance ?', 'Complications déjà recherchées ?', 'Objectif thérapeutique attendu ?']
  },
  neurologue: {
    focus: ['chronologie', 'examen neurologique', 'imagerie', 'signes associés', 'traitements essayés'],
    questions: ['Chronologie précise et mode d’installation ?', 'Déficit moteur, sensitif ou trouble de la conscience ?', 'Examen neurologique réalisé ?', 'Imagerie ou bilan déjà disponible ?', 'Traitements essayés et réponse ?']
  },
  pneumologue: {
    focus: ['dyspnée et toux', 'tabagisme', 'SpO2', 'EFR et imagerie', 'traitements inhalés'],
    questions: ['Tabagisme actuel et cumulé ?', 'Dyspnée au repos ou à l’effort ?', 'SpO2 et auscultation ?', 'EFR ou imagerie disponibles ?', 'Traitement respiratoire actuel ?']
  },
  gastro: {
    focus: ['douleur et transit', 'signes d’alarme', 'biologie hépatique', 'endoscopie et imagerie', 'traitements essayés'],
    questions: ['Localisation et rythme des symptômes ?', 'Amaigrissement, saignement ou fièvre ?', 'Transit et alimentation ?', 'Biologie, endoscopie ou imagerie ?', 'Traitements déjà essayés ?']
  },
  nephrologue: {
    focus: ['créatinine et DFG', 'protéinurie', 'pression artérielle', 'ionogramme', 'médicaments néphrotoxiques'],
    questions: ['Créatinine, DFG et évolution ?', 'Protéinurie ou hématurie ?', 'Pression artérielle ?', 'Ionogramme disponible ?', 'Traitements potentiellement néphrotoxiques ?']
  },
  rhumatologue: {
    focus: ['topographie et rythme des douleurs', 'raideur', 'examen articulaire', 'syndrome inflammatoire', 'imagerie'],
    questions: ['Rythme mécanique ou inflammatoire ?', 'Raideur matinale et durée ?', 'Examen articulaire ?', 'CRP/VS disponibles ?', 'Imagerie déjà réalisée ?']
  },
  psychiatre: {
    focus: ['symptômes et durée', 'retentissement', 'risque suicidaire', 'addictions', 'traitements psychotropes'],
    questions: ['Durée et retentissement fonctionnel ?', 'Idées suicidaires ou mise en danger ?', 'Sommeil et appétit ?', 'Consommations ou addictions ?', 'Traitements et suivi antérieurs ?']
  },
  gynecologue: {
    focus: ['cycle et grossesse', 'douleur ou saignement', 'contraception', 'examen', 'imagerie et biologie'],
    questions: ['Date des dernières règles et possibilité de grossesse ?', 'Douleur ou saignement ?', 'Contraception ?', 'Examen clinique réalisé ?', 'Échographie ou biologie disponible ?']
  },
  pediatre: {
    focus: ['âge exact', 'croissance', 'développement', 'vaccinations', 'contexte familial'],
    questions: ['Âge, poids et courbe de croissance ?', 'Développement psychomoteur ?', 'Vaccinations à jour ?', 'Alimentation et sommeil ?', 'Signes de gravité rapportés ?']
  },
  oncologue: {
    focus: ['histologie et stade', 'imagerie', 'traitements reçus', 'tolérance', 'état général'],
    questions: ['Type histologique et stade ?', 'Dernière imagerie ?', 'Traitements reçus et dates ?', 'Tolérance et toxicités ?', 'Performance status ou autonomie ?']
  },
  algologue: {
    focus: ['mécanisme et topographie de la douleur', 'EVA ou échelle', 'retentissement fonctionnel', 'traitements antalgiques essayés', 'composante neuropathique', 'imagerie et signes de gravité'],
    questions: ['EVA actuelle et EVA maximale récente ?', 'Mécanisme nociceptif, neuropathique ou mixte ?', 'Traitements antalgiques et paliers OMS déjà essayés ?', 'Retentissement sommeil, humeur, autonomie ?', 'Signes neurologiques ou d’alarme recherchés ?']
  },
  dermatologue: {
    focus: ['description précise des lésions', 'localisation et étendue', 'évolution et ancienneté', 'traitements locaux et généraux', 'contexte atopique ou immunologique'],
    questions: ['Description précise des lésions (aspect, taille, couleur) ?', 'Localisation et étendue ?', 'Ancienneté et évolution des lésions ?', 'Traitements locaux ou généraux déjà essayés ?', 'Antécédents atopiques ou cutanés ?']
  },
  orl: {
    focus: ['symptômes ORL et ancienneté', 'audiogramme ou bilan auditif', 'rhinoscopie ou nasofibroscopie', 'traitements essayés', 'signes d’alarme (dysphagie, dysphonie)'],
    questions: ['Ancienneté et évolution des symptômes ?', 'Bilan auditif ou audiogramme disponible ?', 'Symptômes rhinologiques associés ?', 'Traitements médicaux essayés ?', 'Dysphagie, dysphonie ou dyspnée laryngeée ?']
  },
  ophtalmologue: {
    focus: ['acuité visuelle', 'fond d’œil', 'pression intra-oculaire', 'contexte (diabète, HTA)', 'traitements oculaires'],
    questions: ['Acuité visuelle mesurée ?', 'Fond d’œil disponible ?', 'Contexte diabète ou HTA connu ?', 'Douleur oculaire ou trouble visuel brutal ?', 'Traitement oculaire en cours ?']
  },
  urologue: {
    focus: ['symptômes urinaires et chronologie', 'PSA ou bilan biologique', 'échographie vésico-rénale', 'ECBU et antibiogramme', 'contexte prostatique ou lithiasique'],
    questions: ['Symptômes urinaires précis et ancienneté ?', 'PSA et date du dernier dosage ?', 'Imagerie urinaire disponible ?', 'ECBU récent disponible ?', 'Antécédents urologiques ou chirurgicaux ?']
  },
  orthopedie: {
    focus: ['mécanisme et localisation lésionnelle', 'imagerie disponible (radio, IRM)', 'retentissement fonctionnel', 'traitements conservateurs essayés', 'critères chirurgicaux'],
    questions: ['Mécanisme et ancienneté de la lésion ?', 'Radiographie et IRM disponibles ?', 'Retentissement fonctionnel précis ?', 'Kinésithérapie ou infiltrations essayées ?', 'Critères d’indication chirurgicale déjà évoqués ?']
  },
  medecine_interne: {
    focus: ['présentation multi-systémique', 'bilan biologique exhaustif', 'bilan immunologique', 'fièvre et AEG', 'diagnostics différentiels'],
    questions: ['Atteintes multi-systémiques présentes ?', 'Bilan biologique complet disponible ?', 'Bilan immunologique (ANA, ANCA, etc.) ?', 'Fièvre prolongée ou AEG associée ?', 'Diagnostics déjà éliminés ?']
  },
  geriatrie: {
    focus: ['polyмédication et iatrogénie', 'chutes et troubles de l’équilibre', 'troubles cognitifs', 'état nutritionnel', 'autonomie et contexte social'],
    questions: ['Nombre de médicaments et interactions ?', 'Chutes récentes et fréquence ?', 'Troubles cognitifs évalués (MMS/MMSE) ?', 'État nutritionnel (poids, albumine) ?', 'Contexte social et aide à domicile ?']
  },
  anesthesiste: {
    focus: ['score ASA et antécédents chirurgicaux', 'allergies médicamenteuses', 'anticoagulants et antiaggrégeants', 'évaluation des voies aériennes', 'traitements en cours'],
    questions: ['Antécédents anesthésiques et chirurgicaux ?', 'Allergies médicamenteuses connues ?', 'Anticoagulants ou antiaggrégeants en cours ?', 'Évaluation des voies aériennes (Mallampati) ?', 'Bilan biologique pré-opératoire disponible ?']
  },
  default: {
    focus: ['motif', 'chronologie', 'antécédents', 'traitements', 'examen et résultats disponibles'],
    questions: ['Chronologie et évolution ?', 'Antécédents pertinents ?', 'Traitements et allergies ?', 'Examen clinique et constantes ?', 'Question précise posée au destinataire ?']
  }
};

function plainClinicalText(body = {}) {
  return ['patient','age','ddn','motif','notes','text','diagnostic','affection','type','medicaments','medicamentsAld']
    .map(k => typeof body[k] === 'string' ? body[k] : '').filter(Boolean).join('\n').trim();
}

function specialtyProfile(name = '') {
  const aliases = {
    gastro:'gastro', hepatologue:'gastro', hepato:'gastro',
    nephrologue:'nephrologue', neph:'nephrologue',
    rhumatologue:'rhumatologue', rhumato:'rhumatologue',
    psychiatre:'psychiatre', psychi:'psychiatre',
    gynecologue:'gynecologue', gyneco:'gynecologue', obstetric:'gynecologue',
    pediatre:'pediatre', pediat:'pediatre',
    oncologue:'oncologue', cancerologue:'oncologue', hematologue:'oncologue',
    algologue:'algologue', algologie:'algologue', algolog:'algologue',
    dermatologue:'dermatologue', dermato:'dermatologue',
    orl:'orl', oto:'orl', rhino:'orl', laryngo:'orl',
    ophtalmologue:'ophtalmologue', ophtalmo:'ophtalmologue',
    urologue:'urologue', urolog:'urologue',
    orthoped:'orthopedie', orthopedie:'orthopedie',
    interniste:'medecine_interne',
    geriatre:'geriatrie', geriatrie:'geriatrie',
    anesthes:'anesthesiste', reanimat:'anesthesiste',
    cardiologue:'cardiologue', cardio:'cardiologue',
    endocrinologue:'endocrinologue', endocrino:'endocrinologue', diabetologue:'endocrinologue',
    neurologue:'neurologue', neuro:'neurologue',
    pneumologue:'pneumologue', pneumo:'pneumologue'
  };
  const normalized = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g,' ');
  const alias = Object.keys(aliases).find(k => normalized.includes(k));
  const key = alias ? aliases[alias] : Object.keys(CLINICAL_PROFILES).find(k => k !== 'default' && normalized.includes(k));
  return CLINICAL_PROFILES[key || 'default'];
}

function hasAny(text, patterns) { return patterns.some(p => p.test(text)); }

function hasClinicalExamSignals(src) {
  return hasAny(src, [
    /examen|auscult|tension|\bpa\b|\bfc\b|spo2|saturation|poids|taille|imc/i,
    /d[eé]ficit|sphincter|motricit|neurolog|man[oe]uvre|lasegue|las[eè]gue/i,
    /\beva\b|échelle.*douleur|douleur.*\/\s*10/i,
    /irm|scanner|échographie|radio|imagerie|tomodensitom[eé]trie/i
  ]);
}

function hasTreatmentSignals(src) {
  return hasAny(src, [
    /traitement|th[eé]rapie|m[eé]dicament|sous\s|mg\b|comprim/i,
    /parac[eé]tamol|ibuprofène|tramadol|morphine|codéine|oxycodone|pregabaline|amitriptyline|kin[eé]sith[eé]rapie|kin[eé]\b/i
  ]);
}

function pushUniqueDeduction(list, text) {
  if (text && !list.includes(text)) list.push(text);
}

function pushUniqueSuggestion(list, item) {
  if (!item || !item.label) return;
  if (!list.some(x => x.id === item.id || x.label === item.label)) list.push(item);
}

function analyzeBySpecialty(source, body, deductions, suggestions) {
  const spec = (body.specialiste || body.specialty || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Cardiology
  if (/palpitation/i.test(source)) {
    pushUniqueDeduction(deductions, 'Un avis cardiologique est pertinent au regard des palpitations rapportées.');
    if (/ecg[^\n.]*normal|ecg\s*normal/i.test(source))
      pushUniqueDeduction(deductions, 'Un ECG intercritique normal n’exclut pas un trouble rythmique intermittent.');
    if (/pas de syncope|sans syncope|absence de syncope/i.test(source))
      pushUniqueDeduction(deductions, 'L’absence de syncope rapportée est un élément rassurant, sans exclure une cause rythmique.');
    pushUniqueSuggestion(suggestions, { id:'holter', label:'Discuter un Holter ECG', rationale: /ecg[^\n.]*normal/i.test(source) ? 'Palpitations persistantes avec ECG intercritique normal' : 'Palpitations rapportées', category:'examen', confidence: /depuis|mois|semaine/i.test(source) ? 96 : 86 });
    pushUniqueSuggestion(suggestions, { id:'cardio', label:'Discuter un avis cardiologique', rationale:'Symptomatologie rythmique rapportée', category:'orientation', confidence:91 });
    pushUniqueSuggestion(suggestions, { id:'echo', label:'Discuter une échographie cardiaque', rationale:'A apprécier selon les antécédents et facteurs de risque', category:'examen', confidence:71 });
  }
  if (/douleur(s)? thoracique/i.test(source)) {
    pushUniqueDeduction(deductions, 'La douleur thoracique rapportée nécessite de préciser son caractère (effort/repos, irradiation, durée).');
    pushUniqueSuggestion(suggestions, { id:'ecg', label:'Discuter un ECG selon le contexte', rationale:'Douleur thoracique rapportée', category:'examen', confidence:94 });
  }
  if (/hta|hypertension/i.test(source) && /cardio/i.test(spec)) {
    pushUniqueDeduction(deductions, 'L’HTA rapportée constitue un facteur de risque cardiovasculaire à mentionner explicitement.');
    pushUniqueSuggestion(suggestions, { id:'hta-bilan', label:'Mentionner les chiffres tensionnels habituels et le traitement', rationale:'HTA connue dans le dossier', category:'clinique', confidence:85 });
  }

  // Endocrinology
  if (/diab[eè]te/i.test(source)) {
    if (/hba1c\s*(?:[:=]?\s*)?(8(?:[.,]\d)?|9(?:[.,]\d)?|1\d)/i.test(source)) {
      pushUniqueDeduction(deductions, 'L’HbA1c rapportée suggère un équilibre glycémique insuffisant nécessitant une réévaluation thérapeutique.');
      pushUniqueSuggestion(suggestions, { id:'diabeto', label:'Discuter une réévaluation thérapeutique (HbA1c élevée)', rationale:'HbA1c élevée rapportée', category:'prise_en_charge', confidence:92 });
    } else {
      pushUniqueDeduction(deductions, 'Le diabète mentionné nécessite de préciser le type, l’ancienneté, l’HbA1c récente et les complications recherchées.');
    }
    pushUniqueSuggestion(suggestions, { id:'complications-diab', label:'Mentionner la recherche de complications (néphropathie, rétinopathie, neuropathie)', rationale:'Diabète rapporté', category:'examen', confidence:84 });
  }
  if (/thyro[iï]d/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le contexte thyroïdien nécessite de préciser les bilans hormonaux récents (TSH, T4).');
    pushUniqueSuggestion(suggestions, { id:'thyro', label:'Joindre le bilan thyroïdien récent (TSH, T4)', rationale:'Pathologie thyroïdienne mentionnée', category:'examen', confidence:89 });
  }

  // Neurology
  if (/epilepsi|crise(s)? convulsiv|comitialit/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’épilepsie rapportée nécessite de préciser le type de crises, leur fréquence et la tolérance du traitement antiépileptique.');
    pushUniqueSuggestion(suggestions, { id:'eeg', label:'Mentionner le dernier EEG si disponible', rationale:'Épilepsie rapportée', category:'examen', confidence:85 });
    pushUniqueSuggestion(suggestions, { id:'observance-epi', label:'Préciser l’observance du traitement antiépileptique', rationale:'Impact direct sur le contrôle des crises', category:'prise_en_charge', confidence:90 });
  }
  if (/cephale|migraine/i.test(source)) {
    pushUniqueDeduction(deductions, 'Les céphalées rapportées nécessitent de préciser leur caractère (pulsatiles, biléatérales, aura) et leur fréquence mensuelle.');
    pushUniqueSuggestion(suggestions, { id:'cephale-freq', label:'Préciser la fréquence et le type de céphalées', rationale:'Céphalées mentionnées', category:'clinique', confidence:82 });
    pushUniqueSuggestion(suggestions, { id:'cephale-ttt', label:'Lister les traitements de crise et de fond déjà essayés', rationale:'Orientation thérapeutique pour le neurologue', category:'prise_en_charge', confidence:87 });
  }
  if (/avc|ait|accident vasculaire|ischemie cerebral/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’AVC ou AIT mentionné nécessite de rappeler la date, le type (ischémique/hémorragique) et le bilan étiologique déjà réalisé.');
    pushUniqueSuggestion(suggestions, { id:'prevention-avc', label:'Mentionner la prévention secondaire en cours (anticoagulants, antiaggrégeants)', rationale:'AVC/AIT dans les antécédents', category:'prise_en_charge', confidence:93 });
  }

  // Pulmonology
  if (/tabagism|fumeur|paquet[- ]ann/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le tabagisme rapporté constitue un élément essentiel pour évaluer le risque de BPCO et de pathologie néoplasique bronchique.');
    pushUniqueSuggestion(suggestions, { id:'efr', label:'Discuter la réalisation d’EFR (spirométrie)', rationale:'Tabagisme significatif mentionné', category:'examen', confidence:88 });
  }
  if (/hemoptys/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’hémoptysie mentionnée est un signe d’alarme nécessitant une imagerie thoracique urgente si ce n’est fait.');
    pushUniqueSuggestion(suggestions, { id:'scanner-thorax', label:'Préciser si un scanner thoracique a été réalisé', rationale:'Hémoptysie rapportée — signe d’alarme', category:'examen', confidence:96 });
  }
  if (/apnee|ronflement|saos|syndrome.*apnee/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le syndrome d’apnées du sommeil suspecté ou confirmé nécessite de préciser les symptômes diurnes et la saturation nocturne.');
    pushUniqueSuggestion(suggestions, { id:'polygraphie', label:'Mentionner si une polygraphie ou polysomnographie est disponible', rationale:'Apnées du sommeil rapportées', category:'examen', confidence:90 });
  }

  // Gastroenterology
  if (/rectorragie|sang.*selle|selle.*sang|melena/i.test(source)) {
    pushUniqueDeduction(deductions, 'Les rectorragies ou le méléna mentionnés sont des signes d’alarme justifiant une coloscopie si non encore programmée.');
    pushUniqueSuggestion(suggestions, { id:'coloscopie', label:'Préciser si une coloscopie est prévue ou disponible', rationale:'Saignement digestif rapporté — signe d’alarme', category:'examen', confidence:95 });
  }
  if (/amaigrissement|perte.*poids/i.test(source) && /gastro|hepato|colon|digest/i.test(source + spec)) {
    pushUniqueDeduction(deductions, 'L’amaigrissement dans ce contexte digestif est un signe d’alarme qui nécessite un bilan oncologique et nutritionnel.');
    pushUniqueSuggestion(suggestions, { id:'bilan-aeg', label:'Mentionner le poids actuel et la perte de poids quantifiée', rationale:'Amaigrissement rapporté — signe d’alarme', category:'clinique', confidence:93 });
  }
  if (/pyrosis|reflux|rgo/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le reflux ou les pyrosis rapportés justifient de préciser leur ancienneté, leur sévérité et la réponse aux IPP déjà essayés.');
    pushUniqueSuggestion(suggestions, { id:'ipp', label:'Préciser la réponse aux IPP et l’indication endoscopique', rationale:'RGO ou pyrosis mentionnés', category:'prise_en_charge', confidence:84 });
  }
  if (/ictere|jaundice|bilirub/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’ictère rapporté nécessite un bilan hépatique complet en urgence et une imagerie hépato-biliaire.');
    pushUniqueSuggestion(suggestions, { id:'bilan-hepatique', label:'Joindre le bilan hépatique complet (bili, transaminases, GGT, PAL)', rationale:'Ictère rapporté', category:'examen', confidence:95 });
  }

  // Nephrology
  if (/creatinine|dfg|clearance/i.test(source)) {
    pushUniqueDeduction(deductions, 'La créatinine ou le DFG mentionnés nécessitent de préciser la valeur exacte, la date et la tendance évolutive.');
    pushUniqueSuggestion(suggestions, { id:'dfg-evol', label:'Joindre les valeurs de créatinine avec dates pour évaluer la progression', rationale:'Créatinine ou DFG mentionnés', category:'examen', confidence:90 });
  }
  if (/proteinurie|albumin.*urine|hematurie/i.test(source) && /nephro|renal|rein/i.test(source + spec)) {
    pushUniqueDeduction(deductions, 'La protéinurie ou l’hématurie rapportées orientent vers une atteinte glomérulaire ou tubulaire à préciser.');
    pushUniqueSuggestion(suggestions, { id:'ecbu', label:'Préciser le résultat du dernier ECBU et la protéinurie quantifiée', rationale:'Protéinurie ou hématurie mentionnées', category:'examen', confidence:87 });
  }

  // Rheumatology
  if (/arthrite|polyarthrite|arthrose|spondyl/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’atteinte articulaire rapportée nécessite de préciser son rythme (mécanique ou inflammatoire) et le nombre d’articulations concernées.');
    pushUniqueSuggestion(suggestions, { id:'bilan-rhumato', label:'Joindre le bilan inflammatoire (CRP, VS) et immunologique si disponible', rationale:'Pathologie articulaire mentionnée', category:'examen', confidence:88 });
  }
  if (/raideur matinal/i.test(source)) {
    pushUniqueDeduction(deductions, 'La raideur matinale mentionnée oriente vers un rythme inflammatoire et nécessite d’en préciser la durée.');
    pushUniqueSuggestion(suggestions, { id:'raideur', label:'Préciser la durée de la raideur matinale (> ou < 30 minutes)', rationale:'Raideur matinale rapportée', category:'clinique', confidence:85 });
  }
  if (/goutte|uricemie|acide urique/i.test(source)) {
    pushUniqueDeduction(deductions, 'La goutte ou l’hyperuricémie rapportée nécessite de préciser le dernier dosage d’acide urique.');
    pushUniqueSuggestion(suggestions, { id:'uricemie', label:'Mentionner le dernier dosage d’acide urique', rationale:'Goutte ou hyperuricémie mentionnée', category:'examen', confidence:87 });
  }
  if (/osteoporose|densitometrie|dexa/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’ostéoporose mentionnée justifie de préciser le score T de la dernière densitométrie et les traitements en cours.');
    pushUniqueSuggestion(suggestions, { id:'dexa', label:'Joindre la dernière densitométrie (T-score)', rationale:'Ostéoporose mentionnée', category:'examen', confidence:83 });
  }

  // Psychiatry
  if (/ideation.*suicid|risque.*suicid|tentative.*suicide|tss\b/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le risque suicidaire mentionné est une urgence clinique : préciser l’intensité de l’idéation, les moyens disponibles et les facteurs protecteurs.');
    pushUniqueSuggestion(suggestions, { id:'urgence-psy', label:'Signaler explicitement l’évaluation du risque suicidaire dans le courrier', rationale:'Risque suicidaire rapporté — élément critique', category:'prise_en_charge', confidence:98 });
  }
  if (/depression|episode depressif|humeur|tristesse/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’épisode dépressif rapporté nécessite de préciser son ancienneté, son intensité et les traitements déjà essayés.');
    pushUniqueSuggestion(suggestions, { id:'psy-ttt', label:'Préciser les antidépresseurs et psychotropes déjà essayés et leur réponse', rationale:'Traitement psychiatrique à évaluer', category:'prise_en_charge', confidence:88 });
  }
  if (/anxiete|trouble anxieux|attaque de panique/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’anxiété ou les attaques de panique mentionnées justifient de préciser l’impact fonctionnel et les stratégies thérapeutiques déjà tentées.');
    pushUniqueSuggestion(suggestions, { id:'tcc', label:'Mentionner si une TCC ou un suivi psychologique est en cours', rationale:'Trouble anxieux mentionné', category:'prise_en_charge', confidence:83 });
  }
  if (/addiction|alcool|cannabis|substance|dependance/i.test(source)) {
    pushUniqueDeduction(deductions, 'L’addiction ou la consommation de substance mentionnée doit être précisée (type, quantité, ancienneté).');
    pushUniqueSuggestion(suggestions, { id:'addiction-detail', label:'Préciser les consommations (type, fréquence) et toute démarche de sevrage', rationale:'Addiction ou consommation mentionnée', category:'clinique', confidence:86 });
  }

  // Gynecology
  if (/menorragie|metrorragie|saignement.*gyneco|saignement.*uterine/i.test(source)) {
    pushUniqueDeduction(deductions, 'Les ménorragies ou métrorragies rapportées nécessitent une échographie pelvienne et un bilan d’hémostase si non encore réalisés.');
    pushUniqueSuggestion(suggestions, { id:'echo-gyneco', label:'Préciser si une échographie pelvienne est disponible', rationale:'Saignement gynécologique rapporté', category:'examen', confidence:91 });
  }
  if (/grossesse|enceinte|amenorrhee|ddm|dernieres regles/i.test(source)) {
    pushUniqueDeduction(deductions, 'La grossesse ou son contexte mentionné nécessite de préciser le terme, la parité et les antécédents obstétricaux.');
    pushUniqueSuggestion(suggestions, { id:'suivi-obstet', label:'Préciser le terme de la grossesse et les antécédents obstétricaux', rationale:'Grossesse ou aménorrhée mentionnée', category:'clinique', confidence:90 });
  }
  if (/menopause|postmenopause/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le contexte ménopausal justifie de mentionner la date de la ménopause, le traitement hormonal éventuel et le bilan osseux.');
    pushUniqueSuggestion(suggestions, { id:'menopause', label:'Mentionner la date de la ménopause et le traitement hormonal si en cours', rationale:'Ménopause mentionnée', category:'clinique', confidence:82 });
  }

  // Pediatrics
  if (/retard.*croissance|courbe.*taille|courbe.*poids|croissance insuffisante/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le retard de croissance mentionné nécessite de préciser le percentile actuel et la courbe d’évolution depuis la naissance.');
    pushUniqueSuggestion(suggestions, { id:'courbe-croissance', label:'Joindre ou décrire la courbe de croissance (percentile taille et poids)', rationale:'Retard de croissance rapporté', category:'clinique', confidence:89 });
  }
  if (/retard.*developpement|trouble.*developpement|autisme|tsa\b|tdah/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le trouble du développement mentionné nécessite une évaluation multidisciplinaire (orthophonie, psychomotricité, neuro-pédia).');
    pushUniqueSuggestion(suggestions, { id:'bilan-neuro-pedia', label:'Mentionner les bilans spécialisés déjà réalisés (orthophonie, psychomotricité)', rationale:'Trouble du développement mentionné', category:'examen', confidence:87 });
  }
  if (/fievre|febrile/i.test(source) && /pediatr/i.test(spec)) {
    pushUniqueDeduction(deductions, 'La fièvre chez l’enfant nécessite de préciser son ancienneté, son niveau maximal et tout signe de gravité associé.');
    pushUniqueSuggestion(suggestions, { id:'gravite-pedia', label:'Signaler les signes de gravité (altération du comportement, signe méningée, purpura)', rationale:'Fièvre pédiatrique rapportée', category:'clinique', confidence:92 });
  }

  // Oncology
  if (/cancer|carcinome|tumeur|lymphome|leucemie|hemopathie|neoplasie|sarcome/i.test(source)) {
    pushUniqueDeduction(deductions, 'La pathologie oncologique mentionnée nécessite de préciser le type histologique, le stade et le protocole de traitement en cours ou prévu.');
    pushUniqueSuggestion(suggestions, { id:'histologie', label:'Préciser le type histologique et le stade (TNM si disponible)', rationale:'Pathologie cancéreuse rapportée', category:'clinique', confidence:93 });
    pushUniqueSuggestion(suggestions, { id:'ps', label:'Mentionner le performance status (OMS/ECOG) ou l’autonomie du patient', rationale:'Élément clé pour la décision thérapeutique oncologique', category:'clinique', confidence:87 });
  }
  if (/chimiotherapie|immunotherapie|radiotherapie|hormonotherapie|therap.*ciblee/i.test(source)) {
    pushUniqueDeduction(deductions, 'Le traitement oncologique en cours nécessite de mentionner le protocole exact, le nombre de cycles réalisés et les toxicités éventuelles.');
    pushUniqueSuggestion(suggestions, { id:'toxicite', label:'Préciser les toxicités observées (hématologiques, digestives, cutanées)', rationale:'Traitement oncologique mentionné', category:'prise_en_charge', confidence:90 });
  }

  // Algology / Pain
  const isPainCtx = /lombalg|cervicalg|douleur|algia|eva|radicul|sciatique|nevralgie|neuropath/i.test(source);
  const toAlgo    = /algolog/i.test(spec);
  if (isPainCtx || toAlgo) {
    if (/lombalg|lombaire/i.test(source) && /irradiation|fesse|cuisse|radicul|sciatique/i.test(source))
      pushUniqueDeduction(deductions, 'La topographie lombaire avec irradiation membre inférieur oriente vers une composante radiculaire à explorer en algologie.');
    if (/\beva\b|\/\s*10|sur\s*10/i.test(source))
      pushUniqueDeduction(deductions, 'L’intensité douloureuse chiffrée (EVA) confirme un retentissement symptomatique significatif justifiant un avis antalgique spécialisé.');
    if (/irm|scanner|échographie|imagerie/i.test(source) && /protrusion|hernie|discopath|sténose/i.test(source))
      pushUniqueDeduction(deductions, 'Les éléments d’imagerie fournis permettent de contextualiser la douleur mécanique ou compressive sans remplacer l’évaluation clinique algologique.');
    if (/paracétamol|ibuprofène|tramadol|ains\b|morphine|codéine/i.test(source) && /insuffisant|échec|peu efficace|soulagement insuffisant/i.test(source))
      pushUniqueDeduction(deductions, 'L’échec des antalgiques de premier niveau plaide pour une réévaluation de la stratégie antalgique en consultation spécialisée.');
    if (/pas de déficit|sans déficit|pas de troubles sphinctériens|sans signe/i.test(source))
      pushUniqueDeduction(deductions, 'L’absence de signe neurologique de gravité rapportée est un élément rassurant à mentionner au confrère.');
    if (/sommeil|professionnel|autonomie|retentissement|impact/i.test(source))
      pushUniqueDeduction(deductions, 'Le retentissement fonctionnel documenté renforce l’indication d’une prise en charge antalgique structurée.');
    pushUniqueSuggestion(suggestions, { id:'neuropath', label:'Évoquer une composante neuropathique (DN4 si pertinent)', rationale:'Douleur avec irradiation ou caractère chronique', category:'examen', confidence:86 });
    pushUniqueSuggestion(suggestions, { id:'oms', label:'Rappeler les paliers antalgiques OMS déjà essayés', rationale:'Antécédents thérapeutiques rapportés', category:'prise_en_charge', confidence:90 });
    pushUniqueSuggestion(suggestions, { id:'pluri', label:'Proposer une prise en charge pluridisciplinaire (kiné + algologie)', rationale:'Douleur chronique avec retentissement fonctionnel', category:'orientation', confidence:84 });
    pushUniqueSuggestion(suggestions, { id:'retour-algo', label:'Solliciter un retour d’avis après consultation algologique', rationale:'Continuité des soins', category:'orientation', confidence:92 });
    if (/ibuprofène|ains\b|diclofénac|naproxène/i.test(source))
      pushUniqueSuggestion(suggestions, { id:'bilan-ains', label:'Mentionner surveillance si AINS au long cours', rationale:'AINS rapportés dans les traitements', category:'surveillance', confidence:72 });
  }

  // Dermatology
  if (/dermatologue|dermato/i.test(spec) || /lesion.*cutan|psoriasis|eczema|melanome|acne/i.test(source)) {
    if (/melanome|lesion.*suspecte|naevus|grain.*beaute/i.test(source)) {
      pushUniqueDeduction(deductions, 'La lésion cutanée suspecte mentionnée nécessite une évaluation dermoscopique urgente.');
      pushUniqueSuggestion(suggestions, { id:'dermoscopy', label:'Préciser l’aspect clinique et dermoscopique de la lésion', rationale:'Lésion suspecte rapportée — urgence diagnostique', category:'examen', confidence:94 });
    }
    if (/psoriasis/i.test(source)) {
      pushUniqueDeduction(deductions, 'Le psoriasis mentionné nécessite de préciser son étendue (score PASI) et les traitements systémiques déjà essayés.');
      pushUniqueSuggestion(suggestions, { id:'pasi', label:'Mentionner l’étendue (score PASI ou BSA%) et les traitements essayés', rationale:'Psoriasis mentionné', category:'clinique', confidence:84 });
    }
    if (/eczema|dermatite atopique/i.test(source)) {
      pushUniqueDeduction(deductions, 'La dermatite atopique mentionnée justifie de préciser les facteurs déclenchants et la réponse aux dermocorticoïdes.');
      pushUniqueSuggestion(suggestions, { id:'dermocortico', label:'Préciser l’utilisation et la réponse aux dermocorticoïdes', rationale:'Eczema ou dermatite atopique mentionné', category:'prise_en_charge', confidence:82 });
    }
  }

  // ORL
  if (/orl|auriculaire|oreille|audition|acouphene|rhinite|sinusite|angine|amygdale|laryngite|dysphonie/i.test(source + spec)) {
    if (/acouphene|tinnitus/i.test(source)) {
      pushUniqueDeduction(deductions, 'Les acouphènes mentionnés nécessitent un bilan audiométrique complet et une évaluation de leur retentissement fonctionnel.');
      pushUniqueSuggestion(suggestions, { id:'audiogramme', label:'Mentionner si un audiogramme récent est disponible', rationale:'Acouphènes rapportés', category:'examen', confidence:88 });
    }
    if (/surdite|hypoacousie/i.test(source)) {
      pushUniqueDeduction(deductions, 'La surdité ou l’hypoacousie mentionnée nécessite de préciser son type (transmission/perception) et son ancienneté.');
      pushUniqueSuggestion(suggestions, { id:'audiogramme-type', label:'Joindre l’audiogramme tonal et vocal si disponible', rationale:'Trouble auditif rapporté', category:'examen', confidence:90 });
    }
    if (/dysphagie/i.test(source)) {
      pushUniqueDeduction(deductions, 'La dysphagie mentionnée est un signe d’alarme ORL nécessitant une nasofibroscopie et un bilan morphologique rapide.');
      pushUniqueSuggestion(suggestions, { id:'nasofibro', label:'Signaler la dysphagie comme signe d’alarme — nasofibroscopie recommandée', rationale:'Dysphagie rapportée — signe d’alarme', category:'examen', confidence:93 });
    }
  }

  // Ophthalmology
  if (/ophtalmo|oculaire|visuel|glaucome|cataracte|dmla|retinopathie|fond.*oeil/i.test(source + spec)) {
    if (/diab[eè]te/i.test(source) && /ophtalmo/i.test(spec)) {
      pushUniqueDeduction(deductions, 'Le diabète justifie un dépistage systématique de la rétinopathie diabétique par fond d’œil ou rétinographie.');
      pushUniqueSuggestion(suggestions, { id:'retino', label:'Mentionner la date du dernier fond d’œil pour dépistage rétinopathie', rationale:'Diabète — dépistage rétinopathie obligatoire', category:'examen', confidence:95 });
    }
    if (/glaucome|pression.*intraoculaire|pio/i.test(source)) {
      pushUniqueDeduction(deductions, 'Le contexte de glaucome nécessite de préciser les chiffres de PIO, le traitement hypotonisant et le dernier champ visuel.');
      pushUniqueSuggestion(suggestions, { id:'pio', label:'Préciser la PIO et le traitement hypotonisant en cours', rationale:'Glaucome mentionné', category:'examen', confidence:90 });
    }
    if (/baisse.*vision|trouble.*visuel|vision.*floue/i.test(source)) {
      pushUniqueDeduction(deductions, 'La baisse d’acuité visuelle mentionnée nécessite de préciser son installation (brutale ou progressive) et l’acuité mesurée.');
      pushUniqueSuggestion(suggestions, { id:'acuite', label:'Préciser l’acuité visuelle mesurée de loin et de près', rationale:'Trouble visuel rapporté', category:'clinique', confidence:88 });
    }
  }

  // Urology
  if (/urologue|urinaire|prostate|vesical|calcul.*urinaire|hematurie.*uro|infection.*urinaire/i.test(source + spec)) {
    if (/psa/i.test(source)) {
      pushUniqueDeduction(deductions, 'Le PSA mentionné doit être précisé avec sa valeur exacte et son évolution dans le temps.');
      pushUniqueSuggestion(suggestions, { id:'psa-val', label:'Préciser la valeur du PSA total, la date et l’évolution', rationale:'PSA mentionné', category:'examen', confidence:92 });
    }
    if (/hematurie/i.test(source)) {
      pushUniqueDeduction(deductions, 'L’hématurie mentionnée est un signe d’alarme urologique nécessitant une échographie vésico-rénale et un ECBU.');
      pushUniqueSuggestion(suggestions, { id:'echo-uro', label:'Préciser si une échographie vésico-rénale et un ECBU sont disponibles', rationale:'Hématurie rapportée — signe d’alarme', category:'examen', confidence:94 });
    }
    if (/pollakiurie|dysurie|incontinen|brulure.*miction|svb|symptome.*mictionnels/i.test(source)) {
      pushUniqueDeduction(deductions, 'Les symptômes du bas appareil urinaire rapportés justifient un score IPSS et une échographie prostatique si ce n’est fait.');
      pushUniqueSuggestion(suggestions, { id:'ipss', label:'Mentionner le score IPSS ou les symptômes mictionnels quantifiés', rationale:'Symptômes urinaires rapportés', category:'clinique', confidence:83 });
    }
    if (/calcul|lithiase|colique.*nephretique/i.test(source)) {
      pushUniqueDeduction(deductions, 'Le contexte lithiasique mentionné nécessite de préciser la localisation, la taille et les antécédents de calculs précédents.');
      pushUniqueSuggestion(suggestions, { id:'lithiase', label:'Joindre le scanner ou écho urinaire avec mesure du calcul', rationale:'Lithiase urinaire rapportée', category:'examen', confidence:91 });
    }
  }

  // Orthopedics
  if (/orthopedie|orthopedique|chirurgie.*articulaire|prothese|ligament|tendon|fracture|entorse/i.test(source + spec)) {
    if (/irm|radio|radiographie/i.test(source)) {
      pushUniqueDeduction(deductions, 'L’imagerie mentionnée (IRM ou radiographie) est un élément essentiel à joindre ou décrire précisément pour le chirurgien orthopédiste.');
      pushUniqueSuggestion(suggestions, { id:'imagerie-ortho', label:'Joindre ou décrire les résultats d’imagerie disponibles (radio, IRM)', rationale:'Imagerie mentionnée pour bilan orthopédique', category:'examen', confidence:92 });
    }
    if (/prothese|arthroplastie|chirurgie/i.test(source)) {
      pushUniqueDeduction(deductions, 'L’indication chirurgicale potentielle nécessite de préciser les traitements conservateurs déjà essayés et le retentissement fonctionnel.');
      pushUniqueSuggestion(suggestions, { id:'conservateur', label:'Préciser les traitements conservateurs essayés (kiné, infiltrations, AINS)', rationale:'Chirurgie envisagée — évaluation conservatrice préalable', category:'prise_en_charge', confidence:87 });
    }
  }

  // Internal Medicine
  if (/medecine interne|interniste|maladie.*auto-immune|vascularite|sarcoidose|lupus|sjogren/i.test(source + spec)) {
    if (/fievre|febrile/i.test(source) && /prolonge|depuis.*semaine|depuis.*mois/i.test(source)) {
      pushUniqueDeduction(deductions, 'La fièvre prolongée mentionnée oriente vers une cause infectieuse, inflammatoire ou néoplasique nécessitant un bilan exhaustif.');
      pushUniqueSuggestion(suggestions, { id:'fievre-bilan', label:'Mentionner le bilan infectieux et inflammatoire déjà réalisé', rationale:'Fièvre prolongée rapportée', category:'examen', confidence:91 });
    }
    if (/lupus|sjogren|polyarthrite|spondyl|vascularite/i.test(source)) {
      pushUniqueDeduction(deductions, 'La pathologie auto-immune mentionnée nécessite de préciser le bilan immunologique (ANA, ANCA, anti-DNA, FR) et l’atteinte d’organe.');
      pushUniqueSuggestion(suggestions, { id:'immuno-bilan', label:'Joindre le bilan immunologique (ANA, ANCA, etc.) si disponible', rationale:'Pathologie auto-immune rapportée', category:'examen', confidence:88 });
    }
  }

  // Geriatrics
  if (/geriatr|personne agee|sujet age|polymedication|chutes?\b|demence|alzheimer|mmse|mms/i.test(source + spec)) {
    if (/chute|chutes/i.test(source)) {
      pushUniqueDeduction(deductions, 'Les chutes mentionnées nécessitent une évaluation multifactorielle (équilibre, vision, médicaments, environnement).');
      pushUniqueSuggestion(suggestions, { id:'chutes-bilan', label:'Mentionner la fréquence des chutes et les facteurs favorisants identifiés', rationale:'Chutes rapportées en contexte gériatrique', category:'clinique', confidence:88 });
      pushUniqueSuggestion(suggestions, { id:'polymed', label:'Lister l’ensemble des médicaments (iatrogénie, psychotropes, hypotenseurs)', rationale:'Recherche de causes iatrogènes aux chutes', category:'prise_en_charge', confidence:85 });
    }
    if (/demence|alzheimer|mmse|mms|troubles cognitifs|confusion/i.test(source)) {
      pushUniqueDeduction(deductions, 'Les troubles cognitifs mentionnés nécessitent de préciser le score MMSE ou MoCA, l’ancienneté et le retentissement sur l’autonomie.');
      pushUniqueSuggestion(suggestions, { id:'mmse', label:'Mentionner le score MMSE ou MoCA avec date', rationale:'Troubles cognitifs rapportés', category:'clinique', confidence:89 });
    }
    if (/denutrition|poids.*baisse|albumin|malnutrition/i.test(source)) {
      pushUniqueDeduction(deductions, 'La dénutrition ou l’amaigrissement chez le sujet âgé nécessite un bilan nutritionnel avec albumine et score MNA.');
      pushUniqueSuggestion(suggestions, { id:'nutri', label:'Préciser le poids actuel, la perte de poids et l’albumine si disponible', rationale:'Dénutrition mentionnée en contexte gériatrique', category:'clinique', confidence:87 });
    }
  }

  // Anesthesia
  if (/anesthes|preoperatoire|pre-op|bilan.*operatoire|chirurgie.*programm/i.test(source + spec)) {
    pushUniqueDeduction(deductions, 'La consultation pré-anesthésique nécessite de rassembler les antécédents anesthésiques, les allergies connues et le bilan biologique récent.');
    if (/anticoagulant|warfarine|rivaroxaban|apixaban|heparine|syntrom|previscan/i.test(source)) {
      pushUniqueDeduction(deductions, 'L’anticoagulant mentionné nécessite une discussion du protocole de relai périopératoire avec l’anesthésiste.');
      pushUniqueSuggestion(suggestions, { id:'relai-acoa', label:'Préciser l’anticoagulant, l’indication et le protocole de relai prévu', rationale:'Anticoagulant mentionné en contexte chirurgical', category:'prise_en_charge', confidence:95 });
    }
    pushUniqueSuggestion(suggestions, { id:'bilan-preop', label:'Mentionner le bilan biologique pré-opératoire (NFS, coag, iono, ECG)', rationale:'Consultation pré-anesthésique', category:'examen', confidence:88 });
    pushUniqueSuggestion(suggestions, { id:'asa', label:'Préciser le score ASA si connu', rationale:'Stratification du risque anesthésique', category:'clinique', confidence:80 });
  }
}

function ensureMinimumGuidance({ deductions, suggestions, source, body }) {
  if (deductions.length === 0)
    pushUniqueDeduction(deductions, 'Le dossier fourni permet une lettre de liaison structurée ; une synthèse orientée vers la question clinique du spécialiste est recommandée.');
  if (body.motif)
    pushUniqueDeduction(deductions, `L’adressage pour « ${s(body.motif, 120)} » justifie de préciser au confrère les éléments clés du contexte et la question posée.`);
  if (body.specialiste || body.specialty)
    pushUniqueDeduction(deductions, `La demande d’avis ${s(body.specialiste || body.specialty, 80)} appelle une mise en avant des éléments pertinents pour cette spécialité.`);

  const fallback = [
    { id:'retour', label:'Solliciter un retour d’avis après la consultation', rationale:'Facilite le suivi et la coordination des soins', category:'orientation', confidence:90 },
    { id:'antecedents', label:'Mentionner les antécédents pertinents s’ils sont connus', rationale:'Enrichit le dossier sans surinterpretér', category:'clinique', confidence:78 },
    { id:'traitements', label:'Récapituler les traitements en cours et leur tolérance', rationale:'Information utile au spécialiste destinataire', category:'clinique', confidence:82 },
    { id:'allergies', label:'Préciser les allergies connues ou leur absence', rationale:'Sécurité thérapeutique', category:'clinique', confidence:75 },
    { id:'gravite', label:'Signaler l’absence de signe de gravité si applicable', rationale:'Élément rassurant pour le confrère', category:'clinique', confidence:74 }
  ];
  for (const item of fallback) {
    if (suggestions.length >= 3) break;
    pushUniqueSuggestion(suggestions, item);
  }
  return { deductions: deductions.slice(0, 8), suggestions: suggestions.slice(0, 8) };
}

function buildConfidenceMeta(source, body, missing, inconsistencies) {
  const breakdown = [];
  if (source.length >= 40)  breakdown.push({ label:'Notes cliniques renseignées', value:25, kind:'gain' });
  if (source.length >= 200) breakdown.push({ label:'Dossier détaillé', value:10, kind:'gain' });
  if (body.patient || /m\.|mme|monsieur|madame/i.test(source)) breakdown.push({ label:'Identité patient', value:10, kind:'gain' });
  if (body.motif || /motif|adress|avis pour|demande/i.test(source)) breakdown.push({ label:'Motif d’adressage', value:15, kind:'gain' });
  if (/depuis|début|mois|semaine|an(s)?\b|évolution/i.test(source)) breakdown.push({ label:'Chronologie', value:10, kind:'gain' });
  if (hasTreatmentSignals(source)) breakdown.push({ label:'Traitements documentés', value:10, kind:'gain' });
  if (hasClinicalExamSignals(source)) breakdown.push({ label:'Examen, sémiologie ou imagerie', value:10, kind:'gain' });
  if (/\beva\b|\/\s*10|retentissement|impact|sommeil/i.test(source)) breakdown.push({ label:'Retentissement ou intensité douleur', value:5, kind:'gain' });

  const optionalMissing = [];
  missing.forEach(label => {
    if (label === 'allergies') {
      optionalMissing.push(label);
      breakdown.push({ label:'Allergies non précisées (facultatif)', value:-3, kind:'optional' });
    } else if (label === 'examen clinique ou constantes' && hasClinicalExamSignals(source)) {
      optionalMissing.push(label);
      breakdown.push({ label:'Constantes vitales non détaillées (facultatif)', value:-2, kind:'optional' });
    } else if (label === 'examen clinique ou constantes') {
      optionalMissing.push(label);
      breakdown.push({ label:'Examen clinique formel non détaillé', value:-5, kind:'optional' });
    } else if (['chronologie','traitements','motif d’adressage'].includes(label)) {
      breakdown.push({ label:`${label} — à compléter`, value:-10, kind:'important' });
    } else {
      optionalMissing.push(label);
      breakdown.push({ label:`${label} (recommandé)`, value:-4, kind:'optional' });
    }
  });
  inconsistencies.forEach(() => breakdown.push({ label:'Incohérence à vérifier', value:-15, kind:'critical' }));

  let confidence = breakdown.reduce((sum, item) => sum + item.value, 0);
  confidence = Math.max(30, Math.min(98, confidence));

  const importantGaps = missing.filter(m => ['chronologie','traitements',"motif d’adressage",'identité ou repère patient'].includes(m));
  let scoreSummary, confidenceLabel;
  if (inconsistencies.length) {
    scoreSummary = `${inconsistencies.length} incohérence(s) à vérifier avant envoi.`;
    confidenceLabel = 'À vérifier';
  } else if (importantGaps.length) {
    scoreSummary = `Informations importantes manquantes : ${importantGaps.join(', ')}.`;
    confidenceLabel = 'À compléter';
  } else if (optionalMissing.length) {
    scoreSummary = `Dossier solide — ${optionalMissing.length} précision(s) facultative(s) pour enrichir le courrier (${optionalMissing.join(', ')}).`;
    confidenceLabel = confidence >= 80 ? 'Prêt à générer' : 'Bon dossier';
  } else {
    scoreSummary = 'Dossier complet : vous pouvez générer la lettre en confiance.';
    confidenceLabel = 'Prêt à générer';
  }
  return { confidence, confidenceBreakdown: breakdown, scoreSummary, confidenceLabel, optionalMissing };
}

function clinicalAnalysis(body = {}) {
  const source = plainClinicalText(body);
  const profile = specialtyProfile(body.specialiste || body.specialty || '');
  const missing = [];
  const questions = [];
  const inconsistencies = [];
  const deductions = [];
  const suggestions = [];

  const checks = [
    ['chronologie', [/depuis|début|evolution|évolution|jour|semaine|mois|an(s)?\b/i], 'Depuis quand et avec quelle évolution ?'],
    ['traitements', [/traitement|thérapie|therapie|médicament|medicament|sous\s|mg\b|comprim|paracétamol|ibuprofène|tramadol|kinésithérapie|kiné\b/i], 'Quels sont les traitements actuels et leur tolérance ?'],
    ['allergies', [/allerg/i], 'Des allergies médicamenteuses sont-elles connues ?'],
    ['examen clinique ou constantes', [/examen|tension|\bpa\b|\bfc\b|spo2|saturation|poids|taille|imc|auscult|déficit|sphincter|\beva\b|irm|scanner|échographie|imagerie/i], 'Quels éléments d’examen, de sémiologie ou d’imagerie sont disponibles ?']
  ];
  checks.forEach(([label, patterns, question]) => {
    if (!hasAny(source, patterns)) { missing.push(label); questions.push(question); }
  });
  if (!body.patient && !/patient|monsieur|madame|\bm\.|mme/i.test(source)) missing.push('identité ou repère patient');
  if (!body.motif && !/motif|adress|avis|pour\s/i.test(source) && body.documentType === 'liaison') {
    missing.push('motif d’adressage'); questions.push('Quelle est la question clinique précise posée au spécialiste ?');
  }

  // Safety inconsistency checks
  if (/femme|enceinte|grossesse/i.test(source) && /hypertrophie\s+prostat|ad[ée]nome\s+prostat/i.test(source))
    inconsistencies.push('Sexe/contexte de grossesse incompatible avec une pathologie prostatique rapportée.');
  if (/allerg[^\n.]*p[ée]nicill|allerg[^\n.]*amoxicill/i.test(source) && /amoxicilline/i.test(source))
    inconsistencies.push('Amoxicilline mentionnée malgré une allergie rapportée aux pénicillines : vérifier avant prescription.');
  if (/enceinte|grossesse/i.test(source) && /isotr[ée]tino[ï]ne|valproate/i.test(source))
    inconsistencies.push('Traitement potentiellement incompatible avec une grossesse rapportée : vérification urgente requise.');
  if (/anticoagul|apixaban|rivaroxaban|warfarine|fluindione/i.test(source) && /ibuprofène|k[ée]toprof[èe]ne|naprox[èe]ne|ains\b/i.test(source))
    inconsistencies.push('Association anticoagulant/AINS rapportée : risque hémorragique à vérifier.');
  const age = Number((String(body.age || '').match(/\d{1,3}/) || [])[0]);
  const infarctAge = Number((source.match(/infarctus[^\n.]*?(?:à|a)\s*(\d{1,3})\s*ans/i) || [])[1]);
  if (infarctAge && infarctAge < 15) inconsistencies.push(`Antécédent d’infarctus à ${infarctAge} ans : vérifier l’âge et la formulation.`);
  if (age && (age < 0 || age > 115)) inconsistencies.push('Âge impossible ou très improbable.');
  const dates = [...source.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)];
  dates.forEach(m => { if (+m[1] > 31 || +m[2] > 12) inconsistencies.push(`Date impossible détectée : ${m[0]}.`); });

  // Specialty-specific analysis
  analyzeBySpecialty(source, body, deductions, suggestions);

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

  const guided = ensureMinimumGuidance({ deductions, suggestions, source, body });
  deductions.length = 0; deductions.push(...guided.deductions);
  suggestions.length = 0; suggestions.push(...guided.suggestions);

  const complexity = source.length > 1800 || inconsistencies.length > 0 || suggestions.length >= 4 ? 'detaille'
    : source.length < 450 && suggestions.length < 3 ? 'express' : 'standard';
  const { confidence, confidenceBreakdown, scoreSummary, confidenceLabel, optionalMissing } =
    buildConfidenceMeta(source, body, [...new Set(missing)], inconsistencies);

  const facts = source.split(/\n|(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length > 2).slice(0, 12);
  return {
    facts, deductions: deductions.slice(0, 8), suggestions: suggestions.slice(0, 8),
    missing: [...new Set(missing)], optionalMissing,
    questions: filteredQuestions.slice(0, 7), inconsistencies: [...new Set(inconsistencies)],
    confidence, confidenceBreakdown, scoreSummary, confidenceLabel,
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
