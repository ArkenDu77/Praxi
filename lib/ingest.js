// ─── Orchestration de l'ingestion ─────────────────────────────────────────────
// Cœur partagé par le CLI (scripts/ingest.js) et par la route d'administration
// POST /admin/ingest. Une seule implémentation : les deux points d'entrée voient
// exactement le même comportement, et il n'y a qu'un endroit à modifier pour
// ajouter une source.

const fs   = require('fs');
const path = require('path');

const { ragIngest, ragStats, store } = require('./rag');
const { getSpecialite, allSpecialites } = require('./specialites');

const SOURCES = {
  pubmed: require('./rag/sources/pubmed'),
  has:    require('./rag/sources/has'),
  sfd:    require('./rag/sources/sfd'),
  bdpm:   require('./rag/sources/bdpm'),
};

// ─── Verrou inter-processus ──────────────────────────────────────────────────
// Le store réécrit l'intégralité des fichiers d'une collection à chaque upsert
// (lecture, fusion, écriture). Deux ingestions simultanées sur la même
// collection perdraient donc les apports de l'une des deux. Le CLI et le serveur
// étant deux processus distincts, un verrou en mémoire ne suffit pas : il passe
// par un fichier dans RAG_DIR.

const LOCK_STALE_MS = 45 * 60 * 1000;   // une ingestion complète tourne ~10 min

function lockPath(collection) {
  return path.join(store.RAG_DIR, `${collection}.ingest.lock`);
}

function lireVerrou(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/**
 * Prend le verrou d'une collection.
 * @returns {{release:Function}}
 * @throws {Error} code VERROU_OCCUPE si une ingestion est déjà en cours
 */
function acquireLock(collection, meta = {}) {
  fs.mkdirSync(store.RAG_DIR, { recursive: true });
  const file = lockPath(collection);

  try {
    // `wx` échoue si le fichier existe : la création est atomique.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, depuis: new Date().toISOString(), ...meta }), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;

    // Un processus tué laisse un verrou orphelin : on le reprend passé le délai.
    const existant = lireVerrou(file);
    const age = existant && existant.depuis ? Date.now() - Date.parse(existant.depuis) : Infinity;
    if (!(age > LOCK_STALE_MS)) {
      const conflit = new Error(
        `Une ingestion est déjà en cours sur « ${collection} »`
        + (existant && existant.depuis ? ` depuis ${existant.depuis}` : '') + '.'
      );
      conflit.code = 'VERROU_OCCUPE';
      conflit.verrou = existant;
      throw conflit;
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, depuis: new Date().toISOString(), reprisApres: existant, ...meta }));
  }

  return {
    release() { try { fs.unlinkSync(file); } catch (_) {} },
  };
}

/** Sources déclarées pour une spécialité et réellement implémentées. */
function sourcesDisponibles(specialite) {
  return Object.keys(specialite.sources).filter(id => SOURCES[id]);
}

/**
 * Lance l'ingestion d'une spécialité.
 *
 * @param {{
 *   specialite: string,
 *   sources?: string[],
 *   limit?: number,
 *   reset?: boolean,
 *   dryRun?: boolean,
 *   onEvent?: (event:object) => void
 * }} options
 * @returns {Promise<object>} rapport d'exécution
 */
async function runIngestion({ specialite: key, sources, limit, reset, dryRun, onEvent = () => {} }) {
  const specialite = getSpecialite(key);
  if (!specialite) {
    const err = new Error(`Spécialité inconnue ou inactive : ${key}`);
    err.code = 'SPECIALITE_INCONNUE';
    err.disponibles = allSpecialites().filter(s => s.actif).map(s => s.key);
    throw err;
  }

  const voulues = sources && sources.length ? sources : sourcesDisponibles(specialite);
  const inconnues = voulues.filter(id => !SOURCES[id] || !specialite.sources[id]);
  if (inconnues.length) {
    const err = new Error(`Source(s) non disponible(s) pour ${specialite.label} : ${inconnues.join(', ')}`);
    err.code = 'SOURCE_INCONNUE';
    err.disponibles = sourcesDisponibles(specialite);
    throw err;
  }

  const verrou = acquireLock(specialite.collection, { specialite: specialite.key, sources: voulues });
  const demarre = Date.now();
  const resultats = [];

  try {
    if (reset && !dryRun) {
      store.drop(specialite.collection);
      onEvent({ type: 'reset', collection: specialite.collection });
    }

    for (const sourceId of voulues) {
      const source = SOURCES[sourceId];
      const config = Object.assign({}, specialite.sources[sourceId]);
      if (limit) config.limit = limit;

      const t0 = Date.now();
      onEvent({ type: 'source-start', source: sourceId, label: source.label });

      let documents;
      try {
        documents = await source.fetchDocuments(Object.assign({}, config, {
          onProgress: info => onEvent({ type: 'progress', source: sourceId, ...info }),
        }));
      } catch (err) {
        // L'échec d'une source ne doit pas annuler les autres : une
        // indisponibilité réseau chez PubMed ne doit pas priver la base des
        // recommandations SFD déjà récupérables.
        onEvent({ type: 'source-error', source: sourceId, message: err.message });
        resultats.push({ source: sourceId, label: source.label, erreur: err.message });
        continue;
      }

      if (dryRun) {
        onEvent({ type: 'source-done', source: sourceId, documents: documents.length, chunks: 0, dryRun: true });
        resultats.push({ source: sourceId, label: source.label, documents: documents.length, chunks: 0, dryRun: true });
        continue;
      }

      try {
        const bilan = await ragIngest({
          collection: specialite.collection,
          documents,
          source: sourceId,
          onProgress: info => onEvent({ type: 'progress', source: sourceId, ...info }),
        });
        onEvent({ type: 'source-done', source: sourceId, documents: bilan.added, chunks: bilan.chunks, ms: Date.now() - t0 });
        resultats.push({
          source: sourceId, label: source.label,
          documents: bilan.added, chunks: bilan.chunks,
          vectorise: bilan.vectorised, ms: Date.now() - t0,
        });
      } catch (err) {
        onEvent({ type: 'source-error', source: sourceId, message: err.message });
        resultats.push({ source: sourceId, label: source.label, erreur: err.message });
      }
    }
  } finally {
    verrou.release();
  }

  const stats = dryRun ? null : ragStats(specialite.collection);
  const rapport = {
    specialite: specialite.key,
    label: specialite.label,
    collection: specialite.collection,
    sources: voulues,
    dryRun: Boolean(dryRun),
    reset: Boolean(reset),
    ms: Date.now() - demarre,
    resultats,
    documents: resultats.reduce((n, r) => n + (r.documents || 0), 0),
    chunks: resultats.reduce((n, r) => n + (r.chunks || 0), 0),
    echecs: resultats.filter(r => r.erreur).map(r => r.source),
    index: stats && {
      passages: stats.count,
      vectoriel: stats.hasVectors,
      modele: stats.model,
      majLe: stats.updatedAt,
    },
  };
  onEvent({ type: 'done', rapport });
  return rapport;
}

module.exports = { runIngestion, acquireLock, sourcesDisponibles, SOURCES, LOCK_STALE_MS };
