/**
 * ============================================================================
 *  LE COMPTE PROPRIÉTAIRE GARDE SON ACCÈS, QUOI QU'IL ARRIVE AU DÉPLOIEMENT
 * ============================================================================
 *
 * Les comptes fondateurs ont un accès illimité : aucun paiement, aucun
 * plafond, tous les modules, et un essai qui ne peut pas expirer sous eux.
 *
 * Ce banc existe parce que ce droit était plus fragile qu'il n'en avait
 * l'air. `ARKIBA_ADMIN_EMAILS` REMPLAÇAIT la liste des fondateurs au lieu de
 * s'y ajouter. Poser cette variable sur un déploiement — pour ouvrir l'accès
 * à un testeur, disons — retirait donc l'accès aux fondateurs, en silence ;
 * et `normaliserCompte()` allait jusqu'à baisser leur drapeau en base au
 * passage suivant. Personne n'aurait fait le lien entre les deux.
 *
 * Un réglage d'exploitation ne doit pas pouvoir retirer un droit qui ne lui
 * appartient pas. Il ouvre, il ne ferme pas.
 *
 * L'email du propriétaire n'est jamais écrit ici : il est lu depuis le code
 * qui fait foi. Un banc qui recopie la valeur qu'il vérifie ne vérifie rien,
 * et il la publie dans un fichier de test par-dessus le marché.
 *
 * Run : npx jest tests/compte-proprietaire.test.js
 */

const plans = require('../lib/plans');

/**
 * Le premier compte fondateur, tel que le code le déclare. On ne le recopie
 * pas : on demande au module qui décide.
 */
const PROPRIETAIRE = (() => {
  const avant = process.env.ARKIBA_ADMIN_EMAILS;
  delete process.env.ARKIBA_ADMIN_EMAILS;
  const source = require('fs').readFileSync(require.resolve('../lib/plans.js'), 'utf8');
  const bloc = source.match(/ADMIN_EMAILS_PAR_DEFAUT = \[([\s\S]*?)\]/);
  if (!bloc) throw new Error('liste des comptes fondateurs introuvable dans lib/plans.js');
  const emails = [...bloc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (emails.length === 0) throw new Error('la liste des comptes fondateurs est VIDE');
  if (avant !== undefined) process.env.ARKIBA_ADMIN_EMAILS = avant;
  return emails;
})();

const compte = (email, extra = {}) => {
  const u = { id: 1, email, createdAt: '2020-01-01T00:00:00.000Z', ...extra };
  plans.normaliserCompte(u);
  return u;
};

beforeEach(() => {
  delete process.env.ARKIBA_ADMIN_EMAILS;
});

describe('le compte propriétaire', () => {
  test('IL Y A AU MOINS UN COMPTE FONDATEUR — la liste ne peut pas être vidée', () => {
    expect(PROPRIETAIRE.length).toBeGreaterThan(0);
  });

  test('ACCÈS ILLIMITÉ', () => {
    for (const email of PROPRIETAIRE) {
      expect(plans.estEmailIllimite(email)).toBe(true);
      expect(plans.planEffectif(compte(email))).toBe('illimite');
      expect(plans.estIllimite(compte(email))).toBe(true);
    }
  });

  test('AUCUN QUOTA — ni documents, ni patients', () => {
    for (const email of PROPRIETAIRE) {
      const droits = plans.droits(compte(email));
      expect(droits.documents).toBe(Infinity);
      expect(droits.patients).toBe(Infinity);
    }
  });

  test('TOUS LES MODULES — base ET pro', () => {
    for (const email of PROPRIETAIRE) {
      const droits = plans.droits(compte(email));
      expect(droits.base).toBe(true);
      expect(droits.pro).toBe(true);
    }
  });

  test('AUCUN ESSAI EXPIRÉ BLOQUANT — même créé il y a des années', () => {
    for (const email of PROPRIETAIRE) {
      // Un essai largement périmé, et un plan `free` écrit en base : le compte
      // reste illimité. L'expiration ne s'applique pas à lui.
      const u = compte(email, { plan: 'free', trialEndsAt: '2020-02-01T00:00:00.000Z' });
      expect(plans.planEffectif(u)).toBe('illimite');
      expect(plans.droits(u).base).toBe(true);
    }
  });

  test('LA CASSE NE CHANGE RIEN', () => {
    for (const email of PROPRIETAIRE) {
      expect(plans.estEmailIllimite(email.toUpperCase())).toBe(true);
      expect(plans.estEmailIllimite(` ${email} `)).toBe(true);
    }
  });
});

describe("ARKIBA_ADMIN_EMAILS ajoute, elle ne retire jamais", () => {
  test('UNE VARIABLE POSÉE SUR LE DÉPLOIEMENT NE RETIRE PAS LE PROPRIÉTAIRE', () => {
    // Le défaut exact : cette variable remplaçait la liste. La poser ce soir,
    // pour n'importe quelle raison, aurait coupé l'accès du propriétaire.
    process.env.ARKIBA_ADMIN_EMAILS = 'un.testeur@exemple.fr';
    for (const email of PROPRIETAIRE) {
      expect(plans.estEmailIllimite(email)).toBe(true);
      expect(plans.planEffectif(compte(email))).toBe('illimite');
    }
  });

  test('et le compte ajouté obtient bien l\'accès', () => {
    process.env.ARKIBA_ADMIN_EMAILS = 'un.testeur@exemple.fr';
    expect(plans.estEmailIllimite('un.testeur@exemple.fr')).toBe(true);
  });

  test('LE DRAPEAU EN BASE N\'EST PAS BAISSÉ SOUS LE PROPRIÉTAIRE', () => {
    // `normaliserCompte()` resynchronise `illimite` sur la whitelist. Quand la
    // whitelist perdait le propriétaire, elle le dégradait donc en base — un
    // dégât persistant, pas un simple refus au moment de la lecture.
    process.env.ARKIBA_ADMIN_EMAILS = 'un.testeur@exemple.fr';
    for (const email of PROPRIETAIRE) {
      const u = { id: 1, email, illimite: true, createdAt: '2020-01-01T00:00:00.000Z' };
      plans.normaliserCompte(u);
      expect(u.illimite).toBe(true);
    }
  });

  test('un compte hors liste reste hors liste', () => {
    process.env.ARKIBA_ADMIN_EMAILS = 'un.testeur@exemple.fr';
    expect(plans.estEmailIllimite('pirate@cabinet.fr')).toBe(false);
    // Et le suffixe qui imite un fondateur ne passe pas davantage.
    expect(plans.estEmailIllimite(`${PROPRIETAIRE[0]}.attaquant.fr`)).toBe(false);
  });
});
