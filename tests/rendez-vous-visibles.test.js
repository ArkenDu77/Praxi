/**
 * ============================================================================
 *  LA PROMESSE « VOS RENDEZ-VOUS RESTENT VISIBLES » DOIT ETRE VRAIE
 * ============================================================================
 *
 * Arkiba affiche, sous le reglage « Appels Arkiba » eteint, cette phrase :
 *
 *     « Arkiba n'appelle personne. Vos rendez-vous restent visibles, sans
 *       appel. »
 *
 * Elle etait fausse. Un cabinet a connecte son agenda Doctolib, laisse les
 * appels eteints, cree un rendez-vous — et n'a rien vu du tout. Le moteur
 * l'avait pourtant bien importe : etat BLOCKED, aucun appel, aucun dossier.
 * Simplement, aucun ecran ne le montrait, parce que la seule liste existante
 * etait celle des DOSSIERS, et qu'un rendez-vous non appele n'en a pas.
 *
 * Ce banc tient les deux bouts : le relais existe et authentifie, et l'ecran
 * qui consomme ce relais existe aussi. Une promesse sans surface pour la
 * tenir est un bug, pas une fonctionnalite manquante.
 *
 * Run : npx jest tests/rendez-vous-visibles.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-rdv-'));
process.env.DATA_DIR = TMP;
process.env.JWT_SECRET = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.INTAKE_SERVICE_TOKEN = 'test-intake-token';
process.env.NODE_ENV = 'test';

/** Ce que le vrai moteur rend pour un cabinet qui n'a pas active les appels. */
const LIGNE = {
  source_appointment_id: 'event-fictif-1',
  state: 'BLOCKED',
  call_id: null,
  blockers: ['CALLS_DISABLED_FOR_TENANT'],
  rendez_vous: { patient: 'MARTIN Alpha', starts_at: '2026-09-09T10:00:00', reason: 'Consultation de suivi' },
  sans_preconsultation: 'appels_desactives',
};

const recu = [];
const moteur = http.createServer((req, res) => {
  recu.push(`${req.method} ${req.url.split('?')[0]}`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ outbound_configured: false, missing_config: [], calls: [LIGNE] }));
});

let request, app, tok;

beforeAll(async () => {
  await new Promise((r) => moteur.listen(0, '127.0.0.1', r));
  process.env.INTAKE_ENGINE_URL = `http://127.0.0.1:${moteur.address().port}`;
  request = require('supertest');
  app = require('../server');
  const email = `medecin.rdv.${Date.now()}@example.com`;
  await request(app).post('/api/auth/register').send({
    prenom: 'Ada', nom: 'Lovelace', email, password: 'TestPassword1',
    specialites: ['Anesthésiste-réanimateur'], ville: 'Paris',
  });
  const connexion = await request(app).post('/api/auth/login').send({ email, password: 'TestPassword1' });
  tok = connexion.body.token;
  if (!tok) throw new Error(`connexion medecin impossible : ${JSON.stringify(connexion.body)}`);
});

afterAll(() => {
  try { moteur.close(); } catch (_) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const auth = (r) => r.set('Authorization', `Bearer ${tok}`);

describe('le relais des rendez-vous détectés', () => {
  test('sans session Arkiba, le proxy refuse', async () => {
    const res = await request(app).get('/api/preconsult/rendez-vous');
    expect(res.status).toBe(401);
  });

  test('le médecin voit le rendez-vous que personne n\'a appelé', async () => {
    const res = await auth(request(app).get('/api/preconsult/rendez-vous'));
    expect(res.status).toBe(200);
    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].rendez_vous.patient).toBe('MARTIN Alpha');
    expect(res.body.calls[0].sans_preconsultation).toBe('appels_desactives');
    // Aucun appel n'a eu lieu, et l'ecran ne doit surtout pas laisser croire
    // qu'un dossier clinique existe.
    expect(res.body.calls[0].call_id).toBeNull();
  });

  test('c\'est bien la liste du moteur qui est lue, pas une invention d\'Arkiba', async () => {
    recu.length = 0;
    await auth(request(app).get('/api/preconsult/rendez-vous'));
    expect(recu).toContain('GET /api/source-appointments');
  });
});

describe('l\'écran qui tient la promesse', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

  test('la promesse existe toujours dans l\'écran de liaison', () => {
    // Si cette phrase disparait un jour, les tests suivants n'ont plus de
    // raison d'etre — et il faut le decider, pas le subir.
    expect(source).toContain('Vos rendez-vous restent visibles, sans appel.');
  });

  test('une surface consomme réellement le relais', () => {
    // Le bug d'origine : la promesse etait affichee, et rien ne l'honorait.
    expect(source).toContain("api('/api/preconsult/rendez-vous')");
    expect(source).toContain('id="pc-attente-card"');
  });

  test('la liste des rendez-vous se charge en même temps que les dossiers', () => {
    // Un cabinet sans appels n'a AUCUN dossier : si le chargement dependait
    // d'eux, l'ecran resterait vide exactement dans le cas qui compte.
    expect(source).toContain('await pcChargerAttente();');
  });

  test('le motif est écrit pour un médecin, jamais dans la langue du moteur', () => {
    expect(source).toContain('Appels Arkiba désactivés');

    // Aucun code d'exploitant ne doit atteindre le DOM : la ligne peinte ne
    // lit ni `blockers`, ni `state`, uniquement le motif déjà traduit.
    const rendu = source.slice(source.indexOf('liste.innerHTML = vus.map'));
    const ligne = rendu.slice(0, rendu.indexOf(".join('');"));
    expect(ligne).toContain('PC_MOTIFS[v.sans_preconsultation]');
    expect(ligne).not.toContain('blockers');
    expect(ligne).not.toContain('.state');

    // Et chaque motif que le moteur sait produire a bien une phrase.
    for (const motif of ['appels_desactives', 'telephonie_non_configuree',
      'identite_incomplete', 'numero_absent', 'bloque', 'en_cours', 'echec_appel']) {
      expect(source).toContain(`${motif}: '`);
    }
  });

  test('aucun faux dossier clinique n\'est fabriqué pour ces rendez-vous', () => {
    // La ligne ne s'ouvre pas : il n'y a rien dessous, et le curseur doit le
    // dire. `pc-row-inerte` est exactement ce refus.
    expect(source).toContain('pc-row pc-row-inerte');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
    expect(css).toContain('.pc-row-inerte { cursor: default; }');
  });
});

describe('un moteur injoignable', () => {
  test('reste un état, pas une page blanche', async () => {
    await new Promise((r) => moteur.close(r));
    const res = await auth(request(app).get('/api/preconsult/rendez-vous'));
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/injoignable/i);
  });
});
