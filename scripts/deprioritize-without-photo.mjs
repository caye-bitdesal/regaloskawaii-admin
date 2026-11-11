#!/usr/bin/env node
/**
 * Pone prioridad 0 a los productos sin foto, para que salgan al final de la web
 * (antes se pasaban a borrador). Cuando fill-photos.mjs les pone foto, recupera
 * la prioridad que les toca.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/deprioritize-without-photo.mjs [--dry-run] [--publish-drafts]
 *   --publish-drafts  publica también los borradores sin foto (p. ej. los que pasó a
 *                     borrador la versión anterior de este script)
 */
import { clienteEmDash } from "./lib/emdash.mjs";
import { tieneFoto } from "./lib/product-priority.mjs";

const SIMULAR = process.argv.includes("--dry-run");
const PUBLICAR_BORRADORES = process.argv.includes("--publish-drafts");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error("✗ Falta EMDASH_TOKEN");
	process.exit(1);
}

const { api, paginas } = clienteEmDash(API, TOKEN);

const productos = await paginas("/content/productos?status=all", "items");
const sinFoto = productos.filter((p) => !tieneFoto(p.data));
const aBajar = sinFoto.filter((p) => p.data.priority !== 0);
const aPublicar = PUBLICAR_BORRADORES ? sinFoto.filter((p) => p.status !== "published") : [];

console.log(`EmDash: ${API}${SIMULAR ? " (simulación)" : ""}`);
console.log(`Productos: ${productos.length} · Sin foto: ${sinFoto.length} · A prioridad 0: ${aBajar.length}${PUBLICAR_BORRADORES ? ` · Borradores a publicar: ${aPublicar.length}` : ""}\n`);

let bajados = 0;
let publicados = 0;
for (const p of new Set([...aBajar, ...aPublicar])) {
	const titulo = p.data.title;
	const bajar = aBajar.includes(p);
	const publicar = p.status === "published" || aPublicar.includes(p);
	if (SIMULAR) {
		console.log(`• «${titulo}»${bajar ? ` (prioridad ${p.data.priority ?? "—"} → 0)` : ""}${aPublicar.includes(p) ? " · se publicaría" : ""}`);
		if (bajar) bajados++;
		if (aPublicar.includes(p)) publicados++;
		continue;
	}
	try {
		// PUT parcial: EmDash mezcla los campos que se envían con los que ya hay.
		if (bajar) await api(`/content/productos/${p.id}`, { method: "PUT", body: JSON.stringify({ data: { priority: 0 } }) });
		if (publicar && (bajar || aPublicar.includes(p))) await api(`/content/productos/${p.id}/publish`, { method: "POST" });
		console.log(`✓ «${titulo}»${bajar ? " → prioridad 0" : ""}${aPublicar.includes(p) ? " · publicado" : ""}`);
		if (bajar) bajados++;
		if (aPublicar.includes(p)) publicados++;
	} catch (e) {
		console.log(`✗ «${titulo}»: ${e.message}`);
		process.exitCode = 1;
	}
}
console.log(
	`\n${SIMULAR ? "Se bajarían" : "Bajados"} a prioridad 0: ${bajados}${PUBLICAR_BORRADORES ? ` · ${SIMULAR ? "Se publicarían" : "Publicados"}: ${publicados}` : ""}`,
);
