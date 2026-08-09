// Banc d'essai de la dictée vocale — reproduit les moteurs de reconnaissance
// réels, pas seulement celui de la machine du développeur.
//
// Le bug de duplication a déjà été « corrigé » une fois : le texte se répétait
// en boucle chez un testeur sur iPhone alors que le même code se comportait
// correctement sur le poste du fondateur. La cause est que les moteurs ne
// livrent pas leurs résultats de la même façon, et qu'un correctif validé sur
// un seul moteur ne prouve rien pour les autres.
//
// Ce script rejoue la même dictée contre quatre profils de moteur documentés,
// en relevant le contenu du champ APRÈS CHAQUE fragment reconnu — c'est
// pendant l'enregistrement que le texte se répétait, pas à la fin.
//
// Usage : BASE=http://localhost:3099 node scripts/dictee-check.js
const { chromium } = require('playwright');

const CHROMIUM = process.env.CHROMIUM_PATH
  || require('fs').globSync?.('/opt/pw-browsers/chromium-*/chrome-linux/chrome')?.[0]
  || '/opt/pw-browsers/chromium/chrome-linux/chrome';
const BASE = process.env.BASE || 'http://localhost:3099';

// ── Profils de moteur ────────────────────────────────────────────────────
// Chacun décrit une façon observée de remplir SpeechRecognitionEvent.results.
//
//  chrome            Chrome/Edge desktop et Android : liste cumulative, un
//                    seul résultat intermédiaire en queue, remplacé à chaque
//                    événement puis figé en isFinal. `continuous` respecté.
//
//  chrome-silence    Idem, mais le navigateur coupe l'écoute après chaque
//                    énoncé (comportement courant sur mobile). La liste
//                    repart vide au start() suivant.
//
//  ios-interim       Safari iOS : `continuous` ignoré, et surtout les
//                    résultats intermédiaires s'EMPILENT dans la liste au
//                    lieu de se remplacer, chacun reprenant l'énoncé complet
//                    depuis le début (isFinal reste false).
//                    → concaténer la liste répète le texte en boucle.
//
//  ios-retain        Variante observée : la liste de résultats n'est pas
//                    réinitialisée par un nouveau start() sur la même
//                    instance. Les énoncés déjà validés sont donc relivrés
//                    à chaque relance qui suit une coupure de silence.
//
//  ios-pire         Les deux à la fois : rien n'interdit à un moteur de
//                   cumuler les deux comportements, et c'est le cas qui
//                   dupliquait le plus vite.
const PROFILS = ['chrome', 'chrome-silence', 'ios-interim', 'ios-retain', 'ios-pire'];

// Énoncé de test : deux phrases, dictées en trois fragments chacune.
const PHRASES = [
  ['patient de', 'patient de soixante', 'patient de soixante-douze ans'],
  ['douleur thoracique', 'douleur thoracique depuis', 'douleur thoracique depuis deux jours'],
];

// ── Le faux moteur, injecté avant tout script de la page ─────────────────
function installerFauxMoteur(profil) {
  const continuous = !profil.startsWith('ios');   // iOS ignore `continuous`
  const empileInterim = profil === 'ios-interim' || profil === 'ios-pire';
  const conserveListe = profil === 'ios-retain'  || profil === 'ios-pire';

  function faireResultat(texte, isFinal) {
    const alt = { transcript: texte, confidence: 0.9 };
    const r = [alt];
    r.isFinal = isFinal; r.length = 1; r.item = () => alt;
    return r;
  }

  class FakeSpeechRecognition {
    constructor() {
      this.lang = ''; this.continuous = false; this.interimResults = false;
      this.onresult = null; this.onend = null; this.onerror = null; this.onstart = null;
      this._results = [];     // liste vivante (sémantique SpeechRecognitionResultList)
      this._finalCount = 0;   // nombre de résultats figés — base de resultIndex
      this._running = false;
      window.__dictee.instances.push(this);
    }
    start() {
      if (this._running) throw new Error('InvalidStateError');
      this._running = true;
      if (!conserveListe) { this._results = []; this._finalCount = 0; }
      window.__dictee.actif = this;
      if (this.onstart) this.onstart();
    }
    stop()  { this._terminer(); }
    abort() { this._terminer(); }
    addEventListener() {} removeEventListener() {}

    _terminer() {
      if (!this._running) return;
      this._running = false;
      if (window.__dictee.actif === this) window.__dictee.actif = null;
      if (this.onend) this.onend();
    }
    _interim(texte) {
      if (empileInterim) {
        // Safari iOS : on AJOUTE un résultat, on ne remplace pas le précédent.
        this._results.push(faireResultat(texte, false));
      } else {
        // Chrome : un seul intermédiaire, en queue, remplacé à chaque fois.
        if (this._results.length > this._finalCount) this._results.pop();
        this._results.push(faireResultat(texte, false));
      }
      this._emettre();
    }
    _final(texte) {
      this._results.length = this._finalCount;   // les intermédiaires disparaissent
      this._results.push(faireResultat(texte, true));
      this._finalCount = this._results.length;
      this._emettre();
    }
    _emettre() {
      if (!this.onresult) return;
      const liste = this._results.slice();
      liste.item = i => liste[i];
      this.onresult({ results: liste, resultIndex: Math.max(0, this._finalCount - 1) });
    }
  }

  window.__dictee = {
    profil, continuous, instances: [], actif: null,
    // Les moteurs réels préfixent d'une espace les énoncés qui suivent le
    // premier d'une même session ; on reproduit ce détail pour ne pas
    // confondre un défaut d'espacement avec une duplication.
    interim(texte, premier) {
      const r = window.__dictee.actif;
      if (r) r._interim(premier ? texte : ' ' + texte);
    },
    final(texte, premier) {
      const r = window.__dictee.actif;
      if (r) r._final(premier ? texte : ' ' + texte);
    },
    finSession() { const r = window.__dictee.actif; if (r) r._terminer(); },
  };

  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
}

const norm = s => s.replace(/\s+/g, ' ').trim();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  let echecs = 0;

  // Un seul compte pour toute la campagne : la limite de débit de /register
  // est volontairement basse et couperait les profils suivants.
  const amorce = await browser.newContext();
  const rep = await amorce.request.post(`${BASE}/api/auth/register`, {
    data: { prenom: 'Test', nom: 'Dictee', email: `dictee.${Date.now()}@example.com`,
            password: 'TestPassword1', specialites: ['Cardiologue'], ville: 'Lyon' },
  });
  const { token, user, error } = await rep.json();
  if (!token) { console.error('  inscription impossible :', error || rep.status()); process.exit(1); }
  await amorce.close();

  for (const profil of PROFILS) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(installerFauxMoteur, profil);

    await page.goto(`${BASE}/login.html`);
    await page.evaluate(([t, u]) => {
      localStorage.setItem('praxi_token', t);
      localStorage.setItem('praxi_profil', JSON.stringify(u));
      localStorage.setItem('praxi_migration_v2', 'vide');
    }, [token, user]);
    await page.goto(`${BASE}/app.html`);
    await page.waitForSelector('[data-mic="c-notes"]', { state: 'attached' });
    await page.evaluate(() => window.switchView('cr'));
    await page.waitForSelector('[data-mic="c-notes"]');

    await page.click('[data-mic="c-notes"]');
    await page.waitForTimeout(120);

    const anomalies = [];
    let acquis = '';        // ce qui doit être définitivement acquis dans le champ
    let premier = true;

    for (const phrase of PHRASES) {
      for (const fragment of phrase) {
        await page.evaluate(([t, p]) => window.__dictee.interim(t, p), [fragment, premier]);
        await page.waitForTimeout(60);
        const vu = norm(await page.inputValue('#c-notes'));
        const attendu = norm(acquis + ' ' + fragment);
        if (vu !== attendu) anomalies.push({ etape: `interim « ${fragment} »`, attendu, vu });
      }
      const dernier = phrase[phrase.length - 1];
      await page.evaluate(([t, p]) => window.__dictee.final(t, p), [dernier, premier]);
      await page.waitForTimeout(60);
      acquis = norm(acquis + ' ' + dernier);
      premier = false;
      const vu = norm(await page.inputValue('#c-notes'));
      if (vu !== acquis) anomalies.push({ etape: `final « ${dernier} »`, attendu: acquis, vu });

      // Sans `continuous`, le moteur rend la main après chaque énoncé : c'est
      // la relance automatique de l'application qui prend le relais.
      if (!profil.startsWith('chrome')) {
        await page.evaluate(() => window.__dictee.finSession());
        await page.waitForTimeout(400);
        const apresRelance = norm(await page.inputValue('#c-notes'));
        if (apresRelance !== acquis) {
          anomalies.push({ etape: 'relance après coupure', attendu: acquis, vu: apresRelance });
          acquis = apresRelance;   // on repart du réel pour ne pas cascader
        }
      }
    }

    // ── Le médecin reprend la main au clavier pendant que le micro tourne ──
    // La saisie manuelle est prioritaire : ce qu'il tape ne doit pas être
    // écrasé, et la dictée doit reprendre à la suite sans republier ce qui
    // précède.
    await page.focus('#c-notes');
    await page.evaluate(() => {
      const el = document.getElementById('c-notes');
      el.value = el.value + ' — corrigé au clavier';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(60);
    acquis = norm(acquis + ' — corrigé au clavier');
    let vuClavier = norm(await page.inputValue('#c-notes'));
    if (vuClavier !== acquis) anomalies.push({ etape: 'frappe clavier', attendu: acquis, vu: vuClavier });

    const suite = ['bilan', 'bilan biologique'];
    for (const fragment of suite) {
      await page.evaluate(([t, p]) => window.__dictee.interim(t, p), [fragment, false]);
      await page.waitForTimeout(60);
      const vu = norm(await page.inputValue('#c-notes'));
      const attendu = norm(acquis + ' ' + fragment);
      if (vu !== attendu) anomalies.push({ etape: `interim après clavier « ${fragment} »`, attendu, vu });
    }

    // ── Arrêt par le bouton de génération, pas par l'icône micro ──
    // C'est le geste réel du médecin. La soumission doit couper le micro ET
    // conserver le fragment en cours, qui ne sera jamais validé.
    acquis = norm(acquis + ' ' + suite[suite.length - 1]);
    await page.evaluate(() => document.querySelector('[data-gen="cr"]').click());
    await page.waitForTimeout(600);
    const micActif = await page.evaluate(() => Boolean(window.__dictee.actif));
    const finalChamp = norm(await page.inputValue('#c-notes'));
    if (finalChamp !== acquis) {
      anomalies.push({ etape: 'champ après « Générer »', attendu: acquis, vu: finalChamp });
    }

    const ok = !anomalies.length && !micActif;
    if (!ok) echecs++;
    console.log(`\n${ok ? '✓' : '✗'} profil « ${profil} »`);
    for (const a of anomalies) {
      console.log(`    ✗ ${a.etape}`);
      console.log(`        attendu : ${JSON.stringify(a.attendu)}`);
      console.log(`        obtenu  : ${JSON.stringify(a.vu)}`);
    }
    if (micActif) console.log('    ✗ le micro tourne encore après « Générer »');
    if (ok) console.log(`    champ final : ${JSON.stringify(finalChamp)}`);

    await ctx.close();
  }

  await browser.close();
  console.log(`\n${echecs ? `${echecs} profil(s) en échec` : 'Tous les profils passent.'}`);
  process.exit(echecs ? 1 : 0);
})();
