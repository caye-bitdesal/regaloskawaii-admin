/**
 * Historial de precios de un producto, guardado en el campo de texto «historial_precios»
 * como JSON: [["2026-11-10", 3.29], ["2026-11-14", 2.99], …]. Cada entrada es un cambio
 * de precio (fecha UTC en la que se vio por primera vez ese precio), en orden.
 *
 * Sirve para anunciar descuentos como manda el artículo 20 de la Ley 7/1996 de Ordenación
 * del Comercio Minorista: el precio anterior de una rebaja es el más bajo de los 30 días
 * anteriores. La web (src/lib/emdash/priceHistory.ts) hace el mismo cálculo.
 */

/** Días que se guardan de historial (más que la ventana, para tener margen). */
const DIAS_GUARDADOS = 60;
/** Ventana del precio anterior. */
export const DIAS_VENTANA = 30;

const DIA_MS = 86_400_000;
export const fechaUTC = (d = new Date()) => d.toISOString().slice(0, 10);
const sumarDias = (fecha, dias) => fechaUTC(new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * DIA_MS));

/** Lee el campo; si está vacío o mal, devuelve []. */
export function leerHistorial(texto) {
	if (!texto) return [];
	try {
		const lista = JSON.parse(texto);
		if (!Array.isArray(lista)) return [];
		return lista
			.filter((e) => Array.isArray(e) && /^\d{4}-\d{2}-\d{2}$/.test(e[0]) && Number.isFinite(e[1]) && e[1] > 0)
			.sort((a, b) => a[0].localeCompare(b[0]));
	} catch {
		return [];
	}
}

/**
 * Apunta el precio de hoy. Devuelve el historial nuevo (o el mismo si no cambia) y quita
 * lo antiguo, conservando la última entrada anterior al corte (el precio con el que empieza
 * la ventana).
 */
export function registrarPrecio(historial, precio, hoy = fechaUTC()) {
	const ultimo = historial.at(-1);
	if (ultimo && ultimo[1] === precio) return historial;
	let nuevo = ultimo?.[0] === hoy ? [...historial.slice(0, -1), [hoy, precio]] : [...historial, [hoy, precio]];
	// Si al corregir el precio de hoy vuelve a ser igual que el anterior, sobra la entrada.
	if (nuevo.length >= 2 && nuevo.at(-1)[1] === nuevo.at(-2)[1]) nuevo = nuevo.slice(0, -1);

	const corte = sumarDias(hoy, -DIAS_GUARDADOS);
	const primeraDentro = nuevo.findIndex((e) => e[0] > corte);
	if (primeraDentro > 1) nuevo = nuevo.slice(primeraDentro - 1);
	return nuevo;
}

/**
 * Precio anterior legal: el más bajo de los 30 días anteriores a `hoy` (sin contar hoy).
 * Undefined si el historial no cubre los 30 días completos (no sabemos el precio de antes).
 */
export function precioAnterior30d(historial, hoy = fechaUTC()) {
	const inicio = sumarDias(hoy, -DIAS_VENTANA);
	const antesDeHoy = historial.filter((e) => e[0] < hoy);
	const alInicio = antesDeHoy.filter((e) => e[0] <= inicio).at(-1);
	if (!alInicio) return undefined;
	const precios = [alInicio[1], ...antesDeHoy.filter((e) => e[0] > inicio).map((e) => e[1])];
	return Math.min(...precios);
}

/** Descuento legal de hoy: precio anterior 30 días y porcentaje, si el precio actual es al menos un 1 % menor. */
export function descuentoLegal(historial, precio, hoy = fechaUTC()) {
	const anterior = precioAnterior30d(historial, hoy);
	if (!anterior || !(precio < anterior * 0.99)) return undefined;
	return { precioAnterior: anterior, porcentaje: Math.round((1 - precio / anterior) * 100) };
}
