/**
 * ============================================================================
 *  CHAQUE ÉTAT DE LA CONNEXION A UN ÉCRAN, ET AUCUN NE MENT
 * ============================================================================
 *
 * L'écran Liaison choisit son message ainsi :
 *
 *     const modele = INT_ETATS[nom] || INT_ETATS.DISCONNECTED;
 *
 * Ce repli est raisonnable pour une valeur inattendue. Il devient un MENSONGE
 * dès que le moteur gagne un état que l'écran ne connaît pas : une session
 * perdue, une panne temporaire ou une révocation s'afficheraient toutes
 * « Non connecté — Arkiba ne lit pas encore votre agenda ». Le médecin
 * cliquerait « Connecter Doctolib » pour une connexion qui existe déjà, ou
 * croirait n'avoir jamais rien branché alors que sa session vient d'expirer.
 *
 * Ce banc lit la liste des états chez le MOTEUR — la source qui fait foi — et
 * exige que l'écran ait un modèle pour chacun. Recopier la liste ici ne
 * prouverait rien : la copie dériverait avec le reste.
 *
 * Il exige aussi que chaque état dise quoi faire. Un écran qui affiche un état
 * sans suite laisse le médecin devant un mur.
 *
 * Run : npx jest tests/liaison-etats.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

/** Les états tels que le moteur les déclare, lus dans son propre schéma. */
const ETATS_DU_MOTEUR = (() => {
  const candidats = [
    path.join(__dirname, '..', '..', 'arkiba-intake', 'packages', 'domain', 'src', 'integration.ts'),
    path.join(__dirname, '..', '..', '..', 'Desktop', 'arkiba-intake', 'packages', 'domain', 'src', 'integration.ts'),
  ];
  const fichier = candidats.find((c) => fs.existsSync(c));
  if (!fichier) return null;
  const source = fs.readFileSync(fichier, 'utf8');
  const bloc = source.match(/ConnectorStateSchema = z\.enum\(\[([\s\S]*?)\]\)/);
  if (!bloc) throw new Error('ConnectorStateSchema introuvable dans le moteur');
  return [...bloc[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
})();

/** Les modèles d'écran, extraits et exécutés — pas cherchés à la ficelle. */
const INT_ETATS = (() => {
  const d = APP.indexOf('const INT_ETATS = {');
  if (d < 0) throw new Error('INT_ETATS introuvable');
  const f = APP.indexOf('\n};\n', d);
  const bac = {};
  vm.createContext(bac);
  vm.runInContext(APP.slice(d, f + 4) + '\nthis.resultat = INT_ETATS;', bac);
  return bac.resultat;
})();

describe("l'écran Liaison couvre le moteur", () => {
  test('LE MOTEUR EST LISIBLE — sinon ce banc ne prouve rien', () => {
    // Un banc qui ne trouve pas sa source doit le dire, pas passer en silence.
    expect(ETATS_DU_MOTEUR).not.toBeNull();
    expect(ETATS_DU_MOTEUR.length).toBeGreaterThan(3);
  });

  test('CHAQUE ÉTAT DU MOTEUR A SON MODÈLE — aucun ne tombe sur le repli', () => {
    const manquants = ETATS_DU_MOTEUR.filter((etat) => !INT_ETATS[etat]);
    // L'échec nomme les états manquants plutôt que de dire « faux ».
    expect({ etatsSansEcran: manquants }).toEqual({ etatsSansEcran: [] });
  });

  test('CHAQUE MODÈLE DIT QUOI FAIRE — un titre, et une suite', () => {
    const muets = [];
    const sansTitre = [];
    for (const [etat, modele] of Object.entries(INT_ETATS)) {
      if (typeof modele.titre !== 'string' || modele.titre.length === 0) sansTitre.push(etat);
      // Soit une action à cliquer, soit une explication de l'attente, soit la
      // possibilité de révoquer. Un état muet est un mur.
      if (!modele.action && !modele.detail && !modele.revoquer) muets.push(etat);
    }
    expect({ sansTitre, muets }).toEqual({ sansTitre: [], muets: [] });
  });

  test("LA SESSION PERDUE EST DISTINGUÉE D'UNE PANNE", () => {
    // Ces deux-là n'appellent pas la même réaction : l'une exige le médecin,
    // l'autre se répare seule. Les confondre l'enverrait se reconnecter pour
    // rien, ou le laisserait attendre une réparation qui ne viendra pas.
    const perdue = INT_ETATS.NEEDS_REAUTH;
    const panne = INT_ETATS.TEMPORARILY_UNAVAILABLE;
    expect(perdue.titre).not.toBe(panne.titre);
    // Une session perdue propose de se reconnecter ; une panne temporaire ne
    // demande rien au médecin.
    expect(Boolean(perdue.action)).toBe(true);
    expect(Boolean(panne.action)).toBe(false);
    expect(perdue.detail).toMatch(/vous seul|expir/i);
  });

  test("L'ÉCRAN LIT BIEN L'ÉTAT DU MOTEUR, il ne le devine pas", () => {
    expect(APP).toContain('integration ? integration.state : ');
    expect(APP).toContain('INT_ETATS[nom]');
  });
});
