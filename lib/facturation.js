'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  FACTURATION — adaptateur Stripe
//
//  Tout ce qui parle à Stripe vit ici. Le serveur n'y voit qu'une poignée de
//  fonctions et ne manipule jamais d'objet Stripe brut, ce qui permet de tester
//  les routes de facturation sans clé ni réseau.
//
//  Les clés viennent exclusivement de l'environnement. Sans STRIPE_SECRET_KEY,
//  le module se déclare inactif et les routes répondent 503 : l'application
//  reste utilisable (essai, comptes illimités), seul le paiement est fermé.
// ─────────────────────────────────────────────────────────────────────────────

let clientStripe = null;

/** La facturation est-elle configurée ? */
function stripeActif() {
  return Boolean((process.env.STRIPE_SECRET_KEY || '').trim());
}

/** Client Stripe, instancié à la première utilisation. */
function getStripe() {
  if (!stripeActif()) return null;
  if (!clientStripe) {
    const Stripe = require('stripe');
    clientStripe = new Stripe((process.env.STRIPE_SECRET_KEY || '').trim(), {
      // Fixer la version évite qu'une mise à jour côté Stripe change la forme
      // des objets reçus par les webhooks sans que rien n'ait bougé ici.
      apiVersion: '2025-09-30.clover',
      maxNetworkRetries: 2,
    });
  }
  return clientStripe;
}

/** Réinitialise le client (tests, rotation de clé). */
function resetStripe() { clientStripe = null; }

// ── Correspondance prix ↔ plan ───────────────────────────────────────────────
function prixParPlan() {
  return {
    pro:    (process.env.STRIPE_PRICE_PRO    || '').trim(),
    groupe: (process.env.STRIPE_PRICE_GROUPE || '').trim(),
  };
}

/** Plan correspondant à un identifiant de prix Stripe (`pro` par défaut). */
function planDepuisPrix(priceId) {
  const prix = prixParPlan();
  if (priceId && priceId === prix.groupe) return 'groupe';
  if (priceId && priceId === prix.pro)    return 'pro';
  return 'pro';
}

/** Traduit le statut d'abonnement Stripe en statut interne. */
function statutInterne(statutStripe) {
  switch (statutStripe) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
      return 'incomplete';
    case 'paused':
      return 'paused';
    default:
      return 'canceled';
  }
}

// ── Client Stripe rattaché au médecin ────────────────────────────────────────

/**
 * Retrouve ou crée le client Stripe du médecin.
 * L'identifiant renvoyé doit être persisté sur le compte par l'appelant : sans
 * cela, chaque passage en caisse créerait un client de plus et les webhooks ne
 * retrouveraient plus le compte à mettre à jour.
 */
async function assurerClient(user) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré.');

  const existant = user.stripe && user.stripe.customerId;
  if (existant) {
    try {
      const client = await stripe.customers.retrieve(existant);
      if (client && !client.deleted) return existant;
    } catch (_) {
      // Client supprimé côté Stripe : on en recrée un plutôt que d'échouer.
    }
  }

  const client = await stripe.customers.create({
    email: user.email,
    name: [user.prenom, user.nom].filter(Boolean).join(' ') || undefined,
    metadata: {
      arkibaUserId: String(user.id),
      specialite: user.specialite || '',
      ville: user.ville || '',
    },
  });
  return client.id;
}

/**
 * Session de paiement hébergée par Stripe.
 * `arkibaUserId` est placé en métadonnée de la session ET de l'abonnement :
 * c'est le lien de secours quand un webhook arrive pour un client dont
 * l'identifiant n'a pas encore été écrit sur le compte.
 */
async function creerSessionCheckout({ user, plan, customerId, successUrl, cancelUrl }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré.');

  const price = prixParPlan()[plan];
  if (!price) {
    throw Object.assign(new Error(`Aucun tarif configuré pour le plan « ${plan} ».`), { code: 'price_missing' });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: String(user.id),
    allow_promotion_codes: true,
    metadata: { arkibaUserId: String(user.id), plan },
    subscription_data: {
      metadata: { arkibaUserId: String(user.id), plan },
    },
  });
  return { id: session.id, url: session.url };
}

/** Portail client Stripe : moyen de paiement, factures, résiliation. */
async function creerSessionPortail({ customerId, returnUrl }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré.');
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Vérifie la signature de l'événement. Le corps DOIT être le buffer brut : un
 * corps déjà passé par JSON.parse puis re-sérialisé ne produit pas la même
 * signature, et laisser passer un événement non vérifié reviendrait à laisser
 * n'importe qui offrir un abonnement à n'importe quel compte.
 */
function verifierEvenement(rawBody, signature) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe non configuré.');
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET manquant.'), { code: 'webhook_secret_missing' });
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** Détails d'abonnement utiles, extraits d'un objet subscription Stripe. */
function detailsAbonnement(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const priceId = item && item.price ? item.price.id : null;
  // Stripe a déplacé la fin de période sur l'item d'abonnement ; on lit les
  // deux emplacements pour rester compatible avec les deux formes.
  const fin = sub.current_period_end || (item && item.current_period_end) || null;
  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    plan: (sub.metadata && sub.metadata.plan) || planDepuisPrix(priceId),
    planStatus: statutInterne(sub.status),
    priceId,
    currentPeriodEnd: fin ? new Date(fin * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    arkibaUserId: sub.metadata && sub.metadata.arkibaUserId ? Number(sub.metadata.arkibaUserId) : null,
  };
}

/**
 * Traduit un événement Stripe en instruction de mise à jour du compte, ou
 * `null` si l'événement ne concerne pas l'abonnement.
 *
 * Forme renvoyée : { cible: {customerId, arkibaUserId, email}, maj: {...} }
 * où `maj` est ce qu'il faut appliquer au compte.
 */
async function interpreterEvenement(evenement) {
  const stripe = getStripe();
  const objet  = evenement && evenement.data ? evenement.data.object : null;
  if (!objet) return null;

  switch (evenement.type) {
    // Paiement accepté en caisse : l'abonnement existe, on va lire son état
    // réel plutôt que de le déduire de la session.
    case 'checkout.session.completed': {
      if (objet.mode !== 'subscription' || !objet.subscription) return null;
      const subId = typeof objet.subscription === 'string' ? objet.subscription : objet.subscription.id;
      const sub   = await stripe.subscriptions.retrieve(subId);
      const d     = detailsAbonnement(sub);
      return {
        cible: {
          customerId: d.customerId || (typeof objet.customer === 'string' ? objet.customer : null),
          arkibaUserId: d.arkibaUserId || (objet.client_reference_id ? Number(objet.client_reference_id) : null),
          email: (objet.customer_details && objet.customer_details.email) || null,
        },
        maj: d,
      };
    }

    // Création, changement de formule (upgrade/downgrade), résiliation
    // programmée, reprise : un seul chemin, l'état de l'abonnement fait foi.
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.resumed':
    case 'customer.subscription.paused': {
      const d = detailsAbonnement(objet);
      return { cible: { customerId: d.customerId, arkibaUserId: d.arkibaUserId, email: null }, maj: d };
    }

    // Résiliation effective : retour au plan gratuit.
    case 'customer.subscription.deleted': {
      const d = detailsAbonnement(objet);
      return {
        cible: { customerId: d.customerId, arkibaUserId: d.arkibaUserId, email: null },
        maj: { ...d, plan: 'free', planStatus: 'canceled', cancelAtPeriodEnd: false },
      };
    }

    // Échec de prélèvement : le compte reste marqué impayé, ce qui coupe
    // l'accès payant tant que Stripe n'a pas encaissé.
    case 'invoice.payment_failed': {
      const customerId = typeof objet.customer === 'string' ? objet.customer : null;
      if (!customerId) return null;
      return {
        cible: { customerId, arkibaUserId: null, email: objet.customer_email || null },
        maj: { planStatus: 'past_due' },
      };
    }

    // Encaissement : réactive un compte qui était passé en impayé.
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const customerId = typeof objet.customer === 'string' ? objet.customer : null;
      if (!customerId) return null;
      return {
        cible: { customerId, arkibaUserId: null, email: objet.customer_email || null },
        maj: { planStatus: 'active' },
      };
    }

    default:
      return null;
  }
}

module.exports = {
  stripeActif,
  getStripe,
  resetStripe,
  prixParPlan,
  planDepuisPrix,
  statutInterne,
  assurerClient,
  creerSessionCheckout,
  creerSessionPortail,
  verifierEvenement,
  detailsAbonnement,
  interpreterEvenement,
};
