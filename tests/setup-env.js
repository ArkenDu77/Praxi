/**
 * ============================================================================
 *  LA SUITE DE TESTS NE DOIT PAS POUVOIR DEPENSER
 * ============================================================================
 *
 * `server.js` appelle `require('dotenv').config()` a sa premiere ligne. Le
 * .env de ce poste porte une VRAIE cle Anthropic — donc chaque execution de la
 * suite partait reellement chez le fournisseur.
 *
 * Une dizaine de tests d'abonnement postent sur /api/generate/* pour verifier
 * le CONTROLE D'ACCES : ils affirment `status !== 402`, jamais le contenu
 * genere. Ils n'ont aucun besoin du modele — mais ils attendaient sa reponse,
 * ce qui rendait la suite lente, dependante du reseau, et payante.
 *
 * C'est la meme classe d'incident que les appels telephoniques reellement
 * composes par la suite de arkiba-intake : un .env de developpement charge
 * dans un contexte de test, et une route qui va jusqu'au bout.
 *
 * On retient donc la cle ici. Chaine VIDE et non `delete` : `dotenv` ne
 * remplace pas une variable deja definie, mais il REMPLIT une variable
 * absente — un `delete` serait annule une ligne plus loin.
 *
 * Les assertions ne perdent rien : sans cle, `generateDocument` leve 503, et
 * 503 satisfait aussi bien `not.toBe(402)` que `[200, 503]`.
 *
 * Un test qui voudrait exercer le VRAI modele doit le dire explicitement en
 * reglant PRAXI_TEST_LLM=real — et sait alors qu'il depense.
 */
const CLES_RETENUES = [
  'ANTHROPIC_API_KEY',
  // Meme raison, un fournisseur plus loin. Ce .env ne les porte pas
  // aujourd'hui, donc la suite est inerte PAR ACCIDENT. Le jour ou quelqu'un
  // les ajoute pour une recette, les tests de facturation parleraient au vrai
  // Stripe. On ferme la CLASSE, pas le cas.
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

if (process.env.PRAXI_TEST_LLM !== 'real') {
  for (const cle of CLES_RETENUES) process.env[cle] = '';
}
