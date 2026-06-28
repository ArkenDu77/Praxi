/**
 * Praxi — Tests API (Jest + Supertest)
 *
 * Setup : npm install --save-dev jest supertest
 * Run   : npx jest tests/api.test.js
 */

const request = require('supertest');

// Le serveur doit être démarrable sans ANTHROPIC_API_KEY pour les tests
process.env.JWT_SECRET    = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN   = 'test-admin-token';
process.env.NODE_ENV      = 'test';
process.env.PORT          = '3099';
process.env.DATA_DIR      = require('os').tmpdir();

const app = require('../server');

let authToken;
let testUserId;

// ─── AUTH ROUTES ───────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  const validUser = {
    prenom:    'Jean',
    nom:       'Test',
    email:     `test.${Date.now()}@example.com`,
    password:  'TestPassword1',
    specialites: ['Médecin généraliste'],
    ville:     'Paris'
  };

  test('enregistre un nouveau médecin', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(validUser)
      .expect(201);

    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({
      prenom: 'Jean',
      nom: 'Test',
      email: validUser.email,
    });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    authToken = res.body.token;
    testUserId = res.body.user.id;
  });

  test('rejette un email déjà utilisé', async () => {
    await request(app)
      .post('/api/auth/register')
      .send(validUser)
      .expect(409);
  });

  test('rejette un mot de passe trop court', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...validUser, email: 'new@test.com', password: 'abc' })
      .expect(400);
    expect(res.body.error).toMatch(/8 caractères/);
  });

  test('rejette sans spécialité', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...validUser, email: 'new2@test.com', specialites: [] })
      .expect(400);
    expect(res.body.error).toMatch(/[Ss]pécialit/);
  });

  test('rejette un email invalide', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...validUser, email: 'not-an-email' })
      .expect(400);
    expect(res.body.error).toMatch(/[Ee]mail/);
  });
});

describe('POST /api/auth/login', () => {
  let loginEmail;

  beforeAll(async () => {
    loginEmail = `login.${Date.now()}@example.com`;
    await request(app)
      .post('/api/auth/register')
      .set('x-forwarded-for', '10.0.0.1')  // IP distincte pour éviter le rate limit du describe précédent
      .send({
        prenom: 'Login', nom: 'Test', email: loginEmail,
        password: 'Login1234', specialites: ['Médecin généraliste'], ville: 'Lyon'
      });
  });

  test('retourne un token pour identifiants valides', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: loginEmail, password: 'Login1234' })
      .expect(200);
    expect(res.body).toHaveProperty('token');
    authToken = res.body.token; // refresh token for subsequent tests
  });

  test('refuse un mauvais mot de passe', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: loginEmail, password: 'wrongpassword' })
      .expect(401);
  });

  test('refuse un email inconnu — même message que mot de passe faux (anti-énumération)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'unknown@example.com', password: 'anything' })
      .expect(401);
    expect(res.body.error).toMatch(/[Ee]mail ou mot de passe/);
  });
});

describe('GET /api/auth/me', () => {
  test('retourne le profil pour un token valide', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);
    expect(res.body.user).toHaveProperty('email');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  test('refuse sans token', async () => {
    await request(app)
      .get('/api/auth/me')
      .expect(401);
  });

  test('refuse avec un token invalide', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid.jwt.token')
      .expect(401);
  });
});

// ─── SECURITY HEADERS ──────────────────────────────────────────────────────

describe('Headers de sécurité (helmet)', () => {
  test('X-Content-Type-Options présent', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('X-Frame-Options présent', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  test('Content-Security-Policy présent', async () => {
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});

// ─── RATE LIMITING ─────────────────────────────────────────────────────────

describe('Rate limiting — /api/auth/forgot-password (max 3/h)', () => {
  const testEmail = `ratelimit.${Date.now()}@example.com`;

  test('accepte les 3 premières requêtes', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: testEmail })
        .expect(200);
    }
  });

  test('bloque la 4ème requête (429)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: testEmail })
      .expect(429);
    expect(res.body.error).toMatch(/Trop de tentatives/);
  });
});

// ─── GENERATE ROUTES ───────────────────────────────────────────────────────

describe('POST /api/clinical/analyze — bouclier clinique V2', () => {
  test('refuse sans authentification', async () => {
    await request(app).post('/api/clinical/analyze').send({ notes: 'Palpitations' }).expect(401);
  });

  test('sépare faits, déductions, suggestions et informations manquantes', async () => {
    const res = await request(app)
      .post('/api/clinical/analyze')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        documentType: 'liaison', patient: 'Patient test', age: '54 ans',
        specialiste: 'Cardiologue', motif: 'Palpitations depuis 3 mois',
        notes: 'ECG normal. Pas de syncope.'
      })
      .expect(200);
    expect(res.body.analysis).toEqual(expect.objectContaining({
      facts: expect.any(Array), deductions: expect.any(Array), suggestions: expect.any(Array),
      missing: expect.any(Array), questions: expect.any(Array), inconsistencies: expect.any(Array),
      confidence: expect.any(Number), recommendedLength: expect.any(String)
    }));
    expect(res.body.analysis.suggestions.some(x => /Holter/i.test(x.label))).toBe(true);
    expect(res.body.analysis.suggestions.find(x => /Holter/i.test(x.label)).confidence).toBeGreaterThanOrEqual(90);
    expect(res.body.analysis.specialtyFocus.join(' ')).toMatch(/ECG/);
    expect(res.body.analysis.questions.join(' ')).not.toMatch(/ECG.*disponible/i);
    expect(res.body.analysis.deductions.length).toBeGreaterThanOrEqual(3);
    expect(res.body.analysis.confidenceBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: expect.any(String), value: expect.any(Number) })
    ]));
  });

  test('détecte une incohérence clinique explicite', async () => {
    const res = await request(app)
      .post('/api/clinical/analyze')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes: 'Femme enceinte suivie pour hypertrophie prostatique.' })
      .expect(200);
    expect(res.body.analysis.inconsistencies.length).toBeGreaterThan(0);
    expect(res.body.analysis.confidence).toBeLessThan(80);
  });

  test('détecte une date impossible', async () => {
    const res = await request(app)
      .post('/api/clinical/analyze')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes: 'Consultation du 42/19/2026 pour douleur.' })
      .expect(200);
    expect(res.body.analysis.inconsistencies.join(' ')).toMatch(/Date impossible/);
  });

  test('signale une incompatibilité médicamenteuse explicite', async () => {
    const res = await request(app)
      .post('/api/clinical/analyze')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes: 'Allergie connue aux pénicillines. Prescription envisagée : amoxicilline.' })
      .expect(200);
    expect(res.body.analysis.inconsistencies.join(' ')).toMatch(/Amoxicilline/);
  });

  test('ne propose rien sans signal clinique reconnu', async () => {
    const res = await request(app)
      .post('/api/clinical/analyze')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes: 'Contrôle annuel stable, aucun symptôme rapporté.' })
      .expect(200);
    expect(res.body.analysis.suggestions).toEqual([]);
  });
});

describe('finalizeDocument — suppression ANALYSE DE PRAXI', () => {
  const { finalizeDocument } = require('../server');
  const sample = `Dr Test\n\nCher Confrère,\n\nLettre de liaison.\n\nDr Test\n\n---\n\nANALYSE DE PRAXI\n\nAucune suggestion validée.`;

  test('retire la section ANALYSE DE PRAXI du document final', () => {
    const out = finalizeDocument(sample);
    expect(out).not.toMatch(/ANALYSE DE PRAXI/i);
    expect(out).not.toMatch(/---/);
    expect(out).toContain('Lettre de liaison.');
  });
});

describe('POST /api/generate/liaison', () => {
  test('refuse sans authentification', async () => {
    await request(app)
      .post('/api/generate/liaison')
      .send({ notes: 'test', motif: 'test' })
      .expect(401);
  });

  test('refuse si ni notes ni motif', async () => {
    const res = await request(app)
      .post('/api/generate/liaison')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ patient: 'Test' })
      .expect(400);
    expect(res.body).toHaveProperty('error');
  });

  test('accepte notes + motif (sans clé API, retourne 503)', async () => {
    const res = await request(app)
      .post('/api/generate/liaison')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notes: 'HTA connue', motif: 'Adressage cardio', specialiste: 'Cardiologue' });
    // Soit 200 (si ANTHROPIC_API_KEY set), soit 503 (si absent en test)
    expect([200, 503]).toContain(res.status);
  });
});

describe('POST /api/generate/mdph', () => {
  test('refuse sans auth', async () => {
    await request(app).post('/api/generate/mdph').send({ diagnostic: 'test' }).expect(401);
  });

  test('refuse sans diagnostic ni notes', async () => {
    const res = await request(app)
      .post('/api/generate/mdph')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ patient: 'M. Test' })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/generate/ald', () => {
  test('refuse sans auth', async () => {
    await request(app).post('/api/generate/ald').send({ affection: 'test' }).expect(401);
  });

  test('refuse sans affection ni notes', async () => {
    const res = await request(app)
      .post('/api/generate/ald')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ patient: 'M. Test' })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/generate/certificat', () => {
  test('refuse sans auth', async () => {
    await request(app).post('/api/generate/certificat').send({ type: 'test' }).expect(401);
  });

  test('refuse sans type ni notes', async () => {
    const res = await request(app)
      .post('/api/generate/certificat')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ patient: 'M. Test' })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/generate/ordonnance', () => {
  test('refuse sans authentification', async () => {
    await request(app)
      .post('/api/generate/ordonnance')
      .send({ medicaments: 'Paracétamol 1g 3x/jour' })
      .expect(401);
  });

  test('refuse sans médicaments', async () => {
    const res = await request(app)
      .post('/api/generate/ordonnance')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ patient: 'M. Test' })
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  test('accepte medicaments (sans clé API, retourne 200 ou 503)', async () => {
    const res = await request(app)
      .post('/api/generate/ordonnance')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ patient: 'M. Dupont', medicaments: 'Amoxicilline 1g — 3x/jour — 7 jours' });
    expect([200, 503]).toContain(res.status);
  });
});

// ─── WAITLIST ──────────────────────────────────────────────────────────────

describe('POST /api/waitlist', () => {
  test('enregistre une entrée valide', async () => {
    const res = await request(app)
      .post('/api/waitlist')
      .send({
        prenom: 'Marie', nom: 'Curie', email: `waitlist.${Date.now()}@example.com`,
        specialite: 'Médecin généraliste', ville: 'Paris'
      })
      .expect(201);
    expect(res.body).toHaveProperty('ok', true);
  });

  test('rejette sans email', async () => {
    await request(app)
      .post('/api/waitlist')
      .send({ prenom: 'Test', nom: 'Test', specialite: 'Médecin généraliste', ville: 'Paris' })
      .expect(400);
  });
});

// ─── ADMIN ─────────────────────────────────────────────────────────────────

describe('GET /api/admin/list', () => {
  test('refuse sans token admin', async () => {
    await request(app).get('/api/admin/list').expect(401);
  });

  test('refuse avec mauvais token admin', async () => {
    await request(app)
      .get('/api/admin/list')
      .set('x-admin-token', 'wrong-token')
      .expect(401);
  });

  test('accepte avec bon token admin', async () => {
    const res = await request(app)
      .get('/api/admin/list')
      .set('x-admin-token', 'test-admin-token')
      .expect(200);
    expect(res.body).toHaveProperty('count');
  });
});

// ─── INPUT VALIDATION / XSS ────────────────────────────────────────────────

describe('Validation des inputs — injection XSS', () => {
  test('les champs texte sont tronqués et nettoyés', async () => {
    const xssPayload = '<script>alert("xss")</script>';
    const res = await request(app)
      .post('/api/waitlist')
      .send({
        prenom: xssPayload,
        nom: 'Test',
        email: `xss.${Date.now()}@example.com`,
        specialite: 'Médecin généraliste',
        ville: 'Paris'
      });
    // La réponse ne doit pas contenir de balises <script>
    expect(JSON.stringify(res.body)).not.toContain('<script>');
  });
});
