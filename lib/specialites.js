// ─── Registre des spécialités « avis spécialisé » ─────────────────────────────
// Ajouter une spécialité = ajouter une entrée ici. Rien d'autre à toucher : ni le
// moteur RAG (générique), ni la route API, ni le script d'ingestion, ni le front
// (qui alimente son menu déroulant depuis GET /api/avis-specialise/specialites).
//
// Chaque entrée décrit :
//   collection  espace de noms de l'index vectoriel
//   cadrage     cadrage clinique injecté dans le prompt système
//   sources     configuration d'ingestion, une clé par source disponible

const SPECIALITES = {
  dermatologie: {
    key: 'dermatologie',
    label: 'Dermatologie',
    collection: 'dermatologie',
    actif: true,
    accepteImages: true,

    cadrage:
      "Tu raisonnes comme un dermatologue hospitalo-universitaire français sollicité par un confrère " +
      "pour un avis de second recours. Structure ton raisonnement autour de la lésion élémentaire, de sa " +
      "topographie, de son évolution et du terrain. Distingue systématiquement ce que tu observes de ce que " +
      "tu supposes.",

    // Repères de vocabulaire injectés dans la requête de recherche pour orienter
    // le rappel lexical (BM25) vers le champ dermatologique.
    termesPivots: ['dermatologie', 'lésion cutanée', 'peau', 'éruption', 'dermatose'],

    sources: {
      pubmed: {
        limit: 2500,
        // Revues et recommandations récentes uniquement : la littérature primaire
        // isolée est trop bruitée pour fonder un avis.
        queries: [
          '("Skin Diseases"[MeSH] OR "Dermatology"[MeSH]) AND (review[pt] OR guideline[pt] OR practice guideline[pt]) AND ("2019"[dp] : "3000"[dp])',
          '"Dermatitis, Atopic"[MeSH] AND (review[pt] OR guideline[pt]) AND ("2019"[dp] : "3000"[dp])',
          '"Psoriasis"[MeSH] AND (review[pt] OR guideline[pt]) AND ("2019"[dp] : "3000"[dp])',
          '"Acne Vulgaris"[MeSH] AND (review[pt] OR guideline[pt]) AND ("2018"[dp] : "3000"[dp])',
          '("Melanoma"[MeSH] OR "Skin Neoplasms"[MeSH]) AND (review[pt] OR guideline[pt]) AND ("2020"[dp] : "3000"[dp])',
          '"Urticaria"[MeSH] AND (review[pt] OR guideline[pt]) AND ("2018"[dp] : "3000"[dp])',
          '("Rosacea"[MeSH] OR "Hidradenitis Suppurativa"[MeSH] OR "Vitiligo"[MeSH]) AND (review[pt] OR guideline[pt]) AND ("2018"[dp] : "3000"[dp])',
          '("Dermatomycoses"[MeSH] OR "Scabies"[MeSH] OR "Skin Diseases, Bacterial"[MeSH]) AND (review[pt] OR guideline[pt]) AND ("2018"[dp] : "3000"[dp])',
          '("Drug Eruptions"[MeSH] OR "Dermatitis, Contact"[MeSH]) AND (review[pt] OR guideline[pt]) AND ("2018"[dp] : "3000"[dp])',
          '"Alopecia"[MeSH] AND (review[pt] OR guideline[pt]) AND ("2018"[dp] : "3000"[dp])',
        ],
      },

      // Publications HAS ciblées. Le moteur de recherche du site étant interdit
      // par robots.txt, cette liste est curée à la main et vérifiée.
      has: {
        limit: 60,
        seeds: [
          'https://www.has-sante.fr/jcms/c_2040322/fr/label-de-la-has-traitement-de-l-acne-par-voie-locale-et-generale',
          'https://www.has-sante.fr/jcms/p_3500387/fr/dupixent-dupilumab-dermatite-atopique',
          'https://www.has-sante.fr/jcms/p_3237060/fr/olumiant-dermatite-atopique-moderee-a-severe-de-l-adulte-baricitinib',
          'https://www.has-sante.fr/jcms/p_3361535/fr/protopic-tacrolimus-monohydrate-dermatite-atopique-severe',
          'https://www.has-sante.fr/jcms/p_3313562/fr/rinvoq-upadacitinib-hemihydrate-dermatite-atopique',
        ],
      },

      sfd: { limit: 120, maxPages: 60 },

      bdpm: {
        limit: 1500,
        filter: {
          // Voies d'administration à visée dermatologique.
          routes: ['cutanée', 'transdermique'],
          // Substances de référence en dermatologie, systémiques comprises.
          substances: [
            'BÉTAMÉTHASONE', 'DIPROPIONATE DE BÉTAMÉTHASONE', 'DÉSONIDE', 'HYDROCORTISONE',
            'CLOBÉTASOL', 'TACROLIMUS', 'PIMÉCROLIMUS', 'CALCIPOTRIOL', 'ISOTRÉTINOÏNE',
            'ADAPALÈNE', 'TRÉTINOÏNE', 'PEROXYDE DE BENZOYLE', 'ACIDE AZÉLAÏQUE',
            'MÉTRONIDAZOLE', 'IVERMECTINE', 'PERMÉTHRINE', 'BENZOATE DE BENZYLE',
            'TERBINAFINE', 'KÉTOCONAZOLE', 'CICLOPIROX', 'GRISÉOFULVINE', 'FLUCONAZOLE',
            'MUPIROCINE', 'ACIDE FUSIDIQUE', 'DOXYCYCLINE', 'LYMÉCYCLINE',
            'MÉTHOTREXATE', 'CICLOSPORINE', 'ACITRÉTINE', 'DUPILUMAB', 'BARICITINIB',
            'UPADACITINIB', 'ABROCITINIB', 'SÉCUKINUMAB', 'IXÉKIZUMAB', 'USTÉKINUMAB',
            'ADALIMUMAB', 'RISANKIZUMAB', 'GUSELKUMAB', 'OMALIZUMAB', 'MINOXIDIL',
            'FINASTÉRIDE', 'HYDROXYZINE', 'CÉTIRIZINE', 'DÉSLORATADINE',
          ],
          keywords: [
            'psoriasis', 'dermatite atopique', 'eczéma', 'acné', 'rosacée', 'urticaire',
            'vitiligo', 'alopécie', 'mycose cutanée', 'gale', 'impétigo', 'hidradénite',
            'kératose actinique', 'dermatose',
          ],
        },
      },
    },
  },

  // ─── Gabarit pour ajouter une spécialité ────────────────────────────────────
  // cardiologie: {
  //   key: 'cardiologie', label: 'Cardiologie', collection: 'cardiologie',
  //   actif: false, accepteImages: false,
  //   cadrage: '…',
  //   termesPivots: ['cardiologie', 'ECG'],
  //   sources: { pubmed: { limit: 2000, queries: [...] }, bdpm: { filter: {...} } },
  // },
};

/** Une spécialité par sa clé, ou null. */
function getSpecialite(key) {
  const entry = SPECIALITES[String(key || '').toLowerCase().trim()];
  return entry && entry.actif ? entry : null;
}

/** Liste destinée au menu déroulant du front. */
function listSpecialites() {
  return Object.values(SPECIALITES)
    .filter(s => s.actif)
    .map(s => ({ key: s.key, label: s.label, accepteImages: Boolean(s.accepteImages) }));
}

/** Toutes les entrées, actives ou non — utilisé par le script d'ingestion. */
function allSpecialites() {
  return Object.values(SPECIALITES);
}

module.exports = { SPECIALITES, getSpecialite, listSpecialites, allSpecialites };
