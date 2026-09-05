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
  // La largeur ne décide plus SI la page s'anime, seulement COMMENT. Un
  // portable n'a aucune raison de recevoir une page statique. Seul
  // `prefers-reduced-motion` coupe réellement le mouvement.
  var PETIT = window.matchMedia('(max-width: 639px)');

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
    var jaugeBtns = document.querySelectorAll('#jauge button');
    var rdv = couche('rdv'), appel = couche('appel'), dossier = couche('dossier'),
        espace = couche('espace'), docs = couche('docs');
    var frags = document.querySelectorAll('.frag');
    var champsD = dossier.querySelectorAll('.champ');
    var barres = onde ? onde.querySelectorAll('i') : [];
    var rangs = espace.querySelectorAll('.rang');
    var cartesDoc = docs.querySelectorAll('.doc');
    var skel = dossier.querySelector('.skel');
    var contenuFlag = dossier.querySelectorAll('.champ.flag .k, .champ.flag .v');
    var jeton = document.getElementById('jeton');

    // Position d un emplacement, relative a la scene. Mesuree a l execution et
    // recalculee a chaque refresh : elle survit au redimensionnement et au
    // chargement des polices.
    function place(nom, axe) {
      var e = scene.querySelector('[data-emp="' + nom + '"]');
      if (!e || !jeton) return 0;
      var a = scene.getBoundingClientRect(), b = e.getBoundingClientRect();
      return axe === 'x' ? (b.left - a.left) : (b.top - a.top);
    }
    function versEmp(nom, duree) {
      return {
        x: function () { return place(nom, 'x'); },
        y: function () { return place(nom, 'y'); },
        duration: duree, ease: 'power2.inOut'
      };
    }

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
    if (jeton) gsap.set(jeton, { x: function () { return place('rdv', 'x'); }, y: function () { return place('rdv', 'y'); }, autoAlpha: 1 });

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
        // La course d epinglage suit la place disponible : sur un ecran court
        // ou etroit, 560 % de hauteur de fenetre demanderait un defilement
        // interminable pour six etapes.
        end: function () { return '+=' + (PETIT.matches ? 420 : 560) + '%'; },
        scrub: 0.85,
        pin: '#scene-wrap',
        pinSpacing: true,
        invalidateOnRefresh: true,
        anticipatePin: 1,
        onUpdate: function (self) {
          // La jauge : six segments, un par étape. Les barres sont créées une
          // fois pour toutes ; à chaque image on ne touche qu'une variable CSS,
          // jamais le DOM.
          var b = bornes(), p = self.progress;
          for (var k = 0; k < jauge.length; k++) {
            var largeur = b[k + 1] - b[k];
            var v = largeur > 0 ? (p - b[k]) / largeur : 0;
            jauge[k].style.setProperty('--v', Math.max(0, Math.min(1, v)));
          }
        }
      }
    });

    // Les six etapes n ont pas la meme duree : la jauge doit suivre les bornes
    // reelles de la frise, pas un sixieme chacune. Sinon un segment se remplit
    // pendant qu une autre etape est a l ecran.
    function bornes() {
      var d = tl.duration() || 1;
      var b = [];
      for (var i = 0; i < 6; i++) b.push((tl.labels['s' + i] || 0) / d);
      b.push(1);
      return b;
    }

    for (var jb = 0; jb < jaugeBtns.length; jb++) {
      (function (b, n) {
        b.addEventListener("click", function () {
          var st = tl.scrollTrigger;
          if (!st) return;
          // Milieu de l etape : on arrive sur un etat stable, jamais sur une
          // image de transition.
          var b = bornes();
          var p = b[n] + (b[n + 1] - b[n]) * 0.72;
          window.scrollTo({ top: st.start + (st.end - st.start) * p, behavior: reduit.matches ? "auto" : "smooth" });
        });
      })(jaugeBtns[jb], jb);
    }

    // ── 1 → 2 : le rendez-vous devient l'appel ───────────────────────────
    tl.addLabel('s0')
      .to({}, { duration: .6 })
      .addLabel('s1')
      .add(versLegende(1), '>-.1')
      .to(rdv, { y: -46, scale: .94, autoAlpha: 0, duration: .5, ease: 'power2.in' }, '<')
      .to(appel, { autoAlpha: 1, duration: .45, ease: 'power2.out' }, '<.15')
      .to(jeton, versEmp('appel', .62), '<')
      .to(barres, { scaleY: 1, duration: .5, stagger: { each: .006, from: 'start' }, ease: 'power2.out' }, '<.05')
      .to(frags, { autoAlpha: 1, y: 0, duration: .38, stagger: .16, ease: 'power2.out' }, '<.1')
      .to({}, { duration: .5 })

    // ── 2 → 3 : les fragments deviennent les champs ──────────────────────
      .addLabel('s2')
      .to(dossier, { autoAlpha: 1, duration: .4 })
      .add(versLegende(2), '<.3')
      .to(appel, { autoAlpha: 0, duration: .45 }, '<-.2')
      .to(jeton, versEmp('dossier', .62), '<-.15')
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
    // Le squelette s'efface AVANT que le contenu arrive : superposés, les deux
    // textes occupent la même ligne et s'écrasent sur les images de transition.
      .addLabel('s3')
      .to(skel, { autoAlpha: 0, duration: .28 })
      .add(versLegende(3), '<')
      .to(contenuFlag, { autoAlpha: 1, duration: .42, stagger: .06, ease: 'power2.out' }, '>-.04')
      .to(champsD[3], {
        backgroundColor: 'rgba(245,185,99,.11)',
        boxShadow: 'inset 2px 0 0 rgba(245,185,99,1)',
        duration: .5, ease: 'power2.out'
      }, '<.05')
      .to({}, { duration: .6 })

    // ── 5 : le dossier rejoint l'espace du médecin ───────────────────────
      .addLabel('s4')
      .to(dossier, { y: -34, scale: .93, autoAlpha: 0, duration: .5, ease: 'power2.in' })
      .add(versLegende(4), '<.3')
      .to(frags, { autoAlpha: 0, duration: .1 }, '<')
    // Les lignes arrivent AVEC la carte, pas après : sinon le panneau reste
    // visible et vide pendant un instant, et ça se lit comme un bug.
      .to(espace, { autoAlpha: 1, duration: .45, ease: 'power2.out' }, '<.2')
      .to(jeton, versEmp('espace', .6), '<-.1')
      .to(rangs, { autoAlpha: 1, x: 0, duration: .38, stagger: .07, ease: 'power2.out' }, '<.04')
      .to({}, { duration: .6 })

    // ── 6 : les documents ────────────────────────────────────────────────
      .addLabel('s5')
      .to(espace, { y: -30, autoAlpha: 0, duration: .45, ease: 'power2.in' })
      .add(versLegende(5), '<.3')
      .to(jeton, { autoAlpha: 0, duration: .3 }, '<')
      .to(docs, { autoAlpha: 1, duration: .4 }, '<.18')
      .to(cartesDoc, { autoAlpha: 1, y: 0, duration: .42, stagger: .12, ease: 'power2.out' }, '<')
      .to({}, { duration: .8 });
  }

  /* ══ SCÈNE DU HÉROS ════════════════════════════════════════════════════════
     Elle joue seule au chargement et raconte le produit avant tout défilement :
     le rendez-vous est lu, l'appel a lieu, chaque réponse arrive avec sa
     provenance, ce qui reste flou s'allume en ambre, le dossier passe à
     « prêt » et attend. Les trois jalons du rail y donnent accès directement.
     ═════════════════════════════════════════════════════════════════════════ */
  var scH = null;

  function sceneHeros(gsap) {
    var scene = document.getElementById('scene-h');
    if (!scene) return;

    var noeuds = scene.querySelectorAll('.rail-n');
    var segs = scene.querySelectorAll('.rail-s i');
    var etat = document.getElementById('rail-etat');
    var champs = scene.querySelectorAll('#h-champs .champ');
    var flag = scene.querySelector('#h-champs .champ.flag');
    var contFlag = scene.querySelectorAll('#h-champs .champ.flag .k, #h-champs .champ.flag .v');
    var pret = document.getElementById('h-pret');
    var attente = document.getElementById('h-attente');

    function jalon(n) {
      for (var i = 0; i < noeuds.length; i++) noeuds[i].classList.toggle('on', i <= n);
    }
    function dire(t) { if (etat) etat.textContent = t; }

    // État de départ : le rendez-vous existe, rien d'autre.
    function zero() {
      gsap.set(champs, { opacity: 0, y: 10 });
      gsap.set(contFlag, { opacity: 0 });
      gsap.set(flag, { backgroundColor: 'rgba(0,0,0,0)', boxShadow: 'inset 2px 0 0 rgba(245,185,99,0)' });
      gsap.set([pret, attente], { opacity: 0 });
      gsap.set(segs, { '--f': 0 });
      jalon(0); dire("Lecture de l'agenda");
    }
    zero();

    // En mouvement réduit, l'état final est posé d'emblée : le contenu ne
    // dépend jamais de l'animation pour exister.
    if (reduit.matches) {
      gsap.set(champs, { opacity: 1, y: 0 });
      gsap.set(contFlag, { opacity: 1 });
      gsap.set(flag, { backgroundColor: 'rgba(245,185,99,.11)', boxShadow: 'inset 2px 0 0 rgba(245,185,99,1)' });
      gsap.set([pret, attente], { opacity: 1 });
      gsap.set(segs, { '--f': 1 });
      jalon(2); dire('Prêt · en attente');
      return;
    }

    var tl = gsap.timeline({ paused: true, defaults: { ease: 'power2.out' } });

    tl.addLabel('e0')
      .call(function () { jalon(0); dire("Lecture de l'agenda"); })
      .to({}, { duration: .5 })

      .addLabel('e1')
      .call(function () { jalon(1); dire('Interrogatoire en cours'); })
      .to(segs[0], { '--f': 1, duration: .7, ease: 'power1.inOut' })
      // Chaque réponse arrive à son tour, jamais en bloc : c'est une
      // conversation qu'on transcrit, pas un formulaire qu'on remplit.
      .to(champs[0], { opacity: 1, y: 0, duration: .5 }, '-=.35')
      .to(champs[1], { opacity: 1, y: 0, duration: .5 }, '+=.5')
      .to(champs[2], { opacity: 1, y: 0, duration: .5 }, '+=.5')
      .to(champs[3], { opacity: 1, y: 0, duration: .45 }, '+=.45')

      .addLabel('e2')
      .call(function () { jalon(2); dire('Relecture'); })
      .to(segs[1], { '--f': 1, duration: .7, ease: 'power1.inOut' })
      .to(contFlag, { opacity: 1, duration: .45, stagger: .07 }, '-=.3')
      .to(flag, {
        backgroundColor: 'rgba(245,185,99,.11)',
        boxShadow: 'inset 2px 0 0 rgba(245,185,99,1)',
        duration: .55
      }, '<')
      .call(function () { dire('Prêt · en attente'); }, null, '+=.35')
      .to(pret, { opacity: 1, duration: .45 }, '-=.15')
      .to(attente, { opacity: 1, duration: .45 }, '-=.25');

    scH = tl;

    // Le cycle : la scène se rejoue au bout d'un moment, une fois, sans
    // s'imposer. Dès que le visiteur clique un jalon, il prend la main et
    // le cycle s'arrête : on ne lui reprend pas ce qu'il vient de choisir.
    var auto = true;
    function relancer() {
      if (!auto) return;
      gsap.delayedCall(13, function () {
        if (!auto || document.hidden) return;
        zero();
        tl.play(0);
      });
    }
    tl.eventCallback('onComplete', relancer);
    tl.play(0);

    // Cible de chaque jalon sur la frise : la fin de son étape.
    var cibles = [0, tl.labels.e2, tl.duration()];

    for (var i = 0; i < noeuds.length; i++) {
      (function (b, n) {
        b.addEventListener('click', function () {
          auto = false;
          gsap.killTweensOf(tl);
          if (n === 0) { tl.pause(0); zero(); return; }
          // On rejoue depuis le début jusqu'au jalon demandé : l'ordre
          // d'apparition des champs reste celui de la conversation, et
          // revenir en arrière ne laisse jamais un état à moitié construit.
          tl.pause(0);
          zero();
          tl.tweenTo(cibles[n], { duration: n === 1 ? 1.5 : 2.4, ease: 'power1.inOut' });
        });
      })(noeuds[i], i);
    }
  }

  /* ── Entrée du héros ───────────────────────────────────────────────────── */
  /* `opacity` et non `autoAlpha` : autoAlpha pose visibility:hidden, ce qui
     retire le contenu de l'arbre d'accessibilité et le rend inatteignable tant
     qu'il n'a pas été révélé. Un lecteur d'écran ne doit pas dépendre d'une
     animation pour entendre un paragraphe. */
  function entreeHeros(gsap) {
    // Les champs du dossier ne sont PAS touches ici : la scene du heros les
    // pilote, et deux timelines sur les memes elements se marchent dessus.
    var els = document.querySelectorAll('[data-h]');
    gsap.set(els, { opacity: 0, y: 20 });
    return gsap.timeline({ defaults: { ease: 'power3.out' } })
      .to(els, { opacity: 1, y: 0, duration: .78, stagger: .075 }, .12);
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


  /* ══ INTERACTION AU POINTEUR ═══════════════════════════════════════════════
     Deux gestes, tous deux au pointeur fin uniquement : la lueur qui suit le
     curseur sur les surfaces produit, et l aimantation legere des boutons.
     Sur un ecran tactile il n y a pas de curseur a suivre : ces couches ne
     sont meme pas branchees.
     ═════════════════════════════════════════════════════════════════════════ */
  function couchePointeur(gsap) {
    if (reduit.matches) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    document.querySelectorAll(".pointeur, .surface").forEach(function (el) {
      el.classList.add("pointeur");
      el.addEventListener("pointermove", function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
        el.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
      });
      el.addEventListener("pointerenter", function () { el.classList.add("actif"); });
      el.addEventListener("pointerleave", function () { el.classList.remove("actif"); });
    });

    // Aimantation : le bouton vient un peu vers le curseur, au sixieme de la
    // distance et plafonne a 6 px. Ce qu on cherche est la sensation que
    // l interface repond, pas un bouton qui se promene.
    document.querySelectorAll(".btn-1, .btn-2, .ong, .rail-n").forEach(function (b) {
      b.classList.add("aimant");
      var actif = null;
      b.addEventListener("pointermove", function (e) {
        var r = b.getBoundingClientRect();
        var dx = (e.clientX - (r.left + r.width / 2)) / 6;
        var dy = (e.clientY - (r.top + r.height / 2)) / 6;
        var m = 6;
        actif = gsap.to(b, {
          x: Math.max(-m, Math.min(m, dx)), y: Math.max(-m, Math.min(m, dy)),
          duration: .4, ease: "power3.out", overwrite: "auto"
        });
      });
      b.addEventListener("pointerleave", function () {
        gsap.to(b, { x: 0, y: 0, duration: .55, ease: "elastic.out(1,.6)", overwrite: "auto" });
      });
    });
  }

  /* ══ ONGLETS ═══════════════════════════════════════════════════════════════
     Le dossier et les documents se choisissent. La bascule est une vraie
     transition, pas un display:none : le panneau sortant s efface pendant que
     l entrant monte.
     ═════════════════════════════════════════════════════════════════════════ */
  function onglets(gsap, conteneurId, attrBouton, selPanneaux, attrPanneau, apres) {
    var barre = document.getElementById(conteneurId);
    if (!barre) return;
    var boutons = barre.querySelectorAll(".ong");
    var panneaux = document.querySelectorAll(selPanneaux);

    function montrer(cle, anime) {
      for (var i = 0; i < boutons.length; i++) {
        var actif = boutons[i].getAttribute(attrBouton) === cle;
        boutons[i].classList.toggle("on", actif);
        boutons[i].setAttribute("aria-selected", String(actif));
      }
      panneaux.forEach(function (p) {
        var cible = p.getAttribute(attrPanneau) === cle;
        if (cible) {
          p.hidden = false;
          if (anime && gsap) gsap.fromTo(p, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: .42, ease: "power2.out" });
        } else if (!p.hidden) {
          if (anime && gsap) {
            gsap.to(p, { opacity: 0, duration: .16, onComplete: function () { p.hidden = true; } });
          } else { p.hidden = true; }
        }
      });
      if (apres) apres(cle);
    }

    for (var j = 0; j < boutons.length; j++) {
      (function (b) {
        b.addEventListener("click", function () { montrer(b.getAttribute(attrBouton), true); });
      })(boutons[j]);
    }
  }

  var TITRES_DOC = {
    cr: "Compte rendu de consultation",
    liaison: "Lettre de liaison",
    certificat: "Certificat"
  };

  function interactions(gsap) {
    modules(gsap);
    bandeauParcours();
    onglets(gsap, "ong-dossier", "data-o", "#explorateur .vol", "data-v");
    onglets(gsap, "ong-doc", "data-d", "#doc-corps .dv", "data-d", function (cle) {
      var t = document.getElementById("doc-titre");
      if (t) t.textContent = TITRES_DOC[cle] || "";
    });
  }


  /* ══ TRANSITIONS DE SECTION ════════════════════════════════════════════════
     Le fond de la page se deplace lentement au fil du parcours au lieu de
     sauter d une bande a l autre. C est une seule variable CSS animee : rien
     n est repeint en plus, et les sections ne sont plus des boites posees
     bout a bout.
     ═════════════════════════════════════════════════════════════════════════ */
  function fondEvolutif(gsap, ST) {
    if (reduit.matches) return;
    var etapes = [
      { sel: "#systeme",  bg: "#0a0c0f" },
      { sel: "#dossier",  bg: "#08090b" },
      { sel: "#consultation", bg: "#0a0c0f" },
      { sel: "#documents", bg: "#0c0e11" },
      { sel: "#transfert", bg: "#0a0c0f" },
      { sel: "#tarifs",   bg: "#08090b" }
    ];
    etapes.forEach(function (e) {
      var el = document.querySelector(e.sel);
      if (!el) return;
      gsap.to(document.body, {
        backgroundColor: e.bg,
        ease: "none",
        scrollTrigger: { trigger: el, start: "top 75%", end: "top 25%", scrub: true }
      });
    });
  }

  /* Le voile de transition : une bande degradee entre deux sections, qui
     evite la couture nette entre deux fonds differents. */
  function coutures() {
    var cibles = document.querySelectorAll(".sect.tinted, .systeme");
    for (var i = 0; i < cibles.length; i++) cibles[i].classList.add("fondu");
  }


  /* ══ LES MODULES DE LA PLATEFORME ══════════════════════════════════════════
     Dix modules, un panneau. La bascule est une vraie transition : le panneau
     sortant s efface pendant que l entrant monte, et la mini-interface arrive
     legerement apres son texte, pour que l oeil suive.
     ═════════════════════════════════════════════════════════════════════════ */
  function modules(gsap) {
    var barre = document.getElementById("mods");
    if (!barre) return;
    var boutons = barre.querySelectorAll(".mod");
    var panneaux = document.querySelectorAll(".banc .pan");
    var courant = null;

    function montrer(cle, anime) {
      if (cle === courant) return;
      courant = cle;
      for (var i = 0; i < boutons.length; i++) {
        var a = boutons[i].getAttribute("data-m") === cle;
        boutons[i].classList.toggle("on", a);
        boutons[i].setAttribute("aria-selected", String(a));
      }
      panneaux.forEach(function (p) {
        var vise = p.getAttribute("data-p") === cle;
        if (vise) {
          p.hidden = false;
          if (anime && gsap) {
            var txt = p.querySelector(".pan-txt"), ui = p.querySelector(".pan-ui");
            gsap.fromTo(txt, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .45, ease: "power2.out" });
            gsap.fromTo(ui, { opacity: 0, y: 20, scale: .985 }, { opacity: 1, y: 0, scale: 1, duration: .55, ease: "power2.out", delay: .07 });
          }
        } else if (!p.hidden) {
          if (anime && gsap) {
            gsap.to(p, { opacity: 0, duration: .16, onComplete: function () { p.hidden = true; gsap.set(p, { opacity: 1 }); } });
          } else { p.hidden = true; }
        }
      });
    }

    for (var j = 0; j < boutons.length; j++) {
      (function (b) {
        b.addEventListener("click", function () { montrer(b.getAttribute("data-m"), true); });
      })(boutons[j]);
    }
    montrer("agenda", false);
  }


  /* Les neuf jalons du parcours s allument l un apres l autre, dans l ordre de
     la chaine : c est ce qui fait lire la rangee comme un flux et non comme
     neuf cases posees cote a cote. */
  function bandeauParcours() {
    // ScrollTrigger est pris sur window : cette fonction est appelee depuis
    // interactions(), qui ne recoit pas ST en parametre.
    var ST = window.ScrollTrigger;
    var n = document.querySelectorAll(".fx-n");
    if (!n.length || !ST) return;
    if (reduit.matches) { for (var i = 0; i < n.length; i++) n[i].classList.add("vu"); return; }
    ST.create({
      trigger: "#fx", start: "top 82%", once: true,
      onEnter: function () {
        for (var k = 0; k < n.length; k++) {
          (function (el, d) { setTimeout(function () { el.classList.add("vu"); }, d); })(n[k], k * 90);
        }
      }
    });
  }

  /* ── Démarrage ─────────────────────────────────────────────────────────── */
  function demarrer() {
    var gsap = window.gsap;
    var ST = window.ScrollTrigger;

    // GSAP absent : repli CSS. Mouvement reduit : lecture a plat, sans
    // epinglage. Dans TOUS les autres cas, quelle que soit la largeur, la page
    // s anime. La largeur ne decide que de la choregraphie.
    if (!gsap || !ST) {
      document.getElementById('systeme').classList.add('plat');
      demarrerRepli();
      return;
    }
    gsap.registerPlugin(ST);
    if (window.Flip) gsap.registerPlugin(window.Flip);

    if (reduit.matches) {
      document.getElementById('systeme').classList.add('plat');
      demarrerRepli();
      sceneHeros(gsap);
      interactions(null);
      return;
    }

    entreeHeros(gsap);
    sceneHeros(gsap);
    blocs(gsap, ST);
    construireSequence(gsap);
    couchePointeur(gsap);
    interactions(gsap);
    fondEvolutif(gsap, ST);
    coutures();
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
