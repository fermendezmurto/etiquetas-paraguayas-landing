import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });

// PRNG determinista para que regenerar no cambie los archivos.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- Fondos de sector: textura industrial abstracta ---------- */
function sectorSvg({ id, title, hue, accent, seed }) {
  const r = rng(seed);
  const W = 900, H = 1100;
  let shapes = '';

  // Bandas diagonales tipo material en movimiento
  for (let i = 0; i < 14; i++) {
    const y = -200 + i * 110 + r() * 40;
    const op = (0.03 + r() * 0.08).toFixed(3);
    shapes += `<rect x="-200" y="${y.toFixed(0)}" width="1400" height="${(28 + r() * 46).toFixed(0)}" fill="#fff" opacity="${op}" transform="rotate(-18 450 550)"/>`;
  }

  // Troqueles flotando
  for (let i = 0; i < 9; i++) {
    const w = 120 + r() * 190;
    const h = w * (0.5 + r() * 0.25);
    const x = r() * (W - w);
    const y = r() * (H - h);
    const rot = (r() * 30 - 15).toFixed(1);
    const op = (0.06 + r() * 0.14).toFixed(3);
    shapes += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="${(h * 0.14).toFixed(0)}" fill="${accent}" opacity="${op}" transform="rotate(${rot} ${(x + w / 2).toFixed(0)} ${(y + h / 2).toFixed(0)})"/>`;
  }

  // Retícula de registro
  let grid = '';
  for (let x = 0; x <= W; x += 60) grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#9fc4e8" stroke-width="1" opacity="0.05"/>`;
  for (let y = 0; y <= H; y += 60) grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#9fc4e8" stroke-width="1" opacity="0.05"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${hue}"/><stop offset="1" stop-color="#04101f"/>
</linearGradient>
<radialGradient id="v" cx="0.3" cy="0.2" r="0.9">
<stop offset="0" stop-color="${accent}" stop-opacity="0.28"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
${grid}
${shapes}
<rect width="${W}" height="${H}" fill="url(#v)"/>
</svg>`;
}

/* ---------- Mockups de etiqueta para la galería ---------- */
function labelSvg({ id, brand, kind, ink, accent, paper, seed }) {
  const r = rng(seed);
  const W = 800, H = 1000;

  // Bloque impreso principal
  const barW = [];
  let bx = 90;
  for (let i = 0; i < 30; i++) {
    const w = 3 + Math.floor(r() * 8);
    if (i % 2 === 0) barW.push([bx, w]);
    bx += w + 3;
  }
  const bars = barW.map(([x, w]) => `<rect x="${x}" y="${H - 190}" width="${w}" height="70" fill="${ink}"/>`).join('');

  const lines = [0, 1, 2, 3]
    .map((i) => `<rect x="90" y="${560 + i * 34}" width="${(180 + r() * 380).toFixed(0)}" height="12" rx="6" fill="${ink}" opacity="${(0.2 + r() * 0.3).toFixed(2)}"/>`)
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Etiqueta ${esc(brand)} — ${esc(kind)}">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
<stop offset="0" stop-color="#0b2340"/><stop offset="1" stop-color="#04101f"/>
</linearGradient>
<linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#fff" stop-opacity="0.30"/>
<stop offset="0.45" stop-color="#fff" stop-opacity="0.03"/>
<stop offset="1" stop-color="#fff" stop-opacity="0.16"/>
</linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
<feDropShadow dx="0" dy="26" stdDeviation="30" flood-color="#000" flood-opacity="0.55"/>
</filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<g filter="url(#sh)">
<rect x="60" y="110" width="${W - 120}" height="${H - 260}" rx="34" fill="${paper}"/>
<rect x="60" y="110" width="${W - 120}" height="150" rx="34" fill="${ink}"/>
<rect x="60" y="220" width="${W - 120}" height="40" fill="${ink}"/>
<rect x="60" y="256" width="${W - 120}" height="14" fill="${accent}"/>
<text x="90" y="196" font-family="Sora, Montserrat, sans-serif" font-size="58" font-weight="700" fill="${paper}">${esc(brand)}</text>
<text x="90" y="360" font-family="ui-monospace, monospace" font-size="26" letter-spacing="6" fill="${accent}">${esc(kind.toUpperCase())}</text>
<circle cx="${W - 175}" cy="470" r="82" fill="none" stroke="${accent}" stroke-width="9"/>
<circle cx="${W - 175}" cy="470" r="54" fill="${ink}" opacity="0.12"/>
${lines}
${bars}
<rect x="60" y="110" width="${W - 120}" height="${H - 260}" rx="34" fill="url(#sheen)" opacity="0.5"/>
</g>
</svg>`;
}

const sectors = [
  { id: 'sector-frigorifico', title: 'Frigoríficos y cárnicos', hue: '#12305c', accent: '#a6ce39', seed: 11 },
  { id: 'sector-farmaceutica', title: 'Industria farmacéutica', hue: '#173a63', accent: '#45b6d8', seed: 22 },
  { id: 'sector-domisanitarios', title: 'Domisanitarios', hue: '#0f2b50', accent: '#b9dd53', seed: 33 },
  { id: 'sector-bebidas', title: 'Bebidas y licores', hue: '#1b3b6f', accent: '#a6ce39', seed: 44 },
  { id: 'sector-lacteos', title: 'Lácteos y derivados', hue: '#14335a', accent: '#7fd8e8', seed: 55 },
  { id: 'sector-agro', title: 'Agroquímicos', hue: '#0d2747', accent: '#b9dd53', seed: 66 },
  { id: 'planta', title: 'Planta de producción', hue: '#12305c', accent: '#a6ce39', seed: 77 },
  { id: 'prensa', title: 'Prensa flexográfica', hue: '#0b2340', accent: '#45b6d8', seed: 88 },
];

const labels = [
  { id: 'w-angus', brand: 'Angus', kind: 'Cárnicos', cat: 'carnicos', seed: 101 },
  { id: 'w-beefclub', brand: 'Beef Club', kind: 'Envasado al vacío', cat: 'carnicos', seed: 102 },
  { id: 'w-hereford', brand: 'Hereford', kind: 'Exportación', cat: 'carnicos', seed: 103 },
  { id: 'w-coop', brand: 'Co-op', kind: 'Lácteos', cat: 'lacteos', seed: 104 },
  { id: 'w-campella', brand: 'Campella', kind: 'Quesos', cat: 'lacteos', seed: 105 },
  { id: 'w-fortin', brand: 'Fortín', kind: 'Ron', cat: 'bebidas', seed: 106 },
  { id: 'w-donvicente', brand: 'Don Vicente', kind: 'Cerveza artesanal', cat: 'bebidas', seed: 107 },
  { id: 'w-naturel', brand: 'Naturel', kind: 'Agua mineral', cat: 'bebidas', seed: 108 },
  { id: 'w-frutika', brand: 'Frutika', kind: 'Salsas', cat: 'alimentos', seed: 109 },
  { id: 'w-catedral', brand: 'Catedral', kind: 'Farmacéutica', cat: 'farma', seed: 110 },
  { id: 'w-carey', brand: 'Carey', kind: 'Cosmética', cat: 'farma', seed: 111 },
  { id: 'w-tecnomyl', brand: 'Tecnomyl', kind: 'Agroquímicos', cat: 'agro', seed: 112 },
];

const palettes = [
  { ink: '#12305c', accent: '#a6ce39', paper: '#f4f7fa' },
  { ink: '#0d2747', accent: '#45b6d8', paper: '#eef3f8' },
  { ink: '#1b3b6f', accent: '#b9dd53', paper: '#f7f9fb' },
];

sectors.forEach((s) => writeFileSync(`${OUT}/${s.id}.svg`, sectorSvg(s)));
labels.forEach((l, i) =>
  writeFileSync(`${OUT}/${l.id}.svg`, labelSvg({ ...l, ...palettes[i % palettes.length] }))
);

console.log(`Generados ${sectors.length + labels.length} SVG en ${OUT}`);
console.log(JSON.stringify(labels.map((l) => ({ id: l.id, brand: l.brand, kind: l.kind, cat: l.cat }))));
