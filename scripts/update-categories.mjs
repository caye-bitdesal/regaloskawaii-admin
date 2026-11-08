#!/usr/bin/env node
/**
 * Pone al día las categorías de una base de datos que ya existe (local o producción),
 * igual que en seed/seed.json:
 *   1. convierte «Categorías» en jerárquica (con subcategorías),
 *   2. crea las categorías y subcategorías que falten y coloca cada una bajo su padre,
 *   3. con --assign, asigna subcategoría a los productos según palabras de su título
 *      (taza → Tazas, llavero → Llaveros…). Sin --assign solo enseña lo que haría.
 *
 * Un producto en una subcategoría sale también en su categoría padre en la web,
 * así que basta con asignarle la más concreta. No quita ninguna categoría que ya tenga.
 * Se puede ejecutar varias veces.
 *
 * Uso:
 *   EMDASH_TOKEN=ec_pat_… node scripts/update-categories.mjs [--dry-run] [--assign]
 *   (producción: EMDASH_URL=https://admin.regaloskawaii.es)
 *
 * Token con: content:read, content:write, taxonomies:manage.
 */
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const SIMULAR = args.includes("--dry-run");
const ASIGNAR = args.includes("--assign");
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

// ── 1 y 2: estructura, sacada del seed para no tenerla en dos sitios ─────────────────
const seed = JSON.parse(await readFile(new URL("../seed/seed.json", import.meta.url), "utf8"));
const deseadas = seed.taxonomies.find((t) => t.name === "categoria").terms; // padres antes que hijos

const respuestaDef = await api("/taxonomies/categoria");
const def = respuestaDef.taxonomy ?? respuestaDef;
const LOCALE = def.locale ?? "es"; // los términos nuevos, en el mismo idioma que los de siempre
if (!def.hierarchical) {
	console.log(`${SIMULAR ? "• Se convertiría" : "✓ Convertida"} «Categorías» en jerárquica`);
	if (!SIMULAR) await api("/taxonomies/categoria", { method: "PUT", body: JSON.stringify({ hierarchical: true }) });
}

const aplanar = (terms) => terms.flatMap((t) => [t, ...aplanar(t.children ?? [])]);
const leerTerminos = async () =>
	new Map(aplanar((await api(`/taxonomies/categoria/terms?locale=${LOCALE}`)).terms).map((t) => [t.slug, t]));
let terminos = await leerTerminos();

for (const d of deseadas) {
	const actual = terminos.get(d.slug);
	const padre = d.parent ? terminos.get(d.parent) : null;
	const padreId = padre ? padre.id : null;
	if (!actual) {
		const nombrePadre = deseadas.find((x) => x.slug === d.parent)?.label;
		console.log(`${SIMULAR ? "• Se crearía" : "✓ Creada"} ${nombrePadre ? `${nombrePadre} › ` : ""}${d.label}`);
		if (!SIMULAR) {
			await api("/taxonomies/categoria/terms", {
				method: "POST",
				body: JSON.stringify({ slug: d.slug, label: d.label, parentId: padreId, locale: LOCALE }),
			});
			terminos = await leerTerminos();
		}
		continue;
	}
	// parentId puede venir como id o como translationGroup del padre
	const padreActual = actual.parentId ?? null;
	const bienColocada = d.parent ? padreActual === padre?.id || padreActual === padre?.translationGroup : !padreActual;
	if (!bienColocada && (padre || !d.parent)) {
		console.log(`${SIMULAR ? "• Se movería" : "✓ Movida"} ${d.label} → ${d.parent ?? "primer nivel"}`);
		if (!SIMULAR) await api(`/taxonomies/categoria/terms/${d.slug}`, { method: "PUT", body: JSON.stringify({ parentId: padreId }) });
	}
}
if (!SIMULAR) terminos = await leerTerminos();

// ── 3: subcategoría según el título ────────────────────────────────────────────────
// Se compara sin tildes y en minúsculas. Dentro de un mismo grupo gana la primera regla.
const REGLAS = [
	["tazas", /\b(taza|tazon|mug)s?\b/],
	["botellas", /\b(botella|termo|vaso)s?\b/],
	["lamparas", /\b(lampara|luz nocturna|night ?light)s?\b/],
	["mochilas", /\b(mochila|bolso|bolsa|rinonera|bandolera)s?\b/],
	["llaveros", /\b(llavero)s?\b/],
	["auriculares", /\b(auricular|cascos)e?s?\b/],
	["sudaderas", /\b(sudadera|hoodie)s?\b/],
	["camisetas", /\b(camiseta)s?\b/],
	["faldas", /\b(falda)s?\b/],
	["pijamas-kigurumis", /\b(pijama|kigurumi|onesie)s?\b/],
	["pegatinas", /\b(pegatina|sticker)s?\b/],
	["boligrafos", /\b(boligrafo|boli|rotulador|marcador)(e?s)?\b/],
	["libretas", /\b(libreta|cuaderno|agenda|bloc)s?\b/],
	["libros", /\b(libro|manga)s?\b/],
];
const SQUISHY = [
	["squishy-gigantes", /\b(gigante|jumbo|xxl)s?\b/],
	["squishy-comida", /\b(comida|pastel|donut|dona|fruta|helado|mochi|pan|sushi|tarta|galleta|cupcake|bubble tea|boba)s?\b/],
	["squishy-animales", /\b(gato|perro|conejo|oso|panda|unicornio|animal|axolotl|pinguino|rana|dinosaurio)(e?s)?\b/],
];
const normal = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const productos = [];
let cursor;
do {
	const q = new URLSearchParams({ limit: "100", status: "all" });
	if (cursor) q.set("cursor", cursor);
	const data = await api(`/content/productos?${q}`);
	productos.push(...data.items);
	cursor = data.nextCursor;
} while (cursor);

const subcategorias = new Set(deseadas.filter((d) => d.parent).map((d) => d.slug));
let asignados = 0;
let sinCategoria = 0;
console.log(`\nSubcategorías por título${ASIGNAR && !SIMULAR ? "" : " (sin --assign solo se muestran)"}:`);
for (const p of productos) {
	const titulo = normal(p.data.title ?? "");
	const { terms: actuales } = await api(`/content/productos/${p.id}/terms/categoria`);
	const tiene = new Set(actuales.map((t) => t.slug));
	if (actuales.length === 0) sinCategoria++;
	if ([...tiene].some((s) => subcategorias.has(s))) continue; // ya tiene subcategoría

	const nuevas = REGLAS.filter(([, re]) => re.test(titulo)).map(([slug]) => slug);
	if (/\bisbn\b/.test(titulo) || /^\d{9}[\dX]$/i.test(p.data.id_externo ?? "")) nuevas.push("libros"); // ASIN de libro = ISBN-10
	if (tiene.has("squishy") || /\bsquish/.test(titulo)) {
		const s = SQUISHY.find(([, re]) => re.test(titulo));
		if (s) nuevas.push(s[0]);
	}
	// En simulación las subcategorías aún no existen: se usan las del seed.
	const existe = (s) => terminos.has(s) || (SIMULAR && deseadas.some((d) => d.slug === s));
	const nombre = (s) => terminos.get(s)?.label ?? deseadas.find((d) => d.slug === s).label;
	const aAnadir = [...new Set(nuevas)].filter((s) => !tiene.has(s) && existe(s));
	if (!aAnadir.length) continue;

	console.log(`  ${ASIGNAR && !SIMULAR ? "✓" : "•"} «${p.data.title}» → ${aAnadir.map(nombre).join(", ")}`);
	asignados++;
	if (ASIGNAR && !SIMULAR) {
		const termIds = [...actuales.map((t) => t.id), ...aAnadir.map((s) => terminos.get(s).id)];
		await api(`/content/productos/${p.id}/terms/categoria`, { method: "POST", body: JSON.stringify({ termIds }) });
	}
}
console.log(
	`\n${asignados} producto(s) ${ASIGNAR && !SIMULAR ? "con subcategoría nueva" : "recibirían subcategoría"} · ${sinCategoria} sin ninguna categoría de ${productos.length}`,
);
if (ASIGNAR && !SIMULAR && asignados) console.log("Para verlo en la web: lanza «Build and deploy» en GitHub Actions (asignar categorías no avisa a GitHub).");
