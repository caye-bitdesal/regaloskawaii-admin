import { esEnlaceAfiliadoAliExpress } from "./aliexpress-api.mjs";
import { tieneTagAmazon, tipoTiendaAfiliado } from "./affiliate-link-check.mjs";

/** 2 = oficial, 1 = enlace de afiliado válido, 0 = sin afiliación útil */
export function calcularPrioridad(data, tienda) {
	const tipo = data.tipo ?? "generico";
	if (tipo === "oficial") return 2;

	const tipoTienda = tienda ? tipoTiendaAfiliado(tienda) : null;
	const enlace = data.enlace_afiliado?.trim() ?? "";

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
