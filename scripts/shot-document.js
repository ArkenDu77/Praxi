// Capture l'écran de résultat (document généré + panneau de vérification)
// sans appeler l'IA : on injecte un document réaliste et une analyse clinique
// de la même forme que celle du serveur.
// Usage : node scripts/shot-document.js <label>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const CHROMIUM = process.env.CHROMIUM_PATH
  || fs.globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome')?.[0]
  || '/opt/pw-browsers/chromium/chrome-linux/chrome';

const LABEL = process.argv[2] || 'doc-avant';
const OUT = path.join(process.cwd(), '.screenshots', LABEL);
const BASE = process.env.BASE || 'http://localhost:3099';
fs.mkdirSync(OUT, { recursive: true });

const DOC = `Dr Camille Rivière
Cardiologue
12 rue des Lilas, 69003 Lyon
RPPS 10101010101

Lyon, le 07 août 2026

MOTIF DE CONSULTATION :
Suivi de fibrillation atriale permanente, à trois mois de la dernière consultation. Le patient rapporte une gêne à l'effort en aggravation depuis trois semaines.

ANTÉCÉDENTS ET FACTEURS DE RISQUE CARDIOVASCULAIRE :
Hypertension artérielle traitée depuis 2018. Tabagisme sevré en 2020, estimé à 25 paquets-années. Pas d'antécédent coronarien ni d'accident vasculaire cérébral.

EXAMEN CLINIQUE ET CONSTANTES :
Pression artérielle 138/84 mmHg aux deux bras. Fréquence cardiaque 78 par minute, irrégulière. Auscultation cardiaque sans souffle. Absence d'œdème des membres inférieurs. Poids stable à 82 kg.

EXAMENS COMPLÉMENTAIRES :
ECG réalisé au cabinet : fibrillation atriale à cadence ventriculaire contrôlée, sans trouble de la repolarisation.

SYNTHÈSE DIAGNOSTIQUE :
Fibrillation atriale permanente bien tolérée sur le plan hémodynamique, à cadence contrôlée sous bêtabloquant. La gêne à l'effort rapportée justifie de réévaluer la tolérance fonctionnelle.

CONDUITE À TENIR :
Poursuite de l'anticoagulation orale et du bêtabloquant aux posologies actuelles. Un Holter ECG des 24 heures pourrait être utile si vous le jugez indiqué, afin de documenter la cadence à l'effort.

SURVEILLANCE :
Réévaluation clinique dans trois mois, avec contrôle de la fonction rénale avant renouvellement de l'anticoagulant.`;

const ANALYSE = {
  confidence: 78,
  confidenceLabel: 'Bon dossier',
  scoreSummary: "Dossier exploitable. L'ancienneté de la fibrillation et la tolérance du traitement renforceraient la synthèse.",
  facts: ['Fibrillation atriale permanente', 'HTA traitée depuis 2018', 'PA 138/84 mmHg', 'FC 78/min irrégulière', 'ECG au cabinet sans trouble de repolarisation'],
  confidenceBreakdown: [
    { label: 'Motif renseigné', value: 15 }, { label: 'Examen clinique', value: 20 },
    { label: 'Constantes chiffrées', value: 15 }, { label: 'Examens complémentaires', value: 10 },
    { label: 'Ancienneté du trouble', value: -12 }, { label: 'Tolérance du traitement', value: -8, kind: 'optional' },
  ],
  inconsistencies: ["« Gêne à l'effort en aggravation » coexiste avec « bien tolérée » dans la synthèse."],
  missing: ['chronologie', 'traitements'],
  optionalMissing: ['allergies'],
  deductions: [
    "La gêne à l\u2019effort peut traduire une cadence ventriculaire mal contrôlée à l\u2019effort.",
    "Le sevrage tabagique de 2020 réduit le risque évolutif à moyen terme.",
  ],
  questions: ["Depuis combien de temps la fibrillation est-elle connue ?", 'Le bêtabloquant est-il bien toléré ?'],
  suggestions: [
    { label: 'Holter ECG des 24 heures', confidence: 78, rationale: "Documente la cadence ventriculaire à l'effort." },
    { label: 'Contrôle de la fonction rénale', confidence: 82, rationale: "Conditionne la posologie de l'anticoagulant." },
    { label: 'Échocardiographie de réévaluation', confidence: 65, rationale: 'Réévalue la FEVG à trois ans du diagnostic.' },
    { label: 'Score CHA2DS2-VASc à recalculer', confidence: 70, rationale: "Vérifie l'indication d'anticoagulation." },
    { label: 'Épreuve d\'effort', confidence: 55, rationale: 'À discuter selon la tolérance.', role: 'specialiste' },
  ],
  specialtyFocus: [],
  recommendedLength: 'standard',
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  const r = await page.request.post(`${BASE}/api/auth/register`, {
    data: { prenom: 'Camille', nom: 'Rivière', email: `doc.${Date.now()}@example.com`,
            password: 'TestPassword1', specialites: ['Cardiologue'], ville: 'Lyon' },
  });
  const { token, user } = await r.json();
  if (!token) { console.error('register failed'); process.exit(1); }

  await page.goto(`${BASE}/login.html`);
  await page.evaluate(([t, u]) => {
    localStorage.setItem('praxi_token', t);
    localStorage.setItem('praxi_profil', JSON.stringify(u));
    localStorage.setItem('praxi_migration_v2', 'vide');
  }, [token, user]);
  await page.goto(`${BASE}/app.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);

  // ── Document rendu ──
  await page.evaluate(([doc]) => {
    window.switchView('cr');
    const cfg = window.GEN ? window.GEN.cr : { outId: 'c-out', resId: 'c-result' };
    const outEl = document.getElementById(cfg.outId);
    window.renderResult(outEl, doc);
    window.renderTools('cr');
    const host = document.getElementById(cfg.resId);
    host.classList.add('show');
    window.renderPraxiVerification(host, {}, { requiresReview: true, unsupportedNumbers: ['24'] }, outEl);
  }, [DOC]);
  await page.waitForTimeout(700);
  await page.locator('#c-result').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'document.png') });
  console.log('  ✓ Document généré');

  // ── Panneau de vérification finale ──
  await page.evaluate(([a]) => {
    window.renderClinicalReview('cr', document.querySelector('[data-gen="cr"]') || document.createElement('button'),
      'Générer le compte-rendu', a, { documentType: 'cr' });
  }, [ANALYSE]);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'verification.png') });
  console.log('  ✓ Panneau de vérification');

  // Suggestions dépliées : c'est là que vit la bascule Oui/Non.
  const fold = page.locator('.cv-fold summary', { hasText: 'Suggestions' });
  if (await fold.count()) {
    await fold.first().click();
    await page.waitForTimeout(500);
    // Une suggestion basculée sur Oui, pour comparer les deux états.
    const t = page.locator('.suggestion-toggle');
    if (await t.count()) { await t.first().click(); await page.waitForTimeout(400); }
    await page.screenshot({ path: path.join(OUT, 'suggestions.png') });
    console.log('  ✓ Suggestions dépliées');
  }

  await browser.close();
  console.log(`→ ${OUT}`);
})();
