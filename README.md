# Arkiba — Stack technique

Assistant médico-administratif pour médecins libéraux français.
Génération de lettres de liaison, comptes-rendus de consultation et résumés de documents
médicaux à partir de notes brutes, via l'API Anthropic.

## Démarrage local

```bash
npm install
cp .env.example .env   # puis renseigner ANTHROPIC_API_KEY et JWT_SECRET
npm start
# → http://localhost:3001
```

## Structure

```
praxi/
├── public/
│   ├── index.html                       ← Landing page
│   ├── login.html                       ← Connexion médecin
│   ├── register.html                    ← Inscription médecin
│   ├── app.html                         ← Application (sidebar + 3 modules)
│   ├── auth.css                         ← Styles partagés login/register
│   ├── mentions-legales.html            ← Pages légales
│   ├── cgu.html
│   └── politique-confidentialite.html
├── lib/
│   ├── plans.js                         ← Plans d'abonnement : droits, quotas, whitelist
│   ├── facturation.js                   ← Adaptateur Stripe (checkout, portail, webhooks)
│   ├── ingest.js                        ← Orchestration de l'ingestion (CLI + route admin)
│   ├── specialites.js                   ← Registre des spécialités « avis spécialisé »
│   └── rag/                             ← Brique RAG générique (réutilisable)
│       ├── index.js                     ← API publique : ragIngest / ragSearch
│       ├── chunk.js                     ← Découpage en passages
│       ├── embeddings.js                ← Voyage AI, repli lexical
│       ├── lexical.js                   ← BM25
│       ├── store.js                     ← Index fichier (driver pgvector prévu)
│       └── sources/                     ← PubMed, HAS, SFD, BDPM
├── scripts/
│   └── ingest.js                        ← CLI d'ingestion de la base de connaissances
├── server.js                            ← Backend Express
├── users.json                           ← Comptes médecins (créé au 1er register)
├── rag/                                 ← Index vectoriel (généré, non versionné)
├── .env.example                         ← Modèle de configuration
├── package.json
└── README.md
```

## Variables d'environnement (.env)

```env
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
ADMIN_TOKEN=change-moi-en-prod

# Authentification JWT
JWT_SECRET=change-moi-en-production
JWT_EXPIRES_IN=7d

# Comptes à accès illimité (facultatif — deux emails par défaut dans le code)
ARKIBA_ADMIN_EMAILS=benarken@yahoo.com,sbh75@gmx.fr

# Stripe — facultatif : sans clé, le paiement est fermé (503) et le reste
# de l'application fonctionne normalement
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_GROUPE=price_...
```

Liste complète et commentée : `.env.example`.

## API

### Public

| Méthode | Route | Description |
|---------|-------|-------------|
| GET    | `/api/specialites` | Liste fermée des spécialités — source unique des menus du front |
| GET    | `/health` | Sonde de l'hébergeur : IA, stockage, facturation |

> `/api/specialites` sert exactement la liste contre laquelle
> `/api/auth/register` et `/api/auth/profile` valident. Les pages `index.html`,
> `register.html` et `app.html` peuplent leur menu depuis cette route : ne
> réintroduisez pas de liste écrite en dur dans une page. Une copie figée dans
> `register.html` avait divergé du serveur et faisait échouer *toutes* les
> inscriptions avec « Spécialité requise » ; `tests/specialites.test.js`
> verrouille désormais cet invariant.

### Authentification (médecins)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST   | `/api/auth/register` | Inscription d'un médecin (bcrypt + JWT) |
| POST   | `/api/auth/login` | Connexion → renvoie un JWT |
| GET    | `/api/auth/me` | Infos du médecin connecté (JWT requis) |
| PATCH  | `/api/auth/profile` | Mise à jour du profil (JWT requis) |

### Génération IA (JWT requis)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST   | `/api/generate/liaison` | Lettre de liaison vers un spécialiste |
| POST   | `/api/generate/compte-rendu` | Compte-rendu de consultation structuré |
| POST   | `/api/generate/resume` | Analyse / résumé d'un document |

### Avis spécialisé (JWT requis)

| Méthode | Route | Description |
|---------|-------|-------------|
| GET    | `/api/avis-specialise/specialites` | Spécialités disponibles + état de la base indexée |
| POST   | `/api/avis-specialise` | Cas clinique + photos + spécialité → avis argumenté et sourcé |
| POST   | `/api/avis-specialise/resume` | Synthèse courte d'un avis déjà généré (sans nouvelle recherche) |

Chaque route protégée attend l'en-tête `Authorization: Bearer <token>`.
Le profil du médecin (prénom, nom, spécialité, adresse, RPPS…) est automatiquement
injecté dans le system prompt — aucun champ vide entre crochets n'apparaît dans le document.

### Abonnement / facturation

| Méthode | Route | Description |
|---------|-------|-------------|
| GET    | `/api/billing/state` | Formule, essai restant, quota, fonctionnalités ouvertes (JWT) |
| POST   | `/api/billing/checkout` | Ouvre une session de paiement Stripe (JWT) |
| POST   | `/api/billing/portal` | Portail client Stripe : moyen de paiement, factures, résiliation (JWT) |
| POST   | `/api/stripe/webhook` | Notifications Stripe — signature vérifiée, corps brut |

Voir la section [Abonnements](#abonnements) plus bas.

### Admin

| Méthode | Route | Description |
|---------|-------|-------------|
| POST   | `/admin/ingest?specialite=X` | Lancer l'ingestion d'une spécialité (voir section RAG) |
| GET    | `/admin/ingest/:id` | Avancement d'un job d'ingestion |
| GET    | `/admin/ingest` | Jobs récents + état des index |

```bash
curl http://localhost:3001/admin/ingest -H "x-admin-token: arkiba-admin-dev"
```

## Fonctionnalités de l'application (`/app.html`)

### Bouclier clinique V2

Avant chaque génération, Arkiba effectue une revue clinique explicable et affiche séparément :

- les faits présents dans la source ;
- les déductions prudentes ;
- les informations manquantes et questions utiles ;
- les incohérences simples à vérifier ;
- les suggestions, qui ne sont intégrées qu'après validation explicite du médecin ;
- un score de confiance expliqué et un format recommandé.

Le médecin choisit un document Express, Standard ou Détaillé. Le style peut être défini manuellement ou appris localement à partir de l'historique. Le serveur impose un contrat anti-hallucination à tous les générateurs et signale les valeurs numériques sans correspondance directe dans la source.

- **Authentification JWT** — vérification au chargement, redirection vers `/login.html` si absent ou expiré.
- **Sidebar** — logo, nom du médecin, 3 modules, historique, profil, déconnexion.
- **3 modules** — lettre de liaison, compte-rendu de consultation, résumé de document (.txt / .pdf via pdf.js).
- **Dictée vocale** — Web Speech API (fr-FR), bouton micro sur chaque champ notes, indicateur rouge pulsant.
- **Modèles par spécialité** — pré-remplissage adapté du champ notes selon la spécialité destinataire ; le serveur ajuste légèrement le prompt en conséquence.
- **Export** — Copier, télécharger `.txt`, télécharger PDF (jsPDF), sauvegarder dans l'historique.
- **Historique local** — 50 documents max en localStorage, FIFO, réouverture / suppression.
- **Profil médecin** — synchronisé avec le serveur (`PATCH /api/auth/profile`) et préfixé en en-tête de chaque document généré.
- **Import Doctolib (simulation)** — modale dédiée, données fictives, mention claire « Mode simulation ».

## Avis spécialisé (RAG)

Le médecin décrit un cas, joint jusqu'à 4 photos et choisit une spécialité
(dermatologie aujourd'hui). Le serveur interroge une base de connaissances
médicale **réellement indexée** et construit un prompt multimodal à partir des
passages retrouvés. Ce n'est pas un prompt demandant au modèle de « jouer » un
spécialiste : sans base indexée, la route répond `503` au lieu de produire un
avis qui aurait l'apparence d'être sourcé sans l'être.

### Architecture

La brique `lib/rag/` est **générique** : elle ne connaît ni la dermatologie, ni
le médical. Une « collection » est un espace de noms indépendant.

```js
await ragIngest({ collection: 'dermatologie', documents });
await ragSearch({ collection: 'dermatologie', query, topK: 8 });
```

L'objectif à terme est de l'appliquer aussi aux comptes-rendus et lettres de
liaison, pour les enrichir avec des données médicales réelles plutôt que du
simple prompting.

| Brique | Choix | Pourquoi |
|--------|-------|----------|
| Vector store | Index fichier sur `RAG_DIR` (JSONL + Float32) | Aucun Postgres dans le projet ; 8 000 passages = 33 Mo en RAM, recherche ~15 ms. Interface prête pour un driver pgvector (`store.js`) |
| Embeddings | Voyage AI `voyage-3.5` (HTTPS direct) | Bon en français, pas de dépendance npm. Sans `VOYAGE_API_KEY`, repli lexical automatique |
| Recherche | Hybride : cosinus + BM25, fusion RRF | Le lexical rattrape ce que les embeddings ratent : molécules, scores PASI/SCORAD, acronymes |
| Découpage | ~3 000 caractères, recouvrement 15 % | Passages homogènes, frontières de paragraphe respectées |

### Sources dermatologie

| Source | Accès | Contenu |
|--------|-------|---------|
| **PubMed** | API E-utilities (NCBI) | Revues et recommandations récentes, filtrées par termes MeSH |
| **SFD** | HTML (`reco.` / `centredepreuves.` / `chronoreco.sfdermato.org`) | Recommandations et algorithmes de la Société Française de Dermatologie |
| **HAS** | Pages de publication ciblées | Recommandations de bonne pratique et avis de transparence |
| **BDPM (ANSM)** | Fichiers TSV officiels | Molécules, formes, statut de commercialisation, indications retenues par la HAS |

Deux exclusions volontaires :

- **Vidal** — ses conditions d'utilisation interdisent l'extraction automatisée
  et il n'existe pas d'API publique. La BDPM en est l'équivalent officiel et
  librement exploitable. Un accès Vidal passerait par leur offre commerciale.
- **DermNet NZ** — licence CC BY-NC-ND, usage non commercial uniquement.

Le moteur de recherche du site HAS est interdit par son `robots.txt` : la source
`has.js` part d'une liste d'URL de publications curée dans `lib/specialites.js`,
qui relève de pages autorisées. Les PDF (PNDS, argumentaires) ne sont pas
ingérés — pas de parseur PDF côté serveur ; le texte des indications HAS reste
disponible via la BDPM, qui le redistribue en clair.

### Ingestion

```bash
npm run ingest -- --list                          # spécialités et état des index
npm run ingest -- dermatologie                    # toutes les sources
npm run ingest -- dermatologie --sources=sfd,has  # une partie seulement
npm run ingest -- dermatologie --limit=50 --dry-run
npm run ingest -- dermatologie --reset            # repart d'un index vide
```

L'ingestion est idempotente : relancée, elle écrase les passages déjà connus
(clé = identifiant du document) sans dupliquer le corpus. Comptez ~10 min et
quelques euros d'embeddings pour un corpus dermatologique complet.

Un verrou fichier (`<collection>.ingest.lock` dans `RAG_DIR`) empêche deux
ingestions simultanées sur une même collection — le store réécrit les fichiers
en entier, deux écritures concurrentes se perdraient. Le verrou couvre le CLI
**et** la route d'administration, qui sont deux processus distincts ; il est
repris automatiquement s'il est resté orphelin plus de 45 minutes.

### Ingestion par API (administration)

Même moteur que le CLI (`lib/ingest.js`), utilisable à distance sans shell sur
le service. Utile pour ré-ingérer périodiquement ou pour indexer une nouvelle
spécialité après l'avoir déclarée.

| Méthode | Route | Description |
|---------|-------|-------------|
| POST   | `/admin/ingest?specialite=X` | Lance l'ingestion en arrière-plan, renvoie `202` + identifiant de job |
| GET    | `/admin/ingest/:id` | Avancement et rapport d'un job |
| GET    | `/admin/ingest` | Jobs récents + état des index par spécialité |

Authentification par en-tête `x-admin-token`, comparé à `ADMIN_TOKEN`. Les mêmes
routes existent sous `/api/admin/ingest`, par cohérence avec les autres routes
d'administration.

```bash
# Lancer une ingestion complète
curl -X POST "https://www.arkiba.fr/admin/ingest?specialite=dermatologie" \
  -H "x-admin-token: $ADMIN_TOKEN"

# Suivre l'avancement
curl "https://www.arkiba.fr/admin/ingest/<job-id>" -H "x-admin-token: $ADMIN_TOKEN"

# Rafraîchir une seule source, ou repartir d'un index vide
curl -X POST "…/admin/ingest?specialite=dermatologie&sources=sfd,has" -H "x-admin-token: $ADMIN_TOKEN"
curl -X POST "…/admin/ingest?specialite=dermatologie&reset=1"        -H "x-admin-token: $ADMIN_TOKEN"
```

Paramètres, en query string ou dans le corps JSON : `specialite` (requis),
`sources` (liste séparée par des virgules), `limit`, `reset`, `dryRun`.

**Pourquoi en arrière-plan** — une ingestion complète dépasse largement le délai
d'attente d'un proxy HTTP. La route rend la main immédiatement avec un
identifiant de job ; l'avancement se consulte sur `GET /admin/ingest/:id`. Un
`409` est renvoyé si une ingestion est déjà en cours sur la spécialité.

L'historique des jobs vit **en mémoire** (20 derniers) : il est perdu au
redémarrage du service. L'index, lui, est sur le volume — c'est ce qui compte.
Le serveur relit son index dès qu'il change sur le disque (contrôle de mtime) :
une ingestion terminée est prise en compte sans redémarrage.

> ⚠ **Sur Railway** : définissez `RAG_DIR` dans le volume persistant
> (ex. `RAG_DIR=/data/rag`), sinon l'index est perdu à chaque redéploiement.
> L'ingestion se lance depuis un shell sur le service, ou en local avec
> `RAG_DIR` pointé sur une copie, puis en synchronisant le dossier.

### Ajouter une spécialité

Une seule chose à modifier : ajouter une entrée dans `lib/specialites.js`
(libellé, collection, cadrage clinique, configuration des sources), puis lancer
l'ingestion. Le moteur RAG, la route API, le script d'ingestion et le front —
qui alimente son menu déroulant depuis `GET /api/avis-specialise/specialites` —
n'ont pas besoin d'être touchés. Un gabarit commenté figure en fin de fichier.

### Résumé actionnable

L'avis complet fait ~10 000 caractères : un document de fond. Le bouton
**Résumé** en produit une lecture rapide, pour le médecin entre deux
consultations, en quatre rubriques — hypothèse la plus probable et pourquoi,
autres pistes, ce qui peut être proposé, signaux d'alerte.

| | |
|---|---|
| Modèle | `claude-sonnet-4-6` — le raisonnement diagnostique est déjà fait, il ne reste qu'à condenser |
| Entrée | **le texte de l'avis uniquement** : aucune nouvelle recherche RAG |
| Longueur visée | 1 800 à 2 400 caractères (~300-380 mots), mesurée à ~2 350 en production |
| Renvois | les numéros `[n]` sont conservés, les sources restent affichées dans les deux vues |

Le prompt interdit d'ajouter la moindre hypothèse, examen ou produit absent du
texte d'origine, et impose de conserver les réserves : un résumé qui affirme ce
que l'avis nuançait serait faux tout en paraissant plus utile.

La longueur est contrainte par des **plafonds par rubrique** (3 phrases pour
l'hypothèse, 3 pistes, 5 propositions, 5 signaux d'alerte) et non par un nombre
de caractères : un modèle ne compte pas ses signes, et la consigne chiffrée seule
produisait des résumés 40 % trop longs. Les plafonds, eux, sont tenus.

**L'avis complet reste toujours accessible** (bouton « Voir le détail ») : c'est
lui qui porte le raisonnement et les renvois vers les sources. Les deux versions
sont éditables et les corrections du médecin sont conservées d'une vue à l'autre.

Le texte à résumer est envoyé par le client, qui l'a déjà en mémoire — cohérent
avec le principe du projet : aucune donnée patient n'est conservée côté serveur.

### Garde-fous

- Photos redimensionnées **sur l'appareil du médecin** (1568 px, JPEG q0.85) avant
  envoi ; validation serveur du type MIME, de l'encodage et de la taille.
- Corps de requête plafonné à 20 Mo sur cette route seule, 2 Mo partout ailleurs.
- Rate limit par utilisateur (les appels vision sur Opus sont coûteux).
- Le prompt impose de citer les extraits par numéro, de distinguer observation et
  interprétation, et de signaler explicitement ce que les sources ne couvrent pas.
- Produits et molécules cités **à titre documentaire entre confrères**, jamais
  sous forme de prescription, de posologie nominative ou de conseil au patient.
- Les sources consultées sont renvoyées au front et affichées sous l'avis, avec
  leur lien : le médecin peut remonter à l'original.
- Aucune donnée patient n'est stockée côté serveur, comme pour les autres modules.

## Modèle IA

`claude-sonnet-4-6` via le SDK Anthropic officiel pour la génération de documents.
L'avis spécialisé tourne sur `claude-opus-5` (raisonnement diagnostique + lecture
de photos). Les prompts système imposent :
- sortie en français, jamais de Markdown (`*`, `**`, `#`, tirets de liste),
- prose fluide pour les lettres, sections en majuscules + `:` pour les comptes-rendus,
- aucun champ vide entre crochets : si une info manque, elle est omise proprement.

## Sécurité

- Mots de passe hachés bcrypt.
- JWT signés, expiration configurable (`JWT_EXPIRES_IN`).
- Routes IA protégées par middleware `authenticateJWT`.
- Aucune donnée patient n'est stockée côté serveur : les documents générés restent
  sur l'appareil du médecin (localStorage).

## Déploiement Railway

`railway.json` décrit le build (Nixpacks), la commande de démarrage et la sonde
de santé. Railway injecte `PORT` : le serveur l'utilise déjà, rien à configurer.

### 1. Volume persistant — obligatoire

Le système de fichiers de Railway est éphémère : **sans volume, tous les comptes
médecins et tous les dossiers patients disparaissent à chaque redéploiement.**
Ce n'était qu'ennuyeux tant que l'historique vivait dans le navigateur ; depuis
que les dossiers patients sont côté serveur, c'est une perte de données
médicales.

1. Service → **Variables** → **Add Volume**, point de montage `/data`
2. Ajouter la variable `DATA_DIR=/data`
3. Ajouter `RAG_DIR=/data/rag` si la base de connaissances est utilisée

Fichiers écrits dans `DATA_DIR` : `users.json`, **`dossiers.json`**
(fiches patients + documents).

### 2. Variables d'environnement

| Variable | Obligatoire | Note |
| --- | --- | --- |
| `DATA_DIR` | oui | `/data` — sinon stockage éphémère |
| `JWT_SECRET` | oui | le serveur refuse de démarrer sans, en production |
| `ADMIN_TOKEN` | oui | idem |
| `ANTHROPIC_API_KEY` | oui | sans elle, la génération renvoie 503 |
| `APP_URL` | oui | URL publique — sert aux liens de réinitialisation et au CORS |
| `RAG_DIR` | si RAG | `/data/rag` |
| `SMTP_USER` / `SMTP_PASS` | non | mot de passe d'application Gmail, sans espaces |

### 3. Vérifier le déploiement

```bash
curl https://<votre-app>.up.railway.app/health
```

```json
{ "status": "ok", "ia": true,
  "stockage": { "chemin": "/data", "inscriptible": true, "persistant": true } }
```

`"persistant": false` signifie que `DATA_DIR` n'est pas défini : le volume n'est
pas pris en compte et les données seront perdues au prochain déploiement.

### Reprise des données existantes

Les fiches et l'historique créés avant la bascule serveur vivent dans le
`localStorage` du navigateur. Ils sont importés automatiquement à la première
ouverture de l'application, une seule fois par navigateur, sans doublon si
l'opération est rejouée. Rien à lancer à la main.

## Déploiement VPS

```bash
git clone <repo> && cd praxi
npm install --production
cp .env.example .env && nano .env   # renseigner les secrets
npm start

# Ou en arrière-plan avec screen
screen -S praxi
npm start
# Ctrl+A D pour détacher
```

## Abonnements

### Parcours d'inscription

Le formulaire de la page d'accueil (`#acces`) et `register.html` créent tous deux
un vrai compte via `POST /api/auth/register` et entrent **directement** dans
l'application avec le jeton renvoyé.

L'ancienne liste d'attente a été retirée : `POST /api/waitlist`, `GET /api/stats`,
`GET /api/admin/list`, `PATCH /api/admin/status/:id`, le fichier `waitlist.json`
et les statuts associés (`pending` / `invited` / `active` / `rejected`) n'existent
plus. Aucun compte n'y avait été enregistré. Un `waitlist.json` resté sur un
volume de production n'est plus lu par personne et peut être supprimé à la main.

### Plans

| Plan | Champ `plan` | Ce qui est ouvert |
|------|--------------|-------------------|
| Essai (15 jours) | `trial` | Lettre de liaison, compte-rendu, résumé, dictée et analyse clinique · **50 documents** · **10 dossiers patients** |
| Essai terminé | `free` | Lecture seule : l'historique et les dossiers restent consultables et supprimables, plus aucune génération |
| Arkiba Pro | `pro` | Tout l'essai sans plafond + MDPH, ALD, certificat, ordonnance, avis spécialisé · dossiers illimités |
| Arkiba Groupe | `groupe` | Identique à Pro (tarif par médecin) |
| Accès illimité | *(whitelist)* | Tout, sans abonnement ni paiement — voir ci-dessous |

Tout compte démarre sur `trial`. Les comptes créés avant l'introduction des plans
sont migrés à la première lecture et démarrent leur essai à ce moment-là
(et non à leur date d'inscription) : les inscrits de la bêta ne se réveillent pas
bloqués au lancement.

### Où le droit d'accès est décidé

`lib/plans.js` est la source unique. `server.js` place `exigerFonctionnalite()`
devant chaque route concernée, **avant** tout appel au modèle, et refuse avec un
`402` portant un `code` exploitable par le front :

| `code` | Signification |
|--------|---------------|
| `plan_required` | Module réservé à Arkiba Pro |
| `quota_exceeded` | Plafond de l'essai atteint (documents ou dossiers) |
| `trial_expired` | Période d'essai terminée, compte en lecture seule |

L'interface (`app.html`) ne fait que refléter `me.abonnement.fonctionnalites` :
retirer un cadenas depuis la console du navigateur ne débloque rien, la route
répond quand même `402`. `tests/abonnement.test.js` verrouille cet invariant en
appelant les routes payantes directement, sans passer par l'interface.

Le compteur de documents n'est incrémenté **qu'après une réponse acceptée** :
une génération qui échoue (erreur du modèle, validation) ne consomme rien.

### Comptes à accès illimité

Une whitelist d'emails donne accès à toutes les fonctionnalités, indépendamment
du statut d'abonnement : pas de paiement, pas de plafond, et **aucune session
Stripe n'est jamais créée** pour ces comptes (`/api/billing/checkout` répond
`400 compte_illimite` avant tout appel à Stripe).

- Le contrôle se fait sur **l'email du compte en base** (`users.json`), jamais
  sur un mot de passe ou un jeton écrit dans le code.
- Le mot de passe de ces comptes reste géré par l'authentification normale :
  la whitelist ouvre des fonctionnalités, pas la porte d'entrée.
- Le drapeau `illimite` stocké sur le compte est **recalculé à chaque lecture**
  à partir de la whitelist : le poser à la main en base sur un compte hors liste
  ne donne rien, et retirer un email de la liste retire l'accès.

Liste par défaut : `benarken@yahoo.com`, `sbh75@gmx.fr`.
Surchargeable par `ARKIBA_ADMIN_EMAILS` (emails séparés par des virgules).

### Stripe

Clés uniquement en variables d'environnement (voir `.env.example`) :
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`,
`STRIPE_PRICE_GROUPE`. Sans `STRIPE_SECRET_KEY`, l'application tourne
normalement et les routes de paiement répondent `503` — le lancement ne dépend
donc pas de l'activation du paiement.

Le paiement passe par **Stripe Checkout hébergé** : aucun numéro de carte ne
transite par Arkiba. Le webhook `/api/stripe/webhook` reçoit le corps brut
(exception au parseur JSON global) et vérifie la signature ; un événement mal
signé est rejeté sans être lu.

Événements traités → effet sur le champ `plan` / `planStatus` :

| Événement | Effet |
|-----------|-------|
| `checkout.session.completed` | Lit l'abonnement créé → `pro`/`groupe`, `active` |
| `customer.subscription.created` / `.updated` / `.resumed` / `.paused` | Formule et statut réalignés (upgrade, downgrade, résiliation programmée) |
| `customer.subscription.deleted` | Retour à `free`, statut `canceled` |
| `invoice.payment_failed` | Statut `past_due` → l'accès payant se ferme |
| `invoice.paid` / `invoice.payment_succeeded` | Statut `active` → l'accès rouvre |

Le compte visé est retrouvé par `stripe.customerId`, puis par l'identifiant
Arkiba placé en métadonnée à la création de la session, puis par email. Un
événement sans compte correspondant est journalisé et acquitté (un `5xx` le
ferait rejouer pendant des jours) ; une vraie erreur de traitement rend un `500`
pour que Stripe rejoue.

### Recette en mode test, puis bascule en production

```bash
# 1. Clés de test
export STRIPE_SECRET_KEY=sk_test_...
export STRIPE_PRICE_PRO=price_...        # tarif récurrent 89 €/mois créé en mode test

# 2. Rediriger les webhooks vers le serveur local
stripe listen --forward-to localhost:3001/api/stripe/webhook
# → recopier le whsec_... affiché
export STRIPE_WEBHOOK_SECRET=whsec_...

npm start
```

À vérifier, dans l'ordre :

1. `GET /health` → `facturation.active: true`, `facturation.webhook: true`, `plans: ["pro"]`.
2. Créer un compte depuis la page d'accueil → l'application s'ouvre directement, badge « Essai ».
3. Ouvrir **Abonnement** → « Passer à Arkiba Pro » → payer avec `4242 4242 4242 4242`
   (date future, CVC quelconque) → retour sur l'application, badge « Arkiba Pro »
   après quelques secondes, modules MDPH/ALD/certificat/ordonnance/avis déverrouillés.
4. Échec de paiement : carte `4000 0000 0000 0341` → le compte repasse en accès
   restreint après l'événement `invoice.payment_failed`.
5. Résiliation depuis « Gérer mon abonnement » → à la fin de la période,
   `customer.subscription.deleted` ramène le compte en lecture seule.
6. Se connecter avec un email de la whitelist → écran Abonnement sans aucun
   bouton de paiement, toutes les fonctionnalités ouvertes.

Bascule en production : recréer le produit et le tarif **en mode Live**, créer un
endpoint webhook Live pointant sur `https://www.arkiba.fr/api/stripe/webhook`
(avec les événements du tableau ci-dessus), puis remplacer les quatre variables
par leurs équivalents Live sur l'hébergeur. Aucun changement de code.
