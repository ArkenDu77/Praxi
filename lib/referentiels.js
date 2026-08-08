// ─── Référentiels documentaires par spécialité ──────────────────────────────
//
// Pourquoi ce fichier existe
// --------------------------
// Jusqu'ici, la structure d'un compte-rendu et les repères chiffrés qu'il
// mobilise (seuils de scores, cibles thérapeutiques, rythme de surveillance)
// étaient laissés au modèle : c'est exactement le « prompting seul » qu'Arkiba
// doit dépasser. Un modèle qui produit « HbA1c cible < 7 % » le fait de mémoire,
// sans que rien ne garantisse la valeur ni ne permette de la vérifier.
//
// Ici, ces données sont figées dans une table citable. Le prompt ne demande plus
// au modèle de connaître les seuils : il les lui fournit, avec leur source. Et
// ce qui manque dans les notes du médecin est calculé par comparaison à cette
// table — donc signalé comme manquant, jamais comblé par une valeur inventée.
//
// Ce que ce fichier n'est PAS
// ---------------------------
// Ce n'est pas une base de recommandations exhaustive et ce n'est pas un
// dispositif d'aide à la décision. C'est le squelette documentaire attendu d'un
// compte-rendu de la spécialité, avec les repères que le médecin doit avoir
// sous les yeux. La décision reste au médecin.
//
// Ajouter une spécialité = ajouter une entrée. `cles` liste les libellés du
// menu d'inscription qui doivent y être rattachés (voir SPECIALITES côté
// server.js).

const REFERENTIELS = {
  // ── Médecine générale ─────────────────────────────────────────────────────
  generaliste: {
    key: 'generaliste',
    label: 'Médecine générale',
    cles: ['médecin généraliste', 'généraliste', 'medecin generaliste'],
    source: {
      libelle: 'HAS — Consultation de médecine générale, structuration du dossier patient',
      url: 'https://www.has-sante.fr/jcms/c_1761912/fr/dossier-patient-en-medecine-generale',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'HISTOIRE DE LA MALADIE',
      'EXAMEN CLINIQUE ET CONSTANTES',
      'DIAGNOSTIC / IMPRESSION CLINIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    // Repères chiffrés fournis au modèle plutôt que rappelés de mémoire.
    reperes: [
      { nom: 'Pression artérielle', valeur: 'cible < 140/90 mmHg en consultation ; < 135/85 en automesure' },
      { nom: 'IMC', valeur: 'surpoids ≥ 25 ; obésité ≥ 30 kg/m²' },
      { nom: 'Fréquence cardiaque de repos', valeur: 'normale 60–100 /min' },
      { nom: 'SpO2', valeur: 'normale ≥ 95 % en air ambiant' },
    ],
    // Éléments dont l'absence dans les notes est signalée au médecin.
    attendus: [
      { cle: 'constantes',  libelle: 'Constantes (PA, FC, poids)', motifs: [/\bPA\b|tension|pression art/i, /\bFC\b|pouls|fréquence card/i, /poids|\bkg\b/i] },
      { cle: 'motif',       libelle: 'Motif de consultation explicite', motifs: [/motif|consulte pour|vient pour|se présente/i] },
      { cle: 'traitement',  libelle: 'Traitement en cours ou prescrit', motifs: [/traitement|ttt|prescription|mg\b|posologie/i] },
      { cle: 'suivi',       libelle: 'Délai de réévaluation / suivi', motifs: [/revoir|réévalu|contrôle|suivi|consultation dans/i] },
    ],
    alertes: [
      'Douleur thoracique, dyspnée aiguë, déficit neurologique brutal : orientation urgente.',
      'Fièvre + purpura, céphalée brutale en coup de tonnerre : urgence absolue.',
    ],
  },

  // ── Cardiologie ───────────────────────────────────────────────────────────
  cardiologie: {
    key: 'cardiologie',
    label: 'Cardiologie',
    cles: ['cardiologue', 'cardiologie'],
    source: {
      libelle: 'HAS — Guide parcours de soins insuffisance cardiaque ; fibrillation atriale',
      url: 'https://www.has-sante.fr/jcms/p_3308377/fr/guide-du-parcours-de-soins-insuffisance-cardiaque',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'ANTÉCÉDENTS ET FACTEURS DE RISQUE CARDIOVASCULAIRE',
      'EXAMEN CLINIQUE ET CONSTANTES',
      'EXAMENS COMPLÉMENTAIRES',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'NYHA', valeur: 'I aucune limitation — II limitation légère — III limitation marquée — IV symptômes au repos' },
      { nom: 'CHA2DS2-VASc', valeur: 'anticoagulation recommandée si ≥ 2 chez l\'homme, ≥ 3 chez la femme' },
      { nom: 'HAS-BLED', valeur: 'risque hémorragique élevé si ≥ 3 — impose vigilance, jamais contre-indication seule' },
      { nom: 'FEVG', valeur: 'altérée ≤ 40 % — légèrement altérée 41–49 % — préservée ≥ 50 %' },
      { nom: 'LDL-c', valeur: 'cible < 0,55 g/L si risque très élevé ; < 0,70 g/L si risque élevé' },
    ],
    attendus: [
      // « tabagique » et « fumeur » sont plus fréquents sous la plume d'un
      // médecin que « tabac » : la racine seule laissait passer le cas courant.
      { cle: 'fdrcv',     libelle: 'Facteurs de risque cardiovasculaire', motifs: [/tabac|tabagi|fumeu|diabèt|hta\b|hypertension|cholest|hérédit|dyslipid|obésit|surpoids/i] },
      { cle: 'ecg',       libelle: 'ECG et son interprétation', motifs: [/\becg\b|électrocardio/i] },
      { cle: 'nyha',      libelle: 'Stade NYHA si dyspnée', motifs: [/nyha|dyspnée|essoufflement/i] },
      { cle: 'constantes', libelle: 'PA et FC', motifs: [/\bPA\b|tension|pression art/i] },
      { cle: 'traitement', libelle: 'Traitement cardiovasculaire et tolérance', motifs: [/bêtabloq|betabloq|iec\b|ara2|sartan|statine|anticoag|diuréti/i] },
    ],
    alertes: [
      'Douleur thoracique typique, syncope d\'effort, dyspnée de repos : avis urgent.',
      'FA récente non anticoagulée avec CHA2DS2-VASc élevé : ne pas différer.',
    ],
  },

  // ── Diabétologie / endocrinologie ─────────────────────────────────────────
  diabetologie: {
    key: 'diabetologie',
    label: 'Diabétologie — endocrinologie',
    cles: ['diabétologue', 'endocrinologue', 'diabetologue', 'endocrinologie', 'diabétologie'],
    source: {
      libelle: 'HAS — Guide parcours de soins diabète de type 2 de l\'adulte',
      url: 'https://www.has-sante.fr/jcms/p_3316232/fr/guide-parcours-de-soins-diabete-de-type-2-de-l-adulte',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'ANCIENNETÉ DU DIABÈTE ET TRAITEMENT ACTUEL',
      'ÉQUILIBRE GLYCÉMIQUE',
      'DÉPISTAGE DES COMPLICATIONS',
      'EXAMEN CLINIQUE ET CONSTANTES',
      'OBJECTIFS THÉRAPEUTIQUES',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'HbA1c', valeur: 'cible générale ≤ 7 % ; ≤ 6,5 % si diabète récent sans comorbidité ; ≤ 8 % si comorbidités ou sujet âgé fragile' },
      { nom: 'Rythme HbA1c', valeur: 'tous les 3 mois ; tous les 6 mois si objectif atteint et stable' },
      { nom: 'Fond d\'œil', valeur: 'annuel ; espacement possible à 2 ans si équilibre et absence de rétinopathie' },
      { nom: 'Microalbuminurie / créatininémie', valeur: 'annuelles (rapport albuminurie/créatininurie)' },
      { nom: 'Examen des pieds', valeur: 'annuel au minimum, gradation du risque podologique 0 à 3' },
      { nom: 'Bilan lipidique', valeur: 'annuel ; LDL-c cible selon niveau de risque cardiovasculaire' },
    ],
    attendus: [
      { cle: 'hba1c',     libelle: 'HbA1c datée', motifs: [/hba1c|hémoglobine glyqu|hemoglobine glyqu/i] },
      { cle: 'complications', libelle: 'Dépistage des complications (œil, rein, pied, cœur)', motifs: [/fond d.?œil|fo\b|rétinopath|albuminur|créatinin|pied|neuropath/i] },
      { cle: 'traitement', libelle: 'Traitement antidiabétique et tolérance', motifs: [/metformine|insulin|glp|sglt|sulfamide|antidiabét/i] },
      { cle: 'poids',     libelle: 'Poids / IMC', motifs: [/poids|imc|\bkg\b/i] },
      { cle: 'hygiene',   libelle: 'Mesures hygiéno-diététiques', motifs: [/diétét|activité physique|alimentation|hygiéno/i] },
    ],
    alertes: [
      'Hypoglycémies sévères répétées : réévaluation thérapeutique sans délai.',
      'Plaie du pied chez un diabétique : avis spécialisé rapide, risque d\'amputation.',
    ],
  },

  // ── Pneumologie ───────────────────────────────────────────────────────────
  pneumologie: {
    key: 'pneumologie',
    label: 'Pneumologie',
    cles: ['pneumologue', 'pneumologie'],
    source: {
      libelle: 'HAS — Guide parcours de soins BPCO ; asthme de l\'adulte',
      url: 'https://www.has-sante.fr/jcms/p_3163037/fr/guide-du-parcours-de-soins-bronchopneumopathie-chronique-obstructive-bpco',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'ANTÉCÉDENTS RESPIRATOIRES ET EXPOSITIONS',
      'EXAMEN CLINIQUE ET CONSTANTES',
      'EXPLORATION FONCTIONNELLE RESPIRATOIRE',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'Diagnostic BPCO', valeur: 'VEMS/CVF < 0,70 après bronchodilatateur' },
      { nom: 'Sévérité BPCO (GOLD)', valeur: 'I VEMS ≥ 80 % — II 50–79 % — III 30–49 % — IV < 30 % de la théorique' },
      { nom: 'mMRC', valeur: '0 dyspnée à l\'effort intense — 4 dyspnée au moindre effort / habillage' },
      { nom: 'Contrôle de l\'asthme', valeur: 'évalué sur 4 semaines : symptômes diurnes, nocturnes, recours au traitement de secours, limitation d\'activité' },
      { nom: 'SpO2', valeur: 'normale ≥ 95 % ; oxygénothérapie discutée si PaO2 ≤ 55 mmHg' },
    ],
    attendus: [
      { cle: 'tabac',   libelle: 'Statut tabagique et exposition professionnelle', motifs: [/tabac|tabagi|fume|fumeu|paquet|amiante|exposition|sevrage/i] },
      { cle: 'efr',     libelle: 'EFR / spirométrie', motifs: [/efr|spiromét|vems|cvf|débit de pointe|dep\b/i] },
      { cle: 'dyspnee', libelle: 'Quantification de la dyspnée (mMRC)', motifs: [/mmrc|dyspnée|essoufflement/i] },
      { cle: 'exacerbations', libelle: 'Nombre d\'exacerbations sur 12 mois', motifs: [/exacerbation|décompensation|crise/i] },
      { cle: 'traitement', libelle: 'Traitement inhalé et technique de prise', motifs: [/inhal|bronchodilat|corticoïde|salbutamol|spray|chambre/i] },
    ],
    alertes: [
      'Dyspnée aiguë avec SpO2 < 90 %, cyanose, épuisement respiratoire : urgence.',
      'Hémoptysie, altération de l\'état général chez un fumeur : imagerie sans délai.',
    ],
  },

  // ── Rhumatologie ──────────────────────────────────────────────────────────
  rhumatologie: {
    key: 'rhumatologie',
    label: 'Rhumatologie',
    cles: ['rhumatologue', 'rhumatologie'],
    source: {
      libelle: 'HAS — Polyarthrite rhumatoïde : diagnostic et prise en charge ; lombalgie commune',
      url: 'https://www.has-sante.fr/jcms/c_1751215/fr/polyarthrite-rhumatoide',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'HISTOIRE DE LA MALADIE ET RETENTISSEMENT',
      'EXAMEN ARTICULAIRE',
      'EXAMENS COMPLÉMENTAIRES',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'DAS28', valeur: 'rémission < 2,6 — activité faible 2,6–3,2 — modérée 3,2–5,1 — forte > 5,1' },
      { nom: 'Rythme inflammatoire', valeur: 'réveil nocturne, dérouillage matinal > 30 min — oriente vers une origine inflammatoire' },
      { nom: 'Drapeaux rouges lombalgie', valeur: 'âge < 20 ou > 55 ans, traumatisme, cancer, corticothérapie, fièvre, déficit neurologique, altération de l\'état général' },
      { nom: 'Surveillance méthotrexate', valeur: 'NFS, transaminases, créatininémie — toutes les 4 à 12 semaines' },
    ],
    attendus: [
      { cle: 'horaire',  libelle: 'Horaire de la douleur (inflammatoire / mécanique)', motifs: [/dérouillage|nocturne|matinal|inflammatoire|mécanique/i] },
      { cle: 'articulations', libelle: 'Articulations atteintes et nombre', motifs: [/articulation|synovite|genou|main|poignet|hanche|rachis|épaule/i] },
      { cle: 'biologie', libelle: 'Bilan inflammatoire (CRP, VS)', motifs: [/crp|vs\b|vitesse de sédim|inflammatoire/i] },
      { cle: 'imagerie', libelle: 'Imagerie', motifs: [/radio|irm|échographie|scanner|tdm/i] },
      { cle: 'retentissement', libelle: 'Retentissement fonctionnel', motifs: [/gêne|handicap|marche|profession|arrêt de travail|autonomie/i] },
    ],
    alertes: [
      'Monoarthrite fébrile : arthrite septique jusqu\'à preuve du contraire, urgence.',
      'Lombalgie avec déficit moteur, anesthésie en selle, troubles sphinctériens : urgence neurochirurgicale.',
    ],
  },

  // ── Psychiatrie ───────────────────────────────────────────────────────────
  psychiatrie: {
    key: 'psychiatrie',
    label: 'Psychiatrie',
    cles: ['psychiatre', 'psychiatrie'],
    source: {
      libelle: 'HAS — Épisode dépressif caractérisé de l\'adulte ; conduite à tenir en cas de risque suicidaire',
      url: 'https://www.has-sante.fr/jcms/c_1739917/fr/episode-depressif-caracterise-de-l-adulte-prise-en-charge-en-soins-de-premier-recours',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'HISTOIRE DU TROUBLE ET ANTÉCÉDENTS',
      'EXAMEN PSYCHIATRIQUE',
      'ÉVALUATION DU RISQUE SUICIDAIRE',
      'RETENTISSEMENT FONCTIONNEL',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'Épisode dépressif caractérisé', valeur: '≥ 5 symptômes pendant ≥ 2 semaines, dont humeur dépressive ou anhédonie' },
      { nom: 'PHQ-9', valeur: 'minime 0–4 — léger 5–9 — modéré 10–14 — modérément sévère 15–19 — sévère 20–27' },
      { nom: 'GAD-7', valeur: 'minime 0–4 — léger 5–9 — modéré 10–14 — sévère 15–21' },
      { nom: 'Risque suicidaire', valeur: 'évalué sur idées, intentionnalité, scénario, moyens disponibles, antécédent de tentative' },
      { nom: 'Durée antidépresseur', valeur: 'poursuite ≥ 6 mois après rémission d\'un premier épisode' },
    ],
    attendus: [
      { cle: 'suicidaire', libelle: 'Évaluation explicite du risque suicidaire', motifs: [/suicid|idées noires|scénario|passage à l.?acte|auto-?agress/i] },
      { cle: 'symptomes',  libelle: 'Symptômes thymiques et durée', motifs: [/humeur|tristesse|anhédonie|insomnie|appétit|fatigue|semaine|mois/i] },
      { cle: 'toxiques',   libelle: 'Consommations (alcool, toxiques, traitements)', motifs: [/alcool|cannabis|toxique|substance|benzodiazép/i] },
      { cle: 'retentissement', libelle: 'Retentissement professionnel et social', motifs: [/travail|professionnel|social|familial|isolement|arrêt/i] },
      { cle: 'traitement', libelle: 'Traitement psychotrope et tolérance', motifs: [/antidépresseur|isrs|psychothérap|traitement|mg\b/i] },
    ],
    alertes: [
      'Idées suicidaires avec scénario ou moyens disponibles : ne pas laisser repartir sans mise en sécurité.',
      'Virage maniaque sous antidépresseur, symptômes psychotiques : avis spécialisé urgent.',
    ],
  },

  // ── Pédiatrie ─────────────────────────────────────────────────────────────
  pediatrie: {
    key: 'pediatrie',
    label: 'Pédiatrie',
    cles: ['pédiatre', 'pediatre', 'pédiatrie'],
    source: {
      libelle: 'HAS — Suivi médical de l\'enfant ; carnet de santé et examens obligatoires',
      url: 'https://www.has-sante.fr/jcms/p_3162944/fr/suivi-medical-de-l-enfant',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'ANTÉCÉDENTS ET DÉVELOPPEMENT',
      'CROISSANCE STATURO-PONDÉRALE',
      'EXAMEN CLINIQUE',
      'VACCINATIONS',
      'SYNTHÈSE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'Courbes de croissance', valeur: 'poids, taille, périmètre crânien reportés en couloirs de dérivation standard' },
      { nom: 'Cassure de courbe', valeur: 'changement de couloir : signal d\'alerte imposant une recherche étiologique' },
      { nom: 'Examens obligatoires', valeur: '20 examens de la naissance à 16 ans, dont 3 donnant lieu à certificat (8 jours, 9 mois, 24 mois)' },
      { nom: 'Vaccinations obligatoires', valeur: '11 valences pour les enfants nés depuis le 1er janvier 2018' },
      { nom: 'Fièvre du nourrisson', valeur: '< 3 mois avec fièvre : avis hospitalier systématique' },
    ],
    attendus: [
      { cle: 'croissance', libelle: 'Poids, taille (et PC avant 2 ans)', motifs: [/poids|taille|périmètre crânien|\bpc\b|courbe|percentile/i] },
      { cle: 'developpement', libelle: 'Développement psychomoteur', motifs: [/développement|psychomoteur|marche|langage|acquisition|tient assis/i] },
      { cle: 'vaccins',    libelle: 'Statut vaccinal', motifs: [/vaccin|rappel|ror|dtp|carnet de santé/i] },
      { cle: 'alimentation', libelle: 'Alimentation / sommeil', motifs: [/alimentation|allaitement|biberon|sommeil|diversification/i] },
    ],
    alertes: [
      'Fièvre chez un nourrisson de moins de 3 mois : avis hospitalier sans délai.',
      'Cassure de la courbe de croissance, purpura fébrile, geignement : urgence.',
    ],
  },

  // ── Gériatrie ─────────────────────────────────────────────────────────────
  geriatrie: {
    key: 'geriatrie',
    label: 'Gériatrie',
    cles: ['gériatre', 'geriatre', 'gériatrie'],
    source: {
      libelle: 'HAS — Repérage de la fragilité en soins ambulatoires ; prévention des chutes',
      url: 'https://www.has-sante.fr/jcms/c_1602970/fr/comment-reperer-la-fragilite-en-soins-ambulatoires',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'AUTONOMIE ET MODE DE VIE',
      'ÉVALUATION GÉRIATRIQUE',
      'EXAMEN CLINIQUE ET CONSTANTES',
      'RÉVISION DE L\'ORDONNANCE',
      'SYNTHÈSE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'MMSE', valeur: 'score sur 30 ; altération cognitive à explorer si < 26, à interpréter selon le niveau socio-culturel' },
      { nom: 'ADL / IADL', valeur: 'ADL sur 6 (autonomie de base), IADL sur 4 ou 8 (autonomie instrumentale)' },
      { nom: 'Chutes', valeur: '≥ 1 chute dans l\'année : évaluation multifactorielle recommandée' },
      { nom: 'Dénutrition', valeur: 'perte de poids ≥ 5 % en 1 mois ou ≥ 10 % en 6 mois ; IMC < 22 chez le sujet âgé' },
      { nom: 'Polymédication', valeur: '≥ 5 médicaments : réévaluation du rapport bénéfice/risque de chaque ligne' },
    ],
    attendus: [
      { cle: 'autonomie', libelle: 'Autonomie (ADL / IADL) et mode de vie', motifs: [/autonomie|adl|iadl|domicile|ehpad|aide|entourage/i] },
      { cle: 'chutes',    libelle: 'Recherche de chutes', motifs: [/chute|équilibre|marche|déambulat/i] },
      { cle: 'cognition', libelle: 'Évaluation cognitive', motifs: [/mmse|cognitif|mémoire|orientation|confusion/i] },
      { cle: 'nutrition', libelle: 'État nutritionnel (poids, IMC)', motifs: [/poids|imc|dénutrition|appétit|amaigriss/i] },
      { cle: 'ordonnance', libelle: 'Révision de l\'ordonnance', motifs: [/ordonnance|traitement|médicament|déprescri|iatrogén/i] },
    ],
    alertes: [
      'Confusion aiguë : rechercher une cause organique (infection, rétention, iatrogénie) avant tout.',
      'Chutes répétées avec traitement psychotrope ou anticoagulant : réévaluation urgente.',
    ],
  },

  // ── Dermatologie ──────────────────────────────────────────────────────────
  dermatologie: {
    key: 'dermatologie',
    label: 'Dermatologie',
    cles: ['dermatologue', 'dermatologie'],
    source: {
      libelle: 'HAS — Prise en charge du psoriasis, de la dermatite atopique et de l\'acné',
      url: 'https://www.has-sante.fr/jcms/c_2040322/fr/label-de-la-has-traitement-de-l-acne-par-voie-locale-et-generale',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'HISTOIRE DE LA DERMATOSE',
      'DESCRIPTION LÉSIONNELLE',
      'TOPOGRAPHIE ET ÉTENDUE',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'Lésion élémentaire', valeur: 'macule, papule, plaque, vésicule, bulle, pustule, nodule — à nommer avant toute hypothèse' },
      { nom: 'PASI / BSA', valeur: 'psoriasis modéré à sévère si PASI > 10 ou BSA > 10 % ou DLQI > 10' },
      { nom: 'SCORAD', valeur: 'dermatite atopique : légère < 25 — modérée 25–50 — sévère > 50' },
      { nom: 'Règle ABCDE', valeur: 'mélanome : Asymétrie, Bordure irrégulière, Couleur inhomogène, Diamètre > 6 mm, Évolution' },
      { nom: 'Dermocorticoïdes', valeur: '4 niveaux d\'activité ; visage et plis : activité modérée à faible uniquement' },
    ],
    attendus: [
      { cle: 'lesion',      libelle: 'Lésion élémentaire décrite', motifs: [/macule|papule|plaque|vésicule|bulle|pustule|nodule|squame|érythème/i] },
      { cle: 'topographie', libelle: 'Topographie et étendue', motifs: [/topograph|localis|visage|tronc|membre|plis|cuir chevelu|étendue|bsa/i] },
      { cle: 'evolution',   libelle: 'Ancienneté et évolution', motifs: [/depuis|évolution|poussée|récidiv|chronique|aigu/i] },
      { cle: 'prurit',      libelle: 'Prurit et retentissement', motifs: [/prurit|démangeais|gratt|dlqi|retentissement/i] },
      { cle: 'traitement',  libelle: 'Traitements déjà essayés', motifs: [/dermocortic|émollient|traitement|crème|pommade|essayé/i] },
    ],
    alertes: [
      'Lésion pigmentée évolutive répondant aux critères ABCDE : avis dermatologique rapide.',
      'Décollement cutané, atteinte muqueuse, fièvre : toxidermie grave, urgence hospitalière.',
    ],
  },

  // ── Neurologie ────────────────────────────────────────────────────────────
  neurologie: {
    key: 'neurologie',
    label: 'Neurologie',
    cles: ['neurologue', 'neurologie'],
    source: {
      libelle: 'HAS — Accident vasculaire cérébral : prise en charge précoce ; maladie d\'Alzheimer',
      url: 'https://www.has-sante.fr/jcms/c_830203/fr/accident-vasculaire-cerebral-prise-en-charge-precoce',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'HISTOIRE DE LA MALADIE',
      'EXAMEN NEUROLOGIQUE',
      'EXAMENS COMPLÉMENTAIRES',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'Score de Glasgow', valeur: 'sur 15 : ouverture des yeux /4, réponse verbale /5, réponse motrice /6' },
      { nom: 'NIHSS', valeur: 'sévérité de l\'AVC : mineur < 5 — modéré 5–15 — sévère > 15' },
      { nom: 'Thrombolyse', valeur: 'fenêtre de 4h30 après le début des symptômes — l\'heure de début conditionne tout' },
      { nom: 'MMSE', valeur: 'sur 30, à interpréter selon âge et niveau socio-culturel' },
      { nom: 'Céphalée en coup de tonnerre', valeur: 'maximale en moins d\'une minute : hémorragie méningée jusqu\'à preuve du contraire' },
    ],
    attendus: [
      { cle: 'debut',    libelle: 'Heure ou date de début des symptômes', motifs: [/depuis|début|heure|brutal|progressif|installation/i] },
      { cle: 'examen',   libelle: 'Examen neurologique (déficit, réflexes, sensibilité)', motifs: [/déficit|réflexe|sensibilité|force|babinski|marche|coordination|nerf/i] },
      { cle: 'imagerie', libelle: 'Imagerie cérébrale', motifs: [/irm|scanner|tdm|imagerie|angio/i] },
      { cle: 'fdr',      libelle: 'Facteurs de risque vasculaire', motifs: [/hta|diabèt|tabac|cholest|fibrillation|acfa/i] },
    ],
    alertes: [
      'Déficit neurologique brutal : appel du 15, filière AVC, ne jamais différer.',
      'Céphalée brutale intense, fièvre + raideur de nuque : urgence absolue.',
    ],
  },

  // ── Gastro-entérologie ────────────────────────────────────────────────────
  gastroenterologie: {
    key: 'gastroenterologie',
    label: 'Gastro-entérologie — hépatologie',
    cles: ['gastro-entérologue', 'gastro-enterologue', 'hépatologue', 'hepatologue', 'gastro-entérologie'],
    source: {
      libelle: 'HAS — Dépistage du cancer colorectal ; prise en charge des MICI',
      url: 'https://www.has-sante.fr/jcms/c_1623732/fr/depistage-et-prevention-du-cancer-colorectal',
    },
    sections: [
      'MOTIF DE CONSULTATION',
      'HISTOIRE DES SYMPTÔMES',
      'EXAMEN CLINIQUE',
      'EXAMENS COMPLÉMENTAIRES',
      'SYNTHÈSE DIAGNOSTIQUE',
      'CONDUITE À TENIR',
      'SURVEILLANCE',
    ],
    reperes: [
      { nom: 'Dépistage colorectal', valeur: 'test immunologique tous les 2 ans de 50 à 74 ans ; coloscopie si positif' },
      { nom: 'Coloscopie de dépistage', valeur: 'dès 45 ans si antécédent familial au premier degré, ou 10 ans avant l\'âge du cas index' },
      { nom: 'Score de Child-Pugh', valeur: 'A 5–6 — B 7–9 — C 10–15 (bilirubine, albumine, TP, ascite, encéphalopathie)' },
      { nom: 'FIB-4', valeur: 'fibrose hépatique peu probable si < 1,30 ; avis spécialisé si > 2,67' },
      { nom: 'Signes d\'alarme digestifs', valeur: 'amaigrissement, anémie, rectorragies, dysphagie, âge > 50 ans d\'apparition récente' },
    ],
    attendus: [
      { cle: 'transit',   libelle: 'Transit et caractéristiques des selles', motifs: [/transit|selle|diarrhée|constipation|rectorrag|méléna/i] },
      { cle: 'alarme',    libelle: 'Recherche de signes d\'alarme', motifs: [/amaigriss|perte de poids|anémie|dysphagie|rectorrag|nocturne/i] },
      { cle: 'biologie',  libelle: 'Bilan biologique (NFS, bilan hépatique)', motifs: [/nfs|hémoglobine|transaminase|asat|alat|ggt|bilirubine|crp/i] },
      { cle: 'endoscopie', libelle: 'Endoscopie / imagerie', motifs: [/coloscopie|endoscop|fibroscop|échographie|scanner/i] },
      { cle: 'alcool',    libelle: 'Consommation d\'alcool', motifs: [/alcool|verre|oh\b|sevrage/i] },
    ],
    alertes: [
      'Hémorragie digestive avec retentissement hémodynamique : urgence.',
      'Ictère fébrile avec douleur de l\'hypochondre droit : angiocholite, urgence.',
    ],
  },
};

// ── Résolution spécialité → référentiel ─────────────────────────────────────

// Index inversé construit une fois : libellé d'inscription → référentiel.
const INDEX_CLES = new Map();
for (const ref of Object.values(REFERENTIELS)) {
  for (const cle of ref.cles) INDEX_CLES.set(cle.toLowerCase(), ref);
}

/**
 * Référentiel correspondant au libellé de spécialité du compte médecin.
 *
 * Le champ `specialite` d'un compte peut contenir plusieurs spécialités
 * séparées par des virgules : on retient la première qui a un référentiel.
 * Renvoie null si aucune ne correspond — l'appelant retombe alors sur le
 * comportement générique, il n'y a pas de référentiel par défaut imposé.
 */
function getReferentiel(specialite) {
  if (!specialite || typeof specialite !== 'string') return null;

  for (const brut of specialite.split(',')) {
    const nom = brut.trim().toLowerCase();
    if (!nom) continue;
    if (INDEX_CLES.has(nom)) return INDEX_CLES.get(nom);
    // Correspondance partielle : « Chirurgien orthopédiste » n'a pas de
    // référentiel propre, mais « Pédiatre » doit matcher « pédiatre ».
    for (const [cle, ref] of INDEX_CLES) {
      if (nom.includes(cle)) return ref;
    }
  }
  return null;
}

/**
 * Compare les notes du médecin aux éléments attendus par le référentiel.
 *
 * C'est le mécanisme qui remplace l'hallucination par un aveu : plutôt que de
 * laisser le modèle inventer une HbA1c absente, on constate son absence et on
 * la signale. Le calcul est purement lexical et local — aucun appel modèle.
 */
function analyserCouverture(referentiel, notes) {
  if (!referentiel) return { presents: [], manquants: [], couverture: 1 };

  const source = String(notes || '');
  const presents = [];
  const manquants = [];

  for (const attendu of referentiel.attendus) {
    const trouve = attendu.motifs.some(re => re.test(source));
    (trouve ? presents : manquants).push({ cle: attendu.cle, libelle: attendu.libelle });
  }

  const total = referentiel.attendus.length;
  return {
    presents,
    manquants,
    couverture: total ? presents.length / total : 1,
  };
}

/**
 * Bloc injecté dans le system prompt : structure attendue + repères chiffrés
 * + consigne explicite sur les éléments manquants.
 */
function blocPrompt(referentiel, couverture) {
  if (!referentiel) return '';

  const reperes = referentiel.reperes
    .map(r => `- ${r.nom} : ${r.valeur}`)
    .join('\n');

  const manquants = (couverture && couverture.manquants) || [];

  return (
    `\nRÉFÉRENTIEL ${referentiel.label.toUpperCase()} (source : ${referentiel.source.libelle}) :\n` +
    `Structure attendue du document, dans cet ordre : ${referentiel.sections.join(' — ')}.\n` +
    `Omets toute rubrique pour laquelle les notes n'apportent rien : une rubrique vide n'a pas d'intérêt clinique.\n\n` +
    `REPÈRES DE LA SPÉCIALITÉ (fournis ici, à ne PAS reconstituer de mémoire ; ` +
    `ne les cite que s'ils éclairent une donnée effectivement présente dans les notes) :\n${reperes}\n\n` +
    (manquants.length
      ? `ÉLÉMENTS ATTENDUS PAR LE RÉFÉRENTIEL ET ABSENTS DES NOTES : ` +
        `${manquants.map(m => m.libelle).join(' ; ')}.\n` +
        `RÈGLE ABSOLUE : n'invente aucune valeur pour ces éléments et ne les mentionne pas comme s'ils avaient été recueillis. ` +
        `Ne crée pas non plus de rubrique « éléments manquants » dans le document : ` +
        `ces manques sont restitués séparément au médecin par l'interface, pas dans le document signé.\n`
      : `Tous les éléments attendus par le référentiel sont couverts par les notes.\n`) +
    (referentiel.alertes.length
      ? `SIGNAUX D'ALERTE de la spécialité — à mentionner uniquement si les notes en contiennent un élément :\n` +
        referentiel.alertes.map(a => `- ${a}`).join('\n') + '\n'
      : '')
  );
}

/** Vue publique d'un référentiel, pour l'API et l'affichage front. */
function referentielPublic(referentiel, couverture) {
  if (!referentiel) return null;
  return {
    key: referentiel.key,
    label: referentiel.label,
    source: referentiel.source,
    sections: referentiel.sections,
    reperes: referentiel.reperes,
    alertes: referentiel.alertes,
    couverture: couverture
      ? {
          presents: couverture.presents,
          manquants: couverture.manquants,
          taux: Math.round(couverture.couverture * 100),
        }
      : null,
  };
}

function listReferentiels() {
  return Object.values(REFERENTIELS).map(r => ({
    key: r.key,
    label: r.label,
    source: r.source,
    nbReperes: r.reperes.length,
    nbAttendus: r.attendus.length,
  }));
}

module.exports = {
  REFERENTIELS,
  getReferentiel,
  analyserCouverture,
  blocPrompt,
  referentielPublic,
  listReferentiels,
};
