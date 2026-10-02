// ============================================================================
// ESTADÍSTICAS — panel propio (Panel / Rentabilidad / Cierres / Control)
//
// Principios:
//  • Los números NUNCA se recalculan con datos de hoy: cada cierre guarda,
//    línea por línea, el precio, el costo y la ganancia de ese momento
//    (ver registrarEstadisticasDeLista en app.js). Los cierres viejos, de
//    antes del detalle, se marcan como "Estimado".
//  • Todo número se puede auditar: pestaña Cierres → detalle de cada venta.
//  • La pestaña Control avisa de cualquier dato raro (margen fuera de rango,
//    precios ridículos, duplicados, ganancias estimadas...).
//  • Lectura puntual de Firestore al abrir / cambiar de período (nunca en vivo).
// ============================================================================
(function () {
    'use strict';

    const MARGEN_MIN_NORMAL = 0.05;   // por debajo de esto el cierre es sospechoso
    const MARGEN_MAX_NORMAL = 0.30;   // por encima también
    const PRECIO_PAR_MIN = 15000;     // facturación por par fuera de este rango = sospechoso
    const PRECIO_PAR_MAX = 120000;

    const E = {
        mes: null,            // 'YYYY-MM' seleccionado
        tab: 'panel',
        cache: {},            // mesId -> [cierre normalizado]
        orden: { col: 'gan', dir: -1 },
        vistaRent: 'categoria',
        cargando: false,
    };

    // ---------- utilidades ---------------------------------------------------
    const num = v => parseFloat(v) || 0;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pesos = n => (typeof formatoPesos === 'function' ? formatoPesos(n) : '$' + Math.round(n));
    const pct = (n, dec = 1) => (n * 100).toLocaleString('es-AR', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + '%';
    const fechaCorta = f => (typeof formatoFechaLegible === 'function' ? formatoFechaLegible(f) : f);

    function pesosCorto(v) {
        const a = Math.abs(v), s = v < 0 ? '-' : '';
        if (a >= 1e6) return s + '$' + (a / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 2 }) + ' M';
        if (a >= 1e3) return s + '$' + Math.round(a / 1e3).toLocaleString('es-AR') + ' mil';
        return s + '$' + Math.round(a);
    }

    function nombreMes(id) {
        const [y, m] = id.split('-').map(Number);
        const t = new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
        return t.charAt(0).toUpperCase() + t.slice(1);
    }

    function mesesDisponibles() {
        const hoy = new Date();
        const out = [];
        for (let i = 0; i < 12; i++) out.push(idMes(new Date(hoy.getFullYear(), hoy.getMonth() - i, 1)));
        return out;
    }

    function mesAnterior(id) {
        const [y, m] = id.split('-').map(Number);
        return idMes(new Date(y, m - 2, 1));
    }

    function claveModelo(m) {
        return typeof normalizarModelo === 'function' ? normalizarModelo(m) : String(m).toLowerCase().trim();
    }

    // ---------- normalización de un cierre ----------------------------------
    function normalizarCierre(c) {
        const fact = num(c.facturacion), pares = num(c.cantidadPares), pedidos = num(c.cantidadPedidos);
        const modelos = c.modelosVendidos || {};
        let ganancia, estimada = false, sinCosto = num(c.lineasSinCosto);
        if (typeof c.ganancia === 'number') {
            ganancia = c.ganancia;
        } else {
            // Cierre anterior al costo: se estima con los costos actuales.
            let costo = 0; sinCosto = 0; estimada = true;
            Object.entries(modelos).forEach(([modelo, cant]) => {
                const n = num(cant);
                const cu = (typeof precioConfig !== 'undefined' && precioConfig) ? costoUnitarioDeModelo(precioConfig, modelo) : null;
                if (cu === null) sinCosto += n; else costo += cu * n;
            });
            ganancia = fact - costo;
        }
        return {
            id: c.id, fecha: c.fecha || '', fact, pares, pedidos, ganancia, estimada, sinCosto,
            lineas: Array.isArray(c.lineas) ? c.lineas : null,
            modelos, corregido: !!c.corregido, nota: c.correccionNota || '',
            cobrado: typeof c.cobrado === 'number' ? c.cobrado : null,
            pendiente: typeof c.pendiente === 'number' ? c.pendiente : null,
        };
    }

    // ---------- control de calidad ------------------------------------------
    function alertasDeCierre(c) {
        const a = [];
        const margen = c.fact > 0 ? c.ganancia / c.fact : 0;
        if (c.fact > 0 && (margen < MARGEN_MIN_NORMAL || margen > MARGEN_MAX_NORMAL)) {
            a.push({ nivel: 'aviso', texto: `Margen de ${pct(margen)}, fuera del rango habitual (${pct(MARGEN_MIN_NORMAL, 0)}–${pct(MARGEN_MAX_NORMAL, 0)}). Revisá los precios de ese cierre.` });
        }
        if (c.pares > 0) {
            const porPar = c.fact / c.pares;
            if (porPar < PRECIO_PAR_MIN || porPar > PRECIO_PAR_MAX) {
                a.push({ nivel: 'aviso', texto: `Facturación por par de ${pesos(porPar)}: fuera de lo normal (${pesos(PRECIO_PAR_MIN)}–${pesos(PRECIO_PAR_MAX)}).` });
            }
        }
        if (c.estimada) a.push({ nivel: 'info', texto: 'Cierre anterior al detalle por venta: su ganancia es una ESTIMACIÓN con los costos actuales.' });
        if (c.sinCosto > 0) a.push({ nivel: 'aviso', texto: `${c.sinCosto} par(es) sin costo cargado: la ganancia está incompleta.` });
        if (c.corregido) a.push({ nivel: 'info', texto: c.nota || 'Este cierre fue corregido manualmente (hay una copia del original guardada).' });
        if (c.lineas) {
            const ventas = c.lineas.filter(l => !l.cambio);
            const sinPrecio = ventas.filter(l => !(num(l.importe) > 0));
            if (sinPrecio.length) a.push({ nivel: 'error', texto: `${sinPrecio.length} venta(s) sin precio: ${sinPrecio.slice(0, 3).map(l => `${l.cliente} – ${l.modelo}`).join('; ')}${sinPrecio.length > 3 ? '…' : ''}` });
            const chicos = ventas.filter(l => num(l.importe) > 0 && num(l.importe) / (num(l.cantidad) || 1) < 1000);
            if (chicos.length) a.push({ nivel: 'error', texto: `${chicos.length} venta(s) con precio menor a $1.000.` });
            const perdidas = ventas.filter(l => l.ganancia !== null && l.ganancia < 0 && num(l.importe) / (num(l.cantidad) || 1) >= 1000);
            if (perdidas.length) a.push({ nivel: 'aviso', texto: `${perdidas.length} venta(s) por debajo del costo.` });
            const sinCat = ventas.filter(l => l.categoria === 'Sin categoría');
            if (sinCat.length) a.push({ nivel: 'info', texto: `${sinCat.length} venta(s) de modelos sin categoría de precios (usan el precio y costo por defecto): ${[...new Set(sinCat.map(l => l.modelo))].slice(0, 4).join('; ')}. Conviene crear su regla en Configuración.` });
        }
        return a;
    }

    // Marca duplicados entre todos los cierres cargados (mismo día, mismos totales).
    function alertasDeDuplicados(cierres) {
        const out = {};
        const vistos = {};
        cierres.forEach(c => {
            const k = `${c.fecha}|${c.fact}|${c.pedidos}|${c.pares}`;
            (vistos[k] = vistos[k] || []).push(c);
        });
        Object.values(vistos).forEach(grupo => {
            if (grupo.length > 1) grupo.forEach(c => { (out[c.id] = out[c.id] || []).push({ nivel: 'error', texto: `Posible cierre DUPLICADO: hay ${grupo.length} cierres idénticos el ${fechaCorta(c.fecha)}.` }); });
        });
        const porDia = {};
        cierres.forEach(c => { (porDia[c.fecha] = porDia[c.fecha] || []).push(c); });
        Object.values(porDia).forEach(grupo => {
            if (grupo.length > 1) grupo.forEach(c => {
                if (!(out[c.id] || []).some(x => x.nivel === 'error')) (out[c.id] = out[c.id] || []).push({ nivel: 'info', texto: `Hubo ${grupo.length} cierres el ${fechaCorta(c.fecha)} (puede ser normal si cargaste dos listas ese día).` });
            });
        });
        return out;
    }

    // ---------- agregación del período --------------------------------------
    function agregar(cierres) {
        const t = { fact: 0, gan: 0, pares: 0, pedidos: 0, n: cierres.length, sinCosto: 0, estimados: 0, conDetalle: 0 };
        const porDia = {};
        const modelosUnid = {};
        const cats = {};
        const mods = {};
        let paresDetalle = 0;

        cierres.forEach(c => {
            t.fact += c.fact; t.gan += c.ganancia; t.pares += c.pares; t.pedidos += c.pedidos; t.sinCosto += c.sinCosto;
            if (c.estimada) t.estimados++;
            if (c.lineas) t.conDetalle++;

            const d = porDia[c.fecha] = porDia[c.fecha] || { fecha: c.fecha, fact: 0, gan: 0, pares: 0, pedidos: 0, modelos: {}, cierres: 0 };
            d.fact += c.fact; d.gan += c.ganancia; d.pares += c.pares; d.pedidos += c.pedidos; d.cierres++;

            Object.entries(c.modelos).forEach(([nombre, cant]) => {
                const k = claveModelo(nombre);
                const n = num(cant);
                const m1 = modelosUnid[k] = modelosUnid[k] || { nombre, n: 0 };
                m1.n += n;
                const m2 = d.modelos[k] = d.modelos[k] || { nombre, n: 0 };
                m2.n += n;
            });

            if (c.lineas) {
                c.lineas.forEach(l => {
                    const cat = l.categoria || 'Sin categoría';
                    const cant = l.cambio ? 0 : (num(l.cantidad) || 1);
                    const imp = num(l.importe) + num(l.recargo);
                    const conCosto = l.ganancia !== null && l.ganancia !== undefined;
                    const g = conCosto ? num(l.ganancia) : 0;
                    const ca = cats[cat] = cats[cat] || { nombre: cat, pares: 0, fact: 0, factConCosto: 0, gan: 0, sinCosto: 0 };
                    ca.pares += cant; ca.fact += imp; if (conCosto) { ca.factConCosto += imp; ca.gan += g; } else if (imp > 0) ca.sinCosto++;
                    if (!l.cambio) {
                        paresDetalle += cant;
                        const k = claveModelo(l.modelo);
                        const mo = mods[k] = mods[k] || { nombre: l.modelo, categoria: cat, pares: 0, fact: 0, factConCosto: 0, gan: 0, sinCosto: 0 };
                        mo.pares += cant; mo.fact += imp; if (conCosto) { mo.factConCosto += imp; mo.gan += g; } else if (imp > 0) mo.sinCosto++;
                    }
                });
            }
        });

        const dias = Object.values(porDia).sort((a, b) => a.fecha.localeCompare(b.fecha));
        return {
            t, dias,
            ranking: Object.values(modelosUnid).sort((a, b) => b.n - a.n),
            cats: Object.values(cats), mods: Object.values(mods),
            paresDetalle, cobertura: t.pares > 0 ? paresDetalle / t.pares : 0,
        };
    }

    // ---------- carga de datos ----------------------------------------------
    async function cargarMes(id, forzar) {
        if (!forzar && E.cache[id]) return E.cache[id];
        const crudos = await Store.obtenerCierresDelMes(id);
        const norm = (crudos || []).map(normalizarCierre).sort((a, b) => a.fecha.localeCompare(b.fecha) || 0);
        E.cache[id] = norm;
        return norm;
    }

    // ---------- gráficos ----------------------------------------------------
    function pasoBonito(crudo) {
        const p = Math.pow(10, Math.floor(Math.log10(crudo || 1)));
        const f = crudo / p;
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    }

    // Columnas verticales: un solo eje, 0 como base, marcas finas, tooltip al pasar.
    function graficoColumnas(items, color) {
        if (!items.length) return '<p class="vacio">Sin datos en este período.</p>';
        const vals = items.map(i => i.valor);
        const max = Math.max(0, ...vals), min = Math.min(0, ...vals);
        const paso = pasoBonito(((max - min) || 1) / 4);
        const top = (Math.ceil(max / paso) * paso) || paso;
        const bottom = Math.floor(min / paso) * paso;
        const rango = (top - bottom) || 1;
        const y = v => ((v - bottom) / rango) * 100;
        const ticks = [];
        for (let v = bottom; v <= top + paso / 1000; v += paso) ticks.push(v);
        const conValores = items.length <= 10;
        const cadaX = Math.ceil(items.length / 12);
        const y0 = y(0);

        const cols = items.map((it, i) => {
            const pos = it.valor >= 0;
            const barra = pos
                ? `bottom:${y0}%;height:${Math.max(y(it.valor) - y0, 0.8)}%;border-radius:4px 4px 0 0;background:${color};`
                : `bottom:${y(it.valor)}%;height:${Math.max(y0 - y(it.valor), 0.8)}%;border-radius:0 0 4px 4px;background:var(--danger);`;
            const etiqueta = pos
                ? `bottom:calc(${y(it.valor)}% + 3px);`
                : `bottom:calc(${y(it.valor)}% - 15px);`;
            return `
            <div class="est-col" data-tip="${esc(it.tip)}">
                <div class="est-barra" style="${barra}"></div>
                ${conValores ? `<span class="est-valor" style="${etiqueta}">${esc(pesosCorto(it.valor))}</span>` : ''}
                ${i % cadaX === 0 ? `<span class="est-x">${esc(it.etiqueta)}</span>` : ''}
            </div>`;
        }).join('');

        return `
        <div class="est-chart">
            <div class="est-yaxis">${ticks.map(v => `<span style="bottom:${y(v)}%">${esc(pesosCorto(v))}</span>`).join('')}</div>
            <div class="est-plot">
                <div class="est-plot-inner" style="min-width:${items.length * 34}px">
                    ${ticks.map(v => `<div class="est-grid${v === 0 ? ' est-grid-cero' : ''}" style="bottom:${y(v)}%"></div>`).join('')}
                    <div class="est-cols">${cols}</div>
                </div>
            </div>
        </div>`;
    }

    // Barras horizontales (rankings). items: {nombre, valor, texto, tip}
    function barrasH(items, color) {
        if (!items.length) return '<p class="vacio">Sin datos en este período.</p>';
        const max = Math.max(...items.map(i => Math.abs(i.valor)), 1);
        return `<div class="est-hbars">${items.map(i => `
            <div class="est-hrow" data-tip="${esc(i.tip || '')}">
                <span class="est-hnombre">${esc(i.nombre)}</span>
                <span class="est-htrack"><span class="est-hbar" style="width:${Math.max(Math.abs(i.valor) / max * 100, 1.5)}%;background:${i.valor < 0 ? 'var(--danger)' : color}"></span></span>
                <span class="est-hvalor">${esc(i.texto)}</span>
            </div>`).join('')}</div>`;
    }

    // ---------- componentes -------------------------------------------------
    function delta(act, prev, esPuntos) {
        if (prev === null || prev === undefined) return '';
        if (esPuntos) {
            const d = (act - prev) * 100;
            if (Math.abs(d) < 0.05) return '<span class="est-delta est-delta-igual">= igual</span>';
            return `<span class="est-delta ${d > 0 ? 'est-delta-sube' : 'est-delta-baja'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toLocaleString('es-AR', { maximumFractionDigits: 1 })} pp</span>`;
        }
        if (!prev) return '<span class="est-delta est-delta-igual">sin datos previos</span>';
        const d = (act - prev) / Math.abs(prev);
        if (Math.abs(d) < 0.0005) return '<span class="est-delta est-delta-igual">= igual</span>';
        return `<span class="est-delta ${d > 0 ? 'est-delta-sube' : 'est-delta-baja'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d * 100).toLocaleString('es-AR', { maximumFractionDigits: 0 })}%</span>`;
    }

    function kpi(etiqueta, valor, deltaHtml, clase, ayuda) {
        return `<div class="est-kpi ${clase || ''}" ${ayuda ? `data-tip="${esc(ayuda)}"` : ''}>
            <span class="est-kpi-etiqueta">${esc(etiqueta)}</span>
            <span class="est-kpi-valor">${valor}</span>
            <span class="est-kpi-pie">${deltaHtml || '&nbsp;'}</span>
        </div>`;
    }

    function badge(texto, clase, tip) {
        return `<span class="est-badge ${clase}" ${tip ? `data-tip="${esc(tip)}"` : ''}>${esc(texto)}</span>`;
    }

    function topN(mapa, n) {
        return Object.values(mapa).sort((a, b) => b.n - a.n).slice(0, n);
    }

    // ---------- pestañas ----------------------------------------------------
    function htmlPanel(ag, agPrev, alertasTotales) {
        const t = ag.t, p = agPrev.t;
        const margen = t.fact > 0 ? t.gan / t.fact : 0;
        const margenPrev = p.fact > 0 ? p.gan / p.fact : null;
        const gPar = t.pares > 0 ? t.gan / t.pares : 0;
        const gParPrev = p.pares > 0 ? p.gan / p.pares : null;
        const fPar = t.pares > 0 ? t.fact / t.pares : 0;
        const hayPrev = agPrev.t.n > 0;
        const aprox = (t.estimados > 0 || t.sinCosto > 0);
        // El mes en curso todavía no terminó: compararlo contra el mes anterior
        // completo con una flecha engaña. Ahí se muestra el valor del mes
        // anterior; las flechas quedan para los totales de meses completos y
        // para métricas que no dependen del volumen (margen, ganancia por par).
        const parcial = E.mes === idMes(new Date());
        const volumen = (act, prev, fmt) => !hayPrev ? ''
            : (parcial ? `<span class="est-sub">Mes anterior (completo): ${fmt(prev)}</span>` : delta(act, prev) + ' vs mes ant.');

        const graves = alertasTotales.filter(a => a.nivel !== 'info').length;
        const banner = graves > 0
            ? `<div class="est-aviso est-aviso-warn">⚠️ Hay <strong>${graves}</strong> alerta${graves === 1 ? '' : 's'} de control en este período. <a href="#" onclick="Est.tab('control');return false;">Ver detalle →</a></div>`
            : (t.n > 0 ? '<div class="est-aviso est-aviso-ok">✅ Control de datos: sin alertas en este período.</div>' : '');
        const bannerAprox = aprox ? `<div class="est-aviso est-aviso-info">ℹ️ ${t.estimados > 0 ? `${t.estimados} cierre(s) sin detalle por venta: su ganancia es una estimación.` : ''} ${t.sinCosto > 0 ? `Faltan costos de ${t.sinCosto} par(es).` : ''} Los cierres nuevos guardan todo exacto.</div>` : '';

        const itemsFact = ag.dias.map(d => ({ etiqueta: fechaCorta(d.fecha), valor: d.fact, tip: `${fechaCorta(d.fecha)}\nFacturación: ${pesos(d.fact)}\n${d.pares} pares · ${d.pedidos} pedidos` }));
        const itemsGan = ag.dias.map(d => ({ etiqueta: fechaCorta(d.fecha), valor: d.gan, tip: `${fechaCorta(d.fecha)}\nGanancia: ${pesos(d.gan)}\nMargen: ${d.fact > 0 ? pct(d.gan / d.fact) : '—'}` }));
        const top = ag.ranking.slice(0, 8).map(m => ({ nombre: m.nombre, valor: m.n, texto: `${m.n} par${m.n === 1 ? '' : 'es'}`, tip: `${m.nombre}: ${m.n} par(es) vendidos` }));

        return `
        ${banner}${bannerAprox}
        <div class="est-kpis">
            ${kpi('Facturación', pesos(t.fact), volumen(t.fact, p.fact, pesos), 'est-kpi-fact', 'Total facturado (bruto) en los cierres del período.')}
            ${kpi('Ganancia' + (aprox ? ' (aprox.)' : ''), pesos(t.gan), volumen(t.gan, p.gan, pesos), 'est-kpi-gan', 'Facturación menos el costo de cada par vendido. Los "Cambio" suman su recargo completo.')}
            ${kpi('Margen', t.fact > 0 ? pct(margen) : '—', hayPrev ? delta(margen, margenPrev, true) + ' vs mes ant.' : '', '', 'Ganancia ÷ facturación.')}
            ${kpi('Pares vendidos', t.pares.toLocaleString('es-AR'), volumen(t.pares, p.pares, n => n.toLocaleString('es-AR')), '', 'Sin contar los "Cambio" de talle.')}
            ${kpi('Ganancia por par', t.pares > 0 ? pesos(gPar) : '—', hayPrev ? delta(gPar, gParPrev) + ' vs mes ant.' : '', '', 'Ganancia promedio de cada par vendido.')}
            ${kpi('Facturación por par', t.pares > 0 ? pesos(fPar) : '—', t.n > 0 ? `${t.n} cierre${t.n === 1 ? '' : 's'} · ${pesos(t.fact / t.n)} c/u` : '', '', 'Precio promedio de venta de un par.')}
        </div>

        <div class="est-grid2">
            <section class="est-card"><h3 class="est-h3">Facturación por día</h3>${graficoColumnas(itemsFact, 'var(--est-fact)')}</section>
            <section class="est-card"><h3 class="est-h3">Ganancia por día</h3>${graficoColumnas(itemsGan, 'var(--est-gan)')}</section>
        </div>

        <div class="est-grid2">
            <section class="est-card"><h3 class="est-h3">Modelos más vendidos <span class="est-sub">(pares)</span></h3>${barrasH(top, 'var(--est-fact)')}</section>
            <section class="est-card"><h3 class="est-h3">Ventas por día <span class="est-sub">(tocá un día para ver su top)</span></h3>${tablaDias(ag)}</section>
        </div>`;
    }

    function tablaDias(ag) {
        if (!ag.dias.length) return '<p class="vacio">Sin cierres registrados.</p>';
        return `<div class="tabla-scroll"><table class="est-tabla">
            <thead><tr><th>Fecha</th><th>Pares</th><th>Facturación</th><th>Ganancia</th><th>Margen</th></tr></thead>
            <tbody>${ag.dias.slice().reverse().map(d => {
                const id = 'est-dia-' + d.fecha;
                const top = topN(d.modelos, 5);
                return `<tr class="est-fila-click" onclick="Est.toggle('${id}')">
                    <td>${fechaCorta(d.fecha)}${d.cierres > 1 ? ` <span class="est-sub">(${d.cierres} cierres)</span>` : ''}</td>
                    <td>${d.pares}</td><td>${pesos(d.fact)}</td>
                    <td class="${d.gan < 0 ? 'est-neg' : 'est-pos'}">${pesos(d.gan)}</td>
                    <td>${d.fact > 0 ? pct(d.gan / d.fact) : '—'}</td></tr>
                <tr id="${id}" class="est-detalle"><td colspan="5"><strong>Top del ${fechaCorta(d.fecha)}:</strong>
                    ${top.length ? `<ol class="est-top-dia">${top.map(m => `<li>${esc(m.nombre)} <span class="est-badge est-b-neutro">×${m.n}</span></li>`).join('')}</ol>` : '<p class="vacio">Sin modelos registrados.</p>'}</td></tr>`;
            }).join('')}</tbody></table></div>`;
    }

    function htmlRentabilidad(ag) {
        const pctCob = ag.cobertura;
        const margenGlobal = (() => {
            const f = ag.cats.reduce((s, c) => s + c.factConCosto, 0);
            const g = ag.cats.reduce((s, c) => s + c.gan, 0);
            return f > 0 ? g / f : 0;
        })();

        if (ag.t.n > 0 && ag.paresDetalle === 0) {
            return `<div class="est-aviso est-aviso-info">ℹ️ Los cierres de este período son anteriores al detalle por venta, así que todavía no se puede calcular la rentabilidad por modelo o categoría. Se activa sola con el próximo "📊 Cargar a Estadísticas".</div>
            <section class="est-card"><h3 class="est-h3">Modelos más vendidos <span class="est-sub">(pares)</span></h3>${barrasH(ag.ranking.slice(0, 15).map(m => ({ nombre: m.nombre, valor: m.n, texto: `${m.n} par${m.n === 1 ? '' : 'es'}`, tip: '' })), 'var(--est-fact)')}</section>`;
        }
        if (ag.t.n === 0) return '<p class="vacio">Sin cierres registrados en este período.</p>';

        const aviso = pctCob < 0.999
            ? `<div class="est-aviso est-aviso-info">ℹ️ Rentabilidad calculada sobre <strong>${ag.paresDetalle} de ${ag.t.pares} pares</strong> (${pct(pctCob, 0)}): solo los cierres con detalle por venta.</div>` : '';

        const filas = (lista) => {
            const { col, dir } = E.orden;
            const valor = x => col === 'nombre' ? x.nombre.toLowerCase()
                : col === 'margen' ? (x.factConCosto > 0 ? x.gan / x.factConCosto : -1)
                : col === 'porPar' ? (x.pares > 0 ? x.gan / x.pares : -1e12)
                : x[col];
            return lista.slice().sort((a, b) => {
                const va = valor(a), vb = valor(b);
                return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * dir;
            });
        };
        const th = (col, txt) => `<th class="est-th-orden" onclick="Est.ordenar('${col}')">${txt}${E.orden.col === col ? (E.orden.dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
        const filaHtml = (x, conCat) => {
            const margen = (x.factConCosto > 0 && x.nombre !== 'Cambio de talle') ? x.gan / x.factConCosto : null;
            const claseM = margen === null ? '' : (margen >= margenGlobal ? 'est-pos' : 'est-neg-suave');
            return `<tr><td class="est-izq">${esc(x.nombre)}${conCat ? ` <span class="est-sub">· ${esc(x.categoria)}</span>` : ''}${x.sinCosto ? ` ${badge('sin costo', 'est-b-warn', 'Hay ventas de este grupo sin costo cargado')}` : ''}</td>
                <td>${x.pares}</td><td>${pesos(x.fact)}</td>
                <td class="${x.gan < 0 ? 'est-neg' : 'est-pos'}">${pesos(x.gan)}</td>
                <td class="${claseM}">${margen === null ? '—' : pct(margen)}</td>
                <td>${x.pares > 0 ? pesos(x.gan / x.pares) : '—'}</td></tr>`;
        };
        const cabecera = `<thead><tr>${th('nombre', 'Nombre')}${th('pares', 'Pares')}${th('fact', 'Facturación')}${th('gan', 'Ganancia')}${th('margen', 'Margen')}${th('porPar', 'Gan. por par')}</tr></thead>`;

        const porCat = filas(ag.cats);
        const porMod = filas(ag.mods);
        const grafCat = porCat.slice().sort((a, b) => b.gan - a.gan).slice(0, 12).map(c => ({
            nombre: c.nombre, valor: c.gan, texto: pesosCorto(c.gan),
            tip: `${c.nombre}\nGanancia: ${pesos(c.gan)}\n${c.pares} pares · margen ${c.factConCosto > 0 ? pct(c.gan / c.factConCosto) : '—'}`,
        }));
        const grafMod = porMod.slice().sort((a, b) => b.gan - a.gan).slice(0, 10).map(m => ({
            nombre: m.nombre, valor: m.gan, texto: pesosCorto(m.gan),
            tip: `${m.nombre}\nGanancia: ${pesos(m.gan)}\n${m.pares} par(es)`,
        }));
        const mostrandoCat = E.vistaRent === 'categoria';

        return `${aviso}
        <div class="est-grid2">
            <section class="est-card"><h3 class="est-h3">Ganancia por categoría</h3>${barrasH(grafCat, 'var(--est-gan)')}</section>
            <section class="est-card"><h3 class="est-h3">Modelos que más ganancia dejan <span class="est-sub">(top 10)</span></h3>${barrasH(grafMod, 'var(--est-gan)')}</section>
        </div>
        <section class="est-card">
            <div class="est-card-cab">
                <h3 class="est-h3">Rentabilidad ${mostrandoCat ? 'por categoría' : 'por modelo'}</h3>
                <div class="est-seg">
                    <button class="${mostrandoCat ? 'activo' : ''}" onclick="Est.vistaRent('categoria')">Categorías</button>
                    <button class="${!mostrandoCat ? 'activo' : ''}" onclick="Est.vistaRent('modelo')">Modelos</button>
                </div>
            </div>
            <p class="est-sub">Margen en verde = por encima del promedio del período (${pct(margenGlobal)}). Tocá un título para ordenar.</p>
            <div class="tabla-scroll"><table class="est-tabla">${cabecera}<tbody>${(mostrandoCat ? porCat : porMod).map(x => filaHtml(x, !mostrandoCat)).join('')}</tbody></table></div>
        </section>`;
    }

    function htmlCierres(cierres, alertasPorId) {
        if (!cierres.length) return '<p class="vacio">Sin cierres registrados en este período.</p>';
        const orden = cierres.slice().sort((a, b) => b.fecha.localeCompare(a.fecha));
        return `<section class="est-card"><h3 class="est-h3">Historial de cierres <span class="est-sub">(tocá uno para ver el detalle de cada venta)</span></h3>
        <div class="tabla-scroll"><table class="est-tabla">
            <thead><tr><th>Fecha</th><th>Pedidos</th><th>Pares</th><th>Facturación</th><th>Ganancia</th><th>Margen</th><th>Datos</th><th>Control</th></tr></thead>
            <tbody>${orden.map(c => {
                const al = (alertasPorId[c.id] || []);
                const graves = al.filter(a => a.nivel !== 'info').length;
                const id = 'est-cierre-' + c.id;
                return `<tr class="est-fila-click" onclick="Est.toggle('${id}')">
                    <td>${fechaCorta(c.fecha)}</td><td>${c.pedidos}</td><td>${c.pares}</td><td>${pesos(c.fact)}</td>
                    <td class="${c.ganancia < 0 ? 'est-neg' : 'est-pos'}">${pesos(c.ganancia)}</td>
                    <td>${c.fact > 0 ? pct(c.ganancia / c.fact) : '—'}</td>
                    <td>${c.lineas ? badge('Con detalle', 'est-b-ok', 'Guarda cada venta con su precio y costo de ese momento') : badge('Estimado', 'est-b-warn', 'Cierre anterior al detalle: ganancia estimada con los costos actuales')}${c.corregido ? ' ' + badge('Corregido', 'est-b-info', c.nota) : ''}</td>
                    <td>${graves ? badge(`⚠ ${graves}`, 'est-b-warn') : badge('✓ OK', 'est-b-ok')}</td></tr>
                <tr id="${id}" class="est-detalle"><td colspan="8">${detalleCierre(c)}</td></tr>`;
            }).join('')}</tbody></table></div></section>`;
    }

    function detalleCierre(c) {
        if (!c.lineas) {
            const top = Object.entries(c.modelos).map(([nombre, n]) => ({ nombre, n: num(n) })).sort((a, b) => b.n - a.n);
            return `<p class="est-sub">Este cierre es anterior al detalle por venta: solo se conservan los totales y los modelos vendidos.</p>
                <ol class="est-top-dia">${top.map(m => `<li>${esc(m.nombre)} <span class="est-badge est-b-neutro">×${m.n}</span></li>`).join('')}</ol>`;
        }
        const ls = c.lineas.slice().sort((a, b) => (a.cliente || '').localeCompare(b.cliente || '') || (a.modelo || '').localeCompare(b.modelo || ''));
        return `<div class="tabla-scroll"><table class="est-tabla est-tabla-chica">
            <thead><tr><th>Cliente</th><th>Modelo</th><th>Talle</th><th>Categoría</th><th>Precio</th><th>Costo</th><th>Ganancia</th><th>Envío</th></tr></thead>
            <tbody>${ls.map(l => `<tr>
                <td class="est-izq">${esc(l.cliente)}</td><td class="est-izq">${esc(l.modelo)}</td><td>${esc(l.talle)}</td><td class="est-izq">${esc(l.categoria)}</td>
                <td>${l.cambio ? 'Cambio' : pesos(l.importe)}</td>
                <td>${l.cambio ? '—' : (l.costoUnit === null || l.costoUnit === undefined ? '—' : pesos(num(l.costoUnit) * (num(l.cantidad) || 1)))}</td>
                <td class="${l.ganancia === null ? '' : (l.ganancia < 0 ? 'est-neg' : 'est-pos')}">${l.ganancia === null || l.ganancia === undefined ? '—' : pesos(l.ganancia)}</td>
                <td>${esc(l.envio || '—')}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function htmlControl(cierres, alertasPorId) {
        const filas = cierres.slice().sort((a, b) => b.fecha.localeCompare(a.fecha)).map(c => {
            const al = alertasPorId[c.id] || [];
            return `<div class="est-ctrl-fila">
                <div class="est-ctrl-cab"><strong>${fechaCorta(c.fecha)}</strong> · ${pesos(c.fact)} · ${c.pares} pares ${al.length === 0 ? badge('✓ Sin alertas', 'est-b-ok') : ''}</div>
                ${al.map(a => `<div class="est-ctrl-item est-ctrl-${a.nivel}">${a.nivel === 'error' ? '🛑' : a.nivel === 'aviso' ? '⚠️' : 'ℹ️'} ${esc(a.texto)}</div>`).join('')}
            </div>`;
        }).join('');

        return `
        <section class="est-card"><h3 class="est-h3">Control de calidad de los datos</h3>
            ${cierres.length ? filas : '<p class="vacio">Sin cierres registrados en este período.</p>'}
        </section>
        <section class="est-card"><h3 class="est-h3">Cómo se calcula cada número</h3>
            <ul class="est-def">
                <li><strong>Facturación:</strong> suma del precio de cada pedido confirmado (✅) más el recargo de los "Cambio" de talle. Es bruta: no distingue cobrado de pendiente.</li>
                <li><strong>Ganancia:</strong> precio de venta menos el costo del par (según su categoría en Configuración). En un "Cambio", la ganancia es el recargo completo.</li>
                <li><strong>Congelado:</strong> al apretar "📊 Cargar a Estadísticas" se guarda cada venta con su precio y su costo de ESE momento. Cambiar precios o costos después no altera cierres anteriores.</li>
                <li><strong>Estimado:</strong> los cierres anteriores al detalle por venta no tienen costos guardados; su ganancia se estima con los costos actuales.</li>
                <li><strong>Alertas:</strong> margen fuera de ${pct(MARGEN_MIN_NORMAL, 0)}–${pct(MARGEN_MAX_NORMAL, 0)}, facturación por par fuera de ${pesos(PRECIO_PAR_MIN)}–${pesos(PRECIO_PAR_MAX)}, ventas sin precio, con precio menor a $1.000 o por debajo del costo, y cierres duplicados.</li>
                <li><strong>Fechas:</strong> se registran en hora de Argentina (la de tu compu).</li>
            </ul>
        </section>`;
    }

    // ---------- render general ----------------------------------------------
    function render() {
        const cont = document.getElementById('estadisticas-cuerpo-pro');
        if (!cont) return;
        const act = E.cache[E.mes] || [];
        const prev = E.cache[mesAnterior(E.mes)] || [];
        const ag = agregar(act), agPrev = agregar(prev);

        const alertasPorId = {};
        const dupl = alertasDeDuplicados(act);
        act.forEach(c => { alertasPorId[c.id] = alertasDeCierre(c).concat(dupl[c.id] || []); });
        const alertasTotales = Object.values(alertasPorId).flat();
        const graves = alertasTotales.filter(a => a.nivel !== 'info').length;

        let cuerpo = '';
        if (E.tab === 'panel') cuerpo = htmlPanel(ag, agPrev, alertasTotales);
        else if (E.tab === 'rentabilidad') cuerpo = htmlRentabilidad(ag);
        else if (E.tab === 'cierres') cuerpo = htmlCierres(act, alertasPorId);
        else cuerpo = htmlControl(act, alertasPorId);

        const tabs = [['panel', '📈 Panel'], ['rentabilidad', '💰 Rentabilidad'], ['cierres', '🗂️ Cierres'], ['control', `🛡️ Control${graves ? ` (${graves})` : ''}`]];
        cont.innerHTML = `
        <div class="est-app">
            <div class="est-header">
                <div>
                    <h2 class="est-titulo">Panel de Estadísticas</h2>
                    <p class="est-sub-titulo">Zapatillas · ${esc(nombreMes(E.mes))}</p>
                </div>
                <div class="est-controles">
                    <label class="est-sel">Período
                        <select onchange="Est.mes(this.value)">${mesesDisponibles().map(m => `<option value="${m}" ${m === E.mes ? 'selected' : ''}>${esc(nombreMes(m))}</option>`).join('')}</select>
                    </label>
                    <button class="btn btn-outline" onclick="Est.refrescar()" title="Volver a leer los cierres">↻ Actualizar</button>
                    <button class="btn btn-outline" onclick="Est.excel()" title="Descargar los cierres del período en Excel">⬇ Excel</button>
                </div>
            </div>
            <nav class="est-tabs">${tabs.map(([id, txt]) => `<button class="est-tab ${E.tab === id ? 'activa' : ''}" onclick="Est.tab('${id}')">${txt}</button>`).join('')}</nav>
            <div class="est-contenido">${cuerpo}</div>
        </div>`;
    }

    // ---------- API pública ------------------------------------------------
    async function cargar(forzar) {
        const cont = document.getElementById('estadisticas-cuerpo-pro');
        if (!cont) return;
        if (!E.mes) E.mes = idMes(new Date());
        if (!E.cache[E.mes] || forzar) cont.innerHTML = '<p class="ayuda">Cargando estadísticas...</p>';
        try {
            await Promise.all([cargarMes(E.mes, forzar), cargarMes(mesAnterior(E.mes), forzar)]);
            render();
        } catch (e) {
            console.error(e);
            cont.innerHTML = '<p class="ayuda">No se pudieron cargar las estadísticas. Revisá la conexión y tocá "Actualizar".</p>';
        }
    }

    async function exportarExcel() {
        if (typeof ExcelJS === 'undefined') { alert('No se pudo cargar el generador de Excel (revisá la conexión).'); return; }
        const act = E.cache[E.mes] || [];
        if (!act.length) { alert('No hay cierres en este período para exportar.'); return; }
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Cierres');
        ws.columns = [
            { header: 'Fecha', key: 'fecha', width: 12 }, { header: 'Pedidos', key: 'pedidos', width: 10 },
            { header: 'Pares', key: 'pares', width: 8 }, { header: 'Facturación', key: 'fact', width: 15 },
            { header: 'Ganancia', key: 'gan', width: 15 }, { header: 'Margen', key: 'margen', width: 10 },
            { header: 'Datos', key: 'datos', width: 14 },
        ];
        act.forEach(c => ws.addRow({ fecha: c.fecha, pedidos: c.pedidos, pares: c.pares, fact: c.fact, gan: c.ganancia, margen: c.fact > 0 ? c.ganancia / c.fact : 0, datos: c.lineas ? 'Con detalle' : 'Estimado' }));
        ws.getColumn('fact').numFmt = '"$"#,##0'; ws.getColumn('gan').numFmt = '"$"#,##0'; ws.getColumn('margen').numFmt = '0.0%';
        ws.getRow(1).font = { bold: true };

        const wl = wb.addWorksheet('Ventas (detalle)');
        wl.columns = [
            { header: 'Fecha cierre', key: 'fecha', width: 13 }, { header: 'Cliente', key: 'cliente', width: 22 },
            { header: 'Modelo', key: 'modelo', width: 32 }, { header: 'Talle', key: 'talle', width: 8 },
            { header: 'Categoría', key: 'cat', width: 26 }, { header: 'Precio', key: 'precio', width: 13 },
            { header: 'Costo', key: 'costo', width: 13 }, { header: 'Ganancia', key: 'gan', width: 13 },
            { header: 'Envío', key: 'envio', width: 10 },
        ];
        act.filter(c => c.lineas).forEach(c => c.lineas.forEach(l => wl.addRow({
            fecha: c.fecha, cliente: l.cliente, modelo: l.modelo, talle: l.talle, cat: l.categoria,
            precio: l.cambio ? 'Cambio' : num(l.importe), costo: l.cambio || l.costoUnit == null ? '' : num(l.costoUnit) * (num(l.cantidad) || 1),
            gan: l.ganancia == null ? '' : l.ganancia, envio: l.envio,
        })));
        ['precio', 'costo', 'gan'].forEach(k => { wl.getColumn(k).numFmt = '"$"#,##0'; });
        wl.getRow(1).font = { bold: true };

        const buf = await wb.xlsx.writeBuffer();
        const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const a = document.createElement('a');
        a.href = url; a.download = `estadisticas-${E.mes}.xlsx`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    window.Est = {
        tab(id) { E.tab = id; render(); },
        mes(id) { E.mes = id; cargar(false); },
        refrescar() { E.cache = {}; cargar(true); },
        toggle(id) { const el = document.getElementById(id); if (el) el.classList.toggle('abierta'); },
        ordenar(col) { E.orden = { col, dir: E.orden.col === col ? -E.orden.dir : -1 }; render(); },
        vistaRent(v) { E.vistaRent = v; render(); },
        excel: exportarExcel,
        // Para pruebas: expone los cálculos puros.
        _agregar: agregar, _normalizar: normalizarCierre, _alertas: alertasDeCierre,
    };
    window.cargarEstadisticasPro = () => { E.cache = {}; cargar(true); };

    // ---------- tooltip global (hover / toque) ------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        const vista = document.getElementById('vista-estadisticas');
        if (!vista) return;
        const tip = document.createElement('div');
        tip.id = 'est-tooltip';
        document.body.appendChild(tip);
        const ocultar = () => { tip.style.display = 'none'; };
        const mover = e => {
            const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
            const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
            tip.style.left = Math.max(x, 4) + 'px'; tip.style.top = Math.max(y, 4) + 'px';
        };
        const mostrar = e => {
            const t = e.target.closest ? e.target.closest('[data-tip]') : null;
            if (!t || !t.dataset.tip) { ocultar(); return; }
            tip.textContent = t.dataset.tip;
            tip.style.display = 'block';
            mover(e);
        };
        vista.addEventListener('mouseover', mostrar);
        vista.addEventListener('mousemove', e => { if (tip.style.display === 'block') mover(e); });
        vista.addEventListener('mouseleave', ocultar);
        vista.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-tip]')) mostrar(e); else ocultar(); });
    });
})();
