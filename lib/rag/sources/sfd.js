// ─── Source : Société Française de Dermatologie ───────────────────────────────
// robots.txt du domaine : « Allow: / ». On reste malgré tout sur un crawl étroit
// — une page d'amorce (le sommaire des recommandations) puis les fiches qu'elle
// référence, sur les sous-domaines qui publient en HTML :
//
//   reco.sfdermato.org           algorithmes de prise en charge
//   centredepreuves.sfdermato.org  recommandations du Centre de Preuves
//   chronoreco.sfdermato.org     recommandations chronologiques
//
// Les PNDS et argumentaires publiés en PDF (sfdermato.org/upload/…) ne sont pas
// ingérés : pas de parseur PDF côté serveur.

const { crawlPages } = require('./_crawl');

// Trois points d'entrée : le sommaire de la SFD et les deux plateformes qui
// publient les recommandations en HTML.
const HUBS = [
  'https://www.sfdermato.org/page-24-recommandations',
  'https://reco.sfdermato.org/fr/',
  'https://centredepreuves.sfdermato.org/',
];

// Fiches HTML uniquement — le motif exclut de fait les .pdf.
const RECO_LINK = /^https:\/\/(reco|centredepreuves|chronoreco)\.sfdermato\.org\/[^?]*(recommandation|reco)/i;

/**
 * @param {{seeds?:string[], limit?:number, maxPages?:number, onProgress?:Function}} options
 */
async function fetchDocuments({ seeds, limit = 120, maxPages = 60, onProgress } = {}) {
  const documents = await crawlPages({
    seeds: seeds && seeds.length ? seeds : HUBS,
    sourceId: 'sfd',
    sourceLabel: 'Société Française de Dermatologie',
    expand: { pattern: RECO_LINK, max: maxPages },
    minChars: 400,
    onProgress,
  });
  return documents.slice(0, limit);
}

module.exports = { id: 'sfd', label: 'Société Française de Dermatologie', fetchDocuments, HUBS, RECO_LINK };
