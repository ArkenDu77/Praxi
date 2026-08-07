// Parcours de bout en bout : création patient → document → timeline → relecture.
// Vérifie que le front tient réellement le parcours, pas seulement que le JS parse.
const { chromium } = require('playwright');
// Chromium fourni par l'environnement (PLAYWRIGHT_BROWSERS_PATH). Surchargeable
// via CHROMIUM_PATH si le binaire vit ailleurs.
const CHROMIUM = process.env.CHROMIUM_PATH
  || require('fs').globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome')?.[0]
  || '/opt/pw-browsers/chromium/chrome-linux/chrome';


const BASE = process.env.BASE || 'http://localhost:3099';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();

  const erreurs = [];
  page.on('console', m => { if (m.type() === 'error') erreurs.push(m.text()); });
  page.on('pageerror', e => erreurs.push('PAGEERROR: ' + e.message));

  const email = `smoke.${Date.now()}@example.com`;
  const res = await page.request.post(`${BASE}/api/auth/register`, {
    data: { prenom: 'Camille', nom: 'Rivière', email, password: 'TestPassword1',
            specialites: ['Cardiologue'], ville: 'Lyon' },
  });
  const { token, user } = await res.json();

  await page.goto(`${BASE}/login.html`);
  await page.evaluate(([t, u]) => {
    localStorage.setItem('praxi_token', t);
    localStorage.setItem('praxi_profil', JSON.stringify(u));
    // Données héritées : la migration doit les reprendre au premier chargement.
    localStorage.setItem('praxi_patients', JSON.stringify([
      { id: 'old1', nom: 'Hérité Ancien', patho: 'HTA' },
    ]));
    localStorage.setItem('praxi_history', JSON.stringify([
      { type: 'cr', patient: 'Hérité Ancien', contenu: 'Ancien compte-rendu local.',
        createdAt: new Date(Date.now() - 86400000).toISOString() },
    ]));
  }, [token, user]);

  await page.goto(`${BASE}/app.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const ok = [];
  const ko = [];
  const check = (nom, cond) => (cond ? ok : ko).push(nom);

  // 1. Migration des données locales
  await page.evaluate(() => window.switchView('patients'));
  await page.waitForTimeout(900);
  const migre = await page.locator('.pt-card', { hasText: 'Hérité Ancien' }).count();
  check('migration localStorage → serveur', migre === 1);

  // 2. Création d'un patient via l'interface
  await page.locator('#pt-new-disclosure summary').click();
  await page.fill('#pt-nom', 'Jean Dupont');
  await page.fill('#pt-patho', 'Fibrillation atriale');
  await page.fill('#pt-allergies', 'Pénicilline');
  await page.click('#pt-add-btn');
  await page.waitForTimeout(1200);

  // 3. Le dossier s'ouvre sur la timeline
  const surDossier = await page.locator('#view-dossier.active').count();
  check('ouverture du dossier après création', surDossier === 1);
  const nomAffiche = await page.locator('.dossier-nom').first().textContent().catch(() => '');
  check('nom du patient en tête de dossier', (nomAffiche || '').includes('Jean Dupont'));

  // 4. L'allergie remonte comme alerte, pas comme ligne de texte
  const alerte = await page.locator('.dossier-alerte').count();
  check('allergie signalée en alerte', alerte === 1);

  // 5. Timeline vide mais explicite
  const vide = await page.locator('#ds-timeline .history-empty').count();
  check('timeline vide explicite', vide === 1);

  // 6. Le bouton « Nouvelle consultation » lie le patient
  await page.click('#ds-new-consult');
  await page.waitForTimeout(700);
  const lie = await page.evaluate(() => {
    const b = document.querySelector('#view-consult [data-patient-pick]');
    return b ? b.dataset.lie : null;
  });
  check('patient lié au parcours consultation', lie === '1');
  const nomPrerempli = await page.inputValue('#ct-patient').catch(() => '');
  check('nom pré-rempli dans la consultation', nomPrerempli === 'Jean Dupont');

  // 7. Le sélecteur de dossier existe sur les écrans de rédaction
  const picks = await page.locator('[data-patient-pick]').count();
  check('sélecteur de dossier présent sur les écrans de rédaction', picks >= 3);

  // 8. Enregistrement d'un document et retour dans la timeline
  const docRes = await page.evaluate(async ([t]) => {
    const r = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: document.querySelector('[data-pick-select]').value,
        type: 'cr',
        contenu: 'MOTIF DE CONSULTATION :\nBilan de FA.\n\nEXAMEN CLINIQUE ET CONSTANTES :\nPA 138/84, FC 78 irrégulière.\n\nCONDUITE À TENIR :\nPoursuite anticoagulation.',
      }),
    });
    return r.status;
  }, [token]);
  check('enregistrement du document (201)', docRes === 201);

  await page.evaluate(() => window.switchView('patients'));
  await page.waitForTimeout(800);
  await page.locator('.pt-card', { hasText: 'Jean Dupont' }).click();
  await page.waitForTimeout(1000);
  const events = await page.locator('.tl-event').count();
  check('document visible dans la timeline', events === 1);

  // 9. Relecture : le document se rouvre dans son écran
  await page.locator('.tl-event').first().click();
  await page.waitForTimeout(1000);
  const surCr = await page.locator('#view-cr.active').count();
  check('relecture du document depuis la timeline', surCr === 1);
  const sections = await page.locator('#c-out .cr-section').count();
  check('compte-rendu rendu en rubriques', sections >= 3);

  await browser.close();

  console.log('\n  ✓ ' + ok.join('\n  ✓ '));
  if (ko.length) console.log('\n  ✗ ' + ko.join('\n  ✗ '));
  if (erreurs.length) {
    console.log('\n  Erreurs console :');
    [...new Set(erreurs)].slice(0, 10).forEach(e => console.log('   ! ' + e));
  }
  console.log(`\n  ${ok.length}/${ok.length + ko.length} vérifications passées`);
  process.exit(ko.length || erreurs.length ? 1 : 0);
})();
