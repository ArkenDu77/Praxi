const { pack: algology } = require('./algology');
const { getReferentiel } = require('../referentiels');
const PACKS = [algology];

function getSpecialtyPack(value = '') {
  const label = String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return PACKS.find(pack => pack.id === label) || (/algolog|douleur/.test(label) ? algology : null);
}

function publicPack(pack) {
  return { id: pack.id, version: pack.version, label: pack.label, sections: pack.sections, fields: pack.fields.map(({ id, label }) => ({ id, label })), scales: pack.scales };
}

function analyzeSpecialtyPack(value, notes, inputs = {}) {
  const pack = getSpecialtyPack(value);
  return pack ? { ...publicPack(pack), ...pack.evaluate(String(notes || ''), inputs || {}) } : null;
}

function reportStructure(specialty, selectedPack) {
  const pack = getSpecialtyPack(selectedPack || specialty);
  const reference = getReferentiel(specialty);
  const sections = pack ? pack.sections : reference && reference.sections;
  return sections ? `Structure du compte rendu : ${sections.join(' ; ')}. Omets les rubriques sans données. ` : '';
}

function calculatedScoreText(packResult) {
  if (!packResult) return '';
  return packResult.scores.filter(score => score.status === 'CALCULATED').map(score => `${score.label} : ${Number(score.value.toFixed(2))}/${score.max} (calcul déterministe sur ${score.inputs.length} réponses complètes).`).join('\n');
}

module.exports = { getSpecialtyPack, analyzeSpecialtyPack, reportStructure, calculatedScoreText, listSpecialtyPacks: () => PACKS.map(publicPack) };
