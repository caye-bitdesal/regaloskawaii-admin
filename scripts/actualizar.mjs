#!/usr/bin/env node
/**
 * Pone al día los productos de AliExpress que ya están en EmDash, con la API oficial de
 * afiliados (una llamada por cada 20 productos) y una sola escritura por producto, solo
 * si algo cambia:
 *
 *   - precio_ref, historial_precios y precio_actualizado. La web solo anuncia un descuento
 *     si el precio actual es menor que el más bajo de los 30 días anteriores según este
 *     historial (art. 20 Ley 7/1996); nunca se usa el «precio original» de AliExpress.
 *   - enlace_afiliado, si falta o no es de afiliado (s.click.aliexpress.com).
 *   - la foto, si el producto no tiene.
 *   - la prioridad (lib/product-priority.mjs): 2 oficial, 1 con foto y enlace de afiliado, 0 el resto.
 *   - Despublica al momento los que la API ya no devuelve (retirados, fuera del programa de
 *     afiliados o sin venta en España) y lo apunta en sus notas. Si en otra revisión vuelven
 *     a aparecer, se republican solos y se quita la nota.
 *     Protección: si la API no devuelve más del 40 % de los productos, se supone que falla
 *     la API y no se despublica ninguno.
 *
 * Los productos de Amazon no se tocan (no hay acceso a la Creators API ni se permite scraping).
 *
 * Uso:
 *   npm run actualizar                 (carga .env si existe)
 *   npm run actualizar -- --dry-run    muestra lo que haría sin escribir nada
 *   EMDASH_PAUSA_MS=1000 …             pausa mínima entre llamadas a EmDash (por defecto 500 ms)
 *
 * Variables de entorno: EMDASH_URL, EMDASH_TOKEN, ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET,
 * ALIEXPRESS_TRACKING_ID. El campo «historial_precios» (Texto) tiene que existir en Productos.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiAliExpressConfigurada, detallesAliExpress, esEnlaceAfiliadoAliExpress, trackingIdConfigurado } from "./lib/aliexpress-api.mjs";
import { clienteEmDash } from "./lib/emdash.mjs";
import { fotoOriginalAliExpress, subirImagen } from "./lib/imagenes.mjs";
import { descuentoLegal, fechaUTC, leerHistorial, registrarPrecio } from "./lib/price-history.mjs";
import { calcularPrioridad, tieneFoto } from "./lib/product-priority.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(resolve(RAIZ, ".env"))) process.loadEnvFile(resolve(RAIZ, ".env"));

const SIMULAR = process.argv.includes("--dry-run");
const API = (process.env.EMDASH_URL ?? "http://localhost:4321").replace(/\/+$/, "");
const TOKEN = process.env.EMDASH_TOKEN;

if (!TOKEN) salir("Falta EMDASH_TOKEN");
if (!apiAliExpressConfigurada()) salir("Faltan ALIEXPRESS_APP_KEY y/o ALIEXPRESS_APP_SECRET");
if (!trackingIdConfigurado()) salir("Falta ALIEXPRESS_TRACKING_ID: sin él la API no da enlaces de afiliado");

function salir(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

/** Si la API no devuelve más de esta parte de los productos consultados, no se despublica ninguno. */
const MAX_PROPORCION_DESAPARECIDOS = 0.4;
/** Un producto con descuento se vuelve a guardar si su precio tiene más días que esto (la web no enseña descuentos de más de 7). */
const REFRESCO_DIAS = 3;
/** Errores seguidos de EmDash (tras agotar reintentos) a partir de los que se para. */
const MAX_FALLOS_SEGUIDOS = 3;
/** Marca en «notas» de los productos que despublica este script (para republicarlos si vuelven). */
const MARCA = "[despublicado por actualizar";

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const redondear = (n) => Math.round(n * 100) / 100;
const eur = (n) => (n == null ? "—" : `${n.toFixed(2).replace(".", ",")} €`);
const diasDesde = (iso) => {
	const t = new Date(iso ?? "").getTime();
	return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86_400_000;
};
const quitarMarca = (notas) =>
	String(notas ?? "")
		.split("\n")
		.filter((l) => !l.startsWith(MARCA))
		.join("\n")
		.trim();
const despublicadoPorMi = (data) => String(data.notas ?? "").includes(MARCA);

const { api, paginas, stats } = clienteEmDash(API, TOKEN);

// ---------- productos a revisar (una lectura del catálogo) ----------

const esquema = await api("/schema/collections/productos?includeFields=true");
if (!esquema.item.fields.some((f) => f.slug === "historial_precios")) {
	salir("La colección productos no tiene el campo «historial_precios» (Texto) (Tipos de contenido → Productos).");
}

const todos = new Map((await paginas("/content/productos?status=all", "items")).map((p) => [p.id, p]));
const tiendas = await paginas("/content/tiendas?status=all", "items");

const productos = [];
const vistos = new Set();
for (const t of tiendas) {
	const plantilla = t.data.plantilla_url ?? "";
	const esAmazon = /amazon\./i.test(plantilla) || /amazon/i.test(t.data.title ?? "");
	const esAli = /aliexpress/i.test(plantilla) || /aliexpress/i.test(t.data.title ?? "");
	if (esAmazon || !esAli) continue;
	for (const ref of await paginas(`/content/tiendas/${t.id}/references/productos_tienda/parents`, "parents")) {
		if (vistos.has(ref.id)) continue;
		vistos.add(ref.id);
		const item = todos.get(ref.id);
		if (!item?.data?.id_externo) continue;
		// Publicados, y borradores que despublicó este script (por si han vuelto)
		if (item.status !== "published" && !despublicadoPorMi(item.data)) continue;
		productos.push({ item, id: String(item.data.id_externo), tienda: t });
	}
}
// Primero los que llevan más tiempo sin revisar: si se corta, al repetirlo sigue por ahí.
productos.sort((a, b) => diasDesde(b.item.data.precio_actualizado) - diasDesde(a.item.data.precio_actualizado));

console.log(`EmDash: ${API} · productos de AliExpress a revisar: ${productos.length}${SIMULAR ? " (simulación)" : ""}`);
if (!productos.length) process.exit(0);

// ---------- consulta a la API (sin escribir todavía) ----------

const detalles = new Map();
const sinRespuesta = new Set(); // productos de lotes en los que falló la llamada: no se tocan
for (let i = 0; i < productos.length; i += 20) {
	const lote = productos.slice(i, i + 20);
	try {
		for (const [id, d] of await detallesAliExpress(lote.map((p) => p.id))) detalles.set(id, d);
	} catch (e) {
		console.error(`✗ Lote ${i / 20 + 1} de la API de AliExpress: ${e.message}`);
		for (const p of lote) sinRespuesta.add(p.id);
	}
	if (i + 20 < productos.length) await esperar(1000);
}
const consultados = productos.filter((p) => !sinRespuesta.has(p.id));
const desaparecidos = consultados.filter((p) => !detalles.get(p.id)?.precio);
const apiSospechosa = consultados.length > 0 && desaparecidos.length / consultados.length > MAX_PROPORCION_DESAPARECIDOS;
if (apiSospechosa) {
	console.log(
		`\n! La API no ha devuelto ${desaparecidos.length} de ${consultados.length} productos: parece un fallo de la API, así que no se despublica ninguno.`,
	);
}

// ---------- cambios y escritura (un PUT por producto, solo si cambia algo) ----------

const ahora = new Date().toISOString();
const hoy = fechaUTC();
const cuenta = { sinCambios: 0, actualizados: 0, precios: 0, enlaces: 0, fotos: 0, prioridad: 0, despublicados: 0, republicados: 0, errores: 0 };
let fallosSeguidos = 0;

for (const { item, id, tienda } of consultados) {
	const data = item.data;
	const titulo = data.title;
	const d = detalles.get(id);
	const publicado = item.status === "published";

	// 1. Ya no está en la API → despublicar (salvo fallo general de la API)
	if (!d?.precio) {
		if (!publicado || apiSospechosa) continue;
		const notas = [quitarMarca(data.notas), `${MARCA} ${hoy}: la API de AliExpress no lo devuelve]`].filter(Boolean).join("\n");
		const hecho = await escribir(`«${titulo}»: ya no está en la API de AliExpress → despublicado`, titulo, async () => {
			await api(`/content/productos/${item.id}`, { method: "PUT", body: JSON.stringify({ data: { notas } }) });
			await api(`/content/productos/${item.id}/unpublish`, { method: "POST" });
		});
		if (hecho) cuenta.despublicados++;
		if (fallosSeguidos >= MAX_FALLOS_SEGUIDOS) break;
		continue;
	}

	// 2. Está en la API → precio, enlace, foto y prioridad
	const cambios = {};
	const notasCambio = [];

	const precio = redondear(d.precio);
	const historialAntes = leerHistorial(data.historial_precios);
	const historial = registrarPrecio(historialAntes, precio, hoy);
	const descuento = descuentoLegal(historial, precio, hoy);
	const cambiaPrecio = data.precio_ref !== precio || JSON.stringify(historial) !== JSON.stringify(historialAntes);
	const caduca = descuento && diasDesde(data.precio_actualizado) > REFRESCO_DIAS;
	if (cambiaPrecio || caduca) {
		Object.assign(cambios, { precio_ref: precio, historial_precios: JSON.stringify(historial), precio_actualizado: ahora });
		notasCambio.push(
			`${eur(data.precio_ref)} → ${eur(precio)}${descuento ? ` (más bajo en 30 días: ${eur(descuento.precioAnterior)}, -${descuento.porcentaje} %)` : ""}`,
		);
		cuenta.precios++;
	}

	const promo = d.enlaceAfiliado?.trim();
	if (promo && esEnlaceAfiliadoAliExpress(promo) && !esEnlaceAfiliadoAliExpress(data.enlace_afiliado ?? "")) {
		cambios.enlace_afiliado = promo;
		notasCambio.push("enlace de afiliado");
		cuenta.enlaces++;
	}

	const necesitaFoto = !tieneFoto(data) && d.imagen;

	const vuelve = !publicado && despublicadoPorMi(data);
	if (vuelve) {
		cambios.notas = quitarMarca(data.notas);
		notasCambio.push("ha vuelto a la API → republicado");
	}

	// La prioridad se calcula con el resultado final (la foto se tiene en cuenta abajo).
	const prioridadCon = (imagen) => calcularPrioridad({ ...data, ...cambios, ...(imagen ? { imagen } : {}) }, tienda);

	if (!Object.keys(cambios).length && !necesitaFoto && prioridadCon(null) === (data.priority ?? 0)) {
		cuenta.sinCambios++;
		continue;
	}

	await escribir(null, titulo, async () => {
		if (necesitaFoto) {
			if (SIMULAR) {
				notasCambio.push("foto");
				cuenta.fotos++;
			}
			else {
				try {
					cambios.imagen = await subirImagen(api, fotoOriginalAliExpress(d.imagen), titulo);
					cambios.fuente_imagen ??= data.fuente_imagen ?? "marca";
					notasCambio.push("foto");
					cuenta.fotos++;
				} catch (e) {
					notasCambio.push(`sin foto (${e.message})`);
				}
			}
		}
		const prioridad = prioridadCon(cambios.imagen ?? (SIMULAR && necesitaFoto ? { src: "simulada" } : null));
		if (prioridad !== (data.priority ?? 0)) {
			cambios.priority = prioridad;
			notasCambio.push(`prioridad ${data.priority ?? "—"} → ${prioridad}`);
			cuenta.prioridad++;
		}
		if (!Object.keys(cambios).length) return false;
		console.log(`${SIMULAR ? "•" : "✓"} «${titulo}»: ${notasCambio.join(" · ")}`);
		if (SIMULAR) return true;
		// PUT parcial: EmDash mezcla los campos enviados con los que ya hay. No se reenvía el
		// producto entero (historial_precios llega como lista y EmDash lo rechazaría).
		await api(`/content/productos/${item.id}`, { method: "PUT", body: JSON.stringify({ data: cambios }) });
		if (publicado || vuelve) await api(`/content/productos/${item.id}/publish`, { method: "POST" });
		return true;
	}).then((escrito) => {
		if (escrito === false) cuenta.sinCambios++;
		else if (escrito) {
			cuenta.actualizados++;
			if (vuelve) cuenta.republicados++;
		}
	});
	if (fallosSeguidos >= MAX_FALLOS_SEGUIDOS) break;
}

/**
 * Ejecuta una escritura en EmDash. Devuelve lo que devuelva `fn` (o true), o undefined si falla.
 * Tras MAX_FALLOS_SEGUIDOS fallos seguidos se para el bucle.
 */
async function escribir(texto, titulo, fn) {
	if (SIMULAR && texto) {
		console.log(`• ${texto}`);
		return true;
	}
	try {
		const r = await fn();
		if (texto) console.log(`✓ ${texto}`);
		fallosSeguidos = 0;
		return r ?? true;
	} catch (e) {
		console.log(`✗ «${titulo}»: ${e.message}`);
		cuenta.errores++;
		if (++fallosSeguidos >= MAX_FALLOS_SEGUIDOS) {
			console.log(`\n✗ EmDash sigue fallando tras ${MAX_FALLOS_SEGUIDOS} errores seguidos: paro aquí. Al repetirlo seguirá por los que faltan.`);
		} else {
			await esperar(30_000); // un respiro antes del siguiente
		}
		return undefined;
	}
}

const c = cuenta;
console.log(
	`\n${SIMULAR ? "Simulación · " : ""}Revisados: ${consultados.length} · Sin cambios: ${c.sinCambios} · Actualizados: ${c.actualizados}` +
		` (precios ${c.precios} · enlaces ${c.enlaces} · fotos ${c.fotos} · prioridad ${c.prioridad} · republicados ${c.republicados})` +
		` · Despublicados: ${c.despublicados}` +
		(sinRespuesta.size ? ` · Sin respuesta de la API: ${sinRespuesta.size}` : "") +
		` · Errores: ${c.errores}`,
);
console.log(`Peticiones a EmDash: ${stats.peticiones} (reintentos: ${stats.reintentos})`);
if (c.errores || sinRespuesta.size) process.exitCode = 1;
