/**
 * Arkiba — Plans d'abonnement et contrôle d'accès
 *
 * Ce fichier verrouille l'invariant qui compte : la décision se prend côté
 * serveur. Une fonctionnalité payante appelée par un compte gratuit doit
 * répondre 402 même si l'appel arrive directement sur la route, sans passer
 * par l'interface.
 *
 * Run : npx jest tests/plans.test.js
 */

const fs   = require('fs');
const path = require('path');

const plans = require('../lib/plans');

const JOUR = 86_400_000;

/** Compte d'essai neuf. */
function compteEssai(extra = {}) {
  const u = {
    id: 1,
    email: 'medecin@cabinet.fr',
    prenom: 'Camille',
    plan: 'trial',
    planStatus: 'trialing',
    trialEndsAt: new Date(Date.now() + 20 * JOUR).toISOString(),
    usage: { documents: 0, depuis: new Date().toISOString() },
    ...extra,
  };
  plans.normaliserCompte(u);
  return u;
}

describe('planEffectif', () => {
  test("un compte neuf est en essai", () => {
    expect(plans.planEffectif(compteEssai())).toBe('trial');
  });

  test("l'essai expiré retombe en gratuit", () => {
    const u = compteEssai({ trialEndsAt: new Date(Date.now() - JOUR).toISOString() });
    expect(plans.planEffectif(u)).toBe('free');
  });

  test('un abonnement actif donne le plan payant', () => {
    const u = compteEssai({ plan: 'pro', planStatus: 'active' });
    expect(plans.planEffectif(u)).toBe('pro');
    expect(plans.estPayant(u)).toBe(true);
  });

  // Un impayé qui laisserait l'accès ouvert reviendrait à offrir l'abonnement :
  // Stripe cesse d'encaisser, mais le compte continuerait de générer.
  test('un abonnement impayé ne vaut plus accès payant', () => {
    const u = compteEssai({
      plan: 'pro',
      planStatus: 'past_due',
      trialEndsAt: new Date(Date.now() - JOUR).toISOString(),
    });
    expect(plans.planEffectif(u)).toBe('free');
    expect(plans.verifierAcces(u, 'generate.liaison').ok).toBe(false);
  });

  test('un abonnement résilié retombe en gratuit', () => {
    const u = compteEssai({
      plan: 'free',
      planStatus: 'canceled',
      trialEndsAt: new Date(Date.now() - JOUR).toISOString(),
    });
    expect(plans.planEffectif(u)).toBe('free');
  });
});

describe('découpage gratuit / payant', () => {
  const base  = ['generate.liaison', 'generate.compte-rendu', 'generate.resume', 'clinical.analyze'];
  const payant = ['generate.mdph', 'generate.ald', 'generate.certificat', 'generate.ordonnance', 'avis-specialise'];

  test("l'essai ouvre les modules du quotidien", () => {
    const u = compteEssai();
    for (const f of base) expect(plans.verifierAcces(u, f)).toMatchObject({ ok: true });
  });

  test("l'essai refuse les modules Pro avec le code attendu", () => {
    const u = compteEssai();
    for (const f of payant) {
      const v = plans.verifierAcces(u, f);
      expect(v.ok).toBe(false);
      expect(v.code).toBe('plan_required');
    }
  });

  test('un abonnement payant ouvre tout', () => {
    const u = compteEssai({ plan: 'pro', planStatus: 'active' });
    for (const f of [...base, ...payant]) expect(plans.verifierAcces(u, f).ok).toBe(true);
  });

  test("l'essai terminé ferme même les modules de base, en lecture seule", () => {
    const u = compteEssai({ trialEndsAt: new Date(Date.now() - JOUR).toISOString() });
    for (const f of [...base, ...payant]) {
      const v = plans.verifierAcces(u, f);
      expect(v.ok).toBe(false);
      expect(v.code).toMatch(/trial_expired|plan_required/);
    }
  });

  // Une fonctionnalité ajoutée sans être déclarée ne doit pas être ouverte par
  // défaut : on préfère un refus visible à une route payante restée libre.
  test('une fonctionnalité inconnue est refusée par défaut', () => {
    expect(plans.niveauRequis('generate.inexistant')).toBe('pro');
    expect(plans.verifierAcces(compteEssai(), 'generate.inexistant').ok).toBe(false);
  });
});

describe('quota de documents', () => {
  test("l'essai s'arrête au plafond", () => {
    const u = compteEssai();
    for (let i = 0; i < plans.QUOTA_DOCUMENTS_ESSAI; i++) {
      expect(plans.verifierAcces(u, 'generate.liaison').ok).toBe(true);
      plans.consommerDocument(u);
    }
    const v = plans.verifierAcces(u, 'generate.liaison');
    expect(v.ok).toBe(false);
    expect(v.code).toBe('quota_exceeded');
  });

  test('un plan payant ne consomme pas de quota', () => {
    const u = compteEssai({ plan: 'pro', planStatus: 'active' });
    expect(plans.consommerDocument(u)).toBe(false);
    expect(plans.documentsConsommes(u)).toBe(0);
  });

  test("le plafond de dossiers patients s'applique à l'essai", () => {
    const u = compteEssai();
    expect(plans.verifierQuotaPatients(u, plans.QUOTA_PATIENTS_ESSAI - 1).ok).toBe(true);
    const v = plans.verifierQuotaPatients(u, plans.QUOTA_PATIENTS_ESSAI);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('quota_exceeded');
  });
});

describe('whitelist « accès illimité »', () => {
  const AVANT = process.env.ARKIBA_ADMIN_EMAILS;
  afterEach(() => {
    if (AVANT === undefined) delete process.env.ARKIBA_ADMIN_EMAILS;
    else process.env.ARKIBA_ADMIN_EMAILS = AVANT;
  });

  test('les deux emails prévus ont un accès total', () => {
    delete process.env.ARKIBA_ADMIN_EMAILS;
    for (const email of ['benarken@yahoo.com', 'sbh75@gmx.fr']) {
      const u = compteEssai({ email, trialEndsAt: new Date(Date.now() - 999 * JOUR).toISOString() });
      expect(plans.planEffectif(u)).toBe('illimite');
      expect(plans.estIllimite(u)).toBe(true);
      // Ni essai expiré ni plafond ne s'appliquent : l'accès est indépendant
      // du statut d'abonnement, c'est tout l'objet de la whitelist.
      for (const f of Object.keys(plans.FONCTIONNALITES)) {
        expect(plans.verifierAcces(u, f).ok).toBe(true);
      }
    }
  });

  test('la comparaison ignore la casse et les espaces', () => {
    delete process.env.ARKIBA_ADMIN_EMAILS;
    expect(plans.estEmailIllimite('  BenArken@Yahoo.com ')).toBe(true);
  });

  test('un email hors liste ne passe pas', () => {
    delete process.env.ARKIBA_ADMIN_EMAILS;
    expect(plans.estEmailIllimite('benarken@yahoo.com.attaquant.fr')).toBe(false);
    expect(plans.estEmailIllimite('autre@cabinet.fr')).toBe(false);
  });

  // Le drapeau ne doit pas être une porte dérobée : poser `illimite: true` en
  // base sur un compte hors whitelist doit être annulé au passage suivant.
  test('le drapeau est resynchronisé sur la whitelist', () => {
    process.env.ARKIBA_ADMIN_EMAILS = 'admin@arkiba.fr';
    const u = { id: 9, email: 'pirate@cabinet.fr', illimite: true };
    plans.normaliserCompte(u);
    expect(u.illimite).toBe(false);
    expect(plans.planEffectif(u)).toBe('trial');
  });

  test('retirer un email de la whitelist retire l\'accès', () => {
    process.env.ARKIBA_ADMIN_EMAILS = 'admin@arkiba.fr';
    const u = compteEssai({ email: 'admin@arkiba.fr' });
    expect(plans.planEffectif(u)).toBe('illimite');

    process.env.ARKIBA_ADMIN_EMAILS = 'quelquun.dautre@arkiba.fr';
    plans.normaliserCompte(u);
    expect(u.illimite).toBe(false);
    expect(plans.planEffectif(u)).toBe('trial');
  });
});

describe('normaliserCompte — migration des comptes existants', () => {
  test("un compte d'avant les plans démarre un essai plein", () => {
    const ancien = {
      id: 42,
      email: 'ancien@cabinet.fr',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    expect(plans.normaliserCompte(ancien)).toBe(true);
    expect(ancien.plan).toBe('trial');
    expect(plans.joursEssaiRestants(ancien)).toBe(plans.DUREE_ESSAI_JOURS);
    expect(plans.planEffectif(ancien)).toBe('trial');
  });

  test('une seconde normalisation ne change plus rien', () => {
    const u = compteEssai();
    expect(plans.normaliserCompte(u)).toBe(false);
  });
});

describe('etatAbonnement — ce que voit le front', () => {
  test("l'essai expose son décompte", () => {
    const u = compteEssai();
    plans.consommerDocument(u);
    const etat = plans.etatAbonnement(u);
    expect(etat.plan).toBe('trial');
    expect(etat.documents).toMatchObject({ utilises: 1, limite: plans.QUOTA_DOCUMENTS_ESSAI });
    expect(etat.fonctionnalites['generate.mdph']).toBe(false);
    expect(etat.fonctionnalites['generate.liaison']).toBe(true);
  });

  test('un compte illimité est signalé comme tel, sans plafond', () => {
    delete process.env.ARKIBA_ADMIN_EMAILS;
    const u = compteEssai({ email: 'sbh75@gmx.fr' });
    const etat = plans.etatAbonnement(u);
    expect(etat.illimite).toBe(true);
    expect(etat.documents.limite).toBeNull();
    expect(Object.values(etat.fonctionnalites).every(Boolean)).toBe(true);
  });
});

// ─── La vitrine ne doit pas annoncer une autre durée que celle appliquée ────
//
// Le dépôt a déjà connu cette panne avec la liste des spécialités : une copie
// figée dans une page avait divergé du serveur, et l'inscription refusait
// toutes ses propres options. La durée d'essai court le même risque — elle est
// écrite noir sur blanc à cinq endroits de la page d'accueil, et c'est
// lib/plans.js qui l'applique.

describe("durée d'essai annoncée sur la vitrine", () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    // Les commentaires HTML racontent l'historique de la page : ils peuvent
    // citer d'anciennes durées sans que le visiteur les voie.
    .replace(/<!--[\s\S]*?-->/g, '');

  test('aucune durée en jours ne contredit DUREE_ESSAI_JOURS', () => {
    const annoncees = [...page.matchAll(/(\d+)\s*jours?\b/gi)].map(m => Number(m[1]));
    const fautives  = annoncees.filter(n => n !== plans.DUREE_ESSAI_JOURS);
    expect(fautives).toEqual([]);
  });

  test('la durée appliquée est bien affichée quelque part', () => {
    expect(page).toMatch(new RegExp(plans.DUREE_ESSAI_JOURS + '\\s*jours'));
  });
});
