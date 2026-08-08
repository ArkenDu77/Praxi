/**
 * Arkiba — Tests dossiers patients (timeline) et référentiels de spécialité
 *
 * Run : npx jest tests/dossiers.test.js
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Chaque exécution part d'un répertoire vierge : les tests ne doivent pas
// dépendre d'un dossiers.json laissé par une exécution précédente.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'praxi-dossiers-'));
process.env.DATA_DIR    = TMP;
process.env.JWT_SECRET  = 'test-secret-key-min-32-chars-000000';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.NODE_ENV    = 'test';

const request  = require('supertest');
const dossiers = require('../lib/dossiers');
const {
  getReferentiel, analyserCouverture, blocPrompt, referentielPublic, listReferentiels,
} = require('../lib/referentiels');

const MEDECIN = 1;
const AUTRE   = 2;

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ─── MODULE DOSSIERS ────────────────────────────────────────────────────────

describe('lib/dossiers — fiches patients', () => {
  test('crée une fiche et la retrouve dans la liste', () => {
    const { patient } = dossiers.createPatient(MEDECIN, {
      nom: 'Martin Dupont', ddn: '1970-05-12', patho: 'HTA', allergies: 'Pénicilline',
    });
    expect(patient.id).toBeTruthy();
    expect(patient.nom).toBe('Martin Dupont');

    const liste = dossiers.listPatients(MEDECIN);
    expect(liste.map(p => p.nom)).toContain('Martin Dupont');
  });

  test('refuse une fiche sans nom', () => {
    expect(dossiers.createPatient(MEDECIN, { patho: 'HTA' }).error).toBeTruthy();
  });

  test("calcule l'âge depuis la date de naissance", () => {
    const attendu = new Date().getFullYear() - 1970;
    const age = dossiers.ageDepuisDdn('1970-05-12');
    // Selon le mois courant, l'âge vaut attendu ou attendu - 1.
    expect([attendu, attendu - 1]).toContain(age);
  });

  test('renvoie null pour une date de naissance inexploitable', () => {
    expect(dossiers.ageDepuisDdn('')).toBeNull();
    expect(dossiers.ageDepuisDdn('pas une date')).toBeNull();
    expect(dossiers.ageDepuisDdn('1870-01-01')).toBeNull();
  });

  test('accepte le format JJ/MM/AAAA', () => {
    expect(typeof dossiers.ageDepuisDdn('12/05/1970')).toBe('number');
  });

  test('une mise à jour partielle ne vide pas les autres champs', () => {
    const { patient } = dossiers.createPatient(MEDECIN, {
      nom: 'Claire Petit', patho: 'Diabète type 2', traitements: 'Metformine',
    });
    const maj = dossiers.updatePatient(MEDECIN, patient.id, { allergies: 'Iode' });
    expect(maj.patient.allergies).toBe('Iode');
    expect(maj.patient.patho).toBe('Diabète type 2');
    expect(maj.patient.traitements).toBe('Metformine');
  });

  test('un champ explicitement vidé est bien effacé', () => {
    const { patient } = dossiers.createPatient(MEDECIN, { nom: 'Paul Vide', patho: 'À retirer' });
    const maj = dossiers.updatePatient(MEDECIN, patient.id, { patho: '' });
    expect(maj.patient.patho).toBe('');
  });

  test('un médecin ne voit pas les fiches d\'un autre', () => {
    dossiers.createPatient(AUTRE, { nom: 'Patient Confidentiel' });
    const noms = dossiers.listPatients(MEDECIN).map(p => p.nom);
    expect(noms).not.toContain('Patient Confidentiel');
  });

  test('un médecin ne peut pas modifier la fiche d\'un autre', () => {
    const { patient } = dossiers.createPatient(AUTRE, { nom: 'Isolé' });
    expect(dossiers.updatePatient(MEDECIN, patient.id, { nom: 'Détourné' }).error).toBeTruthy();
    expect(dossiers.deletePatient(MEDECIN, patient.id).error).toBeTruthy();
  });

  test('la recherche filtre sur nom, pathologie et traitements', () => {
    dossiers.createPatient(MEDECIN, { nom: 'Zoé Recherche', patho: 'Asthme', traitements: 'Ventoline' });
    expect(dossiers.listPatients(MEDECIN, 'ventoline').map(p => p.nom)).toContain('Zoé Recherche');
    expect(dossiers.listPatients(MEDECIN, 'asthme').map(p => p.nom)).toContain('Zoé Recherche');
    expect(dossiers.listPatients(MEDECIN, 'zoé').map(p => p.nom)).toContain('Zoé Recherche');
  });
});

describe('lib/dossiers — documents et timeline', () => {
  let patientId;

  beforeAll(() => {
    patientId = dossiers.createPatient(MEDECIN, {
      nom: 'Timeline Test', ddn: '1985-01-01', allergies: 'Amoxicilline',
    }).patient.id;
  });

  test('enregistre un document rattaché au patient', () => {
    const { document } = dossiers.createDocument(MEDECIN, {
      patientId, type: 'cr', contenu: 'MOTIF DE CONSULTATION : toux fébrile.',
    });
    expect(document.patientId).toBe(patientId);
    expect(document.typeLabel).toBe('Compte-rendu de consultation');
  });

  test('refuse un document vide', () => {
    expect(dossiers.createDocument(MEDECIN, { patientId, contenu: '' }).error).toBeTruthy();
  });

  test('détache un document dont le patientId appartient à un autre médecin', () => {
    const etranger = dossiers.createPatient(AUTRE, { nom: 'Pas le mien' }).patient.id;
    const { document } = dossiers.createDocument(MEDECIN, {
      patientId: etranger, type: 'cr', contenu: 'Contenu quelconque.',
    });
    // Le document existe, mais n'est pas greffé sur le dossier d'autrui.
    expect(document.patientId).toBeNull();
  });

  test('la timeline groupe les documents par jour, du plus récent au plus ancien', () => {
    dossiers.createDocument(MEDECIN, { patientId, type: 'ordonnance', contenu: 'ORDONNANCE : paracétamol.' });
    const tl = dossiers.getTimeline(MEDECIN, patientId);

    expect(tl.patient.nom).toBe('Timeline Test');
    expect(tl.stats.total).toBeGreaterThanOrEqual(2);
    expect(tl.jours.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < tl.documents.length; i++) {
      expect(tl.documents[i - 1].createdAt >= tl.documents[i].createdAt).toBe(true);
    }
  });

  test('la timeline d\'un patient inexistant est nulle', () => {
    expect(dossiers.getTimeline(MEDECIN, 'inexistant')).toBeNull();
  });

  test('supprimer une fiche supprime ses documents', () => {
    const p = dossiers.createPatient(MEDECIN, { nom: 'À supprimer' }).patient;
    dossiers.createDocument(MEDECIN, { patientId: p.id, type: 'cr', contenu: 'Document lié.' });
    dossiers.deletePatient(MEDECIN, p.id);
    expect(dossiers.listDocuments(MEDECIN, { patientId: p.id })).toHaveLength(0);
  });
});

describe('lib/dossiers — contexte de génération', () => {
  let patientId;

  beforeAll(() => {
    patientId = dossiers.createPatient(MEDECIN, {
      nom: 'Contexte Patient', ddn: '1960-03-03',
      patho: 'Insuffisance cardiaque', traitements: 'Furosémide', allergies: 'Sulfamides',
    }).patient.id;
    dossiers.createDocument(MEDECIN, {
      patientId, type: 'cr', contenu: 'Majoration du furosémide à 40 mg.',
    });
  });

  test('le contexte reprend la fiche et les documents antérieurs', () => {
    const ctx = dossiers.contextePatient(MEDECIN, patientId);
    expect(ctx.vide).toBe(false);
    expect(ctx.texte).toContain('Insuffisance cardiaque');
    expect(ctx.texte).toContain('Sulfamides');
    expect(ctx.texte).toContain('furosémide');
  });

  test('chaque document du contexte est référencé pour la traçabilité', () => {
    const ctx = dossiers.contextePatient(MEDECIN, patientId);
    expect(ctx.documents[0].ref).toBe('A1');
    expect(ctx.documents[0].id).toBeTruthy();
    expect(ctx.texte).toContain('[A1]');
  });

  test('le contexte est vide pour une fiche sans donnée ni document', () => {
    const p = dossiers.createPatient(MEDECIN, { nom: 'Fiche Nue' }).patient;
    expect(dossiers.contextePatient(MEDECIN, p.id).vide).toBe(true);
  });

  test('le contexte d\'un patient d\'un autre médecin est inaccessible', () => {
    expect(dossiers.contextePatient(AUTRE, patientId)).toBeNull();
  });
});

describe('lib/dossiers — import depuis localStorage', () => {
  test('importe patients et documents, puis reste idempotent', () => {
    const charge = {
      patients:  [{ id: 'loc1', nom: 'Importé Un', patho: 'Migraine' }],
      documents: [{ type: 'cr', patient: 'Importé Un', contenu: 'Compte-rendu importé.' }],
    };

    const premier = dossiers.importerDepuisLocal(3, charge);
    expect(premier.patientsImportes).toBe(1);
    expect(premier.documentsImportes).toBe(1);

    // Rejouer le même import ne doit rien dupliquer.
    const second = dossiers.importerDepuisLocal(3, charge);
    expect(second.patientsImportes).toBe(0);
    expect(second.documentsImportes).toBe(0);
    expect(dossiers.listPatients(3)).toHaveLength(1);
  });

  test('rattache le document importé à la fiche du même nom', () => {
    dossiers.importerDepuisLocal(4, {
      patients:  [{ id: 'x', nom: 'Rattaché' }],
      documents: [{ type: 'liaison', patient: 'Rattaché', contenu: 'Lettre importée.' }],
    });
    const p = dossiers.listPatients(4)[0];
    expect(dossiers.listDocuments(4, { patientId: p.id })).toHaveLength(1);
  });
});

// ─── MODULE RÉFÉRENTIELS ────────────────────────────────────────────────────

describe('lib/referentiels — résolution par spécialité', () => {
  test('résout les libellés du menu d\'inscription', () => {
    expect(getReferentiel('Cardiologue').key).toBe('cardiologie');
    expect(getReferentiel('Médecin généraliste').key).toBe('generaliste');
    expect(getReferentiel('Diabétologue').key).toBe('diabetologie');
    expect(getReferentiel('Pédiatre').key).toBe('pediatrie');
    expect(getReferentiel('Dermatologue').key).toBe('dermatologie');
  });

  test('retient la première spécialité connue d\'un compte multi-spécialités', () => {
    expect(getReferentiel('Orthoptiste, Cardiologue').key).toBe('cardiologie');
  });

  test('renvoie null plutôt qu\'un référentiel par défaut', () => {
    expect(getReferentiel('')).toBeNull();
    expect(getReferentiel(null)).toBeNull();
    expect(getReferentiel('Anatomopathologiste')).toBeNull();
  });

  test('chaque référentiel déclare une source citable', () => {
    for (const r of listReferentiels()) {
      expect(r.source.libelle).toBeTruthy();
      expect(r.source.url).toMatch(/^https:\/\//);
    }
  });
});

describe('lib/referentiels — couverture des notes', () => {
  const cardio = getReferentiel('Cardiologue');

  test('repère les éléments présents dans les notes', () => {
    const c = analyserCouverture(cardio, 'Patient tabagique, ECG normal, PA 130/80, sous bêtabloquant.');
    const cles = c.presents.map(p => p.cle);
    expect(cles).toContain('fdrcv');
    expect(cles).toContain('ecg');
    expect(cles).toContain('traitement');
  });

  test('signale les éléments attendus et absents', () => {
    const c = analyserCouverture(cardio, 'Patient vu en consultation.');
    expect(c.manquants.length).toBeGreaterThan(0);
    expect(c.couverture).toBeLessThan(1);
  });

  test('une couverture complète ne laisse aucun manquant', () => {
    const diab = getReferentiel('Diabétologue');
    const c = analyserCouverture(diab,
      'HbA1c 7,2 %. Fond d\'œil fait. Sous metformine. Poids 82 kg. Conseils diététiques donnés.');
    expect(c.manquants).toHaveLength(0);
    expect(c.couverture).toBe(1);
  });

  test('sans référentiel, la couverture est neutre', () => {
    const c = analyserCouverture(null, 'notes quelconques');
    expect(c.manquants).toHaveLength(0);
    expect(c.couverture).toBe(1);
  });
});

describe('lib/referentiels — bloc de prompt', () => {
  const diab = getReferentiel('Diabétologue');

  test('injecte les repères chiffrés plutôt que de les faire deviner', () => {
    const bloc = blocPrompt(diab, analyserCouverture(diab, 'Consultation de suivi.'));
    expect(bloc).toContain('HbA1c');
    expect(bloc).toContain('≤ 7 %');
    expect(bloc).toContain(diab.source.libelle);
  });

  test('interdit explicitement d\'inventer une valeur pour un élément manquant', () => {
    const bloc = blocPrompt(diab, analyserCouverture(diab, 'Consultation de suivi.'));
    expect(bloc).toMatch(/n'invente aucune valeur/i);
  });

  test('garde les manques hors du document signé', () => {
    const bloc = blocPrompt(diab, analyserCouverture(diab, 'Consultation de suivi.'));
    expect(bloc).toMatch(/pas dans le document signé/i);
  });

  test('sans référentiel, le bloc est vide', () => {
    expect(blocPrompt(null, null)).toBe('');
  });

  test('la vue publique expose source, repères et taux de couverture', () => {
    const pub = referentielPublic(diab, analyserCouverture(diab, 'HbA1c 6,8 %.'));
    expect(pub.label).toBeTruthy();
    expect(pub.source.url).toMatch(/^https:\/\//);
    expect(pub.reperes.length).toBeGreaterThan(0);
    expect(pub.couverture.taux).toBeGreaterThan(0);
    expect(pub.couverture.taux).toBeLessThanOrEqual(100);
  });
});

// ─── ROUTES API ─────────────────────────────────────────────────────────────

describe('API dossiers patients', () => {
  const app = require('../server');
  let token, autreToken, patientId, documentId;

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({
      prenom: 'Api', nom: 'Dossier', email: `dossier.${Date.now()}@example.com`,
      password: 'TestPassword1', specialites: ['Cardiologue'], ville: 'Lyon',
    });
    token = res.body.token;

    const autre = await request(app).post('/api/auth/register').send({
      prenom: 'Autre', nom: 'Medecin', email: `autre.${Date.now()}@example.com`,
      password: 'TestPassword1', specialites: ['Pédiatre'], ville: 'Lille',
    });
    autreToken = autre.body.token;
  });

  test('exige une authentification', async () => {
    await request(app).get('/api/patients').expect(401);
    await request(app).get('/api/documents').expect(401);
  });

  test('POST /api/patients crée une fiche', async () => {
    const res = await request(app)
      .post('/api/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({ nom: 'Jean Timeline', ddn: '1975-06-15', allergies: 'Aspirine' })
      .expect(201);
    expect(res.body.patient.nom).toBe('Jean Timeline');
    patientId = res.body.patient.id;
  });

  test('POST /api/patients refuse une fiche sans nom', async () => {
    await request(app)
      .post('/api/patients')
      .set('Authorization', `Bearer ${token}`)
      .send({ patho: 'sans nom' })
      .expect(400);
  });

  test('POST /api/documents enregistre un document dans la timeline', async () => {
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .send({ patientId, type: 'cr', contenu: 'MOTIF : suivi HTA. PA 145/90.' })
      .expect(201);
    documentId = res.body.document.id;
    expect(res.body.document.patientId).toBe(patientId);
  });

  test('GET /api/patients/:id renvoie la timeline', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.patient.nom).toBe('Jean Timeline');
    expect(res.body.documents.length).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/patients/:id/contexte expose ce qui sera réutilisé', async () => {
    const res = await request(app)
      .get(`/api/patients/${patientId}/contexte`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.vide).toBe(false);
    expect(res.body.apercu).toContain('Aspirine');
    expect(res.body.documents[0].ref).toBe('A1');
  });

  test('un autre médecin ne peut pas lire la timeline', async () => {
    await request(app)
      .get(`/api/patients/${patientId}`)
      .set('Authorization', `Bearer ${autreToken}`)
      .expect(404);
  });

  test('PATCH /api/patients/:id met à jour la fiche', async () => {
    const res = await request(app)
      .patch(`/api/patients/${patientId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ traitements: 'Ramipril 5 mg' })
      .expect(200);
    expect(res.body.patient.traitements).toBe('Ramipril 5 mg');
    expect(res.body.patient.allergies).toBe('Aspirine');
  });

  test('GET /api/documents/:id permet de rouvrir un document', async () => {
    const res = await request(app)
      .get(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.document.contenu).toContain('suivi HTA');
  });

  test('GET /api/documents filtre par patient et par recherche', async () => {
    const parPatient = await request(app)
      .get(`/api/documents?patientId=${patientId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(parPatient.body.documents.length).toBeGreaterThanOrEqual(1);

    const parTexte = await request(app)
      .get('/api/documents?q=introuvable-xyz')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(parTexte.body.documents).toHaveLength(0);
  });

  test('GET /api/referentiels/mien renvoie le référentiel de la spécialité', async () => {
    const res = await request(app)
      .get('/api/referentiels/mien')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.referentiel.key).toBe('cardiologie');
    expect(res.body.referentiel.source.url).toMatch(/^https:\/\//);
  });

  test('POST /api/dossiers/import reprend les données locales', async () => {
    const res = await request(app)
      .post('/api/dossiers/import')
      .set('Authorization', `Bearer ${token}`)
      .send({
        patients:  [{ id: 'l1', nom: 'Depuis Local', patho: 'Arythmie' }],
        documents: [{ type: 'cr', patient: 'Depuis Local', contenu: 'CR local.' }],
      })
      .expect(200);
    expect(res.body.patientsImportes).toBe(1);
    expect(res.body.documentsImportes).toBe(1);
  });

  test('DELETE /api/patients/:id supprime la fiche', async () => {
    await request(app)
      .delete(`/api/patients/${patientId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app)
      .get(`/api/patients/${patientId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
