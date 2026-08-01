# Praxi — Stack technique

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
├── waitlist.json                        ← Inscriptions waitlist
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
```

## API

### Waitlist (public)

| Méthode | Route | Description |
|---------|-------|-------------|
| POST   | `/api/waitlist` | Inscription liste d'attente |
| GET    | `/api/stats` | Stats publiques (total inscrits) |

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

Chaque route protégée attend l'en-tête `Authorization: Bearer <token>`.
Le profil du médecin (prénom, nom, spécialité, adresse, RPPS…) est automatiquement
injecté dans le system prompt — aucun champ vide entre crochets n'apparaît dans le document.

### Admin

| Méthode | Route | Description |
|---------|-------|-------------|
| GET    | `/api/admin/list` | Liste complète des inscrits waitlist |
| PATCH  | `/api/admin/status/:id` | Changer le statut d'un inscrit |
| POST   | `/admin/ingest?specialite=X` | Lancer l'ingestion d'une spécialité (voir section RAG) |
| GET    | `/admin/ingest/:id` | Avancement d'un job d'ingestion |
| GET    | `/admin/ingest` | Jobs récents + état des index |

```bash
curl http://localhost:3001/api/admin/list -H "x-admin-token: praxi-admin-dev"

curl -X PATCH http://localhost:3001/api/admin/status/1 \
  -H "x-admin-token: praxi-admin-dev" \
  -H "Content-Type: application/json" \
  -d '{"status":"invited"}'
```

## Fonctionnalités de l'application (`/app.html`)

### Bouclier clinique V2

Avant chaque génération, Praxi effectue une revue clinique explicable et affiche séparément :

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
curl -X POST "https://praxi.up.railway.app/admin/ingest?specialite=dermatologie" \
  -H "x-admin-token: $ADMIN_TOKEN"

# Suivre l'avancement
curl "https://praxi.up.railway.app/admin/ingest/<job-id>" -H "x-admin-token: $ADMIN_TOKEN"

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

## Statuts waitlist

- `pending` → inscrit, pas encore invité
- `invited` → email d'invitation envoyé
- `active`  → compte créé
- `rejected` → refusé (hors cible)
