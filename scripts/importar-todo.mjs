#!/usr/bin/env node
/**
 * Hace en una sola orden todo lo necesario para que unos productos salgan bien en la web:
 *
 *   0. (con --buscar) busca productos con la API de afiliados de AliExpress   search-products.mjs
 *   1. los importa y los publica                                              import-products.mjs --publish
 *   2. pone los enlaces de afiliado                                           fill-affiliate-links.mjs
 *   3. pone fotos a los que no tienen                                         fill-photos.mjs --publish
 *   4. actualiza precios e historial                                          update-prices.mjs
 *   5. deja al final (prioridad 0) los que siguen sin foto                    deprioritize-without-photo.mjs
 *
 * Si la importación falla, se para. Si falla un paso posterior, sigue con los demás y
 * al final dice cuáles fallaron (se pueden repetir: todos los pasos retoman donde iban).
 *
 * Uso:
 *   npm run importar -- datos/top-kawaii-16-11.json         importa un fichero que ya tienes
 *   npm run importar -- --buscar                            busca con busquedas/palabras.csv e importa
 *   npm run importar -- --buscar=busquedas/squishy.csv      busca con otro CSV e importa
 *   npm run importar -- … --dry-run                         lo simula todo, sin escribir nada
 *
 * Opciones:
 *   --images=DIR      carpeta de fotos locales (por defecto images/)
 *   --remove-bg       quita el fondo de las fotos nuevas (necesita onnxruntime-node y sharp)
 *   --sin-precios     se salta el paso 4
 *   Las demás opciones (--cantidad=, --precio-max=, --min-vendidos=…) se pasan a la búsqueda.
 *
 * Variables de entorno: las de .env (se carga solo si existe) o las del workflow:
 *   EMDASH_URL, EMDASH_TOKEN                                          obligatorias
 *   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID para búsqueda, enlaces, fotos y precios
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(DIR, "..");
if (existsSync(resolve(RAIZ, ".env"))) process.loadEnvFile(resolve(RAIZ, ".env"));

const args = process.argv.slice(2);
const SIMULAR = args.includes("--dry-run");
const SIN_PRECIOS = args.includes("--sin-precios");
const QUITAR_FONDO = args.includes("--remove-bg");
const IMAGENES = args.find((a) => a.startsWith("--images=")) ?? "--images=images";
const argBuscar = args.find((a) => a === "--buscar" || a.startsWith("--buscar="));
const PROPIAS = ["--dry-run", "--sin-precios", "--remove-bg"];
const opcionesBusqueda = args.filter(
	(a) => a.startsWith("--") && !PROPIAS.includes(a) && !a.startsWith("--images=") && a !== argBuscar,
);
const ficheros = args.filter((a) => !a.startsWith("--"));

const hayApi = Boolean(process.env.ALIEXPRESS_APP_KEY && process.env.ALIEXPRESS_APP_SECRET);
const hayTracking = Boolean(process.env.ALIEXPRESS_TRACKING_ID?.trim());

if (!process.env.EMDASH_TOKEN) salir("Falta EMDASH_TOKEN (en .env o en el entorno)");
if (!argBuscar && !ficheros.length) {
	salir("Indica qué importar: npm run importar -- datos/fichero.json  (o --buscar para buscar primero)");
}
if (argBuscar && !hayApi) salir("Para --buscar hacen falta ALIEXPRESS_APP_KEY y ALIEXPRESS_APP_SECRET");

function salir(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

const resumen = [];

/** Ejecuta un script de esta carpeta con las mismas variables de entorno. Devuelve true si acabó bien. */
function paso(titulo, script, scriptArgs = [], { obligatorio = false } = {}) {
	console.log(`\n━━━ ${titulo} ━━━`);
	const r = spawnSync(process.execPath, [resolve(DIR, script), ...scriptArgs], {
		cwd: RAIZ,
		stdio: "inherit",
		env: process.env,
	});
	const ok = r.status === 0;
	resumen.push(`${ok ? "✓" : "✗"} ${titulo}`);
	if (!ok && obligatorio) {
		console.error(`\n✗ «${titulo}» ha fallado; no sigo.`);
		imprimirResumen();
		process.exit(1);
	}
	return ok;
}

function omitir(titulo, motivo) {
	resumen.push(`– ${titulo} (${motivo})`);
}

function imprimirResumen() {
	console.log(`\n━━━ Resumen${SIMULAR ? " (simulación)" : ""} ━━━\n${resumen.join("\n")}`);
}

const dry = SIMULAR ? ["--dry-run"] : [];

// 0. Búsqueda
if (argBuscar) {
	const csv = argBuscar.includes("=") ? argBuscar.split("=").slice(1).join("=") : "busquedas/palabras.csv";
	const hoy = new Date().toISOString().slice(0, 10);
	const salida = `datos/busqueda-${hoy}.json`;
	paso("Buscar productos en AliExpress", "search-products.mjs", [csv, `--out=${salida}`, ...opcionesBusqueda], {
		obligatorio: true,
	});
	ficheros.push(salida);
}

// 1. Importar y publicar
for (const f of ficheros) {
	paso(`Importar ${f}`, "import-products.mjs", [f, "--publish", IMAGENES, ...(QUITAR_FONDO ? ["--remove-bg"] : []), ...dry], {
		obligatorio: true,
	});
}

// 2. Enlaces de afiliado
if (hayApi && hayTracking) paso("Enlaces de afiliado", "fill-affiliate-links.mjs", dry);
else omitir("Enlaces de afiliado", "faltan las claves de AliExpress o el Tracking ID");

// 3. Fotos
paso("Fotos", "fill-photos.mjs", ["--publish", IMAGENES, ...(QUITAR_FONDO ? ["--remove-bg"] : []), ...dry]);

// 4. Precios
if (SIN_PRECIOS) omitir("Precios", "--sin-precios");
else if (hayApi) paso("Precios", "update-prices.mjs", dry);
else omitir("Precios", "faltan las claves de AliExpress");

// 5. Los que siguen sin foto, al final
paso("Prioridad de los productos sin foto", "deprioritize-without-photo.mjs", dry);

imprimirResumen();
if (resumen.some((l) => l.startsWith("✗"))) process.exitCode = 1;
