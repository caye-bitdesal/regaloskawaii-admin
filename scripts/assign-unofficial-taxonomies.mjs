#!/usr/bin/env node
/**
 * Asigna personajes y marcas a productos ya publicados con tipo «no-oficial»
 * (el import antiguo no guardaba esas taxonomías). Lee un JSON con la misma forma
 * que import-products (personajes, marcas, enlace, id_externo…).
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/assign-unofficial-taxonomies.mjs [fichero.json] [--dry-run]
 *
 * Por defecto fichero: datos/pendientes-no-oficiales.json
 * Solo toca productos cuyo tipo en EmDash es no-oficial (salvo --all-types).
 * Añade términos que falten; no quita los que ya tengan.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const SIMULAR = args.includes("--dry-run");
const TODOS_TIPOS = args.includes("--all-types");
const fichero = args.find((a) => !a.startsWith("--")) ?? "datos/pendientes-no-oficiales.json";
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
			...(opciones.headers ?? {}),
		},
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json.data;
}

const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const clave = (s) => sinAcentos(String(s)).toLowerCase().trim();
const slugify = (s) =>
	sinAcentos(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/, "");

function analizarEnlace(url) {
	try {
		const u = new URL(url);
		const m =
			u.pathname.match(/\/item\/(\d+)\.html/) ??
			u.search.match(/productIds=(\d+)/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

function indiceTerminos({ terms }) {
	const aplanar = (items) => items.flatMap((t) => [t, ...aplanar(t.children ?? [])]);
	return new Map(
		aplanar(terms).flatMap((t) => [
			[clave(t.slug), t],
			[clave(t.label), t],
		]),
	);
}

function resolverTerminos(valores, indice, nombreTax) {
	const ids = [];
	for (const valor of valores ?? []) {
		const term = indice.get(clave(valor)) ?? indice.get(clave(slugify(valor)));
		if (!term) throw new Error(`no existe ${nombreTax} «${valor}»`);
		ids.push(term.id);
	}
	return ids;
}

async function añadirTerminos(productoId, taxonomia, nuevosIds) {
	if (!nuevosIds.length) return false;
	const { terms: actuales } = await api(`/content/productos/${productoId}/terms/${taxonomia}`);
	const actualesIds = new Set(actuales.map((t) => t.id));
	const faltan = nuevosIds.filter((id) => !actualesIds.has(id));
	if (!faltan.length) return false;
	const termIds = [...actuales.map((t) => t.id), ...faltan];
	if (SIMULAR) return true;
	await api(`/content/productos/${productoId}/terms/${taxonomia}`, {
		method: "POST",
		body: JSON.stringify({ termIds }),
	});
	return true;
}

const raw = JSON.parse(await readFile(resolve(fichero), "utf8"));
const lista = Array.isArray(raw) ? raw : raw.productos;
if (!Array.isArray(lista)) {
	console.error('✗ El fichero debe ser una lista o { "productos": [...] }');
	process.exit(1);
}

const [personajes, marcas] = await Promise.all([
	api("/taxonomies/personaje/terms"),
	api("/taxonomies/marca/terms"),
]);
const idxPersonaje = indiceTerminos(personajes);
const idxMarca = indiceTerminos(marcas);

const productos = [];
let cursor;
do {
	const q = new URLSearchParams({ limit: "100", status: "all" });
	if (cursor) q.set("cursor", cursor);
	const data = await api(`/content/productos?${q}`);
	productos.push(...data.items);
	cursor = data.nextCursor;
} while (cursor);

const porIdExterno = new Map(
	productos.filter((p) => p.data?.id_externo).map((p) => [clave(p.data.id_externo), p]),
);

console.log(`EmDash: ${API}${SIMULAR ? " (simulación)" : ""} · fichero: ${fichero}`);
let actualizados = 0;
let sinProducto = 0;
let omitidosTipo = 0;
let yaCompletos = 0;
let errores = 0;

for (const entrada of lista) {
	const titulo = entrada.nombre ?? "?";
	const idExterno = entrada.id_externo ?? (entrada.enlace ? analizarEnlace(entrada.enlace) : null);
	if (!idExterno) {
		console.log(`  ! «${titulo}»: sin id_externo ni enlace reconocible`);
		errores++;
		continue;
	}
	const item = porIdExterno.get(clave(idExterno));
	if (!item) {
		console.log(`  ? «${titulo}» (${idExterno}): no está en EmDash`);
		sinProducto++;
		continue;
	}
	if (!TODOS_TIPOS && item.data.tipo !== "no-oficial") {
		omitidosTipo++;
		continue;
	}
	if (!entrada.personajes?.length && !entrada.marcas?.length) continue;

	try {
		const idsPersonaje = resolverTerminos(entrada.personajes, idxPersonaje, "personaje");
		const idsMarca = resolverTerminos(entrada.marcas, idxMarca, "marca");
		const cambioP = await añadirTerminos(item.id, "personaje", idsPersonaje);
		const cambioM = await añadirTerminos(item.id, "marca", idsMarca);
		if (!cambioP && !cambioM) {
			yaCompletos++;
			continue;
		}
		if (!SIMULAR && item.status === "published") {
			await api(`/content/productos/${item.id}/publish`, { method: "POST" });
		}
		const partes = [];
		if (cambioP && entrada.personajes?.length) partes.push(entrada.personajes.join(", "));
		if (cambioM && entrada.marcas?.length) partes.push(`marca: ${entrada.marcas.join(", ")}`);
		console.log(`${SIMULAR ? "•" : "✓"} «${item.data.title}» → ${partes.join(" · ")}`);
		actualizados++;
	} catch (e) {
		console.log(`  ✗ «${titulo}»: ${e.message}`);
		errores++;
	}
}

console.log(
	`\n${SIMULAR ? "Se actualizarían" : "Actualizados"}: ${actualizados} · Ya con taxonomía: ${yaCompletos} · Otro tipo (omitidos): ${omitidosTipo} · Sin ficha en EmDash: ${sinProducto} · Errores: ${errores}`,
);
if (actualizados && !SIMULAR) {
	console.log("Siguiente paso: en regaloskawaii, npm run sync-content (o el workflow de deploy del admin).");
}
