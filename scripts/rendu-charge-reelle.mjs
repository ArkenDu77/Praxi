/**
 * ============================================================================
 *  LA VRAIE CHARGE DE PRODUCTION, DANS LE VRAI RENDU
 * ============================================================================
 *
 * Le banc du moteur part d'un dossier produit par le vrai moteur. Le banc de
 * l'ecran part d'une charge ecrite a la main. Chaque moitie est donc testee
 * contre une doublure de l'autre — et c'est exactement la faute qui a coute un
 * appel reel : les deux cotes passaient au vert, et l'ecran etait vide.
 *
 * Ce programme ferme la boucle. Il lit le dossier REEL sur le deploiement, et
 * le passe aux VRAIES fonctions de rendu extraites de app.html.
 *
 * Il n'ecrit rien, ne publie rien, et n'affiche aucune donnee du patient :
 * seulement des comptages et la presence ou l'absence de jargon.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const U = 'https://arkiba-intake-production.up.railway.app';
const T = process.env.ARKIBA_SERVICE_TOKEN ?? '';
const DOSSIER = process.argv[2] ?? 'enc_27a5f490-1fd9-4fac-8b81-074b22a65f94';
const APP = readFileSync('C:/Users/Ken/Desktop/Praxi/public/app.html', 'utf8');

if (!T) {
  console.log('ARKIBA_SERVICE_TOKEN requis');
  process.exit(1);
}

const reponse = await fetch(`${U}/api/encounters/${DOSSIER}`, {
  headers: { 'x-arkiba-service-token': T, 'x-arkiba-tenant': 'org-4' },
});
if (!reponse.ok) {
  console.log(`dossier illisible : HTTP ${reponse.status}`);
  process.exit(1);
}
const charge = await reponse.json();

function extraire(signature) {
  const d = APP.indexOf(signature);
  if (d < 0) throw new Error(`introuvable : ${signature}`);
  const f = APP.indexOf('\n}\n', d);
  return APP.slice(d, f + 3);
}

const peint = {};
const elements = {};
const el = (id) => {
  if (!elements[id]) {
    elements[id] = {
      set innerHTML(v) { peint[id] = v; },
      get innerHTML() { return peint[id]; },
      set hidden(v) { peint[`${id}-hidden`] = v; },
      get hidden() { return peint[`${id}-hidden`]; },
      textContent: '',
    };
  }
  return elements[id];
};

const bac = { document: { getElementById: el }, pcEncounter: charge, console };
vm.createContext(bac);
for (const sig of [
  'function pcEchappe(',
  'function pcFaits(',
  'function pcValeur(',
  'function pcLigneFait(',
  'function pcLigneListe(',
  'function pcRendreIntake()',
  'function pcRendreAVerifier()',
]) {
  vm.runInContext(extraire(sig), bac);
}
vm.runInContext('pcRendreIntake(); pcRendreAVerifier();', bac);

const intake = peint['pc-intake'] ?? '';
const alertes = peint['pc-alerts'] ?? '';
const texte = (h) =>
  String(h)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

const lisible = texte(intake + alertes);

// Combien de faits la charge portait-elle, et combien sont peints ?
let porteurs = 0;
const marcher = (n, chemin) => {
  if (n === null || typeof n !== 'object' || Array.isArray(n)) return;
  if ('value' in n && 'confidence' in n) {
    if (n.value !== null && n.value !== undefined) porteurs += 1;
    return;
  }
  for (const k of Object.keys(n)) marcher(n[k], chemin ? `${chemin}.${k}` : k);
};
marcher(charge.clinical_data, '');

const lignes = (intake.match(/class="pc-item"/g) ?? []).length;
const boutons = (intake.match(/class="pc-corriger"/g) ?? []).length;
const sections = (intake.match(/class="pc-section"/g) ?? []).length;

const JARGON = [
  'transcript_review',
  'substance_use',
  'chronic_conditions',
  'anesthesia_history',
  'functional_capacity',
  'cardiovascular.',
  'appointment.procedure',
  'editable_path',
];
const fuites = JARGON.filter((j) => lisible.includes(j));

console.log(`faits porteurs de valeur dans la charge : ${porteurs}`);
console.log(`lignes peintes                          : ${lignes}`);
console.log(`sections peintes                        : ${sections}`);
console.log(`corrections offertes                    : ${boutons}`);
console.log(`points « a verifier » peints            : ${(alertes.match(/class="pc-item"/g) ?? []).length}`);
console.log(`jargon visible par le medecin           : ${fuites.length === 0 ? 'aucun' : fuites.join(', ')}`);

const echecs = [];
if (lignes < porteurs) echecs.push(`${porteurs - lignes} fait(s) porteur(s) non peint(s)`);
if (boutons === 0) echecs.push('aucune correction offerte');
if (fuites.length > 0) echecs.push('du jargon atteint le medecin');
if (sections === 0) echecs.push('aucune section');

console.log('');
console.log(echecs.length === 0 ? 'VERDICT : LA CHARGE REELLE SE PEINT ENTIEREMENT' : `VERDICT : ${echecs.join(' | ')}`);
process.exit(echecs.length === 0 ? 0 : 1);
