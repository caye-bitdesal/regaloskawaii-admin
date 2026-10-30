# API de EmDash para la web de Regalos Kawaii

Contrato entre el backend (`regaloskawaii-admin`, EmDash 1.3.1) y la web estática (`regaloskawaii-web`, Astro `output: "static"`).

Los JSON de esta carpeta son **respuestas reales** capturadas el 28/10/2026 contra EmDash 1.3.1 con el `seed/seed.json` del proyecto y un **token de solo lectura** (`content:read`, `media:read`). Los productos son de ejemplo.

## Conexión

- **Base URL**: variable `EMDASH_URL` (local: `http://localhost:4321`; producción: `https://admin.regaloskawaii.es`).
- **Autenticación**: cabecera `Authorization: Bearer ${EMDASH_TOKEN}`. Sin token la API de contenido responde `401 NOT_AUTHENTICATED`.
- **Formato**: todas las respuestas son `{ "success": true, "data": … }` o `{ "success": false, "error": { "code", "message" } }`.
- La API solo se usa **al construir** la web (en `getStaticPaths` / frontmatter). El token **nunca** debe llegar al HTML ni al navegador.

## Reglas importantes (comprobadas)

1. **Pasar siempre `?status=published` en los listados.** Si el token pertenece a un usuario con rol de administrador, sin ese filtro la API devuelve también borradores.
2. **Construir con los listados, no con el detalle.** Con `status=published`, el listado devuelve la versión publicada. El detalle (`/content/{tipo}/{id}`) puede devolver un borrador pendiente si el token es de un administrador.
3. **Recomendado en producción**: crear un usuario «web-build» con rol mínimo (suscriptor) y generar el token desde él, además de la regla 1.
4. **Booleanos llegan como `0`/`1`**, no `true`/`false` (`destacado`, `para_grabar`, `destacada`, `activa`). Convertir con `Boolean(x)`.
5. **Los campos de relación no vienen en `data`.** `tienda` y `colecciones` se piden aparte (ver «Relaciones»).
6. **Las imágenes no traen URL directa.** Se construye con `meta.storageKey`: `${EMDASH_URL}/_emdash/api/media/file/${imagen.meta.storageKey}`. Esa ruta es **pública** (no necesita token).
7. **No publicar nunca `notas`** (notas internas) ni `para_grabar`: vienen en la API pero son de uso interno.
8. **Paginación**: `limit` (1–100, por defecto 50) y `cursor`. Si la respuesta trae `data.nextCursor`, hay más páginas: repetir con `&cursor=${nextCursor}`.

## Endpoints

| # | Fichero de ejemplo | Petición | Para qué |
|---|---|---|---|
| 1 | `01-productos-lista.json` | `GET /_emdash/api/content/productos?status=published&limit=100` | Todos los productos publicados (con paginación) |
| 2 | `02-producto-detalle.json` | `GET /_emdash/api/content/productos/{id}` | Detalle (no usar para construir: ver regla 2) |
| 3 | `03-producto-tienda.json` | `GET /_emdash/api/content/productos/{id}/references/productos_tienda/children` | Tienda de un producto |
| 4 | `04-producto-colecciones.json` | `GET /_emdash/api/content/productos/{id}/references/productos_colecciones/children` | Colecciones de un producto |
| 5 | `05-producto-personajes.json` | `GET /_emdash/api/content/productos/{id}/terms/personaje` | Personajes de un producto |
| 6 | `06-producto-marcas.json` | `GET /_emdash/api/content/productos/{id}/terms/marca` | Marcas de un producto |
| 6b | — | `GET /_emdash/api/content/productos/{id}/terms/categoria` | Categorías de un producto (misma forma que 5 y 6). La API no tiene un filtro «productos de una categoría»: hay que pedirlo por producto |
| 7 | `07-colecciones-lista.json` | `GET /_emdash/api/content/colecciones?status=published` | Colecciones publicadas |
| 8 | `08-coleccion-productos.json` | `GET /_emdash/api/content/colecciones/{id}/references/productos_colecciones/parents?limit=100` | Productos de una colección (**recomendado** para montar la relación: 1 llamada por colección en vez de 1 por producto) |
| 9 | `09-tiendas-lista.json` | `GET /_emdash/api/content/tiendas?status=published` | Tiendas y plantillas de enlace |
| 10 | `10-paginas-lista.json` | `GET /_emdash/api/content/pages?status=published` | Páginas fijas (aviso de afiliados…) |
| 11 | `11-taxonomias.json` | `GET /_emdash/api/taxonomies` | Taxonomías (`categoria`, `personaje`, `marca`; si aparecen `category` y `tag`, son de EmDash: ignorarlas) |
| 12 | `12-personajes-terminos.json` | `GET /_emdash/api/taxonomies/personaje/terms` | Términos con `count` (nº de productos). Igual para `categoria` y `marca` |
| 13 | `13-menu-principal.json` | `GET /_emdash/api/menus/primary` | Menú principal (`items[].customUrl`, `label`, `sortOrder`) |
| 14 | — | `GET /_emdash/api/settings` | **No accesible** con este token (`INSUFFICIENT_SCOPE`). Poner título y lema en la configuración de la web |
| 15 | `15-media-detalle.json` | `GET /_emdash/api/media/{id}` | Metadatos de una imagen (no suele hacer falta) |

Las rutas de taxonomía de un término concreto: `GET /_emdash/api/taxonomies/{nombre}/terms/{slug}`.

## Modelo de datos

### Producto (`productos`) — `items[]` del listado

```ts
interface Producto {
  id: string;                 // ULID
  slug: string;               // URL: /producto/{slug}
  status: "published";
  publishedAt: string | null; updatedAt: string;
  seo: { title: string|null; description: string|null; image: string|null; canonical: string|null; noIndex: boolean };
  data: {
    title: string;
    resumen?: string;                    // 1–2 frases para tarjetas
    descripcion?: PortableTextBlock[];   // texto enriquecido (Portable Text)
    id_externo: string;                  // ASIN en Amazon, product_id en AliExpress
    enlace_afiliado?: string;            // si existe, usarlo tal cual (p. ej. s.click de AliExpress)
    precio_ref?: number;                 // € orientativo (no mostrar como precio exacto)
    precio_actualizado?: string;         // fecha ISO
    imagen?: Imagen;
    galeria?: { imagen: Imagen }[];
    fuente_imagen?: "propia" | "marca";
    tipo: "oficial" | "generico";
    edad_min?: number;
    destacado: 0 | 1;
    para_grabar: 0 | 1;                  // interno, no publicar
    notas?: string;                      // interno, no publicar
  };
}

interface Imagen {
  id: string; provider: "local"; filename: string; mimeType: string;
  width: number; height: number; alt?: string;
  blurhash?: string; dominantColor?: string;   // útiles para placeholders
  meta: { storageKey: string; caption: string|null; blurhash?: string; dominantColor?: string };
}
```

### Colección (`colecciones`)

`data`: `title`, `descripcion?` (texto plano), `imagen?` (Imagen), `orden` (número, ordenar ascendente), `destacada` (0/1, mostrar en portada). URL: `/coleccion/{slug}`.

### Tienda (`tiendas`)

`data`: `title`, `plantilla_url` (p. ej. `https://www.amazon.es/dp/{id}?tag={tag}`), `tag_web`, `tag_telegram`, `tag_tiktok`, `activa` (0/1). Sin slug (no tiene página).

**Enlace de afiliado** de un producto en la web (si el producto trae `enlace_afiliado`, se usa ese; si no, la plantilla de su tienda):

```ts
const url = producto.data.enlace_afiliado || tienda.data.plantilla_url
  .replace("{id}", encodeURIComponent(producto.data.id_externo))
  .replace("{tag}", encodeURIComponent(tienda.data.tag_web));
// <a href={url} rel="sponsored nofollow noopener" target="_blank">Ver en Amazon</a>
```

### Página (`pages`)

`data`: `title`, `content` (Portable Text). URL: `/{slug}`. La página `aviso-afiliados` es obligatoria (enlazarla en el pie de todas las páginas).

### Relaciones

Las referencias `children`/`parents` devuelven entradas resumidas:

```json
{ "id": "…", "slug": "menos-de-10", "collection": "colecciones", "title": "…", "locale": "es", "sortOrder": 0 }
```

Para montar los datos al construir (eficiente):

1. Listar productos, colecciones y tiendas publicados (3 listados con paginación).
2. Por cada colección: `…/references/productos_colecciones/parents?limit=100` → mapa colección → productos. **Pagina**: si la respuesta trae `nextCursor`, repite con `&cursor=…` (sin `limit` devuelve menos de 50).
2b. Por cada producto: `…/productos/{id}/terms/categoria` → mapa producto → categorías (1 llamada por producto; con 100–200 productos son segundos y solo pasa al construir).
3. Tienda: por ahora solo hay una (Amazon España). Si hay más, pedir `…/productos_tienda/children` por producto.
4. Personajes y marcas: `…/terms/{taxonomía}` por producto (o solo cuando se necesiten páginas por personaje).
5. Con esos mapas se generan todas las páginas: categoría = productos con esa categoría; colección = productos de esa colección; categoría + colección = la intersección de las dos (filtro en el navegador sobre la página de la categoría).

### Portable Text

`descripcion` y `content` son arrays de bloques Portable Text (`_type: "block"`, `style: "normal" | "h2" | …`, `children[]` con `text` y `marks`). Renderizar con `astro-portabletext` o `@portabletext/to-html`.

## Navegación de la web

Hay dos formas de agrupar productos, y la web debe mantenerlas separadas:

- **Categorías** (taxonomía `categoria`): qué tipo de producto es. Términos: abrigos, moda, peluches, cosplay, gaming, cajas-sorpresa, squishy, papeleria, joyeria, maquillaje. Lista: `GET /_emdash/api/taxonomies/categoria/terms` (con `count`). Categorías de un producto: `GET /_emdash/api/content/productos/{id}/terms/categoria`.
- **Colecciones** (colección `colecciones`): selecciones hechas a mano: por precio (menos-de-10, de-10-a-20, de-20-a-40) y temáticas (lo-mas-viral, kawaii-para-adultos). Ordenar por `data.orden`.

Páginas:

1. **Home** (`/`): un selector con dos pestañas, «Por categoría» y «Por colección». Cada pestaña muestra tarjetas de sus grupos (nombre + nº de productos). La pestaña activa puede cambiarse sin recargar (`?ver=colecciones`).
2. **Categorías** (`/categorias`): solo la lista de categorías, sin colecciones. No mostrar categorías con `count` 0.
3. **Una categoría** (`/categoria/{slug}`): los productos de esa categoría, con una fila de filtros por colección («Todas», «Menos de 10 €», «Lo más viral»…). Mostrar solo las colecciones que tengan algún producto en esa categoría. El filtro se aplica en el navegador sobre los productos ya cargados, y se refleja en la URL (`/categoria/peluches?coleccion=menos-de-10`) para poder compartirla.
4. **Una colección** (`/coleccion/{slug}`): sus productos (sin filtro adicional).

Cómo montarlo en el build (la web es estática): descargar una vez todos los productos publicados, sus categorías y sus colecciones (`…/references/colecciones/children`), y generar a partir de ahí todas las páginas. Cada tarjeta de producto lleva en un atributo `data-colecciones` sus slugs de colección, para que el filtro funcione sin llamadas a la API.

## Respuestas reales

### `01-productos-lista.json`

```json
{
    "success": true,
    "data": {
        "items": [
            {
                "id": "01M61R19MACE1WCK8M0G51MM79",
                "type": "productos",
                "slug": "ejemplo-labubu-caja-sorpresa",
                "status": "published",
                "data": {
                    "title": "EJEMPLO – Labubu caja sorpresa",
                    "resumen": "Producto de prueba. Sustituir por uno real con su ASIN.",
                    "id_externo": "B000000002",
                    "precio_ref": 24.9,
                    "fuente_imagen": "marca",
                    "tipo": "oficial",
                    "edad_min": 15,
                    "destacado": 1,
                    "para_grabar": 0,
                    "notas": "Producto de ejemplo del seed. Ojo con las falsificaciones: solo vendedor oficial de Pop Mart."
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.970Z",
                "updatedAt": "2026-10-28T17:13:39.445Z",
                "publishedAt": "2026-10-28T17:13:39.445Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R1KVNYJMMKKZNF0MF5YJW",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19MACE1WCK8M0G51MM79",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19M3XH5SGGTHNAN6YGWC",
                "type": "productos",
                "slug": "ejemplo-set-washi-tape",
                "status": "published",
                "data": {
                    "title": "EJEMPLO – Set de washi tape kawaii",
                    "resumen": "Producto de prueba. Sustituir por uno real con su ASIN.",
                    "id_externo": "B000000001",
                    "precio_ref": 7.5,
                    "fuente_imagen": "propia",
                    "tipo": "generico",
                    "edad_min": 8,
                    "destacado": 0,
                    "para_grabar": 1,
                    "notas": "Producto de ejemplo del seed."
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.964Z",
                "updatedAt": "2026-10-28T17:13:39.494Z",
                "publishedAt": "2026-10-28T17:13:39.494Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R1KX6RFXETRPZGAJDM5Q9",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19M3XH5SGGTHNAN6YGWC",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19KEXN3VFX3T9NSNMJ70",
                "type": "productos",
                "slug": "ejemplo-llavero-peluche-kuromi",
                "status": "published",
                "data": {
                    "title": "EJEMPLO – Llavero de peluche Kuromi",
                    "resumen": "Producto de prueba. Sustituir por uno real con su ASIN.",
                    "descripcion": [
                        {
                            "_type": "block",
                            "_key": "d0",
                            "style": "normal",
                            "children": [
                                {
                                    "_type": "span",
                                    "_key": "d1",
                                    "text": "Llavero suave de Kuromi, ideal para la mochila."
                                }
                            ]
                        }
                    ],
                    "id_externo": "B000000000",
                    "precio_ref": 9.99,
                    "imagen": {
                        "id": "01M61R1VR9ZRN8WS980G2D410D",
                        "provider": "local",
                        "filename": "kuromi.jpg",
                        "mimeType": "image/jpeg",
                        "width": 800,
                        "height": 800,
                        "blurhash": "L9TP_2~CfQ~C~CoLfQoLfQfQfQfQ",
                        "dominantColor": "rgb(255,190,204)",
                        "alt": "Llavero de peluche Kuromi",
                        "meta": {
                            "storageKey": "01M61R1VM1F81G2DCEMBJDZEK6.jpg",
                            "caption": null,
                            "blurhash": "L9TP_2~CfQ~C~CoLfQoLfQfQfQfQ",
                            "dominantColor": "rgb(255,190,204)"
                        }
                    },
                    "fuente_imagen": "propia",
                    "tipo": "oficial",
                    "edad_min": 6,
                    "destacado": 0,
                    "para_grabar": 1,
                    "notas": "Producto de ejemplo del seed."
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.942Z",
                "updatedAt": "2026-10-28T17:13:59.633Z",
                "publishedAt": "2026-10-28T17:13:39.537Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R27G9CD09W1YVN6N1580Y",
                "draftRevisionId": null,
                "version": 4,
                "locale": "es",
                "translationGroup": "01M61R19KEXN3VFX3T9NSNMJ70",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            }
        ],
        "total": 3
    }
}
```

### `02-producto-detalle.json`

```json
{
    "success": true,
    "data": {
        "item": {
            "id": "01M61R19KEXN3VFX3T9NSNMJ70",
            "type": "productos",
            "slug": "ejemplo-llavero-peluche-kuromi",
            "status": "published",
            "data": {
                "title": "EJEMPLO – Llavero de peluche Kuromi",
                "resumen": "Producto de prueba. Sustituir por uno real con su ASIN.",
                "descripcion": [
                    {
                        "_type": "block",
                        "_key": "d0",
                        "style": "normal",
                        "children": [
                            {
                                "_type": "span",
                                "_key": "d1",
                                "text": "Llavero suave de Kuromi, ideal para la mochila."
                            }
                        ]
                    }
                ],
                "id_externo": "B000000000",
                "precio_ref": 9.99,
                "imagen": {
                    "id": "01M61R1VR9ZRN8WS980G2D410D",
                    "provider": "local",
                    "filename": "kuromi.jpg",
                    "mimeType": "image/jpeg",
                    "width": 800,
                    "height": 800,
                    "blurhash": "L9TP_2~CfQ~C~CoLfQoLfQfQfQfQ",
                    "dominantColor": "rgb(255,190,204)",
                    "alt": "Llavero de peluche Kuromi",
                    "meta": {
                        "storageKey": "01M61R1VM1F81G2DCEMBJDZEK6.jpg",
                        "caption": null,
                        "blurhash": "L9TP_2~CfQ~C~CoLfQoLfQfQfQfQ",
                        "dominantColor": "rgb(255,190,204)"
                    }
                },
                "fuente_imagen": "propia",
                "tipo": "oficial",
                "edad_min": 6,
                "destacado": 0,
                "para_grabar": 1,
                "notas": "Producto de ejemplo del seed."
            },
            "authorId": null,
            "primaryBylineId": null,
            "createdAt": "2026-10-28T17:13:28.942Z",
            "updatedAt": "2026-10-28T17:13:59.633Z",
            "publishedAt": "2026-10-28T17:13:39.537Z",
            "scheduledAt": null,
            "liveRevisionId": "01M61R27G9CD09W1YVN6N1580Y",
            "draftRevisionId": null,
            "version": 4,
            "locale": "es",
            "translationGroup": "01M61R19KEXN3VFX3T9NSNMJ70",
            "seo": {
                "title": null,
                "description": null,
                "image": null,
                "canonical": null,
                "noIndex": false
            },
            "bylines": [],
            "byline": null,
            "references": {
                "tienda": {
                    "children": [
                        {
                            "id": "tienda-amazon-es",
                            "slug": null,
                            "collection": "tiendas",
                            "title": "Amazon España",
                            "locale": "es",
                            "translationGroup": "tienda-amazon-es",
                            "sortOrder": 0
                        }
                    ]
                },
                "colecciones": {
                    "children": [
                        {
                            "id": "01M61R19HPS906VXNFW97FAGEB",
                            "slug": "menos-de-10",
                            "collection": "colecciones",
                            "title": "Regalos kawaii por menos de 10 €",
                            "locale": "es",
                            "translationGroup": "01M61R19HPS906VXNFW97FAGEB",
                            "sortOrder": 0
                        }
                    ]
                }
            }
        },
        "_rev": "NDoyMDI2LTEwLTI4VDE3OjEzOjU5LjYzM1o="
    }
}
```

### `03-producto-tienda.json`

```json
{
    "success": true,
    "data": {
        "children": [
            {
                "id": "tienda-amazon-es",
                "slug": null,
                "collection": "tiendas",
                "title": "Amazon España",
                "locale": "es",
                "translationGroup": "tienda-amazon-es",
                "sortOrder": 0
            }
        ]
    }
}
```

### `04-producto-colecciones.json`

```json
{
    "success": true,
    "data": {
        "children": [
            {
                "id": "01M61R19HPS906VXNFW97FAGEB",
                "slug": "menos-de-10",
                "collection": "colecciones",
                "title": "Regalos kawaii por menos de 10 €",
                "locale": "es",
                "translationGroup": "01M61R19HPS906VXNFW97FAGEB",
                "sortOrder": 0
            }
        ]
    }
}
```

### `05-producto-personajes.json`

```json
{
    "success": true,
    "data": {
        "terms": [
            {
                "id": "01M61R19GK653QGMCAFK6W4D7M",
                "name": "personaje",
                "slug": "kuromi",
                "label": "Kuromi",
                "parentId": null,
                "locale": "es",
                "translationGroup": "01M61R19GK653QGMCAFK6W4D7M"
            }
        ],
        "unresolved": [],
        "entryLocale": "es",
        "defaultLocale": "en",
        "implicitDefaultLocale": true
    }
}
```

### `06-producto-marcas.json`

```json
{
    "success": true,
    "data": {
        "terms": [
            {
                "id": "01M61R19GX50G4FR3SGTXY0ZJG",
                "name": "marca",
                "slug": "sanrio",
                "label": "Sanrio",
                "parentId": null,
                "locale": "es",
                "translationGroup": "01M61R19GX50G4FR3SGTXY0ZJG"
            }
        ],
        "unresolved": [],
        "entryLocale": "es",
        "defaultLocale": "en",
        "implicitDefaultLocale": true
    }
}
```

### `07-colecciones-lista.json`

```json
{
    "success": true,
    "data": {
        "items": [
            {
                "id": "01M61R19K2QS549EYQXX7FTVNE",
                "type": "colecciones",
                "slug": "kawaii-para-adultos",
                "status": "published",
                "data": {
                    "title": "Kawaii para adultos",
                    "descripcion": "Escritorio, cocina y tecnología con estilo kawaii.",
                    "orden": 60,
                    "destacada": 0
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.930Z",
                "updatedAt": "2026-10-28T17:13:28.933Z",
                "publishedAt": "2026-10-28T17:13:28.930Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19K54ZNYGK4PHMME11SY",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19K2QS549EYQXX7FTVNE",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19JA8WH6112S7E01Y2B7",
                "type": "colecciones",
                "slug": "papeleria",
                "status": "published",
                "data": {
                    "title": "Papelería kawaii",
                    "descripcion": "Bolígrafos, washi tape, pegatinas y notas adhesivas kawaii para el cole o la oficina.",
                    "orden": 50,
                    "destacada": 0
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.906Z",
                "updatedAt": "2026-10-28T17:13:28.907Z",
                "publishedAt": "2026-10-28T17:13:28.906Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19JB865PEJSFBNEHN3HS",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19JA8WH6112S7E01Y2B7",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19J3HCYA7RQTCVDNW8HG",
                "type": "colecciones",
                "slug": "lo-mas-viral",
                "status": "published",
                "data": {
                    "title": "Lo más viral",
                    "descripcion": "Los coleccionables kawaii que arrasan en TikTok.",
                    "orden": 40,
                    "destacada": 1
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.899Z",
                "updatedAt": "2026-10-28T17:13:28.901Z",
                "publishedAt": "2026-10-28T17:13:28.899Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19J6AK1RAG7G2SWWQRTS",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19J3HCYA7RQTCVDNW8HG",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19J0DBVNHPYNV0ER6HGA",
                "type": "colecciones",
                "slug": "de-20-a-40",
                "status": "published",
                "data": {
                    "title": "Regalos kawaii de 20 a 40 €",
                    "descripcion": "Mochilas, peluches grandes y regalos kawaii especiales.",
                    "orden": 30,
                    "destacada": 0
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.896Z",
                "updatedAt": "2026-10-28T17:13:28.897Z",
                "publishedAt": "2026-10-28T17:13:28.896Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19J1JFBCHX55JME8YM8B",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19J0DBVNHPYNV0ER6HGA",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19HWJ8196HQYKBE0NZQN",
                "type": "colecciones",
                "slug": "de-10-a-20",
                "status": "published",
                "data": {
                    "title": "Regalos kawaii de 10 a 20 €",
                    "descripcion": "Peluches, estuches, lámparas y más regalos kawaii por menos de 20 €.",
                    "orden": 20,
                    "destacada": 1
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.892Z",
                "updatedAt": "2026-10-28T17:13:28.893Z",
                "publishedAt": "2026-10-28T17:13:28.892Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19HYZ0NNNR862A4JTZ36",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19HWJ8196HQYKBE0NZQN",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            },
            {
                "id": "01M61R19HPS906VXNFW97FAGEB",
                "type": "colecciones",
                "slug": "menos-de-10",
                "status": "published",
                "data": {
                    "title": "Regalos kawaii por menos de 10 €",
                    "descripcion": "Detalles kawaii baratos para amigos invisibles, cumpleaños o para darse un capricho.",
                    "orden": 10,
                    "destacada": 1
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.887Z",
                "updatedAt": "2026-10-28T17:13:28.888Z",
                "publishedAt": "2026-10-28T17:13:28.886Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19HR02QFTJQ4N2RFKHPY",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19HPS906VXNFW97FAGEB",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            }
        ],
        "total": 6
    }
}
```

### `08-coleccion-productos.json`

```json
{
    "success": true,
    "data": {
        "parents": [
            {
                "id": "01M61R19KEXN3VFX3T9NSNMJ70",
                "slug": "ejemplo-llavero-peluche-kuromi",
                "collection": "productos",
                "title": "EJEMPLO – Llavero de peluche Kuromi",
                "locale": "es",
                "translationGroup": "01M61R19KEXN3VFX3T9NSNMJ70",
                "sortOrder": 0
            },
            {
                "id": "01M61R19M3XH5SGGTHNAN6YGWC",
                "slug": "ejemplo-set-washi-tape",
                "collection": "productos",
                "title": "EJEMPLO – Set de washi tape kawaii",
                "locale": "es",
                "translationGroup": "01M61R19M3XH5SGGTHNAN6YGWC",
                "sortOrder": 0
            }
        ]
    }
}
```

### `09-tiendas-lista.json`

```json
{
    "success": true,
    "data": {
        "items": [
            {
                "id": "tienda-amazon-es",
                "type": "tiendas",
                "slug": null,
                "status": "published",
                "data": {
                    "title": "Amazon España",
                    "plantilla_url": "https://www.amazon.es/dp/{id}?tag={tag}",
                    "tag_web": "PENDIENTE-21",
                    "tag_telegram": "PENDIENTE-21",
                    "tag_tiktok": "PENDIENTE-21",
                    "activa": 1
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.871Z",
                "updatedAt": "2026-10-28T17:13:28.878Z",
                "publishedAt": "2026-10-28T17:13:28.871Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19HFK01FFMNJ1PCMCNX2",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "tienda-amazon-es",
                "bylines": [],
                "byline": null
            }
        ],
        "total": 1
    }
}
```

### `10-paginas-lista.json`

```json
{
    "success": true,
    "data": {
        "items": [
            {
                "id": "01M61R19MK8X0MNCQ8WHCJFBYC",
                "type": "pages",
                "slug": "aviso-afiliados",
                "status": "published",
                "data": {
                    "title": "Enlaces de afiliado",
                    "content": [
                        {
                            "_type": "block",
                            "_key": "a0",
                            "style": "normal",
                            "children": [
                                {
                                    "_type": "span",
                                    "_key": "a1",
                                    "text": "Regalos Kawaii participa en programas de afiliados. Cuando compras a través de nuestros enlaces podemos recibir una pequeña comisión, sin coste adicional para ti."
                                }
                            ]
                        },
                        {
                            "_type": "block",
                            "_key": "a2",
                            "style": "normal",
                            "children": [
                                {
                                    "_type": "span",
                                    "_key": "a3",
                                    "text": "Como Afiliado de Amazon, obtengo ingresos por las compras adscritas que cumplen los requisitos aplicables."
                                }
                            ]
                        }
                    ]
                },
                "authorId": null,
                "primaryBylineId": null,
                "createdAt": "2026-10-28T17:13:28.979Z",
                "updatedAt": "2026-10-28T17:13:28.980Z",
                "publishedAt": "2026-10-28T17:13:28.979Z",
                "scheduledAt": null,
                "liveRevisionId": "01M61R19MNYMCH7QDD7SYRE23J",
                "draftRevisionId": null,
                "version": 2,
                "locale": "es",
                "translationGroup": "01M61R19MK8X0MNCQ8WHCJFBYC",
                "seo": {
                    "title": null,
                    "description": null,
                    "image": null,
                    "canonical": null,
                    "noIndex": false
                },
                "bylines": [],
                "byline": null
            }
        ],
        "total": 1
    }
}
```

### `11-taxonomias.json`

```json
{
    "success": true,
    "data": {
        "taxonomies": [
            {
                "id": "taxdef_category",
                "name": "category",
                "label": "Categories",
                "labelSingular": "Category",
                "hierarchical": true,
                "collections": [],
                "locale": "en",
                "translationGroup": "taxdef_category"
            },
            {
                "id": "taxdef_tag",
                "name": "tag",
                "label": "Tags",
                "labelSingular": "Tag",
                "hierarchical": false,
                "collections": [],
                "locale": "en",
                "translationGroup": "taxdef_tag"
            },
            {
                "id": "01M61R14WTGD1VYZ8H9R8PNGMC",
                "name": "personaje",
                "label": "Personajes",
                "labelSingular": "Personaje",
                "hierarchical": false,
                "collections": [
                    "productos"
                ],
                "locale": "es",
                "translationGroup": "01M61R14WTGD1VYZ8H9R8PNGMC"
            },
            {
                "id": "01M61R14WWJVR11NXH228CTA0H",
                "name": "marca",
                "label": "Marcas",
                "labelSingular": "Marca",
                "hierarchical": false,
                "collections": [
                    "productos"
                ],
                "locale": "es",
                "translationGroup": "01M61R14WWJVR11NXH228CTA0H"
            }
        ]
    }
}
```

### `12-personajes-terminos.json`

```json
{
    "success": true,
    "data": {
        "terms": [
            {
                "id": "01M61R19GK653QGMCAFK6W4D7M",
                "name": "personaje",
                "slug": "kuromi",
                "label": "Kuromi",
                "parentId": null,
                "children": [],
                "count": 1,
                "locale": "es",
                "translationGroup": "01M61R19GK653QGMCAFK6W4D7M"
            },
            {
                "id": "01M61R19GN11RYSDH83VNEA0YY",
                "name": "personaje",
                "slug": "cinnamoroll",
                "label": "Cinnamoroll",
                "parentId": null,
                "children": [],
                "count": 0,
                "locale": "es",
                "translationGroup": "01M61R19GN11RYSDH83VNEA0YY"
            },
            {
                "id": "01M61R19GQWXVFF6DQWW7V00FW",
                "name": "personaje",
                "slug": "my-melody",
                "label": "My Melody",
                "parentId": null,
                "children": [],
                "count": 0,
                "locale": "es",
                "translationGroup": "01M61R19GQWXVFF6DQWW7V00FW"
            },
            {
                "id": "01M61R19GR08NYWJ5S7DQGDYJW",
                "name": "personaje",
                "slug": "hello-kitty",
                "label": "Hello Kitty",
                "parentId": null,
                "children": [],
                "count": 0,
                "locale": "es",
                "translationGroup": "01M61R19GR08NYWJ5S7DQGDYJW"
            },
            {
                "id": "01M61R19GSNG7244Q13G32M0FQ",
                "name": "personaje",
                "slug": "pompompurin",
                "label": "Pompompurin",
                "parentId": null,
                "children": [],
                "count": 0,
                "locale": "es",
                "translationGroup": "01M61R19GSNG7244Q13G32M0FQ"
            },
            {
                "id": "01M61R19GT7HVN61F25F0XCZWG",
                "name": "personaje",
                "slug": "sumikko-gurashi",
                "label": "Sumikko Gurashi",
                "parentId": null,
                "children": [],
                "count": 0,
                "locale": "es",
                "translationGroup": "01M61R19GT7HVN61F25F0XCZWG"
            },
            {
                "id": "01M61R19GVW8YRCDSAQHTB1CQR",
                "name": "personaje",
                "slug": "pusheen",
                "label": "Pusheen",
                "parentId": null,
                "children": [],
                "count": 0,
                "locale": "es",
                "translationGroup": "01M61R19GVW8YRCDSAQHTB1CQR"
            },
            {
                "id": "01M61R19GW28MADMX3G1C4AYDV",
                "name": "personaje",
                "slug": "labubu",
                "label": "Labubu",
                "parentId": null,
                "children": [],
                "count": 1,
                "locale": "es",
                "translationGroup": "01M61R19GW28MADMX3G1C4AYDV"
            }
        ]
    }
}
```

### `13-menu-principal.json`

```json
{
    "success": true,
    "data": {
        "id": "01M61R14WYXBD93ZA7QT9E1JZY",
        "name": "primary",
        "label": "Menú principal",
        "createdAt": "2026-10-28T17:13:24.126Z",
        "updatedAt": "2026-10-28T17:13:24.126Z",
        "locale": "es",
        "translationGroup": "01M61R14WYXBD93ZA7QT9E1JZY",
        "items": [
            {
                "id": "01M61R19MS58YXGCEJD75QRDA4",
                "menuId": "01M61R14WYXBD93ZA7QT9E1JZY",
                "parentId": null,
                "sortOrder": 0,
                "type": "custom",
                "referenceCollection": null,
                "referenceId": null,
                "customUrl": "/",
                "label": "Inicio",
                "titleAttr": null,
                "target": null,
                "cssClasses": null,
                "createdAt": "2026-10-28T17:13:28.985Z",
                "locale": "es",
                "translationGroup": "01M61R19MS58YXGCEJD75QRDA4"
            },
            {
                "id": "01M61R19MSH015AJN3RZBFHMP4",
                "menuId": "01M61R14WYXBD93ZA7QT9E1JZY",
                "parentId": null,
                "sortOrder": 1,
                "type": "custom",
                "referenceCollection": null,
                "referenceId": null,
                "customUrl": "/coleccion/menos-de-10",
                "label": "Menos de 10 €",
                "titleAttr": null,
                "target": null,
                "cssClasses": null,
                "createdAt": "2026-10-28T17:13:28.985Z",
                "locale": "es",
                "translationGroup": "01M61R19MSH015AJN3RZBFHMP4"
            },
            {
                "id": "01M61R19MSHM9CXRTH8CFQ4EG6",
                "menuId": "01M61R14WYXBD93ZA7QT9E1JZY",
                "parentId": null,
                "sortOrder": 2,
                "type": "custom",
                "referenceCollection": null,
                "referenceId": null,
                "customUrl": "/coleccion/lo-mas-viral",
                "label": "Lo más viral",
                "titleAttr": null,
                "target": null,
                "cssClasses": null,
                "createdAt": "2026-10-28T17:13:28.985Z",
                "locale": "es",
                "translationGroup": "01M61R19MSHM9CXRTH8CFQ4EG6"
            },
            {
                "id": "01M61R19MSFY1N2RJ3SKQ90YBK",
                "menuId": "01M61R14WYXBD93ZA7QT9E1JZY",
                "parentId": null,
                "sortOrder": 3,
                "type": "custom",
                "referenceCollection": null,
                "referenceId": null,
                "customUrl": "/coleccion/papeleria",
                "label": "Papelería",
                "titleAttr": null,
                "target": null,
                "cssClasses": null,
                "createdAt": "2026-10-28T17:13:28.985Z",
                "locale": "es",
                "translationGroup": "01M61R19MSFY1N2RJ3SKQ90YBK"
            }
        ]
    }
}
```

### `15-media-detalle.json`

```json
{
    "success": true,
    "data": {
        "item": {
            "id": "01M61R1VR9ZRN8WS980G2D410D",
            "filename": "kuromi.jpg",
            "mimeType": "image/jpeg",
            "size": 10628,
            "width": 800,
            "height": 800,
            "focalX": null,
            "focalY": null,
            "alt": "Llavero de peluche Kuromi",
            "caption": null,
            "storageKey": "01M61R1VM1F81G2DCEMBJDZEK6.jpg",
            "contentHash": "sha1:8723a7e64ad899f9c6c34571dda5a78b7b18cf9a",
            "blurhash": "L9TP_2~CfQ~C~CoLfQoLfQfQfQfQ",
            "dominantColor": "rgb(255,190,204)",
            "status": "ready",
            "createdAt": "2026-10-28T17:13:47.529Z",
            "authorId": "01M61R19SYH5TTE8QC3XA98RY0",
            "folderId": null
        }
    }
}
```
