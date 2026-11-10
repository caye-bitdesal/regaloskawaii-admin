#!/usr/bin/env node
/**
 * Actualiza el precio de los productos de AliExpress con la API oficial de afiliados:
 *   - precio_ref          precio de venta actual en euros, envío a España
 *   - historial_precios   cambios de precio de los últimos 60 días (JSON, ver lib/price-history.mjs)
 *   - precio_actualizado  fecha de esta consulta (la web no enseña descuentos de más de 7 días)
 *
 * La web solo anuncia un descuento si el precio actual es menor que el más bajo de los
 * 30 días anteriores según este historial (art. 20 Ley 7/1996). El «precio original» que
 * da AliExpress no se usa: los vendedores lo inflan (casi siempre es el doble).
 * Por eso los descuentos empiezan a verse 30 días después de la primera ejecución.
 *
 * Para no saturar EmDash (responde 503 si recibe muchas escrituras seguidas):
 *   - lee todos los productos de una vez con el listado, no uno a uno;
 *   - solo escribe los productos cuyo precio ha cambiado, o los que tienen descuento y
 *     llevan más de REFRESCO_DIAS sin consultar (para que la web lo siga enseñando);
 *   - empieza por los que hace más tiempo que no se actualizan, así que si se corta,
 *     al volver a ejecutarlo sigue por donde iba;
 *   - va más despacio cuando EmDash da 503 y se para si sigue saturado.
 *
 * Requiere en .env: ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET (y ALIEXPRESS_TRACKING_ID)
 * y el campo «historial_precios» (Texto) en Tipos de contenido → Productos.
 *
 * Uso:
 *   node --env-file=.env scripts/update-prices.mjs [--dry-run]
 *   EMDASH_PAUSA_MS=1000 …   pausa mínima entre llamadas a EmDash (por defecto 500 ms)
 *   EMDASH_LIMITE=25 …       elementos por página en los listados (por defecto 50)
 */
import { apiAliExpressConfigurada, detallesAliExpress } from "./lib/aliexpress-api.mjs";
import { clienteEmDash } from "./lib/emdash.mjs";
import { descuentoLegal, fechaUTC, leerHistorial, registrarPrecio } from "./lib/price-history.mjs";
import { calcularPrioridad } from "./lib/product-priority.mjs";

const SIMULAR = process.argv.includes("--dry-run");
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

/** Un producto con descuento se vuelve a guardar si su precio tiene más días que esto. */
const REFRESCO_DIAS = 3;
/** Errores seguidos (tras agotar reintentos) a partir de los que se para el script. */
const MAX_FALLOS_SEGUIDOS = 3;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Llamadas a EmDash: de una en una, con pausa adaptativa y reintentos (lib/emdash.mjs)

const { api, paginas, stats } = clienteEmDash(API, TOKEN);

// --- Utilidades ---------------------------------------------------------------------

const redondear = (n) => Math.round(n * 100) / 100;
const eur = (n) => (n == null ? "—" : `${n.toFixed(2).replace(".", ",")} €`);
const diasDesde = (iso) => {
	const t = new Date(iso ?? "").getTime();
	return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86_400_000;
};

/** Productos de tiendas AliExpress (o cuyo enlace / id lo indica). */
function esProductoAliExpress(data, tiendaAli) {
	const id = String(data.id_externo ?? "");
	const enlaces = `${data.enlace_afiliado ?? ""} ${data.enlace ?? ""}`;
	return tiendaAli || /aliexpress\./i.test(enlaces) || /^\d{13,17}$/.test(id);
}

// --- Productos a revisar ------------------------------------------------------------

const esquema = await api("/schema/collections/productos?includeFields=true");
if (!esquema.item.fields.some((f) => f.slug === "historial_precios")) {
	console.error("✗ La colección productos no tiene el campo «historial_precios» (Texto) (Tipos de contenido → Productos).");
	process.exit(1);
}

// Una sola lectura de todos los productos (en lugar de una por producto).
const todos = new Map((await paginas("/content/productos?status=all", "items")).map((p) => [p.id, p]));

const tiendas = await paginas("/content/tiendas?status=all", "items");
const productos = [];
const vistos = new Set();
for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	if (/amazon\./i.test(plantilla)) continue;
	const tiendaAli = /aliexpress/i.test(plantilla) || /aliexpress/i.test(t.data.title ?? "");
	for (const ref of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) {
		if (vistos.has(ref.id)) continue;
		vistos.add(ref.id);
		const resumen = todos.get(ref.id);
		if (!resumen?.data?.id_externo || !esProductoAliExpress(resumen.data, tiendaAli)) continue;
		productos.push({ resumen, id: String(resumen.data.id_externo), tienda: t });
	}
}
// Primero los que aún no tienen historial y luego los que llevan más tiempo sin
// actualizar: si el script se corta, al volver a ejecutarlo se retoma ahí.
const orden = (p) => (p.resumen.data.historial_precios ? 0 : 1e6) + diasDesde(p.resumen.data.precio_actualizado);
productos.sort((a, b) => orden(b) - orden(a));

console.log(`Precios AliExpress · productos: ${productos.length}${SIMULAR ? " (simulación)" : ""}`);
if (!productos.length) process.exit(0);

// --- Consulta de precios y escritura ------------------------------------------------

const ahora = new Date().toISOString();
const hoy = fechaUTC();
const cuenta = { actualizados: 0, sinCambios: 0, conDescuento: 0, sinDatos: 0, errores: 0 };
let fallosSeguidos = 0;

lotes: for (let i = 0; i < productos.length; i += 20) {
	const lote = productos.slice(i, i + 20);
	let datos;
	try {
		datos = await detallesAliExpress(lote.map((p) => p.id));
	} catch (e) {
		console.error(`✗ Lote API de AliExpress: ${e.message}`);
		cuenta.errores += lote.length;
		continue;
	}

	for (const { resumen, id, tienda } of lote) {
		const titulo = resumen.data.title;
		const d = datos.get(id);
		if (!d?.precio || d.precio <= 0) {
			console.log(`  ! «${titulo}»: la API no devuelve precio (¿producto fuera del programa o retirado?)`);
			cuenta.sinDatos++;
			continue;
		}
		const precio = redondear(d.precio);
		const historialAntes = leerHistorial(resumen.data.historial_precios);
		const historial = registrarPrecio(historialAntes, precio, hoy);
		const descuento = descuentoLegal(historial, precio, hoy);
		if (descuento) cuenta.conDescuento++;

		const antes = resumen.data.precio_ref;
		const cambia =
			antes !== precio ||
			JSON.stringify(historial) !== JSON.stringify(historialAntes) ||
			resumen.data.precio_original != null; // campo antiguo: se borra
		// Con descuento, la fecha tiene que ser reciente para que la web lo enseñe.
		const caduca = descuento && diasDesde(resumen.data.precio_actualizado) > REFRESCO_DIAS;
		if (!cambia && !caduca) {
			cuenta.sinCambios++;
			continue;
		}

		const texto = `«${titulo}»: ${eur(antes)} → ${eur(precio)}${descuento ? ` (más bajo en 30 días: ${eur(descuento.precioAnterior)}, -${descuento.porcentaje} %)` : ""}`;
		if (SIMULAR) {
			console.log(`• ${texto}`);
			cuenta.actualizados++;
			continue;
		}
		try {
			// El producto completo justo antes de guardarlo, para no perder ningún campo.
			const { item } = await api(`/content/productos/${resumen.id}`);
			// precio_original (el «antes» de AliExpress) ya no se usa: se quita.
			const { precio_original: _viejo, ...resto } = item.data;
			const merged = {
				...resto,
				precio_ref: precio,
				historial_precios: JSON.stringify(historial),
				precio_actualizado: ahora,
			};
			await api(`/content/productos/${item.id}`, {
				method: "PUT",
				body: JSON.stringify({
					data: { ...merged, ...(tienda ? { priority: calcularPrioridad(merged, tienda) } : {}) },
				}),
			});
			if (item.status === "published") await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ ${texto}`);
			cuenta.actualizados++;
			fallosSeguidos = 0;
		} catch (e) {
			console.log(`✗ «${titulo}»: ${e.message}`);
			cuenta.errores++;
			if (++fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
				console.log(`\n✗ EmDash sigue saturado tras ${MAX_FALLOS_SEGUIDOS} fallos seguidos: paro aquí. Vuelve a ejecutarlo más tarde; seguirá por los que faltan.`);
				break lotes;
			}
			// Un respiro antes de seguir con el siguiente producto.
			await esperar(30_000);
		}
	}
}

console.log(
	`\n${SIMULAR ? "Se actualizarían" : "Actualizados"}: ${cuenta.actualizados} · Sin cambios: ${cuenta.sinCambios} · Con descuento: ${cuenta.conDescuento} · Sin datos en la API: ${cuenta.sinDatos} · Errores: ${cuenta.errores}`,
);
if (cuenta.actualizados && !SIMULAR) {
	console.log("La web se reconstruye sola esta noche, o lánzala ya desde Actions → Build and deploy → Run workflow.");
}
console.log(`Peticiones a EmDash: ${stats.peticiones} (reintentos: ${stats.reintentos})`);
if (cuenta.errores) process.exitCode = 1;
