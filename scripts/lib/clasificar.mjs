/**
 * Clasifica un producto en una categoría de la web a partir de su nombre (y, si hay, de la
 * palabra con la que se encontró). Se usa en import-products.mjs cuando el JSON no trae
 * "categorias", y en search-products.mjs cuando la fila del CSV no trae categoría.
 *
 * Las reglas van de la más concreta a la más general: gana la primera que encaja
 * (un «llavero de peluche» es un llavero; un «squishy de fresa» es squishy de comida).
 * Devuelve el slug de la subcategoría; la categoría padre la añade el importador.
 */

const normalizar = (s) =>
	` ${String(s ?? "")
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()} `;

// Cada regla: [slug, expresión]. Las expresiones se aplican al texto normalizado
// (sin acentos, en minúsculas, con espacios alrededor), así que \b funciona con palabras.
const SQUISHY = /\b(squish\w*|antiestres)\b/;
const REGLAS = [
	// Squishy: primero tamaño, luego animales, luego comida
	["squishy-gigantes", /\b(gigantes?|grandes?|jumbo|enormes?|xxl)\b/, SQUISHY],
	["squishy-animales", /\b(gat\w*|perr\w*|pat\w*|poll\w*|conej\w*|os[oa]s?|osit\w*|pandas?|capibaras?|ajolotes?|ranas?|cerd\w*|unicornios?|dinosaurios?|pulpos?|focas?|pinguinos?|ballenas?|tiburon\w*|zorr\w*|koalas?|raton\w*|hamster\w*|erizos?|llamas?|mapaches?|nutrias?|vacas?|tortugas?|abejas?|mariposas?|tigres?|leon\w*|monos?|elefantes?|jirafas?|buhos?|pajar\w*|animal\w*)\b/, SQUISHY],
	["squishy-comida", /\b(comida|fresas?|helados?|pastel\w*|tartas?|donuts?|donas?|pan|panes|bollos?|bao|queso|mantequilla|hamburguesas?|pizzas?|frutas?|sandias?|aguacates?|sushi|galletas?|palomitas|leche|huevos?|pinas?|platanos?|melocoton\w*|cupcakes?|macarons?|gelatinas?|tomates?|caramelos?|chuches|dulces?)\b/, SQUISHY],
	["squishy", SQUISHY],
	// Ropa: antes que peluches y cosplay («sudadera con orejas de oso» es una sudadera)
	["pijamas-kigurumis", /\b(kigurumis?|pijamas?|onesies?|monos? de dormir)\b/],
	["sudaderas", /\b(sudaderas?|hoodies?)\b/],
	["faldas", /\b(faldas?|minifaldas?)\b/],
	["abrigos", /\b(abrigos?|chaquet\w*|cazadoras?|parkas?|capas?)\b/],
	["camisetas", /\b(camisetas?|t shirt|blusas?)\b/],
	["moda", /\b(vestidos?|pantalon\w*|calcetin\w*|medias|gorros?|bufandas?|guantes|zapatill\w*|zapatos?|jerseys?|cardigan\w*|chalecos?|leggings|shorts|ropa)\b/],
	// Objetos concretos
	["cajas-sorpresa", /\b(caja sorpresa|cajas sorpresa|blind box|caja ciega|capsulas? sorpresa|sorpresas?)\b/],
	["llaveros", /\b(llaveros?|colgantes? para (bolso|mochila))\b/],
	["auriculares", /\b(auriculares?|cascos|earbuds)\b/],
	["mochilas", /\b((mini)?mochil\w*|neceser\w*|bolsos?|bolsas? de hombro|bandoleras?|rinoneras?|tote)\b/],
	["lamparas", /\b(lamparas?|luz nocturna|luces nocturnas|luz de noche|quitamiedos)\b/],
	["tazas", /\b(tazas?|mugs?|vasos?)\b/],
	["botellas", /\b(botellas?|termos?|cantimploras?)\b/],
	["libros", /\b(libros?|manga|comic\w*)\b/],
	["pegatinas", /\b(pegatin\w*|stickers?|calcomanias?)\b/],
	["boligrafos", /\b(boligraf\w*|bolis?|plumas? de gel|rotulador\w*)\b/],
	["libretas", /\b(libret\w*|cuadern\w*|agendas?|diarios?|blocs?|planificador\w*|bullet journal)\b/],
	["papeleria", /\b(estuches?|lapic\w*|lapiz|gomas? de borrar|gomas|washi|cinta adhesiva|clips?|subrayador\w*|marcapaginas|sellos?|portalapices|sacapuntas|papeler\w*|material escolar|tijeras|reglas?)\b/],
	["gaming", /\b(gaming|gamer|mandos?|teclados?|ratones? (inalambric\w*|gaming)|alfombrill\w*|consolas?|switch|joystick)\b/],
	["joyeria", /\b(collar\w*|pendientes|anillos?|pulser\w*|joy\w*|bisuteria|broches?)\b/],
	["maquillaje", /\b(maquillaje|pintalabios|labial\w*|brillo de labios|sombras? de ojos|esmaltes?|unas postizas|brochas?|cosmetic\w*)\b/],
	["cosplay", /\b(cosplay|orejas de|pelucas?|disfraz\w*|colas? de)\b/],
	["peluches", /\b(peluch\w*|muneco\w* de peluche|plush)\b/],
	["hogar-cocina", /\b(platos?|cuencos?|cojin\w*|almohad\w*|organizador\w*|cocina|hogar|mantas?|alfombras?|cortinas?|decoracion|velas?|relojes?|espejos?|cubiertos|palillos|fiambreras?|tapers?|toallas?|macetas?|percheros?)\b/],
	["accesorios", /\b(fundas?|carcasas?|horquill\w*|pinzas?|coleter\w*|diademas?|lazos?|carteras?|monederos?|paraguas|gafas|accesorios?)\b/],
];

/**
 * @param {string} nombre   nombre del producto
 * @param {string} [extra]  texto de apoyo (p. ej. la palabra de búsqueda)
 * @param {Set<string>} [validos] slugs que existen en la web: las reglas de otros se saltan
 * @returns {string|undefined} slug de la categoría
 */
export function clasificar(nombre, extra = "", validos) {
	for (const texto of [normalizar(nombre), normalizar(`${nombre} ${extra}`)]) {
		for (const [slug, ...expresiones] of REGLAS) {
			if (validos && !validos.has(slug)) continue;
			if (expresiones.every((re) => re.test(texto))) return slug;
		}
	}
	return undefined;
}
