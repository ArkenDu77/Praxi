/**
 * ============================================================================
 *  LA PRÉ-CONSULTATION EST UN ÉPISODE DU PATIENT, PAS UN PRODUIT PARALLÈLE
 * ============================================================================
 *
 * Arkiba possède déjà des patients, des documents, un compte rendu, une lettre
 * de liaison. La pré-consultation les avait redoublés : elle créait ses propres
 * documents, dans le moteur, avec un autre générateur — donc un autre prompt,
 * un autre référentiel de spécialité, d'autres garde-fous — et ces documents
 * n'étaient rattachés à aucun patient. Deux qualités de document dans le même
 * produit, sans que rien ne le dise, et rien qui survive à un rafraîchissement.
 *
 * Ce banc tient la jonction. Ce qu'il exige :
 *
 *   1. un rendez-vous détecté crée un VRAI patient, dans la seule liste de
 *      patients qui existe ;
 *   2. le même patient qui reprend rendez-vous retrouve SON dossier — jamais
 *      un second ;
 *   3. deux personnes homonymes ne fusionnent pas ;
 *   4. le document d'interrogatoire est rattaché au patient, donc repris par
 *      le contexte que lisent les vrais générateurs ;
 *   5. les documents générés sont de vrais documents Arkiba, rattachés au
 *      patient, et ils survivent au rafraîchissement ;
 *   6. le compte rendu et la lettre de liaison continuent de fonctionner
 *      SANS aucune pré-consultation.
 *
 * Run : npx jest tests/preconsultation-dans-arkiba.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-pc-'));
process.env.DATA_DIR             = TMP;
process.env.JWT_SECRET           = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN          = 'test-admin-token';
process.env.INTAKE_SERVICE_TOKEN = 'test-intake-token';
process.env.NODE_ENV             = 'test';

const request  = require('supertest');
const app      = require('../server');
const dossiers = require('../lib/dossiers');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const MEDECIN = `pc.${Date.now()}@example.com`;
let jeton;
let cabinet;

/** Ce que le moteur remet quand il détecte un rendez-vous : l'identité seule. */
const rendezVousDetecte = (overrides = {}) => ({
  tenant_id: cabinet,
  intake_id: '',
  source_patient_ref: 'doctolib-patient-77',
  patient: { first_name: 'Marius', last_name: 'GIBEAU', date_of_birth: '1979-03-02' },
  patient_summary: { patho: '', traitements: '', allergies: '' },
  ...overrides,
});

/** Ce que le moteur remet APRÈS l'appel : le dossier clinique. */
const interrogatoireTermine = (overrides = {}) => ({
  tenant_id: cabinet,
  intake_id: 'intake_pc_001',
  session_id: 'sess_pc_001',
  source_patient_ref: 'doctolib-patient-77',
  status: 'completed',
  patient: { first_name: 'Marius', last_name: 'GIBEAU', date_of_birth: '1979-03-02' },
  patient_summary: {
    patho: 'Hypertension non traitée',
    traitements: 'Doliprane ; Aerius',
    allergies: 'Aucune signalée',
  },
  document: {
    titre: 'Interrogatoire pré-anesthésique',
    contenu: '# Pré-consultation\n\nCapacité à l\'effort : 10 étages sans s\'arrêter.',
  },
  ...overrides,
});

const commeMoteur = (corps) =>
  request(app).post('/api/internal/intake-results').set('x-intake-token', 'test-intake-token').send(corps);

const auth = (r) => r.set('Authorization', `Bearer ${jeton}`);

beforeAll(async () => {
  await request(app).post('/api/auth/register').send({
    prenom: 'Faiez', nom: 'Demo', email: MEDECIN,
    password: 'TestPassword1', specialites: ['Anesthésiste-réanimateur'], ville: 'Paris',
  });
  const connexion = await request(app).post('/api/auth/login').send({ email: MEDECIN, password: 'TestPassword1' });
  jeton = connexion.body.token;
  if (!jeton) throw new Error(`connexion impossible : ${JSON.stringify(connexion.body)}`);
  const monCabinet = await auth(request(app).get('/api/mon-cabinet'));
  cabinet = monCabinet.body.cabinet;
  if (!cabinet) throw new Error('cabinet introuvable pour ce compte');
});

describe('le rendez-vous détecté crée un vrai patient Arkiba', () => {
  let patientId;

  test('LE PATIENT EXISTE DÈS LA DÉTECTION, sans attendre l\'appel', async () => {
    // Avant, la fiche n'apparaissait qu'après l'interrogatoire : entre la
    // détection et la fin de l'appel — le moment où le médecin regarde son
    // écran — le patient n'existait nulle part.
    const res = await commeMoteur(rendezVousDetecte()).expect(201);
    expect(res.body.created).toBe(true);
    patientId = res.body.patientId;
    expect(patientId).toBeTruthy();
    // Aucune donnée clinique n'est inventée à ce stade.
    expect(res.body.documentId).toBeNull();
  });

  test('IL EST VISIBLE DANS L\'ONGLET PATIENTS — la seule liste qui existe', async () => {
    const liste = await auth(request(app).get('/api/patients')).expect(200);
    const sien = liste.body.patients.find((p) => p.id === patientId);
    expect(sien).toBeTruthy();
    expect(sien.nom).toBe('GIBEAU Marius');
  });

  test('LE CABINET DÉSIGNE LE MÉDECIN — aucun email codé quelque part', async () => {
    // Le destinataire était nommé par une variable d'environnement contenant
    // UN email : un seul cabinet pouvait recevoir ses patients, et il fallait
    // un déploiement pour en brancher un second.
    const res = await commeMoteur(rendezVousDetecte({ tenant_id: 'org-inexistant' })).expect(404);
    expect(res.body.error).toMatch(/cabinet/i);
  });

  test('L\'INTERROGATOIRE ENRICHIT CETTE FICHE, il n\'en crée pas une seconde', async () => {
    const avant = dossiers.readDossiers().patients.length;
    const res = await commeMoteur(interrogatoireTermine()).expect(200);
    expect(res.body.created).toBe(false);
    expect(res.body.patientId).toBe(patientId);
    expect(dossiers.readDossiers().patients.length).toBe(avant);

    const fiche = await auth(request(app).get(`/api/patients/${patientId}`)).expect(200);
    expect(fiche.body.patient.traitements).toMatch(/Doliprane/);
  });

  test('LE DOCUMENT D\'INTERROGATOIRE EST RATTACHÉ AU PATIENT', async () => {
    // C'est ce rattachement qui fait que les VRAIS générateurs reprennent la
    // pré-consultation : ils lisent le contexte du patient, pas un canal à part.
    const contexte = dossiers.contextePatient(
      dossiers.readDossiers().patients.find((p) => p.id === patientId).userId,
      patientId,
    );
    expect(contexte.documents.some((d) => d.type === 'intake')).toBe(true);
    expect(contexte.texte).toMatch(/étages/);
  });
});

describe('le même patient qui reprend rendez-vous garde son dossier', () => {
  test('UN SECOND RENDEZ-VOUS NE CRÉE PAS DE DOUBLON', async () => {
    const avant = dossiers.readDossiers().patients.length;
    const res = await commeMoteur(
      interrogatoireTermine({ intake_id: 'intake_pc_002', session_id: 'sess_pc_002' }),
    ).expect(200);
    expect(res.body.created).toBe(false);
    expect(dossiers.readDossiers().patients.length).toBe(avant);
  });

  test('DEUX HOMONYMES NE FUSIONNENT PAS', async () => {
    // Fusionner deux patients est irréparable : leurs antécédents, leurs
    // traitements et leurs allergies se mélangent, et le médecin lit ensuite
    // l'allergie de quelqu'un d'autre. Dans le doute, on crée un dossier.
    const avant = dossiers.readDossiers().patients.length;
    const res = await commeMoteur(
      rendezVousDetecte({
        source_patient_ref: 'doctolib-patient-99',
        patient: { first_name: 'Marius', last_name: 'GIBEAU', date_of_birth: '1991-11-30' },
      }),
    ).expect(201);
    expect(res.body.created).toBe(true);
    expect(dossiers.readDossiers().patients.length).toBe(avant + 1);
  });

  test('un patient sans date de naissance ne se rapproche pas sur le nom seul', async () => {
    const avant = dossiers.readDossiers().patients.length;
    await commeMoteur(
      rendezVousDetecte({
        source_patient_ref: 'doctolib-patient-123',
        patient: { first_name: 'Marius', last_name: 'GIBEAU', date_of_birth: null },
      }),
    ).expect(201);
    expect(dossiers.readDossiers().patients.length).toBe(avant + 1);
  });
});

describe('les documents générés sont de vrais documents du patient', () => {
  let patientId;

  beforeAll(() => {
    // On désigne le patient par sa RÉFÉRENCE SOURCE, pas par son nom : les
    // tests d'homonymie ont volontairement créé plusieurs « GIBEAU Marius »,
    // et c'est précisément ce qu'on veut pouvoir distinguer.
    patientId = dossiers.readDossiers().patients
      .find((p) => p.sourcePatientRef === 'doctolib-patient-77').id;
  });

  test('UN DOCUMENT GÉNÉRÉ SE RATTACHE AU PATIENT ET SURVIT AU RAFRAÎCHISSEMENT', async () => {
    // L'écran archivait dans son propre état : le document disparaissait au
    // rafraîchissement et n'appartenait à personne.
    const cree = await auth(
      request(app).post('/api/documents').send({
        patientId,
        patientNom: 'GIBEAU Marius',
        type: 'cr',
        typeLabel: 'Compte rendu de consultation',
        contenu: 'COMPTE RENDU\n\nPatient vu ce jour.',
      }),
    ).expect(201);
    const documentId = cree.body.document ? cree.body.document.id : cree.body.id;
    expect(documentId).toBeTruthy();

    // Rafraîchissement : on relit depuis le serveur, sans aucun état local.
    const relu = await auth(request(app).get(`/api/patients/${patientId}`)).expect(200);
    const tousLesDocs = (relu.body.jours || []).flatMap((j) => j.documents || []);
    expect(tousLesDocs.some((d) => d.id === documentId)).toBe(true);
  });

  test('LE DOCUMENT APPARAÎT AUSSI DANS L\'HISTORIQUE FILTRÉ PAR PATIENT', async () => {
    const historique = await auth(request(app).get(`/api/documents?patientId=${patientId}`)).expect(200);
    expect(historique.body.documents.some((d) => d.type === 'cr')).toBe(true);
  });
});

describe('le reste du produit continue de fonctionner sans pré-consultation', () => {
  test('UN PATIENT CRÉÉ À LA MAIN RESTE POSSIBLE', async () => {
    const res = await auth(
      request(app).post('/api/patients').send({ nom: 'MARTIN Claire', ddn: '1980-01-15' }),
    ).expect(201);
    expect(res.body.patient.nom).toBe('MARTIN Claire');
  });

  test('UN DOCUMENT SANS PATIENT RESTE POSSIBLE — document isolé', async () => {
    // Le compte rendu et la lettre de liaison doivent marcher sans qu'aucune
    // pré-consultation n'existe : la pré-consultation ENRICHIT, elle ne
    // devient pas obligatoire.
    const res = await auth(
      request(app).post('/api/documents').send({
        patientId: null,
        patientNom: 'Patient',
        type: 'liaison',
        typeLabel: 'Lettre de liaison',
        contenu: 'Chère consœur, …',
      }),
    ).expect(201);
    expect(res.body.document ? res.body.document.type : res.body.type).toBe('liaison');
  });

  test('LE CONTEXTE PATIENT RESTE LISIBLE POUR LES GÉNÉRATEURS', async () => {
    // C'est ce que lisent /api/generate/compte-rendu et /api/generate/liaison.
    const patientId = dossiers.readDossiers().patients
      .find((p) => p.sourcePatientRef === 'doctolib-patient-77').id;
    const contexte = await auth(request(app).get(`/api/patients/${patientId}/contexte`)).expect(200);
    expect(contexte.body.vide).toBe(false);
    // L'aperçu est tronqué pour l'écran ; ce que reçoit le générateur est le
    // texte COMPLET. C'est donc lui qu'on vérifie : la pré-consultation doit
    // y être, sinon le compte rendu serait écrit sans elle.
    const complet = dossiers.contextePatient(
      dossiers.readDossiers().patients.find((p) => p.id === patientId).userId,
      patientId,
    );
    expect(complet.texte).toMatch(/étages|Doliprane/);
  });
});
