require('dotenv').config();

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const Anthropic  = require('@anthropic-ai/sdk');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'praxi-admin-dev';

// ── AUTH (JWT) ──
const JWT_SECRET     = process.env.JWT_SECRET || 'praxi-dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

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

// ── MIDDLEWARE ──
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit (mémoire)
const rlMap = new Map();
function rateLimit(ip, max = 3) {
  const now = Date.now();
  const win = 60 * 60 * 1000;
  const r   = rlMap.get(ip) || { n: 0, reset: now + win };
  if (now > r.reset) { r.n = 0; r.reset = now + win; }
  r.n++;
  rlMap.set(ip, r);
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

  if (!rateLimit(ip)) {
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
  console.log('[auth] register :', s(req.body.email, 200).toLowerCase());
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
  console.log('[auth] login :', s(req.body.email, 200).toLowerCase());
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
    "Enrichis la lettre avec tes connaissances cliniques : évoque les éléments sémiologiques " +
    "pertinents pour la spécialité du destinataire, les comorbidités à signaler, les traitements " +
    "en cours et leur tolérance, les examens déjà réalisés et leurs résultats. " +
    "N'invente aucune information absente des notes — mais valorise et structure ce qui est fourni " +
    "avec la précision d'un médecin expérimenté. " +
    "RÈGLE ABSOLUE SUR LE NOM DU PATIENT : utilise toujours le prénom et/ou nom exact fourni. " +
    "N'écris JAMAIS 'Monsieur' ou 'Madame' seul sans faire suivre immédiatement du nom complet. " +
    "N'écris JAMAIS 'le patient' ou 'la patiente' dans la lettre — remplace systématiquement " +
    "par le nom réel. " +
    enteteConsigne(req.user) +
    "FORMAT : prose fluide en paragraphes continus. N'utilise JAMAIS de Markdown : pas " +
    "d'astérisques (* ou **), pas de dièses (#), pas de tirets de liste, pas de puces. " +
    "Les titres (OBJET, etc.) s'écrivent en majuscules sans aucun caractère de formatage. " +
    "Sections séparées par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets comme [date] ou [nom]. " +
    "Si une information est absente, omets simplement la section — n'écris JAMAIS " +
    "'Non renseigné', 'Non précisé', 'À compléter' ou équivalent. " +
    "N'ajoute aucun commentaire hors de la lettre.";

  const user =
    (specialiste ? `Spécialiste destinataire : ${specialiste}\n` : '') +
    (patient ? `Patient : ${patient}${age ? `, ${age}` : ''}\n` : '') +
    (motif ? `Motif d'adressage : ${motif}\n` : '') +
    `\nNotes cliniques du médecin :\n${notes || '(aucune)'}\n` +
    (complement ? `\nÉléments additionnels à intégrer : ${complement}\n` : '');

  try {
    const document = await generateDocument({ system, user, maxTokens: 1500 });
    res.json({ document });
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
       "N'écris JAMAIS 'Non renseigné', 'Non précisé' ou équivalent. " +
       "FORMAT : n'utilise JAMAIS de Markdown (pas d'astérisques, pas de dièses). " +
       "Sections séparées par des sauts de ligne. N'ajoute aucun commentaire hors du compte-rendu.")
    : (`Tu es un médecin expert en ${specialiteRedacteurCR}, exerçant en libéral en France. ` +
       "À partir de notes brutes de consultation, rédige un compte-rendu structuré et cliniquement " +
       "enrichi, comme tu le ferais dans ta pratique. Mobilise tes connaissances de spécialité pour " +
       "compléter le raisonnement clinique : précise les hypothèses diagnostiques pertinentes, les " +
       "éléments d'examen attendus pour cette présentation, les recommandations HAS applicables, " +
       "et une conduite à tenir adaptée à la spécialité et au contexte. " +
       "N'invente aucune donnée absente — enrichis et structure ce qui est fourni. " +
       enteteConsigne(req.user) +
       "Organise le compte-rendu avec exactement ces sections dans cet ordre, chaque titre en " +
       "MAJUSCULES suivi de deux-points : " +
       "MOTIF DE CONSULTATION :, " +
       "EXAMEN CLINIQUE ET CONSTANTES : (inclure les constantes si mentionnées : PA, FC, SpO2, poids, taille, IMC), " +
       "DIAGNOSTIC / IMPRESSION CLINIQUE :, " +
       "OBJECTIFS THÉRAPEUTIQUES :, " +
       "CONDUITE À TENIR : (traitements avec posologie complète si pertinent, examens complémentaires, orientations), " +
       "SURVEILLANCE :, " +
       "ÉDUCATION THÉRAPEUTIQUE / CONSEILS : (si applicable). " +
       "Omets entièrement toute section pour laquelle aucune information n'est disponible — " +
       "n'écris ni le titre ni le contenu, et n'écris JAMAIS 'Non renseigné', 'Non précisé' ou équivalent. " +
       "Sous chaque titre, écris en prose (phrases continues), jamais sous forme de liste à puces. " +
       "FORMAT : n'utilise JAMAIS de Markdown : pas d'astérisques, pas de dièses, pas de tirets de liste. " +
       "Sépare les sections par des sauts de ligne. N'ajoute aucun commentaire hors du compte-rendu.");

  const user =
    (patient ? `Patient : ${patient}\n` : '') +
    (date ? `Date de consultation : ${date}\n` : '') +
    `\nNotes brutes de consultation :\n${notes}\n` +
    (complement ? `\nÉléments additionnels à intégrer : ${complement}\n` : '');

  try {
    const document = await generateDocument({ system, user, maxTokens: 1800 });
    res.json({ document });
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
    "Analyse le document médical fourni et produis exactement trois sections dans cet ordre, " +
    "chaque titre en MAJUSCULES suivi de deux-points : RÉSUMÉ :, POINTS CLÉS :, ACTIONS SUGGÉRÉES :. " +
    "Sous RÉSUMÉ : 3 à 5 phrases en prose synthétisant les éléments essentiels du document. " +
    "Sous POINTS CLÉS : chaque point sur sa propre ligne, en texte simple, sans tiret ni puce, " +
    "en mettant en avant ce qui est cliniquement significatif pour ta spécialité. " +
    "Sous ACTIONS SUGGÉRÉES : enrichis avec tes connaissances cliniques — propose des actions " +
    "concrètes et adaptées au contexte (suivi biologique, orientation spécialisée, ajustement " +
    "thérapeutique, éducation patient, etc.), une action par ligne, en texte simple. " +
    "N'invente aucune donnée absente du document ; les actions suggérées sont des propositions " +
    "cliniques fondées sur les données fournies et les recommandations en vigueur. " +
    medecinContext(req.user) +
    "FORMAT : n'utilise JAMAIS de Markdown : pas d'astérisques (* ou **), pas de dièses (#), " +
    "pas de tirets de liste. Sépare les sections par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets. " +
    "Si une section est vide, omets-la entièrement — n'écris JAMAIS 'Non renseigné' ou équivalent.";

  const user = `Document médical à analyser :\n\n${document}\n` +
    (complement ? `\nÉléments additionnels à intégrer / actions retenues par le médecin : ${complement}\n` : '');

  try {
    const result = await generateDocument({ system, user, maxTokens: 1500 });
    res.json({ document: result });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/auth/forgot-password — génère un token de réinitialisation et l'envoie par email
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = s(req.body.email, 200).toLowerCase();
  console.log('[auth] forgot-password :', email);

  const user = readUsers().users.find(u => u.email === email);
  if (user) {
    // Token sans état : aucune écriture sur disque (robuste au stockage éphémère).
    const token = makeResetToken(user);
    try {
      await sendPasswordResetEmail(email, user.prenom, token);
      console.log('[auth] email de réinitialisation envoyé à', email);
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

  console.log('[auth] mot de passe réinitialisé pour', user.email);
  res.json({ ok: true });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ──
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
