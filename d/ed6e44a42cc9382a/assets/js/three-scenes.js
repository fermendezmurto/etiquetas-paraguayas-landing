/**
 * Etiquetas Paraguayas — escenas WebGL
 * ---------------------------------------------------------------------------
 * Dos escenas independientes, cada una autocontenida y perezosa:
 *
 *  1. siteRibbon()   — una única banda de etiquetas que recorre el documento
 *                      entero por detrás del contenido. El scroll no mueve la
 *                      banda: mueve la cámara y adelanta el cabezal de
 *                      impresión, de modo que las etiquetas se van imprimiendo
 *                      a medida que el visitante baja.
 *
 *  2. labelRoll()    — rollo de etiquetas navegable con el arrastre del mouse.
 *                      La textura impresa se genera por código en un <canvas>,
 *                      así el tema no depende de ninguna imagen externa.
 *
 * Reglas transversales: nada arranca si el usuario pidió menos movimiento, si
 * no hay WebGL, o si la sección está fuera de viewport. Todo se pausa con la
 * pestaña oculta y se destruye limpio.
 */

import * as THREE from './vendor/three.module.min.js';

/* ==========================================================================
   Utilidades compartidas
   ========================================================================== */

const PALETTE = {
  navyDeep: 0x04101f,
  navy: 0x12305c,
  navyLight: 0x3d74b8,
  lime: 0xa6ce39,
  limeBright: 0xb9dd53,
  cyan: 0x45b6d8,
  paper: 0xf2f6fa,
};

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    );
  } catch (e) {
    return false;
  }
}

/** Conexión ligera / equipo modesto → bajamos la calidad antes de dibujar. */
function qualityTier() {
  const conn = navigator.connection;
  if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ''))) return 'off';
  const cores = navigator.hardwareConcurrency || 4;
  const narrow = window.matchMedia('(max-width: 767px)').matches;
  if (cores <= 4 || narrow) return 'low';
  return 'high';
}

/**
 * Bucle de render con pausa automática.
 * Combina IntersectionObserver (fuera de pantalla) y visibilitychange.
 */
function createLoop(el, onFrame) {
  // Reloj propio: THREE.Clock quedó deprecado en r185 y THREE.Timer vive en
  // los addons, que no se distribuyen con el build que empaquetamos.
  let last = 0;
  let elapsed = 0;
  let rafId = null;
  let onScreen = false;

  const tick = (now) => {
    rafId = requestAnimationFrame(tick);
    // Se acota el delta para que volver de una pausa no dé un salto enorme.
    const delta = Math.min((now - last) / 1000, 0.05);
    last = now;
    elapsed += delta;
    onFrame(delta, elapsed);
  };

  const start = () => {
    if (rafId !== null) return;
    last = performance.now();
    rafId = requestAnimationFrame(tick);
  };

  const stop = () => {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  };

  const sync = () => {
    if (onScreen && !document.hidden) start();
    else stop();
  };

  // Con viewport de altura cero el observador no intersecaría nunca y la
  // escena quedaría congelada; en ese caso se asume visible.
  const observable = 'IntersectionObserver' in window && !!window.innerHeight;

  let io = null;
  if (observable) {
    io = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0].isIntersecting;
        sync();
      },
      { rootMargin: '160px' }
    );
    io.observe(el);
  } else {
    onScreen = true;
  }

  document.addEventListener('visibilitychange', sync);

  return {
    start,
    stop,
    dispose() {
      stop();
      if (io) io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    },
  };
}

/** Libera geometrías, materiales y texturas de un subárbol. */
function disposeTree(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m) => {
      if (!m) return;
      Object.values(m).forEach((v) => {
        if (v && v.isTexture) v.dispose();
      });
      m.dispose();
    });
  });
}

/** Observa el tamaño real del canvas y mantiene cámara + renderer en escala. */
function watchSize(canvas, renderer, camera, extra) {
  const apply = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (extra) extra(w, h);
  };
  const ro = new ResizeObserver(apply);
  ro.observe(canvas);
  apply();
  return () => ro.disconnect();
}

/* ==========================================================================
   Escena 1 — La banda continua
   --------------------------------------------------------------------------
   Una sola banda de sustrato recorre el documento entero, de arriba abajo,
   detrás del contenido. El scroll de la página no mueve la banda: mueve la
   cámara a lo largo de ella y, sobre todo, adelanta el cabezal de impresión.

   Las etiquetas por delante del cabezal son papel en blanco con el troquel
   marcado; las que ya pasaron salen impresas. Así, bajar por el sitio es
   literalmente ver correr la tirada.
   ========================================================================== */

/** Trayectoria de la banda. Debe ser idéntica a curve() del vertex shader. */
const BAND = {
  len: 150,      // largo total en unidades de mundo
  amp: 6.2,      // cuánto se abre hacia los costados
  zBase: -6.0,   // profundidad media
  zAmp: 3.4,     // cuánto entra y sale de plano
  weaves: 3.25,  // vaivenes completos de arriba abajo
};

/**
 * Punto de la banda para t ∈ [0,1].
 * Se usa en JS para colocar el cabezal; el shader repite la misma fórmula.
 */
function bandPoint(t, out) {
  const a = t * Math.PI * 2 * BAND.weaves;
  out.set(
    Math.sin(a) * BAND.amp,
    -t * BAND.len,
    BAND.zBase + Math.cos(a * 0.6 + 1.3) * BAND.zAmp
  );
  return out;
}

const BAND_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uLen;
  uniform float uAmp;
  uniform float uZBase;
  uniform float uZAmp;
  uniform float uWeaves;
  uniform float uWidth;
  uniform float uTwist;

  varying vec2  vUv;
  varying float vFresnel;
  varying float vShade;

  const float TAU = 6.2831853;

  vec3 curve(float t) {
    float a = t * TAU * uWeaves;
    return vec3(
      sin(a) * uAmp,
      -t * uLen,
      uZBase + cos(a * 0.6 + 1.3) * uZAmp
    );
  }

  void main() {
    vUv = uv;

    // uv.y corre a lo largo de la banda; uv.x, a lo ancho.
    float t = uv.y;
    float across = uv.x - 0.5;

    const float dt = 0.0015;
    vec3 p0 = curve(t);
    vec3 p1 = curve(t + dt);
    vec3 tangent = normalize(p1 - p0);

    // El eje de referencia es Z y no Y: la banda baja casi vertical, y con Y
    // el producto vectorial se degeneraría.
    vec3 binormal = normalize(cross(tangent, vec3(0.0, 0.0, 1.0)));
    vec3 normalV  = normalize(cross(binormal, tangent));

    // Torsión suave, como el sustrato al salir de un rodillo.
    float twist = uTwist * sin(t * 9.0 + uTime * 0.25);
    vec3 side = binormal * cos(twist) + normalV * sin(twist);

    vec3 pos = p0 + side * (across * uWidth);
    vec3 nrm = normalize(cross(tangent, side));

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vec3 nrmView = normalize(normalMatrix * nrm);
    vec3 viewDir = normalize(-mv.xyz);

    vFresnel = pow(1.0 - abs(dot(nrmView, viewDir)), 2.4);
    vShade   = abs(dot(nrmView, normalize(vec3(0.35, 0.55, 0.75)))) * 0.38 + 0.62;

    gl_Position = projectionMatrix * mv;
  }
`;

const BAND_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3  uPaper;
  uniform vec3  uInk;
  uniform vec3  uAccent;
  uniform vec3  uEdge;
  uniform float uCells;
  uniform float uPrint;    // frontera impreso / sin imprimir, en t
  uniform float uOpacity;
  uniform float uTime;

  varying vec2  vUv;
  varying float vFresnel;
  varying float vShade;

  // Rectángulo de bordes suaves. El parámetro se llama halfSize y no half:
  // "half" es palabra reservada en GLSL ES y el shader no compilaría.
  float roundedRect(vec2 p, vec2 halfSize, float r, float soft) {
    vec2 d = abs(p) - halfSize + r;
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    return 1.0 - smoothstep(-soft, soft, dist);
  }

  void main() {
    // Troquel repetido a lo largo de la banda.
    float cellF  = vUv.y * uCells;
    float cellId = floor(cellF);
    vec2  cellUv = vec2(vUv.x, fract(cellF)) - 0.5;

    float body   = roundedRect(cellUv, vec2(0.40, 0.44), 0.10, 0.012);
    float head   = roundedRect(cellUv - vec2(0.0, 0.26), vec2(0.30, 0.09), 0.03, 0.010);
    float lines  = roundedRect(cellUv - vec2(-0.05, 0.02), vec2(0.22, 0.03), 0.02, 0.010);
    float code   = roundedRect(cellUv - vec2(0.0, -0.26), vec2(0.26, 0.07), 0.02, 0.010);

    // ¿Esta etiqueta ya pasó por el cabezal?
    float printed = smoothstep(uPrint + 0.006, uPrint - 0.006, vUv.y);

    // Sin imprimir: sustrato limpio, apenas el troquel marcado.
    vec3 blank = uPaper * (0.90 + body * 0.10);

    // Impresa: bloque de cabecera, filete de acento, texto y código.
    vec3 ink = uPaper;
    ink = mix(ink, uInk,    head  * 0.92);
    ink = mix(ink, uAccent, lines * 0.75);
    ink = mix(ink, uInk,    code  * 0.80);

    vec3 color = mix(blank, ink, printed);

    // Justo en el cabezal, la tinta destella al asentarse.
    float atHead = exp(-pow((vUv.y - uPrint) * 90.0, 2.0));
    color += uAccent * atHead * 0.55;

    color *= vShade;
    color += uEdge * vFresnel * 0.5;

    // La banda entra y sale de cuadro sin cortes secos.
    float fadeEnds = smoothstep(0.0, 0.02, vUv.y) * smoothstep(1.0, 0.98, vUv.y);
    float fadeSide = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x);

    float alpha = uOpacity * fadeEnds * fadeSide
                * (0.74 + body * 0.26 + vFresnel * 0.3 + atHead * 0.4);

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

const DUST_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  attribute float aScale;
  attribute float aSeed;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    p.x += sin(uTime * 0.14 + aSeed * 6.28) * 1.4;
    p.y += cos(uTime * 0.11 + aSeed * 4.71) * 1.0;
    p.z += sin(uTime * 0.09 + aSeed * 2.35) * 0.8;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uPixelRatio * (34.0 / max(-mv.z, 0.001));

    vAlpha = smoothstep(46.0, 8.0, -mv.z) * (0.2 + aSeed * 0.45);
  }
`;

const DUST_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    float mask = smoothstep(0.5, 0.06, d);
    if (mask < 0.01) discard;
    gl_FragColor = vec4(uColor, mask * vAlpha);
  }
`;

/**
 * Monta la banda continua sobre un canvas fijo, detrás de todo el documento.
 * @returns {{dispose: () => void} | null}
 */
export function siteRibbon(canvas, options = {}) {
  if (!canvas || !supportsWebGL() || prefersReducedMotion()) return null;

  // Sin caja de layout no hay nada que dibujar: es el caso del teléfono, donde
  // la hoja de estilos lo pone en display:none (ver nota en main.css).
  if (!canvas.clientWidth || !canvas.clientHeight) return null;

  const tier = options.tier || qualityTier();
  if (tier === 'off') return null;

  const LOW = tier === 'low';
  const segments = LOW ? 220 : 520;
  const dustCount = LOW ? 90 : 260;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !LOW,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW ? 1.25 : 1.75));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 90);

  /* --- La banda ---------------------------------------------------------- */

  // Muchos segmentos a lo largo (uv.y) y pocos a lo ancho: la curvatura vive
  // toda en el eje largo.
  const bandGeo = new THREE.PlaneGeometry(1, 1, 2, segments);

  const bandMat = new THREE.ShaderMaterial({
    vertexShader: BAND_VERT,
    fragmentShader: BAND_FRAG,
    uniforms: {
      uTime:    { value: 0 },
      uLen:     { value: BAND.len },
      uAmp:     { value: BAND.amp },
      uZBase:   { value: BAND.zBase },
      uZAmp:    { value: BAND.zAmp },
      uWeaves:  { value: BAND.weaves },
      uWidth:   { value: 3.9 },
      uTwist:   { value: 0.42 },
      uCells:   { value: 46 },
      uPrint:   { value: 0 },
      uOpacity: { value: 0.95 },
      uPaper:   { value: new THREE.Color(0xe9eef5) },
      uInk:     { value: new THREE.Color(options.ink || PALETTE.navy) },
      uAccent:  { value: new THREE.Color(options.accent || PALETTE.lime) },
      uEdge:    { value: new THREE.Color(PALETTE.limeBright) },
    },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const band = new THREE.Mesh(bandGeo, bandMat);
  band.frustumCulled = false;
  scene.add(band);

  /* --- Banda de acompañamiento, más lejos y más tenue -------------------- */

  let ghost = null;
  if (!LOW) {
    const ghostMat = bandMat.clone();
    ghostMat.uniforms = THREE.UniformsUtils.clone(bandMat.uniforms);
    ghostMat.uniforms.uAmp.value = BAND.amp * 1.55;
    ghostMat.uniforms.uZBase.value = BAND.zBase - 9;
    ghostMat.uniforms.uWeaves.value = BAND.weaves * 0.62;
    ghostMat.uniforms.uWidth.value = 4.6;
    ghostMat.uniforms.uCells.value = 34;
    ghostMat.uniforms.uOpacity.value = 0.2;
    ghostMat.uniforms.uInk.value = new THREE.Color(PALETTE.navyLight);

    ghost = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 2, Math.round(segments * 0.6)), ghostMat);
    ghost.frustumCulled = false;
    scene.add(ghost);
  }

  /* --- Cabezal de impresión ---------------------------------------------- */
  // Dos cilindros que muerden la banda. Viajan sobre ella siguiendo uPrint,
  // así que la frontera entre impreso y sin imprimir siempre cae bajo ellos.

  const head = new THREE.Group();
  const rollerGeo = new THREE.CylinderGeometry(0.62, 0.62, 4.4, LOW ? 16 : 28);

  const rollerMat = new THREE.MeshBasicMaterial({ color: 0x2b3a4d });
  const inkedMat = new THREE.MeshBasicMaterial({
    color: options.accent || PALETTE.lime,
  });

  const rollerTop = new THREE.Mesh(rollerGeo, inkedMat);
  const rollerBottom = new THREE.Mesh(rollerGeo, rollerMat);
  rollerTop.position.z = 0.72;
  rollerBottom.position.z = -0.72;
  head.add(rollerTop, rollerBottom);

  // Anillo de luz para que el cabezal se lea aun sobre secciones claras.
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(2.6, 3.4, 32),
    new THREE.MeshBasicMaterial({
      color: options.accent || PALETTE.lime,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  head.add(halo);
  scene.add(head);

  /* --- Polvo de tinta ---------------------------------------------------- */

  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(dustCount * 3);
  const dustScale = new Float32Array(dustCount);
  const dustSeed = new Float32Array(dustCount);

  for (let i = 0; i < dustCount; i += 1) {
    dustPos[i * 3] = (Math.random() - 0.5) * 34;
    dustPos[i * 3 + 1] = -Math.random() * BAND.len;
    dustPos[i * 3 + 2] = -Math.random() * 18 + 2;
    dustScale[i] = 0.5 + Math.random() * 1.8;
    dustSeed[i] = Math.random();
  }

  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aScale', new THREE.BufferAttribute(dustScale, 1));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));

  const dustMat = new THREE.ShaderMaterial({
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uColor: { value: new THREE.Color(PALETTE.limeBright) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);

  /* --- Scroll y parallax -------------------------------------------------- */

  const pointer = new THREE.Vector2(0, 0);
  const pointerTarget = new THREE.Vector2(0, 0);
  let scrollTarget = 0;
  let scrollEased = 0;

  const readScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollTarget = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  };

  const onPointerMove = (e) => {
    pointerTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointerTarget.y = (e.clientY / window.innerHeight) * 2 - 1;
  };

  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (finePointer) window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('resize', readScroll, { passive: true });
  readScroll();
  scrollEased = scrollTarget;

  const unwatch = watchSize(canvas, renderer, camera, () => {
    dustMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    readScroll();
  });

  /* --- Bucle -------------------------------------------------------------- */

  const headPos = new THREE.Vector3();
  const headAhead = new THREE.Vector3();
  const camAt = new THREE.Vector3();

  // La cámara mira un poco más adelante que el punto donde está el cabezal:
  // así el cabezal queda en el tercio superior y no tapado por el contenido.
  const CAM_LEAD = 0.055;

  // Sin fundido de entrada, a propósito. Este canvas es un fondo: aparece con
  // la página y listo. Cualquier rampa —CSS o JS— deja la opacidad en manos de
  // que el bucle avance, y basta con que el navegador estrangule
  // requestAnimationFrame para que la banda se quede apagada indefinidamente.
  const loop = createLoop(canvas, (delta, elapsed) => {
    // Suavizado del scroll: sin esto la banda da tirones con la rueda.
    const k = Math.min(1, delta * 4.5);
    scrollEased += (scrollTarget - scrollEased) * k;
    pointer.x += (pointerTarget.x - pointer.x) * Math.min(1, delta * 2.2);
    pointer.y += (pointerTarget.y - pointer.y) * Math.min(1, delta * 2.2);

    // El cabezal recorre la banda con el scroll, dejando margen en las puntas.
    const print = 0.04 + scrollEased * 0.92;

    bandMat.uniforms.uPrint.value = print;
    bandMat.uniforms.uTime.value = elapsed;
    if (ghost) {
      ghost.material.uniforms.uPrint.value = print;
      ghost.material.uniforms.uTime.value = elapsed;
    }
    dustMat.uniforms.uTime.value = elapsed;

    // Cabezal sobre la banda, orientado según su tangente.
    bandPoint(print, headPos);
    bandPoint(print + 0.004, headAhead);
    head.position.copy(headPos);
    head.lookAt(headAhead);
    // Los cilindros nacen sobre Y; se acuestan para cruzar la banda.
    rollerTop.rotation.z = Math.PI / 2;
    rollerBottom.rotation.z = Math.PI / 2;
    rollerTop.rotation.x = elapsed * 2.4;
    rollerBottom.rotation.x = -elapsed * 2.4;

    // Cámara: baja junto al cabezal, con parallax suave del puntero.
    bandPoint(print + CAM_LEAD, camAt);
    // La cámara va corrida a la izquierda para que la banda quede en el
    // tercio derecho del cuadro: el texto del sitio es de alineación
    // izquierda y así no compiten.
    camera.position.set(
      -2.4 + pointer.x * 1.1,
      camAt.y + 1.2,
      13.5 - pointer.y * 0.8
    );
    camera.lookAt(-2.4, camAt.y - 2.5, BAND.zBase);

    renderer.render(scene, camera);
  });

  renderer.render(scene, camera);
  canvas.classList.add('is-ready');
  document.documentElement.classList.add('ep-backdrop-on');
  loop.start();

  return {
    dispose() {
      loop.dispose();
      unwatch();
      if (finePointer) window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('scroll', readScroll);
      window.removeEventListener('resize', readScroll);
      document.documentElement.classList.remove('ep-backdrop-on');
      disposeTree(scene);
      renderer.dispose();
    },
  };
}

/* ==========================================================================
   Escena 2 — Rollo de etiquetas
   ========================================================================== */

/**
 * Dibuja la cara impresa del rollo en un canvas 2D.
 * Se genera por código a propósito: el tema no arrastra imágenes de muestra y
 * el cliente puede recolorearlo desde el Personalizador.
 */
function makeLabelTexture(opts) {
  const { count = 8, ink = '#12305c', accent = '#a6ce39', paper = '#f2f6fa',
          brand = 'ETIQUETAS PARAGUAYAS' } = opts || {};

  // La etiqueta se dibuja en horizontal (como se lee) y después se rota al
  // pegarla en el atlas: en un rollo real el troquel se repite alrededor de la
  // circunferencia y el texto corre a lo ancho de la banda, no alrededor.
  const LEN = 512;   // largo del texto — termina siguiendo el eje del rollo
  const WID = 320;   // ancho del troquel — termina siguiendo la circunferencia

  const cell = document.createElement('canvas');
  cell.width = LEN;
  cell.height = WID;
  const cx = cell.getContext('2d');

  cx.fillStyle = paper;
  cx.fillRect(0, 0, LEN, WID);

  // Separación entre troqueles
  cx.fillStyle = 'rgba(18,48,92,0.10)';
  cx.fillRect(0, 0, LEN, 8);

  // Bloque de color de cabecera
  cx.fillStyle = ink;
  cx.fillRect(26, 24, LEN - 62, 96);

  cx.fillStyle = accent;
  cx.fillRect(26, 120, LEN - 62, 10);

  // Marca, ajustada para que nunca se corte contra el borde del troquel.
  const brandBox = LEN - 62 - 44;
  cx.fillStyle = paper;
  cx.textBaseline = 'middle';
  let brandSize = 40;
  do {
    cx.font = `700 ${brandSize}px Sora, Montserrat, sans-serif`;
    if (cx.measureText(brand).width <= brandBox) break;
    brandSize -= 2;
  } while (brandSize > 14);
  cx.fillText(brand, 48, 74);

  // Líneas de texto simuladas
  cx.fillStyle = 'rgba(18,48,92,0.55)';
  [220, 300, 180].forEach((w, i) => {
    cx.fillRect(30, 168 + i * 26, w, 9);
  });

  // Código de barras determinista (mismo dibujo en cada render)
  let bx = 30;
  for (let i = 0; i < 34; i += 1) {
    const w = 2 + ((i * 7919) % 5);
    if (i % 2 === 0) {
      cx.fillStyle = ink;
      cx.fillRect(bx, 250, w, 46);
    }
    bx += w + 2;
  }

  // Sello lateral
  cx.strokeStyle = accent;
  cx.lineWidth = 4;
  cx.beginPath();
  cx.arc(LEN - 78, 246, 40, 0, Math.PI * 2);
  cx.stroke();

  // Atlas de dos troqueles a lo largo de la circunferencia (eje U).
  const canvas = document.createElement('canvas');
  canvas.width = WID * 2;
  canvas.height = LEN;
  const ctx = canvas.getContext('2d');

  for (let c = 0; c < 2; c += 1) {
    ctx.save();
    ctx.translate(c * WID, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(cell, 0, -WID);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(count / 2, 1);
  texture.anisotropy = 8;
  return texture;
}

/** Cara lateral del rollo: espiral de capas bobinadas. */
function makeWindingTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;

  ctx.fillStyle = '#e7edf4';
  ctx.fillRect(0, 0, size, size);

  // Anillos concéntricos = capas de sustrato.
  for (let r = c; r > 40; r -= 2.2) {
    const t = (c - r) / c;
    const shade = 214 + Math.sin(r * 0.9) * 16 - t * 26;
    ctx.strokeStyle = `rgb(${shade},${shade + 5},${shade + 12})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Núcleo de cartón
  ctx.fillStyle = '#b9a184';
  ctx.beginPath();
  ctx.arc(c, c, 44, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/**
 * Rollo 3D interactivo. Arrastre horizontal para girar, inercia al soltar.
 * @returns {{dispose: () => void} | null}
 */
export function labelRoll(canvas, options = {}) {
  if (!canvas || !supportsWebGL()) return null;

  const tier = options.tier || qualityTier();
  if (tier === 'off') return null;

  const reduced = prefersReducedMotion();
  const LOW = tier === 'low';
  const radialSeg = LOW ? 48 : 96;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !LOW,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  // Un poco más atrás en pantallas chicas: con el encuadre de escritorio el
  // rollo se salía por el costado.
  camera.position.set(0, 1.15, LOW ? 7.4 : 6.4);
  camera.lookAt(0, 0, 0);

  const group = new THREE.Group();
  group.rotation.set(0.34, -0.55, 0.12);
  scene.add(group);

  const labelTex = makeLabelTexture({
    count: 9,
    brand: options.brand || 'ETIQUETAS PARAGUAYAS',
    ink: options.ink || '#12305c',
    accent: options.accent || '#a6ce39',
  });
  const windingTex = makeWindingTexture();

  const R = 1.55;   // radio exterior
  const H = 1.9;    // ancho de bobina

  /* --- Superficie impresa ------------------------------------------------ */
  const shellMat = new THREE.MeshStandardMaterial({
    map: labelTex,
    roughness: 0.52,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, H, radialSeg, 1, true),
    shellMat
  );
  shell.rotation.z = Math.PI / 2; // el eje del rollo queda horizontal
  group.add(shell);

  /* --- Caras laterales (capas bobinadas) --------------------------------- */
  const sideMat = new THREE.MeshStandardMaterial({
    map: windingTex,
    roughness: 0.78,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  [-1, 1].forEach((dir) => {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, radialSeg), sideMat);
    disc.position.x = dir * (H / 2 + 0.001);
    disc.rotation.y = dir * (Math.PI / 2);
    group.add(disc);
  });

  /* --- Núcleo de cartón --------------------------------------------------- */
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(0.44, 0.44, H + 0.06, Math.max(24, radialSeg / 2), 1, true),
    new THREE.MeshStandardMaterial({ color: 0xb9a184, roughness: 0.95, side: THREE.DoubleSide })
  );
  core.rotation.z = Math.PI / 2;
  group.add(core);

  /* --- Cola de etiquetas que se despega ---------------------------------- */
  // El eje del rollo es X, así que la banda vive en el plano YZ. Se construye
  // en dos tramos: primero abraza la bobina, después sale por la tangente y
  // cae. Sin el tramo pegado la cola se lee como una lámina flotando suelta.
  const tailLen = 3.4;
  const tailSeg = LOW ? 28 : 64;
  const tailGeo = new THREE.PlaneGeometry(tailLen, H, tailSeg, 1);
  {
    const pos = tailGeo.attributes.position;
    const rr = R + 0.012;          // apenas por encima de la superficie impresa
    const wrap = 0.40;             // porción de la banda que sigue adherida
    const aEnd = Math.PI / 2;      // se suelta justo arriba del rollo
    const aSpan = 1.5;             // arco recorrido antes de soltarse
    const droop = 0.22;            // caída por su propio peso

    for (let i = 0; i < pos.count; i += 1) {
      const along = pos.getX(i);              // -L/2 … L/2 a lo largo de la banda
      const across = pos.getY(i);             // -H/2 … H/2 a lo ancho
      const t = (along + tailLen / 2) / tailLen;

      let y;
      let z;

      if (t < wrap) {
        // Todavía adherida: sigue la circunferencia hasta el punto de despegue.
        const a = aEnd + aSpan * (1 - t / wrap);
        y = Math.sin(a) * rr;
        z = Math.cos(a) * rr;
      } else {
        // Libre: sale por la tangente y se va venciendo.
        const d = (t - wrap) * tailLen;
        y = Math.sin(aEnd) * rr - Math.cos(aEnd) * d - droop * d * d;
        z = Math.cos(aEnd) * rr + Math.sin(aEnd) * d;
      }

      // El ancho de la banda se alinea con el eje del rollo.
      pos.setXYZ(i, across, y, z);
    }
    pos.needsUpdate = true;
    tailGeo.computeVertexNormals();
  }

  // De la cola vemos la cara opuesta del plano, así que la impresión llega
  // girada 180°: hay que invertir ambos ejes, no sólo uno (invertir sólo V
  // deja el texto derecho pero el troquel cabeza abajo).
  const tailTex = labelTex.clone();
  tailTex.needsUpdate = true;
  tailTex.wrapT = THREE.RepeatWrapping;
  tailTex.repeat.set(-3, -1);
  tailTex.offset.set(1, 1);

  const tail = new THREE.Mesh(
    tailGeo,
    new THREE.MeshStandardMaterial({
      map: tailTex,
      roughness: 0.5,
      metalness: 0.03,
      side: THREE.DoubleSide,
    })
  );
  group.add(tail);

  /* --- Luces -------------------------------------------------------------- */
  scene.add(new THREE.HemisphereLight(0xdfeaf6, PALETTE.navyDeep, 1.15));

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(3.2, 4.4, 4.0);
  scene.add(key);

  const rim = new THREE.DirectionalLight(PALETTE.limeBright, 2.4);
  rim.position.set(-4.2, 1.4, -3.0);
  scene.add(rim);

  const fill = new THREE.PointLight(PALETTE.cyan, 12, 18, 2);
  fill.position.set(-1.5, -2.2, 3.2);
  scene.add(fill);

  /* --- Interacción -------------------------------------------------------- */
  let spin = 0;            // rotación acumulada del eje
  let velocity = reduced ? 0 : 0.22;
  let dragging = false;
  let lastX = 0;
  let tiltTarget = 0.34;
  let tilt = 0.34;

  const onDown = (e) => {
    dragging = true;
    lastX = e.clientX;
    canvas.setPointerCapture?.(e.pointerId);
  };

  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    velocity = dx * 0.012;
    spin += velocity;
  };

  const onUp = (e) => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  };

  const onHover = (e) => {
    const rect = canvas.getBoundingClientRect();
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    tiltTarget = 0.34 - ny * 0.5;
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointermove', onHover, { passive: true });

  // Accesibilidad: el rollo también se gira con el teclado.
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    'Modelo tridimensional de un rollo de etiquetas impresas. Usá las flechas para girarlo.'
  );
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { spin -= 0.18; e.preventDefault(); }
    if (e.key === 'ArrowRight') { spin += 0.18; e.preventDefault(); }
  };
  canvas.addEventListener('keydown', onKey);

  const unwatch = watchSize(canvas, renderer, camera);

  const loop = createLoop(canvas, (delta, elapsed) => {
    if (!dragging) {
      // Inercia + retorno al giro base.
      velocity += ((reduced ? 0 : 0.22) * delta - velocity) * Math.min(1, delta * 1.6);
      spin += velocity * delta * (reduced ? 0 : 1);
    }

    tilt += (tiltTarget - tilt) * Math.min(1, delta * 3);

    group.rotation.x = tilt;
    group.rotation.y = -0.55 + spin;
    if (!reduced) group.position.y = Math.sin(elapsed * 0.7) * 0.06;

    renderer.render(scene, camera);
  });

  renderer.render(scene, camera);
  canvas.classList.add('is-ready');
  loop.start();

  return {
    dispose() {
      loop.dispose();
      unwatch();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointermove', onHover);
      canvas.removeEventListener('keydown', onKey);
      disposeTree(scene);
      labelTex.dispose();
      tailTex.dispose();
      windingTex.dispose();
      renderer.dispose();
    },
  };
}

/* ==========================================================================
   Arranque automático
   ========================================================================== */

/**
 * Busca los canvas del documento y monta lo que corresponda.
 * Se puede llamar más de una vez sin duplicar escenas.
 */
export function initScenes(config = {}) {
  const mounted = [];
  const tier = qualityTier();

  const site = document.querySelector('[data-three="site"]');
  if (site && !site.dataset.mounted) {
    const scene = siteRibbon(site, {
      tier,
      ink: site.dataset.ink || config.ink,
      accent: site.dataset.accent || config.accent,
    });
    if (scene) {
      site.dataset.mounted = '1';
      mounted.push(scene);
    }
  }

  const roll = document.querySelector('[data-three="roll"]');
  if (roll && !roll.dataset.mounted) {
    const scene = labelRoll(roll, {
      tier,
      brand: roll.dataset.brand || config.brand,
      ink: roll.dataset.ink || config.ink,
      accent: roll.dataset.accent || config.accent,
    });
    if (scene) {
      roll.dataset.mounted = '1';
      mounted.push(scene);
    }
  }

  return {
    dispose() {
      mounted.forEach((s) => s.dispose());
    },
  };
}
