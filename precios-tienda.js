// ============================================================================
// PRECIOS DE LA TIENDA
// ============================================================================
// La tienda (plataforma-zapas) maneja sus precios en dos archivos de reglas:
//   precios-minorista.json  (público)   y   precios-mayorista.json (revendedores)
// más los precios propios de los modelos de casa (en el catálogo, productos.json).
// Acá se leen esos mismos archivos y se calcula el precio con la MISMA lógica que
// usa la tienda (motor/js/pricing.js): gana la primera regla que coincide, "empieza
// con" ignora la marca, precio propio de cada modelo, "sin precio por mayor", etc.
//
// Así el precio de la app y el de la tienda salen del mismo lugar. Si no se pueden
// leer (sin internet y sin copia guardada), la app sigue con sus categorías de
// Configuración, como antes (calcularPrecioUnitario en pricing.js).
//
// Lo que NO viene de la tienda y sigue siendo de la app: el costo por par y las
// palabras clave de cada categoría (para saber la ganancia y si es ropa).
// ============================================================================
const PreciosTienda = (function () {
    const BASE = 'https://mitiendazapas.github.io/';
    const ARCHIVOS = { minorista: BASE + 'precios-minorista.json', mayorista: BASE + 'precios-mayorista.json' };
    const URL_CATALOGO = 'https://mitiendastock.com/api/tienda/laimp/productos.json';
    // "Cambiar precios" del panel: sube/baja TODA la lista (en % y/o en pesos) y no está en los JSON de reglas.
    const URL_AJUSTES = 'https://mitiendastock.com/api/tienda/laimp/ajustes.json';
    const CELDAS_AJUSTE = {
        'publico:br': ['brPercent', 'brAmount'], 'mayorista:br': ['resalePercent', 'resaleAmount'],
        'publico:g5': ['g5Percent', 'g5Amount'], 'mayorista:g5': ['g5ResalePercent', 'g5ResaleAmount'],
    };
    const CADENA_AJUSTE = {   // misma cascada que motor/js/ajuste-lista.js
        'publico:br': ['publico:br'], 'mayorista:br': ['mayorista:br', 'publico:br'],
        'publico:g5': ['publico:g5', 'publico:br'],
        'mayorista:g5': ['mayorista:g5', 'mayorista:br', 'publico:g5', 'publico:br'],
    };
    const CLAVE = 'preciosTienda:v1';
    const REFRESCO_MS = 5 * 60 * 1000;

    let compilado = null;      // { minorista, mayorista, porNombre, marcas }
    let info = { actualizadoEl: 0, desdeCopia: false, error: null };
    let ultimoJson = '';
    const oyentes = [];

    // Texto para comparar (igual que priceKey de la tienda): "TL1", "TL 1" y "TL-1" quedan iguales.
    function pk(texto) {
        return String(texto == null ? '' : texto)
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim()
            .replace(/-/g, ' ')
            .replace(/([a-z])(?=\d)|(\d)(?=[a-z])/g, '$1$2 ')
            .replace(/\s+/g, ' ').trim();
    }

    function compilarLista(lista) {
        return {
            def: Number(lista && lista.default) || 0,
            reglas: ((lista && lista.rules) || []).map(r => ({
                precio: Number(r.price) || 0,
                bulk: r.bulk ? { min: Number(r.bulk.min), precio: Number(r.bulk.price) } : null,
                contains: (r.contains || []).map(pk),
                containsAll: (r.containsAll || []).map(pk),
                startsWith: (r.startsWith || []).map(pk),
                category: r.category || [],
            })),
        };
    }

    function coincide(r, clave, corta, categoria) {
        if (r.category.length) return r.category.includes(categoria);
        if (r.startsWith.some(t => clave.startsWith(t) || corta.startsWith(t))) return true;
        if (r.contains.some(t => clave.includes(t))) return true;
        return r.containsAll.length > 0 && r.containsAll.every(t => clave.includes(t));
    }
    const buscar = (lista, clave, corta, categoria) => lista.reglas.find(r => coincide(r, clave, corta, categoria)) || null;

    // { percent, amount } de "Cambiar precios" para una versión ('publico'|'mayorista') y calidad ('br'|'g5').
    function ajusteDe(ajustes, version, calidad) {
        for (const clave of CADENA_AJUSTE[version + ':' + calidad]) {
            const [kp, ka] = CELDAS_AJUSTE[clave];
            if (ajustes && (ajustes[kp] != null || ajustes[ka] != null)) {
                return { percent: Number(ajustes[kp]) || 0, amount: Number(ajustes[ka]) || 0 };
            }
        }
        return { percent: 0, amount: 0 };
    }

    function compilarTabla(t, ajustes, version) {
        const ajuste = o => ({ percent: Number(o && o.percent) || 0, amount: Number(o && o.amount) || 0 });
        const ajBr = ajusteDe(ajustes, version, 'br');
        const ajG5 = ajusteDe(ajustes, version, 'g5');
        // Igual que adjustedTable de la tienda: si hay algún ajuste en el panel, manda; si no, queda lo del JSON.
        const hayAjuste = ajBr.percent || ajBr.amount || ajG5.percent || ajG5.amount;
        const br = hayAjuste ? ajBr : ajuste(t);
        return {
            unit: compilarLista(t.unit),
            mayor: compilarLista(t.wholesalePrice),
            overrides: t.overrides || {},
            conMayor: t.wholesale !== false,
            br,
            g5: hayAjuste ? ajG5 : (t.g5Adjust ? ajuste(t.g5Adjust) : br),
        };
    }

    function compilar(datos) {
        const porNombre = new Map();
        const marcas = new Set();
        (datos.catalogo || []).forEach(p => {
            porNombre.set(pk(p.name), p);
            if (p.brand) marcas.add(pk(p.brand));
        });
        compilado = {
            minorista: compilarTabla(datos.minorista, datos.ajustes, 'publico'),
            mayorista: compilarTabla(datos.mayorista, datos.ajustes, 'mayorista'),
            porNombre,
            marcas: [...marcas].sort((a, b) => b.length - a.length),
        };
    }

    // "Nike mind negras" -> "mind negras" (así "empieza con mind " también sirve con la marca adelante).
    function sinMarca(clave, marca) {
        const prefijos = marca ? [pk(marca)] : compilado.marcas;
        for (const base of prefijos) {
            const todos = base === 'new balance' ? [base, 'nb'] : [base];
            for (const pre of todos) if (pre && clave.startsWith(pre + ' ')) return clave.slice(pre.length + 1);
        }
        return clave;
    }

    // Precio propio de un modelo de casa, según la versión de la tienda (igual que applyChannelPrices).
    function propios(prod, tabla) {
        if (!prod) return {};
        let price = prod.price, wp = prod.wholesalePrice;
        if (tabla === 'mayorista') {
            const r = prod.mayorista;
            if (prod.manual) {
                if (r && r.price) { price = r.price; wp = r.wholesalePrice || null; }
                else if (r && r.wholesalePrice) wp = r.wholesalePrice;
            } else { price = (r && r.price) || null; wp = (r && r.wholesalePrice) || null; }
        }
        return price ? { unit: price, wholesale: wp } : {};
    }

    /**
     * Precio de UN par según la tienda, o null si no se puede calcular (todavía no se leyeron las reglas).
     * nivel: 'Unidad' (menos de 5 pares) | 'Mayor' (5 o más)   tipo: 'zapatilla' | 'ropa'
     */
    function calcular(tabla, modelo, nivel, cantidadMismoModelo, tipo) {
        if (!compilado || !compilado[tabla]) return null;
        const t = compilado[tabla];
        const clave = pk(modelo);
        if (!clave) return null;
        const prod = compilado.porNombre.get(clave) || null;
        const corta = sinMarca(clave, prod && prod.brand);
        const categoria = (prod && prod.category) || '';
        const ajustar = precio => {
            const { percent, amount } = categoria === 'g5' ? t.g5 : t.br;
            if (!precio || (!percent && !amount)) return precio;
            const escalado = percent ? Math.round((precio * (1 + percent)) / 100) * 100 : precio;
            return Math.max(100, escalado + amount);
        };

        const propio = propios(prod, tabla);
        const override = (prod && (t.overrides[prod.slug] || t.overrides[prod.id])) || propio;
        const reglaUnidad = (prod && prod.manual) ? null : buscar(t.unit, clave, corta, categoria);
        const unidad = Number(override.unit) || ajustar((reglaUnidad && reglaUnidad.precio) || t.unit.def);

        const bulkPropio = prod && prod.bulk && prod.bulk.min && prod.bulk.price && prod.bulk.price < unidad
            ? { min: prod.bulk.min, precio: prod.bulk.price } : null;
        const bulk = bulkPropio || ((prod && prod.manual) ? null : (reglaUnidad && reglaUnidad.bulk) || null);
        if (bulk && cantidadMismoModelo >= bulk.min) return { precio: bulk.precio, origen: 'tienda' };

        let precio = unidad;
        if (nivel === 'Mayor' && tipo !== 'ropa' && t.conMayor && !bulk) {
            let mayor = (prod && prod.manual)
                ? (Number(propio.wholesale) || null)
                : (Number(override.wholesale) || ajustar((buscar(t.mayor, clave, corta, categoria) || {}).precio || t.mayor.def));
            if (override.wholesale === false || (prod && prod.noWholesale)) mayor = null;
            if (mayor && mayor < unidad) precio = mayor;   // un "por mayor" que no conviene no se usa
        }
        return { precio, origen: 'tienda' };
    }

    // ---- lectura de la tienda -------------------------------------------------------------------
    function guardarCopia(datos) {
        try { localStorage.setItem(CLAVE, JSON.stringify(datos)); } catch (e) { /* sin almacenamiento */ }
    }
    function leerCopia() {
        try {
            const d = JSON.parse(localStorage.getItem(CLAVE) || 'null');
            return d && d.minorista && d.mayorista ? d : null;
        } catch (e) { return null; }
    }
    function compactarCatalogo(c) {
        const lista = (c && (c.products || c.productos)) || [];
        return lista.map(p => ({
            id: p.id, slug: String(p.slug || p.id), name: String(p.name || ''), brand: p.brand || '',
            category: p.category || '', manual: p.manual === true, noWholesale: p.noWholesale === true,
            price: Number(p.price) > 0 ? Number(p.price) : null,
            wholesalePrice: Number(p.wholesalePrice) > 0 ? Number(p.wholesalePrice) : null,
            bulk: p.bulk && Number(p.bulk.min) > 1 && Number(p.bulk.price) > 0 ? { min: Number(p.bulk.min), price: Number(p.bulk.price) } : null,
            mayorista: p.mayorista && typeof p.mayorista === 'object' ? {
                price: Number(p.mayorista.price) > 0 ? Number(p.mayorista.price) : null,
                wholesalePrice: Number(p.mayorista.wholesalePrice) > 0 ? Number(p.mayorista.wholesalePrice) : null,
            } : null,
        })).filter(p => p.name);
    }
    async function pedirJson(url) {
        const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    async function actualizar() {
        try {
            const [minorista, mayorista, catalogoBruto, ajustesBruto] = await Promise.all([
                pedirJson(ARCHIVOS.minorista), pedirJson(ARCHIVOS.mayorista),
                pedirJson(URL_CATALOGO).catch(() => null),   // sin catálogo igual se calculan las reglas
                pedirJson(URL_AJUSTES).catch(() => null),
            ]);
            const anterior = leerCopia();
            const datos = {
                minorista, mayorista,
                catalogo: catalogoBruto ? compactarCatalogo(catalogoBruto) : ((anterior && anterior.catalogo) || []),
                ajustes: ajustesBruto || ((anterior && anterior.ajustes) || null),
                actualizadoEl: Date.now(),
            };
            const firma = JSON.stringify([datos.minorista, datos.mayorista, datos.catalogo, datos.ajustes]);
            compilar(datos);
            info = { actualizadoEl: datos.actualizadoEl, desdeCopia: false, error: null,
                ajustes: ajustesBruto ? 'ok' : (datos.ajustes ? 'copia' : 'no') };
            guardarCopia(datos);
            if (firma !== ultimoJson) { ultimoJson = firma; avisar(); }
            else avisar(true);
            return true;
        } catch (e) {
            info = { ...info, error: (e && e.message) || 'sin conexión' };
            avisar(true);
            return false;
        }
    }

    function avisar(sinCambioDePrecios) {
        oyentes.forEach(fn => { try { fn(!!sinCambioDePrecios); } catch (e) { console.error(e); } });
    }

    function iniciar() {
        const copia = leerCopia();
        if (copia) {
            try {
                compilar(copia);
                info = { actualizadoEl: copia.actualizadoEl || 0, desdeCopia: true, error: null, ajustes: copia.ajustes ? 'copia' : 'no' };
                ultimoJson = JSON.stringify([copia.minorista, copia.mayorista, copia.catalogo, copia.ajustes]);
            } catch (e) { compilado = null; }
        }
        actualizar();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && Date.now() - info.actualizadoEl > REFRESCO_MS) actualizar();
        });
        setInterval(() => { if (document.visibilityState === 'visible') actualizar(); }, 10 * 60 * 1000);
    }

    return {
        iniciar, actualizar, calcular,
        listo: () => !!compilado,
        info: () => ({ ...info }),
        alCambiar: fn => { oyentes.push(fn); },
        _pk: pk,
    };
})();
