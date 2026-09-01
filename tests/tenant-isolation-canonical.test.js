/**
 * ============================================================================
 *  DEUX CABINETS, DANS LE VRAI ARKIBA
 * ============================================================================
 *
 * Le cloisonnement du moteur a ses propres tests. Celui-ci porte sur la
 * FRONTIERE : est-ce que le cabinet transmis au moteur vient bien du compte
 * connecte, et jamais de ce que le navigateur pretend etre ?
 *
 * Le gap qui a rendu ce fichier necessaire : aucun utilisateur ne portait
 * d'organisation. TOUS retombaient sur le cabinet de laboratoire — et le
 * cloisonnement pose plus bas ne cloisonnait rien, faute de deux valeurs
 * differentes a comparer.
 *
 * Run : npx jest tests/tenant-isolation-canonical.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-tenant-'));
process.env.DATA_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.INTAKE_SERVICE_TOKEN = 'test-intake-token';
process.env.NODE_ENV = 'test';

/**
 * Moteur factice qui ne rend QUE ce qui appartient au cabinet demande. C'est
 * ainsi que le vrai moteur se comporte depuis le cloisonnement des lectures :
 * un dossier demande avec le mauvais cabinet n'existe pas.
 */
const DOSSIERS = {
  'org-1': { enc: 'enc_alpha', patient: 'Alpha MARTIN' },
  'org-2': { enc: 'enc_beta', patient: 'Beta DURAND' },
};
const vus = [];
const moteur = http.createServer((req, res) => {
  const tenant = req.headers['x-arkiba-tenant'];
  vus.push({ url: req.url.split('?')[0], tenant });
  const json = (o, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const mien = DOSSIERS[tenant];

  if (req.url === '/api/encounters') {
    return json({ encounters: mien ? [{ encounter_id: mien.enc, patient_name: mien.patient, status: 'READY_FOR_DOCTOR' }] : [] });
  }
  const m = req.url.match(/^\/api\/encounters\/([^/?]+)/);
  if (m) {
    // Le dossier n'appartient au cabinet demande que si c'est LE sien.
    if (!mien || m[1] !== mien.enc) return json({ error: 'consultation introuvable' }, 404);
    return json({ encounter: { encounter_id: mien.enc, patient: { last_name: mien.patient } } });
  }
  return json({ error: 'inconnu' }, 404);
});

let request, app, tokenA, tokenB;

async function inscrire(email) {
  await request(app).post('/api/auth/register').send({
    prenom: 'Dr', nom: email.split('@')[0], email, password: 'TestPassword1',
    specialites: ['Anesthésiste-réanimateur'], ville: 'Paris',
  });
  const co = await request(app).post('/api/auth/login').send({ email, password: 'TestPassword1' });
  return co.body.token;
}

beforeAll(async () => {
  await new Promise((r) => moteur.listen(0, '127.0.0.1', r));
  process.env.INTAKE_ENGINE_URL = `http://127.0.0.1:${moteur.address().port}`;
  request = require('supertest');
  app = require('../server');
  tokenA = await inscrire(`cabinet.a.${Date.now()}@example.com`);
  tokenB = await inscrire(`cabinet.b.${Date.now()}@example.com`);
});

afterAll(() => {
  moteur.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const commeA = (r) => r.set('Authorization', `Bearer ${tokenA}`);
const commeB = (r) => r.set('Authorization', `Bearer ${tokenB}`);

describe('chaque medecin a son propre cabinet', () => {
  test('un compte recoit une organisation des l\'inscription', () => {
    const users = JSON.parse(fs.readFileSync(path.join(TMP, 'users.json'), 'utf8')).users;
    for (const u of users) {
      expect(u.organizationId).toBeTruthy();
      // Le cabinet de laboratoire n'est plus le sort commun de tout le monde.
      expect(u.organizationId).not.toBe('tenant-demo');
    }
    // Deux comptes, deux cabinets DIFFERENTS.
    expect(users[0].organizationId).not.toBe(users[1].organizationId);
  });

  test('le cabinet transmis au moteur vient du COMPTE, pas de la requete', async () => {
    vus.length = 0;
    await commeA(request(app).get('/api/preconsult/encounters'));
    await commeB(request(app).get('/api/preconsult/encounters'));
    const tenants = vus.map((v) => v.tenant);
    expect(tenants[0]).toBe('org-1');
    expect(tenants[1]).toBe('org-2');
  });

  test('un en-tete de cabinet envoye par le CLIENT est ignore', async () => {
    // C'est l'attaque la plus simple : pretendre etre un autre cabinet.
    vus.length = 0;
    await commeA(request(app).get('/api/preconsult/encounters')).set('x-arkiba-tenant', 'org-2');
    expect(vus[0].tenant).toBe('org-1');
    expect(vus[0].tenant).not.toBe('org-2');
  });
});

describe('un medecin ne voit que ses dossiers', () => {
  test('A voit Alpha, et Alpha seulement', async () => {
    const res = await commeA(request(app).get('/api/preconsult/encounters'));
    expect(res.body.encounters).toHaveLength(1);
    expect(res.body.encounters[0].patient_name).toBe('Alpha MARTIN');
  });

  test('B voit Beta, et Beta seulement', async () => {
    const res = await commeB(request(app).get('/api/preconsult/encounters'));
    expect(res.body.encounters).toHaveLength(1);
    expect(res.body.encounters[0].patient_name).toBe('Beta DURAND');
  });
});

describe('connaitre l\'identifiant de l\'autre ne sert a rien', () => {
  test('A demande le dossier de B avec son identifiant exact : introuvable', async () => {
    const res = await commeA(request(app).get('/api/preconsult/encounters/enc_beta'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Beta');
  });

  test('B demande le dossier de A : introuvable', async () => {
    const res = await commeB(request(app).get('/api/preconsult/encounters/enc_alpha'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('Alpha');
  });

  test('chacun accede au sien', async () => {
    expect((await commeA(request(app).get('/api/preconsult/encounters/enc_alpha'))).status).toBe(200);
    expect((await commeB(request(app).get('/api/preconsult/encounters/enc_beta'))).status).toBe(200);
  });

  test('ECRIRE sur le dossier de l\'autre est refuse', async () => {
    const res = await commeA(request(app).put('/api/preconsult/encounters/enc_beta/notes'))
      .send({ text: 'note volee', entry: 'typed' });
    expect(res.status).toBe(404);
  });

  test('TRANSFERER le dossier de l\'autre est refuse', async () => {
    // Le pire cas : envoyer le dossier d'un patient d'un autre cabinet dans
    // son propre logiciel metier.
    const res = await commeA(request(app).post('/api/preconsult/encounters/enc_beta/transfer'))
      .send({ selection: { intake_structured_data: true, clinical_notes: false, document_ids: [] } });
    expect(res.status).toBe(404);
  });
});
