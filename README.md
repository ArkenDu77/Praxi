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
├── server.js                            ← Backend Express
├── waitlist.json                        ← Inscriptions waitlist
├── users.json                           ← Comptes médecins (créé au 1er register)
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

Chaque route protégée attend l'en-tête `Authorization: Bearer <token>`.
Le profil du médecin (prénom, nom, spécialité, adresse, RPPS…) est automatiquement
injecté dans le system prompt — aucun champ vide entre crochets n'apparaît dans le document.

### Admin

| Méthode | Route | Description |
|---------|-------|-------------|
| GET    | `/api/admin/list` | Liste complète des inscrits waitlist |
| PATCH  | `/api/admin/status/:id` | Changer le statut d'un inscrit |

```bash
curl http://localhost:3001/api/admin/list -H "x-admin-token: praxi-admin-dev"

curl -X PATCH http://localhost:3001/api/admin/status/1 \
  -H "x-admin-token: praxi-admin-dev" \
  -H "Content-Type: application/json" \
  -d '{"status":"invited"}'
```

## Fonctionnalités de l'application (`/app.html`)

- **Authentification JWT** — vérification au chargement, redirection vers `/login.html` si absent ou expiré.
- **Sidebar** — logo, nom du médecin, 3 modules, historique, profil, déconnexion.
- **3 modules** — lettre de liaison, compte-rendu de consultation, résumé de document (.txt / .pdf via pdf.js).
- **Dictée vocale** — Web Speech API (fr-FR), bouton micro sur chaque champ notes, indicateur rouge pulsant.
- **Modèles par spécialité** — pré-remplissage adapté du champ notes selon la spécialité destinataire ; le serveur ajuste légèrement le prompt en conséquence.
- **Export** — Copier, télécharger `.txt`, télécharger PDF (jsPDF), sauvegarder dans l'historique.
- **Historique local** — 50 documents max en localStorage, FIFO, réouverture / suppression.
- **Profil médecin** — synchronisé avec le serveur (`PATCH /api/auth/profile`) et préfixé en en-tête de chaque document généré.
- **Import Doctolib (simulation)** — modale dédiée, données fictives, mention claire « Mode simulation ».

## Modèle IA

`claude-sonnet-4-6` via le SDK Anthropic officiel. Les prompts système imposent :
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
