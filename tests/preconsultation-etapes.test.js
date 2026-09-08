/**
 * ============================================================================
 *  LE MÉDECIN TRAVAILLE PAR ÉTAPES, ET SUR LE VRAI BLOC COMPTE RENDU
 * ============================================================================
 *
 * Deux défauts que ce banc empêche de revenir.
 *
 * 1. LA PAGE INTERMINABLE. Dossier, points à vérifier, validation, notes,
 *    documents, transfert : six cartes empilées, chacune avec son gros bouton.
 *    Le médecin ne savait ni où regarder, ni ce qui restait à faire. Le
 *    travail a un ordre — relire, valider, consulter, rédiger — et l'écran le
 *    suit désormais.
 *
 * 2. L'IMITATION DU COMPTE RENDU. Cet écran avait sa propre interface de
 *    génération : un bouton, pas d'aperçu, pas d'animation, pas les outils du
 *    document. Le médecin obtenait une expérience différente de celle qu'il
 *    connaît, pour le même geste. On ne recopie plus rien : les éléments des
 *    onglets Compte rendu et Lettre de liaison sont DÉPLACÉS le temps de la
 *    rédaction, puis remis chez eux. Mêmes nœuds, mêmes écouteurs, même
 *    animation, même archivage.
 *
 * Une copie finit toujours par diverger de l'original ; un déplacement, non.
 *
 * Run : npx jest tests/preconsultation-etapes.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

function extraire(signature) {
  const d = APP.indexOf(signature);
  if (d < 0) throw new Error(`introuvable : ${signature}`);
  const f = APP.indexOf('\n}\n', d);
  if (f < 0) throw new Error(`fin introuvable : ${signature}`);
  return APP.slice(d, f + 3);
}

describe("l'écran est découpé en étapes", () => {
  test('LES QUATRE ÉTAPES EXISTENT DANS LE DOCUMENT', () => {
    for (const etape of ['preconsultation', 'consultation', 'documents', 'transfert']) {
      expect(APP).toContain(`data-etape="${etape}"`);
    }
  });

  test("UNE SEULE ÉTAPE EST VISIBLE À LA FOIS", () => {
    // La fonction cache toutes les étapes sauf celle demandée : c'est ce qui
    // remplace la page unique où tout était empilé.
    const source = extraire('function pcAllerA(');
    expect(source).toContain(".pc-etape");
    expect(source).toContain('el.hidden = el.dataset.etape !== cle');
  });

  test('LE DOSSIER COMPLET EST REPLIÉ PAR DÉFAUT', () => {
    // Le médecin doit comprendre son patient en dix secondes. Le détail reste
    // accessible, il n'est simplement plus ce qu'on voit en premier.
    expect(APP).toContain('Voir toutes les informations');
    expect(APP).toContain('id="pc-intake-resume"');
  });
});

describe('le bloc Compte rendu est le vrai, pas une imitation', () => {
  test('LES ÉLÉMENTS SONT EMPRUNTÉS À L\'ONGLET EXISTANT', () => {
    const source = extraire('const PC_TYPES_DOCUMENT = [');
    // Ce sont les sélecteurs des VRAIS écrans, pas un gabarit recopié.
    expect(source).toContain("'#view-cr > .card'");
    expect(source).toContain("'#c-result'");
    expect(source).toContain("'#view-liaison > .card'");
    expect(source).toContain("'#l-result'");
  });

  test('CHAQUE TYPE N\'APPARAÎT QU\'UNE FOIS', () => {
    const source = extraire('const PC_TYPES_DOCUMENT = [');
    // `extraire` s'arrête à la première accolade en colonne zéro : on relit
    // donc la déclaration entière depuis le document.
    const debut = APP.indexOf('const PC_TYPES_DOCUMENT = [');
    const table = APP.slice(debut, APP.indexOf('const pcMorceauxEmpruntes', debut));
    const cles = [...table.matchAll(/cle: '([a-z]+)'/g)].map((m) => m[1]);
    expect(cles).toEqual([...new Set(cles)]);
    expect(cles).toEqual(['cr', 'liaison']);
  });

  test('LE BLOC EST REMIS EN PLACE QUAND ON LE DÉCOCHE', () => {
    // Un bloc laissé dans la pré-consultation serait invisible pour le médecin
    // qui retourne dans l'onglet Compte rendu — une panne silencieuse.
    const source = extraire('function pcRendreBloc(');
    expect(source).toContain('parent.insertBefore');
    expect(APP).toContain('pcRendreTousLesBlocs()');
  });

  test("QUITTER LE DOSSIER REND TOUT CE QUI A ÉTÉ EMPRUNTÉ", () => {
    const retour = APP.slice(APP.indexOf("document.getElementById('pc-back')"));
    expect(retour.slice(0, 400)).toContain('pcRendreTousLesBlocs()');
  });

  test("IL N'Y A PLUS DE GÉNÉRATEUR MAISON", () => {
    // Le bouton « Générer » propre à cet écran, et la liste des documents du
    // moteur, ont disparu : c'est le vrai bloc qui génère et le vrai stockage
    // qui conserve.
    expect(APP).not.toContain('pcGenererDocuments');
    expect(APP).not.toContain("api('/api/preconsult/document-kinds')");
  });
});

describe('les documents affichés sont ceux du patient', () => {
  test('ILS SONT RELUS DEPUIS LE SERVEUR, PAS DEPUIS L\'ÉTAT DE L\'ÉCRAN', () => {
    // La liste venait des documents du MOTEUR, et partageait son état avec les
    // cases à cocher : c'est ce mélange qui affichait « Compte rendu de
    // consultation » plusieurs fois de suite.
    const source = extraire('async function pcChargerDocumentsDuPatient(');
    expect(source).toContain("'/api/documents?patientId='");
  });

  test('LA SÉLECTION DES TYPES NE PARTAGE PLUS SON ÉTAT AVEC LES DOCUMENTS', () => {
    expect(APP).toContain('let pcTypesChoisis = []');
    const source = extraire('function pcRendreTypesDocument(');
    expect(source).toContain('pcTypesChoisis');
    expect(source).not.toContain('pcChosenDocs');
  });
});

describe('le microcopy parle au médecin', () => {
  test('« ÉLÉMENTS À VÉRIFIER », PAS « INFORMATIONS NON OBTENUES »', () => {
    const source = extraire('function pcRendreAVerifier(');
    expect(source).toContain('élément à vérifier');
    expect(source).not.toContain('information(s) non obtenue');
  });

  test("AUCUN NOM DE CLÉ INTERNE DANS LES LIBELLÉS AFFICHÉS", () => {
    const source = extraire('function pcPointsAVerifier(');
    // On affiche le libellé humain fourni par le moteur, jamais `field`.
    expect(source).toContain('u.field_label || u.label');
    // Le chemin technique ne doit jamais servir d'intitulé. On vérifie qu'il
    // n'est pas lu SEUL — `field_label` est justement le libellé humain.
    expect(/intitule:\s*u\.field(?!_label)/.test(source)).toBe(false);
    expect(/intitule:\s*m\.field(?!_label)/.test(source)).toBe(false);
  });
});
