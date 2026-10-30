#!/usr/bin/env node
/**
 * Pone foto a los productos que ya están en EmDash sin imagen (excepto Amazon, cuyas
 * fotos no se pueden alojar). Para cada uno busca, por este orden:
 *   1. images/<ID>.webp|jpg|jpeg|png|avif en tu carpeta (otra carpeta: --images=DIR)
 *   2. la foto principal de su página en AliExpress
 * Sube la foto, la asigna al producto y vuelve a publicar los que estaban publicados.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/fill-photos.mjs [--dry-run] [--no-web-photos]
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

const args = process.argv.slice(2);
const SIMULAR = args.includes("--dry-run");
const FOTOS_WEB = !args.includes("--no-web-photos");
const DIR_IMAGENES = resolve(args.find((a) => a.startsWith("--images="))?.slice(9) ?? "images");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
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
		return url.replace(/(\.(?:jpe?g|png|webp))_[^/]*$/i, "$1");
	} catch {
		return null;
	}
}

async function leerImagen(ruta) {
	if (!/^https?:\/\//i.test(ruta)) return { buffer: await readFile(ruta), tipo: MIME[extname(ruta).toLowerCase()], nombre: basename(ruta) };
	const res = await fetch(ruta);
	if (!res.ok) throw new Error(`no se pudo descargar ${ruta} (HTTP ${res.status})`);
	const tipo = (res.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!Object.values(MIME).includes(tipo)) throw new Error(`${ruta} no es una imagen admitida (${tipo || "tipo desconocido"})`);
	const ext = Object.keys(MIME).find((e) => MIME[e] === tipo);
	const camino = new URL(ruta).pathname;
	return { buffer: Buffer.from(await res.arrayBuffer()), tipo, nombre: `${basename(camino, extname(camino))}${ext}` };
}

async function subirImagen(ruta, alt) {
	const { buffer, tipo, nombre } = await leerImagen(ruta);
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

const tiendas = await paginas("/content/tiendas?status=all", "items");
let puestas = 0;
let sinFoto = 0;
for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	if (/amazon\./i.test(plantilla)) continue;
	const esAli = /aliexpress\./i.test(plantilla);
	for (const ref of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) {
		const { item } = await api(`/content/productos/${ref.id}`);
		const id = item.data.id_externo;
		if (item.data.imagen || !id) continue;
		let ruta = fotoLocal(id);
		if (!ruta && esAli && FOTOS_WEB) {
			ruta = await fotoDeAliExpress(id);
			await esperar(1000);
		}
		if (!ruta) {
			console.log(`  ! «${item.data.title}»: no se encontró foto`);
			sinFoto++;
			continue;
		}
		if (SIMULAR) {
			console.log(`• «${item.data.title}» ← ${ruta}`);
			puestas++;
			continue;
		}
		let media;
		try {
			media = await subirImagen(ruta, item.data.title);
			await api(`/content/productos/${item.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { imagen: media, fuente_imagen: item.data.fuente_imagen ?? "marca" } }),
			});
			if (item.status === "published") await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ «${item.data.title}» ← ${ruta}`);
			puestas++;
		} catch (e) {
			if (media) await api(`/media/${media.id}`, { method: "DELETE" }).catch(() => {});
			console.log(`✗ «${item.data.title}»: ${e.message}`);
			sinFoto++;
		}
	}
}
console.log(`\n${SIMULAR ? "Se pondrían" : "Fotos puestas"}: ${puestas} · Sin foto: ${sinFoto}`);
