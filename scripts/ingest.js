#!/usr/bin/env node
// ─── Ingestion de la base de connaissances ────────────────────────────────────
//
//   node scripts/ingest.js dermatologie
//   node scripts/ingest.js dermatologie --sources=sfd,has
//   node scripts/ingest.js dermatologie --limit=300 --reset
//   node scripts/ingest.js --list
//
// Le script est idempotent : relancé, il écrase les passages déjà connus (clé =
// identifiant du document) sans dupliquer le corpus. `--reset` repart de zéro.
//
// Sans VOYAGE_API_KEY, l'ingestion se fait quand même : l'index est alors
// purement lexical (BM25) et la recherche fonctionne en mode dégradé.

require('dotenv').config();

const { ragIngest, ragStats, store, embeddings } = require('../lib/rag');
const { getSpecialite, allSpecialites } = require('../lib/specialites');

const SOURCES = {
  pubmed: require('../lib/rag/sources/pubmed'),
  has:    require('../lib/rag/sources/has'),
  sfd:    require('../lib/rag/sources/sfd'),
  bdpm:   require('../lib/rag/sources/bdpm'),
};

function parseArgs(argv) {
  const options = { sources: null, limit: null, reset: false, dryRun: false, list: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === '--reset') options.reset = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--list') options.list = true;
    else if (arg.startsWith('--sources=')) options.sources = arg.slice(10).split(',').map(s => s.trim()).filter(Boolean);
    else if (arg.startsWith('--limit=')) options.limit = parseInt(arg.slice(8), 10) || null;
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  return { options, specialite: positional[0] };
}

function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function printStats() {
  console.log('\n  Collections indexées');
  const collections = store.listCollections();
  if (!collections.length) { console.log('    (aucune)'); return; }
  for (const collection of collections) {
    const s = ragStats(collection);
    console.log(
      `    ${collection.padEnd(18)} ${String(s.count).padStart(6)} passages` +
      `   ${s.hasVectors ? `vectoriel ${s.model} (${s.dim}d)` : 'lexical seul'}` +
      `   maj ${String(s.updatedAt || '').slice(0, 10)}`
    );
  }
}

async function run() {
  const { options, specialite: key } = parseArgs(process.argv.slice(2));

  if (options.list || !key) {
    console.log('\n  Spécialités déclarées');
    for (const s of allSpecialites()) {
      console.log(`    ${s.key.padEnd(18)} ${s.actif ? 'active ' : 'inactive'}  sources : ${Object.keys(s.sources).join(', ')}`);
    }
    printStats();
    if (!key) console.log('\n  Usage : node scripts/ingest.js <spécialité> [--sources=a,b] [--limit=N] [--reset]\n');
    return;
  }

  const specialite = getSpecialite(key);
  if (!specialite) {
    console.error(`\n  ✗ Spécialité inconnue ou inactive : ${key}`);
    console.error(`    Déclarées : ${allSpecialites().map(s => s.key).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  const wanted = options.sources || Object.keys(specialite.sources);
  const unknown = wanted.filter(s => !SOURCES[s] || !specialite.sources[s]);
  if (unknown.length) {
    console.error(`\n  ✗ Source(s) non disponible(s) pour ${specialite.label} : ${unknown.join(', ')}`);
    console.error(`    Disponibles : ${Object.keys(specialite.sources).join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Ingestion — ${specialite.label} (collection « ${specialite.collection} »)`);
  console.log(`  Sources : ${wanted.join(', ')}`);
  console.log(`  Embeddings : ${embeddings.isAvailable()
    ? `Voyage ${embeddings.VOYAGE_MODEL}`
    : '⚠ VOYAGE_API_KEY absente — index lexical seul (recherche dégradée)'}`);

  if (options.reset) {
    store.drop(specialite.collection);
    console.log('  Index précédent supprimé (--reset)');
  }
  console.log('');

  const started = Date.now();
  const résumé = [];

  for (const sourceId of wanted) {
    const source = SOURCES[sourceId];
    const config = Object.assign({}, specialite.sources[sourceId]);
    if (options.limit) config.limit = options.limit;

    process.stdout.write(`  ▸ ${source.label} … `);
    const t0 = Date.now();

    let documents;
    try {
      documents = await source.fetchDocuments(Object.assign({}, config, {
        onProgress: info => {
          if (info.phase === 'page' && info.done % 10 === 0) process.stdout.write('.');
          if (info.phase === 'download' || info.phase === 'search') process.stdout.write('·');
        },
      }));
    } catch (err) {
      console.log(`\n    ✗ échec : ${err.message}`);
      résumé.push({ source: source.label, error: err.message });
      continue;
    }

    if (!documents.length) {
      console.log('aucun document');
      résumé.push({ source: source.label, documents: 0, chunks: 0 });
      continue;
    }

    if (options.dryRun) {
      console.log(`${documents.length} documents (dry-run, rien d'indexé)`);
      console.log(`      exemple : ${documents[0].title.slice(0, 90)}`);
      résumé.push({ source: source.label, documents: documents.length, chunks: 0 });
      continue;
    }

    let result;
    try {
      result = await ragIngest({
        collection: specialite.collection,
        documents,
        source: sourceId,
        onProgress: info => {
          if (info.phase === 'embed' && info.done % 640 === 0) process.stdout.write('+');
        },
      });
    } catch (err) {
      console.log(`\n    ✗ indexation échouée : ${err.message}`);
      résumé.push({ source: source.label, error: err.message });
      continue;
    }

    console.log(` ${result.added} documents → ${result.chunks} passages   (${humanDuration(Date.now() - t0)})`);
    résumé.push({ source: source.label, documents: result.added, chunks: result.chunks });
  }

  console.log(`\n  Terminé en ${humanDuration(Date.now() - started)}`);
  for (const line of résumé) {
    console.log(line.error
      ? `    ✗ ${line.source} — ${line.error}`
      : `    ✓ ${line.source.padEnd(38)} ${String(line.documents).padStart(5)} doc  ${String(line.chunks).padStart(6)} passages`);
  }
  printStats();
  console.log('');
}

run().catch(err => {
  console.error('\n  ✗ Erreur inattendue :', err && err.stack || err, '\n');
  process.exit(1);
});
