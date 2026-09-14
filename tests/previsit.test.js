const { clinicalDelta, recordClinicalChange, buildPrevisitSummary } = require('../lib/previsit');

test('compare des observations sans transformer un manque en négation', () => {
  expect(clinicalDelta({ allergies: 'Aucune allergie', traitements: 'Eliquis' }, { allergies: 'Pénicilline', traitements: '' })).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: 'allergies', status: 'CONTRADICTOIRE' }),
    expect.objectContaining({ field: 'traitements', status: 'MODIFIE' }),
  ]));
  expect(clinicalDelta({}, { patho: 'HTA' })[0].status).toBe('NOUVEAU');
  expect(clinicalDelta({ patho: 'HTA' }, { patho: 'hta.' })[0].status).toBe('INCHANGE');
});

test('prépare une lecture courte avec sources et changements postérieurs à la consultation', () => {
  const patient = recordClinicalChange({ allergies: 'Aucune allergie', traitements: 'Eliquis' }, { id: 'synthetic', allergies: 'Pénicilline', traitements: 'Eliquis', updatedAt: '2026-09-14' }, { source: 'pré-consultation', at: '2026-09-14' });
  const summary = buildPrevisitSummary(patient, [
    { id: 'old', type: 'cr', createdAt: '2026-09-01', contenu: 'MOTIF : Douleur du genou\nCONCLUSION : Réévaluation prévue' },
    { id: 'new', type: 'intake', createdAt: '2026-09-14', contenu: 'MOTIF : Suivi douleur' },
  ]);
  expect(summary.reason.text).toBe('Suivi douleur');
  expect(summary.reason.source.id).toBe('new');
  expect(summary.lastVisit.text).toBe('Réévaluation prévue');
  expect(summary.delta.find(item => item.field === 'allergies').status).toBe('CONTRADICTOIRE');
  expect(summary.newDocuments.map(doc => doc.id)).toEqual(['new']);
  expect(summary.toVerify.join(' ')).toContain('déclarations différentes');
});

test('un dossier historique sans snapshot ne reçoit pas de delta inventé', () => {
  const summary = buildPrevisitSummary({ id: 'test', patho: 'HTA' });
  expect(summary.comparisonAvailable).toBe(false);
  expect(summary.delta).toEqual([]);
  expect(summary.lastVisit).toBeNull();
});

test('la reprise identique et les modifications démographiques préservent la trace clinique', () => {
  const patient = { patho: 'HTA', clinicalChange: { source: 'pré-consultation', at: '2026-09-14' } };
  expect(recordClinicalChange(patient, { ...patient, nom: 'Fictif' }, { source: 'fiche médecin', at: '2026-09-15' }).clinicalChange).toEqual(patient.clinicalChange);
});
