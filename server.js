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
// L'avis spécialisé combine raisonnement diagnostique et lecture de photos :
// il tourne sur un modèle plus capable que les générateurs de documents.
const AI_MODEL_AVIS = 'claude-opus-5';

// ── RAG (base de connaissances médicale) ──
const { ragSearch, ragStats, DEFAULT_WEIGHTS, DEFAULT_MAX_PER_DOC } = require('./lib/rag');
const { getSpecialite, listSpecialites } = require('./lib/specialites');

// ── DOSSIERS PATIENTS (fiches + timeline de documents) ──
const dossiers = require('./lib/dossiers');

// ── RÉFÉRENTIELS DOCUMENTAIRES PAR SPÉCIALITÉ ──
// Fournit au prompt la structure attendue et les repères chiffrés de la
// spécialité, plutôt que de laisser le modèle les reconstituer de mémoire.
const {
  getReferentiel, analyserCouverture, blocPrompt,
  referentielPublic, listReferentiels,
} = require('./lib/referentiels');

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

// Le plafond reste à 2 Mo partout, sauf sur l'avis spécialisé qui transporte des
// photos en base64. Le front redimensionne déjà côté navigateur (1568 px max,
// 4 photos) : 20 Mo est une marge, pas une cible.
const jsonStandard = express.json({ limit: '2mb' });
const jsonAvecPhotos = express.json({ limit: '20mb' });
app.use((req, res, next) => {
  const parser = req.path.startsWith('/api/avis-specialise') ? jsonAvecPhotos : jsonStandard;
  parser(req, res, next);
});

// body-parser renvoie du HTML sur dépassement : on rend une erreur JSON lisible
// par le front, qui n'attend que du JSON.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'Fichiers trop volumineux. Réduisez le nombre ou la taille des photos.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Requête mal formée.' });
  }
  next(err);
});

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

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — INGESTION DE LA BASE DE CONNAISSANCES
// ═══════════════════════════════════════════════════════════════════════════════
// Route permanente : sert à ré-ingérer une spécialité (mise à jour du corpus)
// comme à en indexer une nouvelle après ajout dans lib/specialites.js.
//
// L'ingestion complète dure une dizaine de minutes, bien au-delà du délai d'un
// proxy HTTP : le travail est donc lancé en arrière-plan et la route rend
// immédiatement un identifiant de job, consultable via GET /admin/ingest/:id.
//
// Le serveur relit son index depuis le disque dès que celui-ci change (contrôle
// de mtime dans lib/rag/store.js) : une ingestion terminée est prise en compte
// sans redémarrage.

const { runIngestion, sourcesDisponibles } = require('./lib/ingest');

const JOBS_MAX = 20;                 // historique borné : la carte vit en mémoire
const ingestJobs = new Map();

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }
  next();
}

function jobPublic(job) {
  return {
    id: job.id,
    specialite: job.specialite,
    sources: job.sources,
    statut: job.statut,
    demarreA: job.demarreA,
    termineA: job.termineA || null,
    dureeMs: job.termineA ? Date.parse(job.termineA) - Date.parse(job.demarreA) : Date.now() - Date.parse(job.demarreA),
    etape: job.etape,
    rapport: job.rapport || null,
    erreur: job.erreur || null,
  };
}

// POST /admin/ingest?specialite=X[&sources=a,b][&limit=N][&reset=1][&dryRun=1]
app.post(['/admin/ingest', '/api/admin/ingest'], requireAdmin, (req, res) => {
  // Les paramètres sont acceptés en query string (comme demandé) ou dans le
  // corps JSON, pour rester utilisable depuis un client qui préfère un body.
  const source = Object.assign({}, req.body, req.query);

  const specialite = String(source.specialite || '').trim();
  if (!specialite) {
    return res.status(400).json({
      error: 'Paramètre « specialite » requis.',
      disponibles: listSpecialites().map(s => s.key),
    });
  }

  const specialiteEntry = getSpecialite(specialite);
  if (!specialiteEntry) {
    return res.status(404).json({
      error: `Spécialité inconnue ou inactive : ${specialite}`,
      disponibles: listSpecialites().map(s => s.key),
    });
  }

  const sources = source.sources
    ? String(source.sources).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const inconnues = (sources || []).filter(id => !sourcesDisponibles(specialiteEntry).includes(id));
  if (inconnues.length) {
    return res.status(400).json({
      error: `Source(s) non disponible(s) pour ${specialiteEntry.label} : ${inconnues.join(', ')}`,
      disponibles: sourcesDisponibles(specialiteEntry),
    });
  }

  const limit = source.limit ? parseInt(source.limit, 10) : null;
  if (source.limit && (!Number.isFinite(limit) || limit < 1)) {
    return res.status(400).json({ error: 'Paramètre « limit » invalide.' });
  }
  const vrai = v => v === true || v === '1' || v === 'true';

  const job = {
    id: crypto.randomUUID(),
    specialite: specialiteEntry.key,
    sources: sources || sourcesDisponibles(specialiteEntry),
    statut: 'en-cours',
    demarreA: new Date().toISOString(),
    termineA: null,
    etape: 'démarrage',
    rapport: null,
    erreur: null,
  };

  // Le verrou de lib/ingest.js est pris à l'intérieur de runIngestion, donc de
  // façon asynchrone : on refuse tout de suite si un job de cette spécialité est
  // déjà actif dans ce processus, pour rendre un 409 franc plutôt qu'un job qui
  // échouerait une seconde plus tard.
  const dejaActif = [...ingestJobs.values()].find(j => j.statut === 'en-cours' && j.specialite === job.specialite);
  if (dejaActif) {
    return res.status(409).json({
      error: `Une ingestion est déjà en cours sur « ${job.specialite} ».`,
      job: jobPublic(dejaActif),
    });
  }

  ingestJobs.set(job.id, job);
  while (ingestJobs.size > JOBS_MAX) ingestJobs.delete(ingestJobs.keys().next().value);

  // Lancement en arrière-plan : la réponse part sans attendre.
  runIngestion({
    specialite: specialiteEntry.key,
    sources,
    limit,
    reset: vrai(source.reset),
    dryRun: vrai(source.dryRun),
    onEvent: event => {
      if (event.type === 'source-start') job.etape = `source ${event.source}`;
      else if (event.type === 'source-done') job.etape = `source ${event.source} terminée`;
      else if (event.type === 'source-error') job.etape = `source ${event.source} en échec`;
    },
  })
    .then(rapport => {
      job.rapport = rapport;
      job.statut = rapport.echecs.length ? 'termine-avec-erreurs' : 'termine';
      job.etape = 'terminé';
      console.log(`[ingest] ${job.specialite} — ${rapport.documents} documents, ${rapport.chunks} passages en ${Math.round(rapport.ms / 1000)} s`
        + (rapport.echecs.length ? ` — échecs : ${rapport.echecs.join(', ')}` : ''));
    })
    .catch(err => {
      job.statut = err.code === 'VERROU_OCCUPE' ? 'refuse' : 'echec';
      job.erreur = err.message;
      job.etape = 'échec';
      console.error(`[ingest] ${job.specialite} — ${err.message}`);
    })
    .finally(() => { job.termineA = new Date().toISOString(); });

  res.status(202).json({
    ok: true,
    message: 'Ingestion lancée en arrière-plan. Suivez son avancement sur GET /admin/ingest/:id.',
    job: jobPublic(job),
    suivi: `/admin/ingest/${job.id}`,
  });
});

// GET /admin/ingest/:id — avancement d'un job
app.get(['/admin/ingest/:id', '/api/admin/ingest/:id'], requireAdmin, (req, res) => {
  const job = ingestJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job inconnu ou expiré.' });
  res.json({ job: jobPublic(job) });
});

// POST /admin/rag/search — inspection de la recherche, sans appel au modèle.
// Répond à « pourquoi cette source remonte-t-elle sur ce cas ? » et permet de
// régler les poids de la fusion hybride sur des cas réels, contre l'index de
// production, sans consommer d'appel Opus ni redéployer entre deux essais.
app.post(['/admin/rag/search', '/api/admin/rag/search'], requireAdmin, async (req, res) => {
  const params = Object.assign({}, req.body, req.query);

  const specialite = getSpecialite(params.specialite);
  if (!specialite) {
    return res.status(404).json({
      error: `Spécialité inconnue ou inactive : ${params.specialite}`,
      disponibles: listSpecialites().map(s => s.key),
    });
  }

  const query = txt(params.query || params.cas, 4000);
  if (!query) return res.status(400).json({ error: 'Paramètre « query » requis.' });

  const nombre = v => (v == null || v === '' ? null : Number(v));
  const poidsVectoriel = nombre(params.poidsVectoriel);
  const poidsLexical   = nombre(params.poidsLexical);
  for (const [nom, valeur] of [['poidsVectoriel', poidsVectoriel], ['poidsLexical', poidsLexical]]) {
    if (valeur !== null && (!Number.isFinite(valeur) || valeur < 0)) {
      return res.status(400).json({ error: `Paramètre « ${nom} » invalide.` });
    }
  }
  const topK = nombre(params.topK) || 8;

  // Nombre maximal de passages retenus par document source. Exposé ici parce
  // qu'il pèse plus lourd qu'il n'y paraît : un document découpé en plusieurs
  // passages peut occuper autant de rangs, et évincer des sources pertinentes.
  const maxPerDoc = nombre(params.maxPerDoc);
  if (maxPerDoc !== null && (!Number.isInteger(maxPerDoc) || maxPerDoc < 1)) {
    return res.status(400).json({ error: 'Paramètre « maxPerDoc » invalide (entier ≥ 1).' });
  }

  try {
    const recherche = await ragSearch({
      collection: specialite.collection,
      query,
      topK: Math.min(Math.max(topK, 1), 30),
      weights: { vector: poidsVectoriel, lexical: poidsLexical },
      maxPerDoc: maxPerDoc == null ? undefined : maxPerDoc,
    });
    res.json({
      mode: recherche.mode,
      corpus: recherche.stats ? recherche.stats.count : 0,
      poids: {
        vectoriel: poidsVectoriel == null ? DEFAULT_WEIGHTS.vector : poidsVectoriel,
        lexical:   poidsLexical   == null ? DEFAULT_WEIGHTS.lexical : poidsLexical,
      },
      maxPerDoc: maxPerDoc == null ? DEFAULT_MAX_PER_DOC : maxPerDoc,
      // `parts` indique le rang obtenu par chaque moteur : c'est ce qui montre
      // lequel des deux a fait remonter un passage donné.
      passages: recherche.passages.map(p => ({
        titre: p.meta.title,
        source: p.meta.sourceLabel || p.meta.source,
        url: p.meta.url,
        score: Number(p.score.toFixed(5)),
        rangs: p.parts,
        extrait: p.text.slice(0, 180),
      })),
    });
  } catch (err) {
    console.error('[rag/search]', err.message);
    res.status(500).json({ error: 'Recherche impossible.' });
  }
});

// GET /admin/ingest — jobs récents et état des index
app.get(['/admin/ingest', '/api/admin/ingest'], requireAdmin, (_req, res) => {
  res.json({
    jobs: [...ingestJobs.values()].map(jobPublic).reverse(),
    specialites: listSpecialites().map(s => {
      const stats = ragStats(s.key);
      return {
        key: s.key,
        label: s.label,
        sources: sourcesDisponibles(getSpecialite(s.key)),
        index: stats && {
          passages: stats.count,
          vectoriel: stats.hasVectors,
          modele: stats.model,
          majLe: stats.updatedAt,
        },
      };
    }),
  });
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

// ─── CONTEXTE PATIENT ANTÉRIEUR ─────────────────────────────────────────────
// Un document généré pour un patient déjà suivi doit savoir ce qui a été écrit
// et prescrit avant. Le médecin garde la main : `utiliserContexte: false` dans
// le corps de requête désactive entièrement la reprise.

function chargerContextePatient(req) {
  const patientId = s(req.body.patientId, 40);
  if (!patientId) return null;
  if (req.body.utiliserContexte === false) return null;
  try {
    const ctx = dossiers.contextePatient(req.user.id, patientId);
    return ctx && !ctx.vide ? ctx : null;
  } catch (err) {
    // Un contexte indisponible ne doit jamais empêcher une génération :
    // le document se fait sans, et le front l'indique.
    console.error('[contexte] lecture impossible —', err.message);
    return null;
  }
}

// Consignes d'usage du contexte antérieur. Sans ces garde-fous, le modèle
// recopie un traitement ancien comme s'il était en cours.
function consigneContexte(contexte) {
  if (!contexte) return '';
  return (
    `\nCONTEXTE ANTÉRIEUR DU PATIENT :\n` +
    `La fiche du patient et ses documents précédents te sont fournis, chacun daté et référencé [A1], [A2]…\n` +
    `RÈGLES D'USAGE :\n` +
    `- Ce contexte sert à éviter les redites et à assurer la continuité (« traitement introduit le 12 mars, bien toléré »).\n` +
    `- Ne présente JAMAIS un élément antérieur comme constaté aujourd'hui. Date-le explicitement quand tu le reprends.\n` +
    `- Un traitement prescrit antérieurement n'est pas forcément en cours : écris « introduit le … » et non « prend actuellement », sauf si les notes du jour le confirment.\n` +
    `- Les allergies connues de la fiche patient sont toujours à reprendre : elles engagent la sécurité de la prescription.\n` +
    `- N'utilise ce contexte que s'il éclaire la consultation du jour. Un antécédent sans rapport n'a pas à figurer.\n`
  );
}

// Métadonnées renvoyées au front : sur quoi cette génération s'est appuyée.
// C'est ce qui rend la provenance vérifiable côté interface.
function contexteMeta(contexte) {
  if (!contexte) return { utilise: false, documents: [] };
  return {
    utilise: true,
    patient: { id: contexte.patient.id, nom: contexte.patient.nom, age: contexte.patient.age },
    documents: contexte.documents,
  };
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
  const authorVoice = authorVoiceConstraint(specialiteRedacteur, specialiste);

  // Contexte antérieur : une lettre d'adressage qui ignore les documents
  // précédents du même patient refait dire au confrère ce qu'il sait déjà.
  const contexteL = chargerContextePatient(req);

  // Référentiel du DESTINATAIRE : la lettre est lue par lui, c'est sa grille de
  // lecture qui compte. À défaut, celui du rédacteur.
  const referentielL = getReferentiel(specialiste) || getReferentiel(specialiteRedacteur);
  const couvertureL  = analyserCouverture(referentielL, `${motif}\n${notes}\n${complement}`);
  const system =
    `Tu es un médecin expert en ${specialiteRedacteur}, exerçant en libéral en France. ` +
    authorVoice +
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

  // Le référentiel du destinataire ne dicte pas la structure de la lettre (qui
  // reste une prose confraternelle) : il indique ce que ce confrère attend de
  // trouver. On ne reprend donc que les repères, pas le plan de document.
  const systemL = system
    + (referentielL
        ? `\nATTENTES DU DESTINATAIRE (${referentielL.label}, source : ${referentielL.source.libelle}) :\n`
          + `Éléments que ce confrère attend d'une lettre d'adressage : `
          + `${referentielL.attendus.map(a => a.libelle).join(' ; ')}.\n`
          + `Ne présente que ceux qui figurent réellement dans les notes. `
          + `N'invente jamais une valeur pour compléter cette liste : une lettre incomplète mais exacte `
          + `vaut infiniment mieux qu'une lettre complète et fausse.\n`
        : '')
    + consigneContexte(contexteL);

  const user =
    (specialiste ? `Spécialiste destinataire : ${specialiste}\n` : '') +
    (patient ? `Patient : ${patient}${age ? `, ${age}` : ''}\n` : '') +
    (motif ? `Motif d'adressage : ${motif}\n` : '') +
    (contexteL ? `\n${contexteL.texte}\n` : '') +
    `\nNotes cliniques du médecin :\n${notes || '(aucune)'}\n` +
    (complement ? `\nÉléments additionnels à intégrer : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system: systemL, user, maxTokens: 1500 }));
    res.json({
      document,
      safety: documentSafety(document, `${plainClinicalText(req.body)}\n${contexteL ? contexteL.texte : ''}`, req.user),
      referentiel: referentielPublic(referentielL, couvertureL),
      contexte: contexteMeta(contexteL),
    });
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

  // Contexte antérieur du patient : ce compte-rendu sait ce qui a été prescrit
  // la semaine dernière. Le médecin peut le désactiver (utiliserContexte:false).
  const contexte = chargerContextePatient(req);

  // Référentiel de la spécialité : structure attendue + repères chiffrés
  // fournis au prompt, et calcul de ce que les notes ne couvrent pas.
  const referentiel = getReferentiel(specialiteRedacteurCR);
  const couverture  = analyserCouverture(referentiel, `${notes}\n${complement}`);

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

  // Le référentiel s'ajoute au cadrage de spécialité ; l'algologie garde sa
  // structure propre, déjà dérivée des recommandations HAS 2024.
  const systemComplet = system
    + (isAlgologie ? '' : blocPrompt(referentiel, couverture))
    + consigneContexte(contexte);

  const user =
    (patient ? `Patient : ${patient}\n` : '') +
    (date ? `Date de consultation : ${date}\n` : '') +
    (contexte ? `\n${contexte.texte}\n` : '') +
    `\nNotes brutes de consultation :\n${notes}\n` +
    (complement ? `\nÉléments additionnels à intégrer : ${complement}\n` : '');

  try {
    const document = finalizeDocument(await generateDocument({ system: systemComplet, user, maxTokens: 1800 }));
    res.json({
      document,
      // Le contrôle des valeurs chiffrées inclut le contexte antérieur : une
      // posologie reprise d'une ordonnance passée est sourcée, pas inventée.
      safety: documentSafety(document, `${plainClinicalText(req.body)}\n${contexte ? contexte.texte : ''}`, req.user),
      referentiel: referentielPublic(referentiel, couverture),
      contexte: contexteMeta(contexte),
    });
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

  // Sur une ordonnance, le contexte du dossier n'est pas un confort de
  // rédaction : allergies connues et traitements en cours conditionnent la
  // sécurité de la prescription.
  const contexteO = chargerContextePatient(req);
  const consigneSecuriteO = contexteO
    ? `\nSÉCURITÉ DE LA PRESCRIPTION :\n` +
      `La fiche du patient et ses documents antérieurs te sont fournis.\n` +
      `- Si une molécule prescrite entre en conflit avec une ALLERGIE mentionnée dans la fiche, ` +
      `ne la retire pas silencieusement et ne la remplace pas de ta propre initiative : ` +
      `rédige l'ordonnance telle que demandée et signale le conflit en fin de document, ` +
      `sur une ligne isolée préfixée « ⚠ À VÉRIFIER : ». Le choix appartient au médecin.\n` +
      `- Ne reconduis JAMAIS de toi-même un traitement antérieur qui ne figure pas dans la demande du jour.\n` +
      `- N'ajoute aucun médicament que le médecin n'a pas explicitement prescrit.\n`
    : '';

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
      (contexteO ? `\n${contexteO.texte}\n` : '') +
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
      (contexteO ? `\n${contexteO.texte}\n` : '') +
      `\nMédicaments à prescrire :\n${medicaments}\n` +
      (complement ? `\nÉléments additionnels : ${complement}\n` : '');
  }

  try {
    const document = finalizeDocument(await generateDocument({
      system: system + consigneSecuriteO + consigneContexte(contexteO),
      user: userMsg, maxTokens: 1800,
    }));
    res.json({
      document,
      safety: documentSafety(document, `${plainClinicalText(req.body)}\n${contexteO ? contexteO.texte : ''}`, req.user),
      contexte: contexteMeta(contexteO),
    });
  } catch (err) { aiError(res, err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AVIS SPÉCIALISÉ — cas clinique + photos, enrichi par la base de connaissances
// ═══════════════════════════════════════════════════════════════════════════════
// Ce module ne « joue » pas un spécialiste : la réponse est ancrée sur des
// passages réellement extraits d'une base indexée (littérature, recommandations
// de sociétés savantes, référentiel médicament officiel). Les passages retenus
// sont renvoyés au front pour que le médecin puisse remonter à la source.

const MEDIA_TYPES_PHOTO = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 4_500_000;   // limite API par image, marge comprise
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Valide et convertit les photos reçues en blocs d'image pour l'API.
 * Accepte une data URL (« data:image/jpeg;base64,… ») ou { mediaType, data }.
 * @returns {{blocks:object[], erreur:string|null}}
 */
function parsePhotos(raw) {
  if (!raw) return { blocks: [], erreur: null };
  if (!Array.isArray(raw)) return { blocks: [], erreur: 'Format de photos invalide.' };
  if (raw.length > MAX_PHOTOS) {
    return { blocks: [], erreur: `${MAX_PHOTOS} photos au maximum.` };
  }

  const blocks = [];
  for (const photo of raw) {
    let mediaType = '';
    let data = '';

    if (typeof photo === 'string') {
      const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(photo.trim());
      if (!match) return { blocks: [], erreur: 'Photo illisible (data URL attendue).' };
      mediaType = match[1].toLowerCase();
      data = match[2];
    } else if (photo && typeof photo === 'object') {
      mediaType = String(photo.mediaType || photo.media_type || '').toLowerCase();
      data = String(photo.data || '');
      const inline = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(data.trim());
      if (inline) { mediaType = mediaType || inline[1].toLowerCase(); data = inline[2]; }
    } else {
      return { blocks: [], erreur: 'Photo illisible.' };
    }

    data = data.replace(/\s+/g, '');
    if (!MEDIA_TYPES_PHOTO.includes(mediaType)) {
      return { blocks: [], erreur: 'Formats acceptés : JPEG, PNG, WebP, GIF.' };
    }
    if (!data || !BASE64_RE.test(data)) {
      return { blocks: [], erreur: 'Photo corrompue ou mal encodée.' };
    }
    // Taille décodée approchée — évite de décoder le buffer pour rien.
    if (Math.floor(data.length * 3 / 4) > MAX_PHOTO_BYTES) {
      return { blocks: [], erreur: 'Photo trop lourde (5 Mo maximum par image).' };
    }

    blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  return { blocks, erreur: null };
}

/** Mise en forme des passages retenus pour injection dans le prompt. */
function formatPassages(passages) {
  return passages.map((p, i) => {
    const meta = p.meta || {};
    const entete = [
      `[${i + 1}]`,
      meta.title || 'Sans titre',
      meta.sourceLabel ? `— ${meta.sourceLabel}` : '',
      meta.year ? `(${meta.year})` : '',
      meta.journal ? `— ${meta.journal}` : '',
    ].filter(Boolean).join(' ');
    return `${entete}\n${p.text}`;
  }).join('\n\n———\n\n');
}

/** Références compactes renvoyées au front, sans le texte intégral. */
function formatReferences(passages) {
  const vues = new Set();
  const references = [];
  for (const p of passages) {
    const meta = p.meta || {};
    const cle = meta.docId || p.id;
    if (vues.has(cle)) continue;
    vues.add(cle);
    references.push({
      n: references.length + 1,
      titre: meta.title || 'Sans titre',
      source: meta.sourceLabel || meta.source || '',
      url: meta.url || '',
      annee: meta.year || '',
    });
  }
  return references;
}

/** Appel multimodal : photos d'abord, puis le texte. */
async function generateAvisMultimodal({ system, blocks, maxTokens = 6000 }) {
  if (!anthropic) {
    const err = new Error('Clé API non configurée sur le serveur (ANTHROPIC_API_KEY).');
    err.status = 503;
    throw err;
  }
  const msg = await anthropic.messages.create({
    model: AI_MODEL_AVIS,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: blocks }],
  });
  const texte = (msg.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  if (!texte) throw new Error('Réponse vide du modèle.');
  return texte;
}

// GET /api/avis-specialise/specialites — alimente le menu déroulant du front.
app.get('/api/avis-specialise/specialites', authenticateJWT, (_req, res) => {
  const specialites = listSpecialites().map(s => {
    const stats = ragStats(s.key);
    return Object.assign({}, s, {
      baseIndexee: Boolean(stats),
      passages: stats ? stats.count : 0,
      recherche: stats ? (stats.hasVectors ? 'hybride' : 'lexicale') : 'indisponible',
    });
  });
  res.json({ specialites });
});

// POST /api/avis-specialise — cas clinique + photos → avis argumenté et sourcé.
app.post('/api/avis-specialise', authenticateJWT, async (req, res) => {
  const specialite = getSpecialite(req.body.specialite);
  if (!specialite) {
    return res.status(400).json({ error: 'Spécialité non disponible.' });
  }

  const cas = txt(req.body.cas, 12000);
  if (!cas || cas.length < 30) {
    return res.status(400).json({ error: 'Décrivez le cas en quelques phrases (histoire, symptômes, terrain).' });
  }

  const { blocks: photoBlocks, erreur } = parsePhotos(req.body.photos);
  if (erreur) return res.status(400).json({ error: erreur });

  // Les appels vision + Opus sont coûteux : garde-fou par utilisateur.
  const ipAvis = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!rateLimit(`${req.user.id}:${ipAvis}`, 12, 'avis-specialise')) {
    return res.status(429).json({ error: 'Trop de demandes d\'avis. Réessayez dans quelques minutes.' });
  }

  // ── Recherche dans la base de connaissances ──
  // La requête est le cas lui-même, sans enrichissement : la collection étant
  // déjà restreinte à la spécialité, y préfixer des termes génériques ne
  // discrimine rien et dégrade le classement lexical.
  const requete = cas.slice(0, 4000);
  let recherche = { passages: [], mode: 'vide', stats: null };
  try {
    recherche = await ragSearch({ collection: specialite.collection, query: requete, topK: 8 });
  } catch (err) {
    console.error('[avis] recherche RAG échouée —', err.message);
  }

  const passages = recherche.passages;
  if (!passages.length) {
    // Sans base indexée, cette fonctionnalité se réduirait à du prompting pur —
    // exactement ce qu'elle est censée dépasser. On refuse plutôt que de livrer
    // un avis qui aurait l'apparence d'être sourcé sans l'être.
    return res.status(503).json({
      error: `La base de connaissances « ${specialite.label} » n'est pas encore indexée sur ce serveur. `
        + 'Lancez l\'ingestion (npm run ingest ' + specialite.key + ') avant d\'utiliser l\'avis spécialisé.',
    });
  }

  const contexte = formatPassages(passages);
  const references = formatReferences(passages);

  const system =
    specialite.cadrage + ' ' +
    "Tu réponds à un confrère médecin, pas à un patient : le registre est technique et direct.\n\n" +

    "SOURCES : des extraits de littérature scientifique, de recommandations de sociétés savantes et du " +
    "référentiel officiel du médicament te sont fournis. Ils constituent ta base factuelle. " +
    "Appuie chaque affirmation notable sur ces extraits en citant leur numéro entre crochets, par exemple [2]. " +
    "Si les extraits ne couvrent pas un point, dis-le explicitement plutôt que de combler avec des " +
    "connaissances générales non sourcées, et signale que ce point mérite vérification.\n\n" +

    (photoBlocks.length
      ? "PHOTOS : une ou plusieurs images cliniques précèdent le texte. Décris d'abord ce que tu observes " +
        "objectivement (lésion élémentaire, couleur, bordure, topographie, distribution), en distinguant " +
        "nettement l'observation de l'interprétation. Si la qualité de l'image ne permet pas de conclure " +
        "sur un point, dis-le au lieu de supposer.\n\n"
      : "Aucune photo n'est fournie : ne décris aucun aspect visuel que le texte ne mentionne pas.\n\n") +

    "STRUCTURE de la réponse, dans cet ordre exact, chaque titre en majuscules suivi de deux points :\n" +
    "CE QUE MONTRENT LES ÉLÉMENTS FOURNIS : constats objectifs, texte et photos, sans interprétation.\n" +
    "HYPOTHÈSES DIAGNOSTIQUES : de la plus à la moins probable, chacune avec les arguments pour et contre " +
    "tirés du cas.\n" +
    "CAUSES ET MÉCANISMES POSSIBLES : ce qui explique le tableau, y compris les facteurs favorisants.\n" +
    "ÉLÉMENTS MANQUANTS ET EXAMENS UTILES : ce qui départagerait les hypothèses.\n" +
    "PISTES DE PRISE EN CHARGE : stratégies documentées, avec leur niveau de preuve quand les extraits le " +
    "précisent. Les produits ou molécules sont cités à titre d'information documentaire pour éclairer le " +
    "confrère — jamais sous forme de prescription, de posologie personnalisée ou de conseil au patient. " +
    "La décision thérapeutique appartient au médecin qui suit le patient.\n" +
    "SIGNAUX D'ALERTE : ce qui imposerait un avis spécialisé rapide ou un adressage en urgence. " +
    "Omets cette section s'il n'y en a aucun.\n\n" +

    "LIMITES : termine par une phrase rappelant qu'il s'agit d'une aide à la décision fondée sur la " +
    "littérature fournie, et non d'une consultation spécialisée ni d'un diagnostic établi.\n\n" +

    "INTERDITS : n'invente aucun élément clinique absent du cas ou des photos (âge, sexe, antécédent, " +
    "traitement, durée, résultat d'examen). N'attribue à une source un contenu qu'elle ne porte pas. " +
    "Ne produis aucune ordonnance ni posologie nominative.\n\n" +

    "FORMAT : français, jamais de Markdown — pas d'astérisques, pas de dièses, pas de tirets de liste. " +
    "Sépare les sections par une ligne vide. Les énumérations se font en début de ligne, sans puce.\n\n" +

    "Médecin demandeur :\n" + medecinContext(req.user);

  const texteUtilisateur =
    `CAS CLINIQUE SOUMIS PAR LE CONFRÈRE :\n${cas}\n\n` +
    (photoBlocks.length ? `${photoBlocks.length} photo(s) clinique(s) jointe(s), ci-dessus.\n\n` : '') +
    `EXTRAITS DE LA BASE DE CONNAISSANCES ${specialite.label.toUpperCase()} ` +
    `(${passages.length} passages, recherche ${recherche.mode}) :\n\n${contexte}`;

  const blocks = [...photoBlocks, { type: 'text', text: texteUtilisateur }];

  try {
    const avis = finalizeDocument(await generateAvisMultimodal({ system, blocks }));
    res.json({
      document: avis,
      specialite: { key: specialite.key, label: specialite.label },
      references,
      rag: {
        mode: recherche.mode,
        passages: passages.length,
        corpus: recherche.stats ? recherche.stats.count : 0,
      },
      // Le contrôle des valeurs chiffrées inclut les extraits : un dosage cité
      // depuis la base est sourcé, il ne doit pas être signalé comme inventé.
      safety: documentSafety(avis, `${cas}\n${contexte}`, req.user),
    });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/avis-specialise/resume — synthèse courte et actionnable d'un avis
// déjà généré. Aucune recherche RAG : le résumé se fonde exclusivement sur le
// texte fourni, celui-là même que le médecin a sous les yeux. Rien d'autre ne
// doit pouvoir entrer dans la synthèse, sans quoi elle affirmerait des choses
// que l'avis complet — et ses sources — ne portent pas.
//
// Modèle plus léger que l'avis lui-même : le raisonnement diagnostique est déjà
// fait, il ne reste qu'à condenser.
app.post('/api/avis-specialise/resume', authenticateJWT, async (req, res) => {
  const avis = txt(req.body.avis, 20000);
  if (!avis || avis.length < 200) {
    return res.status(400).json({ error: 'Aucun avis à résumer.' });
  }

  const specialite = getSpecialite(req.body.specialite);

  const ipResume = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!rateLimit(`${req.user.id}:${ipResume}`, 40, 'avis-resume')) {
    return res.status(429).json({ error: 'Trop de demandes de résumé. Réessayez dans quelques minutes.' });
  }

  const system =
    "Tu condenses un avis médical spécialisé déjà rédigé, à destination du médecin qui l'a demandé. " +
    (specialite ? `Domaine : ${specialite.label}. ` : '') +
    "Il le lira entre deux consultations : il doit pouvoir agir après lecture, sans avoir à ouvrir le texte complet.\n\n" +

    "SOURCE EXCLUSIVE : tu ne disposes que du texte fourni. N'ajoute aucune hypothèse, aucun examen, " +
    "aucun produit, aucun chiffre et aucune précision qui n'y figurent pas déjà. Tu condenses, tu " +
    "n'enrichis pas. Si l'avis complet exprime une réserve ou une incertitude sur un point que tu " +
    "reprends, conserve cette réserve : un résumé qui affirme ce que l'original nuançait est faux.\n\n" +

    "RENVOIS : l'avis complet cite ses sources par des numéros entre crochets. Conserve ces numéros " +
    "sur les éléments que tu reprends, à l'identique, pour que le médecin puisse remonter au détail.\n\n" +

    "STRUCTURE, dans cet ordre exact, chaque titre en majuscules suivi de deux points :\n" +

    "HYPOTHÈSE LA PLUS PROBABLE : la principale, puis une à deux phrases sur ce qui la soutient dans " +
    "ce cas précis. Conserve les nuances de l'avis complet — ce qui rend l'hypothèse probable sans la " +
    "rendre certaine.\n" +
    "Termine ensuite cette rubrique, et elle seule, par une ligne commençant exactement par " +
    "« Concrètement, ça veut dire : » suivie du premier réflexe pratique qui découle de cette " +
    "hypothèse : simplifier une routine de soins, réévaluer un traitement en cours ou une " +
    "contraception, prioriser un examen, orienter vers un confrère, compléter l'examen sur une zone " +
    "précise. Un seul réflexe, le plus déterminant, en une phrase.\n" +
    "Ce réflexe doit déjà figurer dans l'avis complet : tu le mets en avant, tu ne l'inventes pas. " +
    "Reste au registre du premier geste ou de la première vérification — jamais une prescription, " +
    "jamais une posologie, jamais une décision thérapeutique présentée comme acquise. " +
    "Si l'avis complet ne permet pas de dégager un réflexe clair, écris « Concrètement, ça veut " +
    "dire : confirmer le diagnostic avant toute décision thérapeutique. » plutôt que d'en forcer un.\n" +
    "AUTRES PISTES À NE PAS ÉCARTER : les alternatives retenues par l'avis, une ligne chacune, sans les arguments détaillés.\n" +
    "CE QUI PEUT ÊTRE PROPOSÉ : examens utiles, pistes thérapeutiques, produits cités et orientation éventuelle. " +
    "Reste au registre documentaire entre confrères : pas de posologie nominative, pas de prescription.\n" +
    "SIGNAUX D'ALERTE : ce qui imposerait d'agir vite. Écris « Aucun signalé » si l'avis complet n'en mentionne pas.\n\n" +

    // Un modèle ne compte pas ses caractères : une consigne exprimée en nombre
    // de signes est un vœu. Les plafonds par rubrique, eux, sont vérifiables au
    // fil de la rédaction — et c'est bien eux qui tiennent : mesuré en production,
    // le nombre d'éléments est respecté, la longueur de chaque ligne beaucoup moins.
    //
    // La cible a été portée de 1200-1800 à 1800-2400 après mesure. Les résumés
    // obtenus tournent autour de 2350 caractères, avec des lignes de 130 à 170
    // signes qui portent chacune leur justification clinique. Comprimer davantage
    // reviendrait à supprimer ces justifications pour tenir un chiffre : c'est
    // précisément ce qui fait la valeur de la synthèse.
    "LONGUEUR — contrainte la plus importante après l'exactitude. Plafonds par rubrique :\n" +
    "HYPOTHÈSE LA PLUS PROBABLE : trois phrases au maximum, ligne « Concrètement » comprise. " +
    "L'argumentation cède la place au réflexe pratique, elle ne s'y ajoute pas.\n" +
    "AUTRES PISTES À NE PAS ÉCARTER : trois au maximum, une ligne chacune.\n" +
    "CE QUI PEUT ÊTRE PROPOSÉ : cinq éléments au maximum, une ligne chacun. Retiens les plus " +
    "déterminants pour la décision, pas la liste exhaustive de l'avis complet.\n" +
    "SIGNAUX D'ALERTE : cinq au maximum, une ligne chacun.\n" +
    "Une ligne est une phrase, éventuellement avec sa justification clinique, jamais un paragraphe. " +
    "L'ensemble vise 1800 à 2400 caractères. Quand il faut choisir, garde ce qui change la conduite " +
    "à tenir et coupe le reste : le médecin a l'avis complet à portée de clic.\n\n" +

    // La ligne « Concrètement » rend le résumé plus directif : la limite qui suit
    // doit l'être tout autant, et dire explicitement que rien n'est établi.
    "FIN : termine par une ligne rappelant qu'il s'agit d'une aide à la décision et non d'un " +
    "diagnostic établi, et que le détail argumenté et les sources figurent dans l'avis complet.\n\n" +

    "FORMAT : français, jamais de Markdown — pas d'astérisques, pas de dièses, pas de tirets de liste. " +
    "Sépare les sections par une ligne vide. Les énumérations se font en début de ligne, sans puce.";

  try {
    const resume = finalizeDocument(await generateDocument({
      system,
      user: `Avis spécialisé à condenser :\n\n${avis}`,
      maxTokens: 1200,
    }));
    res.json({ resume, modele: AI_MODEL });
  } catch (err) {
    aiError(res, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DOSSIERS PATIENTS — fiches et timeline de documents
//
//  Remplace le stockage localStorage du navigateur, qui cloisonnait l'historique
//  par écran et le perdait au changement de poste. Toutes les routes sont
//  scopées par req.user.id : un médecin ne voit jamais les dossiers d'un autre.
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/patients — liste des fiches, la plus récemment active en tête
app.get('/api/patients', authenticateJWT, (req, res) => {
  res.json({ patients: dossiers.listPatients(req.user.id, s(req.query.q, 120)) });
});

// POST /api/patients — création d'une fiche
app.post('/api/patients', authenticateJWT, (req, res) => {
  const result = dossiers.createPatient(req.user.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

// GET /api/patients/:id — fiche + timeline complète des documents
app.get('/api/patients/:id', authenticateJWT, (req, res) => {
  const timeline = dossiers.getTimeline(req.user.id, s(req.params.id, 40));
  if (!timeline) return res.status(404).json({ error: 'Patient introuvable.' });
  res.json(timeline);
});

// PATCH /api/patients/:id — mise à jour partielle de la fiche
app.patch('/api/patients/:id', authenticateJWT, (req, res) => {
  const result = dossiers.updatePatient(req.user.id, s(req.params.id, 40), req.body || {});
  if (result.error) {
    return res.status(result.error === 'Patient introuvable.' ? 404 : 400).json({ error: result.error });
  }
  res.json(result);
});

// DELETE /api/patients/:id — supprime la fiche et ses documents
app.delete('/api/patients/:id', authenticateJWT, (req, res) => {
  const result = dossiers.deletePatient(req.user.id, s(req.params.id, 40));
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

// GET /api/patients/:id/contexte — contexte clinique antérieur condensé.
// Alimente l'encart « Contexte » avant génération : le médecin voit ce que
// Praxi s'apprête à réutiliser du dossier, et peut le refuser.
app.get('/api/patients/:id/contexte', authenticateJWT, (req, res) => {
  const contexte = dossiers.contextePatient(req.user.id, s(req.params.id, 40));
  if (!contexte) return res.status(404).json({ error: 'Patient introuvable.' });
  res.json({
    patient: contexte.patient,
    documents: contexte.documents,
    vide: contexte.vide,
    apercu: contexte.texte.slice(0, 1500),
  });
});

// GET /api/documents — historique global, filtrable
app.get('/api/documents', authenticateJWT, (req, res) => {
  res.json({
    documents: dossiers.listDocuments(req.user.id, {
      patientId: s(req.query.patientId, 40) || null,
      type:      s(req.query.type, 40) || null,
      query:     s(req.query.q, 200),
    }),
  });
});

// POST /api/documents — enregistre un document généré dans la timeline
app.post('/api/documents', authenticateJWT, (req, res) => {
  const result = dossiers.createDocument(req.user.id, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

// GET /api/documents/:id — relecture d'un document archivé
app.get('/api/documents/:id', authenticateJWT, (req, res) => {
  const doc = dossiers.getDocument(req.user.id, s(req.params.id, 40));
  if (!doc) return res.status(404).json({ error: 'Document introuvable.' });
  res.json({ document: doc });
});

// DELETE /api/documents/:id
app.delete('/api/documents/:id', authenticateJWT, (req, res) => {
  const result = dossiers.deleteDocument(req.user.id, s(req.params.id, 40));
  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

// POST /api/dossiers/import — reprise des données localStorage héritées.
// Idempotent : un second import ne duplique ni les fiches ni les documents.
app.post('/api/dossiers/import', authenticateJWT, (req, res) => {
  const result = dossiers.importerDepuisLocal(req.user.id, {
    patients:  Array.isArray(req.body.patients)  ? req.body.patients  : [],
    documents: Array.isArray(req.body.documents) ? req.body.documents : [],
  });
  res.json(result);
});

// GET /api/referentiels — référentiels documentaires disponibles
app.get('/api/referentiels', authenticateJWT, (_req, res) => {
  res.json({ referentiels: listReferentiels() });
});

// GET /api/referentiels/mien — référentiel correspondant à la spécialité du compte
app.get('/api/referentiels/mien', authenticateJWT, (req, res) => {
  const ref = getReferentiel((req.user && req.user.specialite) || '');
  res.json({ referentiel: referentielPublic(ref, null) });
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


// ─── Perspective auteur ──────────────────────────────────────────────────────
// Contrôle la voix de la lettre selon qui écrit (auteur) vers qui (destinataire).
// Un généraliste expose les faits et demande un avis — jamais la stratégie spécialisée.
function authorVoiceConstraint(authorSpec, destSpec) {
  const norm = t => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const isGeneral = /g[eé]n[eé]ral|mg\b|omniprat/i.test(authorSpec);
  const authorNorm = norm(authorSpec);
  const destNorm   = norm(destSpec || '');
  // Remove "médecin" prefix to get specialty keyword
  const destKey = destNorm.replace(/m[eé]decin\s*/, '').split(/[\s-]/)[0];
  const isSameSpec = destKey.length > 3 && authorNorm.includes(destKey);
  if (isSameSpec) return ''; // même spécialité → pas de contrainte
  if (!isGeneral && !destSpec) return ''; // spécialiste sans destinataire → pas de contrainte

  const examples = {
    algolog: "Formulation correcte : 'Malgré les antalgiques de palier 2, le soulagement reste insuffisant, je vous sollicite pour optimiser la stratégie antalgique.' " +
      "À éviter absolument : 'Un DN4 devrait être réalisé', 'composante neuropathique à suspecter', 'introduction de prégabaline', 'blocs antalgiques à discuter'.",
    cardio:  "Formulation correcte : 'L'ECG est normal, je vous sollicite pour un bilan rythmologique complet.' " +
      "À éviter : 'Un Holter est indiqué', 'la cardioversion pourrait être envisagée'.",
    neuro:   "À éviter : ne reformulez pas l'interprétation EEG ni les modifications du traitement antiépileptique comme des décisions du médecin adresseur.",
    dermato: "À éviter : 'La dermoscopie est nécessaire', 'le score PASI est à calculer'.",
    default: "Exposez les faits cliniques, les traitements essayés et leur résultat, et formulez explicitement votre demande d'avis."
  };
  const k = Object.keys(examples).find(key => key !== 'default' && destNorm.includes(key)) || 'default';

  return "PERSPECTIVE DE L'AUTEUR : vous rédigez en tant que " + authorSpec +
    " qui adresse un patient à un spécialiste. " +
    "Votre rôle est d'exposer objectivement ce que vous avez observé, essayé, et ce qui reste sans réponse. " +
    "N'empiétez JAMAIS sur les décisions du spécialiste destinataire : " +
    "n'utilisez pas son jargon technique spécialisé, " +
    "ne formulez pas de plan thérapeutique relevant de sa compétence, " +
    "ne présentez pas ses examens spécialisés comme des décisions acquises. " +
    examples[k] + " ";
}

module.exports = app;
module.exports.finalizeDocument = finalizeDocument;
