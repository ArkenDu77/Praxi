/* ============================================================================
   ARKIBA — VITRINE
   Aucune dépendance. Le site est statique et servi tel quel : ajouter une
   bibliothèque d'animation depuis un CDN coûterait un aller-retour réseau
   bloquant à une page dont le premier atout est d'arriver vite. Tout ce que la
   narration demande — révélations étagées, fil du temps qui s'encre, dossier
   qui se remplit — tient dans un observateur d'intersection et des transitions
   CSS. Le mouvement est décrit en CSS ; ce fichier ne fait que dire « quand ».
   ============================================================================ */
(function () {
  'use strict';

  var reduit = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ── Échappement — toute valeur qui entre dans du HTML passe par ici ───── */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── En-tête ───────────────────────────────────────────────────────────── */
  var nav = document.getElementById('nav');
  var burger = document.getElementById('nav-burger');

  function auDefilement() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  auDefilement();
  window.addEventListener('scroll', auDefilement, { passive: true });

  function fermerMenu() {
    if (!nav.classList.contains('open')) return;
    nav.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Ouvrir le menu');
  }
  burger.addEventListener('click', function () {
    var ouvert = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(ouvert));
    burger.setAttribute('aria-label', ouvert ? 'Fermer le menu' : 'Ouvrir le menu');
  });
  document.getElementById('nav-mobile').addEventListener('click', function (e) {
    if (e.target.closest('a')) fermerMenu();
  });
  // Un menu qu'on ne peut refermer qu'en retrouvant le bouton est une impasse.
  document.addEventListener('click', function (e) { if (!nav.contains(e.target)) fermerMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fermerMenu(); });

  /* ── Révélations ───────────────────────────────────────────────────────── */
  var aReveler = document.querySelectorAll('[data-rev]');
  if (reduit.matches || !('IntersectionObserver' in window)) {
    // Sans observateur ou en mouvement réduit, tout est déjà là. Le contenu ne
    // dépend jamais de l'animation pour être lisible.
    for (var i = 0; i < aReveler.length; i++) aReveler[i].classList.add('vu');
  } else {
    var obs = new IntersectionObserver(function (entrees) {
      entrees.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('vu');
        obs.unobserve(e.target);
      });
      // Seuil à 0 : un bloc plus haut que la fenêtre (le registre, une grille)
      // ne doit pas attendre d'en montrer un pourcentage pour apparaître.
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0 });
    for (var j = 0; j < aReveler.length; j++) obs.observe(aReveler[j]);
  }

  /* ── Le fil du temps ───────────────────────────────────────────────────── */
  /* Chaque étape franchie encre le segment jusqu'à elle. Pas de scrub lié au
     défilement : une position discrète par étape, donc rien à recalculer à
     chaque image, et rien qui saccade sur mobile. */
  var fil = document.querySelector('.fil');
  var filDossier = document.getElementById('fil-dossier');

  // Chaque étape livre ses champs au dossier d'en face. Une étape franchie
  // dépose ce qu'elle produit, et rien de plus : le dossier ne peut pas
  // montrer une information avant l'heure où elle a été recueillie.
  function livrer(etape) {
    if (!filDossier) return;
    var liste = (etape.getAttribute('data-champ') || '').split(',');
    filDossier.classList.add('demarre');
    liste.forEach(function (nom) {
      if (!nom) return;
      var cible = filDossier.querySelector('[data-c="' + nom + '"]');
      if (!cible) return;
      cible.classList.add('arrive');
      var pied = cible.closest('.dossier-foot');
      if (pied) pied.classList.add('actif');
    });
  }

  if (fil) {
    var etapes = fil.querySelectorAll('.etape');
    if (reduit.matches || !('IntersectionObserver' in window)) {
      fil.style.setProperty('--fil', '1');
      for (var k = 0; k < etapes.length; k++) { etapes[k].classList.add('on'); livrer(etapes[k]); }
    } else {
      var atteinte = 0;
      var obsFil = new IntersectionObserver(function (entrees) {
        entrees.forEach(function (e) {
          if (!e.isIntersecting) return;
          var idx = Array.prototype.indexOf.call(etapes, e.target);
          e.target.classList.add('on');
          livrer(e.target);
          if (idx + 1 > atteinte) {
            atteinte = idx + 1;
            fil.style.setProperty('--fil', String(atteinte / etapes.length));
          }
        });
      }, { rootMargin: '0px 0px -42% 0px', threshold: 0.15 });
      for (var l = 0; l < etapes.length; l++) obsFil.observe(etapes[l]);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     DICTÉE — le moteur de l'application, repris tel quel.
     Reconstruction depuis la liste complète des résultats, redémarrage après
     les coupures silencieuses du navigateur, priorité absolue à la saisie
     manuelle, message explicite à la moindre panne. Rien n'est envoyé : cette
     démonstration ne parle à aucun serveur et ne génère aucun document.
     ══════════════════════════════════════════════════════════════════════════ */
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var actif = null;

  var champNotes = document.getElementById('notes-demo');
  var compteur = document.getElementById('notes-count');
  if (champNotes && compteur) {
    var majCompteur = function () {
      var n = champNotes.value.length;
      compteur.textContent = n + ' caractère' + (n > 1 ? 's' : '');
    };
    champNotes.addEventListener('input', majCompteur);
    majCompteur();
  }

  function zoneStatut(btn) {
    var enveloppe = btn.closest('.with-mic');
    if (!enveloppe) return null;
    var carte = enveloppe.closest('.notes') || enveloppe.parentElement;
    var el = carte.querySelector('.mic-status');
    if (!el) {
      el = document.createElement('div');
      el.className = 'mic-status';
      carte.appendChild(el);
    }
    return el;
  }

  function statutEcoute(btn) {
    var el = zoneStatut(btn);
    if (!el) return;
    el.className = 'mic-status listening show';
    el.innerHTML = '<span class="mic-dot"></span><span>Arkiba vous écoute — parlez naturellement.' +
      '<span class="hint">Le texte s\'ajoute au fur et à mesure. Vous pouvez taper à tout moment. ' +
      'Cliquez à nouveau sur le micro pour arrêter.</span></span>';
  }

  function statutErreur(btn, message, conseil) {
    var el = zoneStatut(btn);
    if (!el) return;
    el.className = 'mic-status error show';
    el.innerHTML = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>' +
      '<span>' + esc(message) + '<span class="hint">' +
      esc(conseil || 'Votre texte est conservé — continuez simplement à taper dans le champ ci-dessus.') +
      '</span></span>';
    setTimeout(function () { if (el.classList.contains('error')) el.classList.remove('show'); }, 9000);
  }

  function cacherStatut(btn) {
    var el = zoneStatut(btn);
    if (el && !el.classList.contains('error')) el.classList.remove('show');
  }

  function arreterMicro() {
    if (!actif) return;
    actif.arretManuel = true;
    try { actif.rec.stop(); } catch (_) {}
  }

  function basculerMicro(btn) {
    if (!SpeechRec) {
      statutErreur(btn,
        'La dictée vocale n\'est pas disponible sur ce navigateur.',
        'Utilisez Chrome, Edge ou Safari — ou tapez votre texte : tout fonctionne sans le micro.');
      return;
    }
    if (actif && actif.btn === btn) { arreterMicro(); return; }
    if (actif) arreterMicro();

    var cible = document.getElementById(btn.dataset.mic);
    var etat = {
      btn: btn,
      cible: cible,
      rec: new SpeechRec(),
      base: cible.value && !/\s$/.test(cible.value) ? cible.value + ' ' : cible.value,
      finalSession: '',
      ignorerJusqua: 0,
      nbResultats: 0,
      arretManuel: false,
      programmatique: false,
      redemarrages: 0
    };
    var rec = etat.rec;
    rec.lang = 'fr-FR';
    rec.continuous = true;
    rec.interimResults = true;

    var poser = function (v) {
      etat.programmatique = true;
      cible.value = v;
      cible.dispatchEvent(new Event('input', { bubbles: true }));
      etat.programmatique = false;
    };

    // La frappe du médecin gagne toujours : ce qu'il vient d'écrire devient la
    // nouvelle base, et la dictée reprend après, sans rien écraser.
    var quandIlTape = function () {
      if (etat.programmatique) return;
      etat.base = cible.value && !/\s$/.test(cible.value) ? cible.value + ' ' : cible.value;
      etat.finalSession = '';
      etat.ignorerJusqua = etat.nbResultats;
    };
    cible.addEventListener('input', quandIlTape);

    rec.onresult = function (e) {
      var def = '', encours = '';
      for (var i = etat.ignorerJusqua; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) def += r[0].transcript;
        else encours += r[0].transcript;
      }
      etat.nbResultats = e.results.length;
      etat.finalSession = def;
      poser(etat.base + def + encours);
    };

    rec.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        etat.arretManuel = true;
        statutErreur(btn, 'Arkiba n\'a pas l\'autorisation d\'utiliser le micro.',
          'Autorisez le micro dans les réglages du navigateur (cadenas dans la barre d\'adresse), ou tapez votre texte : rien n\'est perdu.');
      } else if (e.error === 'audio-capture') {
        etat.arretManuel = true;
        statutErreur(btn, 'Aucun micro n\'a été détecté sur cet appareil.',
          'Vérifiez le branchement du micro, ou tapez votre texte dans le champ ci-dessus.');
      } else if (e.error === 'network') {
        etat.arretManuel = true;
        statutErreur(btn, 'Le service de reconnaissance vocale est momentanément injoignable.',
          'Vérifiez la connexion internet et réessayez, ou tapez votre texte : le champ reste actif.');
      }
    };

    rec.onend = function () {
      if (etat.finalSession) {
        etat.base = etat.base + etat.finalSession;
        if (!/\s$/.test(etat.base)) etat.base += ' ';
        etat.finalSession = '';
      }
      // Le navigateur coupe la reconnaissance après quelques secondes de
      // silence. Sans relance, la dictée s'arrête sans que personne ne
      // l'ait demandé.
      if (!etat.arretManuel && etat.redemarrages < 60) {
        etat.redemarrages++;
        etat.ignorerJusqua = 0;
        etat.nbResultats = 0;
        try { rec.start(); return; } catch (_) {}
      }
      nettoyer(etat);
    };

    function nettoyer(s) {
      s.btn.classList.remove('listening');
      s.btn.setAttribute('aria-label', 'Démarrer la dictée');
      s.cible.removeEventListener('input', quandIlTape);
      cacherStatut(s.btn);
      if (actif === s) actif = null;
    }

    try {
      rec.start();
    } catch (_) {
      statutErreur(btn, 'Impossible de démarrer la dictée.',
        'Réessayez dans un instant, ou tapez votre texte dans le champ ci-dessus.');
      return;
    }
    btn.classList.add('listening');
    btn.setAttribute('aria-label', 'Arrêter la dictée');
    statutEcoute(btn);
    actif = etat;
  }

  var boutonsMicro = document.querySelectorAll('button[data-mic]');
  for (var m = 0; m < boutonsMicro.length; m++) {
    (function (b) { b.addEventListener('click', function () { basculerMicro(b); }); })(boutonsMicro[m]);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CRÉATION DE COMPTE — POST /api/auth/register
     La liste des spécialités vient du serveur, jamais du balisage : une copie
     figée avait divergé et faisait échouer toutes les inscriptions.
     ══════════════════════════════════════════════════════════════════════════ */
  var form = document.getElementById('register-form');
  if (!form) return;

  var bouton = document.getElementById('submit-btn');
  var erreur = document.getElementById('form-error');
  var erreurTexte = document.getElementById('form-error-text');
  var selectSpec = form.querySelector('select[name="specialite"]');

  (function () {
    // L'URL vient du balisage (data-source) : la page déclare d'où sort sa
    // liste, et personne ne peut la remplacer par des valeurs en dur sans que
    // ça se voie à l'endroit même du champ.
    fetch(selectSpec.getAttribute('data-source') || '/api/specialites')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('indisponible')); })
      .then(function (data) {
        if (!Array.isArray(data.specialites)) throw new Error('indisponible');
        selectSpec.querySelector('option').textContent = 'Choisir…';
        data.specialites.forEach(function (nom) {
          var opt = document.createElement('option');
          opt.value = nom;
          opt.textContent = nom;
          selectSpec.appendChild(opt);
        });
      })
      .catch(function () {
        selectSpec.querySelector('option').textContent = 'Spécialités indisponibles — rechargez la page';
      });
  })();

  function montrerErreur(message) {
    erreurTexte.textContent = message;
    erreur.classList.add('show');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    erreur.classList.remove('show');
    if (!form.checkValidity()) { form.reportValidity(); return; }

    bouton.disabled = true;
    var libelle = bouton.innerHTML;
    bouton.textContent = 'Création du compte…';

    var data = Object.fromEntries(new FormData(form));
    var charge = {};
    for (var c in data) charge[c] = data[c];
    charge.specialites = data.specialite ? [data.specialite] : [];

    fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(charge)
    })
      .then(function (res) {
        return res.json().then(function (json) {
          if (!res.ok) throw new Error(json.error || 'Erreur serveur');
          return json;
        });
      })
      .then(function (json) {
        localStorage.setItem('praxi_token', json.token);
        location.href = '/app.html';
      })
      .catch(function (err) {
        // Après un refus, le bouton doit redevenir actif : sinon l'inscrit est
        // coincé devant un formulaire mort.
        bouton.disabled = false;
        bouton.innerHTML = libelle;
        montrerErreur(err.message || 'Une erreur est survenue. Réessayez dans quelques instants.');
      });
  });
})();
