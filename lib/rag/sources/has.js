// ─── Source : Haute Autorité de Santé ─────────────────────────────────────────
// Recommandations de bonne pratique et avis de la Commission de la Transparence.
//
// Le moteur de recherche du site (/jcms/fc_2875171/) est explicitement interdit
// par robots.txt : on ne l'utilise pas. On part à la place d'une liste d'URL de
// publications déclarée par spécialité (lib/specialites.js), qui relève de pages
// autorisées. C'est aussi un choix de qualité : le corpus est curé, pas ratissé.
//
// Les avis HAS ne sont publiés qu'en PDF pour une partie du fonds ; ils ne sont
// pas ingérés ici (pas de parseur PDF côté serveur). Le texte des indications
// retenues par la Commission de la Transparence est en revanche récupéré par la
// source BDPM, qui le redistribue en clair.

const { crawlPages } = require('./_crawl');

const DENIED = /has-sante\.fr\/jcms\/fc_2875171\//i;

/**
 * @param {{seeds:string[], limit?:number, onProgress?:Function}} options
 */
async function fetchDocuments({ seeds = [], limit = 200, onProgress }) {
  if (!seeds.length) return [];
  const documents = await crawlPages({
    seeds,
    sourceId: 'has',
    sourceLabel: 'Haute Autorité de Santé',
    denied: DENIED,
    minChars: 500,
    onProgress,
  });
  return documents.slice(0, limit);
}

module.exports = { id: 'has', label: 'Haute Autorité de Santé', fetchDocuments, DENIED };
