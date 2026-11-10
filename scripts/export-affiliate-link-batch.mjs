#!/usr/bin/env node
/**
 * Lista productos de una tienda cuyo enlace_afiliado no tiene formato de afiliado
 * (AliExpress: debe ser s.click…; Amazon: debe llevar tag=).
 *
 * Genera dos ficheros con el mismo orden de filas:
 *   - CSV con cabecera «URL» (para el generador por lotes de la plataforma)
 *   - JSON con productId y enlace_original (manifiesto para apply-affiliate-link-batch.mjs)
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/export-affiliate-link-batch.mjs "AliExpress"
 *   EMDASH_TOKEN=ec_pat_… node scripts/export-affiliate-link-batch.mjs "Amazon España" --out-dir=datos
 *
 * Opciones:
 *   --out-dir=DIR   Carpeta de salida (por defecto: datos)
 *   --prefix=NOMBRE Prefijo de fichero (por defecto: affiliate-batch-<slug-tienda>-<fecha>)
 */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { clave, necesitaEnlaceAfiliado, tipoTiendaAfiliado } from "./lib/affiliate-link-check.mjs";
import { clienteEmDash } from "./lib/emdash.mjs";

const argv = process.argv.slice(2);
const nombreTienda = argv.find((a) => !a.startsWith("--"));
if (!nombreTienda) {
	console.error('Uso: node scripts/export-affiliate-link-batch.mjs "<nombre tienda>" [--out-dir=datos] [--prefix=…]');
	process.exit(1);
}

const outDir = resolve(argv.find((a) => a.startsWith("--out-dir="))?.slice(10) ?? "datos");
const prefixOpt = argv.find((a) => a.startsWith("--prefix="))?.slice(9);
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error("✗ Falta EMDASH_TOKEN");
	process.exit(1);
}

// Cliente con pausa, reintentos y páginas pequeñas para no saturar EmDash (lib/emdash.mjs).
const { api } = clienteEmDash(API, TOKEN);

async function padres(coleccion, id, relacion) {
	const items = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: "100" });
		if (cursor) q.set("cursor", cursor);
		const data = await api(`/content/${coleccion}/${id}/references/${relacion}/parents?${q}`);
		items.push(...data.parents);
		cursor = data.nextCursor;
	} while (cursor);
	return items;
}

const { items: tiendas } = await api("/content/tiendas?status=all&limit=100");
const tienda = tiendas.find((t) => clave(t.data.title) === clave(nombreTienda))
	?? tiendas.find((t) => clave(t.data.title).includes(clave(nombreTienda)));

if (!tienda) {
	console.error(`✗ No hay tienda «${nombreTienda}». Disponibles: ${tiendas.map((t) => t.data.title).join(", ")}`);
	process.exit(1);
}

const tipo = tipoTiendaAfiliado(tienda);
if (!tipo) {
	console.error(`✗ La tienda «${tienda.data.title}» no es AliExpress ni Amazon (plantilla: ${tienda.data.plantilla_url ?? "?"})`);
	process.exit(1);
}

const refs = await padres("tiendas", tienda.id, "productos_tienda");
const pendientes = [];

for (const ref of refs) {
	const { item } = await api(`/content/productos/${ref.id}`);
	const necesita = necesitaEnlaceAfiliado(tienda, item);
	if (!necesita) continue;
	pendientes.push({
		productId: item.id,
		slug: item.slug,
		title: item.data.title,
		tipoProducto: item.data.tipo ?? "generico",
		id_externo: item.data.id_externo ?? null,
		enlace_original: necesita.enlaceOriginal,
		url_batch: necesita.urlBatch,
	});
}

const fecha = new Date().toISOString().slice(0, 10);
const slugTienda = tienda.slug ?? tienda.id.replace(/^tienda-/, "");
const prefix = prefixOpt ?? `affiliate-batch-${slugTienda}-${fecha}`;
const rutaCsv = resolve(outDir, `${prefix}.csv`);
const rutaJson = resolve(outDir, `${prefix}.json`);

await mkdir(outDir, { recursive: true });

const lineasCsv = ["URL", ...pendientes.map((p) => p.url_batch)];
await writeFile(rutaCsv, `${lineasCsv.join("\n")}\n`, "utf8");

const manifiesto = {
	generatedAt: new Date().toISOString(),
	emdashUrl: API,
	tienda: tienda.data.title,
	tiendaId: tienda.id,
	tipo,
	...(tipo === "amazon" ? { amazonTagEsperado: tienda.data.tag_web ?? "" } : {}),
	count: pendientes.length,
	csvFile: `${prefix}.csv`,
	items: pendientes.map(({ productId, slug, title, id_externo, enlace_original, url_batch, tipoProducto }) => ({
		productId,
		slug,
		title,
		id_externo,
		tipo: tipoProducto,
		enlace_original,
		url_batch,
	})),
};
await writeFile(rutaJson, `${JSON.stringify(manifiesto, null, 2)}\n`, "utf8");

console.log(`Tienda: ${tienda.data.title} (${tipo})`);
console.log(`Productos sin enlace de afiliado correcto: ${pendientes.length}`);
console.log(`CSV:  ${rutaCsv}`);
console.log(`JSON: ${rutaJson}`);
if (pendientes.length) {
	console.log("\nSiguiente paso: genera enlaces en la plataforma con el CSV y ejecuta:");
	console.log(`  node scripts/apply-affiliate-link-batch.mjs ${rutaJson} <fichero-urls-generadas.csv>`);
}
