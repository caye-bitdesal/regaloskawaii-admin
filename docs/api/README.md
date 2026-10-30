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
| 7 | `07-colecciones-lista.json` | `GET /_emdash/api/content/colecciones?status=published` | Colecciones publicadas |
| 8 | `08-coleccion-productos.json` | `GET /_emdash/api/content/colecciones/{id}/references/productos_colecciones/parents` | Productos de una colección (**recomendado** para montar la relación: 1 llamada por colección en vez de 1 por producto) |
| 9 | `09-tiendas-lista.json` | `GET /_emdash/api/content/tiendas?status=published` | Tiendas y plantillas de enlace |
| 10 | `10-paginas-lista.json` | `GET /_emdash/api/content/pages?status=published` | Páginas fijas (aviso de afiliados…) |
| 11 | `11-taxonomias.json` | `GET /_emdash/api/taxonomies` | Taxonomías (`personaje`, `marca`; `category` y `tag` son de EmDash, ignorarlas) |
| 12 | `12-personajes-terminos.json` | `GET /_emdash/api/taxonomies/personaje/terms` | Términos con `count` (nº de productos) |
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
2. Por cada colección: `…/references/productos_colecciones/parents` → mapa colección → productos.
3. Tienda: por ahora solo hay una (Amazon España). Si hay más, pedir `…/productos_tienda/children` por producto.
4. Personajes y marcas: `…/terms/{taxonomía}` por producto (o solo cuando se necesiten páginas por personaje).

### Portable Text

`descripcion` y `content` son arrays de bloques Portable Text (`_type: "block"`, `style: "normal" | "h2" | …`, `children[]` con `text` y `marks`). Renderizar con `astro-portabletext` o `@portabletext/to-html`.
