/**
 * Búsqueda de productos nuevos con la API de afiliados de AliExpress (la usa scripts/importar.mjs
 * con --buscar). Lee un CSV de palabras clave y devuelve productos listos para importar,
 * con enlace de afiliado, precio y foto, y sin los que ya tenemos.
 *
 * Formato del CSV (separado por comas, punto y coma o tabuladores; con cabecera):
 *   palabra,categoria,cantidad,precio_min,precio_max
 *   squishy gato,squishy-animales,8,,15
 * Solo «palabra» es obligatoria. Sin categoría, cada producto se clasifica por su nombre
 * (lib/clasificar.mjs). También vale el CSV que descarga el Planificador de palabras clave
 * de Google Ads (usa su columna «Keyword»; la categoría va con --categoria=).
 * El precio mínimo nunca baja de 5 €.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buscarAliExpress } from "./aliexpress-api.mjs";
import { clasificar } from "./clasificar.mjs";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const sinAcentos = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const clave = (s) => sinAcentos(s).toLowerCase().trim();

async function leerCsv(ruta, { categoria: CATEGORIA, cantidad: CANTIDAD, precioMax: PRECIO_MAX }) {
	const buffer = await readFile(ruta);
	// El Planificador de Google Ads exporta en UTF-16 con BOM
	let texto = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
	texto = texto.replace(/^﻿/, "");
	const lineas = texto.split(/\r?\n/).filter((l) => l.trim());
	// La cabecera es la primera línea con «palabra» o «Keyword» (el Planificador pone dos líneas de título antes)
	const iCabecera = lineas.findIndex((l) => /(^|[\t,;"])\s*(palabra|keyword)\s*("|[\t,;]|$)/i.test(l));
	if (iCabecera < 0) throw new Error(`${ruta}: falta la cabecera con la columna «palabra» (o «Keyword»)`);
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
			precioMin: Math.max(5, num(iMin >= 0 ? c[iMin] : undefined) ?? 0), // nunca menos de 5 €
			precioMax: num(iMax >= 0 ? c[iMax] : undefined) ?? PRECIO_MAX,
		});
	}
	return filas;
}

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

/** IDs de AliExpress que aparecen en los JSON de una carpeta (importados o pendientes). */
async function idsEnJson(dir, excepto) {
	const ids = new Set();
	if (!existsSync(dir)) return ids;
	for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
		if (excepto && resolve(dir, f) === excepto) continue;
		try {
			const json = JSON.parse(await readFile(resolve(dir, f), "utf8"));
			const lista = Array.isArray(json) ? json : json.productos;
			if (!Array.isArray(lista)) continue;
			for (const p of lista) {
				const id = p.id_externo ?? String(p.enlace ?? "").match(/\/item\/(\d+)\.html/)?.[1];
				if (id) ids.add(String(id));
			}
		} catch {
			// un JSON que no es de productos: se ignora
		}
	}
	return ids;
}

/**
 * @param {string} csv  ruta del CSV de palabras
 * @param {object} o
 * @param {Set<string>} o.yaTenemos  id_externo de los productos que ya están en EmDash (o en su papelera)
 * @param {string} [o.salida]        JSON que se va a escribir (se ignora al buscar repetidos en datos/)
 * @param {string} [o.categoria]     categoría para las filas que no la traen
 * @param {number} [o.cantidad=20]   productos por palabra
 * @param {number} [o.minVendidos=20]
 * @param {number} [o.minValoracion=90]
 * @param {number} [o.precioMax=40]
 * @param {number} [o.paginas=2]     páginas de 50 resultados por palabra
 * @param {boolean} [o.permitirMarcas=false]
 * @returns {Promise<{productos: object[], descartes: object, errores: number}>}
 */
export async function buscarProductos(csv, o = {}) {
	const CANTIDAD = o.cantidad ?? 20;
	const MIN_VENDIDOS = o.minVendidos ?? 20;
	const MIN_VALORACION = o.minValoracion ?? 90;
	const PERMITIR_MARCAS = Boolean(o.permitirMarcas);
	const PAGINAS = Math.max(1, o.paginas ?? 2);
	const hoy = new Date().toISOString().slice(0, 10);
	let errores = 0;

	if (!existsSync(csv)) throw new Error(`No existe ${csv}`);
	const yaTenemos = new Set([...(o.yaTenemos ?? []), ...(await idsEnJson("datos", o.salida && resolve(o.salida)))]);

	const filas = await leerCsv(csv, { categoria: o.categoria, cantidad: CANTIDAD, precioMax: o.precioMax ?? 40 });
	if (!filas.length) throw new Error(`${csv} no tiene ninguna palabra`);
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
			errores++;
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

	return { productos: salida, descartes, errores };
}
