#!/usr/bin/env node
/**
 * Actualiza enlace_afiliado y prioridad en EmDash a partir del manifiesto + CSV de plataforma.
 *
 * AliExpress Portals: match por «Original URL»; sin Tracking URL:
 *   - target country → despublicar
 *   - non-affiliate → prioridad 0
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/apply-affiliate-link-batch.mjs manifiesto.json portales.csv [--dry-run]
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { idItemAliExpress, tipoTiendaAfiliado, tieneTagAmazon } from "./lib/affiliate-link-check.mjs";
import { esEnlaceAfiliadoAliExpress } from "./lib/aliexpress-api.mjs";
import { leerUrlsEnOrden, mapaEnlacesAliExpressPortals } from "./lib/parse-affiliate-csv.mjs";
import { calcularPrioridad, clasificarErrorAliExpress } from "./lib/product-priority.mjs";

const SIMULAR = process.argv.includes("--dry-run");
const FORZAR_ORDEN = process.argv.includes("--orden");
const posicionales = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [manifiestoPath, urlsPath] = posicionales;
if (!manifiestoPath || !urlsPath) {
	console.error("Uso: node scripts/apply-affiliate-link-batch.mjs <manifiesto.json> <urls.csv|txt> [--dry-run] [--orden]");
	process.exit(1);
}

const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error("✗ Falta EMDASH_TOKEN");
	process.exit(1);
}

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, {
		...opciones,
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			...(opciones.body ? { "Content-Type": "application/json" } : {}),
		},
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json.data;
}

function esUrlValida(url) {
	if (!url?.trim()) return false;
	try {
		new URL(url.trim());
		return true;
	} catch {
		return false;
	}
}

function claveItemManifiesto(item) {
	return (
		idItemAliExpress(item.url_batch) ??
		idItemAliExpress(item.enlace_original) ??
		(item.id_externo ? String(item.id_externo).trim() : null)
	);
}

const manifiesto = JSON.parse(await readFile(resolve(manifiestoPath), "utf8"));
const contenidoCsv = await readFile(resolve(urlsPath), "utf8");
const items = manifiesto.items ?? [];

const { items: tiendas } = await api("/content/tiendas?status=all&limit=100");
const tienda = tiendas.find((t) => t.id === manifiesto.tiendaId)
	?? tiendas.find((t) => t.data.title === manifiesto.tienda);
const tipo = manifiesto.tipo ?? (tienda ? tipoTiendaAfiliado(tienda) : null);

const { map: mapaAli, formato: formatoCsv } = mapaEnlacesAliExpressPortals(contenidoCsv);
const usarMatchAliExpress = !FORZAR_ORDEN && formatoCsv === "aliexpress-portals" && mapaAli;

let actualizados = 0;
let omitidos = 0;
let sinEnlace = 0;
let despublicados = 0;
let prioridadCero = 0;
let avisos = 0;
let errores = 0;

async function persistirProducto(productId, dataPatch, { republicar = true, despublicar = false } = {}) {
	if (SIMULAR) return null;
	const { item: actual } = await api(`/content/productos/${productId}`);
	await api(`/content/productos/${productId}`, {
		method: "PUT",
		body: JSON.stringify({ data: { ...actual.data, ...dataPatch } }),
	});
	if (despublicar && actual.status === "published") {
		await api(`/content/productos/${productId}/unpublish`, { method: "POST" });
	} else if (republicar && !despublicar && actual.status === "published") {
		await api(`/content/productos/${productId}/publish`, { method: "POST" });
	}
	return actual;
}

async function aplicarEnlace(item, nuevaUrl, indice) {
	const pos = `#${indice} «${item.title ?? item.slug}»`;

	if (!esUrlValida(nuevaUrl)) {
		console.log(`  ⊘ ${pos}: sin enlace de afiliado en el CSV (se mantiene el actual)`);
		sinEnlace++;
		return;
	}

	if (tipo === "aliexpress" && !esEnlaceAfiliadoAliExpress(nuevaUrl)) {
		console.log(`  ! ${pos}: no parece s.click; se aplicará igual`);
		avisos++;
	}
	if (tipo === "amazon" && manifiesto.amazonTagEsperado && !tieneTagAmazon(nuevaUrl, manifiesto.amazonTagEsperado)) {
		console.log(`  ! ${pos}: falta tag=${manifiesto.amazonTagEsperado}; se aplicará igual`);
		avisos++;
	}

	const merged = {
		tipo: item.tipo ?? "generico",
		enlace_afiliado: nuevaUrl.trim(),
	};
	const prioridad = calcularPrioridad(merged, tienda);

	if (SIMULAR) {
		console.log(`• ${pos} (prioridad ${prioridad})\n    ${item.enlace_original || "(vacío)"} → ${nuevaUrl}`);
		actualizados++;
		return;
	}

	try {
		await persistirProducto(item.productId, { enlace_afiliado: nuevaUrl.trim(), priority: prioridad });
		console.log(`✓ ${pos} (prioridad ${prioridad})`);
		actualizados++;
	} catch (e) {
		console.log(`  ✗ ${pos}: ${e.message}`);
		errores++;
	}
}

async function tratarSinTracking(item, fila, indice) {
	const pos = `#${indice} «${item.title ?? item.slug}»`;
	const motivo = clasificarErrorAliExpress(fila.errorNote);
	const nota = fila.errorNote ? ` — ${fila.errorNote}` : "";

	if (motivo === "pais") {
		if (SIMULAR) {
			console.log(`  ⏸ ${pos}: se despublicaría (país objetivo)${nota}`);
		} else {
			try {
				await persistirProducto(item.productId, {}, { republicar: false, despublicar: true });
				console.log(`  ⏸ ${pos}: despublicado (país objetivo)${nota}`);
			} catch (e) {
				console.log(`  ✗ ${pos}: ${e.message}`);
				errores++;
				return;
			}
		}
		despublicados++;
		return;
	}

	const prioridad = motivo === "no-afiliado" ? 0 : 0;
	if (SIMULAR) {
		console.log(`  ⊘ ${pos}: prioridad ${prioridad}${nota}`);
	} else {
		try {
			await persistirProducto(item.productId, { priority: prioridad }, { republicar: true });
			console.log(`  ⊘ ${pos}: prioridad ${prioridad}${nota}`);
		} catch (e) {
			console.log(`  ✗ ${pos}: ${e.message}`);
			errores++;
			return;
		}
	}
	prioridadCero++;
	sinEnlace++;
}

if (usarMatchAliExpress) {
	console.log(`Modo: CSV AliExpress Portals (match por URL) · ${mapaAli.size} filas`);
	let idx = 0;
	for (const item of items) {
		const id = claveItemManifiesto(item);
		idx++;
		if (!id) {
			console.log(`  ✗ #${idx} «${item.title}»: sin id de item en el manifiesto`);
			errores++;
			continue;
		}
		const fila = mapaAli.get(id);
		if (!fila) {
			console.log(`  ? #${idx} «${item.title}» (${id}): no aparece en el CSV`);
			omitidos++;
			continue;
		}
		if (!fila.trackingUrl) {
			await tratarSinTracking(item, fila, idx);
			continue;
		}
		await aplicarEnlace(item, fila.trackingUrl, idx);
	}
} else {
	const urls = leerUrlsEnOrden(contenidoCsv);
	if (urls.length !== items.length) {
		console.error(`✗ Modo por orden: ${urls.length} URL(s) vs ${items.length} en manifiesto.`);
		process.exit(1);
	}
	console.log(`Modo: URLs por orden (${urls.length} filas)`);
	for (let i = 0; i < items.length; i++) {
		await aplicarEnlace(items[i], urls[i], i + 1);
	}
}

console.log(
	`\n${SIMULAR ? "Simulación · " : ""}Actualizados: ${actualizados} · Despublicados (país): ${despublicados} · Prioridad 0: ${prioridadCero} · Sin enlace: ${sinEnlace} · Fuera del CSV: ${omitidos} · Avisos: ${avisos} · Errores: ${errores}`,
);
if ((actualizados || despublicados || prioridadCero) && !SIMULAR) {
	console.log("Siguiente paso: sync-content / deploy en regaloskawaii.");
}
