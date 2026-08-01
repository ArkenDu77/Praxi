// ─── Source : PubMed (NCBI E-utilities) ───────────────────────────────────────
// API publique, sans clé obligatoire. Avec NCBI_API_KEY on passe de 3 à 10
// requêtes/seconde — recommandé pour une ingestion complète.
//
// On ne récupère que des revues et recommandations récentes : la littérature
// primaire isolée est trop bruitée pour servir de base à un avis clinique.

const { fetchText, decodeEntities, sleep } = require('./_http');

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const FETCH_BATCH = 100;   // efetch accepte davantage, mais les réponses deviennent lourdes

function apiKeyParam() {
  const key = (process.env.NCBI_API_KEY || '').trim();
  return key ? `&api_key=${encodeURIComponent(key)}` : '';
}

// Sans clé : 3 req/s max, on reste large.
function throttleDelay() {
  return (process.env.NCBI_API_KEY || '').trim() ? 120 : 400;
}

/** Recherche des PMID. */
async function esearch(term, retmax) {
  const ids = [];
  const pageSize = Math.min(retmax, 500);
  for (let start = 0; start < retmax; start += pageSize) {
    const url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance`
      + `&retmax=${Math.min(pageSize, retmax - start)}&retstart=${start}`
      + `&term=${encodeURIComponent(term)}${apiKeyParam()}`;
    const payload = JSON.parse(await fetchText(url, { accept: 'application/json' }));
    const page = (payload.esearchresult && payload.esearchresult.idlist) || [];
    ids.push(...page);
    if (page.length < pageSize) break;
    await sleep(throttleDelay());
  }
  return ids;
}

// Extrait le contenu textuel d'une balise XML, en concaténant les occurrences.
function tagContents(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match;
  while ((match = re.exec(xml))) out.push(match[1]);
  return out;
}

function textOf(xml, tag) {
  const [first] = tagContents(xml, tag);
  return first ? decodeEntities(first.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

// Les abstracts structurés portent un Label (BACKGROUND, METHODS…) : on le
// conserve, il aide le modèle à situer le passage.
function abstractOf(articleXml) {
  const [block] = tagContents(articleXml, 'Abstract');
  if (!block) return '';
  const parts = [];
  const re = /<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/gi;
  let match;
  while ((match = re.exec(block))) {
    const label = /Label\s*=\s*"([^"]*)"/i.exec(match[1]);
    const body  = decodeEntities(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    parts.push(label ? `${label[1]} : ${body}` : body);
  }
  return parts.join('\n\n');
}

function meshOf(articleXml) {
  return tagContents(articleXml, 'DescriptorName')
    .map(d => decodeEntities(d.replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function publicationTypes(articleXml) {
  return tagContents(articleXml, 'PublicationType')
    .map(t => decodeEntities(t.replace(/<[^>]+>/g, '')).trim())
    .filter(Boolean);
}

/** Récupère et met en forme les articles correspondant à une liste de PMID. */
async function efetch(ids) {
  const documents = [];
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const slice = ids.slice(i, i + FETCH_BATCH);
    const url = `${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&id=${slice.join(',')}${apiKeyParam()}`;
    const xml = await fetchText(url, { accept: 'application/xml' });

    for (const article of tagContents(xml, 'PubmedArticle')) {
      const pmid = textOf(article, 'PMID');
      const title = textOf(article, 'ArticleTitle');
      const abstract = abstractOf(article);
      // Un article sans abstract n'apporte rien d'exploitable.
      if (!pmid || !abstract) continue;

      const journal = textOf(article, 'Title');
      const year = (/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/i.exec(article) || [])[1] || '';
      const types = publicationTypes(article);
      const mesh = meshOf(article);

      documents.push({
        id: `pubmed:${pmid}`,
        title,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        text: [
          abstract,
          mesh.length ? `Termes MeSH : ${mesh.join(', ')}` : '',
        ].filter(Boolean).join('\n\n'),
        meta: {
          source: 'pubmed',
          sourceLabel: 'PubMed',
          pmid,
          journal,
          year,
          publicationTypes: types,
          lang: 'en',
        },
      });
    }
    await sleep(throttleDelay());
  }
  return documents;
}

/**
 * Récupère les documents PubMed d'une spécialité.
 * @param {{queries:string[], limit?:number, onProgress?:Function}} options
 */
async function fetchDocuments({ queries, limit = 2000, onProgress }) {
  const perQuery = Math.max(1, Math.ceil(limit / Math.max(queries.length, 1)));
  const seen = new Set();
  const documents = [];

  for (const query of queries) {
    if (documents.length >= limit) break;
    if (onProgress) onProgress({ phase: 'search', label: query });
    let ids;
    try {
      ids = await esearch(query, perQuery);
    } catch (err) {
      console.warn(`[pubmed] recherche échouée « ${query} » — ${err.message}`);
      continue;
    }
    const fresh = ids.filter(id => !seen.has(id));
    fresh.forEach(id => seen.add(id));
    if (!fresh.length) continue;

    if (onProgress) onProgress({ phase: 'fetch', label: query, total: fresh.length });
    try {
      documents.push(...await efetch(fresh.slice(0, limit - documents.length)));
    } catch (err) {
      console.warn(`[pubmed] récupération échouée « ${query} » — ${err.message}`);
    }
  }
  return documents;
}

module.exports = { id: 'pubmed', label: 'PubMed', fetchDocuments, esearch, efetch };
