---
name: arkiba-design
description: Système de design d'Arkiba — identité, tokens, typographie, motion, règles de crédibilité santé et interdits. À charger avant toute modification visuelle de la vitrine (public/index.html, site.css, site.js) ou de l'application médecin, et avant d'écrire la moindre affirmation marketing sur le produit.
---

# Arkiba — système de design

Arkiba est **la couche IA de workflow entre le patient, le médecin et les
logiciels cliniques existants**. Il ne remplace pas le logiciel métier.

Le concept qui tient tout : **« Le dossier attend le médecin, et non l'inverse. »**
Le travail administratif ne disparaît pas, il **change de place** — avant la
consultation au lieu d'après.

Ordre canonique du récit : rendez-vous détecté → appel patient → interrogatoire
structuré → corrections et incertitudes → dossier prêt → **le médecin ouvre, le
dossier est là** → notes brutes pendant la consultation → documents choisis →
transfert coché vers le logiciel métier.

---

## Deux surfaces, deux mondes — ne jamais les confondre

|  | **Vitrine** (`public/index.html`) | **Application** (`public/app.html`) |
|---|---|---|
| Monde | « Papier clinique » — fond papier chaud, encre | « Nuit clinique » — fond sombre |
| Rôle | convaincre, raconter, prouver | faire le travail |
| Liberté | expressive, éditoriale, animée | sobriété, densité, zéro fioriture |
| Fond | `--paper: #f7f5f1` | `--night` (voir `app.css`) |

**La vitrine est en papier parce que l'artefact qu'Arkiba produit est un
document.** Ce n'est pas une inversion gratuite du thème de l'app : c'est le
sujet rendu en matière.

**Une seule section de la vitrine bascule dans l'encre** (`.nuit`) : le moment
où le médecin ouvre Arkiba. C'est l'unique citation du monde de l'application,
et c'est ce qui rend ce moment mémorable. N'en ajoutez pas une deuxième.

⚠️ **Ne jamais toucher à `app.html`, `app.css`, `auth.css` ou au backend depuis
un travail sur la vitrine.** Une autre branche travaille le produit en parallèle.

---

## Couleur — sémantique, jamais décorative

```css
/* Surfaces */
--paper: #f7f5f1;         /* fond ; jamais #fff pur, plus dur que du papier */
--paper-raised: #ffffff;  /* le document, les cartes */
--paper-sunk: #efebe4;    /* bandes de section alternées */
--nuit: #14181d;          /* la section « le moment », uniquement */

/* Encre */
--ink: #16191c;           /* texte principal */
--ink-2: #4a5158;         /* texte secondaire — 7,4:1 sur papier */
--ink-3: #686e77;         /* libellés, méta — 4,7:1. NE PAS éclaircir. */

/* Bleu Arkiba — encre de stylo, pas cyan de dashboard */
--bleu: #1e3a6e;
--bleu-vif: #2b539b;      /* survol */
--bleu-tint: #e9edf5;
```

**Les quatre significations, à respecter partout :**

| Couleur | Signifie | Exemples |
|---|---|---|
| **encre** (`--ink`) | l'humain, le médecin | titres, notes de consultation |
| **bleu** (`--bleu`) | ce qu'Arkiba a préparé, la machine | provenance d'un champ, nœud Arkiba, fil du temps |
| **ambre** (`--ambre: #92601a`) | **incertain, à vérifier** | ligne « À vérifier » d'un dossier |
| **vert** (`--vert: #2f6b4f`) | validé, prêt | « Dossier prêt », statut Disponible |

**L'ambre n'est jamais décoratif.** Il ne sert qu'à dire « Arkiba n'a pas
tranché ». C'est la couleur la plus importante du produit : elle matérialise le
refus d'inventer.

**Contraste : 4,5:1 minimum, y compris pour le mono de 11 px.** `--ink-3` a été
descendu de `#79818a` (3,6:1) à `#686e77` précisément pour ça. Vérifiez avant
d'éclaircir quoi que ce soit.

---

## Typographie

```css
--serif: "Newsreader", "Iowan Old Style", Georgia, serif;  /* titres, chiffres de prix */
--sans:  "Instrument Sans", ui-sans-serif, system-ui;      /* texte, interface */
--mono:  "IBM Plex Mono", ui-monospace, Menlo;             /* libellés, heures, méta */
```

- **Serif pour tout ce qui argumente.** Ce n'est pas un choix décoratif : les
  courriers et comptes rendus médicaux sont composés en serif.
- **Mono pour tout ce qui est machine** : heures, provenances, statuts,
  surtitres. Toujours en capitales, `letter-spacing` de `.1em` à `.13em`,
  taille de `.5625rem` à `.75rem`.
- Titres en `font-weight: 400` — le serif porte l'autorité, pas le gras.
- Italique du serif pour la **seconde moitié** d'un titre : c'est le motif de la
  page (« Le travail ne disparaît pas. *Il change de place.* »). Une phrase
  affirmée, puis son basculement.
- Interlignage : `.98` en display, `1.06` en h2, `1.62` en texte courant.
- **Espaces insécables françaises obligatoires** : `&nbsp;` avant `: ; ? !` et à
  l'intérieur des guillemets `«&nbsp;…&nbsp;»`. Un `»` seul en début de ligne
  est un défaut, pas un détail.

---

## Espacement, rayon, profondeur

```css
--gut: clamp(20px, 4.5vw, 44px);   /* gouttière */
--max: 1240px;                     /* largeur de contenu */
--sect: clamp(84px, 10.5vw, 158px);/* respiration de section */
--r1: 3px;  --r2: 8px;  --r3: 14px;
```

- **Rayons serrés.** Le « tout arrondi » est le marqueur numéro un du gabarit.
  `--r1` pour les boutons et champs, `--r2` pour les cartes, `--r3` réservé au
  document et au formulaire.
- **Profondeur : presque aucune ombre.** La séparation se fait au **filet**
  (`--rule: #e2ddd4`). Une seule élévation existe, `--lift`, réservée à ce qui
  est un document. Les grilles se construisent avec `gap: 1px` sur fond
  `--rule` : les cartes ne flottent pas, elles sont **rangées**.

---

## Motion

**Aucune bibliothèque.** Le site est statique, sans bundler, et la CSP
(`server.js`) imposerait un aller-retour CDN à une page dont le premier atout
est d'arriver vite. Tout tient dans `site.js` : un `IntersectionObserver` et des
transitions CSS.

```css
--e-out: cubic-bezier(.2,.7,.3,1);   /* décélération calme, par défaut */
--e-soft: cubic-bezier(.4,0,.2,1);   /* changements d'état */
--t1: 160ms; --t2: 260ms; --t3: 420ms; --t4: 720ms;
```

- **Une seule primitive de révélation** : `[data-rev]` monte de 14 px en
  s'opacifiant. Le décalage vient de `style="--i:n"` dans le balisage.
- **Le masquage est conditionné à `.js`**, posée par un script en tête de page.
  Sans JavaScript, rien n'est caché. **Aucun contenu ne doit jamais dépendre
  d'une animation pour exister.**
- **Le fil du temps** (`.fil`) : chaque étape franchie encre le segment via
  `--fil` (0 → 1) et livre ses champs au dossier collant d'en face. Position
  discrète par étape, pas de scrub lié au défilement : rien à recalculer à
  chaque image, rien qui saccade sur mobile.
- **`prefers-reduced-motion` coupe tout** et applique les états finaux
  immédiatement. Vérifié : 52/52 éléments visibles, fil complet, respiration
  arrêtée.
- La seule animation en boucle autorisée est `veille` (3,6 s) sur la pastille
  d'attente du dossier. **Le dossier ne palpite pas, il patiente.**

---

## Représenter l'IA et les états cliniques

- **Arkiba ne se représente jamais par un cerveau, une étincelle, un dégradé
  violet ou un halo.** Il se représente par **ce qu'il produit** : un champ
  daté, avec sa provenance (« Déclaré par le patient · 08 h 41 »).
- **Toujours montrer la provenance** à côté d'une information préparée. Une
  donnée sans source est exactement ce qu'Arkiba refuse de produire.
- **Montrer au moins une incertitude** dans toute maquette de dossier. Un
  dossier parfaitement rempli est un mensonge sur le produit.
- **Montrer au moins un échec** dans toute liste (« Appel sans réponse »). La
  transparence sur les ratés est ce qui rend le reste crédible.
- Le document illustratif porte la mention **« Exemple »**, et le patient est
  réduit à des initiales (« M. R., 61 ans »).

---

## Crédibilité santé — règles absolues

Source de vérité : **`PRODUCT.md`**, section *Evidence on Hand*.

**Interdits, sans exception :**

- ❌ Faux témoignages, faux médecins, faux logos clients, faux compteur
  d'utilisateurs. Les quatre témoignages de l'ancienne vitrine étaient inventés
  et ont été **supprimés**.
- ❌ Chiffres non mesurés (« 54 h », « 5 h 30 », « 18 min », « 3 min ») —
  supprimés. **Ne jamais remplacer un faux chiffre par un autre.**
- ❌ « Hébergement HDS certifié » ou équivalent au présent. **La certification
  n'est pas obtenue.** HDS est un prérequis à la mise en production avec de
  vraies données de santé, et doit être présenté comme tel (statut *En cours*).
- ❌ « AES-256 », « TLS 1.3 », « conforme X », « certifié Y » sans vérification
  dans l'architecture réelle. Pas de *security theatre*.
- ❌ Présenter Arkiba comme partenaire officiel de Doctolib, EMED, Weda ou
  Crossway. Le connecteur Doctolib est un **raccordement pilote**.
- ❌ Laisser croire qu'Arkiba diagnostique ou prescrit.
- ❌ Laisser croire qu'Arkiba est validé dans les 46 spécialités. L'anesthésie
  est un **terrain pilote**, pas l'identité du produit.
- ❌ Inventer deux modes « enregistrer la consultation » / « prendre des notes ».
  **Il y a UN champ de notes brutes**, clavier ou micro, les deux ensemble.

**Obligatoire :** la section *État du produit* (`#etat`) distingue quatre
statuts — **Disponible · Pilote · En cours · À venir**. Toute nouvelle
fonctionnalité mentionnée sur la vitrine doit y apparaître avec son statut réel.
La transparence augmente la confiance ; elle ne rend pas la page timide.

---

## Interdits visuels

Kitsch · crypto · cyberpunk · néons médicaux · dégradés violet/bleu « IA » ·
glassmorphism · empilements de cartes arrondies · bento gratuit · **icône dans
un petit carré au-dessus de chaque titre** · collections d'effets Magic UI ·
animation sans fonction · clone de Linear, Framer ou Doctolib · scroll hijacking
· 3D gratuite · particules · blobs · **ligne ECG** · croix médicale animée ·
animations permanentes fatigantes.

La **pilule arrondie en surtitre** au-dessus d'un h1 est le marqueur du gabarit
SaaS : Arkiba utilise un **filet + mono en capitales** (`.hero-kicker`).

---

## Références — principes, jamais copie

Linear (calme, précision, densité maîtrisée) · Attio (information structurée) ·
Stripe (hiérarchie, présentation de systèmes complexes) · Freed et Heidi (la
visite médicale au centre) · Resend (proportions) · Framer (storytelling).

**Étudier pourquoi ces interfaces fonctionnent, ne rien cloner.**

---

## Copie

Français impeccable, court, précis. Parler du travail réel du médecin.
Faire sentir « Arkiba **enlève** du travail », jamais « Arkiba ajoute un outil ».

Bannis : « révolutionnez votre pratique », « la puissance de l'IA »,
« l'avenir de la médecine », « gagnez X heures » sans mesure.

---

## Vérifier avant de livrer

```bash
# Serveur local
ARKIBA_ALLOW_DEV_SECRETS=1 PORT=3111 node server.js

# Non-régression — 321 tests. NE PAS exporter ARKIBA_ALLOW_DEV_SECRETS ici :
# deux tests vérifient précisément que le serveur refuse les secrets par défaut.
npx jest tests/ --forceExit
```

`tests/specialites.test.js` **exige la chaîne `/api/specialites` dans
`index.html`**. Le `<select>` la déclare via `data-source="/api/specialites"` ;
si vous déplacez ce code, l'invariant casse.

Contrôles à repasser : 1440 / 1280 / tablette / 390 px · débordement horizontal
(`scrollWidth === clientWidth`) · cibles tactiles ≥ 44 px · contraste ≥ 4,5:1 ·
`prefers-reduced-motion` · page sans JavaScript · console sans erreur.
