#!/usr/bin/env node
/**
 * Pasa a borrador los productos publicados que no tienen foto, para que en la web
 * solo salgan productos con imagen. No borra nada: cuando les pongas foto, vuelve a
 * publicarlos desde el panel (o con fill-photos y publícalos después).
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/unpublish-without-photo.mjs [--dry-run]
 *   (producción: EMDASH_URL=https://admin.regaloskawaii.es)
 *
 * Token con: content:read, content:write.
 * En producción, al despublicar se avisa a GitHub y la web se reconstruye sola
 * (si el plugin notify-github está configurado).
 */
const SIMULAR = process.argv.includes("--dry-run");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error('✗ Falta EMDASH_TOKEN (en local: curl -X POST "http://localhost:4321/_emdash/api/setup/dev-bypass?token=1")');
	process.exit(1);
}

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, {
		...opciones,
		headers: { Authorization: `Bearer ${TOKEN}`, ...(opciones.headers ?? {}) },
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json.data;
}

const publicados = [];
let cursor;
do {
	const q = new URLSearchParams({ limit: "100", status: "published" });
	if (cursor) q.set("cursor", cursor);
	const data = await api(`/content/productos?${q}`);
	publicados.push(...data.items);
	cursor = data.nextCursor;
} while (cursor);

const tieneFoto = (img) => Boolean(img && (img.src || img.id || img.meta?.storageKey));
const sinFoto = publicados.filter((p) => !tieneFoto(p.data?.imagen));

console.log(`EmDash: ${API}${SIMULAR ? " (simulación)" : ""}`);
console.log(`Publicados: ${publicados.length} · Sin foto: ${sinFoto.length}\n`);

let hechos = 0;
for (const p of sinFoto) {
	if (SIMULAR) {
		console.log(`• «${p.data.title}»`);
		continue;
	}
	try {
		await api(`/content/productos/${p.id}/unpublish`, { method: "POST" });
		console.log(`✓ «${p.data.title}» → borrador`);
		hechos++;
	} catch (e) {
		console.log(`✗ «${p.data.title}»: ${e.message}`);
		process.exitCode = 1;
	}
}
console.log(`\n${SIMULAR ? `Se pasarían a borrador: ${sinFoto.length}` : `Pasados a borrador: ${hechos}`} · Quedan publicados con foto: ${publicados.length - sinFoto.length}`);
