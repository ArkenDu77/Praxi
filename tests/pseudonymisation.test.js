/**
 * Arkiba — Tests de la pseudonymisation côté client.
 *
 * Ces fonctions décident de ce qui sort du poste du médecin et de ce qui
 * revient dans un document signé : ce sont les deux points où une régression
 * est à la fois invisible et grave. Le code vit dans le script inline de
 * public/app.html ; on l'en extrait par marqueurs plutôt que de le dupliquer,
 * pour que le test porte sur le code réellement livré.
 *
 * Run : npx jest tests/pseudonymisation.test.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

const DEBUT = '// Les champs de texte libre soumis à la pseudonymisation';
// Le bloc s'arrête après nettoyerJetonsResiduels(), que resubstitute() appelle :
// couper à la fin de resubstitute() laissait une référence non résolue.
const FIN   = 'function nettoyerJetonsResiduels(';

function extraireBloc() {
  const debut = APP.indexOf(DEBUT);
  const finDeclaration = APP.indexOf(FIN);
  if (debut === -1 || finDeclaration === -1) {
    throw new Error('Bloc de pseudonymisation introuvable dans public/app.html — marqueurs à mettre à jour.');
  }
  // La fonction se termine à la première accolade en colonne 0 après sa
  // déclaration : le script inline suit la même convention partout.
  const finBloc = APP.indexOf('\n}\n', finDeclaration) + 3;
  return APP.slice(debut, finBloc);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  extraireBloc() +
  '\n;globalThis.__api = { PSEUDO_FIELDS, IDENTITY_TOKENS, pseudonymize, pseudonymizePayload, resubstitute, nettoyerJetonsResiduels };',
  sandbox
);
const { PSEUDO_FIELDS, pseudonymize, pseudonymizePayload, resubstitute, nettoyerJetonsResiduels } = sandbox.__api;

// ─── COUVERTURE ────────────────────────────────────────────────────────────
// Trois écrans (certificat MDPH, protocole ALD, certificat médical) affichaient
// la mention « données identifiantes anonymisées avant envoi » alors que le nom
// du patient et son diagnostic partaient en clair : seules les notes de la
// lettre de liaison, du compte-rendu et de la consultation étaient traitées.

describe('couverture des types de documents', () => {
  const ECRANS_AVEC_PROMESSE = ['liaison', 'cr', 'consult', 'mdph', 'ald', 'certificat', 'ordonnance'];

  test.each(ECRANS_AVEC_PROMESSE)('%s est couvert par la pseudonymisation', key => {
    expect(PSEUDO_FIELDS[key]).toBeDefined();
    expect(PSEUDO_FIELDS[key].length).toBeGreaterThan(0);
  });

  test('le champ complément, présent partout, est toujours couvert', () => {
    for (const key of ECRANS_AVEC_PROMESSE) {
      expect(PSEUDO_FIELDS[key]).toContain('complement');
    }
  });

  test('le motif de la lettre de liaison est couvert', () => {
    expect(PSEUDO_FIELDS.liaison).toContain('motif');
  });

  test("aucun nom de patient ne part en clair sur un certificat MDPH", () => {
    const payload = {
      patient: 'Jean Dupont',
      diagnostic: 'Sclérose en plaques diagnostiquée chez M. Dupont en 2019.',
      notes: 'Dupont se déplace avec une canne depuis 2022.',
    };
    pseudonymizePayload('mdph', payload);
    const envoye = JSON.stringify(payload);
    expect(envoye).not.toMatch(/Dupont/i);
    expect(payload.patient).toBe('PATIENT_CONFIDENTIEL');
  });

  test('le nom, la date de naissance et les médicaments d’une ordonnance sont traités', () => {
    const payload = {
      patient: 'Marie Curie',
      ddn: '1867-11-07',
      medicaments: 'Paracétamol 1 g pour Mme Curie',
      medicamentsAld: '',
      bizone: false,
    };
    pseudonymizePayload('ordonnance', payload);
    expect(payload.patient).toBe('PATIENT_CONFIDENTIEL');
    expect(payload.ddn).toBe('DDN_PATIENT');
    expect(payload.medicaments).not.toMatch(/Curie/i);
  });
});

// ─── ALLER-RETOUR ──────────────────────────────────────────────────────────

describe('aller-retour pseudonymisation → document final', () => {
  test('le nom, l’âge et la date de naissance reviennent dans le document', () => {
    const payload = { patient: 'Jean Dupont', age: '67 ans', ddn: '12/03/1958', medicaments: 'Metformine 1000 mg', complement: '' };
    const { substitutions, patientOrig } = pseudonymizePayload('ordonnance', payload);

    const reponseModele = 'ORDONNANCE\nPatient : PATIENT_CONFIDENTIEL, né le DDN_PATIENT, AGE_PATIENT\n1. Metformine 1000 mg';
    const final = resubstitute(reponseModele, substitutions, patientOrig);

    expect(final).toContain('Jean Dupont');
    expect(final).toContain('12/03/1958');
    expect(final).toContain('67 ans');
    expect(final).not.toMatch(/PATIENT_CONFIDENTIEL|DDN_PATIENT|AGE_PATIENT/);
  });

  test('deux adresses distinctes ne sont pas confondues', () => {
    // La version précédente ne gardait qu'une valeur par catégorie et
    // restituait la première partout : l'adresse du patient se retrouvait
    // recopiée à la place de celle du confrère.
    const texte = 'Patient domicilié 12 rue des Lilas, 75011 Paris. '
                + 'Adresser au cabinet situé 5 avenue Victor Hugo, 75116 Paris.';
    const { anonymizedText, substitutions } = pseudonymize(texte, '', '');

    expect(anonymizedText).not.toMatch(/rue des Lilas|avenue Victor Hugo/);
    const final = resubstitute(anonymizedText, substitutions, '');
    expect(final).toContain('12 rue des Lilas');
    expect(final).toContain('5 avenue Victor Hugo');
  });

  test('deux numéros de sécurité sociale ne sont pas confondus', () => {
    const texte = 'NIR patient 1580375116001, NIR conjoint 2640175056002.';
    const { anonymizedText, substitutions } = pseudonymize(texte, '', '');

    expect(anonymizedText).not.toMatch(/1580375116001|2640175056002/);
    const final = resubstitute(anonymizedText, substitutions, '');
    expect(final).toContain('1580375116001');
    expect(final).toContain('2640175056002');
  });
});

// ─── INTÉGRITÉ CLINIQUE DU DOCUMENT RESTITUÉ ───────────────────────────────
// La restitution comportait deux règles de rattrapage qui remplaçaient TOUTE
// tranche d'âge du document par l'âge du patient. Un seuil de dépistage ou une
// tranche d'AMM se retrouvait réécrit en silence dans un document signé.

describe("les tranches d'âge cliniques ne sont pas réécrites", () => {
  const subs = new Map([['__age__', '67 ans']]);

  test('un seuil de dépistage « entre 50 et 74 ans » reste intact', () => {
    const texte = 'Le patient a AGE_PATIENT. Le dépistage organisé est proposé entre 50 et 74 ans.';
    const final = resubstitute(texte, subs, 'Jean Dupont');
    expect(final).toContain('entre 50 et 74 ans');
    expect(final).toContain('67 ans');
  });

  test("une tranche d'AMM « 18-65 ans » reste intacte", () => {
    const texte = 'Traitement indiqué 18-65 ans. Âge du patient : AGE_PATIENT.';
    const final = resubstitute(texte, subs, 'Jean Dupont');
    expect(final).toContain('18-65 ans');
  });
});

// ─── LIMITES ASSUMÉES ──────────────────────────────────────────────────────

describe('analyse de document collé', () => {
  test('les identifiants de forme fixe sont retirés même sans nom connu', () => {
    const payload = { text: 'Compte-rendu. NIR 1580375116001. Domicile : 12 rue des Lilas, 75011 Paris.' };
    pseudonymizePayload('resume', payload);
    expect(payload.text).not.toMatch(/1580375116001/);
    expect(payload.text).not.toMatch(/rue des Lilas/);
  });
});

// ─── JETONS NON RESTITUÉS ───────────────────────────────────────────────────
// Constaté en production sur l'écran « Compte-rendu de consultation » : le
// document généré contenait « AGE_PATIENT » en clair, deux fois. Ce formulaire
// n'avait pas de champ Âge, le jeton ne pouvait donc jamais être résolu — mais
// le prompt serveur annonçait son existence au modèle, qui l'écrivait quand
// même. La cause est traitée côté serveur ; ce filet garantit qu'aucun jeton
// n'atteint l'écran même si une régression de prompt le réintroduit.

describe('nettoyage des jetons non restitués', () => {
  const JETONS = /AGE_PATIENT|DDN_PATIENT|PATIENT_CONFIDENTIEL/;

  const cas = [
    ['préposition simple', 'Patient de AGE_PATIENT, admis pour douleur thoracique.'],
    ['apposition entre virgules', 'M. Dupont, âgé de AGE_PATIENT, consulte ce jour.'],
    ['entre parenthèses', 'Le patient (AGE_PATIENT) présente une dyspnée.'],
    ['en début de phrase', 'Né le DDN_PATIENT, il est suivi depuis 2019.'],
    ['seul sur sa ligne', 'MOTIF :\nAGE_PATIENT\nToux fébrile.'],
    ['en fin de document', 'Conclusion : surveillance à 3 mois. AGE_PATIENT'],
    ['occurrences multiples', 'AGE_PATIENT puis encore AGE_PATIENT.'],
  ];

  test.each(cas)('retire le jeton — %s', (_nom, texte) => {
    expect(nettoyerJetonsResiduels(texte)).not.toMatch(JETONS);
  });

  test.each(cas)('ne laisse pas de ponctuation orpheline — %s', (_nom, texte) => {
    const r = nettoyerJetonsResiduels(texte);
    expect(r).not.toMatch(/,\s*,/);       // virgules jumelles
    expect(r).not.toMatch(/\s,/);         // espace avant virgule
    expect(r).not.toMatch(/^\s*[,;]/m);   // ponctuation en tête de ligne
  });

  test('une apposition retirée ne laisse pas de virgule avant le verbe', () => {
    expect(nettoyerJetonsResiduels('M. Dupont, âgé de AGE_PATIENT, consulte ce jour.'))
      .toBe('M. Dupont consulte ce jour.');
  });

  test('un texte sans jeton est rendu inchangé', () => {
    const intact = 'Suivi depuis 2019, traitement de 500 mg, patient de 45 ans, RAS.';
    expect(nettoyerJetonsResiduels(intact)).toBe(intact);
  });

  test('les valeurs chiffrées cliniques ne sont pas touchées', () => {
    const t = 'Dépistage entre 50 et 74 ans. Posologie 1500 mg. AGE_PATIENT';
    const r = nettoyerJetonsResiduels(t);
    expect(r).toContain('entre 50 et 74 ans');
    expect(r).toContain('1500 mg');
    expect(r).not.toMatch(JETONS);
  });

  test('resubstitute applique le nettoyage en bout de chaîne', () => {
    // Aucune substitution d'âge fournie : le jeton ne peut pas être résolu.
    const out = resubstitute('Patient de AGE_PATIENT, vu ce jour.', new Map(), '');
    expect(out).not.toMatch(JETONS);
  });
});

// ─── CAUSE RACINE : CONSIGNE DE JETONS CÔTÉ SERVEUR ────────────────────────
// Le prompt annonçait la liste complète des jetons en dur. Le modèle lisait
// donc « AGE_PATIENT représente une donnée disponible mais masquée, recopie-la
// à chaque emplacement naturel de l'âge » même quand aucun âge n'avait été
// transmis, et l'écrivait consciencieusement.

describe('consigne de jetons construite depuis la requête', () => {
  process.env.JWT_SECRET  = process.env.JWT_SECRET  || 'test-secret-key-min-32-chars-000000';
  process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';
  const { consigneJetons } = require('../server');

  test('sans âge transmis, AGE_PATIENT est explicitement interdit', () => {
    const r = consigneJetons({ body: { patient: 'PATIENT_CONFIDENTIEL', notes: 'Toux fébrile.' } });
    expect(r).toMatch(/INTERDICTION/);
    expect(r).toMatch(/n'écris JAMAIS[^.]*AGE_PATIENT/);
  });

  test('avec âge transmis, AGE_PATIENT est annoncé et non interdit', () => {
    const r = consigneJetons({ body: { patient: 'PATIENT_CONFIDENTIEL', age: 'AGE_PATIENT', notes: 'x' } });
    expect(r).toMatch(/JETONS DE PSEUDONYMISATION[^.]*AGE_PATIENT/);
    expect(r).not.toMatch(/n'écris JAMAIS[^.]*AGE_PATIENT/);
  });

  test('un corps sans aucun jeton n\'annonce rien et interdit les trois', () => {
    const r = consigneJetons({ body: { notes: 'Consultation de suivi.' } });
    expect(r).not.toMatch(/JETONS DE PSEUDONYMISATION/);
    for (const j of ['PATIENT_CONFIDENTIEL', 'AGE_PATIENT', 'DDN_PATIENT']) {
      expect(r).toContain(j);
    }
    expect(r).toMatch(/INTERDICTION/);
  });

  test('les marqueurs numérotés sont annoncés quand ils sont présents', () => {
    const r = consigneJetons({ body: { notes: 'Vit au [adresse retirée 1] depuis 2019.' } });
    expect(r).toMatch(/\[adresse retirée 1\]/);
  });

  test('un marqueur absent n\'est pas annoncé', () => {
    const r = consigneJetons({ body: { notes: 'Rien de particulier.' } });
    expect(r).not.toMatch(/numéro retiré/);
  });
});
