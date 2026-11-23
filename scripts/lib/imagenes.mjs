/**
 * Fotos de producto: leer (de disco o URL), quitar el fondo (opcional) y subir a EmDash.
 * Lo usan scripts/importar.mjs y scripts/actualizar.mjs.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export const MIME = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".avif": "image/avif",
	".gif": "image/gif",
};

export const esUrl = (s) => /^https?:\/\//i.test(s ?? "");

/** Quita los sufijos de tamaño de las fotos de AliExpress: …/foto.jpg_640x640.jpg_.webp → …/foto.jpg */
export function fotoOriginalAliExpress(url) {
	if (!url) return url;
	let u = String(url).trim();
	if (u.startsWith("//")) u = `https:${u}`;
	return u.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, "$1");
}

/**
 * Último recurso: la foto principal de la página pública del producto (og:image o la
 * primera de la galería). AliExpress suele bloquear estas peticiones; mejor la API.
 */
export async function fotoDePaginaAliExpress(id) {
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
		return fotoOriginalAliExpress(m[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/"));
	} catch {
		return null;
	}
}

/** Lee la foto: de disco o, si es una URL, descargándola. */
async function leerImagen(ruta) {
	if (!esUrl(ruta)) return { buffer: await readFile(ruta), tipo: MIME[extname(ruta).toLowerCase()], nombre: basename(ruta) };
	const res = await fetch(ruta);
	if (!res.ok) throw new Error(`no se pudo descargar la imagen ${ruta} (HTTP ${res.status})`);
	const tipo = (res.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!Object.values(MIME).includes(tipo)) throw new Error(`la imagen ${ruta} no es jpg, png, webp, avif ni gif (${tipo || "tipo desconocido"})`);
	const ext = Object.keys(MIME).find((e) => MIME[e] === tipo);
	const ruta_ = new URL(ruta).pathname;
	return { buffer: Buffer.from(await res.arrayBuffer()), tipo, nombre: `${basename(ruta_, extname(ruta_))}${ext}` };
}

let fondoDesactivado = false;

/** Quita el fondo con IA y devuelve un WebP transparente. Si falla, devuelve la original. */
async function sinFondo(buffer, tipo, nombre) {
	if (fondoDesactivado) return { buffer, tipo, nombre };
	try {
		const { quitarFondo } = await import("./remove-background.mjs");
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

/**
 * Sube una foto a la biblioteca de medios de EmDash y devuelve el valor del campo «imagen».
 * @param {Function} api  cliente de lib/emdash.mjs
 * @param {string} ruta   fichero local o URL
 * @param {string} [alt]
 * @param {{quitarFondo?: boolean}} [opciones]
 */
export async function subirImagen(api, ruta, alt, { quitarFondo = false } = {}) {
	let foto = await leerImagen(ruta);
	if (quitarFondo) foto = await sinFondo(foto.buffer, foto.tipo, foto.nombre);
	if (!foto.tipo) throw new Error(`formato de imagen no admitido: ${ruta}`);
	const form = new FormData();
	form.append("file", new Blob([foto.buffer], { type: foto.tipo }), foto.nombre);
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
