import { idItemAliExpress } from "./affiliate-link-check.mjs";

/** Una fila CSV con campos entre comillas opcionales. */
export function parseCsvLine(line) {
	const out = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			if (inQuotes && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else inQuotes = !inQuotes;
		} else if (c === "," && !inQuotes) {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	out.push(cur);
	return out.map((c) => c.trim());
}

function headerKey(h) {
	return h.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * CSV de respuesta de AliExpress Portals (Original URL, Tracking URL, Error Notes…).
 * @returns {Map<string, { trackingUrl: string, errorNote?: string, originalUrl: string }>}
 *   clave = id de item AliExpress
 */
export function mapaEnlacesAliExpressPortals(contenido) {
	const lineas = contenido.split(/\r?\n/).filter((l) => l.trim());
	if (!lineas.length) return { map: new Map(), formato: "vacío" };

	const header = parseCsvLine(lineas[0]).map(headerKey);
	const idxOriginal = header.findIndex((h) => h === "original url" || h === "url");
	const idxTracking = header.findIndex((h) => h === "tracking url" || h === "promotion link");
	const idxError = header.findIndex((h) => h.includes("error"));

	if (idxOriginal < 0 || idxTracking < 0) {
		return { map: null, formato: "simple" };
	}

	const map = new Map();
	for (const line of lineas.slice(1)) {
		const cols = parseCsvLine(line);
		const originalUrl = cols[idxOriginal]?.trim() ?? "";
		const trackingUrl = cols[idxTracking]?.trim() ?? "";
		const errorNote = idxError >= 0 ? cols[idxError]?.trim() : "";
		const id = idItemAliExpress(originalUrl);
		if (!id) continue;
		map.set(id, { trackingUrl, errorNote, originalUrl });
	}
	return { map, formato: "aliexpress-portals" };
}

/** Lista de URLs: cabecera «URL» o una URL por línea (orden fijo). */
export function leerUrlsEnOrden(contenido) {
	const lineas = contenido
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lineas[0]?.toUpperCase() === "URL") lineas.shift();
	return lineas;
}
