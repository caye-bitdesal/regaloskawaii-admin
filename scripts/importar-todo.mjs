#!/usr/bin/env node
/**
 * Busca (opcional) e importa productos en una sola orden, y los deja listos en la web.
 *
 *   1. (con --buscar) busca productos con la API de afiliados de AliExpress   search-products.mjs
 *   2. los importa y publica                                                  import-products.mjs --publish
 *
 * import-products completa cada producto de AliExpress antes de guardarlo (foto, enlace de
 * afiliado, precio e historial, con una llamada a la API por cada 20 productos) y lo crea
 * ya con su prioridad: una sola escritura por producto y ninguna pasada por todo el catálogo.
 *
 * fill-photos, fill-affiliate-links, update-prices y deprioritize-without-photo siguen
 * existiendo para el mantenimiento del catálogo ya importado, por separado.
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
 *   Las demás opciones (--cantidad=, --precio-max=, --min-vendidos=…) se pasan a la búsqueda.
 *
 * Variables de entorno: las de .env (se carga solo si existe) o las del workflow:
 *   EMDASH_URL, EMDASH_TOKEN                                          obligatorias
 *   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID para buscar y completar los productos
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
const QUITAR_FONDO = args.includes("--remove-bg");
const IMAGENES = args.find((a) => a.startsWith("--images=")) ?? "--images=images";
const argBuscar = args.find((a) => a === "--buscar" || a.startsWith("--buscar="));
const PROPIAS = ["--dry-run", "--remove-bg"];
const opcionesBusqueda = args.filter(
	(a) => a.startsWith("--") && !PROPIAS.includes(a) && !a.startsWith("--images=") && a !== argBuscar,
);
const ficheros = args.filter((a) => !a.startsWith("--"));

const hayApi = Boolean(process.env.ALIEXPRESS_APP_KEY && process.env.ALIEXPRESS_APP_SECRET);

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

function imprimirResumen() {
	console.log(`\n━━━ Resumen${SIMULAR ? " (simulación)" : ""} ━━━\n${resumen.join("\n")}`);
}

const dry = SIMULAR ? ["--dry-run"] : [];

// 1. Búsqueda
if (argBuscar) {
	const csv = argBuscar.includes("=") ? argBuscar.split("=").slice(1).join("=") : "busquedas/palabras.csv";
	const hoy = new Date().toISOString().slice(0, 10);
	const salida = `datos/busqueda-${hoy}.json`;
	paso("Buscar productos en AliExpress", "search-products.mjs", [csv, `--out=${salida}`, ...opcionesBusqueda], {
		obligatorio: true,
	});
	ficheros.push(salida);
}

// 2. Importar, completar con la API y publicar
for (const f of ficheros) {
	paso(`Importar ${f}`, "import-products.mjs", [f, "--publish", IMAGENES, ...(QUITAR_FONDO ? ["--remove-bg"] : []), ...dry], {
		obligatorio: true,
	});
}

imprimirResumen();
if (resumen.some((l) => l.startsWith("✗"))) process.exitCode = 1;
