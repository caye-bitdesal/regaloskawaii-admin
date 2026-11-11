import { esEnlaceAfiliadoAliExpress } from "./aliexpress-api.mjs";
import { tieneTagAmazon, tipoTiendaAfiliado } from "./affiliate-link-check.mjs";

/** true si el producto tiene foto principal. */
export const tieneFoto = (data) => Boolean(data?.imagen && (data.imagen.src || data.imagen.id || data.imagen.meta?.storageKey));

/**
 * 2 = oficial, 1 = enlace de afiliado válido, 0 = al final de la web.
 * Siempre 0 (aunque sea oficial): sin foto, o de AliExpress sin enlace de afiliado
 * (fuera del programa: no da comisión). Así quedan publicados pero al final de los listados.
 * La web aplica la misma regla (prioridadProducto en src/lib/emdash/helpers.ts).
 */
export function calcularPrioridad(data, tienda) {
	if (!tieneFoto(data)) return 0;

	const tipoTienda = tienda ? tipoTiendaAfiliado(tienda) : null;
	const enlace = data.enlace_afiliado?.trim() ?? "";
	if (tipoTienda === "aliexpress" && !esEnlaceAfiliadoAliExpress(enlace)) return 0;

	const tipo = data.tipo ?? "generico";
	if (tipo === "oficial") return 2;

	if (tipoTienda === "amazon") {
		if (enlace && !tieneTagAmazon(enlace)) return 0;
		return 1;
	}
	if (tipoTienda === "aliexpress") {
		return esEnlaceAfiliadoAliExpress(enlace) ? 1 : 0;
	}
	if (esEnlaceAfiliadoAliExpress(enlace) || tieneTagAmazon(enlace)) return 1;
	return 0;
}

export function clasificarErrorAliExpress(errorNote) {
	const n = (errorNote ?? "").toLowerCase();
	if (n.includes("target country") || n.includes("cannot be sold or promoted")) return "pais";
	if (n.includes("non-affiliate")) return "no-afiliado";
	return "otro";
}
