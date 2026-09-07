---
name: arkiba-design
description: Système de design de la vitrine Arkiba, direction « Papier et nuit » — identité, tokens, typographie, motion GSAP, règles de vérité produit et interdits. À charger avant toute modification visuelle ou rédactionnelle de public/index.html, site.css, site.js.
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

---

## Structure de la vitrine

La page suit le rythme d une vitrine de plateforme, pas d une page produit.
Treize sections, dans cet ordre :

heros · parcours · declaration · systeme (sequence epinglee) · plateforme ·
dossier · comparaison · consultation · transfert · verifier · questions ·
tarifs · acces

**Trois leviers portent le sentiment d etendue.** Ils viennent d une etude
reelle de metaforma.io ; la direction artistique, elle, n en vient pas.

1. **La rangee de modules** (`#plateforme`). Dix puces lisibles d un coup, et
   un panneau qui se transforme au clic, avec sa mini-interface. C est le
   nombre de puces visibles simultanement qui donne la mesure : une grille de
   dix cartes de fonctionnalites dirait la meme chose et se lirait comme un
   catalogue. Les dix modules sont reels : ne jamais en ajouter un qui
   n existe pas dans l application.

2. **La comparaison** (`#comparaison`). La forme porte l argument : a gauche
   des etapes coupees par des ruptures en ambre, a droite une chaine unique
   reliee par un fil vert continu. **Aucun chiffre**, aucune duree, aucune
   statistique : nous n en avons pas de mesuree.

3. **Le bandeau de parcours** (`#parcours`). Neuf jalons sur une ligne qui
   s allument dans l ordre de la chaine. Il dit en un ecran ce que la page
   detaille ensuite.

**A la place de la preuve sociale** (`#verifier`) : « Pas de temoignages. Des
faits verifiables. » Quatre choses qu un visiteur peut controler lui-meme.
C est la reponse durable a l absence de preuve : on ne fabrique jamais un
temoignage, on donne du verifiable.

## Livraison de la preview

GSAP, ScrollTrigger et Flip sont servis depuis `public/vendor/`, pas depuis un
CDN. `package.json` ne porte pas la dependance : les fichiers ont ete copies
puis le paquet desinstalle.

**Piege verifie en conditions reelles :** le port 3002 de cette machine sert le
depot principal `Praxi`, pas ce worktree. Avant de conclure qu une modification
n apparait pas, verifier QUEL serveur repond.

**Windows demande la reduction des animations sur ce poste**
(`SPI_GETCLIENTAREAANIMATION = 0`). Chrome le traduit fidelement en
`prefers-reduced-motion: reduce` et la page bascule a plat, ce qui est le
comportement correct. Pour montrer la version animee sans toucher au reglage
systeme, lancer Chrome avec `--force-prefers-no-reduced-motion`. Ne jamais
supprimer le respect de ce reglage dans le code sans accord explicite.


---

## V2 — direction « Papier et nuit » (remplace « Signal »)

« Signal » posait un fond quasi noir sur toute la page. Mesuré contre les
références réelles (Sully, Clay, Attio, Lovable, Metaforma), cinq sur six sont
claires et n'utilisent le sombre que comme **surface produit**. Le sombre
partout lisait « prototype ». La direction s'inverse donc :

**Fond clair. Le sombre n'est plus l'ambiance, c'est l'objet.** Partout où une
interface d'Arkiba est montrée, elle est sombre, posée sur le papier. Le
contraste fait exister le produit comme une chose, au lieu d'une page qui en
parle.

### Jetons

```
--pap #f6f7f8  --pap-2 #ffffff  --pap-3 #eef0f2
--enc #0b0d10  --enc-2 #59616b  --enc-3 #6b737d
--fil #dfe3e7  --fil-2 #cfd5db
--nuit #141820  --nuit-2 #0d1015  --nuit-l #232935  --nuit-l2 #2e3543
--nuit-t #8b95a3  --nuit-x #f4f6f8
--vert #0f9d63 (action)  --vert-c #6ee7a8 (sur nuit)  --verif #f5b963
```

La règle de couleur ne change pas : **vert et ambre n'existent que là où le
produit porte un état clinique.** L'ambre reste le seul signal chaud de la
page, et il dit qu'Arkiba n'a pas tranché.

### Typographie

- Display : **Bricolage Grotesque**, axe `opsz`, graisse 600.
- UI et corps : **Archivo**, 400 / 500 / 600.
- Micro-étiquettes rares : **IBM Plex Mono**, 9 à 10 px, capitales, .13em.

Schibsted Grotesk est écartée : elle ne signe rien. Manrope lit « SaaS
générique ». Les quatre couples ont été comparés au rendu réel, pas sur
spécimen.

### La photographie

Trois images générées, retravaillées à ffmpeg, servies depuis `/media/` :
cabinet vide au matin (héros), pile de dossiers du soir et bureau rangé du
matin (la comparaison), plus une texture de papier pour le grain des cartes
nuit. Zéro médecin de banque d'images, zéro cabinet cliché. **Toute interface
montrée comme étant Arkiba reste construite en HTML et CSS.**

Le voile posé sur une photographie ne doit jamais dépasser ~.7 au milieu :
au-delà, le sujet disparaît et il ne reste qu'un rectangle sombre.

### Le refus, montré plutôt que déclaré

La section `#refus` est le seul argument qu'un concurrent ne peut pas copier en
le disant : une source unique, cinq registres séparés, et la source qui
s'allume à l'endroit exact d'où vient chaque élément. Le registre
« manquantes » n'allume rien — c'est la démonstration, pas un bug.

### Pièges payés dans cette passe

- `.nav-mob a` visait aussi les boutons du bas et repeignait leur libellé en
  encre sur encre. Une règle de lien de menu se scope au conteneur direct.
- Un méga-menu ancré à son bouton (`left:50%` sur 85 px) sort de l'écran. Il
  s'ancre à la barre.
- Au pointeur fin, le survol a déjà ouvert le menu quand le clic arrive : un
  bouton qui bascule le referme sous le curseur. Le clic n'ouvre que.
- Un `<em>` de surlignage avec un remplissage horizontal repousse la
  ponctuation qui suit. Reprendre en marge négative.
- Les déclencheurs de modale sont des liens vers `#acces`, pas des boutons :
  sans JavaScript ils mènent quand même quelque part.
- Les captures en navigateur sans tête n'avancent GSAP qu'à chaque peinture.
  Compter ~45 captures jetables avant la capture utile, sinon on photographie
  une animation à mi-course et on « corrige » un défaut qui n'existe pas.


---

## V3 — le film, la démonstration jouable, le curseur

La direction « Papier et nuit » ne change pas. Elle gagne trois pièces.

### Les films

Trois plans muets en boucle, générés chez Higgsfield (`kling2_6`, 5 s, 5 crédits
pièce) **depuis les photographies du site comme image de départ**. Partir de la
plaque existante est ce qui garantit que le film reste dans la palette et
n'invente aucune interface : le modèle anime une pièce que nous avons déjà
choisie, il ne la réinvente pas.

- héros : le cabinet à l'aube, seule la lumière bouge · WebM 49 ko
- « sans Arkiba » : la pile de dossiers du soir sous la lampe · WebM 20 ko
- « avec Arkiba » : le bureau rangé du matin · WebM 23 ko

**Fermer la boucle : fondu croisé, et mesurer la couture.** La queue se fond sur
la tête pendant 0,8 s :

```
[0:v]split[a][b];
[a]trim=0:1.6,setpts=PTS-STARTPTS[tete];
[b]trim=1.6:D,setpts=PTS-STARTPTS[corps];
[corps][tete]xfade=transition=fade:duration=0.8:offset=(D-1.6)-0.8
```

**La tête doit être plus longue que le fondu.** Avec `tete = 0.8` et un fondu de
0,8 s, le fondu n'est jamais terminé quand la dernière image sort : la couture
mesurait 33,8 dB contre 47,2 dB pour un écart normal entre deux images. Avec une
tête de 1,6 s, le fondu se termine bien avant la fin et la couture remonte à
42,9 dB.

**Vérifier la couture, ne pas la croire.** Extraire la première et la dernière
image, puis `ffmpeg -i a.png -i z.png -lavfi psnr -f null -`. Comparer au PSNR
de deux images consécutives du milieu : si l'écart est inférieur à 5 dB, la
boucle est invisible.

`reverse` garde toutes les images en mémoire et fait tomber cette machine.
`zoompan` sur une image fixe produit `d` images **par image d'entrée** : avec
`-loop 1 -t 6` on obtient 150 × 150 images et une vidéo de quinze minutes ; la
forme juste est une seule image en entrée et `-frames:v` en sortie.

**Un seul observateur pilote les trois films.** Aucun ne charge son premier octet
avant d'entrer à l'écran, aucun ne décode hors champ. `play()` suffit à
déclencher le chargement d'un `preload="none"` : réassigner `preload` puis
rappeler `load()` annule la requête déjà partie et la laisse en échec dans le
panneau réseau.

Le film porte l'atmosphère, jamais l'interface. **Toute surface Arkiba montrée
reste construite en HTML et CSS**, et les trois jetons de données posés sur le
film font le pont : ils sortent de la pièce filmée, puis s'effacent quand la
carte produit a pris le relais. Sans ce pont, il y aurait une vidéo à gauche et
un tableau de bord à droite, ce qui n'est pas une composition.

### La démonstration jouable

Douze étapes, six vues, un halo, un pointeur et une bande de commentaire. Le
visiteur avance lui-même ; la lecture automatique s'arrête au premier geste et
ne démarre jamais sous mouvement réduit.

Le commentaire est **une bande sous la scène, pas une bulle flottante** : posée
près de sa cible, elle finissait toujours par recouvrir une ligne du dossier,
quelle que soit la logique de placement.

Le halo se mesure dans le repère du cadre, et seulement après deux `rAF` quand
la vue vient de changer : une vue qui vient d'apparaître n'a pas encore ses
dimensions, et le halo se pose alors sur une boîte vide.

### Le curseur

Un point qui suit exactement, un anneau qui rattrape 18 % de la distance par
image. `cursor: none` n'est posé que par `html.cur`, une classe ajoutée en
JavaScript **après** que le curseur a démarré : si le script échoue, le curseur
natif reste. Jamais au doigt, jamais sous mouvement réduit, jamais d'événement
reçu.

### Règles de langue confirmées en V3

- **« sans carte bancaire » est banni de la vitrine.** La formule fait petit
  SaaS en libre-service. « Quinze jours d'accès complet » dit la même chose.
- L'appel principal est **« Demander une démonstration »** partout, y compris
  dans le bloc final. « Ouvrir un accès » est le chemin secondaire.
- La mention « Arkiba n'établit aucun diagnostic » vit dans le panneau
  « Le médecin garde la main », pas sous le premier bouton de la page. La page
  vend le produit avant de se défendre, sans rien cacher.
- **Trois dossiers fictifs récurrents**, jamais un seul : Mme Martin porte le
  parcours préopératoire, M. Bernard le suivi, Mme Leroy les documents. Un même
  motif clinique répété dix fois donne l'impression d'une seule capture d'écran
  déclinée.

### Pièges payés dans cette passe

- Un élément flex sans `min-width: 0` se dimensionne sur son contenu : la carte
  de la démonstration débordait du cadre au téléphone.
- La barre collante se rétracte sur `#acces` ; un test qui clique son bouton à
  cet endroit attend un élément hors de l'écran.
- Les captures en navigateur sans tête n'avancent GSAP qu'à chaque peinture :
  compter environ 45 captures jetables avant la capture utile, sinon on
  photographie une animation à mi-course.

- Une classe utilitaire courte finit par entrer en collision. `.fin` désignait à
  la fois la carte d'appel finale et la mention alignée à droite du pied du champ
  de notes : cette dernière héritait d'une grille, d'un fond nuit et de 64 px de
  remplissage, et s'affichait en panneau sombre au fond du champ.
- Le héros repasse sur une colonne dès 1279 px. En deux colonnes en dessous, la
  colonne de texte devient trop étroite pour aligner les deux appels à l'action,
  et la carte produit recouvre jusqu'aux trois quarts du film.
- Auditer la copie sur `innerText`, jamais sur la source. Un « sans carte
  bancaire » coupé par un retour à la ligne échappe à toute recherche naïve dans
  le balisage et reste parfaitement lisible à l'écran.
