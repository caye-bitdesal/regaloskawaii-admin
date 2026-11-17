#!/usr/bin/env node
/**
 * Busca productos en AliExpress a partir de una lista de palabras clave (CSV) y genera un
 * JSON listo para import-products.mjs. No crea nada en EmDash: revisa el JSON (sobre todo
 * los nombres, que vienen de la traducción automática de AliExpress) y luego impórtalo.
 *
 * Uso:
 *   npm run search                       (usa busquedas/palabras.csv)
 *   npm run search -- otro.csv [opciones]
 *
 * Variables de entorno (en .env):
 *   ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET   obligatorias
 *   ALIEXPRESS_TRACKING_ID                      para que cada producto traiga su enlace de afiliado
 *   EMDASH_URL, EMDASH_TOKEN                    opcionales: si están, se saltan los productos
 *                                               que ya existen en EmDash (o en su papelera)
 *
 * Formato del CSV (separado por comas, punto y coma o tabuladores; con cabecera):
 *   palabra,categoria,cantidad,precio_min,precio_max
 *   squishy gato,squishy-animales,8,,15
 * Solo «palabra» es obligatoria. Sin categoría, cada producto se clasifica por su nombre
 * (scripts/lib/clasificar.mjs). Es el mismo CSV que lee la tarea semanal «Top kawaii». También vale el CSV que descarga el Planificador de
 * palabras clave de Google Ads (usa su columna «Keyword»; la categoría va con --categoria=).
 *
 * Opciones:
 *   --out=RUTA            JSON de salida (por defecto busquedas/resultados/busqueda-AAAA-MM-DD.json).
 *                         Si lo guardas en datos/, el workflow de GitHub lo importa al hacer push.
 *   --categoria=SLUG      categoría para las filas que no la traen
 *   --cantidad=N          productos por palabra (por defecto 20)
 *   --min-vendidos=N      ventas mínimas en los últimos 30 días (por defecto 20)
 *   --min-valoracion=N    % mínimo de valoraciones positivas (por defecto 90)
 *   --precio-max=N        precio máximo en euros para todas las filas (por defecto 40)
 *   --paginas=N           páginas de 50 resultados a mirar por palabra (por defecto 2)
 *   --permitir-marcas     no descartar títulos con personajes o marcas registradas
 *                         (Disney, Sanrio, Pokémon…: en AliExpress suelen ser copias no oficiales)
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { apiAliExpressConfigurada, buscarAliExpress, trackingIdConfigurado } from "./lib/aliexpress-api.mjs";
import { clasificar } from "./lib/clasificar.mjs";
import { clienteEmDash } from "./lib/emdash.mjs";

const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => args.find((a) => a.startsWith(`--${nombre}=`))?.split("=").slice(1).join("=") ?? porDefecto;
const fichero = args.find((a) => !a.startsWith("--")) ?? "busquedas/palabras.csv";
const hoy = new Date().toISOString().slice(0, 10);
const SALIDA = resolve(opcion("out", `busquedas/resultados/busqueda-${hoy}.json`));
const CATEGORIA = opcion("categoria");
const CANTIDAD = Number(opcion("cantidad", 20));
const MIN_VENDIDOS = Number(opcion("min-vendidos", 20));
const MIN_VALORACION = Number(opcion("min-valoracion", 90));
const PRECIO_MAX = Number(opcion("precio-max", 40));
const PAGINAS = Math.max(1, Number(opcion("paginas", 2)));
const PERMITIR_MARCAS = args.includes("--permitir-marcas");

function salir(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

if (!existsSync(fichero)) salir(`No existe ${fichero}. Uso: npm run search -- busquedas/palabras.csv [--out=datos/….json]`);
if (!apiAliExpressConfigurada()) salir("Faltan ALIEXPRESS_APP_KEY y ALIEXPRESS_APP_SECRET en .env");
if (!trackingIdConfigurado()) console.log("! Sin ALIEXPRESS_TRACKING_ID: los productos no traerán enlace de afiliado (prioridad 0).");

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const sinAcentos = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
const clave = (s) => sinAcentos(s).toLowerCase().trim();

// ---------- CSV ----------

async function leerCsv(ruta) {
	const buffer = await readFile(ruta);
	// El Planificador de Google Ads exporta en UTF-16 con BOM
	let texto = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
	texto = texto.replace(/^﻿/, "");
	const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
	// La cabecera es la primera línea con «palabra» o «Keyword» (el Planificador pone dos líneas de título antes)
	const iCabecera = lineas.findIndex((l) => /(^|[\t,;"])\s*(palabra|keyword)\s*("|[\t,;]|$)/i.test(l));
	if (iCabecera < 0) salir(`${ruta}: falta la cabecera con la columna «palabra» (o «Keyword»)`);
	const sep = ["\t", ";", ","].find((s) => lineas[iCabecera].includes(s)) ?? ",";
	const celdas = (l) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
	const cabecera = celdas(lineas[iCabecera]).map(clave);
	const col = (...nombres) => cabecera.findIndex((c) => nombres.includes(c));
	const iPalabra = col("palabra", "palabras", "keyword");
	const iCategoria = col("categoria");
	const iCantidad = col("cantidad");
	const iMin = col("precio_min");
	const iMax = col("precio_max");
	const num = (v) => (v == null || v === "" ? undefined : Number(String(v).replace(",", ".")));
	const filas = [];
	const vistas = new Set();
	for (const l of lineas.slice(iCabecera + 1)) {
		const c = celdas(l);
		const palabra = c[iPalabra]?.trim();
		if (!palabra || l.trim().startsWith("#") || vistas.has(clave(palabra))) continue;
		vistas.add(clave(palabra));
		filas.push({
			palabra,
			categoria: (iCategoria >= 0 && c[iCategoria]) || CATEGORIA,
			cantidad: num(iCantidad >= 0 ? c[iCantidad] : undefined) ?? CANTIDAD,
			precioMin: num(iMin >= 0 ? c[iMin] : undefined) ?? 0,
			precioMax: num(iMax >= 0 ? c[iMax] : undefined) ?? PRECIO_MAX,
		});
	}
	return filas;
}

// ---------- filtros y nombre ----------

// Personajes y marcas registradas: en AliExpress casi siempre son copias no oficiales.
const MARCAS = [
	"disney", "sanrio", "hello kitty", "kuromi", "my melody", "cinnamoroll", "pompompurin", "pochacco",
	"pokemon", "pikachu", "marvel", "stitch", "mickey", "minnie", "frozen", "bob esponja", "spongebob",
	"sonic", "paw patrol", "patrulla canina", "toy story", "labubu", "pop mart", "pusheen", "lol surprise",
	"shopkins", "squishmallow", "sumikko", "rilakkuma", "totoro", "ghibli", "barbie", "peppa", "bluey",
	"minecraft", "among us", "huggy", "my little pony", "naruto", "one piece", "chiikawa", "jellycat",
];
const tieneMarca = (titulo) => {
	const t = ` ${clave(titulo).replace(/[^a-z0-9]+/g, " ")} `;
	return MARCAS.find((m) => t.includes(` ${m} `));
};

/** Nombre corto a partir del título de AliExpress: hasta la primera coma, sin años ni «nuevo», ≤ 70 caracteres. */
function nombreCorto(titulo) {
	let s = String(titulo).replace(/\s+/g, " ").trim();
	s = s.split(/\s*[,，;|]\s*|\s+-\s+/)[0];
	s = s.replace(/\b(20\d\d|nuevo|nueva|novedad|hot|caliente|venta)\b/gi, "").replace(/\s{2,}/g, " ").trim();
	if (s.length > 70) s = s.slice(0, 70).replace(/\s+\S*$/, "");
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function coleccionPorPrecio(precio) {
	if (precio == null) return [];
	if (precio < 10) return ["menos-de-10"];
	if (precio < 20) return ["de-10-a-20"];
	if (precio <= 40) return ["de-20-a-40"];
	return [];
}

// ---------- productos que ya tenemos ----------

const yaTenemos = new Set();

// En los JSON de datos/ (importados o pendientes de importar)
for (const dir of ["datos", dirname(SALIDA)]) {
	if (!existsSync(dir)) continue;
	for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
		if (resolve(dir, f) === SALIDA) continue; // el que vamos a sobrescribir
		try {
			const json = JSON.parse(await readFile(resolve(dir, f), "utf8"));
			const lista = Array.isArray(json) ? json : json.productos;
			if (!Array.isArray(lista)) continue;
			for (const p of lista) {
				const id = p.id_externo ?? String(p.enlace ?? "").match(/\/item\/(\d+)\.html/)?.[1];
				if (id) yaTenemos.add(String(id));
			}
		} catch {
			// un JSON que no es de productos: se ignora
		}
	}
}

// En EmDash, si hay token (pocas peticiones: solo el listado de productos y la papelera)
if (process.env.EMDASH_TOKEN) {
	const { api } = clienteEmDash(process.env.EMDASH_URL || "http://localhost:4321", process.env.EMDASH_TOKEN);
	try {
		for (const ruta of ["/content/productos", "/content/productos/trash"]) {
			for (let cursor; ; ) {
				const q = new URLSearchParams({ limit: "50", ...(ruta.endsWith("trash") ? {} : { status: "all" }) });
				if (cursor) q.set("cursor", cursor);
				const data = await api(`${ruta}?${q}`);
				for (const p of data.items) if (p.data?.id_externo) yaTenemos.add(String(p.data.id_externo));
				if (!(cursor = data.nextCursor)) break;
			}
		}
	} catch (e) {
		console.log(`! No se pudo leer EmDash (${e.message}); solo se evitan los repetidos de datos/.`);
	}
}

// ---------- búsqueda ----------

const filas = await leerCsv(fichero);
if (!filas.length) salir(`${fichero} no tiene ninguna palabra`);
console.log(`${filas.length} palabra(s) · ${yaTenemos.size} producto(s) que ya tenemos se saltan\n`);

const salida = [];
const descartes = { marca: 0, vendidos: 0, valoracion: 0, precio: 0, foto: 0, repetido: 0 };

for (const fila of filas) {
	const elegidos = [];
	try {
		for (let pagina = 1; pagina <= PAGINAS && elegidos.length < fila.cantidad; pagina++) {
			const { productos } = await buscarAliExpress(fila.palabra, { pagina });
			await esperar(1000); // una llamada por segundo
			for (const p of productos) {
				if (elegidos.length >= fila.cantidad) break;
				let motivo;
				if (yaTenemos.has(p.id)) motivo = "repetido";
				else if (!p.imagen) motivo = "foto";
				else if (p.precio == null || p.precio < fila.precioMin || p.precio > fila.precioMax) motivo = "precio";
				else if (p.vendidos < MIN_VENDIDOS) motivo = "vendidos";
				else if (p.valoracion != null && p.valoracion < MIN_VALORACION) motivo = "valoracion";
				else if (!PERMITIR_MARCAS && tieneMarca(p.titulo)) motivo = "marca";
				if (motivo) {
					descartes[motivo]++;
					continue;
				}
				yaTenemos.add(p.id); // que no salga otra vez con otra palabra
				elegidos.push(p);
			}
			if (productos.length < 50) break; // no hay más páginas
		}
	} catch (e) {
		console.error(`✗ «${fila.palabra}»: ${e.message}`);
		process.exitCode = 1;
		continue;
	}

	console.log(`• «${fila.palabra}»${fila.categoria ? ` → ${fila.categoria}` : ""}: ${elegidos.length} de ${fila.cantidad}`);
	for (const p of elegidos) {
		const categoria = fila.categoria ?? clasificar(nombreCorto(p.titulo), fila.palabra);
		salida.push({
			nombre: nombreCorto(p.titulo),
			enlace: `https://es.aliexpress.com/item/${p.id}.html`,
			...(p.enlaceAfiliado ? { enlace_afiliado: p.enlaceAfiliado } : {}),
			id_externo: p.id,
			precio: p.precio,
			tipo: "generico",
			imagen: p.imagen,
			fuente_imagen: "marca",
			colecciones: coleccionPorPrecio(p.precio),
			...(categoria ? { categorias: [categoria] } : {}),
			notas: `Búsqueda «${fila.palabra}» ${hoy} · ${p.vendidos} vendidos/30 días${p.valoracion != null ? ` · ${p.valoracion} % positivas` : ""} · título original: ${p.titulo}`,
		});
		console.log(`    ${p.precio?.toFixed(2)} € · ${p.vendidos} vendidos · ${nombreCorto(p.titulo)}${fila.categoria ? "" : ` → ${categoria ?? "sin categoría"}`}`);
	}
}

await mkdir(dirname(SALIDA), { recursive: true });
await writeFile(SALIDA, `${JSON.stringify(salida, null, "\t")}\n`);

const d = descartes;
console.log(
	`\n${salida.length} producto(s) en ${SALIDA}` +
		`\nDescartados: ${d.repetido} ya los tenemos · ${d.marca} con marca registrada · ${d.vendidos} con pocas ventas` +
		` · ${d.valoracion} con mala valoración · ${d.precio} fuera de precio · ${d.foto} sin foto` +
		`\n\nSiguiente paso: revisa los nombres (y quita los que no te gusten) y después:` +
		`\n  node scripts/import-products.mjs ${SALIDA} --publish --dry-run` +
		`\n  o muévelo a datos/ y haz push para que lo importe GitHub.`,
);
