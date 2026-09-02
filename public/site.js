/* ============================================================================
   ARKIBA — VITRINE

   Trois niveaux de mouvement, et un seul outil par niveau :

     MICRO    survols, focus, changements d'état      → CSS
     PRODUIT  entrée du héros, apparition des blocs   → GSAP, ou CSS en repli
     RÉCIT    la séquence épinglée du système         → GSAP + ScrollTrigger

   GSAP vient de cdnjs, déjà autorisé par la CSP du serveur. S'il ne charge
   pas, `demarrerRepli()` prend la main et la page s'anime en CSS. Sans
   JavaScript du tout, rien n'est masqué : aucun contenu ne dépend d'une
   animation pour exister.
   ============================================================================ */
(function () {
  'use strict';

  var reduit = window.matchMedia('(prefers-reduced-motion: reduce)');
  var GRAND = window.matchMedia('(min-width: 940px)');

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
    var o = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', String(o));
    burger.setAttribute('aria-label', o ? 'Fermer le menu' : 'Ouvrir le menu');
  });
  document.getElementById('nav-mob').addEventListener('click', function (e) {
    if (e.target.closest('a')) fermerMenu();
  });
  document.addEventListener('click', function (e) { if (!nav.contains(e.target)) fermerMenu(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fermerMenu(); });

  /* ── Onde de l'appel ───────────────────────────────────────────────────── */
  /* Une vraie voix n'est pas une sinusoïde régulière. Les hauteurs sont
     tirées une fois, pas animées en boucle : c'est le passage du récit qui
     les fait monter, pas un battement permanent. */
  var onde = document.getElementById('onde');
  if (onde) {
    var html = '';
    for (var i = 0; i < 54; i++) {
      var h = 12 + Math.round(Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.31)) * 78);
      html += '<i style="height:' + h + '%"></i>';
    }
    onde.innerHTML = html;
  }

  /* ══ REPLI CSS ═════════════════════════════════════════════════════════════
     Utilisé quand GSAP est absent, en mouvement réduit, ou sous 940 px.
     ═════════════════════════════════════════════════════════════════════════ */
  function demarrerRepli() {
    var cibles = document.querySelectorAll('[data-rev], [data-h]');
    if (reduit.matches || !('IntersectionObserver' in window)) {
      for (var i = 0; i < cibles.length; i++) cibles[i].classList.add('vu');
      return;
    }
    var obs = new IntersectionObserver(function (entrees) {
      entrees.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('vu');
        obs.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
    for (var j = 0; j < cibles.length; j++) {
      cibles[j].setAttribute('data-rev', '');
      obs.observe(cibles[j]);
    }
  }

  /* ══ SÉQUENCE DU SYSTÈME ═══════════════════════════════════════════════════
     La scène est épinglée, le défilement fait avancer le récit. Les couches
     sont toutes empilées au même endroit : le rendez-vous devient l'appel,
     les fragments de l'appel deviennent les champs du dossier, le dossier
     rejoint l'espace du médecin, puis se recompose en documents.
     ═════════════════════════════════════════════════════════════════════════ */
  function couche(nom) { return document.querySelector('.couche[data-c="' + nom + '"]'); }

  function construireSequence(gsap) {
    var section = document.getElementById('systeme');
    var scene = document.getElementById('scene');
    if (!section || !scene) return;

    var legendes = document.querySelectorAll('.legende');
    var jauge = document.querySelectorAll('#jauge i');
    var rdv = couche('rdv'), appel = couche('appel'), dossier = couche('dossier'),
        espace = couche('espace'), docs = couche('docs');
    var frags = document.querySelectorAll('.frag');
    var champsD = dossier.querySelectorAll('.champ');
    var barres = onde ? onde.querySelectorAll('i') : [];
    var rangs = espace.querySelectorAll('.rang');
    var cartesDoc = docs.querySelectorAll('.doc');
    var skel = dossier.querySelector('.skel');
    var contenuFlag = dossier.querySelectorAll('.champ.flag .k, .champ.flag .v');

    // Position de départ de chaque élément.
    gsap.set([appel, dossier, espace, docs], { autoAlpha: 0 });
    gsap.set(rdv, { autoAlpha: 1, y: 0, scale: 1 });
    gsap.set(legendes, { autoAlpha: 0, y: 14 });
    gsap.set(legendes[0], { autoAlpha: 1, y: 0 });
    gsap.set(frags, { autoAlpha: 0, y: 12 });
    gsap.set(champsD, { autoAlpha: 0 });
    gsap.set(contenuFlag, { autoAlpha: 0 });
    gsap.set(skel, { autoAlpha: 1 });
    gsap.set(barres, { scaleY: 0.06, transformOrigin: 'center' });
    gsap.set(rangs, { autoAlpha: 0, x: 12 });
    gsap.set(cartesDoc, { autoAlpha: 0, y: 16 });

    // Le déplacement d'un fragment vers son champ est mesuré à l'exécution :
    // recalculé à chaque refresh, il survit au redimensionnement.
    function delta(idx, axe) {
      var f = document.querySelector('.frag[data-f="' + idx + '"]');
      var c = dossier.querySelector('.champ[data-df="' + idx + '"]');
      if (!f || !c) return 0;
      var a = f.getBoundingClientRect(), b = c.getBoundingClientRect();
      return axe === 'x' ? (b.left - a.left) : (b.top - a.top + 6);
    }

    function versLegende(n) {
      var t = {};
      return function () {
        gsap.to(legendes, { autoAlpha: 0, y: -10, duration: .3, overwrite: true });
        gsap.to(legendes[n], { autoAlpha: 1, y: 0, duration: .45, overwrite: true });
        return t;
      };
    }

    var tl = gsap.timeline({
      scrollTrigger: {
        trigger: section,
        start: 'top top',
        end: '+=560%',
        scrub: 0.85,
        pin: '#scene-wrap',
        pinSpacing: true,
        invalidateOnRefresh: true,
        anticipatePin: 1,
        onUpdate: function (self) {
          // La jauge : six segments, un par étape. Les barres sont créées une
          // fois pour toutes ; à chaque image on ne touche qu'une variable CSS,
          // jamais le DOM.
          var p = self.progress * 6;
          for (var k = 0; k < jauge.length; k++) {
            jauge[k].style.setProperty('--v', Math.max(0, Math.min(1, p - k)));
          }
        }
      }
    });

    // ── 1 → 2 : le rendez-vous devient l'appel ───────────────────────────
    tl.to({}, { duration: .6 })
      .add(versLegende(1), '>-.1')
      .to(rdv, { y: -46, scale: .94, autoAlpha: 0, duration: .5, ease: 'power2.in' }, '<')
      .to(appel, { autoAlpha: 1, duration: .45, ease: 'power2.out' }, '<.15')
      .to(barres, { scaleY: 1, duration: .5, stagger: { each: .006, from: 'start' }, ease: 'power2.out' }, '<.05')
      .to(frags, { autoAlpha: 1, y: 0, duration: .38, stagger: .16, ease: 'power2.out' }, '<.1')
      .to({}, { duration: .5 })

    // ── 2 → 3 : les fragments deviennent les champs ──────────────────────
      .add(versLegende(2))
      .to(dossier, { autoAlpha: 1, duration: .4 }, '<')
      .to(appel, { autoAlpha: 0, duration: .45 }, '<.1')
      .to(frags, {
        x: function (i, t) { return delta(t.dataset.f, 'x'); },
        y: function (i, t) { return delta(t.dataset.f, 'y'); },
        scale: .92, autoAlpha: 0,
        duration: .62, stagger: .07, ease: 'power2.inOut'
      }, '<')
      .to(champsD[0], { autoAlpha: 1, duration: .3 }, '<.34')
      .to(champsD[1], { autoAlpha: 1, duration: .3 }, '<.07')
      .to(champsD[2], { autoAlpha: 1, duration: .3 }, '<.07')
      // Le quatrième emplacement apparaît dès maintenant, mais vide : il porte
      // « Relecture en cours » tant qu'Arkiba n'a pas fini de relire.
      .to(champsD[3], { autoAlpha: 1, duration: .3 }, '<.07')
      .to({}, { duration: .45 })

    // ── 4 : ce qui reste à vérifier ──────────────────────────────────────
    // L'ambre s'allume ici, et seulement ici. C'est la seule couleur de la
    // page en dehors du vert « prêt », et elle veut dire quelque chose.
      .add(versLegende(3))
      .to(skel, { autoAlpha: 0, duration: .3 }, '<')
      .to(contenuFlag, { autoAlpha: 1, duration: .42, stagger: .06, ease: 'power2.out' }, '<.1')
      .to(champsD[3], {
        backgroundColor: 'rgba(245,185,99,.11)',
        boxShadow: 'inset 2px 0 0 rgba(245,185,99,1)',
        duration: .5, ease: 'power2.out'
      }, '<')
      .to({}, { duration: .6 })

    // ── 5 : le dossier rejoint l'espace du médecin ───────────────────────
      .add(versLegende(4))
      .to(dossier, { y: -34, scale: .93, autoAlpha: 0, duration: .5, ease: 'power2.in' }, '<')
      .to(frags, { autoAlpha: 0, duration: .1 }, '<')
      .to(espace, { autoAlpha: 1, duration: .45, ease: 'power2.out' }, '<.2')
      .to(rangs, { autoAlpha: 1, x: 0, duration: .4, stagger: .1, ease: 'power2.out' }, '<.1')
      .to({}, { duration: .6 })

    // ── 6 : les documents ────────────────────────────────────────────────
      .add(versLegende(5))
      .to(espace, { y: -30, autoAlpha: 0, duration: .45, ease: 'power2.in' }, '<')
      .to(docs, { autoAlpha: 1, duration: .4 }, '<.18')
      .to(cartesDoc, { autoAlpha: 1, y: 0, duration: .42, stagger: .12, ease: 'power2.out' }, '<')
      .to({}, { duration: .8 });
  }

  /* ── Entrée du héros ───────────────────────────────────────────────────── */
  /* `opacity` et non `autoAlpha` : autoAlpha pose visibility:hidden, ce qui
     retire le contenu de l'arbre d'accessibilité et le rend inatteignable tant
     qu'il n'a pas été révélé. Un lecteur d'écran ne doit pas dépendre d'une
     animation pour entendre un paragraphe. */
  function entreeHeros(gsap) {
    var els = document.querySelectorAll('[data-h]');
    var champs = document.querySelectorAll('#dossier-hero .champ');
    gsap.set(els, { opacity: 0, y: 20 });
    gsap.set(champs, { opacity: 0, y: 10 });

    var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.to(els, { opacity: 1, y: 0, duration: .78, stagger: .075 }, .12)
      .to(champs, { opacity: 1, y: 0, duration: .5, stagger: .09 }, '-=.42');
  }

  /* ── Apparition des blocs ──────────────────────────────────────────────── */
  function blocs(gsap, ST) {
    document.querySelectorAll('[data-rev]').forEach(function (el) {
      gsap.fromTo(el,
        { opacity: 0, y: 22 },
        {
          opacity: 1, y: 0, duration: .8, ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true }
        });
    });
  }

  /* ── Démarrage ─────────────────────────────────────────────────────────── */
  function demarrer() {
    var gsap = window.gsap;
    var ST = window.ScrollTrigger;

    // Mouvement réduit, écran étroit, ou GSAP absent : la page se lit à plat.
    if (!gsap || !ST || reduit.matches || !GRAND.matches) {
      document.getElementById('systeme').classList.add('plat');
      demarrerRepli();
      return;
    }
    gsap.registerPlugin(ST);
    entreeHeros(gsap);
    blocs(gsap, ST);
    construireSequence(gsap);
    // Les polices changent les hauteurs : sans ce recalcul, les positions
    // mesurées pour les fragments seraient celles d'avant leur chargement.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { ST.refresh(); });
    }
    window.addEventListener('load', function () { ST.refresh(); });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') demarrer();
  else document.addEventListener('DOMContentLoaded', demarrer);

  /* ══════════════════════════════════════════════════════════════════════════
     DICTÉE — le moteur de l'application, repris tel quel.
     Reconstruction depuis la liste complète des résultats, redémarrage après
     les coupures silencieuses du navigateur, priorité absolue à la saisie
     manuelle, message explicite à la moindre panne. Rien n'est envoyé.
     ══════════════════════════════════════════════════════════════════════════ */
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var actif = null;

  var champNotes = document.getElementById('notes-demo');
  var compteur = document.getElementById('notes-count');
  if (champNotes && compteur) {
    var maj = function () {
      var n = champNotes.value.length;
      compteur.textContent = n + ' caractère' + (n > 1 ? 's' : '');
    };
    champNotes.addEventListener('input', maj);
    maj();
  }

  function zoneStatut(btn) {
    var carte = btn.closest('.notes');
    if (!carte) return null;
    var el = carte.querySelector('.mic-status');
    if (!el) { el = document.createElement('div'); el.className = 'mic-status'; carte.appendChild(el); }
    return el;
  }
  function statutEcoute(btn) {
    var el = zoneStatut(btn); if (!el) return;
    el.className = 'mic-status listening show';
    el.innerHTML = '<span class="mic-dot"></span><span>Arkiba vous écoute.' +
      '<span class="hint">Le texte s\'ajoute au fur et à mesure. Vous pouvez taper à tout moment. ' +
      'Cliquez à nouveau sur le micro pour arrêter.</span></span>';
  }
  function statutErreur(btn, message, conseil) {
    var el = zoneStatut(btn); if (!el) return;
    el.className = 'mic-status error show';
    el.innerHTML = '<svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>' +
      '<span>' + esc(message) + '<span class="hint">' +
      esc(conseil || 'Votre texte est conservé. Continuez simplement à taper dans le champ.') + '</span></span>';
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
      statutErreur(btn, 'La dictée vocale n\'est pas disponible sur ce navigateur.',
        'Utilisez Chrome, Edge ou Safari, ou tapez votre texte : tout fonctionne sans le micro.');
      return;
    }
    if (actif && actif.btn === btn) { arreterMicro(); return; }
    if (actif) arreterMicro();

    var cible = document.getElementById(btn.dataset.mic);
    var etat = {
      btn: btn, cible: cible, rec: new SpeechRec(),
      base: cible.value && !/\s$/.test(cible.value) ? cible.value + ' ' : cible.value,
      finalSession: '', ignorerJusqua: 0, nbResultats: 0,
      arretManuel: false, programmatique: false, redemarrages: 0
    };
    var rec = etat.rec;
    rec.lang = 'fr-FR'; rec.continuous = true; rec.interimResults = true;

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
        if (r.isFinal) def += r[0].transcript; else encours += r[0].transcript;
      }
      etat.nbResultats = e.results.length;
      etat.finalSession = def;
      poser(etat.base + def + encours);
    };
    rec.onerror = function (e) {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        etat.arretManuel = true;
        statutErreur(btn, 'Arkiba n\'a pas l\'autorisation d\'utiliser le micro.',
          'Autorisez le micro dans les réglages du navigateur, ou tapez votre texte : rien n\'est perdu.');
      } else if (e.error === 'audio-capture') {
        etat.arretManuel = true;
        statutErreur(btn, 'Aucun micro détecté sur cet appareil.',
          'Vérifiez le branchement, ou tapez votre texte dans le champ.');
      } else if (e.error === 'network') {
        etat.arretManuel = true;
        statutErreur(btn, 'Le service de reconnaissance vocale est injoignable.',
          'Vérifiez la connexion et réessayez, ou tapez votre texte : le champ reste actif.');
      }
    };
    rec.onend = function () {
      if (etat.finalSession) {
        etat.base = etat.base + etat.finalSession;
        if (!/\s$/.test(etat.base)) etat.base += ' ';
        etat.finalSession = '';
      }
      // Le navigateur coupe la reconnaissance après quelques secondes de
      // silence. Sans relance, la dictée s'arrête sans qu'on l'ait demandé.
      if (!etat.arretManuel && etat.redemarrages < 60) {
        etat.redemarrages++;
        etat.ignorerJusqua = 0; etat.nbResultats = 0;
        try { rec.start(); return; } catch (_) {}
      }
      nettoyer(etat);
    };
    function nettoyer(s) {
      s.btn.classList.remove('on');
      s.btn.setAttribute('aria-label', 'Démarrer la dictée');
      s.cible.removeEventListener('input', quandIlTape);
      cacherStatut(s.btn);
      if (actif === s) actif = null;
    }
    try { rec.start(); }
    catch (_) {
      statutErreur(btn, 'Impossible de démarrer la dictée.', 'Réessayez dans un instant, ou tapez votre texte.');
      return;
    }
    btn.classList.add('on');
    btn.setAttribute('aria-label', 'Arrêter la dictée');
    statutEcoute(btn);
    actif = etat;
  }

  var boutons = document.querySelectorAll('button[data-mic]');
  for (var m = 0; m < boutons.length; m++) {
    (function (b) { b.addEventListener('click', function () { basculerMicro(b); }); })(boutons[m]);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CRÉATION DE COMPTE — POST /api/auth/register
     ══════════════════════════════════════════════════════════════════════════ */
  var form = document.getElementById('register-form');
  if (!form) return;

  var bouton = document.getElementById('submit-btn');
  var erreur = document.getElementById('form-error');
  var erreurTexte = document.getElementById('form-error-text');
  var selectSpec = form.querySelector('select[name="specialite"]');

  // L'URL vient du balisage : la page déclare d'où sort sa liste, et personne
  // ne peut la remplacer par des valeurs en dur sans que ça se voie.
  fetch(selectSpec.getAttribute('data-source') || '/api/specialites')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('indisponible')); })
    .then(function (data) {
      if (!Array.isArray(data.specialites)) throw new Error('indisponible');
      selectSpec.querySelector('option').textContent = 'Choisir…';
      data.specialites.forEach(function (nom) {
        var o = document.createElement('option');
        o.value = nom; o.textContent = nom;
        selectSpec.appendChild(o);
      });
    })
    .catch(function () {
      selectSpec.querySelector('option').textContent = 'Spécialités indisponibles, rechargez la page';
    });

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
        // Après un refus, le bouton redevient actif : sinon l'inscrit est
        // coincé devant un formulaire mort.
        bouton.disabled = false;
        bouton.innerHTML = libelle;
        erreurTexte.textContent = err.message || 'Une erreur est survenue. Réessayez dans quelques instants.';
        erreur.classList.add('show');
      });
  });
})();
