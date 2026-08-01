// ─── Source : BDPM (Base de Données Publique des Médicaments — ANSM/HAS) ──────
// Données publiques officielles françaises, téléchargeables en TSV. Couvre les
// molécules, les formes, le statut de commercialisation et — via le fichier SMR
// — le texte des indications retenues par la Commission de la Transparence.
//
// Choix assumé : Vidal n'est pas utilisé. Ses conditions d'utilisation
// interdisent l'extraction automatisée et il n'existe pas d'API publique ;
// la BDPM en est l'équivalent officiel et librement exploitable.
//
// Fichiers (encodage windows-1252, séparateur tabulation) :
//   CIS_bdpm.txt          spécialités : dénomination, forme, voies, statut
//   CIS_COMPO_bdpm.txt    composition : substances actives et dosages
//   CIS_HAS_SMR_bdpm.txt  avis HAS : niveau de SMR et texte de l'indication

const { fetchText, decodeEntities } = require('./_http');

const BASE = 'https://base-donnees-publique.medicaments.gouv.fr/download/file';
const ENCODING = 'windows-1252';

function rows(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
}

async function loadFile(name) {
  return rows(await fetchText(`${BASE}/${name}`, { encoding: ENCODING, accept: 'text/plain' }));
}

// Normalisation pour comparaison : minuscules, sans accents.
function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Télécharge et assemble le référentiel.
 * @returns {Promise<Map<string, object>>} CIS → fiche consolidée
 */
async function loadReferentiel() {
  const [specialites, compositions, avis] = await Promise.all([
    loadFile('CIS_bdpm.txt'),
    loadFile('CIS_COMPO_bdpm.txt'),
    loadFile('CIS_HAS_SMR_bdpm.txt'),
  ]);

  const byCis = new Map();
  for (const row of specialites) {
    const [cis, denomination, forme, voies, statutAmm, , commercialisation, dateAmm, , , titulaire] = row;
    if (!cis || !denomination) continue;
    byCis.set(cis, {
      cis,
      denomination: denomination.trim(),
      forme: (forme || '').trim(),
      voies: (voies || '').trim(),
      statutAmm: (statutAmm || '').trim(),
      commercialisation: (commercialisation || '').trim(),
      dateAmm: (dateAmm || '').trim(),
      titulaire: (titulaire || '').trim(),
      substances: [],
      indications: [],
    });
  }

  for (const row of compositions) {
    const [cis, , , substance, dosage, , nature] = row;
    const fiche = byCis.get(cis);
    // SA = substance active ; ST = substance thérapeutique de référence (doublon).
    if (!fiche || !substance || (nature || '').trim() !== 'SA') continue;
    const label = dosage ? `${substance.trim()} ${dosage.trim()}` : substance.trim();
    if (!fiche.substances.includes(label)) fiche.substances.push(label);
  }

  for (const row of avis) {
    const [cis, , , dateAvis, niveauSmr, libelle] = row;
    const fiche = byCis.get(cis);
    if (!fiche || !libelle) continue;
    const texte = decodeEntities(libelle.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!texte) continue;
    fiche.indications.push({ date: (dateAvis || '').trim(), smr: (niveauSmr || '').trim(), texte });
  }

  return byCis;
}

/**
 * Une fiche correspond-elle au périmètre de la spécialité ?
 * Trois critères, cumulatifs par « ou » : substance attendue, voie
 * d'administration, ou mot-clé dans l'indication HAS.
 */
function matches(fiche, filter) {
  const substances = fold(fiche.substances.join(' '));
  if (filter.substances && filter.substances.some(s => substances.includes(fold(s)))) return true;

  const voies = fold(fiche.voies);
  if (filter.routes && filter.routes.some(r => voies.includes(fold(r)))) return true;

  if (filter.keywords) {
    const haystack = fold(fiche.indications.map(i => i.texte).join(' ') + ' ' + fiche.denomination);
    if (filter.keywords.some(k => haystack.includes(fold(k)))) return true;
  }
  return false;
}

function toDocument(fiche) {
  const lignes = [
    `Spécialité : ${fiche.denomination}`,
    fiche.substances.length ? `Substance(s) active(s) : ${fiche.substances.join(' ; ')}` : '',
    fiche.forme ? `Forme pharmaceutique : ${fiche.forme}` : '',
    fiche.voies ? `Voie(s) d'administration : ${fiche.voies}` : '',
    fiche.commercialisation ? `État de commercialisation : ${fiche.commercialisation}` : '',
    fiche.titulaire ? `Titulaire de l'AMM : ${fiche.titulaire}` : '',
  ].filter(Boolean);

  // On garde les trois avis les plus récents : au-delà, c'est de l'historique.
  const indications = fiche.indications
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 3)
    .map(i => `Avis HAS${i.date ? ` du ${i.date}` : ''} — service médical rendu : ${i.smr || 'non précisé'}\n${i.texte}`);

  if (indications.length) lignes.push('', 'Indications retenues par la Haute Autorité de Santé :', ...indications);

  return {
    id: `bdpm:${fiche.cis}`,
    title: fiche.denomination,
    url: `https://base-donnees-publique.medicaments.gouv.fr/extrait.php?specid=${fiche.cis}`,
    text: lignes.join('\n'),
    meta: {
      source: 'bdpm',
      sourceLabel: 'Base de données publique des médicaments (ANSM)',
      cis: fiche.cis,
      substances: fiche.substances.slice(0, 8),
      commercialisation: fiche.commercialisation,
      lang: 'fr',
    },
  };
}

/**
 * @param {{filter:{substances?:string[], routes?:string[], keywords?:string[]},
 *          limit?:number, commercialisedOnly?:boolean, onProgress?:Function}} options
 */
async function fetchDocuments({ filter = {}, limit = 1500, commercialisedOnly = true, onProgress }) {
  if (onProgress) onProgress({ phase: 'download', label: 'référentiel BDPM' });
  const referentiel = await loadReferentiel();

  const documents = [];
  for (const fiche of referentiel.values()) {
    if (documents.length >= limit) break;
    if (commercialisedOnly && !/^Commercialis/i.test(fiche.commercialisation)) continue;
    if (!/active/i.test(fiche.statutAmm)) continue;
    if (!fiche.substances.length) continue;
    if (!matches(fiche, filter)) continue;
    documents.push(toDocument(fiche));
  }

  if (onProgress) onProgress({ phase: 'done', label: `${documents.length} spécialités retenues` });
  return documents;
}

module.exports = { id: 'bdpm', label: 'BDPM (ANSM)', fetchDocuments, loadReferentiel };
