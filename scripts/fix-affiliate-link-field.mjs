#!/usr/bin/env node
/**
 * Arregla el campo "enlace_afiliado" de Productos cuando se creó en el panel con un
 * tipo distinto de URL (p. ej. "slug"), que rompe el editor de esos productos.
 *
 * 1. Si el campo no es de tipo URL, lo borra y lo vuelve a crear como URL
 *    (EmDash no deja cambiar el tipo; se pierden sus valores, que se rellenan en el paso 2).
 * 2. Rellena el enlace de los productos de tiendas que no son Amazon con la plantilla
 *    de su tienda (AliExpress: https://es.aliexpress.com/item/{id}.html) y vuelve a
 *    publicar los que estaban publicados.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/fix-affiliate-link-field.mjs [--dry-run]
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
			...(opciones.headers ?? {}),
		},
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json.data;
}

async function listarTodo(coleccion) {
	const items = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: "100", status: "all" });
		if (cursor) q.set("cursor", cursor);
		const data = await api(`/content/${coleccion}?${q}`);
		items.push(...data.items);
		cursor = data.nextCursor;
	} while (cursor);
	return items;
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

const CAMPOS = "/schema/collections/productos/fields";
const DEFINICION = {
	slug: "enlace_afiliado",
	label: "Enlace de afiliado (opcional: si está vacío se usa la plantilla de la tienda)",
	type: "url",
};

// 1. Campo
const { items: campos } = await api(CAMPOS);
const campo = campos.find((c) => c.slug === "enlace_afiliado");
if (campo?.type === "url") {
	console.log("✓ El campo enlace_afiliado ya es de tipo URL");
} else if (SIMULAR) {
	console.log(`• Se ${campo ? `borraría el campo (tipo "${campo.type}") y se ` : ""}crearía enlace_afiliado como URL`);
} else {
	if (campo) {
		await api(`${CAMPOS}/enlace_afiliado`, { method: "DELETE" });
		console.log(`✓ Borrado el campo enlace_afiliado (era de tipo "${campo.type}")`);
	}
	const sortOrder = campo?.sortOrder ?? (campos.find((c) => c.slug === "id_externo")?.sortOrder ?? 0) + 1;
	await api(CAMPOS, { method: "POST", body: JSON.stringify({ ...DEFINICION, sortOrder }) });
	console.log("✓ Creado el campo enlace_afiliado como URL");
}

// 2. Valores
const tiendas = await listarTodo("tiendas");
let rellenados = 0;
for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	if (/amazon\./i.test(plantilla) || !plantilla.includes("{id}")) continue; // Amazon usa la plantilla con el tag
	for (const ref of await padres("tiendas", t.id, "productos_tienda")) {
		const { item } = await api(`/content/productos/${ref.id}`);
		if (item.data.enlace_afiliado || !item.data.id_externo) continue;
		const enlace = plantilla.replace("{id}", item.data.id_externo);
		if (SIMULAR) {
			console.log(`• «${item.data.title}» → ${enlace}`);
		} else {
			await api(`/content/productos/${item.id}`, { method: "PUT", body: JSON.stringify({ data: { enlace_afiliado: enlace } }) });
			if (item.status === "published") await api(`/content/productos/${item.id}/publish`, { method: "POST" });
			console.log(`✓ «${item.data.title}» → ${enlace}`);
		}
		rellenados++;
	}
}
console.log(`\n${SIMULAR ? "Se rellenarían" : "Rellenados"}: ${rellenados}`);
