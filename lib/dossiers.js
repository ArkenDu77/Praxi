// ─── Dossiers patients : fiches + timeline de documents ──────────────────────
//
// Remplace le stockage localStorage du front, qui était cloisonné par écran et
// perdu à chaque changement de navigateur. Tout est ici rattaché au médecin
// propriétaire (userId) : aucune lecture ne traverse les comptes.
//
// Stockage JSON dans DATA_DIR, comme users.json — même contrat de persistance
// (monter un volume et pointer DATA_DIR dessus en production).

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DOSSIERS_PATH = path.join(DATA_DIR, 'dossiers.json');

// Types de documents connus. Sert au libellé de la timeline et au filtrage.
const TYPES_DOCUMENT = {
  cr:          'Compte-rendu de consultation',
  liaison:     'Lettre de liaison',
  ordonnance:  'Ordonnance',
  avis:        'Avis spécialisé',
  resume:      'Analyse de document',
  mdph:        'Certificat MDPH',
  ald:         'Protocole ALD',
  certificat:  'Certificat médical',
  intake:      'Interrogatoire pré-anesthésique (Arkiba Intake)',
};

function emptyDb() {
  return { patients: [], documents: [], nextPatientId: 1, nextDocumentId: 1 };
}

function readDossiers() {
  try {
    const raw = JSON.parse(fs.readFileSync(DOSSIERS_PATH, 'utf8'));
    return {
      patients:       Array.isArray(raw.patients)  ? raw.patients  : [],
      documents:      Array.isArray(raw.documents) ? raw.documents : [],
      nextPatientId:  raw.nextPatientId  || 1,
      nextDocumentId: raw.nextDocumentId || 1,
    };
  } catch {
    return emptyDb();
  }
}

function writeDossiers(db) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  fs.writeFileSync(DOSSIERS_PATH, JSON.stringify(db, null, 2));
}

// ── Helpers de normalisation ────────────────────────────────────────────────

const clean = (v, max = 200) =>
  typeof v === 'string' ? v.trim().slice(0, max).replace(/[<>]/g, '') : '';

const cleanLong = (v, max = 40000) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * Âge calculé depuis la date de naissance (format ISO ou JJ/MM/AAAA).
 * Renvoie null si la date est absente ou inexploitable — jamais une valeur
 * approximative : un âge faux dans un document médical est pire qu'un âge absent.
 */
function ageDepuisDdn(ddn) {
  if (!ddn) return null;
  let d = null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ddn);
  const fr  = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddn);
  if (iso)      d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
  else if (fr)  d = new Date(+fr[3], +fr[2] - 1, +fr[1]);
  if (!d || isNaN(d.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

// Un champ absent du corps de requête conserve sa valeur ; un champ présent mais
// vide est effacé. Sans cette distinction, une mise à jour partielle (ex. ne
// changer que les allergies) réécrirait tout le reste à vide.
function normalisePatient(body, existing = {}) {
  const champ = (nom, max, defaut = '') =>
    Object.prototype.hasOwnProperty.call(body, nom)
      ? clean(body[nom], max)
      : (existing[nom] !== undefined ? existing[nom] : defaut);

  const sexe = champ('sexe', 1);
  return {
    nom:         champ('nom', 120),
    ddn:         champ('ddn', 20),
    sexe:        ['M', 'F', ''].includes(sexe) ? sexe : (existing.sexe || ''),
    patho:       champ('patho', 1000),
    traitements: champ('traitements', 1000),
    allergies:   champ('allergies', 500),
    mt:          champ('mt', 200),
    notes:       champ('notes', 2000),
  };
}

// ── Patients ────────────────────────────────────────────────────────────────

function listPatients(userId, query = '') {
  const db = readDossiers();
  const q = String(query || '').toLowerCase().trim();

  return db.patients
    .filter(p => p.userId === userId)
    .filter(p => !q || [p.nom, p.patho, p.traitements, p.allergies]
      .some(f => (f || '').toLowerCase().includes(q)))
    .map(p => {
      const docs = db.documents.filter(d => d.userId === userId && d.patientId === p.id);
      const dernier = docs.length
        ? docs.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
        : null;
      return {
        ...p,
        age: ageDepuisDdn(p.ddn),
        nbDocuments: docs.length,
        dernierDocument: dernier
          ? { id: dernier.id, type: dernier.type, typeLabel: dernier.typeLabel, createdAt: dernier.createdAt }
          : null,
      };
    })
    // Le plus récemment actif en tête : c'est le patient qu'on rouvre.
    .sort((a, b) => {
      const da = a.dernierDocument ? a.dernierDocument.createdAt : a.createdAt;
      const dbb = b.dernierDocument ? b.dernierDocument.createdAt : b.createdAt;
      return dbb.localeCompare(da);
    });
}

function getPatient(userId, patientId) {
  const db = readDossiers();
  const p = db.patients.find(x => x.id === patientId && x.userId === userId);
  return p ? { ...p, age: ageDepuisDdn(p.ddn) } : null;
}

function createPatient(userId, body) {
  const db = readDossiers();
  const base = normalisePatient(body);
  if (!base.nom) return { error: 'Le nom du patient est requis.' };

  const patient = {
    id: String(db.nextPatientId),
    userId,
    ...base,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.patients.push(patient);
  db.nextPatientId++;
  writeDossiers(db);
  return { patient: { ...patient, age: ageDepuisDdn(patient.ddn), nbDocuments: 0, dernierDocument: null } };
}

function updatePatient(userId, patientId, body) {
  const db = readDossiers();
  const idx = db.patients.findIndex(x => x.id === patientId && x.userId === userId);
  if (idx === -1) return { error: 'Patient introuvable.' };

  const existing = db.patients[idx];
  const base = normalisePatient(body, existing);
  if (!base.nom) return { error: 'Le nom du patient est requis.' };

  db.patients[idx] = { ...existing, ...base, updatedAt: new Date().toISOString() };
  writeDossiers(db);
  return { patient: { ...db.patients[idx], age: ageDepuisDdn(db.patients[idx].ddn) } };
}

function deletePatient(userId, patientId) {
  const db = readDossiers();
  const before = db.patients.length;
  db.patients  = db.patients.filter(x => !(x.id === patientId && x.userId === userId));
  if (db.patients.length === before) return { error: 'Patient introuvable.' };
  // La fiche part avec ses documents : laisser des documents orphelins
  // ferait réapparaître le patient dans l'historique global.
  db.documents = db.documents.filter(d => !(d.patientId === patientId && d.userId === userId));
  writeDossiers(db);
  return { ok: true };
}

// ── Documents ───────────────────────────────────────────────────────────────

function listDocuments(userId, { patientId = null, type = null, query = '', limit = 200 } = {}) {
  const db = readDossiers();
  const q = String(query || '').toLowerCase().trim();

  return db.documents
    .filter(d => d.userId === userId)
    .filter(d => !patientId || d.patientId === patientId)
    .filter(d => !type || d.type === type)
    .filter(d => !q || [d.titre, d.patientNom, d.typeLabel, d.contenu]
      .some(f => (f || '').toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

function getDocument(userId, documentId) {
  const db = readDossiers();
  return db.documents.find(d => d.id === documentId && d.userId === userId) || null;
}

function createDocument(userId, body) {
  const db = readDossiers();

  const type = clean(body.type, 40) || 'cr';
  const contenu = cleanLong(body.contenu);
  if (!contenu) return { error: 'Document vide.' };

  // Un patientId fourni doit appartenir au médecin : sinon on rattache le
  // document à personne plutôt que de le greffer sur un dossier étranger.
  let patientId = clean(body.patientId, 40) || null;
  let patientNom = clean(body.patientNom, 120);
  if (patientId) {
    const p = db.patients.find(x => x.id === patientId && x.userId === userId);
    if (!p) { patientId = null; }
    else if (!patientNom) { patientNom = p.nom; }
  }

  const doc = {
    id: String(db.nextDocumentId),
    userId,
    patientId,
    patientNom: patientNom || 'Patient',
    type,
    typeLabel: TYPES_DOCUMENT[type] || clean(body.typeLabel, 80) || 'Document',
    titre: clean(body.titre, 200) || TYPES_DOCUMENT[type] || 'Document',
    contenu,
    // Trace de provenance : quels documents antérieurs ont nourri celui-ci.
    // C'est ce qui permet au front d'afficher « appuyé sur … » et au médecin
    // de vérifier d'où vient une affirmation.
    sources: Array.isArray(body.sources)
      ? body.sources.map(x => clean(x, 40)).filter(Boolean).slice(0, 20)
      : [],
    meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
    createdAt: new Date().toISOString(),
  };

  db.documents.push(doc);
  db.nextDocumentId++;
  writeDossiers(db);
  return { document: doc };
}

function deleteDocument(userId, documentId) {
  const db = readDossiers();
  const before = db.documents.length;
  db.documents = db.documents.filter(d => !(d.id === documentId && d.userId === userId));
  if (db.documents.length === before) return { error: 'Document introuvable.' };
  writeDossiers(db);
  return { ok: true };
}

// ── Timeline & contexte de génération ───────────────────────────────────────

/**
 * Timeline d'un patient : la fiche + tous ses documents en ordre
 * anti-chronologique, groupés par jour pour l'affichage.
 */
function getTimeline(userId, patientId) {
  const patient = getPatient(userId, patientId);
  if (!patient) return null;

  const documents = listDocuments(userId, { patientId });
  const jours = [];
  for (const doc of documents) {
    const jour = doc.createdAt.slice(0, 10);
    let bucket = jours.find(j => j.date === jour);
    if (!bucket) { bucket = { date: jour, documents: [] }; jours.push(bucket); }
    bucket.documents.push(doc);
  }

  const docsPatient = documents.length;
  return {
    patient,
    documents,
    jours,
    stats: {
      total: docsPatient,
      premier: docsPatient ? documents[documents.length - 1].createdAt : null,
      dernier: docsPatient ? documents[0].createdAt : null,
      parType: documents.reduce((acc, d) => { acc[d.type] = (acc[d.type] || 0) + 1; return acc; }, {}),
    },
  };
}

/** Coupe un document à sa partie utile pour du contexte (pas le document entier). */
function extraitDocument(doc, maxChars = 900) {
  const t = (doc.contenu || '').replace(/\s+\n/g, '\n').trim();
  return t.length <= maxChars ? t : t.slice(0, maxChars) + '…';
}

/**
 * Contexte clinique antérieur destiné aux prompts de génération.
 *
 * Renvoie un bloc texte daté + la liste des documents qui le composent, afin
 * que le front puisse afficher précisément sur quoi la génération s'est appuyée.
 * Rien n'est inventé ici : uniquement ce que le médecin a lui-même enregistré.
 */
function contextePatient(userId, patientId, { maxDocuments = 4, maxChars = 900 } = {}) {
  const patient = getPatient(userId, patientId);
  if (!patient) return null;

  const documents = listDocuments(userId, { patientId, limit: maxDocuments });

  const identite = [];
  if (patient.age !== null)  identite.push(`Âge : ${patient.age} ans`);
  if (patient.sexe)          identite.push(`Sexe : ${patient.sexe === 'M' ? 'masculin' : 'féminin'}`);
  if (patient.patho)         identite.push(`Antécédents connus : ${patient.patho}`);
  if (patient.traitements)   identite.push(`Traitements en cours : ${patient.traitements}`);
  if (patient.allergies)     identite.push(`ALLERGIES : ${patient.allergies}`);
  if (patient.mt)            identite.push(`Médecin traitant : ${patient.mt}`);

  const historique = documents.map((d, i) => {
    const jours = Math.round((Date.now() - new Date(d.createdAt).getTime()) / 86400000);
    const quand = jours === 0 ? "aujourd'hui" : jours === 1 ? 'hier' : `il y a ${jours} jours`;
    return `[A${i + 1}] ${d.typeLabel} du ${d.createdAt.slice(0, 10)} (${quand}) :\n${extraitDocument(d, maxChars)}`;
  });

  const texte = [
    identite.length ? `FICHE PATIENT :\n${identite.join('\n')}` : '',
    historique.length ? `DOCUMENTS ANTÉRIEURS DE CE PATIENT :\n\n${historique.join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    patient,
    texte,
    documents: documents.map((d, i) => ({
      ref: `A${i + 1}`,
      id: d.id,
      type: d.type,
      typeLabel: d.typeLabel,
      createdAt: d.createdAt,
    })),
    vide: !texte,
  };
}

// ── Import depuis le localStorage du navigateur ─────────────────────────────

/**
 * Reprise des données créées avant la bascule serveur. Idempotent sur le nom
 * du patient : réimporter deux fois ne duplique pas les fiches.
 */
function importerDepuisLocal(userId, { patients = [], documents = [] } = {}) {
  const db = readDossiers();
  const parNom = new Map(
    db.patients.filter(p => p.userId === userId).map(p => [p.nom.toLowerCase(), p])
  );

  let patientsImportes = 0;
  const idsLocaux = new Map(); // id local → id serveur

  for (const raw of Array.isArray(patients) ? patients.slice(0, 500) : []) {
    const base = normalisePatient(raw);
    if (!base.nom) continue;
    const existant = parNom.get(base.nom.toLowerCase());
    if (existant) { idsLocaux.set(String(raw.id), existant.id); continue; }

    const patient = {
      id: String(db.nextPatientId),
      userId,
      ...base,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.patients.push(patient);
    parNom.set(patient.nom.toLowerCase(), patient);
    idsLocaux.set(String(raw.id), patient.id);
    db.nextPatientId++;
    patientsImportes++;
  }

  // Signature d'un document déjà présent : même patient, même type, même début
  // de contenu. Suffisant pour empêcher les doublons d'un double import.
  const signature = d => `${d.patientNom || ''}|${d.type}|${(d.contenu || '').slice(0, 120)}`;
  const dejaLa = new Set(db.documents.filter(d => d.userId === userId).map(signature));

  let documentsImportes = 0;
  for (const raw of Array.isArray(documents) ? documents.slice(0, 1000) : []) {
    const contenu = cleanLong(raw.contenu || raw.text || '');
    if (!contenu) continue;

    const type = clean(raw.type, 40) || 'cr';
    const patientNom = clean(raw.patient || raw.patientNom, 120) || 'Patient';
    const candidat = { patientNom, type, contenu };
    if (dejaLa.has(signature(candidat))) continue;

    // Rattachement au dossier du même nom quand il existe.
    const p = parNom.get(patientNom.toLowerCase());

    db.documents.push({
      id: String(db.nextDocumentId),
      userId,
      patientId: p ? p.id : null,
      patientNom,
      type,
      typeLabel: TYPES_DOCUMENT[type] || clean(raw.typeLabel, 80) || 'Document',
      titre: clean(raw.typeLabel, 200) || TYPES_DOCUMENT[type] || 'Document',
      contenu,
      sources: [],
      meta: { importe: true },
      createdAt: raw.createdAt || new Date().toISOString(),
    });
    dejaLa.add(signature(candidat));
    db.nextDocumentId++;
    documentsImportes++;
  }

  writeDossiers(db);
  return { patientsImportes, documentsImportes };
}

// ── Raccordement arkiba-intake ──────────────────────────────────────────────
//
// Le dossier arrive déjà structuré (identité, antécédents, allergies…) depuis
// un appel téléphonique mené par Arkiba Intake : ce n'est ni une saisie du
// médecin, ni un import ponctuel. `intakeId` est la clé d'idempotence — la
// même valeur rejouée (webhook relivré, retry réseau) met à jour la même
// fiche au lieu d'en créer une seconde, sur le même principe que `dossiers.json`
// applique déjà à `nextPatientId`/`nextDocumentId`.
//
// Volontairement séparé de `createPatient`/`updatePatient` (et ne passe donc
// pas par `normalisePatient`) : ces fonctions portent le contrat du formulaire
// saisi à la main par le médecin, et `intakeId` n'a rien à y faire tant qu'il
// n'est pas un champ que le médecin peut lui-même voir ou modifier.

/**
 * Crée ou met à jour la fiche patient rattachée à un dossier Arkiba Intake.
 * `champs` : { nom, ddn, patho, traitements, allergies }, déjà du texte prêt
 * à afficher — la traduction depuis l'IntakeResult se fait côté appelant.
 */
/**
 * ============================================================================
 *  RETROUVER LA PERSONNE, PAS L'INTERROGATOIRE
 * ============================================================================
 *
 * Cette fonction dedoublonnait sur `intakeId`, c'est-a-dire sur UN appel. Un
 * patient qui reprend rendez-vous produit un nouvel interrogatoire, donc un
 * nouvel identifiant — et donc, jusqu'ici, un SECOND dossier pour la meme
 * personne. Le medecin se serait retrouve avec « GIBEAU Marius » en double,
 * chacun portant la moitie de son histoire.
 *
 * On cherche donc la personne, dans cet ordre :
 *
 *   1. `sourcePatientRef` — l'identifiant que l'agenda source donne au
 *      patient. C'est le seul rapprochement vraiment sur : il vient du
 *      systeme qui, lui, sait de qui il parle.
 *   2. `intakeId` — le meme interrogatoire renvoye deux fois.
 *   3. nom EXACT + date de naissance EXACTE. Deux personnes peuvent porter le
 *      meme nom ; deux personnes ne partagent pas nom ET date de naissance.
 *
 * Ce qu'on ne fait JAMAIS : rapprocher sur le nom seul. Fusionner deux
 * patients differents est irreparable — leurs antecedents, leurs traitements
 * et leurs allergies se melangent dans un seul dossier, et le medecin lit
 * ensuite l'allergie de quelqu'un d'autre. Dans le doute, on cree un second
 * dossier : un doublon se corrige, une fusion ne se defait pas.
 */
function trouverPatientExistant(db, userId, { sourcePatientRef, intakeId, nom, ddn }) {
  const miens = db.patients.filter((p) => p.userId === userId);
  if (sourcePatientRef) {
    const parSource = miens.find((p) => p.sourcePatientRef === sourcePatientRef);
    if (parSource) return parSource;
  }
  if (intakeId) {
    const parIntake = miens.find((p) => p.intakeId === intakeId);
    if (parIntake) return parIntake;
  }
  if (nom && ddn) {
    const parIdentite = miens.find(
      (p) => p.nom && p.ddn && p.nom.toLowerCase() === nom.toLowerCase() && p.ddn === ddn,
    );
    if (parIdentite) return parIdentite;
  }
  return null;
}

function upsertPatientFromIntake(userId, intakeId, champs = {}) {
  const idIntake = clean(intakeId, 80);
  const refSource = clean(champs.sourcePatientRef, 120);
  // Un identifiant de patient venu de l'agenda suffit : il designe la
  // personne, ce qu'un identifiant d'interrogatoire ne fait pas.
  if (!idIntake && !refSource) return { error: 'intake_id ou sourcePatientRef requis.' };

  const base = {
    nom:         clean(champs.nom, 120),
    ddn:         clean(champs.ddn, 20),
    sexe:        ['M', 'F', ''].includes(champs.sexe) ? champs.sexe : '',
    patho:       clean(champs.patho, 1000),
    traitements: clean(champs.traitements, 1000),
    allergies:   clean(champs.allergies, 500),
    mt:          '',
    notes:       clean(champs.notes, 2000),
  };
  if (!base.nom) return { error: 'Nom du patient manquant dans le dossier Intake.' };

  const db  = readDossiers();
  const existant = trouverPatientExistant(db, userId, {
    sourcePatientRef: refSource,
    intakeId: idIntake,
    nom: base.nom,
    ddn: base.ddn,
  });
  const maintenant = new Date().toISOString();

  if (existant) {
    const idx = db.patients.findIndex((p) => p.id === existant.id && p.userId === userId);
    // On COMPLETE sans effacer : un champ vide venu d'un nouvel interrogatoire
    // ne doit pas supprimer ce que le medecin avait deja saisi.
    const fusion = { ...db.patients[idx] };
    for (const [cle, valeur] of Object.entries(base)) {
      if (valeur) fusion[cle] = valeur;
    }
    if (idIntake) fusion.intakeId = idIntake;
    if (refSource) fusion.sourcePatientRef = refSource;
    db.patients[idx] = { ...fusion, updatedAt: maintenant };
    writeDossiers(db);
    return { patient: { ...db.patients[idx], age: ageDepuisDdn(db.patients[idx].ddn) }, created: false };
  }

  const patient = {
    id: String(db.nextPatientId),
    userId,
    intakeId: idIntake || null,
    sourcePatientRef: refSource || null,
    ...base,
    createdAt: maintenant,
    updatedAt: maintenant,
  };
  db.patients.push(patient);
  db.nextPatientId++;
  writeDossiers(db);
  return { patient: { ...patient, age: ageDepuisDdn(patient.ddn) }, created: true };
}

/**
 * Crée ou remplace le document « Interrogatoire pré-anesthésique » attaché à
 * un dossier Intake. Idempotent sur `intakeId` (porté dans `meta`), comme la
 * fiche patient elle-même : un renvoi ne duplique pas le document.
 */
function upsertIntakeDocument(userId, patientId, patientNom, intakeId, contenu) {
  const idIntake = clean(intakeId, 80);
  const texte = cleanLong(contenu);
  if (!texte) return { error: 'Document Intake vide.' };

  const db  = readDossiers();
  const idx = db.documents.findIndex(
    d => d.userId === userId && d.meta && d.meta.intakeId === idIntake
  );
  const maintenant = new Date().toISOString();

  const doc = {
    id:         idx !== -1 ? db.documents[idx].id : String(db.nextDocumentId),
    userId,
    patientId:  patientId || null,
    patientNom: clean(patientNom, 120) || 'Patient',
    type:       'intake',
    typeLabel:  TYPES_DOCUMENT.intake,
    titre:      TYPES_DOCUMENT.intake,
    contenu:    texte,
    sources:    [],
    meta:       { source: 'arkiba-intake', intakeId: idIntake },
    createdAt:  idx !== -1 ? db.documents[idx].createdAt : maintenant,
  };

  if (idx !== -1) db.documents[idx] = doc;
  else { db.documents.push(doc); db.nextDocumentId++; }
  writeDossiers(db);
  return { document: doc, created: idx === -1 };
}

/**
 * La fiche patient correspondant a un dossier de pre-consultation.
 *
 * Meme regle de rapprochement que la creation — identifiant source, puis
 * interrogatoire, puis nom ET date de naissance — pour qu'un ecran ne puisse
 * jamais montrer un patient que la creation n'aurait pas choisi.
 */
function trouverPatientPour(userId, criteres = {}) {
  const db = readDossiers();
  const p = trouverPatientExistant(db, userId, {
    sourcePatientRef: clean(criteres.sourcePatientRef, 120),
    intakeId: clean(criteres.intakeId, 80),
    nom: clean(criteres.nom, 120),
    ddn: clean(criteres.ddn, 20),
  });
  return p ? { ...p, age: ageDepuisDdn(p.ddn) } : null;
}

module.exports = {
  trouverPatientPour,
  TYPES_DOCUMENT,
  ageDepuisDdn,
  listPatients, getPatient, createPatient, updatePatient, deletePatient,
  listDocuments, getDocument, createDocument, deleteDocument,
  getTimeline, contextePatient,
  importerDepuisLocal,
  upsertPatientFromIntake, upsertIntakeDocument,
  // exposés pour les tests
  readDossiers, writeDossiers, DOSSIERS_PATH,
};
