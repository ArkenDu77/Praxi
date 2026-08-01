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

// Une limite de débit se compte en minutes, pas en secondes : on est nettement
// plus patient sur un 429 que sur une erreur serveur passagère.
const MAX_RETRIES_SERVEUR = 4;      // 5xx et coupures réseau
const MAX_RETRIES_DEBIT   = 6;      // 429
const ATTENTE_DEBIT_MAX   = 60000;  // plafond d'une attente unitaire
const PACE_APRES_429      = 1500;   // espacement des lots après un premier 429

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

/**
 * Lit l'en-tête `retry-after` : Voyage y met un nombre de secondes, la RFC
 * autorise aussi une date HTTP. Quand il est présent, il fait autorité sur notre
 * back-off — le serveur sait mieux que nous quand il acceptera de nouveau.
 * @returns {number|null} attente en millisecondes
 */
function parseRetryAfter(headers) {
  const brut = headers && headers.get && headers.get('retry-after');
  if (!brut) return null;

  const secondes = Number(brut.trim());
  if (Number.isFinite(secondes) && secondes >= 0) return Math.min(secondes * 1000, ATTENTE_DEBIT_MAX);

  const date = Date.parse(brut);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), ATTENTE_DEBIT_MAX);
  return null;
}

// Espacement appliqué entre deux lots. Passe à PACE_APRES_429 dès qu'une limite
// de débit est rencontrée : inutile de continuer à marteler au même rythme.
// Remis à zéro à chaque appel d'embedBatch, la limite étant propre à un run.
let paceCourant = 0;

async function callVoyage(inputs, inputType) {
  let lastError;
  let attempt = 0;
  let essaisDebit = 0;      // les 429 ont leur propre budget de tentatives

  for (;;) {
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
      // Coupure réseau : ni statut, ni corps.
      if (attempt >= MAX_RETRIES_SERVEUR) throw err;
      await sleep(500 * Math.pow(2, attempt));
      attempt++;
      lastError = err;
      continue;
    }

    if (res.ok) {
      const payload = await res.json();
      // Voyage ne garantit pas l'ordre : on réordonne sur `index`.
      const ordered = new Array(inputs.length);
      for (const item of payload.data) ordered[item.index] = l2normalize(item.embedding);
      return ordered;
    }

    // Le corps est lu quel que soit le statut : c'est lui qui distingue un
    // quota épuisé d'un simple dépassement de débit, et ne pas le remonter rend
    // le diagnostic impossible depuis les logs.
    const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    const detail = `Voyage ${res.status}${body ? ' — ' + body.slice(0, 300) : ''}`;

    // 401, 400, 403 : réessayer n'y changera rien.
    if (res.status !== 429 && res.status < 500) {
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }

    lastError = new Error(detail);
    lastError.status = res.status;

    if (res.status === 429) {
      paceCourant = PACE_APRES_429;
      if (essaisDebit >= MAX_RETRIES_DEBIT) throw lastError;
      const attente = parseRetryAfter(res.headers)
        ?? Math.min(2000 * Math.pow(2, essaisDebit), ATTENTE_DEBIT_MAX);
      await sleep(attente);
      essaisDebit++;
      continue;
    }

    if (attempt >= MAX_RETRIES_SERVEUR) throw lastError;
    await sleep(1000 * Math.pow(2, attempt));
    attempt++;
  }
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
  paceCourant = 0;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    if (i > 0 && paceCourant) await sleep(paceCourant);
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

module.exports = { embedBatch, embedQuery, isAvailable, l2normalize, parseRetryAfter, VOYAGE_MODEL };
