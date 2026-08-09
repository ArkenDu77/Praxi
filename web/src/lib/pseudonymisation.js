/**
 * Arkiba — pseudonymisation côté client.
 *
 * Ces fonctions décident de ce qui sort du poste du médecin et de ce qui revient
 * dans un document signé : ce sont les deux points où une régression est à la
 * fois invisible et grave.
 *
 * Le code vivait dans le script inline de `public/app.html`. Il est porté ici
 * tel quel — même logique, mêmes expressions régulières, mêmes commentaires —
 * pour que la refonte visuelle réutilise le code éprouvé au lieu d'en réécrire
 * une variante. `tests/pseudonymisation.test.js` exécute ce module directement.
 *
 * Module ES : consommé par le frontend. Le test l'exécute dans un `vm`, selon la
 * convention déjà en place dans ce dépôt.
 */

// Les champs de texte libre soumis à la pseudonymisation, par type de document.
// Cette table est la définition unique de ce que recouvre la mention « les
// données identifiantes sont anonymisées avant envoi » affichée dans
// l'interface : tout écran qui porte cette mention doit figurer ici, et tout
// champ absent d'une entrée part en clair. Auparavant seules la lettre de
// liaison, le compte-rendu et la consultation étaient traités — et uniquement
// leur champ `notes` —, alors que le certificat MDPH, le protocole ALD et le
// certificat médical affichaient la même promesse en envoyant le nom du patient
// et son diagnostic tels quels.
export const PSEUDO_FIELDS = {
  liaison:    ['motif', 'notes', 'complement'],
  cr:         ['notes', 'complement'],
  consult:    ['notes', 'complement'],
  mdph:       ['diagnostic', 'notes', 'complement'],
  ald:        ['affection', 'notes', 'complement'],
  certificat: ['type', 'notes', 'complement'],
  ordonnance: ['medicaments', 'medicamentsAld', 'complement'],
  // Le document analysé est collé par le médecin : on ignore quel nom il
  // contient, donc on ne peut pas le masquer. Les identifiants de forme fixe
  // (NIR, adresse, date de naissance) le sont, et l'écran ne promet rien de plus.
  resume:     ['text', 'complement'],
};

export function pseudonymize(text, patient, age, substitutions = new Map()) {
  let anon = text;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Compteur porté par la Map partagée : plusieurs champs d'un même document
  // sont pseudonymisés à la suite et doivent continuer la même numérotation.
  const prochainIndex = kind => {
    let i = 1;
    while (substitutions.has(`__${kind}_${i}__`)) i++;
    return i;
  };

  // ── Nom du patient ──
  if (patient && patient.trim()) {
    const raw = patient.trim();
    const cleanName = raw.replace(/^(M\.|Mme\.?|Mme|Dr\.?|Pr\.?)\s+/i, '').trim();
    const parts = cleanName.split(/\s+/).filter(p => p.length > 0);
    const titles = ['M\\.', 'Mme\\.?', 'Mme', 'Dr\\.?', 'Pr\\.?'];
    const patterns = new Set();

    // Nom avec titres (original et inversé)
    titles.forEach(t => {
      patterns.add(t + '\\s+' + esc(cleanName));
      if (parts.length >= 2) patterns.add(t + '\\s+' + esc([...parts].reverse().join(' ')));
    });
    // Nom original, sans titre, inversé
    patterns.add(esc(raw));
    patterns.add(esc(cleanName));
    if (parts.length >= 2) patterns.add(esc([...parts].reverse().join(' ')));
    // Parties individuelles (≥ 4 chars) avec word boundary
    parts.forEach(p => { if (p.length >= 4) patterns.add('\\b' + esc(p) + '\\b'); });

    // Trier du plus long au plus court pour éviter les correspondances partielles
    Array.from(patterns)
      .sort((a, b) => b.length - a.length)
      .forEach(pat => {
        anon = anon.replace(new RegExp(pat, 'gi'), () => {
          if (!substitutions.has('__patient__')) substitutions.set('__patient__', raw);
          return 'PATIENT_CONFIDENTIEL';
        });
      });
  }

  // ── Âge exact → tranche de 5 ans ──
  if (age && age.trim()) {
    const m = age.trim().match(/^(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      anon = anon.replace(new RegExp('\\b' + n + '\\s*ans\\b', 'gi'), match => {
        if (!substitutions.has('__age__')) substitutions.set('__age__', match);
        return 'AGE_PATIENT';
      });
    }
  }

  // ── Dates de naissance ──
  anon = anon.replace(/né[e]?\s+le\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/gi, (match, d) => {
    substitutions.set('__dob__', match);
    const year = parseInt(d.split(/[\/\-]/).pop(), 10);
    return `né dans les années ${Math.floor(year / 10) * 10}`;
  });
  anon = anon.replace(/né[e]?\s+en\s+(\d{4})/gi, (match, y) => {
    substitutions.set('__doby__', match);
    return `né dans les années ${Math.floor(parseInt(y, 10) / 10) * 10}`;
  });

  // ── NIR / numéro de sécu (13 chiffres consécutifs) ──
  // Chaque occurrence reçoit son propre marqueur numéroté. La version
  // précédente stockait une seule valeur par catégorie (`__nir__`) et
  // restituait la première partout : deux numéros dans un même document
  // ressortaient identiques, celui du second patient écrasé par le premier.
  anon = anon.replace(/\b(\d{13})\b/g, match => {
    const i = prochainIndex('nir');
    substitutions.set(`__nir_${i}__`, match);
    return `[numéro retiré ${i}]`;
  });

  // ── Adresses (numéro + type de voie + libellé) ──
  anon = anon.replace(
    /\b\d+[a-z]?\s+(?:rue|avenue|av\.?|boulevard|bd\.?|allée|place|impasse|chemin|voie|route|passage|cité|résidence|cours)\s+[^,\n]{3,50}(?:,\s*\d{5}\s+[^\n,]{2,30})?/gi,
    match => {
      const i = prochainIndex('addr');
      substitutions.set(`__addr_${i}__`, match);
      return `[adresse retirée ${i}]`;
    }
  );

  return { anonymizedText: anon, substitutions };
}

// Jetons d'identité substitués dans les champs structurés du formulaire.
export const IDENTITY_TOKENS = { patient: 'PATIENT_CONFIDENTIEL', age: 'AGE_PATIENT', ddn: 'DDN_PATIENT' };

/**
 * Pseudonymise sur place tous les champs déclarés pour ce type de document.
 * @returns {{substitutions:Map, patientOrig:string}|null} null si le type n'est
 *          pas couvert — l'appelant ne doit alors afficher aucune promesse.
 */
export function pseudonymizePayload(key, payload) {
  const champs = PSEUDO_FIELDS[key];
  if (!champs) return null;

  const patientOrig = typeof payload.patient === 'string' ? payload.patient.trim() : '';
  const ageOrig     = typeof payload.age === 'string'     ? payload.age.trim()     : '';
  const ddnOrig     = typeof payload.ddn === 'string'     ? payload.ddn.trim()     : '';
  const substitutions = new Map();

  for (const champ of champs) {
    if (typeof payload[champ] !== 'string' || !payload[champ]) continue;
    payload[champ] = pseudonymize(payload[champ], patientOrig, ageOrig, substitutions).anonymizedText;
  }

  if (patientOrig) payload.patient = IDENTITY_TOKENS.patient;
  if (ageOrig) { substitutions.set('__age__', ageOrig); payload.age = IDENTITY_TOKENS.age; }
  // La date de naissance est directement identifiante : elle ne quitte pas le
  // poste. Le modèle reçoit un jeton qu'il recopie, et le front la replace.
  if (ddnOrig) { substitutions.set('__ddn__', ddnOrig); payload.ddn = IDENTITY_TOKENS.ddn; }

  return { substitutions, patientOrig };
}

export function resubstitute(text, substitutions, patient) {
  let out = text;
  if (patient && patient.trim()) {
    const name = patient.trim();
    out = out.replace(/\bPATIENT_CONFIDENTIEL\b/g, name);
    out = out.replace(/Information non renseignée\s*\(prénom et nom du patient\)/gi, name);
    out = out.replace(/(je\s+(?:me permets de vous |vous )?adresse\s+)Information non renseignée/gi, '$1' + name);
    // Ordre du plus spécifique au plus général
    // 1. Titre + référence anonymisée combinés → nom complet
    out = out.replace(/\b(?:M\.|Mme\.?|Monsieur|Madame)\s+(?:le patient|la patiente)\b/gi, name);
    // 2. Possessifs (mon/ma/notre/votre) → nom complet
    out = out.replace(/\b(?:mon|ma|notre|votre)\s+patient[e]?\b/gi, name);
    // 3. Démonstratifs → nom complet
    out = out.replace(/\bce(?:tte)?\s+patient[e]?\b/gi, name);
    // 4. "ce dossier" → "le dossier de [nom]"
    out = out.replace(/\bce\s+dossier\b/gi, `le dossier de ${name}`);
    // 5. Références directes anonymisées → nom complet
    out = out.replace(/\bla patiente\b/gi, name);
    out = out.replace(/\ble patient\b/gi, name);
    out = out.replace(/\bune patiente\b/gi, name);
    out = out.replace(/\bun patient\b/gi, name);
    // 6. Titre seul sans mot qui suit → "M./Mme [nom]"
    out = out.replace(/\bMonsieur\b(?!\s+[A-ZÀ-ÖÙÜa-zà-öùü])/g, `M. ${name}`);
    out = out.replace(/\bMadame\b(?!\s+[A-ZÀ-ÖÙÜa-zà-öùü])/g, `Mme ${name}`);
    // 7. "M." / "Mme" sans nom en majuscule après → "M./Mme [nom]"
    out = out.replace(/\bM\.(?!\s+[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜÇ])/g, `M. ${name}`);
    out = out.replace(/\bMme\.?(?!\s+[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜÇ])/g, `Mme ${name}`);
  }
  for (const [k, v] of substitutions) {
    if (k === '__age__') {
      const exact = String(v).match(/\d{1,3}/);
      if (exact) {
        out = out.replace(/\bAGE_PATIENT\b/g, exact[0] + ' ans');
        out = out.replace(/(?:l['’]âge|âge)\s+Information non renseignée/gi, 'âge de ' + exact[0] + ' ans');
        // Deux règles de rattrapage ont été retirées ici : elles remplaçaient
        // toute tranche d'âge du document (« entre 50 et 74 ans », « 18-65 ans »)
        // par l'âge du patient. Un seuil de dépistage ou une tranche d'AMM se
        // trouvait ainsi réécrit en silence dans un document signé — le
        // document restait plausible tout en étant faux. Le jeton AGE_PATIENT,
        // que le modèle a pour consigne de recopier tel quel, suffit.
      }
    }
    if (k === '__ddn__')   out = out.replace(/\bDDN_PATIENT\b/g, v);
    if (/^__nir_\d+__$/.test(k))  out = out.split(`[numéro retiré ${k.match(/\d+/)[0]}]`).join(v);
    if (/^__addr_\d+__$/.test(k)) out = out.split(`[adresse retirée ${k.match(/\d+/)[0]}]`).join(v);
  }
  const today = new Intl.DateTimeFormat('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' }).format(new Date());
  out = out.replace(/Information non renseignée\s*\(date d['’]émission\)/gi, today);
  return nettoyerJetonsResiduels(out);
}

/**
 * Filet de sécurité : retire tout jeton d'identité qui aurait survécu à la
 * restitution.
 *
 * Un jeton ne survit que si le modèle l'a écrit sans qu'on le lui ait fourni —
 * c'est ce qui se produisait sur l'écran Compte-rendu, dépourvu de champ Âge :
 * « AGE_PATIENT » sortait en clair, deux fois, dans un document destiné à être
 * signé. La cause est traitée côté serveur (la consigne ne cite plus que les
 * jetons réellement transmis) ; ce filet garantit qu'aucune régression de prompt
 * ne puisse à nouveau faire fuiter un jeton jusqu'à l'écran.
 *
 * On retire la mention entière plutôt que le seul jeton : supprimer « AGE_PATIENT »
 * dans « patient de AGE_PATIENT, admis pour… » laisserait « patient de , admis ».
 */
export function nettoyerJetonsResiduels(texte) {
  let out = texte;
  // Prépositions qui introduisent habituellement la donnée masquée.
  const PREP = '(?:âgée?\\s+de|née?\\s+le|de|le)';

  for (const jeton of ['AGE_PATIENT', 'DDN_PATIENT', 'PATIENT_CONFIDENTIEL']) {
    if (!out.includes(jeton)) continue;
    console.warn(`[arkiba] jeton non restitué retiré du document : ${jeton}`);
    out = out
      // 1. Apposition entre deux virgules — « M. Dupont, âgé de X, consulte ».
      //    Les DEUX virgules partent, sinon il reste « M. Dupont, consulte ».
      .replace(new RegExp(`,\\s*${PREP}?\\s*${jeton}\\s*,`, 'gi'), ' ')
      // 2. Entre parenthèses, crochets ou tirets — « le patient (X) présente ».
      .replace(new RegExp(`\\s*[(\\[]\\s*${PREP}?\\s*${jeton}\\s*[)\\]]`, 'gi'), '')
      .replace(new RegExp(`\\s*[—–-]\\s*${PREP}?\\s*${jeton}\\s*(?=[—–-]|$)`, 'gim'), '')
      // 3. Introduit par une préposition — « âgé de X », « né le X ».
      .replace(new RegExp(`\\s*${PREP}\\s+${jeton}\\b`, 'gi'), '')
      // 4. Occurrence isolée restante.
      .replace(new RegExp(`\\s*\\b${jeton}\\b`, 'g'), '');
  }

  // Ponctuation laissée orpheline par les retraits ci-dessus.
  return out
    .replace(/[ \t]+([,;.])/g, '$1')      // espace avant ponctuation
    .replace(/,\s*,/g, ',')               // virgules jumelles
    .replace(/,\s*([.;])/g, '$1')         // virgule collée à un point
    .replace(/^[ \t]*[,;]\s*/gm, '')      // ponctuation en début de ligne
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '');
}
