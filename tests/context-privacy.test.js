const { protectContextText, protectHistoricalContext } = require('../lib/context-privacy');

test('known name, DOB and direct identifiers leave historical text before model use', () => {
  const result = protectContextText('Mme Lucie Fictive, née le 15/03/1978. NIR 2780375116001. Domicile : 12 rue des Lilas, 75011 Paris. Téléphone : 06 12 34 56 78. Courriel : lucie@example.invalid. Traitement : 1500 mg. DN4 : 4/10.', { nom: 'Lucie Fictive', ddn: '1978-03-15' });
  expect(result.text).not.toMatch(/Lucie|Fictive|15\/03\/1978|2780375116001|rue des Lilas|75011|06 12|@/);
  expect(result.text).toContain('PATIENT_CONFIDENTIEL');
  expect(result.text).toContain('Traitement : 1500 mg. DN4 : 4/10.');
  // The known first name also occurs in the email before that whole email is removed.
  expect(result.redactions).toEqual({ name: 2, birthDate: 1, nationalId: 1, email: 1, telephone: 1, address: 1 });
});

test.each(['1978-03-15', '15/03/1978', '15.3.1978', '15 mars 1978'])('known DOB representation %s is removed without deleting the consultation date', dob => {
  const result = protectContextText(`Née le ${dob}. Consultation le 14/09/2026. Traitement depuis 2024.`, { ddn: '1978-03-15' });
  expect(result.text).not.toContain(dob);
  expect(result.text).toContain('Consultation le 14/09/2026. Traitement depuis 2024.');
});

test('Unicode name boundaries and regex metacharacters do not overmatch clinical words', () => {
  const result = protectContextText('Élodie Fictive consulte. ÉLODIE indique des douleurs. Réévaluation clinique.', { nom: 'Élodie Fictive' });
  expect(result.text).not.toMatch(/Élodie|ÉLODIE|Fictive/);
  expect(result.text).toContain('Réévaluation clinique');
  expect(protectContextText('A+B et AAB.', { nom: 'A+B' }).text).toBe('PATIENT_CONFIDENTIEL et AAB.');
  expect(protectContextText('Li consulte pour lombalgie.', { nom: 'Li' }).text).toBe('PATIENT_CONFIDENTIEL consulte pour lombalgie.');
});

test.each(['278037511600123', '2 78 03 75 116 001 23', '278032A11600123'])('NIR representation %s is removed', nir => {
  expect(protectContextText('Identifiant : ' + nir + '.', {}).text).toBe('Identifiant : [identifiant retiré].');
});

test.each(['0612345678', '06.12.34.56.78', '+33 6 12 34 56 78', '0033 6 12 34 56 78', '+33 (0)6 12 34 56 78'])('telephone representation %s is removed', phone => {
  const result = protectContextText('Tél : ' + phone + '. PEG 6/10.', {});
  expect(result.text).not.toContain(phone);
  expect(result.text).toContain('PEG 6/10.');
});

test('address minimisation preserves the following clinical sentence and decimal dose', () => {
  const result = protectContextText('Adresse : 8 bis av. Victor Hugo, 75016 Paris. Traitement : 2.5 mg matin. Aucun déficit.', {});
  expect(result.text).not.toContain('Victor Hugo');
  expect(result.text).toContain('Traitement : 2.5 mg matin. Aucun déficit.');
});

test('context helper changes only the model-bound text, preserves original data, declares limits', () => {
  const original = { patient: { nom: 'Lucie Fictive', ddn: '1978-03-15' }, texte: 'Lucie Fictive : dossier.', documents: [{ id: 'synthetic-1' }], vide: false };
  const result = protectHistoricalContext(original);
  expect(result.texte).toBe('PATIENT_CONFIDENTIEL : dossier.');
  expect(original.texte).toBe('Lucie Fictive : dossier.');
  expect(result.patient).toBe(original.patient);
  expect(result.documents).toBe(original.documents);
  expect(result.privacy).toMatchObject({ method: 'known-identifiers-v1', exhaustive: false });
  expect(protectHistoricalContext(null)).toBeNull();
});

test('unknown people in arbitrary free text are an explicit limitation', () => {
  const result = protectContextText('Consultation avec personne inconnue Jeanne Exemple.', { nom: 'Lucie Fictive' });
  expect(result.text).toContain('Jeanne Exemple');
  expect(protectHistoricalContext({ texte: result.text }).privacy.exhaustive).toBe(false);
});
