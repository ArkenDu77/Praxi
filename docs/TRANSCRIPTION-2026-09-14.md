# Transcription de consultation — 14 septembre 2026

## Diagnostic confirmé dans le code

Base inspectée : Praxi `60ed66e21d3be48cfafb6f4847336ebbcae45ef7`.
La dictée utilise `SpeechRecognition` / `webkitSpeechRecognition` dans le navigateur.
Il n'existe pas de websocket STT applicatif ni de MediaRecorder dans ce chemin initial.

Quatre causes de perte/coupure sont confirmées dans l'ancien `toggleMic` de `public/app.html` :

1. `network` posait `manualStop = true` : une indisponibilité ponctuelle du service arrêtait définitivement la dictée.
2. `state.restarts < 60` imposait un plafond cumulatif : après 60 fins de session navigateur, arrêt sans alerte, indépendamment de la durée de consultation.
3. `onend` ne consolidait que `sessionFinal` et réécrivait le champ : le texte provisoire déjà visible disparaissait.
4. L'erreur disparaissait après neuf secondes. L'échec initial de `rec.start()` laissait aussi le listener de saisie attaché.

Ces mécanismes reproduisent les classes de panne décrites. Sans télémétrie des dix consultations réelles, on ne peut pas attribuer chaque incident passé à un de ces quatre mécanismes.

Preuve structurelle parent : Tier Verify, projet `C-Users-Ken-Desktop-Praxi`, génération `2026-08-30T20:55:02Z`, métadonnées périmées. Le graphe ne couvrait pas la logique JS embarquée utile. Les fonctions manipulées ont été lues directement ; un résultat de couverture `no_recorded_issue` n'a pas été interprété comme une preuve d'exhaustivité.

## Correctif

- Contrôleur indépendant `public/transcription.js` : états starting/listening/reconnecting/offline/error/stopped, instances retirées avant reprise, rejet des callbacks obsolètes.
- Reprise déclenchée par événements, sans plafond arbitraire. Backoff 250 ms → 10 s sur échecs répétés, réinitialisé lors des résultats. Le silence normal ne cumule pas de backoff long.
- Deadline de démarrage de 10 s ; deadline de santé de 45 s renouvelée par les événements du service. Une instance muette est arrêtée avant reconnexion. Le timer de durée sert uniquement à l'affichage et ne démarre jamais la reconnaissance.
- Les frappes gardent priorité. La dernière hypothèse visible survit à une coupure et est signalée comme à relire.
- Erreurs persistantes, compteur de consultation, durées de coupure cumulées, avertissement de mise en arrière-plan.
- Capture MediaRecorder indépendante, chunks de 1 s, débit demandé 32 kbit/s. Audio uniquement en mémoire de l'onglet, sans stockage serveur, IndexedDB ou localStorage. Budget commun de 64 Mio pour toutes les archives, avertissement à 80 %, arrêt explicite du secours si plein ; les anciens fichiers ne sont pas évincés.
- L'audio survit à l'arrêt et au redémarrage de la dictée. Téléchargement et suppression demandent un clic explicite. La fermeture/recharge de l'onglet prévient du travail/audio restant. Une permission microphone encore en attente ne peut pas laisser un flux orphelin après l'arrêt.

Le fichier de secours **n'est pas retranscrit automatiquement** : Web Speech n'accepte pas la réinjection de chunks audio. Le produit affiche cette limite pendant les coupures et après l'arrêt. Il n'affiche pas « audio conservé » si la capture n'a pas réellement démarré.

## Résultats mesurés

Commande : `node node_modules/jest/bin/jest.js tests/transcription.test.js --runInBand --detectOpenHandles`

**22/22 tests PASS**, sans handle ouvert signalé.

| Mesure | Résultat |
|---|---:|
| Durée du banc de transcription simulée | 3 600 000 ms (60 min) |
| Phrases synthétiques reçues / conservées exactement une fois | 360 / 360 |
| Reprises automatiques | 360 |
| Coupures `network` forcées, sans événement `end` | 51 / 51 reprises |
| Fins provisoires conservées | 32 / 32 |
| Note tapée pendant la dictée | Conservée |
| Indisponibilité STT cumulée, affichée | 90 000 ms |
| Arrêt silencieux définitif du contrôleur | 0 |
| Chunks audio synthétiques conservés sur un second banc | 3 600 |
| Taille du secours audio synthétique à l'arrêt | 14 400 000 octets |
| Cycles de silence sans inflation du backoff | 120 / 120 |

Autres cas : permission refusée, micro retiré, service qui ne démarre pas, start qui lève, callbacks obsolètes, connexion absente deux minutes puis retour, deadline d'inactivité, stop pendant retry, quota global de mémoire, dernier chunk arrivant après stop, permission résolue après stop et suppression explicite.

Commande navigateur : `node scripts/test-transcription-browser.js` (Playwright fourni par le checkout doctolib-lab voisin, configurable avec `PLAYWRIGHT_MODULE`).

**Vrais clics navigateur PASS** sur Microsoft Edge `152.0.4191.66`, page application complète, zéro exception JS. Le service SpeechRecognition est simulé ; **MediaRecorder et le micro synthétique Chromium sont réels**. 2 167 octets audio avaient été effectivement reçus avant le clic Arrêter lors de ce passage. L'évidence structurée est `docs/transcription-browser-2026-09-14.json`.

Parcours : clic Consultation → clic Commencer → saisie de notes → clic micro → résultat provisoire → frappe pendant écoute → coupure réseau forcée → reprise automatique → nouvelle phrase → clic Arrêter → clic Télécharger (événement réel de téléchargement) → reprise → permission refusée → vérification de l'erreur après 10 secondes → clic Supprimer.

Toutes les routes non locales sont bloquées dans ce banc. Les API sont simulées. Aucun patient réel ni appel fournisseur n'a été utilisé.

## Limites et critères de fin

- `TRANSCRIPTION_CONTINUE_60_MIN_SIMULATION = PASS` pour le contrôleur, avec 360 reprises visibles et conservation des résultats fournis.
- `STT_AUTO_RECOVERY_SIMULATION = PASS`.
- `TRANSCRIPTION_CONTINUE_60_MIN_REAL_PROVIDER = NOT_VERIFIED`.
- `NO_SPEECH_LOSS_DURING_STT_OUTAGE = NOT_PROVEN` : le banc injecte les résultats quand le service est connecté ; il ne prouve pas une retranscription de paroles prononcées pendant la coupure. Le secours audio permet une récupération manuelle, lorsque disponible.
- `REAL_BROWSER_TRANSCRIPTION_INTERACTION = PASS` avec service simulé et capture native.
- `NO_REAL_PATIENT_USED = PASS` ; `NO_UNAUTHORIZED_REAL_CALL = PASS`.

Une garantie complète de consultation sans perte exige un transport STT acceptant les chunks, des accusés de traitement et une reprise avec séquences/offsets. Il faudra choisir/configurer ce fournisseur dans le cadre d'hébergement santé prévu, puis tester une heure de signal synthétique à débit réel avec panne réseau et replay. Ce correctif ne constitue pas cette migration et n'annonce pas le produit prêt pour la production.

Le navigateur peut suspendre un onglet ou un appareil en veille : aucune logique JavaScript ne peut enregistrer pendant une suspension système. L'avertissement de visibilité et la reprise au retour ne constituent pas une garantie contre cette suspension.

## Intégration

Lot initial : `public/app.html`, nouveau `public/transcription.js`, `tests/transcription.test.js`, `scripts/test-transcription-browser.js`, ce rapport et son JSON de preuve. Aucun changement serveur ni secret. Le parent reprend ensuite `app.html` pour l'UX clinique et réalise les commits/déploiements.
