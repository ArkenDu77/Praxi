/**
 * Praxi — Tests des garde-fous de sécurité et d'intégrité des données.
 *
 * Chaque bloc correspond à un défaut constaté sur le code réel : le test est
 * écrit pour échouer sur la version d'avant, pas pour décrire l'intention.
 *
 * Run : npx jest tests/securite.test.js
 */

const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-secu-'));
process.env.JWT_SECRET  = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV    = 'test';
process.env.PORT        = '3097';
process.env.DATA_DIR    = TEST_DATA_DIR;
process.env.APP_URL     = 'https://praxi.example.fr';

const app = require('../server');
const { documentSafety, readJsonFile, writeJsonFile } = require('../server');

afterAll(() => { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); });

// ─── CONTRÔLE DES VALEURS CHIFFRÉES ────────────────────────────────────────
// Le contrôle comparait par sous-chaîne : `source.includes('500')` est vrai dès
// que la source contient « 1500 ». Une posologie inventée passait donc sans
// alerte, ce qui est précisément le cas que ce contrôle doit attraper.

describe('documentSafety — valeurs chiffrées non sourcées', () => {
  const medecin = { prenom: 'Ada', nom: 'Test' };

  test('signale une posologie inventée même si ses chiffres apparaissent dans un nombre plus long', () => {
    const source   = 'Traitement en cours : metformine 1500 mg par jour.';
    const document = 'Prescription : amoxicilline 500 mg trois fois par jour.';
    const safety   = documentSafety(document, source, medecin);
    expect(safety.unsupportedNumbers).toContain('500');
    expect(safety.requiresReview).toBe(true);
  });

  test("ne signale pas une valeur réellement présente dans la source", () => {
    const source   = 'Metformine 1000 mg matin et soir.';
    const document = 'Poursuite de la metformine 1000 mg matin et soir.';
    expect(documentSafety(document, source, medecin).unsupportedNumbers).toEqual([]);
  });

  test('tolère les écritures équivalentes du même nombre (1 500 / 1500 / 1500,0)', () => {
    const safety = documentSafety('Dose totale 1500 mg.', 'Dose prescrite : 1 500 mg.', medecin);
    expect(safety.unsupportedNumbers).toEqual([]);
  });

  test("ignore la numérotation des listes, qui n'est pas une valeur clinique", () => {
    const document = '1. Amoxicilline 1000 mg\n2. Paracétamol 1000 mg';
    const safety   = documentSafety(document, 'Amoxicilline 1000 mg, paracétamol 1000 mg', medecin);
    expect(safety.unsupportedNumbers).toEqual([]);
  });

  test("n'alerte pas sur la date du jour, que tout document signé porte", () => {
    const now = new Date();
    const document = `Fait le ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}.`;
    expect(documentSafety(document, 'Consultation de contrôle.', medecin).requiresReview).toBe(false);
  });

  // Signalé en production : le bandeau « valeur(s) sans correspondance — 07 »
  // se déclenchait sur le 07 de « 07 août 2026 ». Une alerte fausse sur un
  // élément aussi visible décrédibilise le vrai signal.
  test("n'alerte pas sur une date écrite en toutes lettres", () => {
    const now = new Date();
    const jour = String(now.getDate()).padStart(2, '0');
    const mois = now.toLocaleDateString('fr-FR', { month: 'long' });
    const document = `Lyon, le ${jour} ${mois} ${now.getFullYear()}\nPatient vu ce jour.`;
    const safety = documentSafety(document, 'Patient vu ce jour.', medecin);
    expect(safety.unsupportedNumbers).toEqual([]);
    expect(safety.requiresReview).toBe(false);
  });

  test("n'alerte pas sur un mois et une année sans quantième", () => {
    const now = new Date();
    const mois = now.toLocaleDateString('fr-FR', { month: 'long' });
    const document = `Bilan de ${mois} ${now.getFullYear()}.`;
    expect(documentSafety(document, 'Bilan.', medecin).requiresReview).toBe(false);
  });

  // Les dates sont retirées par leur forme, pas en autorisant leurs chiffres :
  // autoriser globalement le quantième rendait indétectable une posologie
  // inventée qui vaut ce même nombre, un jour sur trente.
  test('une posologie inventée égale au quantième du jour reste détectée', () => {
    const quantieme = new Date().getDate();
    const safety = documentSafety(`Posologie ${quantieme} mg.`, 'Paracétamol prescrit.', medecin);
    expect(safety.unsupportedNumbers).toContain(String(quantieme));
    expect(safety.requiresReview).toBe(true);
  });
});

// ─── STOCKAGE JSON ─────────────────────────────────────────────────────────
// Un `catch` qui renvoyait une base vide sur un JSON tronqué transformait un
// incident récupérable en perte définitive : la première écriture suivante
// persistait ce vide par-dessus les comptes.

describe('stockage JSON — lecture et écriture', () => {
  test('un fichier absent donne la valeur par défaut', () => {
    const file = path.join(TEST_DATA_DIR, 'absent.json');
    expect(readJsonFile(file, { users: [], nextId: 1 })).toEqual({ users: [], nextId: 1 });
  });

  test('un fichier corrompu lève au lieu de se faire passer pour une base vide', () => {
    const file = path.join(TEST_DATA_DIR, 'corrompu.json');
    fs.writeFileSync(file, '{"users":[{"id":1,"email":"dr@exemple.fr"');   // écriture tronquée
    expect(() => readJsonFile(file, { users: [], nextId: 1 })).toThrow(/corrompu/i);
  });

  test("l'écriture est atomique : aucun fichier temporaire ne subsiste", () => {
    const file = path.join(TEST_DATA_DIR, 'atomique.json');
    writeJsonFile(file, { users: [{ id: 1 }], nextId: 2 });
    expect(readJsonFile(file, null)).toEqual({ users: [{ id: 1 }], nextId: 2 });
    expect(fs.readdirSync(TEST_DATA_DIR).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});

// ─── CORS ──────────────────────────────────────────────────────────────────
// La comparaison par préfixe acceptait tout domaine commençant par l'URL de
// production, `https://praxi.example.fr.attaquant.tld` compris.

describe('CORS — origines autorisées', () => {
  test("accepte l'origine de production", async () => {
    const res = await request(app).get('/api/stats').set('Origin', 'https://praxi.example.fr');
    expect(res.headers['access-control-allow-origin']).toBe('https://praxi.example.fr');
  });

  test("refuse un domaine qui se contente de commencer par l'origine autorisée", async () => {
    const res = await request(app).get('/api/stats').set('Origin', 'https://praxi.example.fr.attaquant.tld');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test("n'ouvre pas à tout le monde en l'absence d'en-tête Origin", async () => {
    const res = await request(app).get('/api/stats');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ─── LIMITATION DE DÉBIT ───────────────────────────────────────────────────
// Le compteur était indexé sur la première valeur de X-Forwarded-For, que
// l'appelant contrôle : en faire varier la tête suffisait à obtenir un nouveau
// quota à chaque requête, donc à tenter les mots de passe sans limite.

describe('rate limiting — clé non contrôlable par le client', () => {
  test('varier la tête de X-Forwarded-For ne redonne pas de quota', async () => {
    const vraieIp = '203.0.113.77';
    let refuse = false;
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password')
        .set('X-Forwarded-For', `10.0.0.${i}, ${vraieIp}`)   // tête falsifiée, queue réelle
        .send({ email: 'inconnu@exemple.fr' });
      if (res.status === 429) { refuse = true; break; }
    }
    expect(refuse).toBe(true);
  });
});

// ─── ROUTAGE ───────────────────────────────────────────────────────────────
// Le fallback SPA renvoyait index.html en 200 pour toute route inconnue, y
// compris sous /api : le front recevait du HTML là où il attendait du JSON.

describe('routes API inconnues', () => {
  test('répondent 404 en JSON, pas la page d’accueil en HTML', async () => {
    const res = await request(app).get('/api/route-qui-nexiste-pas');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBeDefined();
  });

  test('le fallback SPA reste actif pour les routes de pages', async () => {
    const res = await request(app).get('/une-page-du-front');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

// ─── SECRETS PAR DÉFAUT ────────────────────────────────────────────────────
// Le garde-fou dépendait de NODE_ENV, qu'aucun hébergeur ne garantit. Un
// JWT_SECRET connu permet de forger un jeton pour n'importe quel compte.

describe('secrets par défaut', () => {
  const lancer = env => {
    try {
      execFileSync(process.execPath, ['-e', 'require("./server")'], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, { NODE_ENV: '', JWT_SECRET: '', ADMIN_TOKEN: '' }, env),
        stdio: 'pipe',
      });
      return { code: 0, err: '' };
    } catch (e) {
      return { code: e.status, err: String(e.stderr || '') };
    }
  };

  test('le serveur refuse de démarrer sans JWT_SECRET, même hors production', () => {
    const r = lancer({ ADMIN_TOKEN: 'un-vrai-token' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/JWT_SECRET/);
  });

  test('le serveur refuse de démarrer sans ADMIN_TOKEN', () => {
    const r = lancer({ JWT_SECRET: 'un-vrai-secret-de-32-caracteres-ok' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ADMIN_TOKEN/);
  });

  test('les secrets par défaut restent utilisables sur demande explicite', () => {
    expect(lancer({ PRAXI_ALLOW_DEV_SECRETS: '1' }).code).toBe(0);
  });

  test('un démarrage avec de vrais secrets passe', () => {
    expect(lancer({ JWT_SECRET: 'un-vrai-secret-de-32-caracteres-ok', ADMIN_TOKEN: 'un-vrai-token' }).code).toBe(0);
  });
});

// ─── GUIDANCE PAR TYPE DE DOCUMENT ─────────────────────────────────────────
// La guidance par défaut était écrite pour la lettre de liaison et servie
// telle quelle sur tous les écrans : sur un compte-rendu, le médecin lisait
// « le dossier permet une lettre de liaison structurée » et des justifications
// adressées à un « spécialiste destinataire » inexistant. Contrairement aux
// libellés d'interface, il s'agissait de contenu généré pour le mauvais
// document — la nuance qui sépare une coquille d'un défaut de routage.

describe('guidance clinique adaptée au type de document', () => {
  const request = require('supertest');
  const app = require('../server');
  const DESTINATAIRE = /lettre de liaison|spécialiste destinataire|confrère/i;
  let token;

  beforeAll(async () => {
    const r = await request(app).post('/api/auth/register').send({
      prenom: 'Guid', nom: 'Ance', email: `guidance.${Date.now()}@example.com`,
      password: 'TestPassword1', specialites: ['Cardiologue'], ville: 'Lyon',
    });
    token = r.body.token;
  });

  const analyser = (documentType, extra = {}) =>
    request(app).post('/api/clinical/analyze')
      .set('Authorization', `Bearer ${token}`)
      .send({ documentType, notes: 'Patient tabagique, FA connue, PA 138/84.', ...extra })
      .then(r => r.body.analysis);

  test('un compte-rendu ne mentionne aucun destinataire', async () => {
    const a = await analyser('cr');
    expect(JSON.stringify(a.deductions) + JSON.stringify(a.suggestions)).not.toMatch(DESTINATAIRE);
    expect(a.deductions[0]).toMatch(/compte-rendu/i);
  });

  test('une ordonnance parle de posologie, pas de courrier', async () => {
    const a = await analyser('ordonnance', { medicaments: 'Bisoprolol 5 mg' });
    expect(JSON.stringify(a.deductions) + JSON.stringify(a.suggestions)).not.toMatch(DESTINATAIRE);
    expect(a.deductions[0]).toMatch(/ordonnance/i);
  });

  test('la lettre de liaison conserve sa guidance orientée destinataire', async () => {
    const a = await analyser('liaison');
    expect(a.deductions[0]).toMatch(/lettre de liaison/i);
  });

  test('le motif d’adressage n’est commenté que pour la lettre', async () => {
    const cr = await analyser('cr', { motif: 'palpitations' });
    expect(JSON.stringify(cr.deductions)).not.toMatch(/adressage/i);
    const liaison = await analyser('liaison', { motif: 'palpitations' });
    expect(JSON.stringify(liaison.deductions)).toMatch(/adressage/i);
  });

  test('un type inconnu retombe sur une guidance sans planter', async () => {
    const a = await analyser('type-inexistant');
    expect(Array.isArray(a.deductions)).toBe(true);
    expect(a.deductions.length).toBeGreaterThan(0);
  });
});
