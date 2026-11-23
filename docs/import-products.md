# Importar productos desde un JSON

El script `scripts/importar.mjs` (`npm run importar`) da de alta productos en EmDash a partir de un fichero JSON o de una búsqueda en AliExpress, usando la API REST. Completa cada producto de AliExpress con la API de afiliados (foto, enlace de afiliado, precio e historial) antes de guardarlo y lo crea ya con su prioridad: una sola escritura por producto. Sirve igual en local que en producción.

Para poner al día los productos que ya están en EmDash está `scripts/actualizar.mjs` (`npm run actualizar`, ver más abajo).

- Deduce la **tienda** y el **ID** (ASIN o product_id) a partir del enlace.
- Enlaza **colecciones**, **categorías**, **personajes** y **marcas** por su nombre o slug.
- Sube la **imagen**: la que indiques en `imagen` o, si no pones nada, busca sola `images/<ID>.webp|jpg|png|avif` (el ID es el de AliExpress, sacado del enlace). Las de Amazon nunca se suben.
- **Solo importa lo nuevo**: se salta los productos que ya existen (misma tienda e ID), los que están en la papelera del panel (si los borraste, no vuelven) y los repetidos dentro del mismo fichero. Esos no se validan, así que un error en un producto antiguo no bloquea la importación. Puedes ejecutarlo varias veces con el mismo fichero.
- **Valida todo antes de crear nada**: si hay un error en cualquier producto, no importa ninguno y te dice qué corregir.

## 1. Preparar el fichero

Una lista de productos (ver `docs/ejemplo-productos.json`):

```json
[
  {
    "nombre": "Llavero de peluche Kuromi",
    "enlace": "https://www.amazon.es/dp/B0C1234567?tag=regaloskawaii-21",
    "precio": 9.99,
    "tipo": "oficial",
    "edad_min": 6,
    "resumen": "Llavero suave de Kuromi para la mochila.",
    "colecciones": ["menos-de-10"],
    "personajes": ["Kuromi"],
    "marcas": ["Sanrio"],
    "imagen": "fotos/kuromi.jpg"
  }
]
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `nombre` | ✅ | Nombre del producto (escrito por ti, no copiado de la tienda) |
| `enlace` | ✅ | Enlace al producto. Amazon: el enlace largo de SiteStripe (`…/dp/ASIN…`). AliExpress: tu enlace de afiliado `s.click…` o `…/item/ID.html` |
| `id_externo` | Solo si el enlace no lo lleva | ASIN o product_id. Necesario con enlaces cortos (`amzn.to`, `s.click.aliexpress.com`) |
| `tienda` | No | Nombre de la tienda en EmDash («Amazon España», «AliExpress»). Se deduce del enlace; ponlo si usas enlaces cortos |
| `precio` | No | Precio de referencia en € |
| `tipo` | No | `oficial`, `generico` o `no-oficial`. **Por defecto:** `oficial` en Amazon, `generico` en el resto. Con `no-oficial` la web muestra el aviso de autenticidad, pero **sí** puede llevar personajes y marcas |
| `edad_min` | No | Edad mínima recomendada |
| `resumen` | No | 1–2 frases para la tarjeta (máx. 200 caracteres) |
| `descripcion` | No | Texto largo; los párrafos se separan con una línea en blanco (`\n\n`) |
| `colecciones` | No | Slugs: `menos-de-10`, `de-10-a-20`, `de-20-a-40`, `lo-mas-viral`, `kawaii-para-adultos` |
| `categorias` | No | Slugs o nombres. Primer nivel: `abrigos`, `moda`, `peluches`, `cosplay`, `gaming`, `cajas-sorpresa`, `squishy`, `papeleria`, `joyeria`, `maquillaje`, `hogar-cocina`, `accesorios`. Subcategorías (mejor la más concreta: el producto sale también en su categoría padre): moda › `sudaderas`, `camisetas`, `faldas`, `pijamas-kigurumis`; squishy › `squishy-comida`, `squishy-animales`, `squishy-gigantes`; papeleria › `pegatinas`, `boligrafos`, `libretas`, `libros`; hogar-cocina › `tazas`, `botellas`, `lamparas`; accesorios › `mochilas`, `llaveros`, `auriculares` |
| `personajes` / `marcas` | No | Nombres o slugs de términos que ya existan en el panel (Kuromi, Sanrio…) |
| `imagen` | No | Ruta a la foto, relativa al JSON (jpg, png, webp, avif). Si no la pones, se busca `images/<ID>.*`. No se admite en productos de Amazon |
| `fuente_imagen` | No | `propia` o `marca` (si hay imagen, por defecto `propia`) |
| `destacado`, `para_grabar` | No | `true` / `false` |
| `notas` | No | Notas internas (no salen en la web) |
| `enlace_afiliado` | No | Fuerza un enlace concreto. En Amazon no hace falta: la web monta el enlace con tu tag |

> **No uses imágenes copiadas de Amazon**: solo fotos tuyas o de la marca con permiso.

## 2. Ejecutar

En local, con `npm run dev` arrancado:

```bash
# Token de desarrollo (solo funciona en local)
export EMDASH_TOKEN=$(curl -s -X POST "http://localhost:4321/_emdash/api/setup/dev-bypass?token=1" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')

# 1) Comprobar sin crear nada
npm run importar -- productos.json --dry-run

# 2) Importar como borradores (para revisarlos en el panel)
npm run importar -- productos.json

#    …o importar y publicar directamente
npm run importar -- productos.json --publish
```

En producción:

```bash
export EMDASH_URL=https://admin.regaloskawaii.es
export EMDASH_TOKEN=ec_pat_…   # token creado en el panel con permisos de escritura de contenido y medios
npm run importar -- productos.json --dry-run
npm run importar -- productos.json --publish
```

> El token de importación necesita permisos de **escritura**. No uses el token de solo lectura de la web, ni guardes este token en el repo.

### Fotos sin escribir rutas

Guarda cada foto en `images/` con el ID del producto como nombre (`images/1005007345370415.webp`) y no pongas `imagen` en el JSON: el script la encuentra solo. Otra carpeta: `--images=fotos`.

### Añadir al panel lo nuevo del seed

El seed solo se aplica entero a una base vacía. Para añadir a una base que ya tiene datos lo que falte (una taxonomía nueva, sus términos, un campo), con `npm run dev` **parado**:

```bash
# En local (base D1 de wrangler)
DB=$(ls .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite | grep -v metadata)
npx emdash seed -d "$DB" --on-conflict skip seed/seed.json
```

Con `--on-conflict skip` no toca nada de lo que ya existe: solo crea lo que falta. No cambia el tipo de un campo ya creado (hay que corregirlo en el panel o en el seed).

### En producción: desde GitHub Actions

Los scripts no se ejecutan «dentro» de Cloudflare: son clientes de la API, así que basta con que corran en cualquier sitio con Node y el token. El workflow `.github/workflows/import.yml` lo hace solo:

1. En el panel de producción crea un token con permisos de escritura de contenido y medios.
2. En GitHub → Settings → Secrets and variables → Actions: variable `EMDASH_URL` = `https://admin.regaloskawaii.es` y secretos `EMDASH_TOKEN`, `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET` y `ALIEXPRESS_TRACKING_ID` (los mismos valores que tu `.env`).
3. El workflow **Import products** (`import.yml`) se lanza:
   - cada lunes a las 07:13 UTC: busca con `busquedas/palabras.csv`, importa y publica lo nuevo y guarda el JSON en `datos/`;
   - al hacer push de un JSON nuevo o modificado en `datos/`: importa y publica ese fichero;
   - a mano: Actions → «Import products» → Run workflow (con `file` vacío busca; con `dry_run` solo simula).
4. El workflow **Update products** (`actualizar.yml`) ejecuta `actualizar.mjs` cada día a las 03:41 UTC (o a mano).

### Fotos sin fondo (IA)

Para que todas las fichas tengan el mismo estilo (producto recortado sobre fondo transparente):

- Al importar: añade `--remove-bg` a `npm run importar`.
- Para las que ya están subidas: `node scripts/remove-backgrounds.mjs --dry-run` y luego sin `--dry-run` (`--limit=5` para probar con pocas).

Usa el modelo ISNet (licencia Apache-2.0) en tu ordenador: gratis y sin enviar las fotos a ningún servicio. La primera vez descarga el modelo (~170 MB) en `~/.cache/regaloskawaii/`. Con `REMOVE_BG_MODEL=u2netp` usa uno de 5 MB, más rápido y algo peor. Necesita `npm install -D onnxruntime-node sharp`.

Nunca se aplica a productos de Amazon (sus fotos no se pueden alojar ni modificar). Si un recorte sale mal, el script lo marca con «← revisar» y la foto original sigue en Medios.

## 3. Salida

```
EmDash: http://localhost:4321
✓ #1 «Llavero de peluche Kuromi»: creado /producto/llavero-de-peluche-kuromi (publicado)
↷ #2 «Set de 6 bolígrafos de gel pastel»: ya existe, se salta
Creados: 1 · Ya existían: 1
```

Si algo está mal, no se crea nada:

```
✗ 1 producto(s) con errores; no se ha importado nada:
  - #1 «X»: los enlaces cortos (amzn.to) no incluyen el ASIN; añade "id_externo" o usa el enlace largo
  - #1 «X»: no existe la colección "navidad" (existen: menos-de-10, …)
```

El campo `priority` (0–2) viene en `seed/seed.json`; en bases antiguas créalo en el panel si falta.

## Categorías automáticas

Si un producto del JSON no trae `categorias`, el importador la deduce de su nombre (y de las `notas`, donde va la palabra de búsqueda) con `scripts/lib/clasificar.mjs`. A toda subcategoría le añade su categoría padre, como en el panel (`pegatinas` → `papeleria` + `pegatinas`). En el `--dry-run` verás cada producto con su categoría, marcada «(auto)» cuando la ha deducido; los que no encajan en ninguna salen como «[sin categoría]» y se cuentan al final. `--sin-clasificar` lo desactiva.

## Buscar productos por palabras clave (AliExpress)

Con `--buscar`, `importar.mjs` busca primero en la API de afiliados de AliExpress las palabras de un CSV (`scripts/lib/buscar.mjs`), guarda lo encontrado en `datos/busqueda-AAAA-MM-DD.json` (otra ruta: `--out=`) y lo importa.

```bash
npm run importar -- --buscar --publish --dry-run          # usa busquedas/palabras.csv
npm run importar -- --buscar=busquedas/squishy.csv --publish
```

CSV: `palabra,categoria,cantidad,precio_min,precio_max` (solo `palabra` es obligatoria; sin categoría, cada producto se clasifica por su nombre). Es el `busquedas/palabras.csv` que usa cada lunes el workflow «Import products»: cambia las palabras y haz push. También acepta el CSV del Planificador de palabras clave de Google Ads, con `--categoria=slug`.

Filtros por defecto: con foto, de 5 € (siempre) a 40 €, al menos 20 ventas en 30 días, 90 % de valoraciones positivas y sin personajes ni marcas registradas en el título (`--permitir-marcas` lo desactiva). Se saltan los productos que ya están en EmDash, en su papelera o en algún JSON de `datos/`. Los nombres vienen de la traducción automática de AliExpress.

## Poner al día los productos existentes: `actualizar.mjs`

`npm run actualizar` (o el workflow diario «Update products») revisa los productos **publicados** de AliExpress con la API de afiliados (una llamada por cada 20) y hace un solo `PUT` por producto, solo si algo cambia:

- precio, historial de precios y fecha de consulta (descuentos legales: ver arriba);
- enlace de afiliado, si falta o no es `s.click.aliexpress.com`;
- foto, si no tiene;
- prioridad (2 oficial, 1 con foto y enlace de afiliado, 0 el resto).

Los que la API ya no devuelve (retirados, fuera del programa o sin venta en España) se **despublican** y se apunta en sus notas («[despublicado por actualizar …]»). Si en otra revisión vuelven a aparecer, se republican y se quita la nota. Si la API no devuelve más del 40 % de los productos, se supone un fallo de la API y no se despublica nada.

Los productos de Amazon no se tocan. Con `--dry-run` solo muestra lo que haría.

## Limitaciones

- **No actualiza** productos existentes: eso lo hace `actualizar.mjs`.
- **Campos nuevos del seed**: el seed solo se aplica a una base vacía. Si añades un campo al seed después (como `enlace_afiliado`), créalo también en el panel o el script te avisará antes de importar.
- Si un producto falla al crearse, su foto se borra para no dejar imágenes huérfanas.
- **Personajes y marcas** tienen que existir antes en el panel (Taxonomías). El script te dice cuáles faltan.
- Probado el 29/10/2026 con EmDash 1.3.1: crea el producto con su tienda, colecciones, personajes, imagen e idioma `es`, y detecta duplicados en una segunda ejecución.

## Categorías y subcategorías

La jerarquía de categorías está en `seed/seed.json`. Asigna categorías en el JSON de import (`categorias`) o en el panel.
