#!/usr/bin/env node
/**
 * Añade la opción «no-oficial» al campo «Tipo» de los productos en una base de datos que
 * ya existe (local o producción), como en seed/seed.json. Los productos con ese tipo
 * salen en la web con el aviso «No oficial · no podemos garantizar su autenticidad».
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/add-unofficial-type.mjs
 *   (producción: EMDASH_URL=https://admin.regaloskawaii.es)
 *
 * Token con: schema:read y schema:manage (en local, el de dev-bypass sirve).
 * Se puede ejecutar varias veces.
 */
const API = (process.env.EMDASH_URL || "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;
if (!TOKEN) {
	console.error('✗ Falta EMDASH_TOKEN (en local: curl -X POST "http://localhost:4321/_emdash/api/setup/dev-bypass?token=1")');
	process.exit(1);
}

async function api(ruta, opciones = {}) {
	const res = await fetch(`${API}/_emdash/api${ruta}`, {
		...opciones,
		headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(opciones.headers ?? {}) },
	});
	const json = await res.json().catch(() => ({}));
	if (!json.success) throw new Error(`${opciones.method ?? "GET"} ${ruta}: ${json.error?.message ?? `HTTP ${res.status}`}`);
	return json.data;
}

const respuesta = await api("/schema/collections/productos/fields/tipo");
const campo = respuesta.item ?? respuesta.field ?? respuesta;
const validacion = campo.validation ?? {};
const opciones = validacion.options ?? [];
if (!opciones.includes("oficial") || !opciones.includes("generico")) {
	// Nunca se guarda una lista que podría borrar las opciones que ya existen.
	console.error(`✗ No he podido leer bien las opciones actuales del campo «Tipo» (${JSON.stringify(opciones)}); no cambio nada.`);
	process.exit(1);
}
if (opciones.includes("no-oficial")) {
	console.log(`✓ El campo «Tipo» ya admite no-oficial (${opciones.join(", ")})`);
	process.exit(0);
}
await api("/schema/collections/productos/fields/tipo", {
	method: "PUT",
	body: JSON.stringify({ validation: { ...validacion, options: [...opciones, "no-oficial"] } }),
});
console.log(`✓ Añadida la opción no-oficial al campo «Tipo» (${[...opciones, "no-oficial"].join(", ")}) en ${API}`);
