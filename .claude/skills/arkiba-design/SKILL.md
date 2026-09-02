---
name: arkiba-design
description: Système de design de la vitrine Arkiba, direction « Signal » — identité, tokens, typographie, motion GSAP, règles de vérité produit et interdits. À charger avant toute modification visuelle ou rédactionnelle de public/index.html, site.css, site.js.
---

# Arkiba — système de design de la vitrine

Arkiba est **la couche IA de workflow entre le patient, le médecin et les
logiciels cliniques existants**. Il ne remplace pas le logiciel métier.

Concept central : **« Le dossier attend le médecin, et non l'inverse. »**
Le travail administratif ne disparaît pas, il **change de place**, avant la
consultation au lieu d'après.

Récit canonique, dans cet ordre : rendez-vous détecté, appel patient,
interrogatoire structuré, points à vérifier, dossier prêt, **le médecin ouvre
et le dossier est là**, notes brutes pendant la consultation, documents,
transfert coché vers le logiciel.

---

## Direction « Signal »

Fond quasi noir, typographie énorme, composition très aérée.

**Le parti pris qui tient tout : le site est monochrome. La couleur n'existe
que là où le produit porte un état clinique.** Vert quand un dossier est prêt,
ambre quand une information reste à vérifier. Nulle part ailleurs. C'est ce qui
donne son poids à l'ambre du champ « À vérifier » : c'est la seule couleur
chaude de toute la page, et elle dit qu'Arkiba n'a pas tranché.

Ajouter une troisième couleur, ou utiliser le vert comme accent décoratif,
détruit ce système. Ne le faites pas.

⚠️ Une direction « papier clinique » (fond crème, serif Newsreader) a existé et
**a été rejetée** : trop sage, trop éditoriale, trop institutionnelle. Ne la
ressuscitez pas.

---

## Tokens

```css
/* Fonds : trois profondeurs, jamais de noir pur */
--bg: #08090b;  --bg-2: #0c0e11;  --surf: #101317;  --surf-2: #161a1f;
--line: #1e232a;  --line-2: #2b323b;

/* Texte */
--tx: #f7f8f8;  --tx-2: #9ba3ad;  --tx-3: #6f7883;

/* Les deux seules couleurs du site */
--pret:  #6ee7a8;   /* prêt, validé, système actif */
--verif: #f5b963;   /* à vérifier, incertain */
```

Rayons `8 / 14 / 20`. Une seule élévation, réservée aux surfaces produit :
`inset 0 1px 0 rgba(255,255,255,.055)` plus une ombre portée très diffuse. Le
**liseré clair en haut** est le détail qui fait qu'une carte sombre a l'air
fabriquée plutôt que dessinée : ne l'enlevez pas.

Une seule source lumineuse dans toute la page, la lueur radiale derrière le
héros (`.hero::before`). Elle a besoin de `overflow: clip` sur `.hero`, sinon
elle allonge la page de sa propre largeur en silence.

---

## Typographie

```css
--sans: "Schibsted Grotesk", ui-sans-serif, system-ui;  /* tout */
--mono: "IBM Plex Mono", ui-monospace, Menlo;           /* rare, voir plus bas */
```

**Schibsted Grotesk** a été choisie après comparaison à l'écran, à 76 px, face
à Manrope, Onest, Sora et Figtree. Elle a l'autorité et les apertures les plus
serrées, sans le côté constructiviste de Sora ni la douceur de Manrope.

- Titres : `font-weight: 600`, `letter-spacing: -.035em` à `-.042em`,
  interlignage `.95` en display.
- `.xl` pour le héros, `.lg` pour les titres de section, et **le `max-width`
  d'un titre se pose sur le titre lui-même**, jamais sur son conteneur : un
  `max-width` en `ch` sur un conteneur de 17 px donne une colonne de 190 px
  pour un titre de 62 px. C'est un bug qui a été commis, corrigé, et qui
  reviendra si on l'oublie.
- **Le mono est rare.** Il ne sort d'une surface produit que pour le surtitre
  de section (`.eyebrow`), une fois par section, jamais deux.
- Second membre du titre en `.dim` (gris) : c'est le motif de la page, une
  phrase affirmée puis son basculement.
- Espaces insécables françaises : `&nbsp;` avant `: ; ? !` et dans les
  guillemets `«&nbsp;…&nbsp;»`.

**Fontes bannies** : Inter, Roboto, Geist, Plus Jakarta Sans, Space Grotesk,
Fraunces, Instrument Sans, Newsreader. Associées à un titrage, elles produisent
la page « landing générée » que le projet refuse.

---

## Motion

Trois niveaux, un outil par niveau :

| Niveau | Quoi | Outil |
|---|---|---|
| **Micro** | survols, focus, états | CSS |
| **Produit** | entrée du héros, apparition des blocs | GSAP, repli CSS |
| **Récit** | la séquence épinglée du système | GSAP + ScrollTrigger |

GSAP vient de **cdnjs**, déjà autorisé par la CSP de `server.js` : aucun
changement serveur n'est nécessaire. S'il ne charge pas, `demarrerRepli()`
prend la main et la page s'anime en CSS. Sans JavaScript, `.js` n'est jamais
posée et **rien n'est masqué**.

**Règles non négociables :**

- **Jamais `autoAlpha` pour révéler du contenu.** Il pose `visibility: hidden`,
  ce qui retire le texte de l'arbre d'accessibilité. Utilisez `opacity`.
  `autoAlpha` reste correct pour les couches empilées de la scène, où masquer
  aux technologies d'assistance est voulu.
- **Jamais d'animation de `width`, `height`, `padding`, `margin`.** Pour une
  hauteur, `grid-template-rows: 0fr → 1fr` (le menu mobile) ou `scaleY`.
- `prefers-reduced-motion` bascule la section en mode `.plat` : pas
  d'épinglage, tout visible, respiration coupée. Idem sous 940 px, où une scène
  épinglée volerait le défilement sans rien apporter.
- Une seule animation en boucle : la pastille « En attente du médecin ».
  **Le dossier ne palpite pas, il patiente.**

### La séquence épinglée

C'est la signature du site. Six étapes, scène épinglée, `scrub`. Les couches
sont toutes empilées au même endroit et le récit les traverse.

Le moment qui compte est le **passage des fragments de l'appel aux champs du
dossier** : chaque `.frag` se déplace vers son `.champ[data-df]` correspondant.
Le déplacement est **mesuré à l'exécution** (`getBoundingClientRect`) via des
valeurs fonctionnelles GSAP et `invalidateOnRefresh: true`, donc il survit au
redimensionnement et au chargement des polices (d'où le `ScrollTrigger.refresh()`
sur `document.fonts.ready`).

Le quatrième emplacement du dossier apparaît **vide mais habité**, portant
« Relecture en cours », avant que l'ambre s'allume à l'étape 4. Un emplacement
réellement vide se lirait comme un défaut d'affichage.

---

## Représenter l'IA et les états cliniques

- **Jamais de cerveau, d'étincelle, de halo ni de dégradé « IA ».** Arkiba se
  représente par **ce qu'il produit** : un champ daté dans une surface produit.
- **Montrer au moins une incertitude** dans toute maquette de dossier. Un
  dossier parfaitement rempli est un mensonge sur le produit.
- **Montrer au moins un cas qui ne marche pas** dans toute liste (« À
  rappeler »). C'est ce qui rend le reste crédible.
- Le patient illustratif est réduit à des initiales, avec la mention
  « Exemple ».

---

## Vérité produit et ton

Source : **`PRODUCT.md`**. La règle a été précisée par le client :

> **Ne jamais mentir n'est pas la même chose qu'énumérer publiquement tout ce
> qui n'est pas terminé.**

Si une capacité n'est pas prête et qu'il n'est pas nécessaire de la mentionner,
**ne la mentionnez pas**. La homepage vend Arkiba, elle ne rédige pas sa propre
due diligence.

**Interdit sur la vitrine :**

- ❌ Témoignages, médecins, logos clients ou compteurs d'utilisateurs inventés.
- ❌ Chiffres non mesurés. Ne jamais remplacer un faux chiffre par un autre.
- ❌ Affirmer HDS au présent. **Et ne pas non plus en faire un argument
  négatif** : pas de « certification non obtenue » sur la homepage. Le sujet
  vit dans les pages légales.
- ❌ Une section « État du produit » listant Disponible / Pilote / En cours /
  À venir. Elle a existé, elle a été **supprimée** : cela ressemblait à des
  tickets Jira publiés.
- ❌ Paragraphes défensifs : « n'est pas partenaire officiel », « aucun
  raccordement livré à ce jour », « refuse de répondre plutôt que d'inventer ».
- ❌ Lister EMED, Weda, Crossway si aucun raccordement n'existe.
- ❌ Laisser croire qu'Arkiba diagnostique ou prescrit.
- ❌ Inventer deux modes « enregistrer » et « prendre des notes ». **Il y a UN
  champ de notes brutes**, clavier ou micro, les deux ensemble.

**Formulations discrètes acceptées** : « Connexion agenda en pilote privé ».

**Règle typographique absolue : aucun tiret cadratin `—` dans le texte visible**,
titre de page et métadonnées comprises. Phrase séparée, virgule, deux-points,
ou parenthèses.

Ton : court, simple, confiant. Pas arrogant, pas défensif. Une section porte
**une** idée : grand statement, visualisation, une ou deux phrases.

Bannis : « révolutionnez votre pratique », « la puissance de l'IA »,
« l'avenir de la médecine », « gagnez X heures ».

---

## Interdits visuels

Kitsch · crypto · cyberpunk · néons médicaux · dégradés violet/bleu « IA » ·
glassmorphism · empilements de cartes arrondies · bento gratuit · **icône dans
un petit carré au-dessus de chaque titre** · **pilule arrondie en surtitre** ·
effets Magic UI · animation sans fonction · clone de Linear, Framer ou Doctolib
· scroll hijacking · 3D gratuite · particules · blobs · **ligne ECG** · croix
médicale animée · fausse fenêtre macOS à trois pastilles.

**Références, pour les principes seulement** : Linear (calme, densité
maîtrisée, titre énorme puis grande surface produit), Ramp (titre gigantesque,
une ligne, un CTA), Attio, Stripe, Resend, Framer. **Ne cloner aucune.**

---

## Vérifier avant de livrer

```bash
ARKIBA_ALLOW_DEV_SECRETS=1 PORT=3111 node server.js

# 321 tests. NE PAS exporter ARKIBA_ALLOW_DEV_SECRETS ici : deux tests
# vérifient précisément que le serveur refuse les secrets par défaut.
npx jest tests/ --forceExit
```

`tests/specialites.test.js` **exige la chaîne `/api/specialites` dans
`index.html`** : le `<select>` la déclare via `data-source`. Si vous déplacez ce
code, l'invariant casse.

À repasser au navigateur : 1440 / 1280 / 834 / 390 px · `scrollWidth ===
clientWidth` · cibles tactiles ≥ 44 px · `prefers-reduced-motion` · GSAP bloqué
· page sans JavaScript · console sans erreur · aucun `—` dans le texte visible.

**Note pour les captures automatisées :** en navigateur sans interface, rAF est
fortement ralenti et les animations GSAP paraissent figées à mi-course. Prenez
plusieurs captures successives (chacune force une peinture) avant la capture
utile, sinon vous critiquerez une image qui n'existe pour personne.

---

## Périmètre

⚠️ **Ne jamais toucher** à `public/app.html`, `app.css`, `auth.css`,
`server.js`, au backend, à l'authentification, à Intake, Doctolib, EMED ou à
l'infrastructure. Une autre branche travaille le produit en parallèle.
