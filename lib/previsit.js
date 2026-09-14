// Préparation locale, sans appel modèle. Chaque extrait conserve sa source.
const FIELDS = { patho: 'Antécédents importants', traitements: 'Traitements', allergies: 'Allergies', notes: 'Points signalés' };
const compact = (v, max = 240) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const normalize = v => compact(v, 2000).toLocaleLowerCase('fr').replace(/[.,;:]$/, '');
const none = v => /^(aucun(e)?(\s+(allergie|traitement|antécédent)s?)?|néant|non|pas d['’](allergie|antécédent)s?|pas de traitement)s?\.?$/i.test(String(v).trim());

function clinicalDelta(before = {}, after = {}) {
  return Object.entries(FIELDS).map(([field, label]) => {
    const previous = compact(before[field], 2000), current = compact(after[field], 2000);
    const status = normalize(previous) === normalize(current) ? 'INCHANGE'
      : !previous ? 'NOUVEAU'
      : previous && current && (none(previous) !== none(current)) ? 'CONTRADICTOIRE'
      : 'MODIFIE';
    return { field, label, previous, current, status };
  }).filter(item => item.previous || item.current);
}

function clinicalSnapshot(patient) {
  return Object.fromEntries(Object.keys(FIELDS).map(key => [key, patient[key] || '']));
}

function recordClinicalChange(previous, next, { source, at }) {
  const delta = clinicalDelta(previous, next);
  if (!delta.some(item => item.status !== 'INCHANGE')) return next;
  return { ...next, clinicalChange: { before: clinicalSnapshot(previous), after: clinicalSnapshot(next), source, at } };
}

function excerpt(document, headings) {
  if (!document) return '';
  const lines = String(document.contenu || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!headings.test(lines[i])) continue;
    const inline = lines[i].split(':').slice(1).join(':').trim();
    const next = lines.slice(i + 1).find(line => line.trim());
    return compact(inline || next || '');
  }
  return '';
}

function buildPrevisitSummary(patient, documents = [], { now = new Date().toISOString() } = {}) {
  const ordered = [...documents].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const lastVisit = ordered.find(doc => doc.type === 'cr');
  const newestIntake = ordered.find(doc => doc.type === 'intake' && (!lastVisit || doc.createdAt > lastVisit.createdAt));
  const source = doc => doc ? { type: 'document', id: doc.id, label: doc.typeLabel, at: doc.createdAt } : null;
  const reasonDoc = newestIntake || lastVisit;
  const newDocuments = ordered.filter(doc => !lastVisit || doc.createdAt > lastVisit.createdAt).slice(0, 5);
  const change = patient.clinicalChange;
  const recentChange = change && (!lastVisit || change.at >= lastVisit.createdAt) ? change : null;
  const delta = recentChange ? clinicalDelta(recentChange.before, recentChange.after).map(item => ({ ...item, source: recentChange.source, at: recentChange.at })) : [];
  const toVerify = delta.filter(item => item.status === 'CONTRADICTOIRE').map(item => `${item.label} : déclarations différentes à vérifier.`);
  if (!patient.allergies) toVerify.push('Allergies non renseignées.');
  if (!patient.traitements) toVerify.push('Traitements actuels non renseignés.');
  if (newDocuments.length) toVerify.push(`${newDocuments.length} document(s) plus récent(s) à consulter.`);
  return {
    generatedAt: now, patientId: patient.id,
    title: 'À savoir avant de faire entrer le patient',
    reason: { text: excerpt(reasonDoc, /^\s*(motif|intervention|procédure)/i) || 'Motif à préciser', source: source(reasonDoc) },
    lastVisit: lastVisit ? { ...source(lastVisit), text: excerpt(lastVisit, /^\s*(synthèse|diagnostic|conclusion|conduite à tenir)/i) || compact(lastVisit.contenu) } : null,
    facts: Object.entries(FIELDS).filter(([field]) => patient[field]).map(([field, label]) => ({ field, label, text: compact(patient[field]), source: { type: 'patient', id: patient.id, at: patient.updatedAt } })),
    newDocuments: newDocuments.map(doc => ({ ...source(doc), title: doc.titre })),
    delta, comparisonAvailable: Boolean(recentChange),
    toVerify: toVerify.slice(0, 4),
  };
}

module.exports = { clinicalDelta, clinicalSnapshot, recordClinicalChange, buildPrevisitSummary };
