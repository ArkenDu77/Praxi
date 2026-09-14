/* Clinical review must cross the actual client request AND the actual server
 * prompt. Merely finding checkboxes or copying their intended output missed the
 * original defect. Every identity and clinical record below is synthetic. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const request = require('supertest');

const mockCreate = jest.fn(async () => ({ content: [{ type: 'text', text: 'Compte rendu fictif. Suivi clinique prévu.' }] }));
jest.mock('@anthropic-ai/sdk', () => class FakeAnthropic { constructor() { this.messages = { create: mockCreate }; } });
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: jest.fn(async () => ({})) }) }));

const syntheticDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arkiba-clinical-review-synthetic-'));
process.env.DATA_DIR = syntheticDirectory;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'synthetic-clinical-review-jwt-secret-00000000';
process.env.ADMIN_TOKEN = 'synthetic-clinical-review-admin';
process.env.ANTHROPIC_API_KEY = 'synthetic-invalid-key-sdk-is-mocked';
process.env.SMTP_HOST = '';
const app = require('../server');
const { analyzeSpecialtyPack } = require('../lib/specialty-packs');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8').replace(/\r\n/g, '\n');
const cleanCopy = value => JSON.parse(JSON.stringify(value));
function extract(signature) {
  const start = APP.indexOf(signature);
  if (start < 0) throw new Error('Function absent: ' + signature);
  const end = APP.indexOf('\n}\n', start);
  if (end < 0) throw new Error('Function end absent: ' + signature);
  return APP.slice(start, end + 3);
}
function pseudoSource() {
  const start = APP.indexOf('// Les champs de texte libre soumis à la pseudonymisation');
  const finish = APP.indexOf('\n}\n', APP.indexOf('function nettoyerJetonsResiduels('));
  if (start < 0 || finish < 0) throw new Error('Pseudonymisation source markers absent');
  return APP.slice(start, finish + 3);
}
function element() {
  return { dataset: {}, value: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {} };
}
function client(payload) {
  const calls = [], errors = [], elements = {};
  const cfg = { endpoint: 'compte-rendu', errId: 'error', outId: 'out', resId: 'result', btnLabel: 'Générer', build: () => ({ payload: cleanCopy(payload) }) };
  const sandbox = {
    console, GEN: { consult: cfg }, patientLie: null, lastClinicalOptions: {},
    document: { getElementById: id => elements[id] ||= element(), querySelectorAll: () => [] },
    api: jest.fn(async (url, opts) => { calls.push({ url, payload: JSON.parse(opts.body) }); return { document: 'PATIENT_CONFIDENTIEL : compte rendu fictif.', safety: {} }; }),
    clearError() {}, showError: (_id, message) => errors.push(message), setLoading() {}, startAiProgress: () => () => {},
    selectedStyle: () => 'direct et sobre',
    renderResult: (el, text) => { el.dataset.plain = text; }, renderTools() {}, renderChips() {}, renderProvenance() {}, renderReferentiel() {}, renderPraxiVerification() {},
    archiverDocument: jest.fn(async () => 'synthetic-document'), refreshHistory: async () => {}, toast: message => errors.push(message),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'physician-workflow.js'), 'utf8'), sandbox);
  vm.runInContext(pseudoSource() + '\n' + extract('async function runGeneration('), sandbox);
  return { sandbox, calls, errors, elements,
    async generate(options) {
      await sandbox.runGeneration('consult', element(), '', 'Générer', options);
      expect(errors).toEqual([]);
      expect(calls).toHaveLength(1);
      return calls[0].payload;
    }
  };
}

// Execute the production modal click listener. The selected checkbox and the
// edited textarea are separate: using the original model text would fail here.
function reviewedOptions({ checked = true } = {}) {
  const events = {}, modal = element(), next = element(), body = element();
  const textarea = { value: 'Formulation modifiée et validée pour Lucie Fictive.' };
  const selected = { checked, closest: () => ({ querySelector: () => textarea }) };
  const refused = { checked: false, closest: () => ({ querySelector: () => ({ value: 'INTERPRÉTATION NON RETENUE' }) }) };
  next.addEventListener = (name, handler) => { events[name] = handler; };
  modal.addEventListener = () => {};
  modal.querySelector = selector => selector === '#clinical-continue' ? next : { addEventListener() {} };
  modal.querySelectorAll = selector => selector.includes('deduction') ? [selected, refused].filter(x => x.checked) : [];
  body.appendChild = () => {};
  const sandbox = {
    document: { getElementById: id => id === 'clinical-modal' ? null : { value: 'standard' }, createElement: () => modal, body },
    window: { scrollTo() {} }, clinicalScrollY: 0,
    clinicalPending: { key: 'consult', btn: element(), label: 'Générer', sourcePayload: {}, analysis: {
      recommendedLength: 'standard', deductions: ['TEXTE INITIAL NON VALIDÉ', 'INTERPRÉTATION NON RETENUE'], inconsistencies: [], specialtyFocus: []
    } },
    lastClinicalOptions: {}, selectedStyle: () => 'direct', applyFinalIdentityEdits() {},
    renderFinalClinicalCheck: () => { next.dataset.step = 'final'; }, renderClinicalReview() {},
    runGeneration: jest.fn(),
  };
  vm.createContext(sandbox); vm.runInContext(extract('function ensureClinicalModal('), sandbox);
  sandbox.ensureClinicalModal(); events.click(); events.click();
  expect(sandbox.runGeneration).toHaveBeenCalledTimes(1);
  return cleanCopy(sandbox.runGeneration.mock.calls[0][4]);
}

let token;
beforeAll(async () => {
  const registration = await request(app).post('/api/auth/register').send({ prenom: 'Médecin', nom: 'Synthétique', email: 'clinical-review@example.invalid', password: 'SyntheticTestPassword1', specialites: ['Médecin généraliste'], ville: 'Ville fictive' }).expect(201);
  token = registration.body.token;
});
afterAll(() => {
  // The only recursive removal target is the exact directory this test created.
  if (!path.basename(syntheticDirectory).startsWith('arkiba-clinical-review-synthetic-')) throw new Error('Unexpected cleanup scope');
  fs.rmSync(syntheticDirectory, { recursive: true, force: true });
});
beforeEach(() => mockCreate.mockClear());

test('unchecked interpretations stay out of the reviewed options', () => {
  const options = reviewedOptions({ checked: false });
  expect(options.clinicalAnalysis.deductions).toEqual([]);
});

test('physician edited selection reaches the pseudonymized request and real server prompt', async () => {
  const options = reviewedOptions();
  expect(options.clinicalAnalysis.deductions).toEqual(['Formulation modifiée et validée pour Lucie Fictive.']);
  const h = client({ patient: 'Lucie Fictive', notes: 'Consultation fictive pour Lucie Fictive.' });
  const payload = await h.generate(options);
  expect(payload.clinicalAnalysis.deductions).toHaveLength(1);
  expect(payload.clinicalAnalysis.deductions[0]).toContain('Formulation modifiée et validée');
  expect(JSON.stringify(payload)).not.toMatch(/Lucie|Fictive|INITIAL NON VALIDÉ|INTERPRÉTATION NON RETENUE/);
  await request(app).post('/api/generate/compte-rendu').set('Authorization', 'Bearer ' + token).send(payload).expect(200);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  const prompt = mockCreate.mock.calls[0][0];
  expect(prompt.system).toContain(payload.clinicalAnalysis.deductions[0]);
  expect(JSON.stringify(prompt)).not.toMatch(/Lucie|Fictive|INITIAL NON VALIDÉ|INTERPRÉTATION NON RETENUE/);
  expect(h.elements.out.dataset.plain).toContain('Lucie Fictive');
});

test('no checked interpretation remains none in the generation prompt', async () => {
  const h = client({ patient: 'Lucie Fictive', notes: 'Notes fictives.' });
  const payload = await h.generate(reviewedOptions({ checked: false }));
  expect(payload.clinicalAnalysis.deductions).toEqual([]);
  await request(app).post('/api/generate/compte-rendu').set('Authorization', 'Bearer ' + token).send(payload).expect(200);
  const prompt = mockCreate.mock.calls[0][0].system;
  expect(prompt).toMatch(/Interprétations explicitement validées[^\n]*aucune/);
  expect(prompt).not.toMatch(/INITIAL NON VALIDÉ|INTERPRÉTATION NON RETENUE/);
});

test('nested reviewed fields share substitutions and never send known patient identifiers', () => {
  const h = client({});
  const payload = {
    patient: 'Lucie Fictive', age: '48 ans', ddn: '1978-03-15', notes: 'Lucie Fictive, NIR 2780375116001.',
    acceptedSuggestions: ['Contacter Lucie Fictive au domicile 12 rue des Lilas, 75011 Paris.'],
    clinicalAnalysis: {
      deductions: ['Chez Lucie Fictive, NIR 2780375116001, composante à préciser.'],
      inconsistencies: ['Lucie Fictive indique 48 ans.'],
      specialtyFocus: ['Évaluation de Lucie Fictive.']
    }
  };
  const original = cleanCopy(payload);
  const pseudo = h.sandbox.pseudonymizePayload('consult', payload);
  expect(JSON.stringify(payload)).not.toMatch(/Lucie|Fictive|2780375116001|rue des Lilas|48 ans|1978-03-15/);
  expect(h.sandbox.resubstitute(payload.clinicalAnalysis.deductions[0], pseudo.substitutions, pseudo.patientOrig)).toContain('2780375116001');
  expect(h.sandbox.resubstitute(payload.acceptedSuggestions[0], pseudo.substitutions, pseudo.patientOrig)).toContain('12 rue des Lilas');
  expect(original.patient).toBe('Lucie Fictive');
});

test('raw model facts and unreviewed pack interpretations do not leak through clinicalAnalysis payload', async () => {
  const h = client({ patient: 'Lucie Fictive', notes: 'Notes fictives.' });
  const options = { mode: 'standard', clinicalAnalysis: {
    facts: ['PATIENT_IDENTIFIER_OUTSIDE_REVIEW'], deductions: ['Conclusion validée.'],
    inconsistencies: ['Incertitude à vérifier.'], specialtyFocus: ['Topographie'],
    specialtyPack: { interpretations: [{ text: 'UNREVIEWED_PACK_HYPOTHESIS', status: 'PENDING_REVIEW' }] }
  } };
  const payload = await h.generate(options);
  expect(payload.clinicalAnalysis.deductions).toEqual(['Conclusion validée.']);
  expect(JSON.stringify(payload.clinicalAnalysis)).not.toMatch(/PATIENT_IDENTIFIER_OUTSIDE_REVIEW|UNREVIEWED_PACK_HYPOTHESIS/);
});

test('archive stores the dated physician review, selected wording and specialty pack', async () => {
  const options = reviewedOptions();
  options.specialtyPack = { id: 'algologie', version: '1.0.0' };
  const h = client({});
  h.sandbox.lastClinicalOptions.consult = options;
  h.sandbox.api = jest.fn(async () => ({ document: { id: 'synthetic-archive' } }));
  vm.runInContext('var dernierArchive = {}; var derniereProvenance = {};\n' + extract('async function archiverDocument('), h.sandbox);
  await h.sandbox.archiverDocument('consult', { getPatient: () => 'Lucie Fictive', label: 'Compte rendu' }, 'Document fictif retenu.');
  const payload = JSON.parse(h.sandbox.api.mock.calls[0][1].body);
  expect(Number.isFinite(Date.parse(payload.meta.clinicalReview.reviewedAt))).toBe(true);
  expect(payload.meta.clinicalReview.interpretations).toEqual(['Formulation modifiée et validée pour Lucie Fictive.']);
  expect(payload.meta.clinicalReview.specialtyPack).toEqual({ id: 'algologie', version: '1.0.0' });
  expect(JSON.stringify(payload.meta)).not.toMatch(/INITIAL NON VALIDÉ|INTERPRÉTATION NON RETENUE/);
});

test('historical patient and document identifiers are removed at the real SDK boundary', async () => {
  const patient = await request(app).post('/api/patients').set('Authorization', 'Bearer ' + token).send({
    nom: 'Lucie Fictive', ddn: '1978-03-15', sexe: 'F', patho: 'Douleur suivie chez Lucie Fictive.', traitements: 'Traitement fictif 1500 mg', allergies: 'Aucune rapportée.'
  }).expect(201);
  const patientId = patient.body.patient.id;
  await request(app).post('/api/documents').set('Authorization', 'Bearer ' + token).send({
    patientId, patientNom: 'Lucie Fictive', type: 'cr',
    contenu: 'Lucie Fictive, née le 15 mars 1978. NIR 2780375116001. Domicile 12 rue des Lilas, 75011 Paris. Téléphone 06 12 34 56 78. lucie@example.invalid. Traitement fictif 1500 mg; évolution favorable.'
  }).expect(201);
  const response = await request(app).post('/api/generate/compte-rendu').set('Authorization', 'Bearer ' + token).send({
    patientId, patient: 'PATIENT_CONFIDENTIEL', notes: 'Réévaluation fictive du jour, évolution favorable.'
  }).expect(200);
  const prompt = JSON.stringify(mockCreate.mock.calls[0][0]);
  expect(prompt).not.toMatch(/Lucie|Fictive|15 mars 1978|1978-03-15|2780375116001|rue des Lilas|75011|06 12 34 56 78|lucie@example/);
  expect(prompt).toContain('Traitement fictif 1500 mg');
  expect(prompt).toContain('évolution favorable');
  // Identified provenance stays available to the authenticated physician.
  expect(response.body.contexte.patient.nom).toBe('Lucie Fictive');
  expect(response.body.contexte.utilise).toBe(true);
});

test('incomplete scale items never produce an inferred numeric DN4/PEG in the prompt', async () => {
  const payload = { patient: 'PATIENT_CONFIDENTIEL', notes: 'Douleur avec brûlure depuis plusieurs semaines.', specialtyPack: 'algologie', scaleInputs: { dn4: [true, false], peg: [5, 6] } };
  const response = await request(app).post('/api/generate/compte-rendu').set('Authorization', 'Bearer ' + token).send(payload).expect(200);
  expect(response.body.specialtyPack.scores.every(score => score.status === 'INCOMPLETE' && score.value === null)).toBe(true);
  const prompt = mockCreate.mock.calls[0][0];
  expect(prompt.messages[0].content).not.toMatch(/DN4\s*:|PEG\s*:|Scores calculés/);
  expect(prompt.system).toContain('Ne calcule aucun autre score depuis des items absents');
});

test('completed scores reach source prompt while their interpretation remains pending unless selected', async () => {
  const payload = { patient: 'PATIENT_CONFIDENTIEL', notes: 'Douleur avec brûlure. Examen et retentissement renseignés.', specialtyPack: 'algologie', scaleInputs: { dn4: [true, true, true, true, false, false, false, false, false, false], peg: [3, 6, 9] } };
  const response = await request(app).post('/api/generate/compte-rendu').set('Authorization', 'Bearer ' + token).send(payload).expect(200);
  const pack = response.body.specialtyPack;
  expect(pack.scores.map(score => score.value)).toEqual([4, 6]);
  expect(pack.interpretations[0].status).toBe('PENDING_REVIEW');
  const prompt = mockCreate.mock.calls[0][0];
  expect(prompt.messages[0].content).toContain('DN4 : 4/10');
  expect(prompt.messages[0].content).toContain('PEG : 6/10');
  expect(JSON.stringify(prompt)).not.toContain(pack.interpretations[0].text);
  expect(analyzeSpecialtyPack('algologie', '', { dn4: Array(10).fill(null), peg: ['3', 6, 9] }).scores.every(score => score.value === null)).toBe(true);
});
