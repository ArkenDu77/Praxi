# Câblage de la refonte — checklist de contrôle

Refonte visuelle des écrans applicatifs (design Lovable) branchée sur l'API
Arkiba existante. Le backend n'est pas modifié : routes, sécurité, RGPD et
anonymisation restent ceux de `server.js`.

Ce document sert de contrat de non-régression. **Chaque ligne est un élément
interactif de l'application actuelle.** Un élément qui n'a pas d'équivalent
branché dans la refonte est une fonctionnalité perdue, pas un choix de design.

Colonne « Action réelle » = ce que le contrôle doit déclencher. Tout passe par
`web/src/lib/arkiba-api.ts` : aucun composant n'appelle `fetch` directement.

Statut : ⬜ à brancher · ✅ branché et vérifié · ➖ purement local (pas d'API)

---

## Conventions vérifiées sur le serveur en fonctionnement

| Point | Contrat relevé |
|---|---|
| Jeton | `localStorage['praxi_token']`, en-tête `Authorization: Bearer …` |
| Profil local | `localStorage['praxi_profil']` — alimente l'en-tête des documents |
| Erreurs | Toujours JSON `{ error: "…" }`, y compris en 404 sous `/api` |
| 401 | Purge de session + retour à la connexion |
| 429 | Inscription 5/h/IP, connexion 10/h/IP — message dédié attendu |
| 503 | `Service IA non configuré` — n'est pas une erreur de saisie du médecin |
| Spécialités | 46 libellés, servis par `GET /api/specialites`, **jamais en dur** |

---

## 1. Connexion

| Contrôle | Action réelle | Statut |
|---|---|---|
| Champ Email professionnel | saisie, `trim()` avant envoi | ⬜ |
| Champ Mot de passe | saisie | ⬜ |
| Bouton « Se connecter » | `POST /api/auth/login` → stocke jeton + profil → `/app` ; état chargement « Connexion… » | ⬜ |
| Bandeau succès post-inscription | affiché sur `?registered=1`, puis l'URL est nettoyée | ⬜ |
| Bandeau d'erreur | message serveur affiché tel quel (identifiants, 429) | ⬜ |
| Lien « Créer un compte » | navigation `/inscription` | ➖ |
| Lien « Mot de passe oublié ? » | navigation `/mot-de-passe-oublie` | ➖ |
| Lien « Retour à l'accueil » | navigation `/` | ➖ |
| Redirection si déjà connecté | jeton présent → `/app` sans afficher le formulaire | ⬜ |

## 2. Création de compte

| Contrôle | Action réelle | Statut |
|---|---|---|
| Prénom · Nom · Email · Ville | saisie, requis côté serveur | ⬜ |
| Mot de passe | 8 caractères min. **et** au moins une majuscule ou un chiffre | ⬜ |
| **Spécialité(s)** | options chargées par `GET /api/specialites` — sélection multiple, envoyée en tableau `specialites[]` | ⬜ |
| Numéro RPPS | optionnel, 20 car. max côté serveur | ⬜ |
| Bouton « Créer mon compte » | `POST /api/auth/register` → jeton + profil → `/login?registered=1` | ⬜ |
| Bandeau d'erreur | erreurs concaténées du serveur ; 409 « compte existe déjà » ; 429 | ⬜ |
| Liens « Se connecter » / « Retour à l'accueil » | navigation | ➖ |

**Piège vérrouillé par `tests/specialites.test.js`** : aucune page ne doit
redéclarer la liste des spécialités. Le test refuse tout `const SPECIALITES = [`
dans les pages et exige la présence de `/api/specialites`.

## 3. Mot de passe oublié / réinitialisation

| Contrôle | Action réelle | Statut |
|---|---|---|
| Champ email + « Envoyer le lien » | `POST /api/auth/forgot-password` → `{ ok: true }` (réponse volontairement identique que le compte existe ou non) | ⬜ |
| Nouveau mot de passe + « Réinitialiser » | `POST /api/auth/reset-password` avec le jeton de l'URL | ⬜ |

## 4. Coquille applicative

| Contrôle | Action réelle | Statut |
|---|---|---|
| Bloc utilisateur (initiale, nom, spécialité) | lu depuis le profil local ; clic → écran Profil | ⬜ |
| 12 entrées de navigation | changement de vue (Nouvelle consultation, Lettre de liaison, Compte-rendu, Résumé, MDPH, ALD, Certificat, Ordonnance, Avis spécialisé, Historique, Mes patients, Profil) | ⬜ |
| Compteur « Historique » | nombre réel de documents | ⬜ |
| Bascule de thème | persistée localement | ➖ |
| « Déconnexion » | purge `praxi_token` + `praxi_profil` **et les brouillons locaux** → `/` | ⬜ |
| Hamburger + voile (tablette) | ouverture/fermeture de la barre latérale | ➖ |
| Pastille d'autosave | états « Enregistrement… » → « Enregistré à l'instant » pilotés par la sauvegarde réelle des brouillons | ⬜ |
| Réglages de génération | « Longueur » et « Mon style » — transmis dans le payload de génération | ⬜ |

## 5. Parcours Nouvelle consultation

### Commun

| Contrôle | Action réelle | Statut |
|---|---|---|
| Sélecteur de dossier | peuplé par `GET /api/patients` ; le choix conditionne la reprise du contexte | ⬜ |
| Stepper (3 étapes cliquables) | navigation entre les volets, états à venir / en cours / validée | ⬜ |
| Bandeau de contexte patient | nom + âge saisis | ➖ |
| Bandeau « brouillon restauré » | affiché quand un brouillon est repris du stockage local | ⬜ |

### Étape 1 — Ouverture

| Contrôle | Action réelle | Statut |
|---|---|---|
| Nom du patient | saisie + autocomplétion sur `GET /api/patients` | ⬜ |
| Âge | saisie | ⬜ |
| Antécédents · Traitements · Histoire | saisie + autosave | ⬜ |
| 3 boutons de dictée | reconnaissance vocale, **repli sur la saisie texte** et erreurs visibles si indisponible | ⬜ |
| « Commencer la consultation → » | passage à l'étape 2 | ➖ |

### Étape 2 — Consultation

| Contrôle | Action réelle | Statut |
|---|---|---|
| Notes de consultation + dictée | saisie + autosave | ⬜ |
| « Générer le compte-rendu » | pseudonymisation → `POST /api/generate/compte-rendu` → resubstitution → rendu | ⬜ |
| Zone de résultat + outils | voir §7 | ⬜ |
| « Clôturer la consultation → » | passage à l'étape 3 | ➖ |
| « ← Ouverture » | retour étape 1 | ➖ |

### Étape 3 — Clôture

| Contrôle | Action réelle | Statut |
|---|---|---|
| Sections repliables Biologie / Imagerie / Soins | contenu **dépendant de la spécialité du compte** (`GET /api/referentiels/mien`), jamais codé en dur | ⬜ |
| Chips cochables | mise à jour du compteur de la section | ➖ |
| « Autres examens ou soins » | saisie libre, une ligne par prescription | ➖ |
| « Médicaments » + dictée | saisie libre | ⬜ |
| « Préparer l'ordonnance » | composition locale de l'ordonnance — **sans IA**, comportement actuel à préserver | ⬜ |
| « ✓ Enregistrer et passer au patient suivant » | ouvre la modale de clôture | ➖ |
| « ← Consultation » | retour étape 2 | ➖ |

### Modale de clôture

| Contrôle | Action réelle | Statut |
|---|---|---|
| Récapitulatif Patient / Compte-rendu / Prescriptions | reflète l'état réel (« Non généré — les notes brutes seront archivées », « Aucune ») | ⬜ |
| « Revenir au dossier » | ferme la modale sans rien écrire | ➖ |
| « ✓ Enregistrer et fermer le dossier » | `POST /api/documents` pour chaque pièce produite, purge des brouillons, dossier vierge pour le patient suivant | ⬜ |

## 6. Écrans de rédaction

Payloads relevés dans la configuration `GEN` de l'application actuelle — à
reproduire à l'identique.

| Écran | Route | Champs envoyés | Refus côté client | Statut |
|---|---|---|---|---|
| Lettre de liaison | `POST /api/generate/liaison` | `patient, age, motif, specialiste, notes` | ni motif ni notes | ⬜ |
| Compte-rendu | `POST /api/generate/compte-rendu` | `patient, age, date, notes` | notes vides | ⬜ |
| Résumé de document | `POST /api/generate/resume` | `text` | aucun fichier chargé | ⬜ |
| Certificat MDPH | `POST /api/generate/mdph` | `patient, diagnostic, notes` | ni diagnostic ni notes | ⬜ |
| Protocole ALD | `POST /api/generate/ald` | `patient, affection, notes` | ni affection ni notes | ⬜ |
| Certificat médical | `POST /api/generate/certificat` | `patient, type, notes` | ni type ni notes | ⬜ |
| Ordonnance | `POST /api/generate/ordonnance` | `patient, ddn, medicaments, medicamentsAld, bizone` | aucun médicament | ⬜ |

Contrôles transverses à ces écrans :

| Contrôle | Action réelle | Statut |
|---|---|---|
| Sélecteur de dossier | `GET /api/patients` ; contexte antérieur repris | ⬜ |
| Barre « Utiliser un modèle » | modèles rapides propres à la spécialité | ⬜ |
| Bouton « Ouvrir Doctolib » (liaison, compte-rendu) | recherche de correspondant + import | ⬜ |
| Zone de dépôt de fichier (résumé) | lecture `.txt` et `.pdf` côté client ; vignette + retrait | ⬜ |
| Bascule « Ordonnance bizone » | révèle le champ ALD ; envoie `bizone: true` | ⬜ |
| Boutons de dictée | dictée + repli texte + erreurs visibles | ⬜ |

### Avis spécialisé

| Contrôle | Action réelle | Statut |
|---|---|---|
| Liste de spécialités | `GET /api/avis-specialise/specialites` (≠ liste d'inscription) | ⬜ |
| Description du cas | saisie | ⬜ |
| Ajout de photos | redimensionnement client, aperçus, retrait | ⬜ |
| « Demander un avis » | `POST /api/avis-specialise` | ⬜ |
| Onglets Résumé / Détail | `POST /api/avis-specialise/resume` pour le résumé | ⬜ |
| Liste des références | sources réellement citées par la réponse | ⬜ |

## 7. Génération et zone de résultat

| Contrôle | Action réelle | Statut |
|---|---|---|
| Indicateur de progression | étapes nommées, avancées **aux franchissements réels** : dossier chargé → référentiel chargé → rédaction. La dernière étape reste active jusqu'à l'arrivée du texte — jamais de minuterie qui simule la fin | ⬜ |
| Squelette de document | affiché pendant l'attente | ➖ |
| Texte du document | éditable au clic (« Cliquez pour modifier le texte ») | ⬜ |
| Copier | presse-papiers | ➖ |
| Télécharger .txt | export local | ➖ |
| Télécharger PDF | export local, pied de page `www.arkiba.fr` | ⬜ |
| Enregistrer dans l'historique | `POST /api/documents` | ⬜ |
| Rattacher à un patient | `POST /api/documents` avec `patientId` | ⬜ |
| Sources / référentiel | rendu du `referentiel` et du `safety` renvoyés avec le document | ⬜ |
| Bandeau d'erreur | message serveur ; cas 503 IA non configurée distinct | ⬜ |

**Pseudonymisation (RGPD)** — les champs identifiants sont pseudonymisés avant
l'appel puis resubstitués dans le texte rendu. Le bloc de référence vit
aujourd'hui dans `public/app.html` et `tests/pseudonymisation.test.js` l'en
extrait par marqueurs. La refonte doit **porter ce code, pas le réécrire**, et
le test doit être pointé vers le nouveau module — les sept types de documents
`liaison, cr, consult, mdph, ald, certificat, ordonnance` doivent rester
couverts.

## 8. Dossier patient

| Contrôle | Action réelle | Statut |
|---|---|---|
| « ← Tous les patients » | retour à la liste | ➖ |
| En-tête (identité, âge, né(e) le, MT, suivi depuis) | `GET /api/patients/:id` | ⬜ |
| Bandeau d'allergies | affiché si `allergies` non vide | ⬜ |
| Encarts Antécédents / Traitements | champs `patho` et `traitements` | ⬜ |
| « + Nouvelle consultation » | ouvre le parcours avec le dossier présélectionné | ⬜ |
| « Autre document » | ouvre un écran de rédaction lié au dossier | ⬜ |
| Fil de suivi | `jours[]` de la timeline, groupés par date | ⬜ |
| Ligne de document | `GET /api/documents/:id` → réouverture | ⬜ |
| Compteur de documents | `stats.total` | ⬜ |

## 9. Mes patients

| Contrôle | Action réelle | Statut |
|---|---|---|
| Recherche | `GET /api/patients?q=` | ⬜ |
| Ligne patient | ouvre le dossier | ⬜ |
| Bloc dépliable « + Nouveau patient » | — | ➖ |
| Nom · Date de naissance · Pathologies · Traitements · Allergies · Médecin traitant | champs `nom, ddn, patho, traitements, allergies, mt` | ⬜ |
| « Enregistrer ce patient » | `POST /api/patients` | ⬜ |
| Bandeau d'erreur | message serveur (400) | ⬜ |

## 10. Historique

| Contrôle | Action réelle | Statut |
|---|---|---|
| Recherche | `GET /api/documents?q=` | ⬜ |
| Liste (50 derniers) | `GET /api/documents` | ⬜ |
| Ligne de document | réouverture | ⬜ |

## 11. Profil médecin

| Contrôle | Action réelle | Statut |
|---|---|---|
| Prénom · Nom · Ville · Adresse · Téléphone · Email pro · RPPS | `GET /api/auth/me` au chargement | ⬜ |
| Bouton d'enregistrement | `PATCH /api/auth/profile` → met à jour `praxi_profil` | ⬜ |
| Confirmation « Profil mis à jour » | après réponse 200 | ⬜ |
| Spécialité(s) | `PATCH` refuse une liste vide (400) — le message doit s'afficher | ⬜ |

---

## Contraintes transverses à vérifier avant livraison

- [ ] **Cibles tactiles ≥ 44 px** sur tablette pour tout élément cliquable
      (boutons, chips, lignes de timeline, résumés dépliables, icônes de dictée).
- [ ] **Aucun bouton mort** : chaque contrôle de ce document déclenche une action.
- [ ] **Aucune liste de spécialités en dur** dans un composant.
- [ ] **Aucune barre de progression factice**.
- [ ] Suite de tests au vert (`npm test`), tests couplés au front adaptés et non
      supprimés.
- [ ] Parcours complet vérifié de bout en bout : inscription → connexion →
      nouvelle consultation → génération → dossier patient → clôture.
