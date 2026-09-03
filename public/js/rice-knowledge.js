/* AgriPricePH — Homepage "Rice Knowledge" sections
 * (Anatomy of Rice Classifications / Commercial Brands vs. Seed Varieties / Philippine Rice
 * Trivia). Self-contained: no dependency on AgriPricePH.* namespaces, just DOM wiring for the
 * markup in landpage.html. Safe to include on pages that don't have these sections — every
 * handler is guarded with a null/empty check.
 */
(function () {
  var parts = {
    hull: {
      kicker: 'Hull · husk',
      title: 'The protective coat',
      copy: 'Palea and lemma wrap the paddy. Millers strip this first. Until then, you are looking at palay — not table rice.',
      img: 'https://images.pexels.com/photos/35245104/pexels-photo-35245104.jpeg?auto=compress&cs=tinysrgb&w=1100',
      alt: 'Close-up of a rice panicle with husks still on the stalk'
    },
    bran: {
      kicker: 'Bran layer',
      title: 'Where the nutrients hide',
      copy: 'A thin brown coat packed with oils and fiber. Regular milled rice keeps more of it — which is why it looks duller and costs less.',
      img: 'https://images.pexels.com/photos/4110253/pexels-photo-4110253.jpeg?auto=compress&cs=tinysrgb&w=1100',
      alt: 'Duller, bran-flecked rice grains on a wooden spoon'
    },
    endosperm: {
      kicker: 'Endosperm',
      title: 'The starchy heart',
      copy: 'This is the white rice you eat. The more thoroughly it is milled, the shinier and more expensive the sack — and the more bran you lose.',
      img: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?auto=format&fit=crop&w=1100&q=80',
      alt: 'Uncooked white rice grains'
    },
    germ: {
      kicker: 'Germ · embryo',
      title: 'The tiny spark of a plant',
      copy: 'The embryo that could become a new stalk. Rich in oils, it is often polished off in white rice and kept in brown rice.',
      img: 'https://images.pexels.com/photos/37012643/pexels-photo-37012643.jpeg?auto=compress&cs=tinysrgb&w=1100',
      alt: 'Lush young rice plants growing in a paddy'
    }
  };

  var millCopy = [
    { kicker: 'Grade · Regular', title: 'Still a little rustic', copy: 'More brokens, less shine. Bran still clings to the kernel — the budget sack most wet markets know well.' },
    { kicker: 'Grade · Well-milled', title: 'The household standard', copy: 'Whiter, smoother, fewer broken grains. This is the everyday kanin for most Filipino tables.' },
    { kicker: 'Grade · Premium', title: 'Whole, long, and bright', copy: 'Head rice with a polish. Special lots add aroma — Dinorado, Jasmine — and a higher price per kilo.' }
  ];

  function setPart(id) {
    var data = parts[id];
    if (!data) return;
    document.querySelectorAll('.grain-part').forEach(function (el) {
      el.classList.toggle('is-active', el.getAttribute('data-part') === id);
      el.classList.toggle('is-dim', el.getAttribute('data-part') !== id);
    });
    document.querySelectorAll('#grain-hotspots button').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-part') === id);
    });
    var img = document.getElementById('anatomy-img');
    var kicker = document.getElementById('anatomy-kicker');
    var title = document.getElementById('anatomy-title');
    var copy = document.getElementById('anatomy-copy');
    if (img) { img.src = data.img; img.alt = data.alt; }
    if (kicker) kicker.textContent = data.kicker;
    if (title) title.textContent = data.title;
    if (copy) copy.textContent = data.copy;
  }

  document.querySelectorAll('.grain-part').forEach(function (el) {
    el.addEventListener('click', function () { setPart(el.getAttribute('data-part')); });
  });
  document.querySelectorAll('#grain-hotspots button').forEach(function (btn) {
    btn.addEventListener('click', function () { setPart(btn.getAttribute('data-part')); });
  });

  var mill = document.getElementById('mill-range');
  var bran = document.getElementById('bran-layer');
  var shine = document.getElementById('endo-shine');
  function applyMill(v) {
    var n = Number(v);
    if (bran) bran.style.opacity = String(1 - n * 0.42);
    if (shine) shine.style.opacity = String(0.2 + n * 0.4);
    document.querySelectorAll('.class-card').forEach(function (card) {
      card.classList.toggle('is-on', Number(card.getAttribute('data-class')) === n);
    });
    var meta = millCopy[n];
    if (meta) {
      var kicker = document.getElementById('anatomy-kicker');
      var title = document.getElementById('anatomy-title');
      var copy = document.getElementById('anatomy-copy');
      if (kicker) kicker.textContent = meta.kicker;
      if (title) title.textContent = meta.title;
      if (copy) copy.textContent = meta.copy;
    }
  }
  if (mill) {
    mill.addEventListener('input', function () { applyMill(mill.value); });
  }
  document.querySelectorAll('.class-card').forEach(function (card) {
    card.addEventListener('click', function () {
      var v = card.getAttribute('data-class');
      if (mill) mill.value = v;
      applyMill(v);
    });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
    });
  });

  document.querySelectorAll('.flip-card').forEach(function (card) {
    var revertTimer = null;
    card.addEventListener('click', function () {
      card.classList.toggle('is-flipped');
      if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
      if (card.classList.contains('is-flipped')) {
        // Auto-flip back after a few seconds (mirrors the :hover auto-revert for mouse users,
        // so tap/keyboard users on touch devices also see the card return to its front).
        revertTimer = setTimeout(function () {
          card.classList.remove('is-flipped');
          revertTimer = null;
        }, 4000);
      }
    });
  });

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('.class-card, .trivia-card').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(900px) rotateY(' + (x * 10) + 'deg) rotateX(' + (-y * 10) + 'deg) scale(1.02)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-in');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.know-reveal').forEach(function (el, i) {
      el.style.transitionDelay = (i % 4) * 80 + 'ms';
      io.observe(el);
    });
  } else {
    document.querySelectorAll('.know-reveal').forEach(function (el) { el.classList.add('is-in'); });
  }

  var cform = document.getElementById('home-contact-form');
  if (cform) {
    cform.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = (cform.name.value || '').trim();
      var email = (cform.email.value || '').trim();
      var message = (cform.message.value || '').trim();
      var subject = encodeURIComponent('AgriPricePH inquiry' + (name ? ' from ' + name : ''));
      var body = encodeURIComponent('From: ' + name + ' <' + email + '>\n\n' + message);
      window.location.href = 'mailto:hello@agripriceph.ph?subject=' + subject + '&body=' + body;
    });
  }
})();
