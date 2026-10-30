#!/usr/bin/env node
/**
 * Pasa «Papelería» de colección a categoría:
 *  1. A cada producto de la colección «papeleria» le añade la categoría «papeleria».
 *  2. Borra la colección «papeleria» (a la papelera y luego definitivamente).
 *
 * Se puede ejecutar varias veces: lo que ya está hecho se salta.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/move-papeleria-to-category.mjs [--dry-run]
 */
const SIMULAR = process.argv.includes("--dry-run");
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

/** Todos los productos que apuntan a una entrada (la API devuelve los resultados por páginas). */
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

const { items: colecciones } = await api("/content/colecciones?status=all&limit=100");
const coleccion = colecciones.find((c) => c.slug === "papeleria");

const { terms } = await api("/taxonomies/categoria/terms");
const termino = terms.find((t) => t.slug === "papeleria");
if (!termino) {
	console.error("✗ No existe la categoría «papeleria». Aplica antes el seed (ver docs/import-products.md)");
	process.exit(1);
}

if (!coleccion) {
	console.log("✓ La colección «papeleria» ya no existe; nada que hacer");
	process.exit(0);
}

// 1. Productos de la colección → categoría
const parents = await padres("colecciones", coleccion.id, "productos_colecciones");
let movidos = 0;
for (const p of parents) {
	const { terms: actuales } = await api(`/content/productos/${p.id}/terms/categoria`);
	const titulo = p.data?.title ?? p.slug ?? p.id;
	if (actuales.some((t) => t.id === termino.id)) {
		console.log(`↷ «${titulo}» ya tiene la categoría Papelería`);
		continue;
	}
	if (SIMULAR) {
		console.log(`• «${titulo}» → categoría Papelería`);
	} else {
		await api(`/content/productos/${p.id}/terms/categoria`, {
			method: "POST",
			body: JSON.stringify({ termIds: [...actuales.map((t) => t.id), termino.id] }),
		});
		console.log(`✓ «${titulo}» → categoría Papelería`);
	}
	movidos++;
}

// 2. Borrar la colección
if (SIMULAR) {
	console.log(`• Se borraría la colección «${coleccion.data.title}»`);
} else {
	await api(`/content/colecciones/${coleccion.id}`, { method: "DELETE" });
	await api(`/content/colecciones/${coleccion.id}/permanent`, { method: "DELETE" });
	console.log(`✓ Borrada la colección «${coleccion.data.title}»`);
}
console.log(`\n${SIMULAR ? "Se moverían" : "Movidos"}: ${movidos} producto(s)`);
