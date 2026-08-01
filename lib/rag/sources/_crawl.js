// ─── RAG : crawl HTML minimal et poli ─────────────────────────────────────────
// Utilisé par les sources HAS et SFD. Deux principes :
//   1. on part d'URL explicitement déclarées (pas de crawl ouvert du domaine) ;
//   2. une seule requête à la fois, avec un délai — on ingère quelques dizaines
//      de pages, pas des milliers.
//
// Les chemins interdits par robots.txt sont refusés côté code (voir `denied`
// dans chaque source) : la liste est courte et stable, on ne va pas embarquer un
// parseur robots pour deux règles.

const { fetchText, htmlToText, htmlTitle, extractLinks, sleep, DEFAULT_DELAY } = require('./_http');

// Lignes de navigation résiduelles : courtes, répétitives, sans ponctuation.
const BOILERPLATE = /^(accueil|menu|recherche|contact|partager|imprimer|connexion|se connecter|retour|suivant|précédent|newsletter|cookies?|plan du site|mentions légales|nous suivre|mon profil)\b/i;

function cleanPage(text) {
  return text
    .split('\n')
    .filter(line => {
      const l = line.trim();
      if (!l) return false;
      if (BOILERPLATE.test(l)) return false;
      // Une ligne très courte sans verbe ni ponctuation est presque toujours du menu.
      if (l.length < 25 && !/[.:;!?]/.test(l)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Récupère un ensemble de pages HTML et les convertit en documents.
 *
 * @param {{
 *   seeds: string[],
 *   sourceId: string,
 *   sourceLabel: string,
 *   expand?: {pattern: RegExp, max?: number},
 *   denied?: RegExp,
 *   minChars?: number,
 *   delay?: number,
 *   onProgress?: Function
 * }} options
 */
async function crawlPages({ seeds, sourceId, sourceLabel, expand, denied, minChars = 400, delay = DEFAULT_DELAY, onProgress }) {
  const allowed = url => !denied || !denied.test(url);
  const queue = [...new Set(seeds.filter(allowed))];
  const visited = new Set();
  const documents = [];
  const maxExpanded = expand && expand.max != null ? expand.max : 60;
  let expandedCount = 0;

  while (queue.length) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let html;
    try {
      html = await fetchText(url, { accept: 'text/html' });
    } catch (err) {
      console.warn(`[${sourceId}] page ignorée ${url} — ${err.message}`);
      continue;
    }
    await sleep(delay);

    // Depuis les pages d'amorce uniquement : on suit les liens vers les fiches.
    if (expand && expandedCount < maxExpanded && seeds.includes(url)) {
      for (const link of extractLinks(html, url, expand.pattern)) {
        if (expandedCount >= maxExpanded) break;
        if (visited.has(link) || queue.includes(link) || !allowed(link)) continue;
        queue.push(link);
        expandedCount++;
      }
    }

    const text = cleanPage(htmlToText(html));
    if (text.length < minChars) continue;

    documents.push({
      id: `${sourceId}:${url}`,
      title: htmlTitle(html) || url,
      url,
      text,
      meta: { source: sourceId, sourceLabel, lang: 'fr', retrievedAt: new Date().toISOString().slice(0, 10) },
    });
    if (onProgress) onProgress({ phase: 'page', label: url, done: documents.length });
  }

  return documents;
}

module.exports = { crawlPages, cleanPage };
