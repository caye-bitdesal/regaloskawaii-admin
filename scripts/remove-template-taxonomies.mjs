#!/usr/bin/env node
/**
 * Borra las taxonomías que EmDash crea por defecto para el blog («Categories» y «Tags»,
 * de la colección posts, que este proyecto no usa), para que en el panel solo quede
 * «Categorías» (la de productos). Ejecútalo una vez en local y otra en producción.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/remove-template-taxonomies.mjs
 */
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

const { taxonomies } = await api("/taxonomies");
for (const nombre of ["category", "tag"]) {
	const t = taxonomies.find((x) => x.name === nombre);
	if (!t) {
		console.log(`↷ «${nombre}» ya no existe`);
		continue;
	}
	const otras = (t.collections ?? []).filter((c) => c !== "posts");
	if (otras.length) {
		console.log(`↷ «${t.label}» se usa en ${otras.join(", ")}; no se borra`);
		continue;
	}
	await api(`/taxonomies/${nombre}`, { method: "DELETE" });
	console.log(`✓ Borrada «${t.label}»`);
}
