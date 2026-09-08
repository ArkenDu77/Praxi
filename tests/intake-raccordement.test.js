/**
 * Arkiba — Raccordement arkiba-intake (POST /api/internal/intake-results)
 *
 * Run : npx jest tests/intake-raccordement.test.js
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-intake-'));
process.env.DATA_DIR             = TMP;
process.env.JWT_SECRET           = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN          = 'test-admin-token';
process.env.INTAKE_SERVICE_TOKEN = 'test-intake-token';
process.env.NODE_ENV             = 'test';

const request = require('supertest');
const app     = require('../server');
const dossiers = require('../lib/dossiers');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const MEDECIN_EMAIL = `pilote.${Date.now()}@example.com`;

function payloadIntake(overrides = {}) {
  return {
    practitioner_email: MEDECIN_EMAIL,
    intake_id: 'intake_test_001',
    session_id: 'sess_test_001',
    status: 'completed',
    patient: { first_name: 'Jean', last_name: 'Dupont', date_of_birth: '1968-04-12' },
    appointment: { slot_start: '2026-09-01T09:00:00', procedure_raw: 'PTH droite', procedure_normalized: 'Prothèse totale de hanche droite' },
    patient_summary: {
      patho: 'HTA ; Diabète type 2',
      traitements: 'Eliquis 5mg matin et soir',
      allergies: 'Pénicilline (éruption cutanée)',
    },
    document: {
      titre: 'Interrogatoire pré-anesthésique (Arkiba Intake)',
      contenu: '# Pré-consultation\n\nDocument complet de démonstration.',
    },
    created_at: '2026-08-24T10:00:00.000Z',
    updated_at: '2026-08-24T10:05:00.000Z',
    ...overrides,
  };
}

beforeAll(async () => {
  await request(app).post('/api/auth/register').send({
    prenom: 'Pilote', nom: 'Test', email: MEDECIN_EMAIL,
    password: 'TestPassword1', specialites: ['Anesthésiste-réanimateur'], ville: 'Paris',
  });
});

describe('POST /api/internal/intake-results', () => {
  test('refuse sans secret de service', async () => {
    await request(app).post('/api/internal/intake-results').send(payloadIntake()).expect(401);
  });

  test('refuse un mauvais secret', async () => {
    await request(app)
      .post('/api/internal/intake-results')
      .set('x-intake-token', 'mauvais-secret')
      .send(payloadIntake())
      .expect(401);
  });

  test('403/503 quand le service n\'est pas configuré', async () => {
    const previous = process.env.INTAKE_SERVICE_TOKEN;
    // Chaine VIDE, jamais `delete`. Recharger le serveur rejoue son
    // `dotenv.config()` de premiere ligne, et dotenv REMPLIT une variable
    // absente : un `delete` etait annule aussitot par le .env du poste, le
    // secret redevenait present, et la route repondait 401 au lieu de 503.
    // Le test etait donc rouge sur toute machine ayant un .env, et vert sur
    // une machine nue — il ne testait pas ce qu'il croyait.
    process.env.INTAKE_SERVICE_TOKEN = '';
    jest.resetModules();
    const appSansSecret = require('../server');
    await request(appSansSecret)
      .post('/api/internal/intake-results')
      .set('x-intake-token', 'peu-importe')
      .send(payloadIntake())
      .expect(503);
    process.env.INTAKE_SERVICE_TOKEN = previous;
    jest.resetModules();
  });

  test('404 pour un médecin inconnu', async () => {
    const res = await request(app)
      .post('/api/internal/intake-results')
      .set('x-intake-token', 'test-intake-token')
      .send(payloadIntake({ practitioner_email: 'inconnu@example.com', intake_id: 'intake_inconnu' }))
      .expect(404);
    expect(res.body.error).toBeTruthy();
  });

  test('crée la fiche patient et le document attaché', async () => {
    const res = await request(app)
      .post('/api/internal/intake-results')
      .set('x-intake-token', 'test-intake-token')
      .send(payloadIntake())
      .expect(201);

    expect(res.body.ok).toBe(true);
    expect(res.body.created).toBe(true);
    expect(res.body.patientId).toBeTruthy();
    expect(res.body.documentId).toBeTruthy();

    const user = dossiers.readDossiers();
    const patient = user.patients.find(p => p.id === res.body.patientId);
    expect(patient.nom).toBe('Dupont Jean');
    expect(patient.allergies).toMatch(/Pénicilline/);
    expect(patient.traitements).toMatch(/Eliquis/);
    expect(patient.intakeId).toBe('intake_test_001');

    const doc = user.documents.find(d => d.id === res.body.documentId);
    expect(doc.type).toBe('intake');
    expect(doc.meta.intakeId).toBe('intake_test_001');
    expect(doc.contenu).toMatch(/Document complet de démonstration/);
  });

  test('rejouer le même intake_id met à jour la fiche au lieu de la dupliquer', async () => {
    const avant = dossiers.readDossiers().patients.length;
    const res = await request(app)
      .post('/api/internal/intake-results')
      .set('x-intake-token', 'test-intake-token')
      .send(payloadIntake({
        patient_summary: {
          patho: 'HTA ; Diabète type 2 ; mise à jour',
          traitements: 'Eliquis 5mg matin et soir',
          allergies: 'Pénicilline (éruption cutanée)',
        },
      }))
      .expect(200);

    expect(res.body.created).toBe(false);
    const apres = dossiers.readDossiers();
    expect(apres.patients.length).toBe(avant);
    const patient = apres.patients.find(p => p.id === res.body.patientId);
    expect(patient.patho).toMatch(/mise à jour/);
  });

  test('le dossier créé par Intake apparaît dans le contexte de génération', async () => {
    // Un NOUVEL interrogatoire du MÊME patient ne crée pas un second dossier :
    // il enrichit le premier. Sans cela, un patient qui reprend rendez-vous se
    // retrouvait en double, chaque fiche portant la moitié de son histoire —
    // et le médecin lisait ses allergies dans l'une, ses traitements dans
    // l'autre. La réponse est donc 200 (retrouvé), pas 201 (créé).
    const res = await request(app)
      .post('/api/internal/intake-results')
      .set('x-intake-token', 'test-intake-token')
      .send(payloadIntake({ intake_id: 'intake_contexte_002', session_id: 'sess_contexte_002' }))
      .expect(200);

    expect(res.body.created).toBe(false);

    const contexte = dossiers.contextePatient(
      dossiers.readDossiers().patients.find(p => p.id === res.body.patientId).userId,
      res.body.patientId,
    );
    expect(contexte.texte).toMatch(/Pénicilline/);
    expect(contexte.documents.some(d => d.type === 'intake')).toBe(true);
  });
});
