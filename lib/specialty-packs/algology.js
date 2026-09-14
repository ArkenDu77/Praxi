// Règles versionnées et calculables. Les interprétations restent à valider.
const DN4_SOURCE = 'https://www.sfetd-douleur.org/wp-content/uploads/2019/08/dn4ok.pdf';
const PEG_SOURCE = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2686775/';
const dn4Items = [
  ['burning', 'Brûlure'], ['cold', 'Froid douloureux'], ['electric', 'Décharges électriques'],
  ['tingling', 'Fourmillements'], ['pins', 'Picotements'], ['numbness', 'Engourdissement'],
  ['itching', 'Démangeaisons'], ['touch', 'Hypoesthésie au tact'],
  ['pinprick', 'Hypoesthésie à la piqûre'], ['brushing', 'Douleur au frottement'],
];

function dn4(inputs) {
  const values = Array.isArray(inputs) ? inputs : [];
  const missing = dn4Items.filter((_, i) => typeof values[i] !== 'boolean').map(([id]) => id);
  if (values.length !== 10 || missing.length) return { id: 'dn4', label: 'DN4', status: 'INCOMPLETE', value: null, missing, source: DN4_SOURCE };
  const value = values.reduce((sum, yes) => sum + Number(yes), 0);
  return { id: 'dn4', label: 'DN4', status: 'CALCULATED', value, max: 10, positive: value >= 4, inputs: values, source: DN4_SOURCE };
}

function peg(inputs) {
  const values = Array.isArray(inputs) ? inputs : [];
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10;
  if (values.length !== 3 || !values.every(valid)) return { id: 'peg', label: 'PEG', status: 'INCOMPLETE', value: null, source: PEG_SOURCE };
  return { id: 'peg', label: 'PEG', status: 'CALCULATED', value: values.reduce((sum, value) => sum + value, 0) / 3, max: 10, inputs: values, source: PEG_SOURCE };
}

const pack = {
  id: 'algologie', version: '1.0.0', label: 'Algologie',
  sections: ['MOTIF DE CONSULTATION', 'HISTOIRE DE LA DOULEUR', 'ÉVALUATION ET RETENTISSEMENT', 'EXAMEN CLINIQUE', 'SYNTHÈSE CLINIQUE RETENUE', 'PLAN DE SOINS ET SUIVI'],
  fields: [
    { id: 'location', label: 'Topographie et irradiation', pattern: /localis|topograph|irrad|lomb|cervic|genou|épaule|céphal/i },
    { id: 'history', label: 'Début, évolution et facteurs modifiants', pattern: /depuis|début|évolution|aggrav|soulag/i },
    { id: 'impact', label: 'Sommeil et activités quotidiennes', pattern: /sommeil|activité|travail|retentissement/i },
    { id: 'treatment', label: 'Traitements essayés, efficacité et tolérance', pattern: /traitement|efficac|tolérance|mg\b|kiné/i },
    { id: 'exam', label: 'Examen clinique ciblé', pattern: /examen|allodynie|hypoesth|déficit/i },
  ],
  scales: [
    { id: 'dn4', label: 'DN4', source: DN4_SOURCE, items: dn4Items.map(([id, label], i) => ({ id, label, kind: 'boolean', requiresExam: i >= 7 })) },
    { id: 'peg', label: 'PEG — moyenne des 3 réponses (semaine passée)', source: PEG_SOURCE, items: [
      { id: 'pain', label: 'Douleur moyenne', kind: 'number' },
      { id: 'enjoyment', label: 'Gêne pour profiter de la vie', kind: 'number' },
      { id: 'activity', label: 'Gêne pour les activités générales', kind: 'number' },
    ] },
  ],
  evaluate(notes, inputs = {}) {
    const scores = [dn4(inputs.dn4), peg(inputs.peg)];
    const interpretations = [];
    if (scores[0].status === 'CALCULATED' && scores[0].positive) interpretations.push({
      id: 'dn4-neuropathic', text: 'Composante neuropathique probable, à confronter à l’examen et au contexte clinique.',
      rationale: `DN4 complet : ${scores[0].value}/10, seuil de dépistage positif à 4/10.`,
      confidence: 'Orientation étayée par un dépistage ; ne constitue pas un diagnostic.',
      provenance: [{ type: 'calculation', id: 'dn4', source: DN4_SOURCE }], status: 'PENDING_REVIEW',
    });
    return { scores, interpretations, missing: this.fields.filter(field => !field.pattern.test(notes)).map(({ id, label }) => ({ id, label })) };
  },
};

module.exports = { pack, dn4, peg };
