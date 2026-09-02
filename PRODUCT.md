# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Cible produit — médecins libéraux français, généralistes comme spécialistes.**
Le registre fermé servi par `GET /api/specialites` compte 46 libellés, et tous
sont des cibles réelles.

Situation : exercice libéral, charge documentaire subie en marge du soin —
lettres d'adressage, comptes rendus, dossiers MDPH/ALD, certificats — souvent
rédigés après la dernière consultation. Le travail à faire : produire un
document exact, signable, à partir de notes brutes ou dictées, sans devoir le
relire ligne à ligne pour y traquer une invention.

**Terrain pilote (confirmé, à ne pas généraliser) :** les spécialités à
préconsultation, interrogatoire patient et forte charge documentaire.
**L'anesthésie est aujourd'hui le terrain pilote principal** — le serveur porte
un modèle de questions pré-anesthésiques dédié (`server.js:1147`) et des
déductions périopératoires (`server.js:1523`).

**Contrainte d'expression qui découle de ce périmètre :** aucune page ne doit
laisser entendre qu'Arkiba est déjà validé dans toutes les spécialités. Cible
large, preuve étroite : les deux doivent rester distinguables. Réciproquement,
Arkiba ne doit pas être présenté comme un produit d'anesthésie.

## Product Purpose

Assistant médico-administratif qui transforme des notes brutes (saisies ou
dictées) en documents médicaux structurés : lettre de liaison, compte rendu de
consultation, résumé de document, dossier MDPH, ALD, certificat, ordonnance, et
avis spécialisé sourcé.

Le succès n'est pas « un document généré » : c'est un document que le médecin
relit, reconnaît comme le sien, signe et envoie — sans avoir eu à vérifier
chaque phrase contre la source.

## Positioning

**Le mécanisme est le refus de produire quand la matière manque.** C'est le
point qu'un produit voisin ne peut pas copier en le déclarant :

- **Bouclier clinique explicable** — avant chaque génération, la revue affiche
  séparément les faits présents dans la source, les déductions prudentes, les
  informations manquantes, les incohérences à vérifier, et les suggestions.
  **Les suggestions ne sont intégrées qu'après validation explicite du médecin.**
- **Contrat anti-hallucination imposé côté serveur**, à tous les générateurs,
  avec signalement des valeurs numériques sans correspondance directe dans la
  source.
- **Avis spécialisé réellement indexé** — la route interroge une base médicale
  ingérée. Sans base indexée, elle répond `503` plutôt que de produire un avis
  qui aurait l'apparence d'être sourcé sans l'être.
- **Les droits d'accès sont décidés côté serveur** (`lib/plans.js`), avant tout
  appel au modèle. Retirer un cadenas depuis la console du navigateur ne
  débloque rien : la route répond `402`.

## Operating Context

- Exercice libéral ; rédaction souvent reportée en fin de journée.
- Authentification JWT ; jeton dans `localStorage['praxi_token']`, profil dans
  `localStorage['praxi_profil']`.
- Le profil médecin (prénom, nom, spécialité, adresse, RPPS) est injecté dans
  le system prompt : aucun champ vide entre crochets dans le document rendu.
- Dictée vocale Web Speech API (fr-FR), avec repli clavier garanti et message
  explicite en cas de panne micro — jamais de blocage silencieux.
- Sortie : copier, `.txt`, PDF (jsPDF), historique local (50 documents, FIFO).
- Préconsultation : parcours `encounters` avec revue champ par champ, puis
  transfert (`/api/preconsult/*`).
- Connexion Doctolib (`POST /api/integrations/doctolib`).
- Deux surfaces : la vitrine `public/index.html` (www.arkiba.fr) et
  l'application `public/app.html`.

## Capabilities and Constraints

**Formules** (source unique : `lib/plans.js`) :

| Formule | Ce qui est ouvert |
|---|---|
| Essai (15 j) | liaison, compte rendu, résumé, dictée, analyse clinique · 50 documents · 10 dossiers |
| Essai terminé (`free`) | lecture seule : consultation et suppression, plus aucune génération |
| Pro — 89 €/mois, sans engagement | tout l'essai sans plafond + MDPH, ALD, certificat, ordonnance, avis spécialisé |
| Groupe — 69 €/médecin | identique à Pro |
| Accès illimité | whitelist d'emails, jamais facturée |

- Refus explicites côté serveur : `plan_required`, `quota_exceeded`,
  `trial_expired` (tous en `402`).
- Sans clé Stripe, le paiement est fermé (`503`) ; le reste fonctionne.
- **RAG : seule la dermatologie est indexée à ce jour.** L'extension aux
  comptes rendus et lettres de liaison est un objectif, pas un fait.
- Liste des spécialités : **jamais écrite en dur** dans une page. Une copie
  figée dans `register.html` avait divergé du serveur et faisait échouer
  *toutes* les inscriptions ; `tests/specialites.test.js` verrouille l'invariant.
- Stack existante : Node ≥ 20, Express, pages statiques dans `public/`, API
  Anthropic, déploiement Railway. Pas de framework front.
- Héritage de nommage : l'ancien nom `praxi` persiste dans les clés
  localStorage et certains chemins. Le renommer casserait les sessions en cours.

## Brand Commitments

- Nom : **Arkiba** ; signature « Arkiba. » avec le point. Domaine `arkiba.fr`,
  contact `contact@arkiba.fr`.
- Langue : **français**, intégralement — interface, documents, messages
  d'erreur, code et commentaires du dépôt.
- Voix : sobre, factuelle, sans superlatif commercial. Les messages d'erreur du
  serveur sont affichés tels quels, dans un bandeau — jamais en `alert()`.
- Monde visuel incumbent (« nuit clinique ») : encre nocturne, lumière
  glaciaire, or réservé aux sources, typographie serif éditoriale, panneaux de
  verre, ligne ECG. Thème sombre par défaut, `praxi_theme = 'light'` pour en
  sortir. *(Consigné comme fait constaté, pas comme prescription : les décisions
  visuelles appartiennent au travail de design, pas à ce document.)*
- Obligation légale : mentions légales, CGU et politique de confidentialité
  sont des pages réelles et doivent le rester — pas des ancres décoratives.

## Evidence on Hand

**Il n'existe aujourd'hui aucune preuve sociale utilisable. Ne rien fabriquer.**

- Les quatre témoignages de la vitrine (Dr Marie L. — Reims, Dr Antoine P. —
  Strasbourg, Dr Sophie C. — Nantes, Dr Julien D. — Paris) sont **des
  placeholders inventés**. Aucun n'est un utilisateur réel.
- Les chiffres du bandeau (**54 h, 5 h 30, 18 min, 3 min**) ne reposent sur
  **aucune mesure**.
- **« Hébergement HDS certifié, France » est un objectif, pas un fait acquis.**
  La certification n'est pas obtenue ; le déploiement est sur Railway. Aucune
  page ne doit l'affirmer au présent tant que ce n'est pas vrai. La mention
  figure actuellement à deux endroits de `public/index.html` (l. 723 et 1000),
  ainsi que la revendication « Chiffrement AES-256 / TLS 1.3 », non vérifiée.
- L'argument « amorti en X actes à 30 € » est un calcul, pas une observation.

Preuves réelles, vérifiables et disponibles :

- `docs/cablage-refonte.md` — contrat de câblage vérifié en navigateur réel :
  **64/64 contrôles applicatifs, 31/31 contrôles vitrine**, cibles tactiles
  toutes ≥ 44 px mesurées à 834 px de large.
- Suite de tests : **236 tests au vert**, dont `tests/abonnement.test.js` qui
  appelle les routes payantes sans passer par l'interface.
- Base dermatologie réellement ingérée (PubMed, HAS, SFD, BDPM).

## Product Principles

1. **Ne jamais produire ce qu'on ne peut pas sourcer.** Le `503` de l'avis
   spécialisé et le signalement des chiffres sans correspondance sont la même
   règle appliquée deux fois. Une page qui promet plus que ça trahit le produit.
2. **Le médecin garde la main.** Rien n'entre dans un document sans sa
   validation explicite ; l'historique et les dossiers ne sont jamais pris en
   otage, même après l'essai.
3. **Le serveur décide, l'interface reflète.** Aucun droit, aucun quota, aucune
   liste métier ne vit dans une page.
4. **Cible large, preuve étroite — et la différence reste visible.** Les
   spécialités pilotes ne se déguisent pas en couverture générale.
5. **Aucune revendication décorative.** Certifications, chiffres et témoignages
   n'apparaissent que s'ils existent.

## Accessibility & Inclusion

- Toutes les cibles tactiles visibles sont à **44 × 44 px minimum** (vérifié en
  834 px) ; les deux défauts de l'ancienne vitrine sont corrigés.
- La dictée n'est jamais un passage obligé : le repli clavier fonctionne seul,
  et tout échec micro produit un message explicite.
- **Ouvert :** aucune obligation RGAA ni niveau WCAG cible n'a été établi pour
  ce produit. À trancher si un marché public ou une structure publique entre au
  périmètre.
