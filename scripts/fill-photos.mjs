#!/usr/bin/env node
/**
 * Pone foto a los productos que ya están en EmDash sin imagen (excepto Amazon, cuyas
 * fotos no se pueden alojar). Para cada uno busca, por este orden:
 *   1. images/<ID>.webp|jpg|jpeg|png|avif en tu carpeta (otra carpeta: --images=DIR)
 *   2. otro EmDash donde ese producto ya tenga foto (--from=URL, p. ej. tu EmDash
 *      local http://localhost:4321, con su token en EMDASH_FROM_TOKEN)
 *   3. la foto principal de su página en AliExpress
 *
 * Con --photos=fichero.json se usan antes que nada las URLs de ese fichero
 * ({ "ID": "https://…" } o { "ID": ["https://…", "https://…"] }, se prueban en orden).
 * Es la única fuente que se aplica también a productos de Amazon, y nunca acepta
 * fotos alojadas en Amazon.
 * Sube la foto, la asigna al producto y vuelve a publicar los que estaban publicados.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/fill-photos.mjs [--dry-run] [--no-web-photos] [--remove-bg] [--publish]
 *   --publish  publica también los productos en borrador a los que consigue poner foto
 *
 * Copiar las fotos de tu EmDash local a producción:
 *   EMDASH_FROM_TOKEN=<token local> EMDASH_URL=https://admin.regaloskawaii.es EMDASH_TOKEN=<token prod> \
 *     node scripts/fill-photos.mjs --from=http://localhost:4321
 */
import { apiAliExpressConfigurada, detallesAliExpress } from "./lib/aliexpress-api.mjs";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const args = process.argv.slice(2);
const SIMULAR = args.includes("--dry-run");
const FOTOS_WEB = !args.includes("--no-web-photos");
const QUITAR_FONDO = args.includes("--remove-bg");
let fondoDesactivado = false;
const PUBLICAR = args.includes("--publish"); // publica también los borradores a los que se pone foto
// Con la API configurada, no se piden páginas de AliExpress salvo con --pages
const SOLO_API = apiAliExpressConfigurada() && !args.includes("--pages");
const DIR_IMAGENES = resolve(args.find((a) => a.startsWith("--images="))?.slice(9) ?? "images");
const FICHERO_FOTOS = args.find((a) => a.startsWith("--photos="))?.slice(9) ?? null;
const ORIGEN = args.find((a) => a.startsWith("--from="))?.slice(7)?.replace(/\/+$/, "") ?? null;
const TOKEN_ORIGEN = process.env.EMDASH_FROM_TOKEN;
if (ORIGEN && !TOKEN_ORIGEN) {
	console.error("✗ Con --from hace falta EMDASH_FROM_TOKEN (el token de ese EmDash)");
	process.exit(1);
}
const API = (process.env.EMDASH_URL || "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error("✗ Falta EMDASH_TOKEN");
	process.exit(1);
}

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, {
		...opciones,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(opciones.headers ?? {}) },
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json.data;
}

async function paginas(ruta, campo) {
	const items = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: "100" });
		if (cursor) q.set("cursor", cursor);
		const data = await api(`${ruta}${ruta.includes("?") ? "&" : "?"}${q}`);
		items.push(...data[campo]);
		cursor = data.nextCursor;
	} while (cursor);
	return items;
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif" };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function fotoLocal(id) {
	for (const ext of [".webp", ".jpg", ".jpeg", ".png", ".avif"]) {
		const ruta = resolve(DIR_IMAGENES, `${id}${ext}`);
		if (existsSync(ruta)) return ruta;
	}
	return null;
}

/**
 * URLs de fotos de AliExpress ya encontradas (también en --dry-run), para no volver a pedir
 * cada página: AliExpress bloquea tras muchas visitas seguidas. Se guarda dentro de la
 * carpeta de imágenes, que no va al repositorio.
 */
const CACHE_ALI = resolve(DIR_IMAGENES, ".aliexpress-fotos.json");
const cacheAli = existsSync(CACHE_ALI) ? JSON.parse(await readFile(CACHE_ALI, "utf8")) : {};
const guardarCacheAli = () => writeFile(CACHE_ALI, `${JSON.stringify(cacheAli, null, 2)}\n`).catch(() => {});

/** @returns {Promise<{url?: string, bloqueado?: boolean, motivo?: string}>} */
async function fotoDeAliExpress(id) {
	if (cacheAli[id]) return { url: cacheAli[id] };
	// 1.º la API oficial de afiliados (sin bloqueos), si está configurada en .env
	if (apiAliExpressConfigurada()) {
		try {
			const datos = (await detallesAliExpress([String(id)])).get(String(id));
			if (datos?.imagen) {
				cacheAli[id] = datos.imagen;
				await guardarCacheAli();
				return { url: datos.imagen, api: true };
			}
			if (SOLO_API) return { motivo: "la API de afiliados no lo devuelve: no está en el programa de afiliados (no da comisión) o ya no existe" };
		} catch (e) {
			if (SOLO_API) return { motivo: e.message };
			console.log(`  ! ${e.message}; pruebo con la página del producto`);
		}
	}
	// 2.º la página del producto
	try {
		const res = await fetch(`https://es.aliexpress.com/item/${id}.html`, {
			headers: {
				"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
				"Accept-Language": "es-ES,es;q=0.9",
			},
		});
		const html = await res.text();
		if (res.status === 429 || /captcha|punish|_____tmd_____|slide to verify|x5secdata/i.test(html.slice(0, 20000))) {
			return { bloqueado: true, motivo: `AliExpress pide verificación (HTTP ${res.status})` };
		}
		if (!res.ok) return { motivo: `la página respondió HTTP ${res.status}` };
		const m =
			html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
			html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
			html.match(/"imagePathList"\s*:\s*\[\s*"([^"]+)"/);
		if (!m) return { motivo: "la página no tiene foto principal (¿producto retirado?)" };
		let url = m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
		if (url.startsWith("//")) url = `https:${url}`;
		url = url.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, "$1");
		cacheAli[id] = url;
		await guardarCacheAli();
		return { url };
	} catch (e) {
		return { motivo: `no se pudo abrir la página (${e.message})` };
	}
}

async function leerImagen(ruta) {
	if (!/^https?:\/\//i.test(ruta)) return { buffer: await readFile(ruta), tipo: MIME[extname(ruta).toLowerCase()], nombre: basename(ruta) };
	const res = await fetch(ruta, ORIGEN && ruta.startsWith(ORIGEN) ? { headers: { Authorization: `Bearer ${TOKEN_ORIGEN}` } } : {});
	if (!res.ok) throw new Error(`no se pudo descargar ${ruta} (HTTP ${res.status})`);
	const tipo = (res.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!Object.values(MIME).includes(tipo)) throw new Error(`${ruta} no es una imagen admitida (${tipo || "tipo desconocido"})`);
	const ext = Object.keys(MIME).find((e) => MIME[e] === tipo);
	const camino = new URL(ruta).pathname;
	return { buffer: Buffer.from(await res.arrayBuffer()), tipo, nombre: `${basename(camino, extname(camino))}${ext}` };
}

/** Con --remove-bg: quita el fondo con IA y sube un WebP transparente. Si falla, sube la original. */
async function prepararFoto(buffer, tipo, nombre, esAmazon = false) {
	if (!QUITAR_FONDO || esAmazon || fondoDesactivado) return { buffer, tipo, nombre };
	try {
		const { quitarFondo } = await import("./lib/remove-background.mjs");
		const salida = await quitarFondo(buffer);
		return { buffer: salida, tipo: "image/webp", nombre: `${nombre.replace(/\.[a-z0-9]+$/i, "")}-sinfondo.webp` };
	} catch (e) {
		if (e.code === "ERR_MODULE_NOT_FOUND") {
			// Falta scripts/lib/remove-background.mjs (o sus dependencias): se avisa una vez y se sigue sin quitar fondos
			console.log(`  ! No se pueden quitar fondos (${e.message.split(" imported from")[0]}): se suben las fotos originales.`);
			fondoDesactivado = true;
		} else {
			console.log(`  ! no se pudo quitar el fondo de ${nombre}: ${e.message}; se sube la original`);
		}
		return { buffer, tipo, nombre };
	}
}

async function subirImagen(ruta, alt, esAmazon = false) {
	const leida = await leerImagen(ruta);
	const { buffer, tipo, nombre } = await prepararFoto(leida.buffer, leida.tipo, leida.nombre, esAmazon);
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

const esDeAmazon = (url) => /(^|\.)(amazon\.[a-z.]+|media-amazon\.com|ssl-images-amazon\.com|amazon-adsystem\.com)$/i.test(new URL(url).hostname);

/** Fotos indicadas a mano: id → [urls]. */
const fotosFichero = new Map();
if (FICHERO_FOTOS) {
	const datos = JSON.parse(await readFile(resolve(FICHERO_FOTOS), "utf8"));
	for (const [id, v] of Object.entries(datos)) {
		if (id.startsWith("_")) continue; // claves de comentario
		const urls = (Array.isArray(v) ? v : [v]).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
		const buenas = urls.filter((u) => !esDeAmazon(u));
		if (buenas.length < urls.length) console.log(`  ! ${id}: se ignoran las fotos alojadas en Amazon`);
		if (buenas.length) fotosFichero.set(id.toLowerCase(), buenas);
	}
	console.log(`Fotos en ${FICHERO_FOTOS}: ${fotosFichero.size}`);
}

/** Fotos del EmDash de origen, por ID de producto: id_externo → URL de descarga. */
const fotosOrigen = new Map();
if (ORIGEN) {
	let cursor;
	do {
		const q = new URLSearchParams({ limit: "100", status: "all" });
		if (cursor) q.set("cursor", cursor);
		const res = await fetch(`${ORIGEN}/_emdash/api/content/productos?${q}`, { headers: { Authorization: `Bearer ${TOKEN_ORIGEN}` } });
		const json = await res.json().catch(() => ({}));
		if (!json.success) {
			console.error(`✗ No se pudo leer ${ORIGEN}: ${json.error?.message ?? `HTTP ${res.status}`}`);
			process.exit(1);
		}
		for (const p of json.data.items) {
			const clave = p.data.imagen?.meta?.storageKey;
			if (p.data.id_externo && clave) fotosOrigen.set(String(p.data.id_externo).toLowerCase(), `${ORIGEN}/_emdash/api/media/file/${clave}`);
		}
		cursor = json.data.nextCursor;
	} while (cursor);
	console.log(`Fotos disponibles en ${ORIGEN}: ${fotosOrigen.size}`);
}

console.log(
	apiAliExpressConfigurada()
		? `AliExpress: API de afiliados (App Key …${process.env.ALIEXPRESS_APP_KEY.slice(-4)})${SOLO_API ? "" : " y, si no devuelve el producto, su página"}`
		: "AliExpress: SIN API (faltan ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET; ¿has puesto --env-file=.env?): se piden las páginas, que AliExpress puede bloquear",
);
const tiendas = await paginas("/content/tiendas?status=all", "items");
let puestas = 0;
let sinFoto = 0; // no se encontró ninguna foto
let fallos = 0; // había foto pero falló la descarga o la subida
let bloqueadas = 0; // AliExpress pidió verificación
let bloqueosSeguidos = 0;
let aliParado = false;
for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	const esAmazon = /amazon\./i.test(plantilla);
	if (esAmazon && !fotosFichero.size) continue; // a Amazon solo se le ponen fotos del fichero --photos
	// AliExpress se reconoce por la plantilla, por el nombre de la tienda o, producto a producto,
	// por su enlace (la plantilla puede estar vacía o ser un enlace de afiliado).
	const tiendaAli = /aliexpress/i.test(plantilla) || /aliexpress/i.test(t.data.title ?? "");
	for (const ref of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) {
		const { item } = await api(`/content/productos/${ref.id}`);
		const id = item.data.id_externo;
		if (item.data.imagen || !id) continue;
		const esAli =
			!esAmazon &&
			(tiendaAli || /aliexpress\./i.test(`${item.data.enlace_afiliado ?? ""} ${item.data.enlace ?? ""}`) || /^\d{13,17}$/.test(String(id)));
		const candidatas = [...(fotosFichero.get(String(id).toLowerCase()) ?? [])];
		if (!esAmazon) {
			const otra = fotoLocal(id) ?? fotosOrigen.get(String(id).toLowerCase());
			if (otra) candidatas.push(otra);
		}
		let motivo = "no hay foto en la carpeta de imágenes";
		if (!candidatas.length && esAli && FOTOS_WEB) {
			if (aliParado) {
				bloqueadas++;
				continue;
			}
			const enCache = Boolean(cacheAli[id]);
			const web = await fotoDeAliExpress(id);
			if (!enCache && !web.api) await esperar(SOLO_API ? 300 : 2000 + Math.random() * 2000);
			if (web.url) {
				candidatas.push(web.url);
				bloqueosSeguidos = 0;
			} else if (web.bloqueado) {
				bloqueadas++;
				console.log(`  ⏸ «${item.data.title}»: ${web.motivo}`);
				if (++bloqueosSeguidos >= 3) {
					aliParado = true;
					console.log("  ⏸ AliExpress está bloqueando las peticiones: dejo de pedirle páginas en esta ejecución.");
				}
				continue;
			} else {
				motivo = web.motivo;
			}
		}
		if (!candidatas.length) {
			if (!esAmazon) {
				console.log(`  ! «${item.data.title}»: ${motivo}`);
				sinFoto++;
			}
			continue;
		}
		let ruta = candidatas[0];
		if (SIMULAR) {
			console.log(`• «${item.data.title}» ← ${ruta}`);
			puestas++;
			continue;
		}
		let media;
		try {
			let ultimoError;
			for (const c of candidatas) {
				try {
					// Las fotos del fichero --photos nunca son de Amazon (se rechazan al leerlo):
					// a esas sí se les puede quitar el fondo aunque el producto sea de Amazon.
					const delFichero = (fotosFichero.get(String(id).toLowerCase()) ?? []).includes(c);
					media = await subirImagen(c, item.data.title, esAmazon && !delFichero);
					ruta = c;
					break;
				} catch (e) {
					ultimoError = e;
				}
			}
			if (!media) throw ultimoError;
			await api(`/content/productos/${item.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { imagen: media, fuente_imagen: item.data.fuente_imagen ?? "marca" } }),
			});
			if (item.status === "published" || PUBLICAR) await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ «${item.data.title}» ← ${ruta}`);
			puestas++;
		} catch (e) {
			if (media) await api(`/media/${media.id}`, { method: "DELETE" }).catch(() => {});
			console.log(`✗ «${item.data.title}»: ${e.message}`);
			fallos++;
		}
	}
}
console.log(
	`\n${SIMULAR ? "Se pondrían" : "Fotos puestas"}: ${puestas} · Sin foto: ${sinFoto}` +
		` · Falló la descarga o subida (✗): ${fallos} · Bloqueadas por AliExpress (⏸): ${bloqueadas}`,
);
if (bloqueadas) console.log("AliExpress ha bloqueado algunas páginas: espera un rato (30-60 min) y vuelve a ejecutarlo; las fotos ya encontradas no se vuelven a pedir.");
if (Object.keys(cacheAli).length) console.log(`Fotos de AliExpress recordadas en ${CACHE_ALI}: ${Object.keys(cacheAli).length}`);
