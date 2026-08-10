/**
 * Arkiba — Abonnement de bout en bout (routes HTTP)
 *
 * Les tests unitaires de lib/plans.js vérifient la règle ; ceux-ci vérifient
 * qu'elle est bien APPLIQUÉE par le serveur. C'est l'invariant demandé : un
 * compte gratuit qui appelle directement une route payante — sans passer par
 * l'interface, donc sans le moindre verrou côté navigateur — se fait refuser.
 *
 * Run : npx jest tests/abonnement.test.js
 */

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');

process.env.JWT_SECRET  = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV    = 'test';
process.env.PORT        = '3098';
// Base isolée : la whitelist doit pouvoir créer ses comptes sans se heurter à
// ceux laissés par une autre suite dans le répertoire temporaire commun.
process.env.DATA_DIR    = fs.mkdtempSync(path.join(os.tmpdir(), 'arkiba-abo-'));

const app         = require('../server');
const plans       = require('../lib/plans');
const facturation = require('../lib/facturation');

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const SPECIALITE = 'Médecin généraliste';
const MOT_DE_PASSE = 'MotDePasse1';

const cheminUsers = () => path.join(process.env.DATA_DIR, 'users.json');

function lireUsers() {
  try { return JSON.parse(fs.readFileSync(cheminUsers(), 'utf8')); }
  catch (_) { return { users: [], nextId: 1 }; }
}

/**
 * Crée un compte directement en base, comme le ferait une inscription.
 *
 * L'inscription HTTP est plafonnée à 5 par heure et par IP — un garde-fou
 * anti-abus qu'on ne veut surtout pas desserrer pour les tests. Ces derniers
 * ont besoin d'une dizaine de comptes : on passe donc par la base, en écrivant
 * exactement ce qu'écrit /api/auth/register (mot de passe haché compris, pour
 * que la connexion classique fonctionne).
 */
function creerCompte(email) {
  const db = lireUsers();
  const maintenant = Date.now();
  const user = {
    id: db.nextId++,
    prenom: 'Camille', nom: 'Rousseau',
    email: email.toLowerCase(),
    passwordHash: bcrypt.hashSync(MOT_DE_PASSE, 10),
    specialite: SPECIALITE, specialites: [SPECIALITE],
    ville: 'Lyon', rpps: '', adresse: '', telephone: '', emailPro: email,
    status: 'verified',
    plan: 'trial', planStatus: 'trialing',
    trialEndsAt: new Date(maintenant + plans.DUREE_ESSAI_JOURS * 86_400_000).toISOString(),
    usage: { documents: 0, depuis: new Date(maintenant).toISOString() },
    createdAt: new Date(maintenant).toISOString(),
  };
  plans.normaliserCompte(user, maintenant);
  db.users.push(user);
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  fs.writeFileSync(cheminUsers(), JSON.stringify(db, null, 2));

  const token = jwt.sign(
    { id: user.id, email: user.email, prenom: user.prenom, specialite: user.specialite },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  return { token, user: { ...user, abonnement: plans.etatAbonnement(user) } };
}

/** Force l'état d'un compte directement en base, comme le ferait un webhook. */
function ecrireCompte(id, modif) {
  const p  = path.join(process.env.DATA_DIR, 'users.json');
  const db = JSON.parse(fs.readFileSync(p, 'utf8'));
  const u  = db.users.find(x => x.id === id);
  Object.assign(u, modif);
  fs.writeFileSync(p, JSON.stringify(db, null, 2));
}

describe('inscription', () => {
  test('crée le compte en essai et renvoie un jeton exploitable tout de suite', async () => {
    const res = await request(app).post('/api/auth/register').send({
      prenom: 'Camille', nom: 'Rousseau',
      email: `inscription.${Date.now()}@cabinet.fr`, password: MOT_DE_PASSE,
      specialites: [SPECIALITE], ville: 'Lyon',
    });
    expect(res.status).toBe(201);
    const { token, user } = res.body;

    // Le formulaire de la vitrine entre directement dans l'application : sans
    // jeton dans la réponse, il faudrait repasser par l'écran de connexion.
    expect(typeof token).toBe('string');
    expect(user.abonnement).toMatchObject({ plan: 'trial', payant: false, illimite: false });
    expect(user.abonnement.essai.joursRestants).toBe(plans.DUREE_ESSAI_JOURS);

    // Aucun secret ne doit fuir dans la réponse d'inscription.
    expect(user.passwordHash).toBeUndefined();
    expect(user.stripe).toBeUndefined();
  });
});

describe('contrôle d\'accès côté serveur', () => {
  let essai;
  beforeAll(() => { essai = creerCompte(`gratuit.${Date.now()}@cabinet.fr`); });

  test.each([
    ['/api/generate/mdph'],
    ['/api/generate/ald'],
    ['/api/generate/certificat'],
    ['/api/generate/ordonnance'],
    ['/api/avis-specialise'],
  ])('%s est refusé à un compte en essai', async (route) => {
    const res = await request(app)
      .post(route)
      .set('Authorization', `Bearer ${essai.token}`)
      .send({ notes: 'test' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('plan_required');
  });

  test.each([
    ['/api/generate/liaison'],
    ['/api/generate/compte-rendu'],
    ['/api/generate/resume'],
  ])('%s reste ouvert pendant l\'essai', async (route) => {
    const res = await request(app)
      .post(route)
      .set('Authorization', `Bearer ${essai.token}`)
      .send({ notes: 'test' });

    // Le contenu peut échouer (pas de clé Anthropic en test) ; ce qui compte
    // est que le refus ne vienne pas de l'abonnement.
    expect(res.status).not.toBe(402);
  });

  test('un module payant reste refusé sans en-tête d\'authentification', async () => {
    const res = await request(app).post('/api/generate/mdph').send({ notes: 'test' });
    expect(res.status).toBe(401);
  });

  test("l'essai terminé ferme aussi les modules de base", async () => {
    const compte = creerCompte(`expire.${Date.now()}@cabinet.fr`);
    ecrireCompte(compte.user.id, { trialEndsAt: new Date(Date.now() - 86_400_000).toISOString() });

    const res = await request(app)
      .post('/api/generate/liaison')
      .set('Authorization', `Bearer ${compte.token}`)
      .send({ notes: 'test' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('trial_expired');

    // …mais l'historique reste consultable : on ne prend pas des documents
    // médicaux en otage à l'expiration de l'essai.
    const lecture = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${compte.token}`);
    expect(lecture.status).toBe(200);
  });

  test('le plafond de documents finit par bloquer', async () => {
    const compte = creerCompte(`quota.${Date.now()}@cabinet.fr`);
    ecrireCompte(compte.user.id, {
      usage: { documents: plans.QUOTA_DOCUMENTS_ESSAI, depuis: new Date().toISOString() },
    });

    const res = await request(app)
      .post('/api/generate/liaison')
      .set('Authorization', `Bearer ${compte.token}`)
      .send({ notes: 'test' });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('quota_exceeded');
  });

  test('un abonnement actif débloque les modules Pro', async () => {
    const compte = creerCompte(`pro.${Date.now()}@cabinet.fr`);
    ecrireCompte(compte.user.id, { plan: 'pro', planStatus: 'active' });

    const res = await request(app)
      .post('/api/generate/mdph')
      .set('Authorization', `Bearer ${compte.token}`)
      .send({ notes: 'test' });

    expect(res.status).not.toBe(402);
  });
});

describe('whitelist « accès illimité »', () => {
  // Les deux adresses du cahier des charges, avec la liste par défaut du code.
  test.each([['benarken@yahoo.com'], ['sbh75@gmx.fr']])(
    '%s a un accès total sans abonnement', async (email) => {
      const compte = creerCompte(email);
      expect(compte.user.abonnement.illimite).toBe(true);

      // Même en forçant un essai expiré et le quota épuisé : l'accès est
      // indépendant du statut d'abonnement.
      ecrireCompte(compte.user.id, {
        trialEndsAt: new Date(Date.now() - 999 * 86_400_000).toISOString(),
        usage: { documents: 9999, depuis: new Date().toISOString() },
      });

      for (const route of ['/api/generate/mdph', '/api/generate/ald', '/api/avis-specialise']) {
        const res = await request(app)
          .post(route)
          .set('Authorization', `Bearer ${compte.token}`)
          .send({ notes: 'test' });
        expect(res.status).not.toBe(402);
      }
    });

  test('le mot de passe de ces comptes reste celui du système d\'authentification', async () => {
    // Aucun raccourci : la whitelist ouvre les fonctionnalités, pas la porte.
    const mauvais = await request(app)
      .post('/api/auth/login')
      .send({ email: 'benarken@yahoo.com', password: 'pas-le-bon' });
    expect(mauvais.status).toBe(401);

    const bon = await request(app)
      .post('/api/auth/login')
      .send({ email: 'benarken@yahoo.com', password: 'MotDePasse1' });
    expect(bon.status).toBe(200);
    expect(bon.body.user.abonnement.illimite).toBe(true);
  });

  test('un compte hors whitelist ne peut pas s\'octroyer l\'accès illimité en base', async () => {
    const compte = creerCompte(`faux.admin.${Date.now()}@cabinet.fr`);
    ecrireCompte(compte.user.id, { illimite: true, plan: 'pro', planStatus: 'active' });

    // `plan: pro` écrit à la main passe — c'est ce que fait le webhook Stripe et
    // seul Stripe y écrit. En revanche `illimite` est recalculé à partir de la
    // whitelist d'emails à chaque lecture du compte.
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${compte.token}`);
    expect(me.body.user.abonnement.illimite).toBe(false);
  });
});

describe('facturation — routes', () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY    = ENV.STRIPE_SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = ENV.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_PRICE_PRO     = ENV.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PRICE_PRO;
    facturation.resetStripe();
  });

  test('GET /api/billing/state décrit la formule du compte', async () => {
    const compte = creerCompte(`state.${Date.now()}@cabinet.fr`);
    const res = await request(app)
      .get('/api/billing/state')
      .set('Authorization', `Bearer ${compte.token}`)
      .expect(200);

    expect(res.body.abonnement.plan).toBe('trial');
    expect(res.body.facturation.active).toBe(false);
  });

  test('un compte de la whitelist n\'ouvre jamais de session de paiement', async () => {
    // Stripe est configuré : le refus ne doit donc pas venir de l'absence de
    // clé, mais bien de la règle « ces comptes ne sont jamais sollicités ».
    process.env.STRIPE_SECRET_KEY = 'sk_test_faux';
    process.env.STRIPE_PRICE_PRO  = 'price_test';
    facturation.resetStripe();

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'sbh75@gmx.fr', password: 'MotDePasse1' })
      .expect(200);

    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ plan: 'pro' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('compte_illimite');

    const portail = await request(app)
      .post('/api/billing/portal')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({});
    expect(portail.body.code).toBe('compte_illimite');
  });

  test('sans clé Stripe, le paiement répond 503 sans casser l\'application', async () => {
    const compte = creerCompte(`sansstripe.${Date.now()}@cabinet.fr`);
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', `Bearer ${compte.token}`)
      .send({ plan: 'pro' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('stripe_inactif');
  });
});

describe('webhook Stripe', () => {
  const SECRET = 'whsec_test_secret';

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY     = 'sk_test_faux';
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_PRICE_PRO      = 'price_pro_test';
    facturation.resetStripe();
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PRICE_PRO;
    facturation.resetStripe();
  });

  function evenementAbonnement(userId, { statut = 'active', priceId = 'price_pro_test', annule = false } = {}) {
    return {
      id: 'evt_test',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_test_1',
          object: 'subscription',
          customer: 'cus_test_1',
          status: statut,
          cancel_at_period_end: annule,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          items: { data: [{ price: { id: priceId } }] },
          metadata: { arkibaUserId: String(userId) },
        },
      },
    };
  }

  function envoyerSigne(corps) {
    const payload = JSON.stringify(corps);
    const entete  = facturation.getStripe().webhooks.generateTestHeaderString({ payload, secret: SECRET });
    return request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', entete)
      .send(payload);
  }

  test('un événement non signé est rejeté', async () => {
    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(evenementAbonnement(1)));
    expect(res.status).toBe(400);
  });

  // Sans cette vérification, n'importe qui pourrait s'offrir un abonnement en
  // postant un faux `subscription.updated` sur une route publique.
  test('une signature forgée est rejetée', async () => {
    const payload = JSON.stringify(evenementAbonnement(1));
    const res = await request(app)
      .post('/api/stripe/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=' + '0'.repeat(64))
      .send(payload);
    expect(res.status).toBe(400);
  });

  test('un abonnement actif fait passer le compte en Pro', async () => {
    const compte = creerCompte(`webhook.${Date.now()}@cabinet.fr`);

    const res = await envoyerSigne(evenementAbonnement(compte.user.id));
    expect(res.status).toBe(200);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${compte.token}`);
    expect(me.body.user.abonnement).toMatchObject({ plan: 'pro', payant: true });

    // Et le module payant s'ouvre dans la foulée, sans reconnexion.
    const mdph = await request(app)
      .post('/api/generate/mdph')
      .set('Authorization', `Bearer ${compte.token}`)
      .send({ notes: 'test' });
    expect(mdph.status).not.toBe(402);
  });

  test('un échec de paiement coupe l\'accès payant', async () => {
    const compte = creerCompte(`impaye.${Date.now()}@cabinet.fr`);
    await envoyerSigne(evenementAbonnement(compte.user.id));

    const echec = await envoyerSigne({
      id: 'evt_echec',
      type: 'invoice.payment_failed',
      data: { object: { object: 'invoice', customer: 'cus_test_1', customer_email: compte.user.email } },
    });
    expect(echec.status).toBe(200);

    const mdph = await request(app)
      .post('/api/generate/mdph')
      .set('Authorization', `Bearer ${compte.token}`)
      .send({ notes: 'test' });
    expect(mdph.status).toBe(402);
  });

  test('une résiliation ramène le compte au plan gratuit', async () => {
    const compte = creerCompte(`resilie.${Date.now()}@cabinet.fr`);
    await envoyerSigne(evenementAbonnement(compte.user.id));

    const res = await envoyerSigne({
      id: 'evt_del',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_test_1', object: 'subscription', customer: 'cus_test_1',
          status: 'canceled', cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_pro_test' } }] },
          metadata: { arkibaUserId: String(compte.user.id) },
        },
      },
    });
    expect(res.status).toBe(200);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${compte.token}`);
    expect(me.body.user.abonnement.payant).toBe(false);
  });

  test('un événement pour un compte inconnu est acquitté sans rejeu', async () => {
    // Répondre 5xx ferait rejouer Stripe pendant des jours pour rien.
    const res = await envoyerSigne(evenementAbonnement(999_999));
    expect(res.status).toBe(200);
  });
});
