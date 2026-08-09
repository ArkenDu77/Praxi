/**
 * Arkiba — le portage de la pseudonymisation ne dérive pas de l'original.
 *
 * La refonte visuelle remplace le frontend. Le code de pseudonymisation, lui,
 * ne doit pas être réécrit à cette occasion : il décide de ce qui sort du poste
 * du médecin, et une variante « équivalente » écrite de mémoire est exactement
 * la façon dont ce genre de garantie se perd.
 *
 * `web/src/lib/pseudonymisation.js` est le portage destiné au nouveau frontend.
 * Ce test exécute les DEUX implémentations — celle encore livrée dans
 * `public/app.html` et le portage — sur le même corpus, et exige des résultats
 * identiques. Tant que les deux coexistent, aucune ne peut dériver.
 *
 * Quand `public/app.html` disparaîtra au profit du nouveau frontend, ce fichier
 * n'aura plus de comparaison à faire : supprimer alors le chargement de l'app
 * et conserver `tests/pseudonymisation.test.js`, pointé sur le portage.
 *
 * Run : npx jest tests/pseudonymisation-portage.test.js
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const RACINE = path.join(__dirname, '..');

// ─── Chargement des deux implémentations ────────────────────────────────────

const EXPORTS = [
  'PSEUDO_FIELDS', 'IDENTITY_TOKENS',
  'pseudonymize', 'pseudonymizePayload', 'resubstitute', 'nettoyerJetonsResiduels',
];

/** Exécute un source dans un bac à sable et en extrait l'API publique. */
function charger(source) {
  // console.warn est appelé par le filet de sécurité ; on le neutralise pour ne
  // pas polluer la sortie des tests, sans masquer les vraies erreurs.
  const sandbox = { console: { ...console, warn: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;globalThis.__api = { ${EXPORTS.join(', ')} };`, sandbox);
  return sandbox.__api;
}

/** L'original, extrait du script inline de public/app.html par marqueurs. */
function chargerOriginal() {
  const app   = fs.readFileSync(path.join(RACINE, 'public', 'app.html'), 'utf8');
  const DEBUT = '// Les champs de texte libre soumis à la pseudonymisation';
  const FIN   = 'function nettoyerJetonsResiduels(';
  const debut = app.indexOf(DEBUT);
  const decl  = app.indexOf(FIN);
  if (debut === -1 || decl === -1) {
    throw new Error('Bloc de pseudonymisation introuvable dans public/app.html — marqueurs à mettre à jour.');
  }
  return charger(app.slice(debut, app.indexOf('\n}\n', decl) + 3));
}

/** Le portage. Module ES : on retire les mots-clés `export` pour l'exécuter. */
function chargerPortage() {
  const src = fs.readFileSync(path.join(RACINE, 'web', 'src', 'lib', 'pseudonymisation.js'), 'utf8');
  return charger(src.replace(/^export\s+/gm, ''));
}

const ORIGINAL = chargerOriginal();
const PORTAGE  = chargerPortage();

// ─── Corpus ─────────────────────────────────────────────────────────────────

const CAS = [
  {
    nom: 'nom composé, âge, antécédents',
    patient: 'M. Dupont Jean', age: '67 ans',
    texte: 'M. Dupont Jean, 67 ans, consulte pour dyspnée. Dupont est suivi depuis 2018. '
         + 'Jean rapporte une gêne à l’effort.',
  },
  {
    nom: 'nom inversé et titre féminin',
    patient: 'Mme Martin Sophie', age: '54 ans',
    texte: 'Mme Sophie Martin, 54 ans. Martin Sophie a été vue en urgence. '
         + 'La patiente décrit des palpitations.',
  },
  {
    nom: 'NIR multiples — chacun doit garder son propre marqueur',
    patient: 'Jean Dupont', age: '',
    texte: 'Assuré 1850475123456, ayant droit 2790362987654. Contrôle des droits effectué.',
  },
  {
    nom: 'adresses multiples',
    patient: '', age: '',
    texte: 'Domicile : 12 rue des Lilas, 69003 Lyon. Travail : 4bis avenue Jean Jaurès, 69007 Lyon.',
  },
  {
    nom: 'dates de naissance, deux formes',
    patient: '', age: '',
    texte: 'Patient né le 22/04/1958, épouse née en 1961.',
  },
  {
    nom: 'seuils chiffrés à ne pas réécrire',
    patient: 'Paul Durand', age: '62 ans',
    texte: 'Paul Durand, 62 ans. Dépistage recommandé entre 50 et 74 ans ; AMM de 18 à 65 ans.',
  },
  {
    nom: 'aucune donnée identifiante',
    patient: '', age: '',
    texte: 'Auscultation cardiaque sans souffle. Absence d’œdème des membres inférieurs.',
  },
  {
    nom: 'nom court (moins de 4 caractères) et accents',
    patient: 'Léa Roy', age: '31 ans',
    texte: 'Léa Roy, 31 ans. Roy présente une éruption. Léa signale un prurit.',
  },
];

const TEXTES_RENDUS = [
  'Le patient présente une dyspnée. Ce dossier est complet. Monsieur consulte ce jour.',
  'PATIENT_CONFIDENTIEL, âgé de AGE_PATIENT, né le DDN_PATIENT, consulte pour bilan.',
  'M. le patient, AGE_PATIENT, a été reçu. Mon patient reste stable.',
  'Suivi de [numéro retiré 1] et de [adresse retirée 1]. Contrôle à six semaines.',
  'Information non renseignée (prénom et nom du patient) présente une HTA.',
  'La patiente (AGE_PATIENT) est adressée — DDN_PATIENT — pour avis.',
];

// ─── Équivalence ────────────────────────────────────────────────────────────

describe('le portage reproduit exactement la pseudonymisation livrée', () => {
  test('la table des champs couverts est identique', () => {
    expect(PORTAGE.PSEUDO_FIELDS).toEqual(ORIGINAL.PSEUDO_FIELDS);
  });

  test('les jetons d’identité sont identiques', () => {
    expect(PORTAGE.IDENTITY_TOKENS).toEqual(ORIGINAL.IDENTITY_TOKENS);
  });

  test.each(CAS.map(c => [c.nom, c]))('pseudonymize — %s', (_nom, cas) => {
    const a = ORIGINAL.pseudonymize(cas.texte, cas.patient, cas.age);
    const b = PORTAGE.pseudonymize(cas.texte, cas.patient, cas.age);
    expect(b.anonymizedText).toBe(a.anonymizedText);
    expect([...b.substitutions.entries()]).toEqual([...a.substitutions.entries()]);
  });

  test.each(Object.keys(ORIGINAL.PSEUDO_FIELDS))('pseudonymizePayload — %s', key => {
    const modele = {
      patient: 'M. Dupont Jean', age: '67 ans', ddn: '22/04/1958',
      motif: 'avis cardiologique pour M. Dupont Jean',
      notes: 'Dupont Jean, 67 ans, NIR 1580475123456, 12 rue des Lilas, 69003 Lyon.',
      complement: 'Jean rapporte une gêne depuis 3 semaines.',
      diagnostic: 'Fibrillation atriale chez Dupont',
      affection: 'ALD 5 — insuffisance cardiaque de M. Dupont',
      type: 'certificat d’aptitude pour Jean Dupont',
      medicaments: 'Bisoprolol 5 mg pour Dupont Jean',
      medicamentsAld: 'Apixaban 5 mg',
      text: 'Compte-rendu concernant Dupont Jean, né le 22/04/1958.',
    };
    const pa = { ...modele };
    const pb = { ...modele };
    const ra = ORIGINAL.pseudonymizePayload(key, pa);
    const rb = PORTAGE.pseudonymizePayload(key, pb);

    expect(pb).toEqual(pa);
    expect(rb.patientOrig).toBe(ra.patientOrig);
    expect([...rb.substitutions.entries()]).toEqual([...ra.substitutions.entries()]);
  });

  test('pseudonymizePayload renvoie null sur un type non couvert, des deux côtés', () => {
    expect(PORTAGE.pseudonymizePayload('inconnu', {})).toBe(ORIGINAL.pseudonymizePayload('inconnu', {}));
  });

  test.each(TEXTES_RENDUS)('resubstitute — %s', texte => {
    const subs = () => new Map([
      ['__age__', '67 ans'],
      ['__ddn__', '22/04/1958'],
      ['__nir_1__', '1580475123456'],
      ['__addr_1__', '12 rue des Lilas, 69003 Lyon'],
    ]);
    expect(PORTAGE.resubstitute(texte, subs(), 'M. Dupont Jean'))
      .toBe(ORIGINAL.resubstitute(texte, subs(), 'M. Dupont Jean'));
  });

  test.each(TEXTES_RENDUS)('resubstitute sans nom de patient — %s', texte => {
    const subs = () => new Map([['__age__', '67 ans']]);
    expect(PORTAGE.resubstitute(texte, subs(), ''))
      .toBe(ORIGINAL.resubstitute(texte, subs(), ''));
  });

  test.each(TEXTES_RENDUS)('nettoyerJetonsResiduels — %s', texte => {
    expect(PORTAGE.nettoyerJetonsResiduels(texte)).toBe(ORIGINAL.nettoyerJetonsResiduels(texte));
  });
});

// ─── Le portage tient seul les garanties attendues ──────────────────────────
// Comparer deux implémentations ne dit rien si les deux sont fausses ensemble.

describe('garanties portées par le module du nouveau frontend', () => {
  test('les sept documents porteurs de la promesse sont couverts', () => {
    for (const key of ['liaison', 'cr', 'consult', 'mdph', 'ald', 'certificat', 'ordonnance']) {
      expect(PORTAGE.PSEUDO_FIELDS[key]).toBeDefined();
      expect(PORTAGE.PSEUDO_FIELDS[key].length).toBeGreaterThan(0);
    }
  });

  test('aucun jeton d’identité ne survit dans un document rendu', () => {
    const rendu = PORTAGE.resubstitute(
      'PATIENT_CONFIDENTIEL, âgé de AGE_PATIENT, né le DDN_PATIENT, consulte.',
      new Map(), '',
    );
    expect(rendu).not.toMatch(/PATIENT_CONFIDENTIEL|AGE_PATIENT|DDN_PATIENT/);
  });

  test('le nom du patient ne part jamais en clair dans un champ couvert', () => {
    const payload = { patient: 'M. Dupont Jean', age: '67 ans', notes: 'Dupont Jean se plaint de vertiges.' };
    PORTAGE.pseudonymizePayload('cr', payload);
    expect(payload.notes).not.toMatch(/Dupont|Jean/);
    expect(payload.patient).toBe('PATIENT_CONFIDENTIEL');
  });

  test('deux NIR distincts restent distincts après restitution', () => {
    const subs = new Map();
    const { anonymizedText } = PORTAGE.pseudonymize(
      'Assuré 1850475123456, ayant droit 2790362987654.', '', '', subs,
    );
    expect(anonymizedText).toContain('[numéro retiré 1]');
    expect(anonymizedText).toContain('[numéro retiré 2]');
    const rendu = PORTAGE.resubstitute(anonymizedText, subs, '');
    expect(rendu).toContain('1850475123456');
    expect(rendu).toContain('2790362987654');
  });

  test('les seuils chiffrés du document ne sont pas réécrits avec l’âge du patient', () => {
    const rendu = PORTAGE.resubstitute(
      'Dépistage recommandé entre 50 et 74 ans. Patient de AGE_PATIENT.',
      new Map([['__age__', '67 ans']]), '',
    );
    expect(rendu).toContain('entre 50 et 74 ans');
    expect(rendu).toContain('67 ans');
  });
});
