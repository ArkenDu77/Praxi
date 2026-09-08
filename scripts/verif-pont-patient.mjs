/**
 * ============================================================================
 *  LE PONT MOTEUR -> PATIENT ARKIBA, SUR LE VRAI DEPLOIEMENT
 * ============================================================================
 *
 * Les bancs prouvent la jonction contre une pile lancee pour eux. Ils ne
 * prouvent pas que les deux services deployes se parlent : un secret pas pose,
 * une URL fausse, un cabinet mal resolu — rien de cela n'apparait en local.
 *
 * Ce programme joue ce que le moteur enverra demain, sur arkiba.fr, pour un
 * compte cree a l'instant. Il ne declenche aucun appel : il n'y a ni agenda,
 * ni rendez-vous, ni telephonie dans ce chemin.
 */

const BASE = 'https://www.arkiba.fr';
const JETON_PONT = process.env.INTAKE_SERVICE_TOKEN ?? '';

if (!JETON_PONT) {
  console.log('INTAKE_SERVICE_TOKEN requis');
  process.exit(1);
}

const resultats = [];
const verifier = (quoi, ok, detail = '') => {
  resultats.push({ quoi, ok });
  console.log(`${ok ? 'PASS ' : 'ECHEC'} ${quoi}${detail ? ` — ${detail}` : ''}`);
};

const json = async (res) => {
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { brut: t.slice(0, 200) }; }
};

const marque = Date.now();
const compte = {
  prenom: 'Pont',
  nom: 'Patient',
  email: `pont.patient.${marque}@example.invalid`,
  password: `Pont${marque}!aA`,
  specialites: ['Anesthésiste-réanimateur'],
  ville: 'Paris',
};

// ---- 1. UN COMPTE NEUF -----------------------------------------------------
const inscription = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(compte),
});
verifier('compte cree', inscription.ok, `HTTP ${inscription.status}`);
if (!inscription.ok) process.exit(1);

const connexion = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: compte.email, password: compte.password }),
});
const jeton = (await json(connexion)).token;
verifier('connexion', Boolean(jeton));
if (!jeton) process.exit(1);

const commeMedecin = (chemin, init = {}) =>
  fetch(`${BASE}${chemin}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jeton}`,
      ...(init.corps ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.corps ? { body: JSON.stringify(init.corps) } : {}),
  });

const cabinet = (await json(await commeMedecin('/api/mon-cabinet'))).cabinet;
verifier('le compte a son propre cabinet', Boolean(cabinet), cabinet ?? '');

// ---- 2. LE MOTEUR ANNONCE UN RENDEZ-VOUS DETECTE ---------------------------
const commeMoteur = (corps) =>
  fetch(`${BASE}/api/internal/intake-results`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-intake-token': JETON_PONT },
    body: JSON.stringify(corps),
  });

const REF = `doctolib-verif-${marque}`;
const detection = await commeMoteur({
  tenant_id: cabinet,
  intake_id: '',
  source_patient_ref: REF,
  patient: { first_name: 'Verif', last_name: 'PONT', date_of_birth: '1980-05-05' },
  patient_summary: { patho: '', traitements: '', allergies: '' },
});
const corpsDetection = await json(detection);
verifier(
  'le pont accepte le moteur et cree le patient',
  detection.status === 201 && Boolean(corpsDetection.patientId),
  `HTTP ${detection.status}`,
);
const patientId = corpsDetection.patientId;

// ---- 3. LE PATIENT EST DANS L'ONGLET PATIENTS -------------------------------
const liste = await json(await commeMedecin('/api/patients'));
const sien = (liste.patients ?? []).find((p) => p.id === patientId);
verifier('le patient apparait dans Patients', Boolean(sien), sien?.nom ?? '');

// ---- 4. L'INTERROGATOIRE ENRICHIT LA MEME FICHE -----------------------------
const apresAppel = await commeMoteur({
  tenant_id: cabinet,
  intake_id: `intake-verif-${marque}`,
  session_id: `sess-verif-${marque}`,
  source_patient_ref: REF,
  status: 'completed',
  patient: { first_name: 'Verif', last_name: 'PONT', date_of_birth: '1980-05-05' },
  patient_summary: { patho: 'Hypertension', traitements: 'Doliprane', allergies: 'Aucune' },
  document: { titre: 'Interrogatoire', contenu: '# Pre-consultation\n\nCapacite a l effort : 10 etages.' },
});
const corpsApres = await json(apresAppel);
verifier(
  "l'interrogatoire enrichit la MEME fiche, sans doublon",
  apresAppel.status === 200 && corpsApres.patientId === patientId && corpsApres.created === false,
  `HTTP ${apresAppel.status}`,
);

const listeApres = await json(await commeMedecin('/api/patients'));
const homonymes = (listeApres.patients ?? []).filter((p) => p.nom === 'PONT Verif');
verifier('un seul dossier pour cette personne', homonymes.length === 1, `${homonymes.length} fiche(s)`);

// ---- 5. LE CONTEXTE QUE LIRONT LES VRAIS GENERATEURS -----------------------
const contexte = await json(await commeMedecin(`/api/patients/${patientId}/contexte`));
verifier(
  'la pre-consultation alimente le contexte de generation',
  contexte.vide === false && (contexte.documents ?? []).some((d) => d.type === 'intake'),
);

// ---- 6. LES DOCUMENTS SE RATTACHENT AU PATIENT ------------------------------
const doc = await commeMedecin('/api/documents', {
  method: 'POST',
  corps: {
    patientId,
    patientNom: 'PONT Verif',
    type: 'cr',
    typeLabel: 'Compte rendu de consultation',
    contenu: 'COMPTE RENDU\n\nVerification du pont.',
  },
});
const corpsDoc = await json(doc);
const documentId = corpsDoc.document ? corpsDoc.document.id : corpsDoc.id;
verifier('un document se rattache au patient', doc.ok && Boolean(documentId), `HTTP ${doc.status}`);

// Rafraichissement : on relit depuis le serveur, sans aucun etat local.
const fiche = await json(await commeMedecin(`/api/patients/${patientId}`));
const tous = (fiche.jours ?? []).flatMap((j) => j.documents ?? []);
verifier('le document survit au rafraichissement', tous.some((d) => d.id === documentId));

// ---- 7. UN CABINET INCONNU EST REFUSE --------------------------------------
const inconnu = await commeMoteur({
  tenant_id: 'org-qui-n-existe-pas',
  intake_id: '',
  source_patient_ref: 'x',
  patient: { first_name: 'A', last_name: 'B', date_of_birth: null },
  patient_summary: { patho: '', traitements: '', allergies: '' },
});
verifier('un cabinet inconnu est refuse', inconnu.status === 404, `HTTP ${inconnu.status}`);

const echecs = resultats.filter((r) => !r.ok);
console.log('');
console.log(`compte de verification : ${compte.email}`);
console.log(echecs.length === 0 ? 'VERDICT : LE PONT FONCTIONNE SUR LE VRAI DEPLOIEMENT' : `VERDICT : ${echecs.length} ECHEC(S)`);
process.exit(echecs.length === 0 ? 0 : 1);
