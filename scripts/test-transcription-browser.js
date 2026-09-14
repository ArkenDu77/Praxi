/* Real clicks on the complete application. No upstream requests, identity,
 * credentials or patient records. Speech service is synthetic; MediaRecorder
 * really captures Chromium's generated test microphone on localhost. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const playwright = require(process.env.PLAYWRIGHT_MODULE || '../../doctolib-lab/node_modules/playwright');
const { listSpecialtyPacks } = require('../lib/specialty-packs');

async function main() {
  const publicDir = path.join(__dirname, '..', 'public');
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const allowed = { '/app.html': 'text/html', '/app.css': 'text/css', '/transcription.js': 'application/javascript',
      '/physician-workflow.js': 'application/javascript', '/physician-workflow.css': 'text/css' };
    if (!allowed[name]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': allowed[name] + '; charset=utf-8' });
    res.end(fs.readFileSync(path.join(publicDir, name.slice(1))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await playwright.chromium.launch({
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : process.platform === 'win32' ? { channel: 'msedge' } : {}),
      headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1100 }, permissions: ['microphone'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const user = { id: 'synthetic-doctor', prenom: 'Médecin', nom: 'Test', email: 'synthetic@example.invalid', specialite: 'Algologue', specialites: ['Algologue'], abonnement: { plan: 'pro', actif: true, fonctionnalites: { consultation: true, dictee: true } } };
      const today = new Date();
      today.setUTCHours(9, 30, 0, 0);
      const encounter = { encounter_id: 'enc-browser-1', patient_name: 'Patient synthétique', scheduled_start: today.toISOString(), display_status: 'Dossier à relire' };
      const waiting = { sans_preconsultation: true, rendez_vous: { patient: 'Patient en attente', starts_at: new Date(today.getTime() + 3600000).toISOString() } };
      const response = url.pathname === '/api/auth/me' ? { user }
        : url.pathname === '/api/specialites' ? { specialites: ['Algologue'] }
        : url.pathname === '/api/clinical/specialty-packs' ? { packs: listSpecialtyPacks() }
        : url.pathname === '/api/preconsult/encounters' ? { encounters: [encounter] }
        : url.pathname === '/api/preconsult/rendez-vous' ? { calls: [waiting] }
        : url.pathname === '/api/integrations' ? { integrations: [{ kind: 'doctolib_browser', state: 'TEMPORARILY_UNAVAILABLE', last_observed_at: new Date().toISOString() }] }
        : { patients: [], documents: [], appointments: [], etapes: [], fonctionnalites: {}, integrations: [], calls: [] };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.addInitScript(() => {
      localStorage.setItem('praxi_token', 'synthetic-local-test');
      localStorage.setItem('praxi_migration_v2', '1');
      localStorage.setItem('praxi_theme_choisi', '1');
      window.__speechTest = { instances: [] };
      class SyntheticSpeech {
        constructor() { window.__speechTest.instances.push(this); }
        start() { queueMicrotask(() => this.onstart?.()); }
        abort() { this.onend?.(); }
      }
      window.SpeechRecognition = SyntheticSpeech;
      window.__speechTest.result = (text, final = true) => {
        const result = [{ transcript: text }]; result.isFinal = final;
        window.__speechTest.instances.at(-1).onresult?.({ results: [result] });
      };
      window.__speechTest.disconnect = () => window.__speechTest.instances.at(-1).onerror?.({ error: 'network' });
    });
    await page.goto(origin + '/app.html');
    await page.locator('#view-today.active').waitFor();
    assert.equal(await page.locator('.wf-primary-nav .side-link').count(), 3);
    await page.locator('#today-content [data-health="DEGRADED"]').waitFor();
    assert.equal(await page.locator('#today-content .wf-today-counts div').first().locator('b').innerText(), '2');
    assert((await page.locator('#today-content').innerText()).includes('rendez-vous visibles aujourd’hui'));
    assert((await page.locator('#today-content').innerText()).includes('Patient synthétique'));
    await page.locator('[data-view="consult"]').first().click();
    await page.locator('#ct-next-1').click();
    await page.locator('#ct-specialty [data-pack]').waitFor();
    assert.equal(await page.locator('#ct-specialty [data-pack]').inputValue(), 'algologie');
    assert.equal(await page.locator('#ct-specialty [data-scale-item]').count(), 13);
    const notes = page.locator('#ct-notes');
    await notes.fill('Note fictive tapée avant écoute.');
    const mic = page.locator('[data-mic="ct-notes"]');
    const micStatus = notes.locator('xpath=parent::div/following-sibling::div[contains(@class,"mic-status")][1]');
    await mic.click();
    await micStatus.getByText('Transcription active', { exact: false }).waitFor();
    await micStatus.getByText('Audio de secours capturé dans cet onglet uniquement.', { exact: false }).waitFor();
    await page.evaluate(() => window.__speechTest.result('Phrase fictive provisoire.', false));
    assert((await notes.inputValue()).includes('Phrase fictive provisoire.'));
    await notes.press('End');
    await notes.pressSequentially(' Correction médecin fictive.');
    await page.evaluate(() => window.__speechTest.disconnect());
    await micStatus.getByText('Reconnexion à la transcription', { exact: false }).waitFor();
    await micStatus.getByText('Transcription active', { exact: false }).waitFor();
    await page.evaluate(() => window.__speechTest.result('Suite après la coupure.'));
    const value = await notes.inputValue();
    for (const phrase of ['Note fictive tapée avant écoute.', 'Phrase fictive provisoire.', 'Correction médecin fictive.', 'Suite après la coupure.']) assert(value.includes(phrase), phrase);
    // Wait for actual MediaRecorder data, not a mocked existence of the button.
    await page.waitForFunction(() => document.querySelector('[data-mic="ct-notes"]')._micLastSession.session.snapshot().audio.bytes > 0);
    const captureBeforeStop = await page.evaluate(() => document.querySelector('[data-mic="ct-notes"]')._micLastSession.session.snapshot().audio);
    await mic.click();
    assert.equal(await mic.getAttribute('aria-pressed'), 'false');
    const archive = page.locator('[data-mic-archive="ct-notes"]');
    await archive.getByRole('button', { name: 'Télécharger le secours audio' }).waitFor();
    const downloadReady = page.waitForEvent('download');
    await archive.getByRole('button', { name: 'Télécharger le secours audio' }).click();
    const download = await downloadReady;
    assert(download.suggestedFilename().endsWith('.webm') || download.suggestedFilename().endsWith('.m4a'));
    // Restart and fatal permission error; archive and notes must survive.
    await mic.click();
    await micStatus.getByText('Transcription active', { exact: false }).waitFor();
    await page.evaluate(() => window.__speechTest.instances.at(-1).onerror?.({ error: 'not-allowed' }));
    await micStatus.getByText('Transcription interrompue', { exact: false }).waitFor();
    assert.equal(await mic.getAttribute('aria-pressed'), 'false');
    assert.equal(await notes.inputValue(), value);
    assert.equal(await archive.count(), 1);
    await page.clock.install();
    await page.clock.runFor(10000);
    await micStatus.getByText('Transcription interrompue', { exact: false }).waitFor();
    await archive.getByRole('button', { name: 'Supprimer le secours audio' }).click();
    assert.equal(await archive.count(), 0);
    assert.deepEqual(errors, []);
    const output = path.join(__dirname, '..', 'docs', 'transcription-browser-2026-09-14.json');
    const evidence = { test: 'real-browser-clicks', status: 'PASS', browser: await browser.version(), assertions: 21,
      transcriptionProvider: 'synthetic Web Speech API', capture: 'real MediaRecorder with Chromium synthetic microphone',
      actualAudioBytesBeforeStop: captureBeforeStop.bytes, noPatientData: true, noUpstreamRequests: true,
      scenarios: ['three-space navigation', 'today workspace with degraded Doctolib health', 'algology scale rendering', 'start by click', 'type while dictating', 'interim preservation', 'forced network error without end', 'automatic recovery', 'stop by click', 'backup download', 'archive survives restart', 'permission failure persists over 9 seconds', 'backup explicit discard'], pageErrors: errors };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
