/**
 * Productos de AliExpress fuera del programa de afiliados: la API no los devuelve, así que
 * no tienen enlace de afiliado (no dan comisión), ni precio, ni foto por la API.
 * Se quedan publicados, pero con prioridad 0 para que salgan al final de los listados
 * (la misma regla que aplica calcularPrioridad en lib/product-priority.mjs).
 *
 * Se respetan los que tienen un enlace de afiliado puesto a mano (s.click.aliexpress.com,
 * p. ej. generado en AliExpress Portals): esos sí dan comisión.
 */
import { esEnlaceAfiliadoAliExpress } from "./aliexpress-api.mjs";

/** Si más de esta parte de los productos consultados no vuelve de la API, se sospecha de la API y no se toca nada. */
export const MAX_PROPORCION_SIN_DATOS = 0.4;

/** true si el producto está fuera del programa y aún no tiene prioridad 0. */
export function debeBajarPrioridad(item) {
	return !esEnlaceAfiliadoAliExpress(item.data?.enlace_afiliado ?? "") && item.data?.priority !== 0;
}

/**
 * Pone prioridad 0 a los productos de `candidatos` que lo necesiten.
 * @param {(ruta: string, opciones?: object) => Promise<any>} api  cliente de lib/emdash.mjs
 * @param {Array<{ id: string, status?: string, data: { title?: string, enlace_afiliado?: string, priority?: number } }>} candidatos
 * @param {{ simular?: boolean, consultados?: number }} opciones  consultados: total de productos preguntados a la API
 * @returns {Promise<number>} cuántos se han bajado (o se bajarían)
 */
export async function bajarPrioridadFueraDePrograma(api, candidatos, { simular = false, consultados } = {}) {
	const aBajar = candidatos.filter(debeBajarPrioridad);
	if (!aBajar.length) return 0;

	if (consultados && candidatos.length / consultados > MAX_PROPORCION_SIN_DATOS) {
		console.log(
			`\n! La API no ha devuelto ${candidatos.length} de ${consultados} productos: parece un fallo de la API, así que no se cambia ninguna prioridad.`,
		);
		return 0;
	}

	console.log(`\nFuera del programa de afiliados (sin datos en la API ni enlace de afiliado) → prioridad 0:`);
	let hechos = 0;
	for (const item of aBajar) {
		const titulo = item.data.title;
		if (simular) {
			console.log(`• «${titulo}» (prioridad ${item.data.priority ?? "—"} → 0)`);
			hechos++;
			continue;
		}
		try {
			// PUT parcial: EmDash mezcla los campos que se envían con los que ya hay.
			await api(`/content/productos/${item.id}`, {
				method: "PUT",
				body: JSON.stringify({ data: { priority: 0 } }),
			});
			if (item.status === "published") await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ «${titulo}» → prioridad 0`);
			hechos++;
		} catch (e) {
			console.log(`✗ «${titulo}»: ${e.message}`);
			process.exitCode = 1;
		}
	}
	return hechos;
}
