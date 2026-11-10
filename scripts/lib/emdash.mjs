/**
 * Cliente común de la API de EmDash para los scripts del admin.
 *
 * EmDash va en un Worker de Cloudflare con plan gratuito: cada petición tiene un límite
 * de CPU muy bajo y, si se pasa o llegan muchas a la vez, responde 503. Para no saturarlo:
 *   - las peticiones van de una en una, aunque el script las lance en paralelo
 *     (por ejemplo, con Promise.all);
 *   - entre una y otra hay una pausa mínima, que se alarga sola si EmDash da 503/429 y
 *     vuelve a bajar tras una racha sin errores;
 *   - los 429/5xx y los fallos de red se reintentan con espera creciente;
 *   - las páginas de los listados son de LIMITE_PAGINA elementos como mucho (las de 100
 *     con todos los datos de los productos son las que más CPU gastan).
 *
 * Variables de entorno opcionales:
 *   EMDASH_PAUSA_MS   pausa mínima entre peticiones (por defecto 500 ms)
 *   EMDASH_LIMITE     elementos por página en los listados (por defecto 50)
 */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export const LIMITE_PAGINA = Math.max(1, Math.min(100, Number(process.env.EMDASH_LIMITE ?? 50)));
const PAUSA_MIN = Math.max(0, Number(process.env.EMDASH_PAUSA_MS ?? 500));
const PAUSA_MAX = 8000;
const REINTENTOS = 6;
const REINTENTABLE = new Set([429, 500, 502, 503, 504]);

/** Baja el `limit` de la URL si pasa de LIMITE_PAGINA. */
function limitarPagina(ruta) {
	return ruta.replace(/([?&]limit=)(\d+)/, (m, pre, n) => (Number(n) > LIMITE_PAGINA ? `${pre}${LIMITE_PAGINA}` : m));
}

/**
 * @param {string} url    Base de EmDash, p. ej. https://admin.regaloskawaii.es
 * @param {string} token  Token de API de EmDash
 */
export function clienteEmDash(url, token) {
	const base = String(url).replace(/\/+$/, "");
	let pausa = PAUSA_MIN;
	let exitosSeguidos = 0;
	let ultima = 0;
	let cola = Promise.resolve();
	const stats = { peticiones: 0, reintentos: 0 };

	async function una(ruta, opciones) {
		const metodo = opciones.method ?? "GET";
		for (let intento = 0; ; intento++) {
			const espera = ultima + pausa - Date.now();
			if (espera > 0) await esperar(espera);
			ultima = Date.now();
			stats.peticiones++;

			let res;
			try {
				res = await fetch(`${base}/_emdash/api${ruta}`, {
					...opciones,
					headers: {
						Authorization: `Bearer ${token}`,
						...(opciones.body && typeof opciones.body === "string" ? { "Content-Type": "application/json" } : {}),
						...(opciones.headers ?? {}),
					},
				});
			} catch (e) {
				res = { status: 0, error: e };
			}

			if (res.status === 0 || REINTENTABLE.has(res.status)) {
				pausa = Math.min(Math.max(pausa, 250) * 2, PAUSA_MAX);
				exitosSeguidos = 0;
				if (intento >= REINTENTOS) {
					const err = new Error(`${metodo} ${ruta}: ${res.status ? `HTTP ${res.status}` : res.error?.message}`);
					err.status = res.status;
					throw err;
				}
				stats.reintentos++;
				const retryAfter = Number(res.headers?.get?.("retry-after"));
				const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * 2 ** intento, 60_000);
				console.log(`  … ${metodo} ${ruta}: ${res.status || res.error?.message}; reintento ${intento + 1}/${REINTENTOS} en ${Math.round(ms / 1000)} s (pausa ${pausa} ms)`);
				await esperar(ms);
				continue;
			}

			if (++exitosSeguidos >= 10 && pausa > PAUSA_MIN) {
				pausa = Math.max(PAUSA_MIN, Math.round(pausa * 0.8));
				exitosSeguidos = 0;
			}

			let json;
			try {
				json = await res.json();
			} catch {
				const err = new Error(`${metodo} ${ruta}: HTTP ${res.status} (respuesta no JSON)`);
				err.status = res.status;
				throw err;
			}
			if (!json.success) {
				const err = new Error(`${metodo} ${ruta}: ${json.error?.code ?? `HTTP ${res.status}`} ${json.error?.message ?? ""}`.trim());
				err.status = res.status;
				err.code = json.error?.code;
				throw err;
			}
			return json.data;
		}
	}

	/** Llamada a /_emdash/api{ruta}. Devuelve `data`; lanza Error si falla. */
	function api(ruta, opciones = {}) {
		const resultado = cola.then(() => una(limitarPagina(ruta), opciones));
		cola = resultado.catch(() => {});
		return resultado;
	}

	/** Recorre todas las páginas de un listado y devuelve los elementos de `campo`. */
	async function paginas(ruta, campo) {
		const items = [];
		let cursor;
		do {
			const q = new URLSearchParams({ limit: String(LIMITE_PAGINA) });
			if (cursor) q.set("cursor", cursor);
			const data = await api(`${ruta}${ruta.includes("?") ? "&" : "?"}${q}`);
			items.push(...(data[campo] ?? []));
			cursor = data.nextCursor;
		} while (cursor);
		return items;
	}

	return { api, paginas, stats };
}
