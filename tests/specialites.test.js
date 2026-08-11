/**
 * Arkiba — Régression : cohérence des listes de spécialités
 *
 * Contexte. Le formulaire « Créer votre compte médecin » a renvoyé
 * « Spécialité requise » pour *toutes* ses options pendant des semaines :
 * register.html embarquait sa propre liste, restée sur un vocabulaire de
 * disciplines (« Médecine générale », « Cardiologie »), alors que le serveur
 * s'était mis à valider contre une liste fermée de praticiens
 * (« Médecin généraliste », « Cardiologue »). Aucun libellé ne correspondait :
 * parseSpecialites() filtrait tout, la liste ressortait vide, la validation
 * échouait. index.html portait exactement le même défaut sur son propre
 * formulaire, qui crée désormais le compte lui aussi.
 *
 * Les tests existants ne pouvaient pas le voir : ils envoyaient le vocabulaire
 * du serveur, jamais celui que le navigateur envoie réellement.
 *
 * Ces tests-ci verrouillent les deux propriétés qui manquaient :
 *   1. les pages ne redéclarent pas de liste en dur, elles la demandent au
 *      serveur (/api/specialites) ;
 *   2. chaque libellé servi est réellement accepté par les routes qui valident.
 */

const fs      = require('fs');
const path    = require('path');
const request = require('supertest');

process.env.JWT_SECRET  = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV    = 'test';
process.env.PORT        = '3098';
process.env.DATA_DIR    = fs.mkdtempSync(path.join(require('os').tmpdir(), 'arkiba-spec-'));

const app = require('../server');

const PUBLIC = path.join(__dirname, '..', 'public');
const lire   = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

/** Le code d'une page, commentaires retirés — ceux-ci citent l'ancien vocabulaire
 *  pour expliquer la panne et ne doivent pas être confondus avec des options. */
const lireSansCommentaires = f => lire(f)
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

let SPECIALITES = [];

beforeAll(async () => {
  const res = await request(app).get('/api/specialites').expect(200);
  SPECIALITES = res.body.specialites;
});

// ─── La liste est servie, et elle est unique ────────────────────────────────

describe('GET /api/specialites', () => {
  test('sert une liste non vide, sans doublon, accessible sans jeton', () => {
    expect(Array.isArray(SPECIALITES)).toBe(true);
    expect(SPECIALITES.length).toBeGreaterThan(10);
    expect(new Set(SPECIALITES).size).toBe(SPECIALITES.length);
    expect(SPECIALITES.every(x => typeof x === 'string' && x.trim() === x && x)).toBe(true);
  });

  test('contient bien « Médecin généraliste » (le cas signalé)', () => {
    expect(SPECIALITES).toContain('Médecin généraliste');
  });
});

describe('les pages ne redéclarent pas la liste en dur', () => {
  for (const page of ['register.html', 'index.html', 'app.html']) {
    test(`${page} peuple son menu depuis /api/specialites`, () => {
      const html = lire(page);
      expect(html).toContain('/api/specialites');
      // Une liste en dur est précisément ce qui a divergé : on refuse qu'elle
      // revienne, quel que soit le vocabulaire employé.
      expect(html).not.toMatch(/const\s+SPECIALITES\s*=\s*\[/);
    });
  }

  test('aucun <option> en dur ne propose de spécialité hors liste', () => {
    // On ne regarde que les <option> réellement proposés : l'ancien vocabulaire
    // subsiste légitimement ailleurs (témoignages « Dr M.L. — Médecine générale »).
    const hors = [];
    for (const page of ['register.html', 'index.html', 'app.html']) {
      const bloc = lireSansCommentaires(page)
        .match(/<select[^>]*name="specialite"[^>]*>[\s\S]*?<\/select>/);
      if (!bloc) continue; // register.html et app.html utilisent le menu .ms
      for (const [, attrs, texte] of bloc[0].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)) {
        const libelle = texte.trim();
        // Le libellé d'invite porte value="" et ne prétend pas être une spécialité.
        if (!libelle || /value\s*=\s*(""|'')/.test(attrs)) continue;
        if (!SPECIALITES.includes(libelle)) hors.push(`${page}: « ${libelle} »`);
      }
    }
    expect(hors).toEqual([]);
  });
});

// ─── Chaque libellé servi est accepté par les routes qui valident ───────────

describe('POST /api/auth/register accepte chaque spécialité servie', () => {
  test('les 100 % des libellés du menu passent la validation', async () => {
    const refuses = [];
    for (const [i, specialite] of SPECIALITES.entries()) {
      const res = await request(app).post('/api/auth/register')
        // Une IP distincte par appel : /api/auth/register est plafonnée à
        // 5 inscriptions par heure et par IP, ce qui n'a rien à voir avec ce
        // qu'on teste ici.
        .set('X-Forwarded-For', `10.0.1.${i + 1}`)
        .send({
          prenom: 'Jean', nom: 'Test',
          email: `spec.${i}.${Date.now()}@example.com`,
          password: 'TestPassword1',
          specialites: [specialite],
          ville: 'Lyon',
        });
      if (res.status !== 201) refuses.push(`${specialite} → ${res.status} ${res.body.error}`);
      else expect(res.body.user.specialites).toEqual([specialite]);
    }
    expect(refuses).toEqual([]);
  }, 60000);

  test('accepte une sélection multiple', async () => {
    const res = await request(app).post('/api/auth/register')
      .set('X-Forwarded-For', '10.0.2.1')
      .send({
      prenom: 'Jean', nom: 'Test',
      email: `multi.${Date.now()}@example.com`,
      password: 'TestPassword1',
      specialites: ['Médecin généraliste', 'Gériatre'],
      ville: 'Lyon',
    }).expect(201);
    expect(res.body.user.specialites).toEqual(['Médecin généraliste', 'Gériatre']);
    expect(res.body.user.specialite).toBe('Médecin généraliste, Gériatre');
  });

  test('refuse toujours un libellé hors liste', async () => {
    const res = await request(app).post('/api/auth/register')
      .set('X-Forwarded-For', '10.0.2.2')
      .send({
      prenom: 'Jean', nom: 'Test',
      email: `hors.${Date.now()}@example.com`,
      password: 'TestPassword1',
      specialites: ['Astrologue'],
      ville: 'Lyon',
    }).expect(400);
    expect(res.body.error).toMatch(/Spécialité requise/);
  });
});

// ─── Le profil ne doit plus effacer la spécialité en silence ────────────────

describe('PATCH /api/auth/profile', () => {
  let token;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register')
      .set('X-Forwarded-For', '10.0.4.1')
      .send({
      prenom: 'Paul', nom: 'Profil',
      email: `profil.${Date.now()}@example.com`,
      password: 'TestPassword1',
      specialites: ['Cardiologue'],
      ville: 'Lyon',
    }).expect(201);
    token = res.body.token;
  });

  test('refuse un libellé hors liste au lieu d\'effacer la spécialité', async () => {
    await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ specialites: ['Médecine générale'] })
      .expect(400);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.user.specialites).toEqual(['Cardiologue']);
  });

  test('accepte une spécialité valide', async () => {
    const res = await request(app)
      .patch('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ specialites: ['Médecin généraliste'] })
      .expect(200);
    expect(res.body.user.specialites).toEqual(['Médecin généraliste']);
  });
});
