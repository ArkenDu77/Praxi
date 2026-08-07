/**
 * Praxi — Tests de la pseudonymisation côté client.
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
const FIN   = 'function resubstitute(';

function extraireBloc() {
  const debut = APP.indexOf(DEBUT);
  const finDeclaration = APP.indexOf(FIN);
  if (debut === -1 || finDeclaration === -1) {
    throw new Error('Bloc de pseudonymisation introuvable dans public/app.html — marqueurs à mettre à jour.');
  }
  // resubstitute() se termine à la première accolade en colonne 0 après sa
  // déclaration : le script inline suit la même convention partout.
  const finBloc = APP.indexOf('\n}\n', finDeclaration) + 3;
  return APP.slice(debut, finBloc);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  extraireBloc() +
  '\n;globalThis.__api = { PSEUDO_FIELDS, IDENTITY_TOKENS, pseudonymize, pseudonymizePayload, resubstitute };',
  sandbox
);
const { PSEUDO_FIELDS, pseudonymize, pseudonymizePayload, resubstitute } = sandbox.__api;

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
