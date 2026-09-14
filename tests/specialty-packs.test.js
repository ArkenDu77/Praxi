const { dn4, peg } = require('../lib/specialty-packs/algology');
const { getSpecialtyPack, analyzeSpecialtyPack, calculatedScoreText } = require('../lib/specialty-packs');

test('DN4 : les 1024 combinaisons complètes et le seuil sont déterministes', () => {
  for (let bits = 0; bits < 1024; bits++) {
    const input = Array.from({ length: 10 }, (_, i) => Boolean(bits & (1 << i)));
    const expected = input.filter(Boolean).length;
    expect(dn4(input)).toMatchObject({ value: expected, positive: expected >= 4, status: 'CALCULATED' });
  }
});
test('DN4 refuse tout item inconnu et exige les trois items de l’examen', () => {
  for (let i = 0; i < 10; i++) {
    const input = Array(10).fill(true); input[i] = null;
    expect(dn4(input)).toMatchObject({ value: null, status: 'INCOMPLETE' });
  }
  for (const bad of [[], Array(7).fill(true), Array(11).fill(true), Array(10).fill('non'), Array(10).fill(0)]) expect(dn4(bad).value).toBeNull();
});
test('PEG : les 1331 combinaisons entières donnent la moyenne des 3 items', () => {
  for (let p = 0; p <= 10; p++) for (let e = 0; e <= 10; e++) for (let g = 0; g <= 10; g++) expect(peg([p, e, g]).value).toBe((p + e + g) / 3);
});
test('PEG conserve les décimales et rejette valeurs invalides ou absentes', () => {
  expect(peg([1.5, 2.5, 3.5]).value).toBe(2.5);
  for (const bad of [[0, 0], [0, 0, null], ['', 0, 0], [NaN, 0, 0], [Infinity, 0, 0], [-1, 0, 0], [11, 0, 0]]) expect(peg(bad).value).toBeNull();
});
test('un score déclaré dans les notes ne remplit jamais les items manquants', () => {
  const result = analyzeSpecialtyPack('Algologue', 'DN4 8/10, douleur depuis un an');
  expect(result.scores.every(score => score.status === 'INCOMPLETE')).toBe(true);
  expect(result.interpretations).toEqual([]);
  expect(calculatedScoreText(result)).toBe('');
});
test('la proposition clinique reste une interprétation sourcée en attente', () => {
  const result = analyzeSpecialtyPack('algologie', 'Suivi douleur', { dn4: Array(10).fill(true) });
  expect(result.interpretations[0]).toMatchObject({ status: 'PENDING_REVIEW', provenance: [{ type: 'calculation', id: 'dn4', source: expect.stringContaining('sfetd') }] });
  expect(calculatedScoreText(result)).toContain('DN4 : 10/10');
  expect(getSpecialtyPack('Anesthésiste')).toBeNull();
});
