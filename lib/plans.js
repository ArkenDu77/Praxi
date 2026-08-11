'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  PLANS D'ABONNEMENT — source unique de vérité
//
//  Ce module ne connaît ni Express, ni Stripe, ni le disque : il décide, à
//  partir d'un enregistrement utilisateur, ce que le compte a le droit de faire.
//  Le serveur applique ces décisions AVANT d'appeler le modèle ; l'interface ne
//  fait que refléter l'état. Un compte gratuit qui retire le verrou dans son
//  navigateur se heurte donc quand même au 402 du backend.
// ─────────────────────────────────────────────────────────────────────────────

// ── Whitelist « accès illimité » ─────────────────────────────────────────────
// Statut indépendant de l'abonnement : ces comptes ne sont jamais facturés, ne
// se voient jamais proposer de session de paiement, et ignorent tout plafond.
// La liste est une liste d'EMAILS : le contrôle se fait sur l'email du compte
// tel qu'il est enregistré en base (users.json), jamais sur un mot de passe ni
// sur un jeton en dur. L'authentification de ces comptes reste le login normal.
const ADMIN_EMAILS_PAR_DEFAUT = [
  'benarken@yahoo.com',
  'sbh75@gmx.fr',
];

/** Emails à accès illimité, surchargeables par ARKIBA_ADMIN_EMAILS (séparés par des virgules). */
function adminEmails() {
  const brut = (process.env.ARKIBA_ADMIN_EMAILS || '').trim();
  const liste = brut
    ? brut.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : ADMIN_EMAILS_PAR_DEFAUT;
  return new Set(liste);
}

/** L'email donne-t-il droit à l'accès illimité ? Comparaison insensible à la casse. */
function estEmailIllimite(email) {
  return adminEmails().has(String(email || '').trim().toLowerCase());
}

// ── Plans ────────────────────────────────────────────────────────────────────
// `plan` est le champ stocké sur le compte. `planEffectif()` en dérive l'état
// réel, qui tient compte de l'expiration de l'essai et de la whitelist.
const PLANS = ['trial', 'free', 'pro', 'groupe'];

const DUREE_ESSAI_JOURS = 30;
const QUOTA_DOCUMENTS_ESSAI = 50;
const QUOTA_PATIENTS_ESSAI  = 10;

// Ce que chaque plan effectif autorise.
//   base    : les modules du quotidien (liaison, compte-rendu, résumé, dictée)
//   pro     : les modules avancés (MDPH, ALD, certificat, ordonnance, avis)
//   documents / patients : plafonds, `Infinity` = sans limite
const DROITS = {
  illimite: { base: true,  pro: true,  documents: Infinity,             patients: Infinity },
  pro:      { base: true,  pro: true,  documents: Infinity,             patients: Infinity },
  groupe:   { base: true,  pro: true,  documents: Infinity,             patients: Infinity },
  trial:    { base: true,  pro: false, documents: QUOTA_DOCUMENTS_ESSAI, patients: QUOTA_PATIENTS_ESSAI },
  // Essai terminé sans abonnement : le compte passe en lecture seule. Les
  // documents et dossiers déjà produits restent consultables et supprimables
  // (on ne prend pas des données médicales en otage), mais plus rien ne se
  // génère.
  free:     { base: false, pro: false, documents: 0,                    patients: 0 },
};

// Niveau requis par fonctionnalité. La clé est celle passée à requireFeature()
// côté serveur ; ajouter une route sans l'inscrire ici la laisserait ouverte,
// c'est pourquoi `niveauRequis()` refuse par défaut les clés inconnues.
const FONCTIONNALITES = {
  'clinical.analyze':      'base',
  'generate.liaison':      'base',
  'generate.compte-rendu': 'base',
  'generate.resume':       'base',
  'generate.mdph':         'pro',
  'generate.ald':          'pro',
  'generate.certificat':   'pro',
  'generate.ordonnance':   'pro',
  'avis-specialise':       'pro',
  'patients.write':        'base',
  'documents.write':       'base',
};

const LIBELLES = {
  'clinical.analyze':      'Analyse clinique',
  'generate.liaison':      'Lettre de liaison',
  'generate.compte-rendu': 'Compte-rendu de consultation',
  'generate.resume':       'Résumé de document',
  'generate.mdph':         'Dossier MDPH',
  'generate.ald':          'Demande ALD',
  'generate.certificat':   'Certificat médical',
  'generate.ordonnance':   'Ordonnance',
  'avis-specialise':       'Avis spécialisé',
  'patients.write':        'Dossiers patients',
  'documents.write':       'Enregistrement de documents',
};

// Fonctionnalités qui appellent le modèle, et décomptent donc du plafond de
// documents. `clinical.analyze` en est exclue : c'est l'aide à la saisie de
// l'écran de consultation, elle tourne sans appel modèle et n'a rien produit
// que le médecin puisse signer.
const CONSOMME_QUOTA = new Set([
  'generate.liaison',
  'generate.compte-rendu',
  'generate.resume',
  'generate.mdph',
  'generate.ald',
  'generate.certificat',
  'generate.ordonnance',
  'avis-specialise',
]);

/** Niveau exigé par une fonctionnalité — `pro` pour toute clé inconnue (refus par défaut). */
function niveauRequis(feature) {
  return FONCTIONNALITES[feature] || 'pro';
}

// ── État du compte ───────────────────────────────────────────────────────────

/** Fin d'essai dépassée ? */
function essaiExpire(user, maintenant = Date.now()) {
  if (!user || !user.trialEndsAt) return false;
  const fin = Date.parse(user.trialEndsAt);
  return Number.isFinite(fin) && maintenant >= fin;
}

/** Jours d'essai restants (0 si expiré ou hors essai). */
function joursEssaiRestants(user, maintenant = Date.now()) {
  if (!user || !user.trialEndsAt) return 0;
  const fin = Date.parse(user.trialEndsAt);
  if (!Number.isFinite(fin)) return 0;
  return Math.max(0, Math.ceil((fin - maintenant) / 86_400_000));
}

/**
 * Plan réellement appliqué : 'illimite' | 'pro' | 'groupe' | 'trial' | 'free'.
 *
 * La whitelist l'emporte sur tout le reste — c'est le point du cahier des
 * charges : un accès total indépendant du statut d'abonnement.
 */
function planEffectif(user, maintenant = Date.now()) {
  if (!user) return 'free';
  if (user.illimite === true || estEmailIllimite(user.email)) return 'illimite';

  const plan = PLANS.includes(user.plan) ? user.plan : 'trial';

  if (plan === 'pro' || plan === 'groupe') {
    // Un abonnement résilié ou impayé ne vaut plus accès. Stripe reste maître
    // du statut : le webhook écrit `planStatus`, on ne fait que le lire.
    const statut = user.planStatus || 'active';
    if (statut === 'active' || statut === 'trialing') return plan;
    return essaiExpire(user, maintenant) || !user.trialEndsAt ? 'free' : 'trial';
  }

  if (plan === 'trial') return essaiExpire(user, maintenant) ? 'free' : 'trial';
  return 'free';
}

/** Droits associés au plan effectif du compte. */
function droits(user, maintenant = Date.now()) {
  return DROITS[planEffectif(user, maintenant)] || DROITS.free;
}

/** Le compte est-il dispensé de paiement (whitelist) ? */
function estIllimite(user) {
  return planEffectif(user) === 'illimite';
}

/** Le compte est-il sur un abonnement payant actif ? */
function estPayant(user, maintenant = Date.now()) {
  const p = planEffectif(user, maintenant);
  return p === 'pro' || p === 'groupe';
}

// ── Quota de documents ───────────────────────────────────────────────────────

/** Compteur de documents consommés sur la période d'essai. */
function documentsConsommes(user) {
  const n = user && user.usage ? Number(user.usage.documents) : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Reste-t-il du quota ? (toujours vrai pour un plan sans limite) */
function quotaDisponible(user, maintenant = Date.now()) {
  const max = droits(user, maintenant).documents;
  if (max === Infinity) return true;
  return documentsConsommes(user) < max;
}

/**
 * Incrémente le compteur de documents SUR L'OBJET utilisateur passé et le
 * renvoie. La persistance reste à l'appelant (server.js relit et réécrit
 * users.json de façon synchrone pour éviter les écritures concurrentes).
 * Sans effet pour les plans sans limite : inutile de réécrire le fichier à
 * chaque génération d'un compte payant ou admin.
 */
function consommerDocument(user, maintenant = Date.now()) {
  if (droits(user, maintenant).documents === Infinity) return false;
  if (!user.usage || typeof user.usage !== 'object') {
    user.usage = { documents: 0, depuis: new Date(maintenant).toISOString() };
  }
  user.usage.documents = documentsConsommes(user) + 1;
  return true;
}

// ── Décision d'accès ─────────────────────────────────────────────────────────

/**
 * Le compte peut-il utiliser cette fonctionnalité maintenant ?
 * Renvoie `{ ok: true }` ou `{ ok: false, code, message, ... }`, le code
 * servant au front à ouvrir le bon écran (abonnement / quota / essai fini).
 */
function verifierAcces(user, feature, maintenant = Date.now()) {
  const plan = planEffectif(user, maintenant);
  const d    = DROITS[plan] || DROITS.free;
  const need = niveauRequis(feature);
  const nom  = LIBELLES[feature] || 'Cette fonctionnalité';

  if (plan === 'free') {
    return {
      ok: false,
      code: 'trial_expired',
      plan,
      feature,
      message: "Votre période d'essai est terminée. Vos documents restent consultables ; " +
               'passez à Arkiba Pro pour générer à nouveau.',
    };
  }

  if (need === 'pro' && !d.pro) {
    return {
      ok: false,
      code: 'plan_required',
      plan,
      feature,
      message: `${nom} fait partie d'Arkiba Pro. Passez au plan Pro pour y accéder.`,
    };
  }

  if (!d.base && need === 'base') {
    return { ok: false, code: 'plan_required', plan, feature, message: `${nom} nécessite un abonnement actif.` };
  }

  // Le plafond de documents ne s'applique qu'à ce qui consomme du modèle : la
  // gestion des dossiers a son propre plafond, contrôlé à la création.
  if (CONSOMME_QUOTA.has(feature)) {
    if (!quotaDisponible(user, maintenant)) {
      return {
        ok: false,
        code: 'quota_exceeded',
        plan,
        feature,
        limite: d.documents,
        message: `Vous avez atteint les ${d.documents} documents de la période d'essai. ` +
                 'Passez à Arkiba Pro pour continuer sans limite.',
      };
    }
  }

  return { ok: true, plan };
}

/** Le compte peut-il créer un dossier patient de plus ? */
function verifierQuotaPatients(user, nbPatientsActuels, maintenant = Date.now()) {
  const d = droits(user, maintenant);
  if (d.patients === Infinity) return { ok: true };
  if (planEffectif(user, maintenant) === 'free') {
    return {
      ok: false,
      code: 'trial_expired',
      message: "Votre période d'essai est terminée. Vos dossiers restent consultables ; " +
               'passez à Arkiba Pro pour en créer de nouveaux.',
    };
  }
  if (nbPatientsActuels >= d.patients) {
    return {
      ok: false,
      code: 'quota_exceeded',
      limite: d.patients,
      message: `La période d'essai est limitée à ${d.patients} dossiers patients. ` +
               'Passez à Arkiba Pro pour un nombre illimité.',
    };
  }
  return { ok: true };
}

// ── Normalisation / migration ────────────────────────────────────────────────

/**
 * Complète un compte avec les champs d'abonnement s'ils manquent, et
 * resynchronise le drapeau `illimite` avec la whitelist d'emails.
 *
 * Renvoie `true` si l'objet a été modifié — l'appelant sait alors qu'il doit
 * réécrire users.json. Les comptes créés avant l'introduction des plans
 * démarrent leur essai à la date de migration, et non à leur inscription :
 * les inscrits de la bêta ne doivent pas se retrouver bloqués au lancement.
 */
function normaliserCompte(user, maintenant = Date.now()) {
  if (!user) return false;
  let modifie = false;

  if (!PLANS.includes(user.plan)) {
    user.plan = 'trial';
    modifie = true;
  }
  if (!user.trialEndsAt) {
    user.trialEndsAt = new Date(maintenant + DUREE_ESSAI_JOURS * 86_400_000).toISOString();
    modifie = true;
  }
  if (!user.planStatus) {
    user.planStatus = user.plan === 'trial' ? 'trialing' : 'active';
    modifie = true;
  }
  if (!user.usage || typeof user.usage !== 'object') {
    user.usage = { documents: 0, depuis: new Date(maintenant).toISOString() };
    modifie = true;
  }

  // Le drapeau est recalculé à chaque passage : retirer un email de la
  // whitelist doit retirer l'accès illimité, et pas seulement cesser de
  // l'accorder aux nouveaux comptes.
  const doitEtreIllimite = estEmailIllimite(user.email);
  if (Boolean(user.illimite) !== doitEtreIllimite) {
    user.illimite = doitEtreIllimite;
    modifie = true;
  }

  return modifie;
}

/** Champs d'abonnement exposés au front (GET /api/auth/me, /api/billing/state). */
function etatAbonnement(user, maintenant = Date.now()) {
  const plan = planEffectif(user, maintenant);
  const d    = DROITS[plan] || DROITS.free;
  const max  = d.documents;
  const utilises = documentsConsommes(user);

  return {
    plan,
    planStocke: user && user.plan ? user.plan : 'trial',
    statut: (user && user.planStatus) || 'trialing',
    illimite: plan === 'illimite',
    payant: plan === 'pro' || plan === 'groupe',
    essai: {
      actif: plan === 'trial',
      finLe: (user && user.trialEndsAt) || null,
      joursRestants: plan === 'trial' ? joursEssaiRestants(user, maintenant) : 0,
    },
    documents: {
      utilises,
      limite: max === Infinity ? null : max,
      restants: max === Infinity ? null : Math.max(0, max - utilises),
    },
    patients: { limite: d.patients === Infinity ? null : d.patients },
    // Le front s'en sert pour verrouiller les modules : c'est un reflet de la
    // décision serveur, jamais la décision elle-même.
    fonctionnalites: Object.fromEntries(
      Object.keys(FONCTIONNALITES).map(f => [f, verifierAcces(user, f, maintenant).ok])
    ),
    resiliationProgrammee: Boolean(user && user.stripe && user.stripe.cancelAtPeriodEnd),
    finPeriode: (user && user.stripe && user.stripe.currentPeriodEnd) || null,
  };
}

module.exports = {
  PLANS,
  DROITS,
  FONCTIONNALITES,
  CONSOMME_QUOTA,
  LIBELLES,
  DUREE_ESSAI_JOURS,
  QUOTA_DOCUMENTS_ESSAI,
  QUOTA_PATIENTS_ESSAI,
  adminEmails,
  estEmailIllimite,
  niveauRequis,
  planEffectif,
  droits,
  estIllimite,
  estPayant,
  essaiExpire,
  joursEssaiRestants,
  documentsConsommes,
  quotaDisponible,
  consommerDocument,
  verifierAcces,
  verifierQuotaPatients,
  normaliserCompte,
  etatAbonnement,
};
