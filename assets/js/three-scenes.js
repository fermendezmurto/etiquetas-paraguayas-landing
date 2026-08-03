/**
 * Etiquetas Paraguayas — escenas WebGL
 * ---------------------------------------------------------------------------
 * Dos escenas independientes, cada una autocontenida y perezosa:
 *
 *  1. heroRibbons()  — la banda continua de etiquetas corriendo por la prensa
 *                      flexográfica. Cintas con torsión real (frame de Frenet
 *                      aproximado por diferencias finitas) + troquelado dibujado
 *                      en el fragment shader + polvo de tinta en suspensión.
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
   Escena 1 — Banda de etiquetas (hero)
   ========================================================================== */

const RIBBON_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uLen;
  uniform float uWidth;
  uniform float uAmpY;
  uniform float uAmpZ;
  uniform float uFreq;
  uniform float uSpeed;
  uniform float uPhase;
  uniform float uTwist;

  varying vec2  vUv;
  varying float vFresnel;
  varying float vShade;

  // Trayectoria del sustrato: dos senoidales desfasadas por eje para que la
  // banda nunca se lea como una onda plana.
  vec3 curve(float u) {
    float a = u * uFreq + uTime * uSpeed + uPhase;
    float y = uAmpY * sin(a) + uAmpY * 0.38 * sin(a * 2.13 + uTime * 0.55);
    float z = uAmpZ * cos(a * 0.82 + uPhase * 1.7)
            + uAmpZ * 0.30 * sin(a * 1.90 - uTime * 0.42);
    return vec3((u - 0.5) * uLen, y, z);
  }

  void main() {
    vUv = uv;

    float u = uv.x;
    float v = uv.y - 0.5;

    // Frame local por diferencias finitas (evita subir una curva a la CPU).
    const float du = 0.0025;
    vec3 p0 = curve(u);
    vec3 p1 = curve(u + du);
    vec3 tangent = normalize(p1 - p0);

    vec3 binormal = normalize(cross(tangent, vec3(0.0, 1.0, 0.0)));
    vec3 normalV  = normalize(cross(binormal, tangent));

    // Torsión: la banda gira sobre su propio eje, como al salir del rodillo.
    float twist = uTwist * sin(u * 3.1 + uTime * 0.35 + uPhase);
    vec3 across = binormal * cos(twist) + normalV * sin(twist);

    vec3 pos = p0 + across * (v * uWidth);
    vec3 nrm = normalize(cross(tangent, across));

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    vec3 nrmView = normalize(normalMatrix * nrm);
    vec3 viewDir = normalize(-mvPosition.xyz);

    // El canto de la cinta se enciende; la cara plana se apaga.
    vFresnel = pow(1.0 - abs(dot(nrmView, viewDir)), 2.2);
    vShade   = abs(dot(nrmView, normalize(vec3(0.4, 0.8, 0.6)))) * 0.75 + 0.25;

    gl_Position = projectionMatrix * mvPosition;
  }
`;

const RIBBON_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorEdge;
  uniform float uOpacity;
  uniform float uCells;
  uniform float uTime;

  varying vec2  vUv;
  varying float vFresnel;
  varying float vShade;

  // Rectángulo con bordes suaves. El parámetro se llama halfSize y no half:
  // "half" es palabra reservada en GLSL ES y el shader no compilaría.
  float roundedRect(vec2 p, vec2 halfSize, float r, float soft) {
    vec2 d = abs(p) - halfSize + r;
    float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    return 1.0 - smoothstep(-soft, soft, dist);
  }

  void main() {
    // Repetición del troquel a lo largo de la banda.
    float cellF  = vUv.x * uCells;
    float cellId = floor(cellF);
    vec2  cellUv = vec2(fract(cellF), vUv.y) - 0.5;

    // Cuerpo de la etiqueta y área impresa interior.
    float body  = roundedRect(cellUv, vec2(0.44, 0.40), 0.10, 0.012);
    float print = roundedRect(cellUv, vec2(0.30, 0.24), 0.06, 0.010);

    // Franja de color que recorre la bobina.
    float sweep = sin(vUv.x * 5.0 - uTime * 0.55 + cellId * 0.35) * 0.5 + 0.5;
    vec3  base  = mix(uColorA, uColorB, sweep);

    // La zona impresa levanta el tono; el resto queda como sustrato.
    vec3 color = mix(base * 0.55, base, body);
    color = mix(color, color + uColorEdge * 0.35, print * 0.6);

    // Sombreado del frame + canto encendido.
    color *= vShade;
    color += uColorEdge * vFresnel * 0.85;

    // Desvanecido en los extremos: la cinta entra y sale de cuadro.
    float fadeX = smoothstep(0.0, 0.13, vUv.x) * smoothstep(1.0, 0.87, vUv.x);
    float fadeY = smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);

    float alpha = uOpacity * fadeX * fadeY * (0.30 + body * 0.70 + vFresnel * 0.45);

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
    // Deriva lenta, cada partícula con su propia fase.
    p.x += sin(uTime * 0.14 + aSeed * 6.28) * 1.4;
    p.y += cos(uTime * 0.11 + aSeed * 4.71) * 1.0;
    p.z += sin(uTime * 0.09 + aSeed * 2.35) * 0.8;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uPixelRatio * (34.0 / max(-mv.z, 0.001));

    // Se apagan con la distancia para dar profundidad.
    vAlpha = smoothstep(46.0, 8.0, -mv.z) * (0.25 + aSeed * 0.55);
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
 * Monta la escena del hero sobre un <canvas>.
 * @returns {{dispose: () => void} | null}
 */
export function heroRibbons(canvas, options = {}) {
  if (!canvas || !supportsWebGL() || prefersReducedMotion()) return null;

  const tier = options.tier || qualityTier();
  if (tier === 'off') return null;

  const LOW = tier === 'low';
  const segments = LOW ? 120 : 260;
  const dustCount = LOW ? 120 : 340;
  const maxDpr = LOW ? 1.5 : 2;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !LOW,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(PALETTE.navyDeep, 0.026);

  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 120);
  camera.position.set(0, 0.4, 15);

  /* --- Cintas ------------------------------------------------------------ */

  const ribbonSpecs = [
    { y:  1.6, z: -3.0, len: 40, width: 3.0, ampY: 1.5, ampZ: 2.4, freq: 3.4,
      speed: 0.30, phase: 0.0,  twist: 0.65, cells: 13, opacity: 0.95,
      a: PALETTE.lime,      b: PALETTE.navyLight, edge: PALETTE.limeBright, rot: -0.10 },
    { y: -1.9, z: -6.5, len: 52, width: 3.8, ampY: 2.1, ampZ: 3.0, freq: 2.6,
      speed: 0.22, phase: 2.1,  twist: 0.85, cells: 15, opacity: 0.62,
      a: PALETTE.navyLight, b: PALETTE.cyan,      edge: PALETTE.cyan,       rot: 0.13 },
    { y:  4.4, z: -11.0, len: 66, width: 4.6, ampY: 2.6, ampZ: 3.6, freq: 2.0,
      speed: 0.16, phase: 4.3,  twist: 1.05, cells: 17, opacity: 0.30,
      a: PALETTE.navy,      b: PALETTE.navyLight, edge: PALETTE.navyLight,  rot: -0.20 },
    { y: -5.2, z: -14.5, len: 78, width: 5.2, ampY: 3.0, ampZ: 4.0, freq: 1.7,
      speed: 0.12, phase: 5.9,  twist: 1.15, cells: 19, opacity: 0.18,
      a: PALETTE.navy,      b: PALETTE.lime,      edge: PALETTE.lime,       rot: 0.24 },
  ];

  const ribbons = ribbonSpecs.slice(0, LOW ? 2 : 4).map((spec) => {
    const geometry = new THREE.PlaneGeometry(1, 1, segments, 1);
    const material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: {
        uTime:      { value: 0 },
        uLen:       { value: spec.len },
        uWidth:     { value: spec.width },
        uAmpY:      { value: spec.ampY },
        uAmpZ:      { value: spec.ampZ },
        uFreq:      { value: spec.freq },
        uSpeed:     { value: spec.speed },
        uPhase:     { value: spec.phase },
        uTwist:     { value: spec.twist },
        uCells:     { value: spec.cells },
        uOpacity:   { value: spec.opacity },
        uColorA:    { value: new THREE.Color(spec.a) },
        uColorB:    { value: new THREE.Color(spec.b) },
        uColorEdge: { value: new THREE.Color(spec.edge) },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, spec.y, spec.z);
    mesh.rotation.z = spec.rot;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, material };
  });

  /* --- Polvo de tinta ---------------------------------------------------- */

  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(dustCount * 3);
  const dustScale = new Float32Array(dustCount);
  const dustSeed = new Float32Array(dustCount);

  for (let i = 0; i < dustCount; i += 1) {
    dustPos[i * 3] = (Math.random() - 0.5) * 46;
    dustPos[i * 3 + 1] = (Math.random() - 0.5) * 24;
    dustPos[i * 3 + 2] = -Math.random() * 26 + 4;
    dustScale[i] = 0.6 + Math.random() * 2.1;
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

  /* --- Parallax de cámara ------------------------------------------------ */

  const pointer = new THREE.Vector2(0, 0);
  const pointerTarget = new THREE.Vector2(0, 0);
  let scrollFactor = 0;

  const onPointerMove = (e) => {
    pointerTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointerTarget.y = (e.clientY / window.innerHeight) * 2 - 1;
  };

  const onScroll = () => {
    const rect = canvas.getBoundingClientRect();
    const h = rect.height || 1;
    scrollFactor = THREE.MathUtils.clamp(-rect.top / h, 0, 1);
  };

  // El parallax por puntero sólo tiene sentido con mouse/trackpad.
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (finePointer) window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const unwatch = watchSize(canvas, renderer, camera, () => {
    dustMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  });

  const loop = createLoop(canvas, (delta, elapsed) => {
    pointer.x += (pointerTarget.x - pointer.x) * Math.min(1, delta * 2.4);
    pointer.y += (pointerTarget.y - pointer.y) * Math.min(1, delta * 2.4);

    ribbons.forEach(({ material }) => {
      material.uniforms.uTime.value = elapsed;
    });
    dustMat.uniforms.uTime.value = elapsed;

    camera.position.x = pointer.x * 1.5;
    camera.position.y = 0.4 - pointer.y * 0.9 - scrollFactor * 2.2;
    camera.position.z = 15 + scrollFactor * 3.5;
    camera.lookAt(0, -scrollFactor * 1.2, -4);

    dust.rotation.y = elapsed * 0.012;

    renderer.render(scene, camera);
  });

  // Un frame inmediato para que el fundido de entrada no muestre el canvas vacío.
  renderer.render(scene, camera);
  canvas.classList.add('is-ready');
  loop.start();

  return {
    dispose() {
      loop.dispose();
      unwatch();
      if (finePointer) window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('scroll', onScroll);
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
  camera.position.set(0, 1.15, 6.4);
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

  const hero = document.querySelector('[data-three="hero"]');
  if (hero && !hero.dataset.mounted) {
    const scene = heroRibbons(hero, { tier });
    if (scene) {
      hero.dataset.mounted = '1';
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
