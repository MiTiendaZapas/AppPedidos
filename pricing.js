// ============================================================================
// MOTOR DE PRECIOS
// ============================================================================
// Una sola lista de "categorías" (ej: "Ojotas", "Jordan low pink"). Cada
// categoría tiene:
//   - palabras clave: si el modelo escrito contiene alguna, es de esa categoría
//   - 4 precios: Minorista/Mayorista × Unidad (menos de 5 pares) / Por mayor (5+)
//     (si la categoría es "ropa" -remera, baggy- solo importan los 2 de
//     "Unidad": el precio de la ropa no cambia según cuántas zapatillas lleve)
//
// No hace falta ordenar nada a mano: si un modelo coincide con varias
// categorías (ej. "Ojotas Mind" tiene "ojota" Y "mind"), gana la que tenga la
// palabra clave MÁS LARGA (más específica) — "ojota mind" (más específica)
// le gana a "mind" sola.
//
// Este archivo solo define los valores POR DEFECTO. Una vez que la app
// arranca, la lista real se guarda en la base (Firestore o localStorage) y
// se edita desde ⚙️ Configuración → Categorías, sin tocar código.
// ============================================================================

function normalizarTexto(txt) {
    return (txt || '')
        .toString()
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, ''); // saca acentos
}

function nuevaReglaId() {
    return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// tabla: 'mayorista' | 'minorista'   nivel: 'Unidad' | 'Mayor'
function clavePrecio(tabla, nivel) { return tabla + nivel; }

// Lo que le SALE al negocio cada par, según el precio "por mayor" de la
// categoría (así lo pasó el dueño: los pares que se venden a 37.000 por mayor
// le cuestan 33.000, etc.). Solo se usa para SEMBRAR el costo de cada
// categoría la primera vez — después se edita a mano en Configuración.
const COSTO_POR_PRECIO_MAYOR = {
    37000: 33000,
    39000: 36000,
    42000: 39000,
    50000: 45000,
    31000: 26000, // ojotas
    35000: 30000, // mind
};

function costoSugerido(precios) {
    const costo = COSTO_POR_PRECIO_MAYOR[precios && precios.mayoristaMayor];
    return costo === undefined ? null : costo; // null = todavía no se cargó el costo
}

function crearCategoria(etiqueta, keywords, tipo, precios, opciones) {
    opciones = opciones || {};
    return {
        id: nuevaReglaId(),
        etiqueta,
        keywords,                  // array de strings (sin acentos, minúsculas)
        tipo: tipo || 'zapatilla', // 'zapatilla' (cuenta para el 5+) | 'ropa' (precio fijo)
        // Costo por unidad (lo que te sale a vos); null = sin dato todavía.
        costo: opciones.costo !== undefined ? opciones.costo : costoSugerido(precios),
        precios: {                 // los 4 precios; en 'ropa' solo se usan/muestran los "Unidad"
            mayoristaUnidad: precios.mayoristaUnidad || 0,
            mayoristaMayor: precios.mayoristaMayor || 0,
            minoristaUnidad: precios.minoristaUnidad || 0,
            minoristaMayor: precios.minoristaMayor || 0,
        },
        volumen: opciones.volumen || null,        // { cantidadMinima, precio } o null
        // Casi ninguna categoría necesita esto: es para el puñado de casos
        // (como "niño/niña") donde esa palabra tiene que pesar MÁS que el
        // tipo de calzado, sin importar qué palabra clave sea más larga.
        prioritaria: !!opciones.prioritaria,
    };
}

// ----------------------------------------------------------------------------
// VALORES POR DEFECTO
// ----------------------------------------------------------------------------
function categoriasPorDefecto() {
    return [
        crearCategoria('Remera', ['remera'], 'ropa',
            { mayoristaUnidad: 17000, minoristaUnidad: 20000 },
            { volumen: { cantidadMinima: 10, precio: 15000 } }),
        crearCategoria('Baggy NK', ['baggy'], 'ropa',
            { mayoristaUnidad: 24000, minoristaUnidad: 28000 },
            { volumen: { cantidadMinima: 10, precio: 22000 } }),

        // "Niño/niña" tiene que pesar más que el tipo de calzado (ej.
        // "Botitas niño" es precio de niño, no precio de botitas), así que
        // es la única categoría marcada "prioritaria".
        crearCategoria('Niño/niños', ['nino', 'ninos', 'nina', 'ninas'], 'zapatilla',
            { mayoristaUnidad: 35000, mayoristaMayor: 30000, minoristaUnidad: 35000, minoristaMayor: 30000 },
            { prioritaria: true }),

        // "Ojotas Mind" y "Mind" (zapatilla) son dos modelos distintos que
        // comparten la palabra "Mind": como "ojota mind" es más específica
        // que "mind" sola, esta categoría le gana automáticamente sin
        // necesidad de ordenar nada.
        crearCategoria('Ojotas Mind (todos los colores)', ['ojota mind', 'ojotas mind', 'mind ojota', 'mind ojotas'], 'zapatilla',
            { mayoristaUnidad: 35000, mayoristaMayor: 35000, minoristaUnidad: 40000, minoristaMayor: 35000 }),
        crearCategoria('Mind (zapatilla, no es ojota)', ['mind'], 'zapatilla',
            { mayoristaUnidad: 37000, mayoristaMayor: 35000, minoristaUnidad: 40000, minoristaMayor: 35000 }),
        crearCategoria('Ojotas', ['ojota'], 'zapatilla',
            { mayoristaUnidad: 35000, mayoristaMayor: 31000, minoristaUnidad: 40000, minoristaMayor: 31000 }),

        crearCategoria('Jordan low pink', ['jordan low pink'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('Jordan 11 / Retro 11 panda', ['jordan 11', 'retro 11'], 'zapatilla',
            { mayoristaUnidad: 55000, mayoristaMayor: 50000, minoristaUnidad: 65000, minoristaMayor: 50000 }),
        crearCategoria('Jordan low 1 diamond / diamond pipa blanca / pink', ['jordan low 1 diamond', 'jordan diamond', 'jordan pink'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Jordan 1 brillosa', ['jordan 1 brillosa'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Jordan low glister', ['jordan low glister'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('Retro 4', ['retro 4'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('Retro 1', ['retro 1'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 55000, minoristaMayor: 37000 }),
        crearCategoria('Botitas', ['botita', 'botitas'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 50000, minoristaMayor: 39000 }),
        // "New Balance 530" (el combo completo) tiene que ganarle a "New
        // Balance" solo, así que se agrega como palabra clave propia —
        // sigue siendo la categoría "530" pero ahora también la reconoce
        // aunque diga "New Balance" antes del número.
        crearCategoria('530', ['530', 'new balance 530'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('New Balance / Nova (genérico)', ['new balance', 'nova'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 55000, minoristaMayor: 37000 }),
        crearCategoria('9060 (brillo)', ['9060 brillo', '9060 nuevas brillo'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('9060', ['9060'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('Abzorb', ['abzorb'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('Running', ['running'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),
        crearCategoria('Samba classic', ['samba classic'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 50000, minoristaMayor: 39000 }),
        crearCategoria('Samba total black', ['samba total black'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Jordan (genérico, sin otra palabra clave)', ['jordan'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 55000, minoristaMayor: 39000 }),

        crearCategoria('Cualquier modelo con "brillo"', ['brillo'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),

        // Mayorista solo tenía precio especial para "pipa gris/black"; el
        // resto de Nike V5/Air Jordan/NB4000 (más genérico) es otra
        // categoría aparte, con precio propio en minorista.
        crearCategoria('Nike V5 / Air Jordan pipa gris-black / NB 4000 negra', ['nike v5', 'air jordan pipa gris', 'air jordan pipa black', 'nb 4000 negra'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Air Jordan / NB 4000 (genérico)', ['air jordan', 'nb 4000'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 39000, minoristaUnidad: 60000, minoristaMayor: 39000 }),

        crearCategoria('Forum verde summer', ['forum verde summer'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Forum (genérico)', ['forum'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),

        crearCategoria('Adidas 2000', ['adidas 2000'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Adidas boas', ['adidas boas'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Puma 180', ['puma 180'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Puma (genérico)', ['puma'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Campus', ['campus'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Shox', ['shox'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('TL1', ['tl1'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),
        crearCategoria('Haylan', ['haylan'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 42000, minoristaUnidad: 60000, minoristaMayor: 42000 }),

        crearCategoria('Exclusivas white', ['exclusivas white'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 41000, minoristaUnidad: 60000, minoristaMayor: 41000 }),
        crearCategoria('Negras medias', ['negras medias'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 41000, minoristaUnidad: 60000, minoristaMayor: 41000 }),
        crearCategoria('Air force/forcé con medias', ['air force con medias', 'air forcé con medias'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 41000, minoristaUnidad: 60000, minoristaMayor: 41000 }),
        crearCategoria('Air force/forcé (sin medias)', ['air force', 'air forcé'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),

        crearCategoria('Super star', ['super star'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Glister/glitter', ['glister', 'glitter'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Dunk', ['dunk'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Vans', ['vans'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Knu', ['knu'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
        crearCategoria('Deportivas fit', ['deportivas fit'], 'zapatilla',
            { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 }),
    ];
}

function defaultPrecioPorDefecto() {
    return { mayoristaUnidad: 43000, mayoristaMayor: 37000, minoristaUnidad: 50000, minoristaMayor: 37000 };
}

function configPreciosPorDefecto() {
    return {
        categorias: categoriasPorDefecto(),
        defaultPrecios: defaultPrecioPorDefecto(),
        recargoCambio: 5000,
        costoDefault: costoSugerido(defaultPrecioPorDefecto()), // para modelos que no entran en ninguna categoría
    };
}

// Las configuraciones guardadas ANTES de existir el costo no lo tienen:
// se les siembra una sola vez (según COSTO_POR_PRECIO_MAYOR) sin tocar nada
// más. Devuelve true si cambió algo (para guardarla de nuevo).
function completarCostosFaltantes(config) {
    let cambio = false;
    (config.categorias || []).forEach(cat => {
        if (!('costo' in cat)) { cat.costo = costoSugerido(cat.precios); cambio = true; }
    });
    if (!('costoDefault' in config)) {
        config.costoDefault = costoSugerido(config.defaultPrecios);
        cambio = true;
    }
    return cambio;
}

// Cuánto le cuesta al negocio UN par de este modelo (según la categoría que
// le toque, igual que para el precio). null = falta cargar ese costo.
function costoUnitarioDeModelo(config, modelo) {
    const cat = matchearCategoria(config.categorias, normalizarTexto(modelo));
    const costo = cat ? cat.costo : config.costoDefault;
    return typeof costo === 'number' ? costo : null;
}

// ----------------------------------------------------------------------------
// MOTOR DE BÚSQUEDA (sin necesidad de ordenar nada a mano)
// ----------------------------------------------------------------------------
// Si varias categorías coinciden con el modelo, gana la de la palabra clave
// MÁS LARGA (más específica). Ej: "Ojotas Mind negras" coincide con "ojota"
// (categoría Ojotas) y con "ojotas mind" (categoría Ojotas Mind) — como
// "ojotas mind" es más larga/específica, esa categoría gana sola.
function matchearCategoria(categorias, modeloNormalizado) {
    // Primero las "prioritarias" (ej: niño/niña): si el modelo tiene alguna
    // de sus palabras, ganan siempre, sin importar qué tan larga sea la
    // palabra de otra categoría.
    for (const cat of categorias) {
        if (cat.prioritaria && (cat.keywords || []).some(k => k && modeloNormalizado.includes(k))) {
            return cat;
        }
    }
    // Después, gana la palabra clave más larga (más específica) entre el resto.
    let mejor = null;
    let mejorLargo = -1;
    for (const cat of categorias) {
        if (cat.prioritaria) continue;
        for (const kw of (cat.keywords || [])) {
            if (kw && modeloNormalizado.includes(kw) && kw.length > mejorLargo) {
                mejor = cat;
                mejorLargo = kw.length;
            }
        }
    }
    return mejor;
}

// 'zapatilla' (cuenta para el 5+) o 'ropa' (precio fijo, no depende de cuántos
// pares lleve el cliente).
function clasificarTipo(config, modelo) {
    const cat = matchearCategoria(config.categorias, normalizarTexto(modelo));
    return cat ? cat.tipo : 'zapatilla';
}

/**
 * Calcula el precio unitario de una línea de pedido.
 * @param {object} config - configPreciosPorDefecto() o la versión editada guardada
 * @param {string} tabla - 'mayorista' | 'minorista'
 * @param {string} modelo - nombre del modelo/producto de esta línea
 * @param {number} totalParesCliente - suma de pares (tipo zapatilla) que lleva el cliente en este pedido
 * @param {number} cantidadMismoModeloCliente - suma de unidades de ESTE mismo modelo/color que lleva el cliente
 * @returns {{precio:number, categoria:string, tipo:string, nivel:string}}
 */
function calcularPrecioUnitario(config, tabla, modelo, totalParesCliente, cantidadMismoModeloCliente) {
    const modeloNorm = normalizarTexto(modelo);
    const cat = matchearCategoria(config.categorias, modeloNorm);
    const tipo = cat ? cat.tipo : 'zapatilla';

    // La ropa tiene un precio fijo (no depende de la cantidad de pares):
    // siempre usa el precio "Unidad".
    const nivel = (tipo !== 'ropa' && totalParesCliente >= 5) ? 'Mayor' : 'Unidad';
    const clave = clavePrecio(tabla, nivel);

    let precio, categoria;
    if (cat) {
        precio = cat.precios[clave];
        categoria = cat.etiqueta;
        if (cat.volumen && cantidadMismoModeloCliente >= cat.volumen.cantidadMinima) {
            precio = cat.volumen.precio;
        }
    } else {
        precio = config.defaultPrecios[clave];
        categoria = 'Todo lo demás (default)';
    }

    return { precio, categoria, tipo, nivel: nivel.toLowerCase() };
}
