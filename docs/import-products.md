# Importar productos desde un JSON

El script `scripts/import-products.mjs` da de alta productos en EmDash a partir de un fichero JSON, usando la API REST. Sirve igual en local que en producción.

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
| `tipo` | No | `oficial` o `generico` (por defecto `generico`) |
| `edad_min` | No | Edad mínima recomendada |
| `resumen` | No | 1–2 frases para la tarjeta (máx. 200 caracteres) |
| `descripcion` | No | Texto largo; los párrafos se separan con una línea en blanco (`\n\n`) |
| `colecciones` | No | Slugs: `menos-de-10`, `de-10-a-20`, `de-20-a-40`, `lo-mas-viral`, `kawaii-para-adultos` |
| `categorias` | No | Slugs o nombres: `abrigos`, `moda`, `peluches`, `cosplay`, `gaming`, `cajas-sorpresa`, `squishy`, `papeleria`, `joyeria`, `maquillaje` |
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
npm run import -- productos.json --dry-run

# 2) Importar como borradores (para revisarlos en el panel)
npm run import -- productos.json

#    …o importar y publicar directamente
npm run import -- productos.json --publish
```

En producción:

```bash
export EMDASH_URL=https://admin.regaloskawaii.es
export EMDASH_TOKEN=ec_pat_…   # token creado en el panel con permisos de escritura de contenido y medios
npm run import -- productos.json --dry-run
npm run import -- productos.json --publish
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

Con `--on-conflict skip` no toca nada de lo que ya existe: solo crea lo que falta. No cambia el tipo de un campo ya creado (para eso, `scripts/fix-affiliate-link-field.mjs`).

### En producción: desde GitHub Actions

Los scripts no se ejecutan «dentro» de Cloudflare: son clientes de la API, así que basta con que corran en cualquier sitio con Node y el token. El workflow `.github/workflows/import.yml` lo hace solo:

1. En el panel de producción crea un token con permisos de escritura de contenido y medios.
2. En GitHub → Settings → Secrets and variables → Actions: variable `EMDASH_URL` = `https://admin.regaloskawaii.es` y secreto `EMDASH_TOKEN`.
3. Guarda el JSON (por ejemplo el del email diario) en `datos/`, haz commit y push. El workflow comprueba el fichero (`--dry-run`), importa lo nuevo como borrador y pone fotos a los que se quedaron sin ella. Si la comprobación falla, no se importa nada y GitHub te avisa por email.
4. Revisa los borradores en el panel y publícalos (eso dispara el build de la web).

También se puede lanzar a mano: Actions → «Import products» → Run workflow, con la ruta del fichero (`file`) y la opción de publicar directamente (`publish`).

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

## Limitaciones

- **No actualiza** productos existentes: si cambias el precio de uno ya importado, hazlo en el panel (o bórralo y vuelve a importarlo).
- **Campos nuevos del seed**: el seed solo se aplica a una base vacía. Si añades un campo al seed después (como `enlace_afiliado`), créalo también en el panel o el script te avisará antes de importar.
- Si un producto falla al crearse, su foto se borra para no dejar imágenes huérfanas.
- **Personajes y marcas** tienen que existir antes en el panel (Taxonomías). El script te dice cuáles faltan.
- Probado el 29/10/2026 con EmDash 1.3.1: crea el producto con su tienda, colecciones, personajes, imagen e idioma `es`, y detecta duplicados en una segunda ejecución.
