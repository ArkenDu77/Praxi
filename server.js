require('dotenv').config();

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');

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

// ── STOCKAGE JSON (MVP — migre vers SQLite sur VPS) ──
const DB_PATH = path.join(__dirname, 'waitlist.json');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { entries: [], nextId: 1 }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ── STOCKAGE UTILISATEURS (médecins) ──
const USERS_PATH = path.join(__dirname, 'users.json');

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
// Renvoie l'utilisateur sans le hash du mot de passe (pour réponses API)
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
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
  'Médecine générale','Médecine interne','Cardiologie','Pédiatrie',
  'Gynécologie','Psychiatrie','Rhumatologie','Gériatrie',
  'Médecin algologue','Médecin anesthésiste réanimateur','Autre spécialité'
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
    { id: user.id, email: user.email, prenom: user.prenom },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
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

// Adaptation légère du ton / des éléments attendus selon la spécialité destinataire.
function adaptationSpecialite(specialite) {
  const map = {
    'Cardiologie':            "Le destinataire est cardiologue : mets en avant les facteurs de risque cardiovasculaire, les symptômes cardiologiques, le traitement cardiotrope et les éventuels examens (ECG, biologie) déjà réalisés.",
    'Pneumologie':            "Le destinataire est pneumologue : insiste sur les symptômes respiratoires, le tabagisme, l'exposition professionnelle et les explorations fonctionnelles respiratoires éventuelles.",
    'Endocrinologie':         "Le destinataire est endocrinologue : précise les éléments métaboliques (poids, glycémie, bilan thyroïdien) et les traitements en cours.",
    'Neurologie':             "Le destinataire est neurologue : détaille la sémiologie neurologique, la chronologie des symptômes et les antécédents pertinents.",
    'Gastro-entérologie':     "Le destinataire est gastro-entérologue : précise les symptômes digestifs, le transit, et les antécédents digestifs.",
    'Rhumatologie':           "Le destinataire est rhumatologue : décris la topographie articulaire, le rythme des douleurs et le retentissement fonctionnel.",
    'Dermatologie':           "Le destinataire est dermatologue : décris précisément les lésions cutanées (aspect, localisation, évolution).",
    'Psychiatrie':            "Le destinataire est psychiatre : reste factuel et nuancé sur le plan symptomatique et le contexte, sans jugement.",
    'Gynécologie':            "Le destinataire est gynécologue : précise les antécédents gynéco-obstétricaux pertinents.",
    'Ophtalmologie':          "Le destinataire est ophtalmologue : précise les symptômes visuels et leur évolution.",
    'ORL':                    "Le destinataire est ORL : précise les symptômes ORL et leur ancienneté.",
    'Urologie':               "Le destinataire est urologue : précise les symptômes urinaires et les antécédents pertinents.",
    'Chirurgie orthopédique': "Le destinataire est chirurgien orthopédiste : précise le mécanisme, la localisation et le retentissement fonctionnel.",
    'Médecine interne':       "Le destinataire est interniste : présente une synthèse globale et les hypothèses diagnostiques."
  };
  return map[specialite] || '';
}

// Adaptation du compte-rendu selon la (les) spécialité(s) du médecin rédacteur.
// Certaines spécialités attendent une structuration ou des éléments spécifiques.
function adaptationRedacteur(user) {
  if (!user) return '';
  const list = (Array.isArray(user.specialites) && user.specialites.length)
    ? user.specialites
    : (user.specialite ? user.specialite.split(',').map(x => x.trim()).filter(Boolean) : []);
  const map = {
    'Médecin algologue':
      "Le rédacteur est médecin algologue (médecine de la douleur) : structure le compte-rendu " +
      "autour de l'évaluation de la douleur (mécanisme nociceptif / neuropathique / mixte, intensité " +
      "type EVA ou EN, topographie et irradiation, ancienneté, retentissement sur le sommeil, " +
      "l'humeur, l'autonomie et la qualité de vie), des traitements antalgiques déjà essayés avec " +
      "leur efficacité et leur tolérance, et de la stratégie thérapeutique proposée (paliers " +
      "antalgiques OMS, co-antalgiques, traitements adjuvants, techniques interventionnelles ou prise " +
      "en charge pluridisciplinaire éventuelles).",
    'Médecin anesthésiste réanimateur':
      "Le rédacteur est médecin anesthésiste-réanimateur : en contexte de consultation " +
      "pré-anesthésique, mets en avant le score ASA, les antécédents médico-chirurgicaux et " +
      "anesthésiques, les allergies, les traitements en cours (notamment anticoagulants et " +
      "antiagrégants), les critères d'intubation difficile, l'évaluation des voies aériennes, le jeûne " +
      "et les consignes péri-opératoires ; en contexte de réanimation, détaille l'état " +
      "hémodynamique, respiratoire et neurologique, les défaillances d'organe et les thérapeutiques " +
      "de suppléance."
  };
  return list.map(sp => map[sp]).filter(Boolean).join(' ');
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

  if (!notes && !motif) {
    return res.status(400).json({ error: 'Renseignez au moins le motif ou les notes cliniques.' });
  }

  const adapt = adaptationSpecialite(specialiste);
  const system =
    "Tu es un assistant médical pour médecins libéraux français. Rédige une lettre de liaison " +
    "professionnelle et concise destinée à un confrère spécialiste, comme un médecin l'écrirait " +
    "réellement. La lettre doit être formelle, en français médical correct, sans inventer " +
    "d'informations non fournies. " +
    enteteConsigne(req.user) +
    (adapt ? adapt + " " : "") +
    "FORMAT : écris en prose fluide, en paragraphes continus. N'utilise JAMAIS de Markdown : pas " +
    "d'astérisques (* ou **), pas de dièses (#), pas de tirets de liste. N'emploie aucune liste à " +
    "puces. Les éventuels titres (objet, etc.) s'écrivent en majuscules sans aucun caractère de " +
    "formatage, et les sections sont séparées par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets comme [date] ou [nom] : si une information manque, " +
    "omets-la proprement et reformule la phrase. N'ajoute aucun commentaire hors de la lettre.";

  const user =
    `Spécialiste destinataire : ${specialiste || 'Non précisé'}\n` +
    `Patient : ${patient || 'Non précisé'}${age ? `, ${age}` : ''}\n` +
    `Motif d'adressage : ${motif || 'Non précisé'}\n\n` +
    `Notes cliniques du médecin :\n${notes || '(aucune)'}\n`;

  try {
    const document = await generateDocument({ system, user, maxTokens: 1500 });
    res.json({ document });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/generate/compte-rendu — compte-rendu de consultation structuré
app.post('/api/generate/compte-rendu', authenticateJWT, async (req, res) => {
  const patient = txt(req.body.patient, 500);
  const date    = s(req.body.date, 40);
  const notes   = txt(req.body.notes);

  if (!notes) {
    return res.status(400).json({ error: 'Renseignez les notes de consultation.' });
  }

  const adaptRedacteur = adaptationRedacteur(req.user);
  const system =
    "Tu es un assistant médical pour médecins libéraux français. À partir de notes brutes, rédige un " +
    "compte-rendu de consultation structuré. " +
    enteteConsigne(req.user) +
    (adaptRedacteur ? adaptRedacteur + " " : "") +
    "Après l'en-tête, organise le compte-rendu avec ces sections, dans cet ordre, chaque titre en " +
    "majuscules suivi de deux-points : MOTIF DE CONSULTATION :, ANTÉCÉDENTS MENTIONNÉS :, " +
    "EXAMEN CLINIQUE :, DIAGNOSTIC / IMPRESSION CLINIQUE :, CONDUITE À TENIR :. " +
    "Sous chaque titre, écris le contenu en prose (phrases continues), jamais sous forme de liste. " +
    "Ne jamais inventer d'informations. Si une section n'est pas mentionnée dans les notes, écris " +
    "'Non renseigné' sous le titre correspondant. " +
    "FORMAT : n'utilise JAMAIS de Markdown : pas d'astérisques (* ou **), pas de dièses (#), pas de " +
    "tirets de liste ni de puces. Sépare les sections par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets comme [date] ou [nom] : si une information manque, " +
    "omets-la proprement. N'ajoute aucun commentaire hors du compte-rendu.";

  const user =
    `Patient : ${patient || 'Non précisé'}\n` +
    `Date de consultation : ${date || 'Non précisée'}\n\n` +
    `Notes brutes de consultation :\n${notes}\n`;

  try {
    const document = await generateDocument({ system, user, maxTokens: 1800 });
    res.json({ document });
  } catch (err) {
    aiError(res, err);
  }
});

// POST /api/generate/resume — analyse / résumé d'un document
app.post('/api/generate/resume', authenticateJWT, async (req, res) => {
  const document = txt(req.body.text);

  if (!document) {
    return res.status(400).json({ error: 'Aucun texte de document à analyser.' });
  }

  const system =
    "Tu es un assistant médical. Analyse le document médical fourni et produis exactement trois sections, " +
    "dans cet ordre, chaque titre en majuscules suivi de deux-points : RÉSUMÉ :, POINTS CLÉS :, " +
    "ACTIONS SUGGÉRÉES :. " +
    "Sous RÉSUMÉ, écris 3 à 5 phrases en prose. Sous POINTS CLÉS, écris chaque point sur sa propre " +
    "ligne, en texte simple, sans tiret, sans puce et sans astérisque en début de ligne. Sous " +
    "ACTIONS SUGGÉRÉES, procède de la même façon : une action par ligne, en texte simple. " +
    "Sois concis et factuel. N'invente rien qui ne figure pas dans le document. " +
    "FORMAT : n'utilise JAMAIS de Markdown : pas d'astérisques (* ou **), pas de dièses (#), pas de " +
    "tirets de liste. Sépare les sections par des sauts de ligne. " +
    "N'écris jamais de champ vide entre crochets comme [date] ou [nom] : si une information manque, " +
    "omets-la proprement.";

  const user = `Document médical à analyser :\n\n${document}\n`;

  try {
    const result = await generateDocument({ system, user, maxTokens: 1500 });
    res.json({ document: result });
  } catch (err) {
    aiError(res, err);
  }
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
  console.log(`  → IA    : ${anthropic ? `activée (${AI_MODEL})` : 'désactivée — ANTHROPIC_API_KEY manquante'}\n`);
});
