/**
 * ============================================================================
 *  L'ACCÈS ILLIMITÉ DU PROPRIÉTAIRE, VÉRIFIÉ SUR LE DÉPLOIEMENT LUI-MÊME
 * ============================================================================
 *
 * Un banc local prouve que `lib/plans.js` accorde l'accès illimité. Il ne
 * prouve pas que LE DÉPLOIEMENT le fait : c'est l'environnement du serveur qui
 * peut le retirer. `ARKIBA_ADMIN_EMAILS` REMPLAÇAIT la liste des fondateurs au
 * lieu de s'y ajouter — la poser sur ce service, pour ouvrir l'accès à un
 * testeur, aurait donc coupé l'accès du propriétaire, en silence, et
 * `normaliserCompte()` serait allé jusqu'à baisser son drapeau en base.
 *
 * Ce programme tourne DANS le conteneur qui sert arkiba.fr. Il charge le vrai
 * module de plans, avec les vraies variables d'environnement, applique-le à la
 * vraie ligne en base, et rend le verdict.
 *
 * Ce qu'il n'affiche jamais : l'email, le hash du mot de passe, un jeton, un
 * secret. Le compte est désigné par son rang dans la liste des fondateurs.
 * Il n'écrit rien : `normaliserCompte` est appliqué à une COPIE.
 */
import { readFileSync } from 'node:fs';

const plans = await import('/app/lib/plans.js').then((m) => m.default ?? m);

/** Les fondateurs, lus dans le code qui fait foi — jamais recopiés ici. */
const source = readFileSync('/app/lib/plans.js', 'utf8');
const bloc = source.match(/ADMIN_EMAILS_PAR_DEFAUT = \[([\s\S]*?)\]/);
if (!bloc) throw new Error('liste des comptes fondateurs introuvable');
const fondateurs = [...bloc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
if (fondateurs.length === 0) throw new Error('la liste des comptes fondateurs est VIDE');

const chemin = process.env.DATA_DIR ? `${process.env.DATA_DIR}/users.json` : '/data/users.json';
let comptes = [];
try {
  const brut = JSON.parse(readFileSync(chemin, 'utf8'));
  comptes = Array.isArray(brut) ? brut : (brut.users ?? []);
} catch (e) {
  console.log(`base des comptes illisible (${chemin}) : ${e.message}`);
}

const normaliser = (email) => String(email ?? '').trim().toLowerCase();

console.log(`ARKIBA_ADMIN_EMAILS posee sur ce deploiement : ${Boolean(process.env.ARKIBA_ADMIN_EMAILS)}`);
console.log(`comptes fondateurs declares dans le code     : ${fondateurs.length}`);
console.log('');

let echecs = 0;
fondateurs.forEach((email, rang) => {
  const nom = `fondateur #${rang + 1}`;
  const enBase = comptes.find((u) => normaliser(u.email) === normaliser(email));

  // La copie protege la ligne reelle : ce programme observe, il ne repare pas.
  const compte = enBase
    ? JSON.parse(JSON.stringify(enBase))
    : { id: 0, email, createdAt: '2020-01-01T00:00:00.000Z' };
  plans.normaliserCompte(compte);
  const droits = plans.droits(compte);

  const verdicts = {
    'compte present en base': Boolean(enBase),
    'reconnu illimite': plans.estEmailIllimite(email) === true,
    'plan effectif illimite': plans.planEffectif(compte) === 'illimite',
    'documents sans quota': droits.documents === Infinity,
    'patients sans quota': droits.patients === Infinity,
    'module de base ouvert': droits.base === true,
    'module pro ouvert': droits.pro === true,
    'drapeau non baisse': compte.illimite === true,
  };

  console.log(nom);
  for (const [quoi, ok] of Object.entries(verdicts)) {
    if (!ok) echecs += 1;
    console.log(`  ${ok ? 'OK  ' : 'ECHEC'} ${quoi}`);
  }
  console.log('');
});

console.log(echecs === 0 ? 'VERDICT : ACCES ILLIMITE INTACT' : `VERDICT : ${echecs} ECHEC(S)`);
process.exit(echecs === 0 ? 0 : 1);
