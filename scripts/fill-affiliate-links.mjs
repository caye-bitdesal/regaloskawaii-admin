#!/usr/bin/env node
/**
 * Sustituye enlaces “normales” de AliExpress (es.aliexpress.com/item/…) por enlaces
 * de afiliado (s.click.aliexpress.com/…) vía la API oficial de afiliados.
 *
 * Requiere en .env (openservice.aliexpress.com + Tracking ID en Portals):
 *   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID
 *
 * Uso:
 *   node --env-file=.env scripts/fill-affiliate-links.mjs [--dry-run] [--force] [--keep-priority]
 *   --force         vuelve a pedir enlace aunque ya parezca de afiliado
 *   --keep-priority  no baja a prioridad 0 los que la API no devuelve (fuera del programa)
 */
import { apiAliExpressConfigurada, detallesAliExpress, esEnlaceAfiliadoAliExpress, trackingIdConfigurado } from "./lib/aliexpress-api.mjs";
import { calcularPrioridad } from "./lib/product-priority.mjs";
import { clienteEmDash } from "./lib/emdash.mjs";
import { bajarPrioridadFueraDePrograma } from "./lib/out-of-program.mjs";

const SIMULAR = process.argv.includes("--dry-run");
const FORZAR = process.argv.includes("--force");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error("✗ Falta EMDASH_TOKEN");
	process.exit(1);
}
if (!apiAliExpressConfigurada()) {
	console.error("✗ Faltan ALIEXPRESS_APP_KEY y/o ALIEXPRESS_APP_SECRET en .env");
	process.exit(1);
}
if (!trackingIdConfigurado()) {
	console.error("✗ Falta ALIEXPRESS_TRACKING_ID (Portals → Tracking ID)");
	process.exit(1);
}

// Cliente con pausa, reintentos y páginas pequeñas para no saturar EmDash (lib/emdash.mjs).
const { api, paginas } = clienteEmDash(API, TOKEN);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Productos de tiendas AliExpress (o cuyo enlace / id lo indica). */
function esProductoAliExpress(item, tiendaAli) {
	const id = String(item.data.id_externo ?? "");
	const enlaces = `${item.data.enlace_afiliado ?? ""} ${item.data.enlace ?? ""}`;
	return tiendaAli || /aliexpress\./i.test(enlaces) || /^\d{13,17}$/.test(id);
}

// Una sola lectura de todos los productos (en lugar de una por producto).
const todos = new Map((await paginas("/content/productos?status=all", "items")).map((p) => [p.id, p]));
const tiendas = await paginas("/content/tiendas?status=all", "items");
const pendientes = [];

for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	if (/amazon\./i.test(plantilla)) continue;
	const tiendaAli = /aliexpress/i.test(plantilla) || /aliexpress/i.test(t.data.title ?? "");
	for (const ref of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) {
		const item = todos.get(ref.id);
		if (!item) continue;
		const id = item.data.id_externo;
		if (!id || !esProductoAliExpress(item, tiendaAli)) continue;
		const actual = item.data.enlace_afiliado?.trim() ?? "";
		if (!FORZAR && actual && esEnlaceAfiliadoAliExpress(actual)) continue;
		pendientes.push({ item, id: String(id), tienda: t });
	}
}

console.log(
	`AliExpress afiliados · tracking «${process.env.ALIEXPRESS_TRACKING_ID}» · productos a convertir: ${pendientes.length}${SIMULAR ? " (simulación)" : ""}`,
);
if (!pendientes.length) process.exit(0);

let actualizados = 0;
let sinEnlace = 0;
const sinEnlaceEnApi = [];
let errores = 0;

for (let i = 0; i < pendientes.length; i += 20) {
	const lote = pendientes.slice(i, i + 20);
	let datos;
	try {
		datos = await detallesAliExpress(lote.map((p) => p.id));
	} catch (e) {
		console.error(`✗ Lote API: ${e.message}`);
		errores += lote.length;
		continue;
	}
	for (const { item, id, tienda: t } of lote) {
		const promo = datos.get(id)?.enlaceAfiliado?.trim();
		if (!promo || !esEnlaceAfiliadoAliExpress(promo)) {
			console.log(`  ! «${item.data.title}»: sin enlace de afiliado en la API (¿producto fuera del programa?)`);
			sinEnlace++;
			sinEnlaceEnApi.push(item);
			continue;
		}
		if (SIMULAR) {
			console.log(`• «${item.data.title}» → ${promo}`);
			actualizados++;
			continue;
		}
		try {
			// El producto completo justo antes de guardarlo, para no perder ningún campo.
			const completo = (await api(`/content/productos/${item.id}`)).item;
			const merged = { ...completo.data, enlace_afiliado: promo };
			const tiendaRef = t;
			await api(`/content/productos/${item.id}`, {
				method: "PUT",
				body: JSON.stringify({
					data: {
						...merged,
						...(tiendaRef ? { priority: calcularPrioridad(merged, tiendaRef) } : {}),
					},
				}),
			});
			if (completo.status === "published") await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ «${item.data.title}» → ${promo}`);
			actualizados++;
		} catch (e) {
			console.log(`✗ «${item.data.title}»: ${e.message}`);
			errores++;
		}
	}
	if (i + 20 < pendientes.length) await esperar(1000);
}

// Sin enlace de afiliado en la API: fuera del programa → prioridad 0 (salvo con --keep-priority).
const bajados = process.argv.includes("--keep-priority")
	? 0
	: await bajarPrioridadFueraDePrograma(api, sinEnlaceEnApi, { simular: SIMULAR });

console.log(
	`\n${SIMULAR ? "Se actualizarían" : "Actualizados"}: ${actualizados} · Sin enlace en API: ${sinEnlace} (a prioridad 0: ${bajados}) · Errores: ${errores}`,
);
if (actualizados && !SIMULAR) {
	console.log("Siguiente paso en regaloskawaii: npm run sync-content (o REFRESH_CONTENT=1 npm run build)");
}
