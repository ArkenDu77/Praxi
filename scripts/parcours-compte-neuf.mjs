/**
 * ============================================================================
 *  LE PARCOURS D'UN COMPTE CREE A L'INSTANT, SUR LE VRAI DEPLOIEMENT
 * ============================================================================
 *
 * Les bancs prouvent le produit contre une pile lancee pour eux. Ils ne
 * prouvent pas que le deploiement de demain se comporte pareil : un reglage
 * d'environnement, un quota, un essai expire, une variable oubliee — rien de
 * cela n'apparait dans un banc local.
 *
 * Ce programme fait donc le parcours REEL sur arkiba.fr, jusqu'a la seule
 * porte qu'un programme ne doit pas franchir : l'authentification Doctolib,
 * qui appartient au medecin et a son second facteur.
 *
 * Il ne compose aucun appel, et ne peut pas en composer : le compte cree n'a
 * aucune connexion authentifiee, donc aucun agenda a lire.
 */

const BASE = process.argv[2] ?? 'https://www.arkiba.fr';
const MOTEUR = 'https://arkiba-intake-production.up.railway.app';
const JETON_SERVICE = process.env.ARKIBA_SERVICE_TOKEN ?? '';

const marque = Date.now();
const compte = {
  prenom: 'Repetition',
  nom: 'Generale',
  email: `repetition.demo.${marque}@example.invalid`,
  password: `Rep${marque}!aA`,
  specialites: ['Anesthésiste-réanimateur'],
  ville: 'Paris',
};

const resultats = [];
const verifier = (quoi, ok, detail = '') => {
  resultats.push({ quoi, ok, detail });
  console.log(`${ok ? 'PASS ' : 'ECHEC'} ${quoi}${detail ? ` — ${detail}` : ''}`);
};

const json = async (res) => {
  const t = await res.text();
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return { brut: t.slice(0, 200) };
  }
};

// ---- 1. CREER LE COMPTE ----------------------------------------------------
const inscription = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(compte),
});
const corpsInscription = await json(inscription);
verifier('creation du compte', inscription.ok, `HTTP ${inscription.status}`);
if (!inscription.ok) {
  console.log(JSON.stringify(corpsInscription).slice(0, 300));
  process.exit(1);
}

// ---- 2. SE CONNECTER -------------------------------------------------------
const connexion = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: compte.email, password: compte.password }),
});
const corpsConnexion = await json(connexion);
const jeton = corpsConnexion.token;
verifier('connexion', Boolean(jeton), `HTTP ${connexion.status}`);
if (!jeton) process.exit(1);

const commeMedecin = (chemin, init = {}) =>
  fetch(`${BASE}${chemin}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jeton}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

// ---- 3. AUCUN MUR AVANT LES ECRANS DU PARCOURS ------------------------------
const preconsult = await commeMedecin('/api/preconsult/encounters');
verifier(
  'ecran Pre-consultation accessible (aucun paywall)',
  preconsult.ok,
  `HTTP ${preconsult.status}`,
);

const rdv = await commeMedecin('/api/preconsult/rendez-vous');
verifier('liste des rendez-vous accessible', rdv.ok, `HTTP ${rdv.status}`);

// ---- 4. LIAISON : CREER LA CONNEXION DOCTOLIB ------------------------------
const creation = await commeMedecin('/api/integrations/doctolib', { method: 'POST', body: {} });
const corpsCreation = await json(creation);
const connecteur = corpsCreation.integration?.connector_id ?? null;
verifier('connexion Doctolib creee depuis Liaison', Boolean(connecteur), `HTTP ${creation.status}`);

const liste = await json(await commeMedecin('/api/integrations'));
const sienne = (liste.integrations ?? []).find((i) => i.connector_id === connecteur);
verifier('la connexion apparait dans Liaison', Boolean(sienne), sienne ? `etat ${sienne.state}` : '');
verifier(
  'APPELS ETEINTS PAR DEFAUT',
  sienne?.calls_enabled === false,
  `calls_enabled=${sienne?.calls_enabled}`,
);

// ---- 5. LE WORKER DECOUVRE CE CABINET, SANS QU'ON LUI DISE ------------------
if (JETON_SERVICE) {
  const cabinets = await json(
    await fetch(`${MOTEUR}/api/worker/cabinets`, {
      headers: { 'x-arkiba-service-token': JETON_SERVICE },
    }),
  );
  const decouvert = (cabinets.cabinets ?? []).find((c) => c.connector_id === connecteur);
  verifier(
    'le worker DECOUVRE ce cabinet tout seul',
    Boolean(decouvert),
    decouvert ? `cabinet ${decouvert.tenant_id}` : 'absent de la liste',
  );
  verifier(
    'son cabinet lui est propre',
    Boolean(decouvert?.tenant_id) && decouvert.tenant_id !== 'org-4',
    decouvert?.tenant_id ?? '',
  );
  // Rien a lire tant que le medecin ne s'est pas authentifie : c'est la
  // barriere que ce programme ne franchit pas, et ne doit pas franchir.
  verifier(
    "aucun agenda lisible avant l'authentification du medecin",
    decouvert?.state !== 'CONNECTED',
    `etat ${decouvert?.state}`,
  );
}

// ---- 6. LE MEDECIN PEUT ACTIVER LES APPELS ---------------------------------
const bascule = await commeMedecin(`/api/integrations/${connecteur}/calls`, {
  method: 'POST',
  body: { enabled: true },
});
verifier('« Activer les appels Arkiba » fonctionne', bascule.ok, `HTTP ${bascule.status}`);

const apres = await json(await commeMedecin('/api/integrations'));
const apresBascule = (apres.integrations ?? []).find((i) => i.connector_id === connecteur);
verifier('les appels sont bien passes a ON', apresBascule?.calls_enabled === true);

// ---- 7. ON REPOSE LE COMPTE INERTE -----------------------------------------
// Ce compte est un compte d'essai cree pour cette verification. On le laisse
// avec les appels ETEINTS : il n'a aucune connexion authentifiee, donc aucun
// agenda, mais un cabinet qu'on laisse arme sans raison est une mauvaise
// habitude.
await commeMedecin(`/api/integrations/${connecteur}/calls`, { method: 'POST', body: { enabled: false } });

const echecs = resultats.filter((r) => !r.ok);
console.log('');
console.log(`compte d'essai : ${compte.email}`);
console.log(echecs.length === 0 ? 'VERDICT : LE PARCOURS D\'UN COMPTE NEUF EST OUVERT' : `VERDICT : ${echecs.length} ECHEC(S)`);
process.exit(echecs.length === 0 ? 0 : 1);
