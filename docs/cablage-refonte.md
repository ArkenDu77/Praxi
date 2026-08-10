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
| Vitrine | 22 | 20/22 — deux constats ouverts, voir partie II |

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

**Cette page n'est pas la maquette Lovable.** La refonte visuelle livrée par
Lovable pour la vitrine vit dans le projet Lovable et n'a jamais été reprise
dans le dépôt : la page en production est la vitrine antérieure. Elle est en
revanche déjà branchée au serveur — ce qui suit le documente contrôle par
contrôle.

Vérification : **22 contrôles, 20 passés**, deux constats ouverts en fin de
partie. 28 liens et boutons recensés au total sur la page.

## 1. En-tête et navigation

| Contrôle | Action réelle | Statut |
|---|---|---|
| « Le problème » · « Comment ça marche » · « Tarifs » | ancres `#probleme` `#comment` `#tarifs` — cibles présentes | ✅ |
| « Accéder à l'app » | `/app.html` → redirection vers `/login.html`, le formulaire câblé sur `POST /api/auth/login` | ✅ |
| « Accès anticipé » | ancre `#acces` — amène le formulaire d'inscription à l'écran | ✅ |
| Bouton hamburger (`#nav-burger`) | ouvre le menu mobile | ⚠️ 38 px, sous le seuil tactile |
| « Se connecter » (menu mobile) | `/login.html` — écran de connexion réel | ✅ |
| « Créer un compte » (menu mobile) | `/register.html` | ✅ |

## 2. Appels à l'action

Tous mènent à l'ancre `#acces`, où se trouve le formulaire de liste d'attente.
Vérifié : après le clic, le formulaire est effectivement à l'écran — ce n'est
pas une ancre qui pointe dans le vide.

| Contrôle | Action réelle | Statut |
|---|---|---|
| « Rejoindre la bêta — gratuit » | `#acces` → formulaire visible | ✅ |
| « Accès anticipé » | `#acces` → formulaire visible | ✅ |
| « Commencer gratuitement » | `#acces` → formulaire visible | ✅ |
| « Essai gratuit 30 jours » · « Nous contacter » | `#acces` | ✅ |
| « Voir comment ça marche » | `#comment` | ✅ |
| « Accéder à l'application » (×3 dans la page) | `/login.html` | ✅ |

## 3. Formulaire de liste d'attente (`#waitlist-form`)

| Contrôle | Action réelle | Statut |
|---|---|---|
| Prénom · Nom · Email · Ville | saisie, validés côté serveur | ✅ |
| **Spécialité** | options chargées par `GET /api/specialites` — **jamais en dur** | ✅ |
| « Demander l'accès bêta » | `POST /api/waitlist` → `201` → l'inscription est comptée par `/api/stats` | ✅ |
| Confirmation | le formulaire s'efface, le bloc de succès apparaît avec le prénom | ✅ |
| Email déjà inscrit | `409` → message serveur affiché (« Cet email est déjà inscrit. ») | ✅ |
| Trop de tentatives | `429` → message serveur affiché ; plafond 3/h/IP | ✅ |
| Après un refus | le bouton redevient actif — l'inscrit n'est pas coincé | ✅ |

Les erreurs remontent par `alert()`. C'est fruste mais fonctionnel, et
délibéré : le message du serveur est actionnable, le masquer derrière un texte
générique laissait l'inscrit réessayer sans savoir ce qui coince.

## 4. Pied de page

| Contrôle | Action réelle | Statut |
|---|---|---|
| Mentions légales · CGU · Confidentialité | pages servies, `200` | ✅ |
| Contact | `mailto:contact@arkiba.fr` | ✅ |

## 5. Deux constats ouverts

### Le compteur « 47 médecins inscrits » est en dur, et faux

`public/index.html` porte `<span id="counter-num">47</span>` et anime la valeur
vers `47` — une constante écrite dans le code, jamais lue du serveur.

`GET /api/stats` existe pourtant et renvoie le compte réel de la liste
d'attente. **En production, ce compte est `0`.** La page affiche donc à ses
visiteurs une adhésion qui n'existe pas, sur le site public d'un produit
médical. Ce n'est pas un simple jeton de maquette resté en place : c'est une
affirmation chiffrée démentie par la donnée.

Deux issues, l'une et l'autre honnêtes, mais qui relèvent d'un arbitrage
produit et non technique :

- brancher le compteur sur `GET /api/stats` — la page dira « 0 médecin inscrit »
  tant que la liste est vide ;
- retirer le compteur tant qu'il n'y a pas d'inscrits réels à annoncer.

Le compteur est laissé en l'état en attendant cet arbitrage, et signalé ici
plutôt que corrigé en silence.

### Cibles tactiles sous 44 px

Mesuré en 834 px de large (tablette) :

| Élément | Hauteur |
|---|---|
| Bouton hamburger `#nav-burger` | 38 px |
| Liens du pied de page (Mentions légales, CGU, Confidentialité, Contact) | 15 px |

L'application a été mise à 44 px partout lors de sa passe de style ; la vitrine
n'a pas encore eu la sienne. À traiter avec la reprise du design Lovable, pour
ne pas retoucher deux fois une page destinée à être remplacée.

## 6. Ce que la vitrine ne fait pas

- **« Essayer une dictée » n'existe pas** dans la page en production. Le bouton
  figure dans la maquette Lovable, où il mène à une route interne `/redaction`
  (un écran de rédaction de démonstration, sans dictée réelle).
- Aucun autre contrôle de la maquette Lovable — la page en production est
  antérieure à cette maquette.
