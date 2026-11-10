/** Identifica productos de Amazon (import y EmDash). */

export function esTiendaAmazon(tienda, enlaceDeducido) {
	if (enlaceDeducido === "amazon") return true;
	if (!tienda) return false;
	const id = String(tienda.id ?? "").toLowerCase();
	if (id.startsWith("tienda-amazon")) return true;
	const title = String(tienda.data?.title ?? "").toLowerCase();
	return title.includes("amazon");
}

/** Sin `tipo` en JSON: Amazon → oficial; resto → generico. */
export function tipoProductoPorDefecto(tipoExplicito, tienda, enlaceDeducido) {
	if (tipoExplicito != null && tipoExplicito !== "") return tipoExplicito;
	if (esTiendaAmazon(tienda, enlaceDeducido)) return "oficial";
	return "generico";
}
