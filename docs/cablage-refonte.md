# Contrat de câblage — vitrine et application

Deux surfaces, un même contrat : **chaque bouton et chaque champ doit
déclencher une action réelle**. La partie I couvre l'application
(`public/app.html`), la partie II la vitrine (`public/index.html`).

La vérification est identique des deux côtés : un harnais pilote la page dans
un vrai navigateur et observe le trafic réseau et la navigation. Un contrôle
qui ne produit ni appel ni navigation est un bouton mort.

| Surface | Contrôles vérifiés | Résultat |
|---|---|---|
| Application | 64 | 64/64 |
| Vitrine | 31 | 31/31 — un constat connu signalé, voir partie II |

---

# Partie I — Application

Le style de la vitrine (« nuit clinique » : encre nocturne, lumière glaciaire,
or de confiance, typographie serif éditoriale) est transposé sur l'application
existante. **Le framework, le balisage et la logique métier ne changent pas** :
pseudonymisation, analyse clinique, génération PDF, autosave, dictée et
provenance des sources restent exactement le code qui tourne aujourd'hui.

Ce document est le contrat de non-régression. **Chaque ligne est un élément
interactif de l'application.** Un élément qui cesse de déclencher son action
après la passe de style est une fonctionnalité perdue, pas un choix de design.

Statut : ✅ vérifié automatiquement · ☑️ vérifié à l'œil · ➖ purement local
(aucun appel serveur attendu)

La vérification automatique pilote l'interface réelle dans un navigateur et
observe le trafic réseau : un contrôle qui ne produit pas l'appel attendu est
un bouton mort. **64 vérifications, 64 passées.** La suite de tests reste à
236 tests au vert.

---

## Conventions relevées sur le serveur en fonctionnement

| Point | Contrat |
|---|---|
| Jeton | `localStorage['praxi_token']`, en-tête `Authorization: Bearer …` |
| Profil local | `localStorage['praxi_profil']` — alimente l'en-tête des documents |
| Erreurs | Toujours JSON `{ error: "…" }`, y compris en 404 sous `/api` |
| 429 | Inscription 5/h/IP, connexion 10/h/IP |
| 503 | `Service IA non configuré` — n'est pas une erreur de saisie du médecin |
| Spécialités | 46 libellés servis par `GET /api/specialites`, **jamais en dur** |
| Thème | « Nuit clinique » par défaut ; `praxi_theme = 'light'` pour en sortir |

---

## 1. Connexion

| Contrôle | Action réelle | Statut |
|---|---|---|
| Email professionnel, Mot de passe | saisie, `trim()` avant envoi | ✅ |
| « Se connecter » | `POST /api/auth/login` → jeton + profil → `/app.html` | ✅ |
| Bandeau succès post-inscription | affiché sur `?registered=1` | ✅ |
| Bandeau d'erreur | message serveur affiché tel quel | ✅ |
| « Créer un compte » · « Mot de passe oublié ? » · « Retour à l'accueil » | navigation | ➖ |
| Redirection si déjà connecté | jeton présent → `/app.html` | ☑️ |

## 2. Création de compte

| Contrôle | Action réelle | Statut |
|---|---|---|
| Prénom · Nom · Email · Ville · Mot de passe · RPPS | saisie | ✅ |
| **Spécialité(s)** | 46 options chargées par `GET /api/specialites` | ✅ |
| — sélection multiple | le menu s'ouvre, coche, referme ; envoi en `specialites[]` | ✅ |
| « Créer mon compte » | `POST /api/auth/register` → `/login.html?registered=1` | ✅ |
| Bandeau d'erreur | erreurs serveur concaténées, 409, 429 | ☑️ |

`tests/specialites.test.js` refuse toute liste en dur (`const SPECIALITES = [`)
dans `register.html`, `index.html` et `app.html`, et exige `/api/specialites`.

## 3. Mot de passe oublié / réinitialisation

| Contrôle | Action réelle | Statut |
|---|---|---|
| Email + « Envoyer le lien » | `POST /api/auth/forgot-password` | ☑️ |
| Nouveau mot de passe + « Réinitialiser » | `POST /api/auth/reset-password` | ☑️ |

## 4. Coquille applicative

| Contrôle | Action réelle | Statut |
|---|---|---|
| Bloc utilisateur | profil local ; clic → écran Profil | ☑️ |
| 12 entrées de navigation | ouvrent leur écran | ✅ |
| Compteur « Historique » | nombre réel de documents | ✅ |
| Bascule de thème | nuit ↔ clair, persistée | ✅ |
| « Déconnexion » | purge jeton, profil et brouillons → `/` | ☑️ |
| Hamburger + voile (tablette) | ouverture/fermeture de la barre latérale | ☑️ |
| Pastille d'autosave | « Enregistrement… » → « Enregistré à l'instant » | ✅ |
| Réglages Longueur / Mon style | transmis au payload de génération | ☑️ |

## 5. Parcours Nouvelle consultation

| Contrôle | Action réelle | Statut |
|---|---|---|
| Sélecteur de dossier | peuplé par `GET /api/patients` | ✅ |
| Stepper 3 étapes | navigation, états à venir / en cours / validée | ✅ |
| Bandeau « brouillon restauré » | affiché à la reprise d'un brouillon | ☑️ |

### Étape 1 — Ouverture

| Contrôle | Action réelle | Statut |
|---|---|---|
| Nom du patient (+ autocomplétion) · Âge | saisie | ✅ |
| Antécédents · Traitements · Histoire | saisie + autosave | ✅ |
| 3 boutons de dictée | dictée, repli texte, erreurs visibles | ☑️ |
| « Commencer la consultation → » | passage à l'étape 2 | ✅ |

### Étape 2 — Consultation

| Contrôle | Action réelle | Statut |
|---|---|---|
| Notes + dictée | saisie + autosave | ✅ |
| « Générer le compte-rendu » | revue clinique puis `POST /api/generate/compte-rendu` | ✅ |
| Bandeau d'erreur | 503 IA affiché, distinct d'une erreur de saisie | ✅ |
| « Clôturer la consultation → » | passage à l'étape 3 | ✅ |

### Étape 3 — Clôture

| Contrôle | Action réelle | Statut |
|---|---|---|
| Sections Biologie / Imagerie / Soins | repliables, contenu **selon la spécialité** | ✅ |
| Chips cochables | cochage + compteur de section | ✅ |
| « Autres examens ou soins » · « Médicaments » (+ dictée) | saisie libre | ✅ |
| « Préparer l'ordonnance » | composition locale, **sans IA** | ✅ |
| « ✓ Enregistrer et passer au patient suivant » | ouvre la modale | ✅ |

### Modale de clôture

| Contrôle | Action réelle | Statut |
|---|---|---|
| Récapitulatif Patient / Compte-rendu / Prescriptions | reflète l'état réel | ✅ |
| « Revenir au dossier » | ferme sans rien écrire | ➖ |
| « ✓ Enregistrer et fermer le dossier » | `POST /api/documents` par pièce, purge des brouillons, dossier vierge | ✅ |

## 6. Écrans de rédaction

Payloads inchangés — ceux de la configuration `GEN`.

| Écran | Route | Champs envoyés | Statut |
|---|---|---|---|
| Lettre de liaison | `POST /api/generate/liaison` | `patient, age, motif, specialiste, notes` | ✅ |
| Compte-rendu | `POST /api/generate/compte-rendu` | `patient, age, date, notes` | ✅ |
| Résumé de document | `POST /api/generate/resume` | `text` | ☑️ |
| Certificat MDPH | `POST /api/generate/mdph` | `patient, diagnostic, notes` | ✅ |
| Protocole ALD | `POST /api/generate/ald` | `patient, affection, notes` | ✅ |
| Certificat médical | `POST /api/generate/certificat` | `patient, type, notes` | ✅ |
| Ordonnance | `POST /api/generate/ordonnance` | `patient, ddn, medicaments, medicamentsAld, bizone` | ✅ |

Chacun passe par la revue clinique (`POST /api/clinical/analyze`, calculée côté
serveur sans IA) avant la génération : vérifié écran par écran.

| Contrôle transverse | Action réelle | Statut |
|---|---|---|
| Sélecteur de dossier | `GET /api/patients`, contexte antérieur repris | ✅ |
| Barre « Utiliser un modèle » | modèles propres à la spécialité | ☑️ |
| « Ouvrir Doctolib » (liaison, compte-rendu) | recherche de correspondant + import | ☑️ |
| Zone de dépôt `.txt` / `.pdf` (résumé) | lecture client, vignette, retrait | ☑️ |
| Bascule « Ordonnance bizone » | révèle le champ ALD, envoie `bizone: true` | ☑️ |

### Avis spécialisé

| Contrôle | Action réelle | Statut |
|---|---|---|
| Liste de spécialités | `GET /api/avis-specialise/specialites` | ☑️ |
| Cas clinique · photos · « Demander un avis » | `POST /api/avis-specialise` | ☑️ |
| Onglets Résumé / Détail | `POST /api/avis-specialise/resume` | ☑️ |
| Références sources | sources citées par la réponse | ☑️ |

## 7. Génération et zone de résultat

| Contrôle | Action réelle | Statut |
|---|---|---|
| Indicateur de progression | étapes nommées, avancées **aux franchissements réels** ; la dernière reste active jusqu'à l'arrivée du texte | ✅ |
| Squelette de document | affiché pendant l'attente | ✅ |
| Texte éditable au clic | « Cliquez pour modifier le texte » | ☑️ |
| Copier · .txt · PDF | export local (pied de page `www.arkiba.fr`) | ☑️ |
| Enregistrer dans l'historique | `POST /api/documents` | ☑️ |
| Rattacher à un patient | `POST /api/documents` avec `patientId` | ☑️ |
| Sources / référentiel | rendu du `referentiel` et du `safety` renvoyés | ☑️ |

**Pseudonymisation (RGPD)** — inchangée. Le bloc reste dans `public/app.html` et
`tests/pseudonymisation.test.js` continue de l'en extraire par marqueurs : la
passe de style n'a touché ni au code ni aux marqueurs.

## 8. Dossier patient

| Contrôle | Action réelle | Statut |
|---|---|---|
| « ← Tous les patients » | retour à la liste | ✅ |
| En-tête (âge, né(e) le, MT, suivi depuis) | `GET /api/patients/:id` | ✅ |
| Bandeau d'allergies | affiché si `allergies` non vide | ✅ |
| Encarts Antécédents / Traitements | `patho` et `traitements` | ✅ |
| « + Nouvelle consultation » · « Autre document » | ouvrent l'écran lié au dossier | ☑️ |
| Fil de suivi groupé par jour | `jours[]` de la timeline | ✅ |
| Ligne de document | `GET /api/documents/:id` → réouverture | ☑️ |

## 9. Mes patients

| Contrôle | Action réelle | Statut |
|---|---|---|
| Recherche | filtrage de la liste chargée | ✅ |
| Ligne patient | ouvre le dossier (`GET /api/patients/:id`) | ✅ |
| Formulaire « + Nouveau patient » | 6 champs | ✅ |
| « Enregistrer ce patient » | `POST /api/patients` puis ouverture du dossier | ✅ |

## 10. Historique

| Contrôle | Action réelle | Statut |
|---|---|---|
| Liste (50 derniers) | `GET /api/documents` | ✅ |
| Recherche | filtrage | ☑️ |
| Ligne de document | réouverture | ☑️ |

## 11. Profil médecin

| Contrôle | Action réelle | Statut |
|---|---|---|
| 7 champs d'identité et de cabinet | `GET /api/auth/me` au chargement | ✅ |
| Bouton d'enregistrement | `PATCH /api/auth/profile` → met à jour `praxi_profil` | ✅ |
| Confirmation « Profil mis à jour » | après 200 | ✅ |

---

## Contraintes transverses

- [x] **Cibles tactiles ≥ 44 px** sur tablette — mesuré sur tous les éléments
      cliquables visibles en 834 × 1112. Trois contrôles étaient sous le seuil
      avant la passe : bouton de dictée (34 px), bascule de thème (36 px),
      entrées de navigation.
- [x] **Aucun bouton mort** — 64/64 contrôles déclenchent leur action.
- [x] **Aucune liste de spécialités en dur** — verrouillé par les tests.
- [x] **Aucune barre de progression factice** — les étapes avancent sur les
      franchissements réels ; la dernière ne se referme jamais seule.
- [x] **Aucune erreur JavaScript** sur le parcours complet.
- [x] `npm test` — 236 tests au vert, aucun test modifié ni supprimé.
- [x] Parcours de bout en bout : inscription → connexion → nouvelle consultation
      → génération → dossier patient → clôture.

## Deux défauts trouvés par la vérification

Ils précèdent la refonte — `git show HEAD:public/app.html` les contient — et
n'ont donc pas été introduits par la passe de style. Ils sont corrigés parce
qu'un bouton qui lève une exception est un bouton mort.

1. **« Enregistrer et fermer le dossier » levait une `ReferenceError` à chaque
   clôture.** `HIST_MAX` et `persistPatients` étaient appelés sans avoir jamais
   été déclarés. La modale restait ouverte, le formulaire n'était pas
   réinitialisé, et la consultation était perdue. Les deux déclarations
   manquantes sont rétablies (`HIST_MAX = 50`, le plafond annoncé par l'écran
   Historique ; `persistPatients`, pendant de `persistHistory`).

2. **La clôture n'archivait qu'en mémoire.** `persistHistory()` ne met à jour
   qu'un cache : la consultation clôturée disparaissait au rechargement, alors
   que l'écran Historique annonce l'inverse et que le bouton « Enregistrer »
   d'une génération, lui, écrit bien côté serveur. La clôture appelle désormais
   `POST /api/documents` pour chaque pièce produite, selon le même schéma que
   `saveToHistory()`, et de façon non bloquante : un réseau de cabinet qui lâche
   ne doit pas immobiliser le passage au patient suivant.

---

# Partie II — Vitrine

`public/index.html`, servie sur `https://www.arkiba.fr/`.

La refonte livrée par Lovable est désormais **dans le dépôt** : nuit clinique,
ligne ECG, typographie serif éditoriale, panneaux de verre, or réservé aux
sources. La transposition suit la maquette section par section — héros, bandeau
de chiffres, contexte, capacités, méthode, témoignages, tarifs, accès anticipé,
pied de page.

Trois endroits s'écartent délibérément de la maquette, parce que le contrat
serveur ou la loi l'imposent :

- **Le formulaire porte plus de champs que la maquette.** `POST /api/auth/register`
  exige `prenom`, `nom`, `email`, `password`, `specialite`, `ville` et rejette
  tout envoi incomplet. La maquette n'en proposait que trois — le formulaire
  aurait été refusé à chaque soumission.
  *(Au lancement, ce formulaire est passé de la liste d'attente à la création de
  compte : la route `POST /api/waitlist` a été retirée, le champ mot de passe
  ajouté, et la soumission entre directement dans l'application.)*
- **La spécialité vient de `GET /api/specialites`.** La maquette embarquait cinq
  libellés en dur (« Médecine générale », « Cardiologie »…) : c'est exactement
  le vocabulaire qui avait divergé de la liste serveur et faisait refuser
  l'inscription. Un test verrouille désormais ce point.
- **Les liens du pied de page pointent vers les vraies pages.** La maquette les
  renvoyait tous vers `#acces`, y compris « Mentions légales », « CGU » et
  « Confidentialité » — des pages dont la présence est une obligation légale.

Vérification : **31 contrôles, 31 passés**, un constat connu signalé (compteur).
35 liens et boutons recensés sur la page.

Statut : ✅ vérifié automatiquement · ⓘ constat connu, assumé · ➖ navigation pure

## 1. En-tête et navigation

| Contrôle | Action réelle | Statut |
|---|---|---|
| Logo « Arkiba. » | ancre `#haut` | ➖ |
| « Le problème » · « Capacités » · « Méthode » · « Tarifs » | ancres `#contexte` `#capacites` `#methode` `#tarifs` — cibles présentes | ✅ |
| « Accéder à l'app » | `/login.html` — le formulaire câblé sur `POST /api/auth/login` | ✅ |
| « Accès anticipé » | ancre `#acces` — amène le formulaire à l'écran | ✅ |
| Fond de l'en-tête au défilement | apparaît au-delà de 12 px | ➖ |
| Bouton hamburger | ouvre le menu mobile, `aria-expanded` suivi — **44 × 44 px** | ✅ |
| « Se connecter » · « Créer un compte » (menu mobile) | `/login.html` · `/register.html` | ✅ |

## 2. Appels à l'action

Vérifié après clic : le formulaire est effectivement à l'écran — l'ancre ne
pointe pas dans le vide.

| Contrôle | Action réelle | Statut |
|---|---|---|
| « Rejoindre la bêta — gratuit » (héros) | `#acces` → formulaire visible | ✅ |
| « Accès anticipé » (en-tête) | `#acces` → formulaire visible | ✅ |
| « Commencer gratuitement » (Découverte) | `#acces` → formulaire visible | ✅ |
| « Essai gratuit 15 jours » (Pro) · « Nous contacter » (Groupe) | `mailto:` pour Groupe | ✅ |
| « Créer mon compte pour générer le document » (démo) | `#acces` | ✅ |

## 3. Démonstration de dictée

« Essayer une dictée » ouvre une démonstration **utilisant le moteur de
l'application** — le bloc Web Speech API de `app.html`, repris tel quel :
reconstruction du texte depuis la liste complète des résultats, redémarrage
après les coupures silencieuses du navigateur, priorité absolue à la saisie
manuelle, et message explicite sous le champ à la moindre panne.

| Contrôle | Action réelle | Statut |
|---|---|---|
| État initial | la démo est repliée tant qu'on ne la demande pas | ✅ |
| « Essayer une dictée » | déplie la démonstration et y amène le regard | ✅ |
| Champ de texte | saisie au clavier — le repli sans micro fonctionne seul | ✅ |
| Compteur de caractères | suit la saisie | ✅ |
| Bouton micro | **44 × 44 px** ; démarre / arrête la reconnaissance | ✅ |
| État d'écoute | bandeau « Arkiba vous écoute », bouton en respiration | ✅ |
| Micro refusé, absent, ou service injoignable | message explicite + consigne de repli, jamais de blocage silencieux | ✅ |
| Navigateur sans Web Speech API | message dédié, le champ reste utilisable | ✅ |
| Texte déjà saisi | conservé quand la dictée démarre — rien n'est écrasé | ✅ |
| Isolation | **aucun appel serveur** : rien n'est envoyé, aucun document généré | ✅ |
| « Fermer » | arrête la dictée en cours et referme la démonstration | ✅ |

La transcription elle-même dépend du service de reconnaissance du navigateur et
ne peut pas être vérifiée en machine : elle reste au test terrain, avec un vrai
micro (voir la liste des vérifications manuelles).

## 4. Formulaire de création de compte (`#register-form`)

| Contrôle | Action réelle | Statut |
|---|---|---|
| Prénom · Nom · Email · Mot de passe · Ville | saisie, validés côté serveur | ✅ |
| **Spécialité** | 46 options chargées par `GET /api/specialites` — **jamais en dur** | ✅ |
| Champ manquant | validation native du navigateur, signalée sur place | ✅ |
| « Créer mon compte » | `POST /api/auth/register` → `201` → jeton rangé, entrée dans `/app.html` | ✅ |
| Confirmation | le formulaire s'efface, le bloc de succès apparaît avec le prénom | ✅ |
| Email déjà inscrit | `409` → message serveur dans un bandeau d'erreur | ✅ |
| Trop de tentatives | `429` → message serveur ; plafond 5/h/IP | ✅ |
| Après un refus | le bouton redevient actif — l'inscrit n'est pas coincé | ✅ |

*(Ce tableau décrit l'état au lancement. Lors du câblage de la refonte, le même
formulaire alimentait une liste d'attente via `POST /api/waitlist` ; cette route
et son fichier `waitlist.json` ont été retirés, aucun compte n'y ayant été
enregistré.)*

Les erreurs passaient auparavant par `alert()`. Elles s'affichent maintenant
dans un bandeau au sein du formulaire, dans la langue visuelle de la refonte.

## 5. Pied de page

| Contrôle | Action réelle | Statut |
|---|---|---|
| Capacités · Méthode · Tarifs · Créer un compte | ancres de la page | ✅ |
| Hébergement & RGPD · Sécurité des données | `/politique-confidentialite.html` | ✅ |
| Sources cliniques | ancre `#capacites` | ✅ |
| Accéder à l'application | `/login.html` | ✅ |
| Mentions légales · CGU · Confidentialité | pages servies, `200` | ✅ |
| Contact | `mailto:contact@arkiba.fr` | ✅ |

## 6. Cibles tactiles

Mesuré en 834 px de large. **Toutes les cibles visibles sont à 44 px ou plus.**
Les deux défauts relevés sur l'ancienne vitrine sont corrigés :

| Élément | Avant | Après |
|---|---|---|
| Bouton hamburger | 38 px | 44 px |
| Liens du pied de page | 15 px | 44 px |
| Bouton micro de la démo | — | 44 px |
| Boutons et liens d'action | variable | 44 px minimum |

## 7. Constat connu — réglé au lancement

ⓘ **Le compteur « 47 médecins inscrits » était une valeur figée dans la page.**
Il avait été laissé en l'état pendant la refonte, signalé ici, en commentaire
dans `index.html` et à chaque passage du harnais (ligne `NOTE`) pour qu'il ne se
fasse jamais passer pour une donnée. Il a été retiré au lancement, en même temps
que la mention « Bêta fermée » qui contredisait un formulaire ouvrant désormais
l'application immédiatement. `GET /api/stats`, qui comptait les inscrits de la
liste d'attente, a été retiré avec elle.

## 8. Compatibilité

Comme l'application, la vitrine déclare un repli hexadécimal devant chaque
valeur `oklch()` / `color-mix()` : sur un iPad resté sous iPadOS 16.4, la page
garde ses couleurs au lieu de les perdre toutes.

---

## Refonte de l'application — passe Lovable (août 2026)

La refonte livrée par Lovable pour l'**application** (et non la vitrine) a été
transposée sur `public/app.html`. Le style vit désormais dans `public/app.css`,
servi en même origine ; le bloc `<style>` en ligne a disparu.

Ce qui change à l'écran, écran par écran :

- **Coque** — barre latérale en verre, groupes de navigation, bloc médecin
  cliquable, pied de barre (thème, déconnexion). Zone de travail centrée,
  900 px, halo en haut de page, trame et grain sur le fond.
- **En-tête d'écran** — chaque vue s'ouvre par un service en capitales
  monospacées, un titre en DM Serif Display centré, une promesse en une phrase.
- **Panneaux** — les champs d'un écran forment un bloc titré (« Éléments du
  certificat », « Éléments de la lettre »…) au lieu d'une liste de champs.
- **Action principale** — une seule par écran, pleine largeur, 56 px. Les
  réglages « Longueur / Mon style » la précèdent au lieu de la suivre, et ne
  s'affichent plus sur les écrans qui ne génèrent rien (profil, patients).
- **Sélecteur de dossier** — étendu au certificat MDPH, au protocole ALD et au
  certificat médical, avec la phrase d'aide qui dit ce que le dossier apporte.
- **Import Doctolib** — sorti du dépliant « Utiliser un modèle », qui annonçait
  autre chose ; le dépliant disparaît quand la spécialité n'a aucun modèle.
- **Attente de génération** — étapes réelles (fait / en cours / à venir) et
  squelette du document, sans pourcentage inventé.
- **Résultat** — « Document généré », titre en serif, outils centrés, texte
  éditable au clic, sources en pastilles ambre.
- **Mouvement** — 140–220 ms sur `transform` et `opacity` uniquement : entrée
  d'écran et d'étape, ondes du micro qui écoute, compteur qui saute quand il
  change, trait qui respire sous l'étape en cours, miroitement du squelette.
  `prefers-reduced-motion` neutralise l'ensemble.

Vérifications après transposition : `verif-cablage.js` **64/64**, `npm test`
**236/236**, aucune erreur JavaScript, toutes les cibles tactiles ≥ 44 px sur
tablette. Le contrat bouton par bouton ci-dessus reste valable : aucun
identifiant, aucun gestionnaire, aucun appel serveur n'a été retiré.
