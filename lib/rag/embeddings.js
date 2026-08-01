// ─── RAG : embeddings ─────────────────────────────────────────────────────────
// Fournisseur enfichable. Voyage AI par défaut (bon en français, tarif faible,
// pas de dépendance npm — appel HTTPS direct via fetch natif).
//
// Si VOYAGE_API_KEY n'est pas défini, le module renvoie `null` au lieu de lever :
// la recherche bascule alors en lexical pur (BM25). La fonctionnalité se dégrade,
// elle ne casse pas — et les tests tournent hors-ligne.

const VOYAGE_URL   = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = (process.env.VOYAGE_MODEL || 'voyage-3.5').trim();
const BATCH_SIZE   = 64;      // Voyage accepte 128 entrées ; on garde de la marge
const MAX_RETRIES  = 4;

function apiKey() {
  return (process.env.VOYAGE_API_KEY || '').trim();
}

/** Le moteur vectoriel est-il utilisable ? */
function isAvailable() {
  return Boolean(apiKey());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Un vecteur normalisé permet de calculer le cosinus par simple produit scalaire.
function l2normalize(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return vector.map(() => 0);
  return vector.map(v => v / norm);
}

async function callVoyage(inputs, inputType) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + apiKey(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: inputs, model: VOYAGE_MODEL, input_type: inputType }),
      });
    } catch (err) {
      lastError = err;
      await sleep(500 * Math.pow(2, attempt));
      continue;
    }

    if (res.ok) {
      const payload = await res.json();
      // Voyage ne garantit pas l'ordre : on réordonne sur `index`.
      const ordered = new Array(inputs.length);
      for (const item of payload.data) ordered[item.index] = l2normalize(item.embedding);
      return ordered;
    }

    // 429 et 5xx sont transitoires ; le reste (401, 400) ne le sera jamais.
    if (res.status !== 429 && res.status < 500) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Voyage ${res.status} — ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    lastError = new Error(`Voyage ${res.status}`);
    await sleep(1000 * Math.pow(2, attempt));
  }
  throw lastError || new Error('Voyage : échec après plusieurs tentatives.');
}

/**
 * Vectorise une liste de textes.
 * @param {string[]} texts
 * @param {{inputType?: 'document'|'query', onProgress?: (done:number, total:number)=>void}} [options]
 * @returns {Promise<{vectors:number[][], dim:number, model:string} | null>} null si aucun fournisseur configuré
 */
async function embedBatch(texts, options = {}) {
  if (!texts.length) return { vectors: [], dim: 0, model: VOYAGE_MODEL };
  if (!isAvailable()) return null;

  const inputType = options.inputType === 'query' ? 'query' : 'document';
  const vectors = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    vectors.push(...await callVoyage(slice, inputType));
    if (options.onProgress) options.onProgress(Math.min(i + BATCH_SIZE, texts.length), texts.length);
  }
  return { vectors, dim: vectors[0] ? vectors[0].length : 0, model: VOYAGE_MODEL };
}

/** Vectorise une requête unique. Renvoie null si le moteur vectoriel est absent. */
async function embedQuery(text) {
  const result = await embedBatch([text], { inputType: 'query' });
  return result ? result.vectors[0] : null;
}

module.exports = { embedBatch, embedQuery, isAvailable, l2normalize, VOYAGE_MODEL };
