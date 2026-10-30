#!/usr/bin/env node
/**
 * Busca productos duplicados (misma tienda e id_externo), se queda con el más antiguo
 * y manda los demás a la papelera del panel (se pueden restaurar desde allí).
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/remove-duplicates.mjs [--dry-run]
 */
const SIMULAR = process.argv.includes("--dry-run");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error("✗ Falta EMDASH_TOKEN");
	process.exit(1);
}

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, { ...opciones, headers: { Authorization: `Bearer ${TOKEN}` } });
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

const productos = await paginas("/content/productos?status=all", "items");
const tiendas = await paginas("/content/tiendas?status=all", "items");
const tiendaDe = new Map();
for (const t of tiendas) {
	for (const p of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) tiendaDe.set(p.id, t.id);
}

const grupos = new Map();
for (const p of productos) {
	const clave = `${tiendaDe.get(p.id) ?? "?"}:${String(p.data.id_externo ?? "").toLowerCase()}`;
	if (!grupos.has(clave)) grupos.set(clave, []);
	grupos.get(clave).push(p);
}

let quitados = 0;
for (const lista of grupos.values()) {
	if (lista.length < 2) continue;
	lista.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
	const [original, ...copias] = lista;
	for (const c of copias) {
		if (SIMULAR) console.log(`• Se quitaría /producto/${c.slug} (se queda /producto/${original.slug})`);
		else {
			await api(`/content/productos/${c.id}`, { method: "DELETE" });
			console.log(`✓ A la papelera /producto/${c.slug} (se queda /producto/${original.slug})`);
		}
		quitados++;
	}
}
console.log(`\n${SIMULAR ? "Se quitarían" : "Quitados"}: ${quitados} duplicado(s)`);
