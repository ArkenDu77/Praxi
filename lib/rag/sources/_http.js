// ─── RAG : utilitaires réseau partagés par les sources ────────────────────────
// Récupération polie (User-Agent identifiable, délai entre requêtes, reprise sur
// erreur transitoire) et conversion HTML → texte.

const UA = 'ArkibaBot/1.0 (assistant médico-administratif; ingestion documentaire)';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_DELAY   = 350;   // ms entre deux requêtes vers un même hôte

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * GET avec reprise sur 429/5xx et erreurs réseau.
 * @param {string} url
 * @param {{timeout?:number, retries?:number, encoding?:string, accept?:string}} [options]
 * @returns {Promise<string>}
 */
async function fetchText(url, options = {}) {
  const retries  = options.retries == null ? 3 : options.retries;
  const timeout  = options.timeout || DEFAULT_TIMEOUT;
  const encoding = options.encoding || 'utf-8';

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': options.accept || '*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        return new TextDecoder(encoding).decode(buffer);
      }
      // 404 / 403 : inutile d'insister.
      if (res.status !== 429 && res.status < 500) {
        const err = new Error(`HTTP ${res.status} — ${url}`);
        err.status = res.status;
        throw err;
      }
      lastError = new Error(`HTTP ${res.status} — ${url}`);
    } catch (err) {
      if (err.status) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    await sleep(800 * Math.pow(2, attempt));
  }
  throw lastError || new Error('Échec de récupération : ' + url);
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&nbsp;': ' ', '&eacute;': 'é', '&egrave;': 'è', '&ecirc;': 'ê', '&agrave;': 'à',
  '&ccedil;': 'ç', '&ugrave;': 'ù', '&ocirc;': 'ô', '&icirc;': 'î', '&iuml;': 'ï',
  '&acirc;': 'â', '&ucirc;': 'û', '&euml;': 'ë', '&laquo;': '«', '&raquo;': '»',
  '&rsquo;': '’', '&deg;': '°', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
};

/** Décode les entités HTML/XML les plus courantes, y compris numériques. */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;/gi, m => ENTITIES[m.toLowerCase()] || m);
}

/**
 * Extrait le texte lisible d'une page HTML.
 * Retire scripts, styles, navigation et pieds de page — le bruit de navigation
 * pollue l'index et fait remonter des passages inutiles.
 */
function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Récupère le contenu de <title>. */
function htmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

/**
 * Liens absolus présents dans une page, filtrés par motif.
 * @param {string} html
 * @param {string} baseUrl
 * @param {RegExp} [pattern]
 */
function extractLinks(html, baseUrl, pattern) {
  const links = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = re.exec(html || ''))) {
    let href = decodeEntities(match[1]).trim();
    if (!href || /^(javascript|mailto|tel):/i.test(href)) continue;
    try { href = new URL(href, baseUrl).href; } catch (_) { continue; }
    if (pattern && !pattern.test(href)) continue;
    links.add(href.split('#')[0]);
  }
  return [...links];
}

module.exports = { fetchText, htmlToText, htmlTitle, extractLinks, decodeEntities, sleep, DEFAULT_DELAY, UA };
