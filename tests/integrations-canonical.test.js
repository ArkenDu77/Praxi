/**
 * ============================================================================
 *  RACCORDER L'AGENDA, DEPUIS LE VRAI ARKIBA
 * ============================================================================
 *
 * Le medecin ne doit ouvrir qu'un seul produit. L'etat de sa connexion
 * Doctolib se lit donc ICI, et l'action se declenche d'ici.
 *
 * Ce que ce fichier verifie n'est pas le moteur (il a ses propres tests) :
 * c'est la FENETRE d'Arkiba dessus. Surtout, qu'elle n'invente aucune
 * identite — un client ne doit pas pouvoir preparer une connexion au nom d'un
 * confrere, meme dans son propre cabinet.
 *
 * Run : npx jest tests/integrations-canonical.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-integrations-'));
process.env.DATA_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.INTAKE_SERVICE_TOKEN = 'test-intake-token';
process.env.ARKIBA_ENGINE_TOKEN = 'jeton-sortant-de-test-suffisamment-long-01';
process.env.NODE_ENV = 'test';

/** Moteur factice qui enregistre ce qu'Arkiba lui envoie. */
const recu = [];
const moteur = http.createServer((req, res) => {
  let corps = '';
  req.on('data', (c) => (corps += c));
  req.on('end', () => {
    const body = corps ? JSON.parse(corps) : {};
    recu.push({
      methode: req.method,
      url: req.url,
      tenant: req.headers['x-arkiba-tenant'],
      body,
    });
    const json = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.url === '/api/integrations' && req.method === 'GET') {
      return json({
        integrations: [{
          connector_id: 'cnx_1', kind: 'doctolib_browser', state: 'NEEDS_REAUTH',
          display_name: 'Dr Test', last_sync_at: null,
          reauth_required_at: '2026-09-02T08:00:00.000Z', last_error: null, pilote: true,
        }],
      });
    }
    if (req.url === '/api/integrations' && req.method === 'POST') {
      return json({ integration: { connector_id: 'cnx_1', state: 'AWAITING_OPERATOR', pilote: true } }, 201);
    }
    if (req.url === '/api/integrations/cnx_1/revoke') {
      return json({ integration: { connector_id: 'cnx_1', state: 'REVOKED', pilote: true } });
    }
    return json({ error: 'route factice inconnue' }, 404);
  });
});

let request, app, tok, moi;

beforeAll(async () => {
  await new Promise((r) => moteur.listen(0, '127.0.0.1', r));
  process.env.INTAKE_ENGINE_URL = `http://127.0.0.1:${moteur.address().port}`;
  request = require('supertest');
  app = require('../server');
  const email = `integrations.${Date.now()}@example.com`;
  await request(app).post('/api/auth/register').send({
    prenom: 'Ada', nom: 'Lovelace', email, password: 'TestPassword1',
    specialites: ['Anesthésiste-réanimateur'], ville: 'Paris',
  });
  const co = await request(app).post('/api/auth/login').send({ email, password: 'TestPassword1' });
  tok = co.body.token;
  moi = email;
  if (!tok) throw new Error(`connexion impossible : ${JSON.stringify(co.body)}`);
});

afterAll(() => {
  moteur.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const auth = (r) => r.set('Authorization', `Bearer ${tok}`);

describe('intégrations dans le vrai Arkiba', () => {
  test('sans session Arkiba, rien n\'est visible', async () => {
    expect((await request(app).get('/api/integrations')).status).toBe(401);
    expect((await request(app).post('/api/integrations/doctolib')).status).toBe(401);
  });

  test('le médecin voit l\'état de sa connexion', async () => {
    const res = await auth(request(app).get('/api/integrations'));
    expect(res.status).toBe(200);
    expect(res.body.integrations[0].state).toBe('NEEDS_REAUTH');
    // Le statut pilote traverse : l'écran ne doit pas laisser croire à une
    // intégration officiellement supportée par Doctolib.
    expect(res.body.integrations[0].pilote).toBe(true);
  });

  test('la demande porte le CABINET de la session', async () => {
    recu.length = 0;
    await auth(request(app).get('/api/integrations'));
    expect(recu[0].tenant).toMatch(/^org-/);
  });

  test('l\'identité du médecin vient de la SESSION, pas du corps', async () => {
    // L'attaque : préparer une connexion au nom d'un confrère. Le corps envoyé
    // par le client est ignoré — le proxy compose le sien.
    recu.length = 0;
    const res = await auth(request(app).post('/api/integrations/doctolib'))
      .send({ doctor_id: 'confrere-usurpe', kind: 'doctolib_official' });
    expect(res.status).toBe(201);
    expect(recu[0].body.doctor_id).not.toBe('confrere-usurpe');
    // Et le type reste le connecteur PILOTE : un client ne s'octroie pas une
    // intégration officielle en la demandant.
    expect(recu[0].body.kind).toBe('doctolib_browser');
  });

  test('la déconnexion est relayée telle quelle', async () => {
    const res = await auth(request(app).post('/api/integrations/cnx_1/revoke')).send({});
    expect(res.status).toBe(200);
    expect(res.body.integration.state).toBe('REVOKED');
  });

  test('aucun mot de passe ne traverse Arkiba, dans aucun sens', async () => {
    // Le médecin s'authentifie lui-même dans le navigateur dédié. Rien de ce
    // qu'il y saisit ne passe par ces routes — et rien ici ne le demande.
    const envoye = JSON.stringify(recu);
    expect(envoye).not.toMatch(/password|mot_de_passe|mdp/i);
  });

  test('un moteur injoignable est un état, pas une page blanche', async () => {
    const port = moteur.address().port;
    await new Promise((r) => moteur.close(r));
    const res = await auth(request(app).get('/api/integrations'));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/injoignable/i);
    await new Promise((r) => moteur.listen(port, '127.0.0.1', r));
  });
});

describe('l\'écran existe et dit la vérité', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  test('la section Intégrations est atteignable depuis le menu', () => {
    expect(page).toContain('data-view="integrations"');
    expect(page).toContain('id="view-integrations"');
  });

  test('chaque état porte une action, ou dit explicitement qu\'il n\'y en a pas', () => {
    // Un écran qui affiche « erreur » sans dire quoi faire laisse le médecin
    // devant un mur.
    for (const etat of ['DISCONNECTED', 'AWAITING_OPERATOR', 'CONNECTED', 'NEEDS_REAUTH',
                        'TEMPORARILY_UNAVAILABLE', 'REVOKED']) {
      expect(page).toContain(`${etat}: {`);
    }
    expect(page).toContain('Reconnecter Doctolib');
    expect(page).toContain('Connecter Doctolib');
  });

  test('l\'écran annonce un raccordement PILOTE', () => {
    expect(page).toContain('raccordement pilote');
  });

  test('il prévient le médecin de ce qui va se passer AVANT le clic', () => {
    // Une fenêtre qui s'ouvre sans prévenir se fait refermer.
    expect(page).toContain('Ce qui va se passer');
    expect(page).toMatch(/Arkiba ne voit ni votre mot de passe/);
  });

  test('la couleur ne porte jamais l\'information toute seule', () => {
    // Un médecin daltonien, ou une capture d'écran en noir et blanc, doivent
    // lire le même état.
    expect(page).toContain("titre: 'Connecté'");
    expect(page).toContain("titre: 'Reconnexion nécessaire'");
  });
});
