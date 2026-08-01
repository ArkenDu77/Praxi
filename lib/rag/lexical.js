// ─── RAG : recherche lexicale (BM25) ──────────────────────────────────────────
// Complément indispensable au vectoriel sur du vocabulaire médical : les noms de
// molécules, les scores (PASI, SCORAD, DLQI) et les acronymes sont mal capturés
// par les embeddings, très bien par une correspondance de termes.
//
// Sert aussi de mode dégradé complet quand aucun fournisseur d'embeddings n'est
// configuré.

const K1 = 1.5;   // saturation de la fréquence de terme
const B  = 0.75;  // normalisation par la longueur du document

// Mots vides français + anglais (les abstracts PubMed sont en anglais).
const STOPWORDS = new Set(`
au aux avec ce ces dans de des du elle en et eux il je la le les leur lui ma mais me
meme mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta
te tes toi ton tu un une vos votre vous c d j l a m n s t y ete etee etees etes etant
suis es est sommes etes sont serai seras sera serons serez seront avoir avons avez ont
plus tres bien tout tous toute toutes autre autres apres avant entre chez sans sous
the a an and or of to in for with on at by from as is are was were be been being that
this these those it its not no than then so such can may might should would could also
we our their his her they them he she which what when where who whom how why into
`.trim().split(/\s+/));

/**
 * Découpe un texte en termes indexables.
 * Les accents sont retirés : « érythème » et « erytheme » doivent matcher.
 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 40 && !STOPWORDS.has(t));
}

/**
 * Construit un index BM25 en mémoire.
 * @param {{text:string}[]} records
 */
function buildIndex(records) {
  const postings = new Map();   // terme → Map(docIndex → fréquence)
  const lengths  = new Array(records.length).fill(0);
  let totalLength = 0;

  records.forEach((record, docIndex) => {
    const terms = tokenize(record.text);
    lengths[docIndex] = terms.length;
    totalLength += terms.length;
    const seen = new Map();
    for (const term of terms) seen.set(term, (seen.get(term) || 0) + 1);
    for (const [term, freq] of seen) {
      let list = postings.get(term);
      if (!list) { list = new Map(); postings.set(term, list); }
      list.set(docIndex, freq);
    }
  });

  return {
    postings,
    lengths,
    docCount: records.length,
    avgLength: records.length ? totalLength / records.length : 0,
  };
}

/**
 * Recherche BM25.
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {number} topK
 * @returns {{docIndex:number, score:number}[]} trié par score décroissant
 */
function search(index, query, topK = 20) {
  if (!index || !index.docCount) return [];
  const terms = tokenize(query);
  if (!terms.length) return [];

  const scores = new Map();
  for (const term of terms) {
    const list = index.postings.get(term);
    if (!list) continue;
    // IDF de Robertson, borné à 0 : un terme présent partout ne discrimine rien.
    const idf = Math.max(
      0,
      Math.log(1 + (index.docCount - list.size + 0.5) / (list.size + 0.5))
    );
    if (!idf) continue;
    for (const [docIndex, freq] of list) {
      const norm = 1 - B + B * (index.lengths[docIndex] / (index.avgLength || 1));
      const contribution = idf * ((freq * (K1 + 1)) / (freq + K1 * norm));
      scores.set(docIndex, (scores.get(docIndex) || 0) + contribution);
    }
  }

  return [...scores.entries()]
    .map(([docIndex, score]) => ({ docIndex, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { tokenize, buildIndex, search, STOPWORDS };
