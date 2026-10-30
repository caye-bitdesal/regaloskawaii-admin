#!/usr/bin/env node
/**
 * Importa productos en EmDash desde un fichero JSON, usando la API REST.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/import-products.mjs productos.json [--publish] [--dry-run]
 *
 * Variables de entorno:
 *   EMDASH_URL    URL del panel (por defecto http://localhost:4321)
 *   EMDASH_TOKEN  Token de API con permisos de escritura (content:create, media:write)
 *   EMDASH_LOCALE Idioma del contenido (por defecto es)
 *
 * Opciones:
 *   --publish    Publica cada producto al crearlo (por defecto se crean como borrador)
 *   --dry-run     No crea nada: valida el fichero y muestra lo que haría
 *   --images=DIR Carpeta donde buscar la foto de cada producto por su ID
 *                 (p. ej. images/1005007345370415.webp). Por defecto: images/
 *                 Solo se usa si el producto no lleva "imagen" y no es de Amazon.
 *   --no-web-photos No buscar la foto en la página de AliExpress cuando el producto no
 *                 trae "imagen" ni hay foto en la carpeta (por defecto sí se busca).
 *
 * Formato del fichero: ver docs/import-products.md y docs/ejemplo-productos.json.
 * Los productos que ya existen (misma tienda e id_externo) se saltan, así que se
 * puede volver a ejecutar con el mismo fichero sin duplicar nada.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

const args = process.argv.slice(2);
const fichero = args.find((a) => !a.startsWith("--"));
const PUBLICAR = args.includes("--publish");
const SIMULAR = args.includes("--dry-run");
const FOTOS_WEB = !args.includes("--no-web-photos");
const DIR_IMAGENES = resolve(args.find((a) => a.startsWith("--images="))?.slice(9) ?? "images");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const LOCALE = process.env.EMDASH_LOCALE ?? "es";
const TOKEN = process.env.EMDASH_TOKEN;

if (!fichero) salir("Uso: node scripts/import-products.mjs productos.json [--publish] [--dry-run]");
if (!TOKEN) salir("Falta EMDASH_TOKEN (en local: curl -X POST \"http://localhost:4321/_emdash/api/setup/dev-bypass?token=1\")");

function salir(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

// ---------- API ----------

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, {
		...opciones,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(opciones.headers ?? {}) },
	});
	let json;
	try {
		json = await res.json();
	} catch {
		throw new Error(`${opciones.method ?? "GET"} ${ruta}: HTTP ${res.status} (respuesta no JSON)`);
	}
	if (!json.success) {
		throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.code ?? res.status} ${json.error?.message ?? ""}`.trim());
	}
	return json.data;
}

async function listarTodo(coleccion) {
	const items = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: "100", status: "all" });
		if (cursor) q.set("cursor", cursor);
		const data = await api(`/content/${coleccion}?${q}`);
		items.push(...data.items);
		cursor = data.nextCursor;
	} while (cursor);
	return items;
}

/** Todos los productos que apuntan a una entrada (la API devuelve los resultados por páginas). */
async function padres(coleccion, id, relacion) {
	const items = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: "100" });
		if (cursor) q.set("cursor", cursor);
		const data = await api(`/content/${coleccion}/${id}/references/${relacion}/parents?${q}`);
		items.push(...data.parents);
		cursor = data.nextCursor;
	} while (cursor);
	return items;
}

// ---------- utilidades ----------

const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const clave = (s) => sinAcentos(String(s)).toLowerCase().trim();

function slugify(s) {
	return sinAcentos(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/, "");
}

/** Deduce tienda e id a partir del enlace. */
function analizarEnlace(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	const host = u.hostname.toLowerCase();
	if (/(^|\.)amazon\.[a-z.]+$/.test(host) || host === "amzn.to" || host === "amzn.eu") {
		const m = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i);
		return { tienda: "amazon", id: m ? m[1].toUpperCase() : null, corto: !m };
	}
	if (/(^|\.)aliexpress\.[a-z.]+$/.test(host)) {
		const m = u.pathname.match(/\/item\/(\d+)\.html/) ?? u.search.match(/productIds=(\d+)/);
		return { tienda: "aliexpress", id: m ? m[1] : null };
	}
	return { tienda: null, id: null };
}

/** Busca la tienda en EmDash: por nombre exacto o por palabra clave. */
function buscarTienda(tiendas, nombre, deducida) {
	if (nombre) {
		const t = tiendas.find((x) => clave(x.data.title) === clave(nombre));
		if (t) return t;
	}
	if (deducida) return tiendas.find((x) => clave(x.data.title).includes(deducida));
	return undefined;
}

function textoAPortable(texto) {
	return String(texto)
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p, i) => ({
			_type: "block",
			_key: `b${i}`,
			style: "normal",
			children: [{ _type: "span", _key: `s${i}`, text: p }],
		}));
}

/** Busca <id>.webp|jpg|… en la carpeta de imágenes. */
function buscarImagenPorId(id) {
	if (!id) return null;
	for (const ext of [".webp", ".jpg", ".jpeg", ".png", ".avif"]) {
		const ruta = resolve(DIR_IMAGENES, `${id}${ext}`);
		if (existsSync(ruta)) return ruta;
	}
	return null;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Busca la foto principal en la página pública del producto de AliExpress
 * (etiqueta og:image o la primera de la galería). Devuelve la URL o null.
 */
async function fotoDeAliExpress(id) {
	try {
		const res = await fetch(`https://es.aliexpress.com/item/${id}.html`, {
			headers: {
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
				"Accept-Language": "es-ES,es;q=0.9",
			},
		});
		if (!res.ok) return null;
		const html = await res.text();
		const m =
			html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
			html.match(/"imagePathList"\s*:\s*\[\s*"([^"]+)"/);
		if (!m) return null;
		let url = m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
		if (url.startsWith("//")) url = `https:${url}`;
		// quita sufijos de tamaño: …/foto.jpg_640x640.jpg_.webp → …/foto.jpg
		return url.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, "$1");
	} catch {
		return null;
	}
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif" };

const esUrl = (s) => /^https?:\/\//i.test(s);

/** Lee la foto: de disco o, si es una URL (p. ej. la foto de AliExpress del email diario), descargándola. */
async function leerImagen(ruta) {
	if (!esUrl(ruta)) return { buffer: await readFile(ruta), tipo: MIME[extname(ruta).toLowerCase()], nombre: basename(ruta) };
	const res = await fetch(ruta);
	if (!res.ok) throw new Error(`no se pudo descargar la imagen ${ruta} (HTTP ${res.status})`);
	const tipo = (res.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!Object.values(MIME).includes(tipo)) throw new Error(`la imagen ${ruta} no es jpg, png, webp, avif ni gif (${tipo || "tipo desconocido"})`);
	const ext = Object.keys(MIME).find((e) => MIME[e] === tipo);
	return { buffer: Buffer.from(await res.arrayBuffer()), tipo, nombre: `${basename(new URL(ruta).pathname, extname(new URL(ruta).pathname))}${ext}` };
}

async function subirImagen(ruta, alt) {
	const { buffer, tipo, nombre } = await leerImagen(ruta);
	if (!tipo) throw new Error(`formato de imagen no admitido: ${ruta}`);
	const form = new FormData();
	form.append("file", new Blob([buffer], { type: tipo }), nombre);
	if (alt) form.append("alt", alt);
	const { item } = await api("/media", { method: "POST", body: form });
	return {
		provider: "local",
		id: item.id,
		src: item.url,
		alt: item.alt ?? alt,
		width: item.width,
		height: item.height,
		filename: item.filename,
		mimeType: item.mimeType,
	};
}

// ---------- validación de cada producto ----------

const TIPOS = new Set(["oficial", "generico"]);
const FUENTES = new Set(["propia", "marca"]);

function preparar(p, i, ctx) {
	const errores = [];
	const pos = `#${i + 1}${p?.nombre ? ` «${p.nombre}»` : ""}`;
	if (!p || typeof p !== "object") return { errores: [`${pos}: no es un objeto`] };
	if (!p.nombre) errores.push(`${pos}: falta "nombre"`);
	if (!p.enlace) errores.push(`${pos}: falta "enlace"`);

	const enlace = p.enlace ? analizarEnlace(p.enlace) : null;
	if (p.enlace && !enlace) errores.push(`${pos}: "enlace" no es una URL válida`);
	const idExterno = p.id_externo ?? enlace?.id;
	if (p.enlace && !idExterno) {
		errores.push(
			enlace?.corto
				? `${pos}: los enlaces cortos (amzn.to) no incluyen el ASIN; añade "id_externo" o usa el enlace largo`
				: `${pos}: no se pudo sacar el ID del enlace; añade "id_externo"`,
		);
	}

	const tienda = buscarTienda(ctx.tiendas, p.tienda, enlace?.tienda);
	if (p.enlace && !tienda) {
		errores.push(`${pos}: no hay ninguna tienda "${p.tienda ?? enlace?.tienda ?? "?"}" en EmDash (tiendas: ${ctx.tiendas.map((t) => t.data.title).join(", ")})`);
	}

	// Imagen: la indicada en el JSON o, si no hay, <id>.webp|jpg en la carpeta de imágenes.
	// Las fotos de Amazon no se suben nunca (el acuerdo de afiliados no permite alojarlas).
	let imagen = p.imagen ? (esUrl(p.imagen) ? p.imagen : resolve(ctx.base, p.imagen)) : null;
	if (enlace?.tienda === "amazon") {
		if (imagen) errores.push(`${pos}: no se pueden subir fotos de Amazon (quita "imagen"; la web las mostrará con la API)`);
		imagen = null;
	} else if (!imagen) {
		imagen = buscarImagenPorId(idExterno);
	}
	if (imagen && !esUrl(imagen)) {
		if (!existsSync(imagen)) errores.push(`${pos}: no existe la imagen ${imagen}`);
		else if (!MIME[extname(imagen).toLowerCase()]) errores.push(`${pos}: formato de imagen no admitido (${basename(imagen)})`);
	}

	const tipo = p.tipo ?? "generico";
	if (!TIPOS.has(tipo)) errores.push(`${pos}: "tipo" debe ser oficial o generico`);
	const fuente = p.fuente_imagen ?? (imagen ? "propia" : undefined);
	if (fuente && !FUENTES.has(fuente)) errores.push(`${pos}: "fuente_imagen" debe ser propia o marca`);

	const colecciones = [];
	for (const slug of p.colecciones ?? []) {
		const c = ctx.colecciones.get(clave(slug));
		if (c) colecciones.push(c.id);
		else errores.push(`${pos}: no existe la colección "${slug}" (existen: ${[...ctx.colecciones.values()].map((x) => x.slug).join(", ")})`);
	}

	const taxonomias = {};
	for (const [campo, tax] of [["categorias", "categoria"], ["personajes", "personaje"], ["marcas", "marca"]]) {
		if (!p[campo]?.length) continue;
		taxonomias[tax] = [];
		for (const valor of p[campo]) {
			const termino = ctx.terminos[tax].get(clave(valor)) ?? ctx.terminos[tax].get(slugify(valor));
			if (termino) taxonomias[tax].push(termino);
			else errores.push(`${pos}: no existe ${tax} "${valor}" (crea el término en el panel: ${[...new Set(ctx.terminos[tax].values())].join(", ")})`);
		}
	}

	// Enlace de afiliado: en Amazon se genera con la plantilla y el tag de la tienda;
	// en el resto se guarda el enlace tal cual (p. ej. el s.click de AliExpress).
	const guardarEnlace = p.enlace_afiliado ?? (enlace?.tienda === "amazon" ? undefined : p.enlace);

	const data = {
		title: String(p.nombre ?? "").trim(),
		...(p.resumen ? { resumen: String(p.resumen).slice(0, 200) } : {}),
		...(p.descripcion ? { descripcion: textoAPortable(p.descripcion) } : {}),
		id_externo: idExterno,
		...(guardarEnlace ? { enlace_afiliado: guardarEnlace } : {}),
		...(p.precio != null ? { precio_ref: Number(p.precio) } : {}),
		...(p.precio != null ? { precio_actualizado: new Date().toISOString() } : {}),
		...(fuente ? { fuente_imagen: fuente } : {}),
		tipo,
		...(p.edad_min != null ? { edad_min: Number(p.edad_min) } : {}),
		destacado: Boolean(p.destacado),
		para_grabar: Boolean(p.para_grabar),
		...(p.notas ? { notas: String(p.notas) } : {}),
	};
	if (p.precio != null && !Number.isFinite(data.precio_ref)) errores.push(`${pos}: "precio" no es un número`);
	for (const campo of [...Object.keys(data), ...(imagen ? ["imagen"] : [])]) {
		if (!ctx.campos.has(campo)) {
			errores.push(`${pos}: la colección productos no tiene el campo "${campo}" en este EmDash (añádelo en el panel, en Tipos de contenido → Productos)`);
		}
	}

	return {
		errores,
		pos,
		clave: tienda ? `${tienda.id}:${clave(idExterno ?? "")}` : null,
		idExterno: idExterno ? clave(idExterno) : null,
		tienda: enlace?.tienda ?? null,
		cuerpo: {
			data,
			locale: LOCALE,
			slug: p.slug ?? slugify(p.nombre ?? ""),
			taxonomies: Object.keys(taxonomias).length ? taxonomias : undefined,
			references: { tienda: tienda ? [tienda.id] : [], ...(colecciones.length ? { colecciones } : {}) },
		},
		imagen,
		alt: p.alt ?? p.nombre,
	};
}

// ---------- programa ----------

const productos = JSON.parse(await readFile(fichero, "utf8"));
const lista = Array.isArray(productos) ? productos : productos.productos;
if (!Array.isArray(lista)) salir('El fichero debe ser una lista [...] o un objeto { "productos": [...] }');

console.log(`EmDash: ${API}${SIMULAR ? " (simulación)" : ""}`);
const [esquema, tiendas, colecciones, existentes, categorias, personajes, marcas] = await Promise.all([
	api("/schema/collections/productos?includeFields=true"),
	listarTodo("tiendas"),
	listarTodo("colecciones"),
	listarTodo("productos"),
	api("/taxonomies/categoria/terms").catch(() => ({ terms: [] })),
	api("/taxonomies/personaje/terms"),
	api("/taxonomies/marca/terms"),
]);
// término → slug, buscando por slug o por nombre visible
const indiceTerminos = ({ terms }) =>
	new Map(terms.flatMap((t) => [[clave(t.slug), t.slug], [clave(t.label), t.slug]]));

// Tienda de cada producto existente (para detectar duplicados)
const tiendaDe = new Map();
for (const t of tiendas) {
	// productos que apuntan a esta tienda
	for (const p of await padres("tiendas", t.id, "productos_tienda")) tiendaDe.set(p.id, t.id);
}
const yaExisten = new Set(existentes.map((p) => `${tiendaDe.get(p.id)}:${clave(p.data.id_externo ?? "")}`));

// Productos en la papelera del panel: si los borraste, no se vuelven a crear.
const papelera = [];
for (let cursor; ; ) {
	const q = new URLSearchParams({ limit: "100" });
	if (cursor) q.set("cursor", cursor);
	const data = await api(`/content/productos/trash?${q}`);
	papelera.push(...data.items);
	if (!(cursor = data.nextCursor)) break;
}
const enPapelera = new Set(papelera.map((p) => clave(p.data?.id_externo ?? "")).filter(Boolean));
const slugsUsados = new Set([...existentes, ...papelera].map((p) => p.slug));

const ctx = {
	tiendas,
	colecciones: new Map(colecciones.map((c) => [clave(c.slug), c])),
	terminos: { categoria: indiceTerminos(categorias), personaje: indiceTerminos(personajes), marca: indiceTerminos(marcas) },
	base: dirname(resolve(fichero)),
	campos: new Map(esquema.item.fields.map((f) => [f.slug, f.type])),
};

const tipoEnlace = ctx.campos.get("enlace_afiliado");
if (tipoEnlace && tipoEnlace !== "url") {
	salir(`El campo enlace_afiliado es de tipo "${tipoEnlace}" y debe ser URL; ejecuta: node scripts/fix-affiliate-link-field.mjs`);
}

// Primero se separa lo que ya está en EmDash (o repetido en el fichero): eso no se valida ni se importa.
const preparados = lista.map((p, i) => preparar(p, i, ctx));
const vistosEnFichero = new Set();
for (const p of preparados) {
	if (p.clave && yaExisten.has(p.clave)) p.estado = "existe";
	else if (p.idExterno && enPapelera.has(p.idExterno)) p.estado = "papelera";
	else if (p.clave && vistosEnFichero.has(p.clave)) p.estado = "repetido";
	else p.estado = "nuevo";
	if (p.clave) vistosEnFichero.add(p.clave);
}
const nuevos = preparados.filter((p) => p.estado === "nuevo");
const conErrores = nuevos.filter((p) => p.errores.length);
if (conErrores.length) {
	console.error(`\n✗ ${conErrores.length} producto(s) con errores; no se ha importado nada:\n`);
	for (const p of conErrores) for (const e of p.errores) console.error(`  - ${e}`);
	process.exit(1);
}

const MOTIVO = {
	existe: "ya existe en EmDash",
	papelera: "está en la papelera del panel (restáuralo desde allí si lo quieres)",
	repetido: "repetido en este fichero",
};
const cuenta = { existe: 0, papelera: 0, repetido: 0 };
for (const p of preparados) {
	if (p.estado === "nuevo") continue;
	console.log(`↷ ${p.pos}: ${MOTIVO[p.estado]}, se salta`);
	cuenta[p.estado]++;
}

let creados = 0;
for (const p of nuevos) {
	// slug único
	let slug = p.cuerpo.slug || "producto";
	for (let n = 2; slugsUsados.has(slug); n++) slug = `${p.cuerpo.slug}-${n}`;
	slugsUsados.add(slug);
	p.cuerpo.slug = slug;

	if (SIMULAR) {
		const foto = p.imagen ? " con imagen" : FOTOS_WEB && p.tienda === "aliexpress" ? " (buscará la foto en AliExpress)" : "";
		console.log(`• ${p.pos}: se crearía /producto/${slug}${foto}${PUBLICAR ? " y se publicaría" : " (borrador)"}`);
		creados++;
		continue;
	}

	let media;
	try {
		if (!p.imagen && FOTOS_WEB && p.tienda === "aliexpress" && p.idExterno) {
			p.imagen = await fotoDeAliExpress(p.idExterno);
			await esperar(1000); // sin prisas: una página por segundo
			if (!p.imagen) console.log(`  ! ${p.pos}: no se encontró la foto en AliExpress; se crea sin foto`);
			else p.cuerpo.data.fuente_imagen ??= "marca";
		}
		if (p.imagen) {
			try {
				media = p.cuerpo.data.imagen = await subirImagen(p.imagen, p.alt);
			} catch (e) {
				if (!/^https?:/i.test(p.imagen)) throw e;
				console.log(`  ! ${p.pos}: ${e.message}; se crea sin foto`);
				p.imagen = null;
			}
		}
		const { item } = await api("/content/productos", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(p.cuerpo),
		});
		if (PUBLICAR) await api(`/content/productos/${item.id}/publish`, { method: "POST" });
		console.log(`✓ ${p.pos}: creado /producto/${slug}${p.imagen ? " con imagen" : ""}${PUBLICAR ? " (publicado)" : " (borrador)"}`);
		creados++;
	} catch (e) {
		// Si la foto se subió pero el producto no se creó, se borra para no dejarla huérfana.
		if (media) await api(`/media/${media.id}`, { method: "DELETE" }).catch(() => {});
		console.error(`✗ ${p.pos}: ${e.message}`);
		process.exitCode = 1;
	}
}

console.log(
	`\n${SIMULAR ? "Nuevos (se crearían)" : "Nuevos creados"}: ${creados} · Ya existían: ${cuenta.existe}` +
		` · En la papelera: ${cuenta.papelera} · Repetidos en el fichero: ${cuenta.repetido}`,
);
