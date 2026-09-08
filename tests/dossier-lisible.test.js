/**
 * ============================================================================
 *  LE MÉDECIN VOIT TOUT CE QUE LE PATIENT A DIT, ET AUCUN NOM DE CLÉ
 * ============================================================================
 *
 * Le premier vrai parcours d'Arkiba — rendez-vous Doctolib, appel réel,
 * quarante-trois tours de conversation — a produit une trentaine de faits
 * cliniques. L'écran en a affiché DEUX.
 *
 * La cause était entièrement ici. `pcRendre()` lisait des chemins écrits à la
 * main qui appartiennent au schéma de STOCKAGE du moteur
 * (`substance_use.tobacco`, `anesthesia_history.previous_anesthesia`), alors
 * que la charge exposée suit un schéma d'AFFICHAGE (`perioperative.tobacco`,
 * `history.anesthetic.previous_anesthesia`). Les chemins rendaient
 * `undefined`, les lignes n'étaient pas ajoutées, rien n'était journalisé.
 * Le tabac, l'alcool, la capacité à l'effort, le diabète, l'asthme, les
 * antécédents anesthésiques : tout disparaissait en silence.
 *
 * Le même code comparait `=== 'yes'` quand le moteur rend « oui ».
 *
 * Et la carte « À vérifier » affichait les alertes internes, dont le libellé
 * est un nom de mécanique : « transcript_review ». Le médecin lisait donc du
 * jargon là où il attendait une consigne.
 *
 * Ce banc exécute VRAIMENT les fonctions de l'écran sur une charge de la même
 * forme que celle du moteur. Un banc qui cherche une chaîne dans le fichier
 * valide une chaîne, pas un comportement — cette leçon a déjà été payée ici.
 *
 * Run : npx jest tests/dossier-lisible.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

function extraire(source, signature) {
  const d = source.indexOf(signature);
  if (d < 0) throw new Error(`introuvable : ${signature}`);
  const f = source.indexOf('\n}\n', d);
  if (f < 0) throw new Error(`fin introuvable : ${signature}`);
  return source.slice(d, f + 3);
}

/** Un fait tel que le moteur le rend : valeur, citation, libellé, chemin. */
const fait = (label, section, editable_path, value, patient_statement = null) => ({
  value,
  patient_statement,
  confidence: value === null ? 'unknown' : 'reported',
  asr_confidence: null,
  provenance: 'patient_reported',
  source_question_id: null,
  source_question_text: null,
  timestamp: null,
  evidence: null,
  label,
  section,
  editable_path,
});

/**
 * La charge du moteur, dans la forme exacte du premier dossier réel : des
 * faits regroupés par lecture médicale, des listes, et les points de
 * relecture rédigés en français.
 */
function chargeReelle() {
  return {
    clinical_data: {
      model_version: '1.0',
      patient: {
        last_name: fait('Nom', 'identite', 'patient.last_name', 'GIBEAU'),
        first_name: fait('Prénom', 'identite', 'patient.first_name', 'Marius'),
        date_of_birth: fait('Date de naissance', 'identite', 'patient.date_of_birth', null),
      },
      planned_procedure: fait(
        'Intervention prévue',
        'intervention',
        'appointment.procedure_normalized',
        "Consultation de suivi d'addictologie",
      ),
      history: {
        anesthetic: {
          previous_anesthesia: fait(
            'A déjà été anesthésié',
            'antecedents',
            'anesthesia_history.previous_anesthesia',
            'non',
          ),
        },
        medical: [],
        surgical: [],
      },
      cardiovascular: {
        hypertension: fait('Hypertension', 'coeur', 'cardiovascular.hypertension', 'non'),
        functional_capacity: fait(
          "Capacité à l'effort",
          'coeur',
          'functional_capacity.raw_description',
          "10 étage(s) sans s'arrêter",
          'Je dirais une bonne dizaine.',
        ),
        pacemaker: fait('Pacemaker ou défibrillateur', 'coeur', 'cardiovascular.pacemaker', null),
      },
      perioperative: {
        tobacco: fait('Tabac', 'perioperatoire', 'substance_use.tobacco', 'non'),
        alcohol: fait('Alcool', 'perioperatoire', 'substance_use.alcohol', 'non'),
        diabetes: fait('Diabète', 'perioperatoire', 'chronic_conditions.diabetes', 'non'),
        asthma: fait('Asthme', 'perioperatoire', 'chronic_conditions.asthma', 'non'),
      },
      medications: [
        {
          id: 'med_1',
          name: { value: 'doliprane', patient_statement: "Je prends du doliprane et de l'Aerius." },
          normalized_name: 'Doliprane',
          dose: { value: null },
          frequency: { value: null },
          temporal_status: 'current',
        },
      ],
      allergies: [],
      uncertain_information: [
        {
          field: 'appointment.procedure',
          label: 'À vérifier après relecture de l\'appel',
          detail: 'Aucune normalisation sûre : la phrase du patient est conservée telle quelle.',
          field_label: 'Intervention prévue',
          editable_path: 'appointment.procedure_normalized',
        },
      ],
      missing_information: [
        {
          field: 'cardiovascular.pacemaker',
          label: 'Savoir si le patient porte un pacemaker ou un défibrillateur',
          reason: 'posée, sans réponse exploitable',
          field_label: 'Pacemaker ou défibrillateur',
          editable_path: 'cardiovascular.pacemaker',
        },
      ],
      attention_points: [],
    },
    nommage: {
      sections: [
        { id: 'identite', titre: 'Patient' },
        { id: 'intervention', titre: 'Motif et intervention' },
        { id: 'antecedents', titre: 'Antécédents' },
        { id: 'traitements', titre: 'Traitements et allergies' },
        { id: 'coeur', titre: "Cœur et capacité à l'effort" },
        { id: 'perioperatoire', titre: 'Points péri-opératoires' },
      ],
      listes: {
        medications: { libelle: 'Traitements en cours', section: 'traitements', vide: 'Aucun traitement signalé' },
        allergies: { libelle: 'Allergies', section: 'traitements', vide: 'Aucune allergie signalée' },
        'history.medical': {
          libelle: 'Antécédents médicaux',
          section: 'antecedents',
          vide: 'Aucun antécédent médical signalé',
        },
      },
    },
    encounter: {
      encounter_id: 'enc_banc',
      // Les alertes internes existent toujours dans la charge ; l'écran ne
      // doit plus les afficher, c'est par là que « transcript_review » passait.
      alerts: [{ label: 'transcript_review', detail: 'Aucune normalisation sûre.', severity: 'info' }],
    },
  };
}

/** Exécute vraiment le rendu et rend le HTML peint dans chaque carte. */
function peindre(charge) {
  const peint = { 'pc-intake': '', 'pc-alerts': '', 'pc-alerts-card': null };
  const elements = {};
  const el = (id) => {
    if (!elements[id]) {
      elements[id] = {
        _id: id,
        set innerHTML(v) { peint[id] = v; },
        get innerHTML() { return peint[id]; },
        set hidden(v) { peint[id + '-hidden'] = v; },
        get hidden() { return peint[id + '-hidden']; },
        textContent: '',
        // L'écran câble ses corrections sur les éléments qu'il vient de
        // peindre. Ce banc ne teste pas le câblage — il teste ce qui est
        // peint — mais il doit laisser le code s'exécuter jusqu'au bout.
        querySelectorAll: () => [],
        addEventListener: () => {},
      };
    }
    return elements[id];
  };
  const bac = {
    document: { getElementById: el },
    pcEncounter: charge,
    console,
  };
  vm.createContext(bac);
  for (const sig of [
    'function pcEchappe(',
    'function pcFaits(',
    'function pcValeur(',
    'function pcLigneFait(',
    'function pcLigneListe(',
    'function pcRendreIntake()',
    'function pcPointsAVerifier()',
    'function pcRendreAVerifier()',
  ]) {
    vm.runInContext(extraire(SOURCE, sig), bac);
  }
  vm.runInContext('pcRendreIntake(); pcRendreAVerifier();', bac);
  return { intake: peint['pc-intake'], alerts: peint['pc-alerts'], alertsCache: peint['pc-alerts-card-hidden'] };
}

/**
 * Ce que le medecin LIT : sans balises, et avec les entites rendues telles
 * qu'un navigateur les affiche. Comparer du HTML brut ferait echouer un test
 * sur une apostrophe echappee, ce qui ne dit rien de ce qui est a l'ecran.
 */
const texte = (html) =>
  String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe('le dossier affiché au médecin', () => {
  test('MONTRE LES FAITS QUI DISPARAISSAIENT — tabac, alcool, effort, antécédents', () => {
    const intake = texte(peindre(chargeReelle()).intake);
    // Exactement les données que le médecin n'a pas vues après le vrai appel.
    for (const attendu of [
      'Tabac',
      'Alcool',
      "Capacité à l'effort",
      "10 étage(s) sans s'arrêter",
      'A déjà été anesthésié',
      'Diabète',
      'Asthme',
      'Hypertension',
    ]) {
      expect(intake).toContain(attendu);
    }
  });

  test("COMPREND « oui » / « non » — pas « yes » / « no »", () => {
    const { intake } = peindre(chargeReelle());
    // L'ancien écran comparait à 'yes' : toute réponse française tombait dans
    // la branche « non renseigné ».
    expect(intake).toContain('non');
    expect(intake).not.toContain('>yes<');
  });

  test("N'AFFICHE AUCUN NOM DE CLÉ INTERNE", () => {
    const { intake, alerts } = peindre(chargeReelle());
    const visible = texte(intake + alerts);
    for (const jargon of [
      'transcript_review',
      'cardiovascular.pacemaker',
      'appointment.procedure',
      'substance_use',
      'perioperative',
      'anesthesia_history',
    ]) {
      expect(visible).not.toContain(jargon);
    }
  });

  test('CITE LE PATIENT quand la phrase source existe', () => {
    const { intake } = peindre(chargeReelle());
    expect(intake).toContain('Je dirais une bonne dizaine.');
  });

  test('MONTRE CE QUI N\'A PAS ÉTÉ OBTENU, sans le cacher', () => {
    const { intake } = peindre(chargeReelle());
    expect(intake).toContain('non renseigné');
    expect(intake).toContain('information(s) non obtenue(s)');
  });

  test('RANGE PAR SECTION, avec les titres du moteur', () => {
    const intake = texte(peindre(chargeReelle()).intake);
    for (const titre of ['Patient', 'Antécédents', "Cœur et capacité à l'effort", 'Points péri-opératoires']) {
      expect(intake).toContain(titre);
    }
  });

  test('REND LES LISTES : traitements présents, allergies explicitement absentes', () => {
    const { intake } = peindre(chargeReelle());
    expect(intake).toContain('Doliprane');
    expect(intake).toContain('Aucune allergie signalée');
  });

  test("NE PERD PAS un fait que le moteur n'a pas su nommer", () => {
    // Le repli ne doit ni inventer un intitulé à partir de la clé, ni jeter
    // la donnée. Les deux seraient une régression de ce qu'on vient de payer.
    const charge = chargeReelle();
    charge.clinical_data.perioperative.chose_nouvelle = fait(null, 'autre', null, 'valeur-inedite');
    const { intake } = peindre(charge);
    expect(intake).toContain('valeur-inedite');
    expect(texte(intake)).not.toContain('chose_nouvelle');
  });
});

describe('la carte « À vérifier »', () => {
  test("VIENT DES POINTS DE RELECTURE, pas des alertes internes", () => {
    const { alerts } = peindre(chargeReelle());
    expect(alerts).toContain('Intervention prévue');
    expect(alerts).toContain('Pacemaker ou défibrillateur');
    // Le motif est rédigé pour un médecin, pas recopié du moteur : « posée,
    // sans réponse exploitable » est une note d'ingénieur.
    expect(alerts).toContain("Le patient n&#39;a pas donné de réponse exploitable.");
    expect(alerts).not.toContain('transcript_review');
  });

  test('reste masquée quand il n\'y a rien à vérifier', () => {
    const charge = chargeReelle();
    charge.clinical_data.uncertain_information = [];
    charge.clinical_data.missing_information = [];
    const { alertsCache } = peindre(charge);
    expect(alertsCache).toBe(true);
  });
});

describe('chaque donnée est corrigible par le médecin', () => {
  test('OFFRE UNE CORRECTION SUR CHAQUE FAIT CORRIGIBLE', () => {
    const { intake } = peindre(chargeReelle());
    const boutons = intake.match(/class="pc-corriger"/g) || [];
    expect(boutons.length).toBeGreaterThanOrEqual(8);
  });

  test('ENVOIE LE CHEMIN DE STOCKAGE, jamais le chemin d\'affichage', () => {
    // C'est la faute symétrique de celle qui a vidé l'écran : une correction
    // envoyée sur un chemin d'affichage est acceptée en 200 et n'écrit rien.
    // Le médecin croirait avoir corrigé une donnée qui resterait fausse.
    const { intake } = peindre(chargeReelle());
    expect(intake).toContain('data-champ="substance_use.tobacco"');
    expect(intake).toContain('data-champ="functional_capacity.raw_description"');
    expect(intake).not.toContain('data-champ="perioperative.tobacco"');
  });

  test('LA CORRECTION SE FAIT DANS LA CARTE, sans aller chercher ailleurs', () => {
    // Un bouton « Corriger » qui renvoyait chercher le champ trente lignes
    // plus bas est exactement ce qui rendait l'écran pénible : on voyait le
    // problème sans pouvoir le régler.
    const { alerts } = peindre(chargeReelle());
    expect(alerts).toContain('pc-souci-saisie');
    expect(alerts).toContain('<input type="text"');
    expect(alerts).toContain('data-champ="cardiovascular.pacemaker"');
    // Un seul geste, et il se termine dans la carte : on saisit, on
    // enregistre. Rien n'envoie chercher ailleurs.
    expect(alerts).toContain('>Enregistrer<');
  });

  test("l'écran appelle bien la route de correction du moteur", () => {
    // La route existait côté serveur et n'était appelée par personne : le
    // médecin ne pouvait corriger aucune donnée depuis le produit.
    expect(SOURCE).toContain("'/review/'");
    expect(SOURCE).toContain("action: 'correct'");
  });
});

describe('les traitements et les allergies se corrigent aussi', () => {
  test('UN TRAITEMENT PORTE SA CORRECTION, avec son identifiant', () => {
    // Le moteur sait appliquer `medications.<id>.name` depuis toujours. Aucun
    // écran ne l'appelait — et un traitement non confirmé BLOQUE la
    // validation : le médecin se serait retrouvé devant une liste qu'on lui
    // demande de traiter, sans aucun moyen de le faire.
    const { intake } = peindre(chargeReelle());
    expect(intake).toContain('data-champ="medications.med_1.name"');
  });

  test("UNE ALLERGIE AUSSI, dès qu'il y en a une", () => {
    const charge = chargeReelle();
    charge.clinical_data.allergies = [
      {
        id: 'alg_1',
        substance: { value: 'pénicilline', patient_statement: 'Je suis allergique à la pénicilline.' },
        normalized_substance: 'Pénicilline',
        requires_physician_audit: false,
      },
    ];
    const { intake } = peindre(charge);
    expect(intake).toContain('data-champ="allergies.alg_1.substance"');
    expect(intake).toContain('Pénicilline');
  });

  test("une liste VIDE n'offre rien à corriger", () => {
    // « Aucune allergie signalée » n'est pas une donnée qu'on corrige : c'est
    // l'absence de données. Un bouton ici n'aurait aucun champ où écrire.
    const { intake } = peindre(chargeReelle());
    const bloc = intake.slice(intake.indexOf('Aucune allergie signalée') - 200, intake.indexOf('Aucune allergie signalée') + 100);
    expect(bloc).not.toContain('data-champ="allergies.');
  });
});
