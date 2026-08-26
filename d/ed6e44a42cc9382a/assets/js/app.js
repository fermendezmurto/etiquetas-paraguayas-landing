/**
 * Etiquetas Paraguayas — comportamiento de interfaz
 * ---------------------------------------------------------------------------
 * Sin dependencias. Todo degrada de forma limpia: si el JS no carga, el sitio
 * sigue siendo legible y navegable (los reveals se activan por CSS de respaldo
 * al final de este archivo, ver `markReady`).
 */

(function () {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  // `document.currentScript` sólo es válido mientras el script se evalúa, así
  // que la ruta del módulo 3D se captura acá y no dentro de un callback.
  //
  // Ojo: un `import()` dentro de un script clásico resuelve contra la URL del
  // script, no contra la del documento. Por eso todo se normaliza a absoluto.
  const SELF = document.currentScript ? document.currentScript.src : '';
  const resolve = (path) => {
    if (!path) return '';
    try {
      return new URL(path, SELF || document.baseURI).href;
    } catch (e) {
      return path;
    }
  };

  // El tema WordPress inyecta la ruta con wp_localize_script (window.EP_SETTINGS).
  const THREE_SRC = resolve(
    (window.EP_SETTINGS && window.EP_SETTINGS.threeSrc) ||
      (document.currentScript && document.currentScript.dataset.threeSrc) ||
      'three-scenes.js'
  );

  /**
   * Ejecuta `cb(el)` la primera vez que el elemento entra en pantalla.
   * Si no hay observador o el viewport mide cero, se ejecuta de inmediato:
   * ninguna de estas mejoras debe poder dejar contenido inerte.
   */
  function whenVisible(el, cb, opts) {
    if (!('IntersectionObserver' in window) || !window.innerHeight) {
      cb(el);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        cb(entry.target);
      });
    }, opts || { threshold: 0.35 });
    io.observe(el);
  }

  /* ======================================================================
     Navegación
     ====================================================================== */

  function initNav() {
    const nav = $('[data-nav]');
    if (!nav) return;

    const toggle = $('[data-nav-toggle]', nav);
    const menu = $('[data-nav-menu]', nav);

    // Sombra al despegarse del tope.
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
    document.body.prepend(sentinel);
    new IntersectionObserver(
      ([entry]) => nav.classList.toggle('is-stuck', !entry.isIntersecting),
      { threshold: 0 }
    ).observe(sentinel);

    if (!toggle || !menu) return;

    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      menu.classList.toggle('is-open', open);
      document.body.classList.toggle('ep-nav-open', open);
    };

    toggle.addEventListener('click', () => {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    // Cerrar al navegar o con Escape.
    menu.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });

    // Si se vuelve a escritorio con el menú abierto, restaurar el scroll.
    // El valor acompaña al breakpoint del hamburguesa en main.css.
    window.matchMedia('(min-width: 1100px)').addEventListener('change', (e) => {
      if (e.matches) setOpen(false);
    });
  }

  /* ======================================================================
     Reveals al hacer scroll
     ====================================================================== */

  function initReveals() {
    const items = $$('[data-reveal]');
    if (!items.length) return;

    const revealAll = () => items.forEach((el) => el.classList.add('is-visible'));

    // Sin observador, con movimiento reducido, o con un viewport de altura cero
    // (pasa en webviews embebidas y en algunos renderers headless), el
    // observador nunca intersecaría nada y el contenido quedaría invisible.
    if (reduced || !('IntersectionObserver' in window) || !window.innerHeight) {
      revealAll();
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
    );

    items.forEach((el) => {
      // Escalona los elementos que comparten contenedor.
      if (!el.style.getPropertyValue('--delay')) {
        const siblings = Array.from(el.parentElement ? el.parentElement.children : []);
        const idx = siblings.indexOf(el);
        el.style.setProperty('--delay', `${Math.min(idx, 6) * 80}ms`);
      }
      io.observe(el);
    });

    // Red de seguridad: si al segundo y medio el observador no reveló nada,
    // asumimos que no va a hacerlo y mostramos todo. Un contenido invisible es
    // mucho peor que una animación que no se ejecuta.
    setTimeout(() => {
      if (!document.querySelector('[data-reveal].is-visible')) {
        io.disconnect();
        revealAll();
      }
    }, 1500);
  }

  /**
   * Divide un título en palabras animables.
   * Corre antes que initReveals para que el observador lo tome como uno más:
   * las palabras dependen de la misma clase `is-visible`.
   */
  function initWords() {
    $$('[data-words]').forEach((el) => {
      if (el.dataset.split) return;
      const words = el.textContent.trim().split(/\s+/);
      el.textContent = '';
      words.forEach((word, i) => {
        const span = document.createElement('span');
        span.textContent = word;
        span.style.setProperty('--i', String(i));
        el.append(span);
        if (i < words.length - 1) el.append(document.createTextNode(' '));
      });
      el.dataset.split = '1';
      el.classList.add('ep-words');
      // Sin esto el título quedaría en opacidad 0 para siempre.
      if (!el.hasAttribute('data-reveal')) el.setAttribute('data-reveal', 'fade');
    });
  }

  /* ======================================================================
     Contadores
     ====================================================================== */

  function initCounters() {
    const nodes = $$('[data-count]');
    if (!nodes.length) return;

    // Sin separador de miles por debajo de 10.000: agrupar convertía el año
    // «1998» en «1.998». Recién a partir de cinco dígitos agrupar ayuda a leer.
    const format = (n, decimals, target) =>
      n.toLocaleString('es-PY', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: Math.abs(target) >= 10000,
      });

    const run = (el) => {
      const target = parseFloat(el.dataset.count);
      if (Number.isNaN(target)) return;
      const decimals = (el.dataset.count.split('.')[1] || '').length;

      if (reduced) {
        el.textContent = format(target, decimals, target);
        return;
      }

      const duration = 1500;
      const start = performance.now();

      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        // easeOutExpo
        const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        el.textContent = format(target * eased, decimals, target);
        if (t < 1) requestAnimationFrame(step);
      };

      requestAnimationFrame(step);
    };

    nodes.forEach((el) => {
      el.textContent = '0';
      whenVisible(el, run, { threshold: 0.5 });
    });
  }

  /* ======================================================================
     Línea de proceso: se dibuja al entrar en pantalla
     ====================================================================== */

  function initProcess() {
    const track = $('[data-process]');
    if (!track) return;

    if (reduced) {
      track.style.setProperty('--progress', '1');
      return;
    }

    whenVisible(track, (el) => el.style.setProperty('--progress', '1'));
  }

  /* ======================================================================
     Resplandor de tarjetas siguiendo al cursor
     ====================================================================== */

  function initCardGlow() {
    if (reduced || !window.matchMedia('(pointer: fine)').matches) return;

    $$('.ep-card').forEach((card) => {
      card.addEventListener(
        'pointermove',
        (e) => {
          const rect = card.getBoundingClientRect();
          card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
          card.style.setProperty('--my', `${e.clientY - rect.top}px`);
        },
        { passive: true }
      );
    });
  }

  /* ======================================================================
     Galería: filtros + lightbox
     ====================================================================== */

  function initGallery() {
    const gallery = $('[data-gallery]');
    if (!gallery) return;

    const tiles = $$('.ep-tile', gallery);
    const filters = $$('[data-filter]');

    filters.forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.filter;
        filters.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        tiles.forEach((tile) => {
          const match = value === '*' || (tile.dataset.cat || '').split(' ').includes(value);
          tile.classList.toggle('is-hidden', !match);
        });
      });
    });

    /* --- Lightbox --- */
    const box = $('[data-lightbox]');
    if (!box) return;

    const img = $('img', box);
    const cap = $('[data-lightbox-cap]', box);
    const closeBtn = $('[data-lightbox-close]', box);
    let lastFocus = null;

    const open = (tile) => {
      const source = $('img', tile);
      if (!source) return;
      lastFocus = document.activeElement;
      img.src = source.dataset.full || source.currentSrc || source.src;
      img.alt = source.alt || '';
      if (cap) cap.textContent = tile.dataset.caption || source.alt || '';
      box.classList.add('is-open');
      document.body.classList.add('ep-nav-open');
      closeBtn?.focus();
    };

    const close = () => {
      box.classList.remove('is-open');
      document.body.classList.remove('ep-nav-open');
      lastFocus?.focus();
    };

    tiles.forEach((tile) => {
      tile.addEventListener('click', () => open(tile));
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(tile);
        }
      });
      if (!tile.hasAttribute('tabindex')) tile.tabIndex = 0;
      if (!tile.hasAttribute('role')) tile.setAttribute('role', 'button');
    });

    closeBtn?.addEventListener('click', close);
    box.addEventListener('click', (e) => {
      if (e.target === box) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && box.classList.contains('is-open')) close();
    });
  }

  /* ======================================================================
     Barra de progreso de lectura
     ====================================================================== */

  function initProgress() {
    const bar = $('[data-progress]');
    if (!bar || reduced) return;

    let ticking = false;
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? window.scrollY / max : 0;
      bar.style.setProperty('--p', String(Math.min(1, Math.max(0, p))));
      ticking = false;
    };

    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  /* ======================================================================
     Marquee: duplica el contenido para que el loop no muestre huecos
     ====================================================================== */

  function initMarquee() {
    $$('[data-marquee]').forEach((track) => {
      if (track.dataset.cloned) return;
      const items = Array.from(track.children);
      items.forEach((item) => {
        const clone = item.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        track.append(clone);
      });
      track.dataset.cloned = '1';
    });
  }

  /* ======================================================================
     Resaltado del enlace de la sección visible
     ====================================================================== */

  function initScrollSpy() {
    const links = $$('[data-spy] a[href^="#"]');
    if (!links.length) return;

    const map = new Map();
    links.forEach((link) => {
      const id = link.getAttribute('href').slice(1);
      const section = id && document.getElementById(id);
      if (section) map.set(section, link.parentElement || link);
    });
    if (!map.size) return;

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = map.get(entry.target);
          if (el) el.classList.toggle('is-active', entry.isIntersecting);
        });
      },
      { rootMargin: '-45% 0px -50% 0px' }
    );

    map.forEach((_, section) => io.observe(section));
  }

  /* ======================================================================
     Formulario de contacto (demo estática)
     ====================================================================== */

  function initForm() {
    const form = $('[data-demo-form]');
    if (!form) return;

    const status = $('[data-form-status]', form);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;

      if (status) {
        status.dataset.state = 'ok';
        status.textContent =
          'Demo estática: el formulario no envía datos. En WordPress queda conectado a Contact Form 7 y llega a etiquetas@etiquetasparaguayas.com.py.';
      }
    });
  }

  /* ======================================================================
     Escenas WebGL (carga diferida)
     ====================================================================== */

  function initThree() {
    const targets = $$('[data-three]');
    if (!targets.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let loaded = false;
    const load = () => {
      if (loaded) return;
      loaded = true;
      import(/* webpackIgnore: true */ THREE_SRC)
        .then((mod) => mod.initScenes(window.EP_SETTINGS || {}))
        .catch((err) => console.warn('[EP] Escenas 3D no disponibles:', err));
    };

    // Sólo se descarga three.js cuando alguna escena está por entrar en pantalla.
    targets.forEach((el) => whenVisible(el, load, { rootMargin: '300px' }));
  }

  /* ======================================================================
     Arranque
     ====================================================================== */

  function markReady() {
    document.documentElement.classList.add('ep-js');
  }

  function init() {
    markReady();
    initNav();
    initWords();
    initReveals();
    initCounters();
    initProcess();
    initCardGlow();
    initGallery();
    initProgress();
    initMarquee();
    initScrollSpy();
    initForm();
    initThree();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
