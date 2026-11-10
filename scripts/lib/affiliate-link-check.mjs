import { esEnlaceAfiliadoAliExpress } from "./aliexpress-api.mjs";

const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const clave = (s) => sinAcentos(String(s)).toLowerCase().trim();

export function tipoTiendaAfiliado(tienda) {
	const plantilla = tienda.data?.plantilla_url ?? "";
	const titulo = tienda.data?.title ?? "";
	if (/amazon\./i.test(plantilla) || /amazon/i.test(titulo)) return "amazon";
	if (/aliexpress/i.test(plantilla) || /aliexpress/i.test(titulo)) return "aliexpress";
	return null;
}

export function urlCanonicaAliExpress(idExterno) {
	if (!idExterno) return null;
	return `https://es.aliexpress.com/item/${String(idExterno).trim()}.html`;
}

/** ID numérico del producto en URLs tipo …/item/1234567890.html */
export function idItemAliExpress(url) {
	if (!url?.trim()) return null;
	try {
		const m = new URL(url.trim()).pathname.match(/\/item\/(\d+)(?:\.html?)?$/i);
		return m ? m[1] : null;
	} catch {
		const m = String(url).match(/\/item\/(\d+)/);
		return m ? m[1] : null;
	}
}

export function urlCanonicaAmazon(idExterno) {
	if (!idExterno) return null;
	return `https://www.amazon.es/dp/${String(idExterno).trim()}`;
}

/** true si la URL guardada lleva un tag de afiliado de Amazon (y opcionalmente coincide con el de la tienda). */
export function tieneTagAmazon(url, tagEsperado) {
	if (!url?.trim()) return false;
	try {
		const tag = new URL(url.trim()).searchParams.get("tag");
		if (!tag) return false;
		if (tagEsperado?.trim() && tag !== tagEsperado.trim()) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * @returns {null | { urlBatch: string, enlaceOriginal: string }}
 *   null = el producto ya tiene enlace de afiliado correcto
 */
export function necesitaEnlaceAfiliado(tienda, item) {
	const tipo = tipoTiendaAfiliado(tienda);
	if (!tipo) return null;

	const guardado = item.data.enlace_afiliado?.trim() ?? "";
	const idExterno = item.data.id_externo;

	if (tipo === "aliexpress") {
		if (guardado && esEnlaceAfiliadoAliExpress(guardado)) return null;
		const urlBatch = urlCanonicaAliExpress(idExterno) ?? guardado;
		if (!urlBatch) return null;
		return {
			urlBatch,
			enlaceOriginal: guardado || urlBatch,
		};
	}

	if (tipo === "amazon") {
		const tag = tienda.data.tag_web?.trim() ?? "";
		if (guardado && tieneTagAmazon(guardado, tag || undefined)) return null;
		const urlBatch = urlCanonicaAmazon(idExterno);
		if (!urlBatch) return null;
		return {
			urlBatch,
			enlaceOriginal: guardado,
		};
	}

	return null;
}
