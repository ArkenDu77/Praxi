#!/usr/bin/env node
// ─── Ingestion de la base de connaissances (CLI) ──────────────────────────────
//
//   node scripts/ingest.js dermatologie
//   node scripts/ingest.js dermatologie --sources=sfd,has
//   node scripts/ingest.js dermatologie --limit=300 --reset
//   node scripts/ingest.js --list
//
// L'orchestration vit dans lib/ingest.js, partagée avec la route
// POST /admin/ingest : ce fichier n'est que l'habillage terminal.
//
// L'ingestion est idempotente : relancée, elle écrase les passages déjà connus
// (clé = identifiant du document) sans dupliquer le corpus. `--reset` repart de
// zéro. Un verrou empêche deux ingestions simultanées sur la même collection.
//
// Sans VOYAGE_API_KEY, l'ingestion se fait quand même : l'index est alors
// purement lexical (BM25) et la recherche fonctionne en mode dégradé.

require('dotenv').config();

const { runIngestion } = require('../lib/ingest');
const { ragStats, store, embeddings } = require('../lib/rag');
const { allSpecialites } = require('../lib/specialites');

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

  console.log(`\n  Ingestion — ${key}`);
  console.log(`  Embeddings : ${embeddings.isAvailable()
    ? `Voyage ${embeddings.VOYAGE_MODEL}`
    : '⚠ VOYAGE_API_KEY absente — index lexical seul (recherche dégradée)'}`);
  console.log('');

  let rapport;
  try {
    rapport = await runIngestion({
      specialite: key,
      sources: options.sources,
      limit: options.limit,
      reset: options.reset,
      dryRun: options.dryRun,
      onEvent: event => {
        switch (event.type) {
          case 'reset':
            console.log('  Index précédent supprimé (--reset)');
            break;
          case 'source-start':
            process.stdout.write(`  ▸ ${event.label} … `);
            break;
          case 'progress':
            if (event.phase === 'page' && event.done % 10 === 0) process.stdout.write('.');
            else if (event.phase === 'embed' && event.done % 640 === 0) process.stdout.write('+');
            else if (event.phase === 'download' || event.phase === 'search') process.stdout.write('·');
            break;
          case 'source-done':
            console.log(event.dryRun
              ? `${event.documents} documents (dry-run, rien d'indexé)`
              : ` ${event.documents} documents → ${event.chunks} passages   (${humanDuration(event.ms)})`);
            break;
          case 'source-error':
            console.log(`\n    ✗ ${event.message}`);
            break;
        }
      },
    });
  } catch (err) {
    console.error(`\n  ✗ ${err.message}`);
    if (err.disponibles) console.error(`    Disponibles : ${err.disponibles.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Terminé en ${humanDuration(rapport.ms)}`);
  for (const ligne of rapport.resultats) {
    console.log(ligne.erreur
      ? `    ✗ ${ligne.label} — ${ligne.erreur}`
      : `    ✓ ${ligne.label.padEnd(38)} ${String(ligne.documents).padStart(5)} doc  ${String(ligne.chunks).padStart(6)} passages`);
  }
  printStats();
  console.log('');
  if (rapport.echecs.length) process.exitCode = 1;
}

run().catch(err => {
  console.error('\n  ✗ Erreur inattendue :', err && err.stack || err, '\n');
  process.exit(1);
});
