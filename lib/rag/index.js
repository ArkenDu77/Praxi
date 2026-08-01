// ─── RAG : API publique ───────────────────────────────────────────────────────
// Brique générique, sans aucune connaissance métier. Une « collection » est un
// espace de noms indépendant : `dermatologie` aujourd'hui, `cardiologie` ou
// `lettres-liaison` demain, sans toucher à ce fichier.
//
//   await ragIngest({ collection, documents })
//   await ragSearch({ collection, query, topK })
//
// La recherche est hybride : vectoriel (sens) + BM25 (termes exacts), fusionnés
// par Reciprocal Rank Fusion. Sur du vocabulaire médical, le lexical rattrape ce
// que les embeddings ratent — noms de molécules, scores PASI/SCORAD, acronymes.

const store = require('./store');
const embeddings = require('./embeddings');
const { chunkDocument } = require('./chunk');

const RRF_K = 60;           // constante d'amortissement standard de la RRF
const DEFAULT_TOP_K = 8;
// Un seul passage par document source. Mesuré en production sur cinq cas, à
// poids constants, passages pertinents sur 8 (documents distincts entre
// parenthèses) :
//
//                maxPerDoc=1   maxPerDoc=2   maxPerDoc=3
//   psoriasis        3/8 (8)       1/8 (6)       1/8 (5)
//   acné             6/8 (8)       6/8 (8)       6/8 (8)
//   atopie           7/8 (8)       7/8 (8)       7/8 (8)
//   mélanome         7/8 (8)       7/8 (8)       7/8 (8)
//   urticaire        7/8 (8)       7/8 (8)       7/8 (8)
//
// Aucune régression, un gain net sur le seul cas qui souffrait. La colonne des
// documents distincts explique pourquoi : les quatre pathologies indifférentes
// n'avaient déjà aucun doublon à plafonner. Le psoriasis, lui, cédait quatre de
// ses huit places à deux documents sur la dermatite atopique, dont la sémiologie
// recouvre largement la sienne — plaques, poussées, prurit, dermocorticoïdes.
//
// Contrepartie assumée : un document long et très pertinent ne contribue plus
// qu'un passage. Sur un avis destiné à un confrère, la diversité des sources
// citées vaut mieux qu'un même document décliné en plusieurs extraits.
const DEFAULT_MAX_PER_DOC = 1;

// Le vectoriel pèse plus lourd que le lexical. Motif : un médecin qui demande un
// avis décrit une sémiologie sans nommer le diagnostic — « plaques
// érythémato-squameuses des faces d'extension » et non « psoriasis ». Le lexical
// ne peut alors s'accrocher qu'à du vocabulaire clinique générique (« poussées »,
// « dermocorticoïdes », « prurit »), commun à des pathologies sans rapport, et
// fait remonter n'importe quelle dermatose qui partage ces mots. Faire le pont
// entre la description et le diagnostic relève du vectoriel.
//
// Poids calibrés en production sur quatre cas (psoriasis, acné, dermatite
// atopique, et un cas nommant molécules et scores). Résultats, passages
// pertinents sur 8 :
//
//        poids     1/1   2/1   3/1   4/1   6/1   8/1   vectoriel seul
//   psoriasis        0     0     1     1     1     1        2
//   acné             5     6     6     6     6     6        6
//   atopie           5     5     6     6     6     6        7
//   molécules        8     8     8     8     8     8        8
//
// Le lexical ne fait jamais mieux et fait moins bien sur trois cas — y compris
// sur celui censé lui être favorable (méthotrexate, PASI, DLQI, ustékinumab),
// que le vectoriel capte parfaitement. Il n'est pas supprimé pour autant : quatre
// cas construits pour l'occasion ne suffisent pas à retirer un canal de recherche
// entier. À 8/1 il devient marginal sans disparaître, et reste disponible si un
// usage réel le justifie.
const DEFAULT_WEIGHTS = { vector: 8, lexical: 1 };

/**
 * Indexe des documents dans une collection.
 *
 * @param {{
 *   collection: string,
 *   documents: {id:string, title?:string, url?:string, text:string, meta?:object}[],
 *   source?: string,
 *   chunkOptions?: object,
 *   onProgress?: (info:{phase:string, done:number, total:number}) => void
 * }} params
 */
async function ragIngest({ collection, documents, source, chunkOptions, onProgress }) {
  const records = [];
  for (const doc of documents) {
    if (!doc || !doc.text || !doc.id) continue;
    records.push(...chunkDocument(doc, chunkOptions));
  }
  if (!records.length) return { collection, added: 0, chunks: 0, vectorised: false };

  const embedded = await embeddings.embedBatch(
    records.map(r => r.text),
    {
      inputType: 'document',
      onProgress: (done, total) => onProgress && onProgress({ phase: 'embed', done, total }),
    }
  );

  if (embedded) {
    records.forEach((record, i) => { record.vector = embedded.vectors[i]; });
  }

  const meta = store.upsert(collection, records, {
    dim: embedded ? embedded.dim : 0,
    model: embedded ? embedded.model : null,
    source,
  });

  return {
    collection,
    added: documents.length,
    chunks: records.length,
    vectorised: Boolean(embedded),
    total: meta.count,
  };
}

// Fusion RRF : chaque liste vote via l'inverse de son rang. Insensible aux
// échelles de score, qui ne sont pas comparables entre cosinus et BM25.
function reciprocalRankFusion(rankedLists, weights) {
  const scores = new Map();
  rankedLists.forEach((list, listIndex) => {
    const weight = weights[listIndex] == null ? 1 : weights[listIndex];
    list.forEach((hit, rank) => {
      const previous = scores.get(hit.docIndex) || { docIndex: hit.docIndex, score: 0, parts: {} };
      previous.score += weight * (1 / (RRF_K + rank + 1));
      previous.parts[listIndex === 0 ? 'vector' : 'lexical'] = { rank: rank + 1, raw: hit.score };
      scores.set(hit.docIndex, previous);
    });
  });
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

/**
 * Recherche les passages les plus pertinents d'une collection.
 *
 * @param {{
 *   collection: string,
 *   query: string,
 *   topK?: number,
 *   maxPerDoc?: number,
 *   weights?: {vector?:number, lexical?:number}
 * }} params
 * @returns {Promise<{
 *   passages: {id:string, text:string, meta:object, score:number, parts:object}[],
 *   mode: 'hybride'|'lexical'|'vide',
 *   stats: object|null
 * }>}
 */
async function ragSearch({ collection, query, topK = DEFAULT_TOP_K, maxPerDoc = DEFAULT_MAX_PER_DOC, weights = {} }) {
  const stats = store.stats(collection);
  if (!stats || !query || !query.trim()) {
    return { passages: [], mode: 'vide', stats };
  }

  // On ratisse plus large que topK avant fusion et déduplication.
  const pool = Math.max(topK * 5, 30);

  let queryVector = null;
  if (stats.hasVectors && embeddings.isAvailable()) {
    try {
      queryVector = await embeddings.embedQuery(query);
    } catch (err) {
      // Une panne du fournisseur d'embeddings ne doit pas casser l'avis :
      // on continue en lexical seul.
      console.warn('[rag] embedding de requête indisponible —', err.message);
    }
  }

  const vectorHits  = queryVector ? store.searchVector(collection, queryVector, pool) : [];
  const lexicalHits = store.searchLexical(collection, query, pool);

  if (!vectorHits.length && !lexicalHits.length) {
    return { passages: [], mode: queryVector ? 'hybride' : 'lexical', stats };
  }

  const fused = reciprocalRankFusion(
    [vectorHits, lexicalHits],
    [
      weights.vector  == null ? DEFAULT_WEIGHTS.vector  : weights.vector,
      weights.lexical == null ? DEFAULT_WEIGHTS.lexical : weights.lexical,
    ]
  );

  // Sélection finale avec plafond par document source.
  const perDoc = new Map();
  const passages = [];
  for (const hit of fused) {
    if (passages.length >= topK) break;
    const [record] = store.getRecords(collection, [hit.docIndex]);
    if (!record) continue;
    const docId = (record.meta && record.meta.docId) || record.id;
    const used = perDoc.get(docId) || 0;
    if (used >= maxPerDoc) continue;
    perDoc.set(docId, used + 1);
    passages.push({
      id: record.id,
      text: record.text,
      meta: record.meta || {},
      score: hit.score,
      parts: hit.parts,
    });
  }

  return { passages, mode: queryVector ? 'hybride' : 'lexical', stats };
}

/** Métadonnées d'une collection. */
function ragStats(collection) {
  return store.stats(collection);
}

/** Collections indexées. */
function ragCollections() {
  return store.listCollections();
}

module.exports = {
  ragIngest, ragSearch, ragStats, ragCollections, store, embeddings,
  DEFAULT_WEIGHTS, DEFAULT_MAX_PER_DOC,
};
