/**
 * Cliente mínimo de la API oficial de afiliados de AliExpress (AliExpress Open Platform).
 *
 * Variables de entorno (en .env, que no va al repositorio):
 *   ALIEXPRESS_APP_KEY      App Key de tu app de afiliado (openservice.aliexpress.com)
 *   ALIEXPRESS_APP_SECRET   App Secret de esa app
 *   ALIEXPRESS_TRACKING_ID  Tracking ID de AliExpress Portals (opcional; da el enlace de afiliado)
 *
 * Firma: HMAC-SHA256 con el App Secret sobre los parámetros ordenados por nombre
 * (nombre+valor concatenados), en hexadecimal mayúsculas. Pasarela: api-sg.aliexpress.com/sync.
 */
import { createHmac } from "node:crypto";

const PASARELA = process.env.ALIEXPRESS_API_URL || "https://api-sg.aliexpress.com/sync";

export const apiAliExpressConfigurada = () => Boolean(process.env.ALIEXPRESS_APP_KEY && process.env.ALIEXPRESS_APP_SECRET);

export const trackingIdConfigurado = () => Boolean(process.env.ALIEXPRESS_TRACKING_ID?.trim());

/** Enlaces cortos de Portals o con parámetros de afiliado en la URL larga. */
export function esEnlaceAfiliadoAliExpress(url) {
	if (!url?.trim()) return false;
	try {
		const u = new URL(url.trim());
		if (/(^|\.)s\.click\.aliexpress\./i.test(u.hostname)) return true;
		return u.searchParams.has("aff_fcid") || u.searchParams.has("aff_fsk");
	} catch {
		return false;
	}
}

export function firmar(params, secreto) {
	const base = Object.keys(params)
		.filter((k) => params[k] != null && params[k] !== "")
		.sort()
		.map((k) => `${k}${params[k]}`)
		.join("");
	return createHmac("sha256", secreto).update(base, "utf8").digest("hex").toUpperCase();
}

async function llamar(method, args) {
	const params = {
		...args,
		method,
		app_key: process.env.ALIEXPRESS_APP_KEY,
		sign_method: "sha256",
		timestamp: String(Date.now()),
	};
	params.sign = firmar(params, process.env.ALIEXPRESS_APP_SECRET);
	const res = await fetch(PASARELA, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
		body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")),
	});
	const json = await res.json().catch(() => null);
	if (!json) throw new Error(`la API de AliExpress respondió HTTP ${res.status}`);
	if (json.error_response) throw new Error(`API de AliExpress: ${json.error_response.msg ?? json.error_response.code}`);
	return json;
}

/** Número de la API (llega como texto, p. ej. "12.34" o "30"); undefined si no es válido. */
function numero(valor) {
	if (valor == null || valor === "") return undefined;
	const n = Number(valor);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Datos de afiliado de varios productos (hasta 20 por llamada).
 * @param {string[]} ids productId de AliExpress
 * Los precios vienen en euros para envío a España: `precio` es el de venta (con descuento) y
 * `precioOriginal` el de antes del descuento (igual a `precio` si no hay descuento).
 * @returns {Promise<Map<string, {imagen?: string, precio?: number, precioOriginal?: number, descuento?: number, enlaceAfiliado?: string, titulo?: string}>>}
 */
export async function detallesAliExpress(ids) {
	const salida = new Map();
	for (let i = 0; i < ids.length; i += 20) {
		const lote = ids.slice(i, i + 20);
		const json = await llamar("aliexpress.affiliate.productdetail.get", {
			product_ids: lote.join(","),
			target_currency: "EUR",
			target_language: "ES",
			ship_to_country: "ES",
			tracking_id: process.env.ALIEXPRESS_TRACKING_ID,
		});
		const resultado = json.aliexpress_affiliate_productdetail_get_response?.resp_result;
		if (resultado && String(resultado.resp_code) !== "200") {
			throw new Error(`API de AliExpress: ${resultado.resp_msg ?? resultado.resp_code}`);
		}
		const productos = resultado?.result?.products?.product ?? resultado?.result?.products ?? [];
		for (const p of Array.isArray(productos) ? productos : [productos]) {
			if (!p?.product_id) continue;
			let imagen = p.product_main_image_url;
			if (imagen?.startsWith("//")) imagen = `https:${imagen}`;
			salida.set(String(p.product_id), {
				imagen,
				precio: numero(p.target_sale_price),
				precioOriginal: numero(p.target_original_price),
				descuento: numero(String(p.discount ?? "").replace("%", "")),
				enlaceAfiliado: p.promotion_link,
				titulo: p.product_title,
			});
		}
		if (i + 20 < ids.length) await new Promise((r) => setTimeout(r, 1000));
	}
	return salida;
}
