/**
 * Praxi — Tests de la brique RAG et de l'avis spécialisé
 *
 * Run : npx jest tests/rag.test.js
 *
 * Ces tests tournent hors-ligne : aucune source n'est appelée, aucun embedding
 * n'est calculé. Ils vérifient le découpage, la recherche lexicale, la
 * persistance de l'index, l'extensibilité du registre de spécialités et le
 * contrat de la route API.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const request = require('supertest');

// Index de test isolé — surtout pas le volume de données réel.
const RAG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-rag-'));
process.env.RAG_DIR       = RAG_DIR;
process.env.DATA_DIR      = os.tmpdir();
process.env.JWT_SECRET    = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN   = 'test-admin-token';
process.env.NODE_ENV      = 'test';
process.env.PORT          = '3098';
delete process.env.VOYAGE_API_KEY;   // force le mode lexical, déterministe

const { chunkText, chunkDocument } = require('../lib/rag/chunk');
const lexical = require('../lib/rag/lexical');
const store   = require('../lib/rag/store');
const { ragIngest, ragSearch, ragStats } = require('../lib/rag');
const { getSpecialite, listSpecialites, SPECIALITES } = require('../lib/specialites');
const app = require('../server');

afterAll(() => {
  fs.rmSync(RAG_DIR, { recursive: true, force: true });
});

// ─── DÉCOUPAGE ─────────────────────────────────────────────────────────────

describe('chunk', () => {
  test('un texte court reste en un seul passage', () => {
    const chunks = chunkText('Une phrase courte sur une dermatose.');
    expect(chunks).toHaveLength(1);
  });

  test('un texte long est découpé sous la taille maximale', () => {
    const paragraphe = 'Le psoriasis en plaques touche préférentiellement les faces d\'extension. ';
    const chunks = chunkText(paragraphe.repeat(300), { maxChars: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(800);
  });

  test('les passages voisins se recouvrent', () => {
    const phrases = Array.from({ length: 60 }, (_, i) => `Phrase numéro ${i} sur la dermatite atopique de l'enfant.`).join(' ');
    const chunks = chunkText(phrases, { maxChars: 400, overlap: 0.25 });
    expect(chunks.length).toBeGreaterThan(1);
    // La fin du premier passage doit réapparaître au début du second.
    const finPremier = chunks[0].slice(-40);
    expect(chunks[1].includes(finPremier.trim().split(' ').slice(-3).join(' '))).toBe(true);
  });

  test('un texte vide ne produit aucun passage', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
  });

  test('chaque passage porte le titre et les métadonnées du document', () => {
    const records = chunkDocument({
      id: 'doc:1',
      title: 'Prise en charge du psoriasis',
      url: 'https://exemple.fr/psoriasis',
      text: 'Contenu clinique. '.repeat(400),
      meta: { source: 'test' },
    }, { maxChars: 600 });

    expect(records.length).toBeGreaterThan(1);
    for (const record of records) {
      expect(record.text.startsWith('Prise en charge du psoriasis')).toBe(true);
      expect(record.meta.docId).toBe('doc:1');
      expect(record.meta.url).toBe('https://exemple.fr/psoriasis');
      expect(record.meta.source).toBe('test');
    }
    expect(records.map(r => r.id)).toEqual(expect.arrayContaining(['doc:1#0', 'doc:1#1']));
  });
});

// ─── RECHERCHE LEXICALE ────────────────────────────────────────────────────

describe('lexical (BM25)', () => {
  const corpus = [
    { text: 'Le psoriasis en plaques se traite en première intention par dermocorticoïdes et analogues de la vitamine D.' },
    { text: 'La dermatite atopique de l\'enfant repose sur les émollients et le tacrolimus topique en cas d\'échec.' },
    { text: 'Le mélanome impose une exérèse complète avec marges adaptées à l\'indice de Breslow.' },
  ];
  const index = lexical.buildIndex(corpus);

  test('les accents sont ignorés à la recherche', () => {
    const avec = lexical.search(index, 'dermocorticoïdes', 3);
    const sans = lexical.search(index, 'dermocorticoides', 3);
    expect(avec[0].docIndex).toBe(sans[0].docIndex);
    expect(avec[0].docIndex).toBe(0);
  });

  test('retrouve le bon document sur un terme discriminant', () => {
    expect(lexical.search(index, 'Breslow exérèse', 3)[0].docIndex).toBe(2);
    expect(lexical.search(index, 'tacrolimus émollients', 3)[0].docIndex).toBe(1);
  });

  test('les mots vides ne créent pas de correspondance', () => {
    expect(lexical.search(index, 'le la les de des', 3)).toEqual([]);
  });

  test('une requête vide ne renvoie rien', () => {
    expect(lexical.search(index, '', 3)).toEqual([]);
  });
});

// ─── STORE ─────────────────────────────────────────────────────────────────

describe('store fichier', () => {
  const collection = 'test-store';
  afterEach(() => store.drop(collection));

  test('refuse un nom de collection qui s\'échapperait du dossier', () => {
    expect(() => store.upsert('../evasion', [])).toThrow(/invalide/);
    expect(() => store.upsert('a/b', [])).toThrow(/invalide/);
  });

  test('persiste les passages et les relit', () => {
    store.upsert(collection, [
      { id: 'a#0', text: 'Premier passage sur la rosacée.', meta: { docId: 'a' } },
      { id: 'b#0', text: 'Second passage sur l\'urticaire.', meta: { docId: 'b' } },
    ]);
    const stats = store.stats(collection);
    expect(stats.count).toBe(2);
    expect(stats.hasVectors).toBe(false);
    expect(store.getRecords(collection, [0])[0].text).toMatch(/rosacée/);
  });

  test('un même identifiant écrase au lieu de dupliquer', () => {
    store.upsert(collection, [{ id: 'a#0', text: 'Version initiale.', meta: {} }]);
    store.upsert(collection, [{ id: 'a#0', text: 'Version corrigée.', meta: {} }]);
    expect(store.stats(collection).count).toBe(1);
    expect(store.getRecords(collection, [0])[0].text).toBe('Version corrigée.');
  });

  test('la recherche vectorielle est ignorée sans vecteurs', () => {
    store.upsert(collection, [{ id: 'a#0', text: 'Sans vecteur.', meta: {} }]);
    expect(store.searchVector(collection, [0.1, 0.2], 5)).toEqual([]);
  });

  test('une collection inconnue ne lève pas', () => {
    expect(store.stats('collection-absente')).toBeNull();
    expect(store.searchLexical('collection-absente', 'psoriasis')).toEqual([]);
  });
});

// ─── PIPELINE COMPLET ──────────────────────────────────────────────────────

describe('ragIngest / ragSearch', () => {
  const collection = 'test-pipeline';
  afterAll(() => store.drop(collection));

  test('indexe des documents et les retrouve', async () => {
    const result = await ragIngest({
      collection,
      source: 'test',
      documents: [
        {
          id: 'reco:psoriasis',
          title: 'Psoriasis en plaques',
          url: 'https://exemple.fr/1',
          text: 'Le méthotrexate reste le traitement systémique de référence des formes étendues de psoriasis. '
              + 'La ciclosporine constitue une alternative. Les biothérapies interviennent en seconde ligne.',
          meta: { source: 'test', sourceLabel: 'Test' },
        },
        {
          id: 'reco:gale',
          title: 'Gale commune',
          url: 'https://exemple.fr/2',
          text: 'Le traitement de la gale commune repose sur l\'ivermectine orale ou la perméthrine topique, '
              + 'avec traitement simultané de l\'entourage et décontamination du linge.',
          meta: { source: 'test', sourceLabel: 'Test' },
        },
      ],
    });

    expect(result.chunks).toBeGreaterThanOrEqual(2);
    expect(result.vectorised).toBe(false);   // pas de VOYAGE_API_KEY en test
    expect(ragStats(collection).count).toBe(result.chunks);

    const recherche = await ragSearch({ collection, query: 'traitement de la gale ivermectine', topK: 2 });
    expect(recherche.mode).toBe('lexical');
    expect(recherche.passages.length).toBeGreaterThan(0);
    expect(recherche.passages[0].meta.docId).toBe('reco:gale');
    expect(recherche.passages[0].meta.url).toBe('https://exemple.fr/2');
  });

  test('une collection non indexée renvoie un résultat vide, pas une erreur', async () => {
    const recherche = await ragSearch({ collection: 'jamais-indexee', query: 'psoriasis' });
    expect(recherche.mode).toBe('vide');
    expect(recherche.passages).toEqual([]);
  });

  test('la recherche est plafonnée par document pour garder de la diversité', async () => {
    const long = 'Passage détaillé sur la photothérapie du psoriasis. '.repeat(200);
    await ragIngest({
      collection,
      documents: [{ id: 'reco:photo', title: 'Photothérapie', text: long, meta: { source: 'test' } }],
    });
    const recherche = await ragSearch({ collection, query: 'photothérapie psoriasis', topK: 8, maxPerDoc: 2 });
    const parDoc = recherche.passages.filter(p => p.meta.docId === 'reco:photo').length;
    expect(parDoc).toBeLessThanOrEqual(2);
  });
});

// ─── REGISTRE DES SPÉCIALITÉS ──────────────────────────────────────────────

describe('registre des spécialités', () => {
  test('la dermatologie est active et complètement déclarée', () => {
    const derm = getSpecialite('dermatologie');
    expect(derm).not.toBeNull();
    expect(derm.collection).toBe('dermatologie');
    expect(derm.cadrage.length).toBeGreaterThan(50);
    expect(derm.accepteImages).toBe(true);
    expect(Object.keys(derm.sources)).toEqual(expect.arrayContaining(['pubmed', 'has', 'sfd', 'bdpm']));
  });

  test('la clé est insensible à la casse et aux espaces', () => {
    expect(getSpecialite('  DERMATOLOGIE ')).not.toBeNull();
  });

  test('une spécialité inconnue renvoie null', () => {
    expect(getSpecialite('astrologie')).toBeNull();
    expect(getSpecialite('')).toBeNull();
    expect(getSpecialite(undefined)).toBeNull();
  });

  test('toute entrée déclarée expose le contrat attendu par le moteur', () => {
    for (const specialite of Object.values(SPECIALITES)) {
      expect(typeof specialite.key).toBe('string');
      expect(typeof specialite.label).toBe('string');
      expect(typeof specialite.collection).toBe('string');
      expect(typeof specialite.cadrage).toBe('string');
      expect(Array.isArray(specialite.termesPivots)).toBe(true);
      expect(typeof specialite.sources).toBe('object');
    }
  });

  test('seules les spécialités actives sont exposées au front', () => {
    const exposees = listSpecialites().map(s => s.key);
    const actives  = Object.values(SPECIALITES).filter(s => s.actif).map(s => s.key);
    expect(exposees.sort()).toEqual(actives.sort());
  });
});

// ─── ROUTE API ─────────────────────────────────────────────────────────────

describe('API avis spécialisé', () => {
  let token;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      prenom: 'Avis', nom: 'Test',
      email: `avis.${Date.now()}@example.com`,
      password: 'TestPassword1',
      specialites: ['Médecin généraliste'],
      ville: 'Lyon',
    });
    token = res.body.token;
  });

  test('la liste des spécialités exige une authentification', async () => {
    await request(app).get('/api/avis-specialise/specialites').expect(401);
  });

  test('la liste des spécialités indique l\'état de la base', async () => {
    const res = await request(app)
      .get('/api/avis-specialise/specialites')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body.specialites)).toBe(true);
    const derm = res.body.specialites.find(s => s.key === 'dermatologie');
    expect(derm).toBeDefined();
    expect(derm).toHaveProperty('baseIndexee');
    expect(derm).toHaveProperty('passages');
  });

  test('refuse sans authentification', async () => {
    await request(app)
      .post('/api/avis-specialise')
      .send({ specialite: 'dermatologie', cas: 'Un cas suffisamment long pour passer la validation.' })
      .expect(401);
  });

  test('refuse une spécialité inconnue', async () => {
    const res = await request(app)
      .post('/api/avis-specialise')
      .set('Authorization', `Bearer ${token}`)
      .send({ specialite: 'astrologie', cas: 'Un cas suffisamment long pour passer la validation.' })
      .expect(400);
    expect(res.body.error).toMatch(/[Ss]pécialité/);
  });

  test('refuse un cas trop court', async () => {
    const res = await request(app)
      .post('/api/avis-specialise')
      .set('Authorization', `Bearer ${token}`)
      .send({ specialite: 'dermatologie', cas: 'Bouton.' })
      .expect(400);
    expect(res.body.error).toMatch(/[Dd]écrivez/);
  });

  test('refuse un format de photo non supporté', async () => {
    const res = await request(app)
      .post('/api/avis-specialise')
      .set('Authorization', `Bearer ${token}`)
      .send({
        specialite: 'dermatologie',
        cas: 'Lésion érythémateuse du bras évoluant depuis trois semaines, sans fièvre.',
        photos: [{ mediaType: 'application/pdf', data: 'AAAA' }],
      })
      .expect(400);
    expect(res.body.error).toMatch(/JPEG/);
  });

  test('refuse plus de quatre photos', async () => {
    const photo = { mediaType: 'image/jpeg', data: 'AAAA' };
    const res = await request(app)
      .post('/api/avis-specialise')
      .set('Authorization', `Bearer ${token}`)
      .send({
        specialite: 'dermatologie',
        cas: 'Lésion érythémateuse du bras évoluant depuis trois semaines, sans fièvre.',
        photos: [photo, photo, photo, photo, photo],
      })
      .expect(400);
    expect(res.body.error).toMatch(/maximum/);
  });

  test('refuse une photo au base64 corrompu', async () => {
    const res = await request(app)
      .post('/api/avis-specialise')
      .set('Authorization', `Bearer ${token}`)
      .send({
        specialite: 'dermatologie',
        cas: 'Lésion érythémateuse du bras évoluant depuis trois semaines, sans fièvre.',
        photos: [{ mediaType: 'image/jpeg', data: '<<< pas du base64 >>>' }],
      })
      .expect(400);
    expect(res.body.error).toMatch(/corrompue|mal encodée/);
  });

  test('refuse de répondre si la base de connaissances n\'est pas indexée', async () => {
    // La collection « dermatologie » n'existe pas dans l'index de test : le
    // serveur doit refuser plutôt que de produire un avis non sourcé.
    const res = await request(app)
      .post('/api/avis-specialise')
      .set('Authorization', `Bearer ${token}`)
      .send({
        specialite: 'dermatologie',
        cas: 'Plaques érythémato-squameuses des coudes et des genoux évoluant depuis deux ans, prurit modéré.',
      });
    expect([503, 429]).toContain(res.status);
    if (res.status === 503) expect(res.body.error).toMatch(/indexée/);
  });
});
