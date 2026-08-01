// ─── RAG : découpage en chunks ────────────────────────────────────────────────
// Générique : ne connaît rien à la dermatologie ni au médical. Découpe un texte
// long en passages de taille homogène, en respectant autant que possible les
// frontières naturelles (paragraphes, puis phrases).
//
// L'unité de travail est le caractère, pas le token : le rapport est stable en
// français (~3,7 caractères par token) et cela évite d'embarquer un tokenizer.

const DEFAULT_MAX_CHARS = 3000;   // ≈ 800 tokens
const DEFAULT_MIN_CHARS = 250;    // en dessous, le passage n'apporte rien
const DEFAULT_OVERLAP   = 0.15;   // 15 % de recouvrement entre chunks voisins

// Normalise les blancs sans écraser la structure en paragraphes.
function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Découpe en phrases. Volontairement simple : on tolère quelques faux positifs
// (abréviations « Dr. », « cf. ») car une phrase coupée en deux reste lisible.
function splitSentences(paragraph) {
  const parts = paragraph.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ0-9«"])/);
  return parts.filter(p => p.trim());
}

// Coupe un bloc trop long qui ne contient aucune frontière exploitable.
function hardSplit(text, maxChars) {
  const out = [];
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars));
  return out;
}

// Reprend la fin d'un chunk pour amorcer le suivant : une idée à cheval sur deux
// passages reste retrouvable depuis l'un comme depuis l'autre.
function tailOverlap(text, overlapChars) {
  if (overlapChars <= 0 || text.length <= overlapChars) return '';
  const tail = text.slice(-overlapChars);
  const cut  = tail.search(/(?<=[.!?…])\s+/);
  return (cut === -1 ? tail : tail.slice(cut)).trim();
}

/**
 * Découpe un texte en passages.
 * @param {string} text
 * @param {{maxChars?:number, minChars?:number, overlap?:number}} [options]
 * @returns {string[]}
 */
function chunkText(text, options = {}) {
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const minChars = options.minChars == null ? DEFAULT_MIN_CHARS : options.minChars;
  const overlapChars = Math.round(maxChars * (options.overlap == null ? DEFAULT_OVERLAP : options.overlap));

  const source = normalize(text);
  if (!source) return [];
  if (source.length <= maxChars) return [source];

  // Unités atomiques : paragraphes, éclatés en phrases si trop longs.
  const units = [];
  for (const paragraph of source.split(/\n{2,}/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= maxChars) { units.push(p); continue; }
    for (const sentence of splitSentences(p)) {
      if (sentence.length <= maxChars) units.push(sentence.trim());
      else units.push(...hardSplit(sentence.trim(), maxChars));
    }
  }

  const chunks = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? current + '\n\n' + unit : unit;
    if (candidate.length <= maxChars) { current = candidate; continue; }
    if (current) chunks.push(current);
    const carry = tailOverlap(current, overlapChars);
    current = carry && (carry.length + unit.length + 2) <= maxChars ? carry + '\n\n' + unit : unit;
  }
  if (current) chunks.push(current);

  // Un dernier passage résiduel trop court est refondu dans le précédent —
  // mais jamais au prix d'un dépassement de maxChars, qui casserait la
  // régularité de taille sur laquelle repose la normalisation BM25.
  if (chunks.length > 1) {
    const dernier = chunks[chunks.length - 1];
    const avantDernier = chunks[chunks.length - 2];
    if (dernier.length < minChars && avantDernier.length + dernier.length + 2 <= maxChars) {
      chunks.pop();
      chunks[chunks.length - 1] = avantDernier + '\n\n' + dernier;
    }
  }
  return chunks.filter(c => c.length >= Math.min(minChars, source.length));
}

/**
 * Découpe un document en enregistrements prêts pour l'indexation.
 * Chaque chunk hérite du titre du document : le contexte reste lisible même
 * quand le passage est extrait seul.
 *
 * @param {{id:string, title?:string, url?:string, text:string, meta?:object}} doc
 * @param {object} [options]
 * @returns {{id:string, text:string, meta:object}[]}
 */
function chunkDocument(doc, options = {}) {
  const pieces = chunkText(doc.text, options);
  return pieces.map((text, i) => ({
    id: `${doc.id}#${i}`,
    text: doc.title ? `${doc.title}\n\n${text}` : text,
    meta: Object.assign({}, doc.meta, {
      docId: doc.id,
      title: doc.title || '',
      url:   doc.url || '',
      chunkIndex: i,
      chunkCount: pieces.length,
    }),
  }));
}

module.exports = { chunkText, chunkDocument, normalize };
