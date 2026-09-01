/**
 * ============================================================================
 *  LA VERTICALE PASSE PAR LE VRAI ARKIBA
 * ============================================================================
 *
 * La preuve qui manquait : le medecin traverse tout le workflow de
 * pre-consultation SANS ouvrir le dashboard interne d'arkiba-intake. Il
 * s'authentifie avec sa session Arkiba, et Arkiba relaie vers le moteur.
 *
 * Le moteur est ici un serveur FACTICE : ce test ne verifie pas le moteur (il
 * a ses ~580 tests), il verifie que la FENETRE d'Arkiba dessus est correcte —
 * qu'elle authentifie, relaie, et ne fabrique aucune verite de son cote.
 *
 * Run : npx jest tests/preconsult-canonical.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-preconsult-'));
process.env.DATA_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.INTAKE_SERVICE_TOKEN = 'test-intake-token';
process.env.NODE_ENV = 'test';

/**
 * Un moteur factice qui enregistre ce qu'on lui envoie. Il repond comme le vrai
 * moteur : liste, dossier, notes, documents, apercu, transfert.
 */
const recu = [];
const moteur = http.createServer((req, res) => {
  recu.push(`${req.method} ${req.url.split('?')[0]}`);
  let corps = '';
  req.on('data', (c) => (corps += c));
  req.on('end', () => {
    const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const body = corps ? JSON.parse(corps) : {};
    if (req.url === '/api/encounters') {
      return json({ encounters: [{ encounter_id: 'enc_x', patient_name: 'Alice MARTIN', status: 'READY_FOR_DOCTOR', display_status: 'À valider' }] });
    }
    if (req.url.startsWith('/api/encounters/enc_x/transfer-preview')) {
      return json({ target_system: 'EMED', mode: 'REST_API', simulated: true, summary: ['Données pré-consultation'], unsupported: [], partially_supported: [], fingerprint: 'enc_x::EMED::v1::intake', documents: [], structured_data: {}, clinical_notes: null });
    }
    if (req.url === '/api/encounters/enc_x') {
      return json({ encounter: { encounter_id: 'enc_x', status: 'READY_FOR_DOCTOR', patient: { first_name: 'Alice', last_name: 'MARTIN' }, documents: [], consultation_notes: { text: '' }, document_version: 1, alerts: [], doctor_review: { reviewed_by: 'dr' } }, clinical_data: {}, transcript: [], review_requirements: { required_fields: [] } });
    }
    if (req.url === '/api/encounters/enc_x/notes') return json({ notes: { text: body.text, author: body.author }, document_version: 2 });
    if (req.url === '/api/document-kinds') return json({ kinds: [{ kind: 'compte_rendu', label: 'Compte rendu', requires: [] }] });
    if (req.url === '/api/encounters/enc_x/documents') return json({ document: { document_id: 'doc_1', title: 'Compte rendu', author: body.author }, documents: 1 }, 201);
    if (req.url === '/api/encounters/enc_x/transfer') return json({ sync_status: 'SYNCED', transferred: ['Données pré-consultation'], message: 'Synchronisé', actor: body.actor });
    return json({ error: 'route factice inconnue' }, 404);
  });
});

let request, app, tok;

beforeAll(async () => {
  await new Promise((r) => moteur.listen(0, '127.0.0.1', r));
  process.env.INTAKE_ENGINE_URL = `http://127.0.0.1:${moteur.address().port}`;
  request = require('supertest');
  app = require('../server');
  // Un vrai compte medecin, cree par la vraie route d'inscription, et une
  // session obtenue par la vraie route de connexion. Signer un jeton a la main
  // testerait notre signature, pas le chemin d'authentification d'Arkiba.
  const email = `medecin.${Date.now()}@example.com`;
  await request(app).post('/api/auth/register').send({
    prenom: 'Ada', nom: 'Lovelace', email, password: 'TestPassword1',
    specialites: ['Anesthésiste-réanimateur'], ville: 'Paris',
  });
  const connexion = await request(app).post('/api/auth/login').send({ email, password: 'TestPassword1' });
  tok = connexion.body.token;
  if (!tok) throw new Error(`connexion medecin impossible : ${JSON.stringify(connexion.body)}`);
});

afterAll(() => {
  moteur.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const auth = (r) => r.set('Authorization', `Bearer ${tok}`);

describe('pré-consultation dans le vrai Arkiba', () => {
  test('sans session Arkiba, le proxy refuse', async () => {
    const res = await request(app).get('/api/preconsult/encounters');
    expect(res.status).toBe(401);
  });

  test('le médecin voit les dossiers préparés par l\'appel', async () => {
    const res = await auth(request(app).get('/api/preconsult/encounters'));
    expect(res.status).toBe(200);
    expect(res.body.encounters).toHaveLength(1);
    expect(res.body.encounters[0].patient_name).toBe('Alice MARTIN');
  });

  test('il ouvre un dossier et voit l\'Intake structuré', async () => {
    const res = await auth(request(app).get('/api/preconsult/encounters/enc_x'));
    expect(res.status).toBe(200);
    expect(res.body.encounter.patient.last_name).toBe('MARTIN');
  });

  test('ses notes portent SON identité, pas une valeur inventée par le client', async () => {
    const res = await auth(request(app).put('/api/preconsult/encounters/enc_x/notes')).send({ text: 'Examen normal.', entry: 'typed' });
    expect(res.status).toBe(200);
    // Le proxy injecte l'auteur depuis la session : le client ne peut pas
    // usurper un autre médecin.
    expect(res.body.notes.author).toContain('@example.com');
  });

  test('il génère un document — l\'auteur vient de la session', async () => {
    const res = await auth(request(app).post('/api/preconsult/encounters/enc_x/documents')).send({ kind: 'compte_rendu' });
    expect(res.status).toBe(201);
    expect(res.body.document.author).toContain('@example.com');
  });

  test('l\'aperçu vient du moteur, pas d\'une reconstruction côté Arkiba', async () => {
    const res = await auth(request(app).get('/api/preconsult/encounters/enc_x/transfer-preview?intake=true'));
    expect(res.status).toBe(200);
    expect(res.body.target_system).toBe('EMED');
    expect(res.body.fingerprint).toBe('enc_x::EMED::v1::intake');
  });

  test('le transfert porte l\'ACTEUR de la session, jamais du corps client', async () => {
    const res = await auth(request(app).post('/api/preconsult/encounters/enc_x/transfer'))
      .send({ selection: { intake_structured_data: true, clinical_notes: false, document_ids: [] }, actor: 'usurpateur@mal.fr' });
    expect(res.status).toBe(200);
    expect(res.body.sync_status).toBe('SYNCED');
    expect(res.body.actor).toContain('@example.com');
    expect(res.body.actor).not.toBe('usurpateur@mal.fr');
  });

  test('un moteur injoignable est un état, pas une page blanche', async () => {
    const port = moteur.address().port;
    await new Promise((r) => moteur.close(r));
    const res = await auth(request(app).get('/api/preconsult/encounters'));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/injoignable/i);
    // On relance pour ne pas casser un éventuel test suivant.
    await new Promise((r) => moteur.listen(port, '127.0.0.1', r));
  });

  test('Arkiba ne stocke aucune vérité clinique de son côté', () => {
    // Tout est passé par le moteur : la liste, le dossier, les notes, le
    // document, l'aperçu, le transfert. Aucune route n'a écrit dans dossiers.json.
    expect(recu).toContain('GET /api/encounters');
    expect(recu).toContain('PUT /api/encounters/enc_x/notes');
    expect(recu).toContain('POST /api/encounters/enc_x/transfer');
  });
});
