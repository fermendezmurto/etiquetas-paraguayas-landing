# Etiquetas Paraguayas — demo de diseño

Versión estática del rediseño de [etiquetasparaguayas.com.py](https://etiquetasparaguayas.com.py/),
publicada para que el cliente la revise y apruebe **antes** de tocar su WordPress
en producción.

> **Esto no es el sitio final.** El entregable es un tema WordPress a medida, que
> vive en un repositorio privado aparte. Esta página comparte con él exactamente
> el mismo CSS y el mismo JavaScript, así que lo que se ve acá es lo que se va a
> ver allá.

## Ver la demo

Publicada con GitHub Pages. Para levantarla localmente, sin instalar nada:

```bash
node serve.mjs
```

Queda en <http://localhost:4321>.

## Qué tiene

- **Escenas WebGL con three.js**, escritas a mano y autoalojadas (sin CDN):
  - *Encabezado* — la banda continua de etiquetas corriendo por la prensa
    flexográfica. Cintas con torsión real (frame de Frenet aproximado por
    diferencias finitas en el vertex shader) y el troquelado dibujado en el
    fragment shader, más polvo de tinta en suspensión.
  - *Rollo* — modelo 3D navegable con el mouse. La etiqueta impresa se genera
    por código en un `<canvas>`, así que cambia sola si cambian los colores de
    marca y no depende de ninguna imagen.
- Galería filtrable por rubro con visor ampliado.
- Animaciones de entrada al hacer scroll, contadores, línea de proceso animada.
- Modo oscuro por sección, no por preferencia del sistema: el diseño alterna
  bloques claros y oscuros a propósito.

## Cómo se comporta cuando no puede lucirse

Nada de lo anterior es obligatorio para que el sitio funcione:

| Situación | Qué pasa |
|---|---|
| `prefers-reduced-motion: reduce` | No se descarga three.js. Todas las transiciones se anulan. |
| Ahorro de datos o red 2G | No se descarga three.js. |
| ≤ 4 núcleos o pantalla angosta | Escenas en calidad reducida: menos cintas, menos partículas, menor `devicePixelRatio`. |
| Sin WebGL | El encabezado queda con su degradado de fondo. |
| Sin JavaScript | Todo el contenido es visible y navegable. Los reveals no ocultan nada porque el estado inicial se aplica sólo si el JS arrancó. |
| Pestaña en segundo plano o sección fuera de pantalla | El bucle de render se detiene. |

## Sobre el contenido

Los textos, teléfonos, dirección, email y nombres de marcas salen del sitio
actual del cliente. **Tres cifras del encabezado son estimaciones para la maqueta
y hay que confirmarlas antes de publicar:**

- «38+ presentaciones en catálogo» — es el conteo de productos listados hoy en
  la web, no necesariamente el catálogo real.
- «6 sectores industriales» — surge de agrupar los productos publicados.
- «100 % producción nacional» — a confirmar con la empresa.

Las imágenes son **placeholders generados por código** (`tools/genimg.mjs`), no
fotos reales de la planta ni artes de clientes. En el sitio final se reemplazan
por material propio de la empresa.

El logotipo es una marca provisoria; el oficial está en el sitio actual y debe
sustituirlo.

## Estructura

```
index.html                    una sola página, sin build step
assets/css/main.css           sistema de diseño completo (tokens + componentes)
assets/js/app.js              navegación, reveals, filtros, visor, contadores
assets/js/three-scenes.js     las dos escenas WebGL
assets/js/vendor/             three.js r185 (MIT), autoalojado
assets/img/                   placeholders SVG generados
serve.mjs                     servidor estático mínimo para desarrollo
tools/genimg.mjs              regenera los placeholders
```

No hay dependencias, ni bundler, ni paso de compilación.

---

Hecho por [Softshop](https://softshop.com.py/).
