// ─── RAG : stockage vectoriel ─────────────────────────────────────────────────
// Implémentation fichier, posée sur le volume persistant déjà utilisé par Arkiba
// (DATA_DIR). Aucun service externe, aucune dépendance : trois fichiers par
// collection, chargés en mémoire au premier accès.
//
//   <collection>.chunks.jsonl   un passage par ligne : { id, text, meta }
//   <collection>.vectors.f32    Float32 contigus, `count * dim` valeurs
//   <collection>.meta.json      { dim, model, count, updatedAt, sources }
//
// Ordre de grandeur : 8 000 passages × 1024 dimensions = 33 Mo en RAM et une
// recherche exhaustive en ~15 ms. Au-delà de ~100 000 passages, basculer sur le
// driver pgvector (voir createPgVectorStore en fin de fichier).
//
// Les vecteurs sont normalisés L2 à l'écriture : le cosinus se réduit alors à un
// produit scalaire.

const fs   = require('fs');
const path = require('path');
const lexical = require('./lexical');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..');
const RAG_DIR  = process.env.RAG_DIR || path.join(DATA_DIR, 'rag');

// Un nom de collection devient un nom de fichier : on refuse tout ce qui pourrait
// s'échapper du dossier.
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function assertCollection(name) {
  if (!COLLECTION_RE.test(String(name || ''))) {
    throw new Error(`Nom de collection invalide : ${name}`);
  }
  return name;
}

function paths(collection) {
  const base = path.join(RAG_DIR, assertCollection(collection));
  return { chunks: base + '.chunks.jsonl', vectors: base + '.vectors.f32', meta: base + '.meta.json' };
}

function ensureDir() {
  fs.mkdirSync(RAG_DIR, { recursive: true });
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Cache mémoire par collection, invalidé si le fichier a changé sur disque
// (ré-ingestion pendant que le serveur tourne).
const cache = new Map();

function signature(p) {
  try {
    const s = fs.statSync(p.chunks);
    return `${s.mtimeMs}:${s.size}`;
  } catch (_) {
    return null;
  }
}

/**
 * Charge une collection en mémoire (ou renvoie le cache à jour).
 * @returns {{records:object[], vectors:Float32Array|null, dim:number, meta:object, lexIndex:object}|null}
 */
function load(collection) {
  const p = signature(paths(collection));
  const cached = cache.get(collection);
  if (cached && cached.signature === p) return cached.data;
  if (p === null) { cache.delete(collection); return null; }

  const files = paths(collection);
  const records = fs.readFileSync(files.chunks, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

  let meta = { dim: 0, model: null, count: records.length };
  try { meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')); } catch (_) {}

  let vectors = null;
  if (meta.dim > 0 && fs.existsSync(files.vectors)) {
    const buffer = fs.readFileSync(files.vectors);
    // Copie dans un Float32Array aligné : le Buffer de Node ne l'est pas toujours.
    vectors = new Float32Array(buffer.byteLength / 4);
    for (let i = 0; i < vectors.length; i++) vectors[i] = buffer.readFloatLE(i * 4);
    if (vectors.length !== records.length * meta.dim) {
      console.warn(`[rag] ${collection} : vecteurs incohérents (${vectors.length} ≠ ${records.length}×${meta.dim}) — recherche lexicale seule`);
      vectors = null;
    }
  }

  const data = { records, vectors, dim: vectors ? meta.dim : 0, meta, lexIndex: lexical.buildIndex(records) };
  cache.set(collection, { signature: p, data });
  return data;
}

/**
 * Insère ou met à jour des passages. Les identifiants existants sont écrasés :
 * relancer une ingestion ne duplique pas le corpus.
 *
 * @param {string} collection
 * @param {{id:string, text:string, meta?:object, vector?:number[]}[]} incoming
 * @param {{dim?:number, model?:string, source?:string}} [options]
 */
function upsert(collection, incoming, options = {}) {
  assertCollection(collection);
  ensureDir();

  const existing = load(collection);
  const dim = options.dim || (existing && existing.meta.dim) || 0;

  // Fusion par id, en conservant l'ordre : anciens d'abord, puis les nouveaux.
  const byId = new Map();
  if (existing) {
    existing.records.forEach((record, i) => {
      const vector = existing.vectors && existing.dim
        ? Array.from(existing.vectors.subarray(i * existing.dim, (i + 1) * existing.dim))
        : null;
      byId.set(record.id, { id: record.id, text: record.text, meta: record.meta, vector });
    });
  }
  for (const record of incoming) {
    byId.set(record.id, {
      id: record.id,
      text: record.text,
      meta: record.meta || {},
      vector: record.vector || null,
    });
  }

  const merged = [...byId.values()];
  const files  = paths(collection);

  writeAtomic(
    files.chunks,
    merged.map(r => JSON.stringify({ id: r.id, text: r.text, meta: r.meta })).join('\n') + '\n'
  );

  let vectorCount = 0;
  if (dim > 0) {
    const buffer = Buffer.alloc(merged.length * dim * 4);
    merged.forEach((record, i) => {
      // Un passage sans vecteur reste indexé pour le lexical ; son vecteur nul
      // donne un cosinus de 0, il ne remonte donc jamais côté vectoriel.
      if (!record.vector || record.vector.length !== dim) return;
      vectorCount++;
      for (let d = 0; d < dim; d++) buffer.writeFloatLE(record.vector[d], (i * dim + d) * 4);
    });
    writeAtomic(files.vectors, buffer);
  } else if (fs.existsSync(files.vectors)) {
    fs.unlinkSync(files.vectors);
  }

  const meta = {
    collection,
    dim,
    model: options.model || (existing && existing.meta.model) || null,
    count: merged.length,
    vectorCount,
    updatedAt: new Date().toISOString(),
    sources: Object.assign({}, existing && existing.meta.sources, options.source ? { [options.source]: incoming.length } : {}),
  };
  writeAtomic(files.meta, JSON.stringify(meta, null, 2));
  cache.delete(collection);
  return meta;
}

/**
 * Recherche vectorielle exhaustive (cosinus sur vecteurs normalisés).
 * @returns {{docIndex:number, score:number}[]}
 */
function searchVector(collection, queryVector, topK = 20) {
  const data = load(collection);
  if (!data || !data.vectors || !data.dim || !queryVector) return [];
  if (queryVector.length !== data.dim) {
    console.warn(`[rag] ${collection} : dimension de requête ${queryVector.length} ≠ index ${data.dim}`);
    return [];
  }

  const { vectors, dim, records } = data;
  const scored = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    let dot = 0;
    const offset = i * dim;
    for (let d = 0; d < dim; d++) dot += vectors[offset + d] * queryVector[d];
    scored[i] = { docIndex: i, score: dot };
  }
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** Recherche lexicale BM25. */
function searchLexical(collection, query, topK = 20) {
  const data = load(collection);
  if (!data) return [];
  return lexical.search(data.lexIndex, query, topK);
}

/** Récupère les passages par indices. */
function getRecords(collection, indices) {
  const data = load(collection);
  if (!data) return [];
  return indices.map(i => data.records[i]).filter(Boolean);
}

/** Métadonnées d'une collection, ou null si elle n'existe pas. */
function stats(collection) {
  const data = load(collection);
  if (!data) return null;
  return Object.assign({}, data.meta, {
    count: data.records.length,
    hasVectors: Boolean(data.vectors),
  });
}

/** Collections présentes sur le disque. */
function listCollections() {
  try {
    return fs.readdirSync(RAG_DIR)
      .filter(f => f.endsWith('.chunks.jsonl'))
      .map(f => f.replace('.chunks.jsonl', ''));
  } catch (_) {
    return [];
  }
}

/** Supprime une collection (utilisé par les tests et par `ingest --reset`). */
function drop(collection) {
  const files = paths(collection);
  for (const file of Object.values(files)) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  cache.delete(collection);
}

// ─── Driver Postgres/pgvector (non implémenté) ────────────────────────────────
// Le jour où un Postgres existe dans le projet, ou si le corpus dépasse ~100 000
// passages, implémenter ici la même signature (upsert / searchVector /
// searchLexical / stats) et l'injecter dans lib/rag/index.js. Rien d'autre ne
// bouge : les appelants ne connaissent que cette interface.
function createPgVectorStore() {
  throw new Error('Driver pgvector non implémenté — voir lib/rag/store.js');
}

module.exports = {
  RAG_DIR,
  load,
  upsert,
  searchVector,
  searchLexical,
  getRecords,
  stats,
  listCollections,
  drop,
  createPgVectorStore,
};
