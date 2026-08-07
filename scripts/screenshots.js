// Captures d'écran de l'application Praxi, avec un dossier réaliste.
// Usage : node shot.js <label>
const { chromium } = require('playwright');
// Chromium fourni par l'environnement (PLAYWRIGHT_BROWSERS_PATH). Surchargeable
// via CHROMIUM_PATH si le binaire vit ailleurs.
const CHROMIUM = process.env.CHROMIUM_PATH
  || require('fs').globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome')?.[0]
  || '/opt/pw-browsers/chromium/chrome-linux/chrome';

const path = require('path');
const fs = require('fs');

const LABEL = process.argv[2] || 'after';
const OUT = process.argv[3] || path.join(process.cwd(), '.screenshots', LABEL);
const BASE = process.env.BASE || 'http://localhost:3099';
const SEED = process.env.SEED !== '0';

fs.mkdirSync(OUT, { recursive: true });

const CR = `MOTIF DE CONSULTATION :
Suivi de fibrillation atriale permanente, à trois mois de la dernière consultation.

ANTÉCÉDENTS ET FACTEURS DE RISQUE CARDIOVASCULAIRE :
Hypertension artérielle traitée depuis 2018. Tabagisme sevré en 2020, estimé à 25 paquets-années.

EXAMEN CLINIQUE ET CONSTANTES :
Pression artérielle 138/84 mmHg. Fréquence cardiaque 78/min, irrégulière. Auscultation cardiaque sans souffle. Absence d'œdème des membres inférieurs.

EXAMENS COMPLÉMENTAIRES :
ECG réalisé au cabinet : fibrillation atriale à cadence ventriculaire contrôlée, sans trouble de la repolarisation.

SYNTHÈSE DIAGNOSTIQUE :
Fibrillation atriale permanente bien tolérée, à cadence contrôlée sous bêtabloquant.

CONDUITE À TENIR :
Poursuite de l'anticoagulation orale et du bêtabloquant aux posologies actuelles.

SURVEILLANCE :
Réévaluation clinique dans trois mois.`;

const ORD = `ORDONNANCE MÉDICALE
Date : ${new Date().toLocaleDateString('fr-FR')}
Patient : Jean Dupont

1. Bisoprolol 5 mg — un comprimé le matin, traitement continu.
2. Apixaban 5 mg — un comprimé matin et soir, traitement continu.`;

const VIEWS = [
  ['patients', 'Patients'],
  ['cr', 'Compte-rendu'],
  ['consult', 'Consultation'],
  ['liaison', 'Lettre de liaison'],
  ['history', 'Historique'],
];

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const email = `shot.${Date.now()}@example.com`;
  const res = await page.request.post(`${BASE}/api/auth/register`, {
    data: { prenom: 'Camille', nom: 'Rivière', email, password: 'TestPassword1',
            specialites: ['Cardiologue'], ville: 'Lyon' },
  });
  const { token, user } = await res.json();
  if (!token) { console.error('register failed'); process.exit(1); }

  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let dossierId = null;

  if (SEED) {
    const p = await (await page.request.post(`${BASE}/api/patients`, {
      headers: H,
      data: { nom: 'Jean Dupont', ddn: '1958-04-22', sexe: 'M',
              patho: 'Fibrillation atriale permanente, hypertension artérielle',
              traitements: 'Bisoprolol 5 mg, Apixaban 5 mg x2',
              allergies: 'Pénicilline', mt: 'Dr Marchand' },
    })).json();
    dossierId = p.patient.id;

    const docs = [
      { type: 'cr', contenu: CR.replace('à trois mois de la dernière consultation', 'première consultation'), jours: 92 },
      { type: 'ordonnance', contenu: ORD, jours: 92 },
      { type: 'cr', contenu: CR, jours: 0 },
    ];
    for (const d of docs) {
      await page.request.post(`${BASE}/api/documents`, {
        headers: H, data: { patientId: dossierId, type: d.type, contenu: d.contenu },
      });
    }

    // La timeline n'a d'intérêt que si elle montre de la durée. Le serveur
    // date au moment de l'écriture : on recule les dates dans le stock pour
    // obtenir deux consultations à trois mois d'intervalle.
    const STORE = path.join(process.env.DATA_DIR || '/tmp/praxi-shots', 'dossiers.json');
    const db = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    const miens = db.documents.filter(x => x.patientId === dossierId);
    miens.forEach((doc, i) => {
      const j = docs[i] ? docs[i].jours : 0;
      if (j) doc.createdAt = new Date(Date.now() - j * 86400000).toISOString();
    });
    fs.writeFileSync(STORE, JSON.stringify(db, null, 2));

    await page.request.post(`${BASE}/api/patients`, {
      headers: H, data: { nom: 'Sophie Bernard', ddn: '1979-11-03', sexe: 'F',
                          patho: 'Hypertension artérielle essentielle' },
    });
    await page.request.post(`${BASE}/api/patients`, {
      headers: H, data: { nom: 'Marc Lefèvre', ddn: '1965-07-19', sexe: 'M',
                          patho: 'Insuffisance cardiaque NYHA II', allergies: 'Iode' },
    });
  }

  await page.goto(`${BASE}/login.html`);
  await page.evaluate(([t, u]) => {
    localStorage.setItem('praxi_token', t);
    localStorage.setItem('praxi_profil', JSON.stringify(u));
    localStorage.setItem('praxi_migration_v2', 'vide');
  }, [token, user]);

  await page.goto(`${BASE}/app.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  for (const [view, name] of VIEWS) {
    await page.evaluate(v => window.switchView(v), view);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${view}.png`) });
    console.log(`  ✓ ${name}`);
  }

  if (dossierId) {
    await page.evaluate(id => window.openDossier(id), dossierId);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'dossier.png') });
    console.log('  ✓ Dossier patient');

    // Écran de génération : l'attente doit montrer du travail, pas un spinner.
    await page.evaluate(() => {
      window.switchView('cr');
      window.startAiProgress('c-error', 'generate-contexte', { titre: 'Génération — dossier Jean Dupont' });
    });
    await page.waitForTimeout(1400);
    await page.screenshot({ path: path.join(OUT, 'generation.png') });
    console.log('  ✓ Génération en cours');
  }

  await browser.close();
  console.log(`→ ${OUT}`);
})();
