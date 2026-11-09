#!/usr/bin/env node
/**
 * Sustituye enlaces “normales” de AliExpress (es.aliexpress.com/item/…) por enlaces
 * de afiliado (s.click.aliexpress.com/…) vía la API oficial de afiliados.
 *
 * Requiere en .env (openservice.aliexpress.com + Tracking ID en Portals):
 *   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID
 *
 * Uso:
 *   node --env-file=.env scripts/fill-affiliate-links.mjs [--dry-run] [--force]
 *   --force  vuelve a pedir enlace aunque ya parezca de afiliado
 */
import { apiAliExpressConfigurada, detallesAliExpress, esEnlaceAfiliadoAliExpress, trackingIdConfigurado } from "./lib/aliexpress-api.mjs";

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

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, {
		...opciones,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			...(opciones.body ? { "Content-Type": "application/json" } : {}),
			...(opciones.headers ?? {}),
		},
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

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Productos de tiendas AliExpress (o cuyo enlace / id lo indica). */
function esProductoAliExpress(item, tiendaAli) {
	const id = String(item.data.id_externo ?? "");
	const enlaces = `${item.data.enlace_afiliado ?? ""} ${item.data.enlace ?? ""}`;
	return tiendaAli || /aliexpress\./i.test(enlaces) || /^\d{13,17}$/.test(id);
}

const tiendas = await paginas("/content/tiendas?status=all", "items");
const pendientes = [];

for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	if (/amazon\./i.test(plantilla)) continue;
	const tiendaAli = /aliexpress/i.test(plantilla) || /aliexpress/i.test(t.data.title ?? "");
	for (const ref of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) {
		const { item } = await api(`/content/productos/${ref.id}`);
		const id = item.data.id_externo;
		if (!id || !esProductoAliExpress(item, tiendaAli)) continue;
		const actual = item.data.enlace_afiliado?.trim() ?? "";
		if (!FORZAR && actual && esEnlaceAfiliadoAliExpress(actual)) continue;
		pendientes.push({ item, id: String(id) });
	}
}

console.log(
	`AliExpress afiliados · tracking «${process.env.ALIEXPRESS_TRACKING_ID}» · productos a convertir: ${pendientes.length}${SIMULAR ? " (simulación)" : ""}`,
);
if (!pendientes.length) process.exit(0);

let actualizados = 0;
let sinEnlace = 0;
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
	for (const { item, id } of lote) {
		const promo = datos.get(id)?.enlaceAfiliado?.trim();
		if (!promo || !esEnlaceAfiliadoAliExpress(promo)) {
			console.log(`  ! «${item.data.title}»: sin enlace de afiliado en la API (¿producto fuera del programa?)`);
			sinEnlace++;
			continue;
		}
		if (SIMULAR) {
			console.log(`• «${item.data.title}» → ${promo}`);
			actualizados++;
			continue;
		}
		try {
			await api(`/content/productos/${item.id}`, {
				method: "PUT",
				body: JSON.stringify({ data: { enlace_afiliado: promo } }),
			});
			if (item.status === "published") await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ «${item.data.title}» → ${promo}`);
			actualizados++;
		} catch (e) {
			console.log(`✗ «${item.data.title}»: ${e.message}`);
			errores++;
		}
	}
	if (i + 20 < pendientes.length) await esperar(1000);
}

console.log(
	`\n${SIMULAR ? "Se actualizarían" : "Actualizados"}: ${actualizados} · Sin enlace en API: ${sinEnlace} · Errores: ${errores}`,
);
if (actualizados && !SIMULAR) {
	console.log("Siguiente paso en regaloskawaii: npm run sync-content (o REFRESH_CONTENT=1 npm run build)");
}
