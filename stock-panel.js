// ============================================================================
// STOCK DE CASA EN EL PANEL DE LA TIENDA (desde el cambio de octubre 2026)
//
// El stock de casa ya no vive en Firebase: se maneja en el panel de la tienda de L.A IMP
// (mitiendastock.com/laimp/panel/), como cualquier revendedor. Este archivo reemplaza las
// partes de Store que tocaban el stock; los pedidos y clientes siguen en Firebase.
//
//  • Ver el stock: se lee el catálogo PÚBLICO de la tienda (no hace falta clave).
//      - productos propios del panel  -> modelos solo de casa   (id "p:<código>")
//      - "pares tuyos" en modelos del proveedor                  (id "b:<código>")
//  • Descontar / devolver por un pedido, y sumar / restar desde la pestaña:
//      - En mitiendastock.com/pedidos: /api/panel/casa, con la cookie de la sesión del panel.
//      - En GitHub (mitiendazapas.github.io): /api/app/casa con un TOKEN (Authorization: Bearer). El
//        token sale de /api/app/ingresar (usuario y clave del panel, que se escriben en la pestaña
//        "Stock de casa"); se guarda en el celular 30 días. La clave NUNCA se guarda.
//    El panel recuerda qué pedido descontó qué par: un pedido nunca descuenta dos veces.
//  • PedidosProveedor (en la compu) solo lee el stock: también lo toma de acá.
// ============================================================================
(function () {
    'use strict';

    const ACTIVO = true;    // prendido el 20/10/2026 (junto con el piloto y la tienda)
    if (!ACTIVO || typeof Store === 'undefined') return;

    const TIENDA = 'laimp';
    const SITIO = 'https://mitiendastock.com';
    // La app puede usarse desde GitHub (mitiendazapas.github.io): ahí NO hay redirección. Desde GitHub se
    // lee el catálogo público (stock, fotos, marcas), pero el panel solo acepta cambios de stock desde su
    // propio sitio (EN_SITIO): en GitHub los botones de sumar/restar quedan desactivados con un aviso.
    const EN_SITIO = location.hostname === 'mitiendastock.com' || location.hostname.endsWith('.mitiendastock.pages.dev')
        || ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && location.port === '8788');
    const BASE = EN_SITIO ? '' : SITIO;
    const CATALOGO = `${BASE}/api/tienda/${TIENDA}/productos.json`;
    const BASE_FOTOS = `${BASE}/api/tienda/${TIENDA}/`;   // las fotos de productos propios vienen relativas ("fotos/...")
    const PANEL = `${BASE}/${TIENDA}/panel/`;
    const CADA_MS = 30000;

    // ---- token de la app (solo en GitHub) ---------------------------------------------------------
    // En mitiendastock.com todo sigue igual (cookie). En GitHub, el panel acepta cambios de stock con
    // un token que se pide con usuario y clave. Se guarda { token, expira, tienda, usuario }: la clave no.
    const CLAVE_TOKEN = 'stockCasa:token';
    const USUARIO_PANEL = 'laimp';
    let sesionVencida = false;   // para avisar "Tu sesión venció" en vez del cartel de siempre

    function borrarToken() { try { localStorage.removeItem(CLAVE_TOKEN); } catch (e) { /* sin almacenamiento */ } }
    function guardarToken(t) {
        try { localStorage.setItem(CLAVE_TOKEN, JSON.stringify({ token: t.token, expira: Number(t.expira), tienda: t.tienda || TIENDA, usuario: t.usuario || '' })); }
        catch (e) { /* sin almacenamiento: la sesión dura hasta cerrar la pestaña */ }
    }
    function leerToken() {
        let t = null;
        try { t = JSON.parse(localStorage.getItem(CLAVE_TOKEN) || 'null'); } catch (e) { t = null; }
        if (!t || typeof t.token !== 'string' || !t.token) return null;
        if (!(Number(t.expira) > Date.now())) { borrarToken(); sesionVencida = true; return null; }   // venció
        return t;
    }
    // GitHub SIN clave: la app intenta cambiar el stock sin pedir usuario ni clave. Si el servidor todavía
    // los exige (responde 401 sin token), se marca acá y recién ahí se muestra el formulario de ingreso.
    let servidorExigeClave = false;
    // ¿Se puede cambiar el stock? En el sitio, sí (cookie del panel); en GitHub, sin clave mientras el
    // servidor no la pida, y si la pide, solo con un token válido.
    const puedeEditar = () => EN_SITIO || !!leerToken() || !servidorExigeClave;

    const norm = s => (typeof normalizarTexto === 'function' ? normalizarTexto(String(s || '')) : String(s || '').toLowerCase()).trim();
    const fmtTalle = t => String(t == null ? '' : t).trim().replace(',', '.').replace(/\s+/g, '');

    let modelos = {};
    let todos = [];        // TODOS los modelos del catálogo (también los que no tienen stock de casa): para "+ Agregar modelo"
    let tocadoHasta = 0;   // mientras se toca el stock acá, la relectura no pisa lo que se ve
    let cargado = false;
    let oyentes = [];
    let reloj = null;
    let buscar = '';       // texto del buscador de la pestaña

    // Foto del catálogo: la de un modelo del proveedor viene completa (https://...), la de un producto
    // propio viene relativa. "sm" (chica) puede faltar: entonces se usa "lg".
    function urlFoto(u) {
        if (!u) return '';
        return /^https?:\/\//i.test(u) ? u : BASE_FOTOS + String(u).replace(/^\//, '');
    }
    function fotosDe(p) {
        const i = (p.images && p.images[0]) || null;
        if (!i) return { foto: '', fotoGrande: '' };
        return { foto: urlFoto(i.sm || i.lg), fotoGrande: urlFoto(i.lg || i.sm) };
    }
    // Calidad (Brasil / G5) para los modelos del proveedor; la categoría propia para los productos del panel.
    function etiquetaDe(p, categorias) {
        if (p.manual) return (categorias && categorias[p.category]) || p.category || '';
        return p.category === 'g5' ? 'G5' : 'Brasil';
    }

    function convertir(data) {
        const obj = {};
        const categorias = (data && data.categories) || {};
        for (const p of (data && data.products) || []) {
            if (!p || !p.name) continue;
            const talles = {};
            const extra = { ...fotosDe(p), marca: p.brand || '', etiqueta: etiquetaDe(p, categorias) };
            if (p.manual) {
                for (const s of p.sizes || []) talles[String(s.size)] = Number(s.stock) || 0;
                obj[`p:${p.id}`] = { nombre: p.name, talles, tipo: p.category === 'indumentaria' ? 'indumentaria' : 'zapatillas', ...extra };
            } else {
                for (const s of p.sizes || []) if (Number(s.extra) > 0) talles[String(s.size)] = Number(s.extra);
                if (Object.keys(talles).length) obj[`b:${p.id}`] = { nombre: p.name, talles, tipo: 'zapatillas', ...extra };
            }
        }
        return obj;
    }

    // Lista completa del catálogo (para elegir un modelo nuevo en "+ Agregar modelo").
    function armarCatalogo(data) {
        const categorias = (data && data.categories) || {};
        return ((data && data.products) || []).filter(p => p && p.name).map(p => ({
            id: `${p.manual ? 'p' : 'b'}:${p.id}`,
            nombre: p.name,
            marca: p.brand || '',
            etiqueta: etiquetaDe(p, categorias),
            manual: !!p.manual,
            talles: (p.sizes || []).map(s => String(s.size)),
            ...fotosDe(p),
        })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    }

    function avisar() { oyentes.forEach(cb => { try { cb(modelos); } catch (e) { console.error(e); } }); }

    async function leer() {
        try {
            const r = await fetch(`${CATALOGO}?t=${Date.now()}`, { cache: 'no-store' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const datos = await r.json();
            todos = armarCatalogo(datos);
            const nuevos = convertir(datos);
            // Recién tocado acá: el catálogo tarda unos segundos en mostrarlo; no se pisa.
            if (Date.now() < tocadoHasta) return;
            modelos = nuevos;
            cargado = true;
            avisar();
            // Si la pestaña está abierta (y no se está escribiendo un talle o una búsqueda), se actualiza sola.
            const vista = document.getElementById('vista-stock');
            if (vista && vista.style.display !== 'none' && !vista.contains(document.activeElement)) pintarPestana();
        } catch (e) {
            console.error('No se pudo leer el stock de casa del panel:', e);
        }
    }

    Store.onStockCasa = function (callback) {
        oyentes.push(callback);
        if (cargado) callback(modelos);
        if (!reloj) { leer(); reloj = setInterval(leer, CADA_MS); }
        return () => { oyentes = oyentes.filter(f => f !== callback); };
    };

    // ---- sesión del panel ---------------------------------------------------
    function pedirIngreso() {
        return new Promise((resolve, reject) => {
            const fondo = document.createElement('div');
            fondo.setAttribute('role', 'dialog');
            fondo.setAttribute('aria-modal', 'true');
            fondo.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.6)';
            fondo.innerHTML = `<form style="max-width:360px;width:100%;padding:22px;border-radius:16px;background:#fff;color:#18181b;font-family:system-ui,sans-serif;display:grid;gap:10px">
                <h2 style="margin:0;font-size:19px">Entrá con el usuario del panel</h2>
                <p style="margin:0;opacity:.8">Para descontar el stock de casa, la app usa el panel de la tienda.</p>
                <label style="display:grid;gap:4px">Usuario<input name="u" autocomplete="username" required style="min-height:44px;padding:0 10px;border:1px solid #ccc;border-radius:10px;font:inherit"></label>
                <label style="display:grid;gap:4px">Clave<input name="c" type="password" autocomplete="current-password" required style="min-height:44px;padding:0 10px;border:1px solid #ccc;border-radius:10px;font:inherit"></label>
                <p data-error role="alert" style="margin:0;color:#b91c1c;font-weight:600"></p>
                <button style="min-height:46px;border:0;border-radius:12px;background:#18181b;color:#fff;font:inherit;font-weight:600">Entrar</button>
                <button type="button" data-cancelar style="min-height:40px;border:0;background:none;font:inherit;text-decoration:underline">Ahora no</button>
            </form>`;
            const form = fondo.querySelector('form');
            const error = fondo.querySelector('[data-error]');
            fondo.querySelector('[data-cancelar]').addEventListener('click', () => { fondo.remove(); reject(new Error('Sin sesión del panel.')); });
            form.addEventListener('submit', async e => {
                e.preventDefault();
                error.textContent = '';
                try {
                    const r = await fetch('/api/panel/ingresar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ usuario: form.u.value.trim(), clave: form.c.value }) });
                    const d = await r.json().catch(() => ({}));
                    if (!r.ok) { error.textContent = d.error || 'No se pudo entrar.'; return; }
                    fondo.remove();
                    resolve();
                } catch (err) {
                    error.textContent = 'Sin conexión. Probá de nuevo.';
                }
            });
            document.body.append(fondo);
            form.u.focus();
        });
    }

    function errorSinClave(mensaje) { const e = new Error(mensaje); e.sinClave = true; return e; }

    // GitHub: el mismo pedido y la misma respuesta que /api/panel/casa. Con token si hay uno; si no, sin
    // Authorization (el servidor decide). Sin cookies.
    async function moverConToken(cuerpo) {
        const t = leerToken();
        if (!t && servidorExigeClave) throw errorSinClave(sesionVencida ? 'Tu sesión venció, ingresá de nuevo.' : 'Ingresá en la pestaña Stock de casa para cambiar el stock.');
        const headers = { 'Content-Type': 'application/json' };
        if (t) headers.Authorization = `Bearer ${t.token}`;
        const r = await fetch(`${SITIO}/api/app/casa`, { method: 'POST', credentials: 'omit', headers, body: JSON.stringify(cuerpo) });
        const d = await r.json().catch(() => ({}));
        if (r.status === 401 && !t) {   // el servidor todavía pide usuario y clave: se muestra el formulario
            servidorExigeClave = true;
            pintarPestana();
            throw errorSinClave('Ingresá en la pestaña Stock de casa para cambiar el stock.');
        }
        if (r.status === 401) {   // token vencido, o la clave se cambió: se vuelve al formulario
            servidorExigeClave = true;
            borrarToken();
            sesionVencida = true;
            pintarPestana();
            throw errorSinClave('Tu sesión venció, ingresá de nuevo.');
        }
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
    }

    // Como moverEnPanel, pero si el servidor exige clave y no hay sesión devuelve null (el pedido queda sin marcar).
    async function moverOSinClave(cuerpo, aviso) {
        try { return await moverEnPanel(cuerpo); }
        catch (e) { if (e && e.sinClave) { avisarSinPanel(aviso); return null; } throw e; }
    }

    async function moverEnPanel(cuerpo, reintento) {
        if (!EN_SITIO) return moverConToken(cuerpo);
        const r = await fetch('/api/panel/casa', { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });
        if (r.status === 401 && !reintento) { await pedirIngreso(); return moverEnPanel(cuerpo, true); }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        return d;
    }

    function ponerLocal(id, talle, cantidad) {
        if (!modelos[id] || cantidad == null) return;
        modelos[id].talles[talle] = cantidad;
        avisar();
    }

    // Igual que antes: devuelve { ok, despues, nombre, motivo }. La marca en el pedido sigue en Firebase.
    // Desde GitHub SIN sesión (sin token) no se descuenta ni se devuelve nada (y se avisa una vez). El pedido
    // NO se marca: apenas se ingrese en la pestaña Stock de casa (o se abra la app en mitiendastock.com/pedidos),
    // dentro de las 24 h, se descuenta. Con token, funciona igual que en el sitio.
    let avisadoSinPanel = false;
    function avisarSinPanel(texto) {
        if (avisadoSinPanel || !window.StockCasa || !window.StockCasa.aviso) return;
        avisadoSinPanel = true;
        window.StockCasa.aviso(texto);
    }

    Store.descontarStockDePedido = async function (pedidoId, modeloId, talle) {
        if (!puedeEditar()) {
            avisarSinPanel('ℹ️ Para descontar el stock de casa ingresá en la pestaña Stock de casa (o abrí la app en mitiendastock.com/pedidos).');
            return { ok: false, motivo: 'sin-panel' };
        }
        talle = String(talle).trim();
        const r = await moverOSinClave({ accion: 'descontar', pedido: pedidoId, id: modeloId, talle },
            'ℹ️ Para descontar el stock de casa ingresá en la pestaña Stock de casa (o abrí la app en mitiendastock.com/pedidos).');
        if (!r) return { ok: false, motivo: 'sin-panel' };
        if (r.ok || r.motivo === 'ya-descontado') {
            await Store.updatePedido(pedidoId, { stockDescontado: { id: r.id || modeloId, talle: r.talle || talle } });
        }
        if (r.ok) ponerLocal(modeloId, talle, r.despues);
        if (r.motivo === 'ya-descontado') return { ok: false, motivo: 'ya-descontado' };
        return r.ok ? { ok: true, antes: r.antes, despues: r.despues, nombre: r.nombre || (modelos[modeloId] || {}).nombre } : r;
    };

    // Pedido descontado ANTES del cambio (con el código viejo de Firebase): se busca el modelo por su nombre.
    async function equivalente(sd) {
        try {
            const doc = await firebase.firestore().collection('stock_casa').doc(sd.id).get();
            const nombre = doc.exists ? norm(doc.data().nombre) : '';
            for (const [id, m] of Object.entries(modelos)) {
                if (norm(m.nombre) !== nombre) continue;
                const talle = Object.keys(m.talles).find(k => fmtTalle(k) === fmtTalle(sd.talle)) || String(sd.talle);
                return { id, talle };
            }
        } catch (e) { console.error(e); }
        return null;
    }

    Store.devolverStockDePedido = async function (pedidoId) {
        if (!puedeEditar()) {
            avisarSinPanel('⚠️ Ese pedido había descontado un par del stock de casa y no se pudo devolver: ingresá en la pestaña Stock de casa (o abrí la app en mitiendastock.com/pedidos).');
            return { ok: false, motivo: 'sin-panel' };
        }
        const snap = await firebase.firestore().collection('pedidos').doc(pedidoId).get();
        const sd = snap.exists ? snap.data().stockDescontado : null;
        let cuerpo = { accion: 'devolver', pedido: pedidoId };
        if (sd && sd.id && !/^(p|b):/.test(sd.id)) {
            const eq = await equivalente(sd);
            if (!eq) {   // ese modelo ya no está en el panel: solo se limpia la marca
                await Store.updatePedido(pedidoId, { stockDescontado: null });
                return { ok: true, despues: null, talle: sd.talle };
            }
            cuerpo = { ...cuerpo, legado: true, id: eq.id, talle: eq.talle };
        }
        const r = await moverOSinClave(cuerpo,
            '⚠️ Ese pedido había descontado un par del stock de casa y no se pudo devolver: ingresá en la pestaña Stock de casa (o abrí la app en mitiendastock.com/pedidos).');
        if (!r) return { ok: false, motivo: 'sin-panel' };
        if (sd) await Store.updatePedido(pedidoId, { stockDescontado: null });
        if (r.ok) leer();
        return r;
    };

    // ---- pestaña "Stock de casa": se suma, resta y agrega talles acá mismo (se guarda en el panel) --
    // Cada cambio se manda al panel de la tienda ("ajustar"): lo ven el panel, la tienda y las demás
    // tiendas. Si se cambia desde el panel, acá se ve solo (se relee cada 30 segundos).
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ordenTalle = (a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || String(a).localeCompare(String(b));
    const totalDe = m => Object.values(m.talles).reduce((a, b) => a + (Number(b) || 0), 0);
    const plural = n => `${n} ${n === 1 ? 'par' : 'pares'}`;

    const ESTILOS = `<style>
        .sp{max-width:760px;margin:0 auto;padding:16px}.sp h2{margin:0 0 6px}.sp p{margin:0 0 12px}
        .sp-barra{display:flex;gap:8px;margin:0 0 12px}
        .sp-barra input[type=search]{flex:1;min-width:0;min-height:44px;padding:0 12px;border:1px solid var(--border,rgba(127,127,127,.4));border-radius:10px;background:var(--surface,transparent);color:inherit;font:inherit}
        .sp-primario{flex:0 0 auto;min-height:44px;padding:0 14px;border:0;border-radius:10px;background:var(--primary,#4f46e5);color:#fff;font:inherit;font-weight:700;cursor:pointer}
        .sp-resumen{font-size:13px;color:var(--text-muted,#64748b);margin:0 0 8px !important}
        .sp-lista{list-style:none;margin:0;padding:0;display:grid;gap:10px}
        .sp-modelo{padding:12px;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:12px;background:var(--surface,transparent)}
        .sp-top{display:flex;gap:10px;align-items:center;margin-bottom:10px}
        .sp-foto{flex:0 0 64px;width:64px;height:64px;border-radius:10px;overflow:hidden;padding:0;border:0;background:var(--neutral-bg,rgba(127,127,127,.15));cursor:zoom-in;display:block}
        .sp-foto img{width:100%;height:100%;object-fit:cover;object-position:center;display:block}
        .sp-sinfoto{flex:0 0 64px;width:64px;height:64px;border-radius:10px;display:grid;place-items:center;text-align:center;font-size:11px;font-weight:600;color:var(--text-muted,#64748b);background:var(--neutral-bg,rgba(127,127,127,.15));cursor:default}
        .sp-datos{flex:1;min-width:0}.sp-datos strong{display:block;overflow-wrap:anywhere}
        .sp-meta{display:block;font-size:12.5px;color:var(--text-muted,#64748b)}
        .sp-total{display:block;font-size:13px;font-weight:600}.sp-sin{color:var(--danger,#c62828);font-weight:600}
        .sp-talles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
        .sp-talle{display:flex;align-items:center;gap:4px;min-width:0;padding:4px 4px 4px 10px;border-radius:10px;background:var(--neutral-bg,rgba(127,127,127,.12))}
        .sp-talle strong{flex:1;min-width:0}.sp-talle output{min-width:2ch;text-align:center;font-weight:700}
        .sp-talle button,.sp-nuevo button,.sp-btn{min-width:44px;min-height:44px;border:1px solid var(--border,rgba(127,127,127,.35));border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:20px;cursor:pointer}
        .sp button:disabled,.sp input:disabled{opacity:.4;cursor:not-allowed}
        .sp-acceso:empty{display:none}.sp-acceso{margin:0 0 12px}
        .sp-ingreso{display:grid;gap:8px;padding:12px;border-radius:12px;border:1px solid var(--border,rgba(127,127,127,.3));background:var(--info-bg,rgba(2,132,199,.10))}
        .sp-ingreso p{margin:0 !important}
        .sp-ingreso label{display:grid;gap:4px;font-size:13px;font-weight:600}
        .sp-ingreso input{width:100%;box-sizing:border-box;min-height:44px;padding:0 12px;border:1px solid var(--border,rgba(127,127,127,.4));border-radius:10px;background:var(--surface,#fff);color:inherit;font:inherit}
        .sp-clave{display:flex;gap:6px}.sp-clave input{flex:1;min-width:0}
        .sp-clave button,.sp-sesion button{min-height:44px;padding:0 12px;border:1px solid var(--border,rgba(127,127,127,.4));border-radius:10px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
        .sp-ingreso .sp-primario{width:100%}
        .sp-vencida{font-weight:700;color:var(--warning,#b45309)}
        .sp-sesion{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-muted,#64748b)}
        .sp-cero{opacity:.6}.sp-nuevo{display:flex;gap:4px;min-width:0}.sp-nuevo input{flex:1;min-width:0;min-height:44px;padding:0 10px;border:1px dashed rgba(127,127,127,.6);border-radius:10px;background:transparent;color:inherit;font:inherit}
        .sp-nuevo button{font-size:15px;font-weight:600;padding:0 10px}
        @media (max-width:480px){.sp-talles{grid-template-columns:1fr}}
        .sp-fondo{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.55)}
        .sp-hoja{width:100%;max-width:560px;max-height:92vh;overflow:auto;box-sizing:border-box;padding:16px;border-radius:16px 16px 0 0;background:var(--surface,#fff);color:var(--text,#18181b);border:1px solid var(--border,transparent)}
        @media (min-width:700px){.sp-fondo{align-items:center}.sp-hoja{border-radius:16px}}
        .sp-hoja h3{margin:0 0 10px;font-size:17px}
        .sp-hoja input[type=search],.sp-hoja input[name=t]{width:100%;box-sizing:border-box;min-height:44px;padding:0 12px;border:1px solid var(--border,rgba(127,127,127,.4));border-radius:10px;background:var(--surface,transparent);color:inherit;font:inherit}
        .sp-elegir{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:6px}
        .sp-fila{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:6px 8px;border:1px solid var(--border,rgba(127,127,127,.3));border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
        .sp-fila .sp-foto,.sp-fila .sp-sinfoto{flex:0 0 44px;width:44px;height:44px;cursor:inherit}
        .sp-chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
        .sp-chip{min-width:44px;min-height:44px;padding:0 12px;border:1px solid var(--border,rgba(127,127,127,.4));border-radius:10px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
        .sp-chip.sp-on{background:var(--primary,#4f46e5);border-color:var(--primary,#4f46e5);color:#fff}
        .sp-acciones{display:flex;gap:8px;margin-top:12px}.sp-acciones button{flex:1;min-height:44px;border-radius:10px;font:inherit;font-weight:700;cursor:pointer}
        .sp-secundario{border:1px solid var(--border,rgba(127,127,127,.4));background:transparent;color:inherit}
        .sp-error{color:var(--danger,#c62828);font-weight:600;margin:8px 0 0 !important}
        .sp-grande{display:block;max-width:100%;max-height:75vh;margin:0 auto;border-radius:10px;object-fit:contain}
    </style>`;

    // La estructura fija (título, buscador, botón) se arma UNA vez; solo la lista se redibuja. Así
    // escribir en el buscador no pierde el foco ni el teclado se cierra.
    function armarCascara() {
        const vista = document.getElementById('vista-stock');
        if (!vista || vista.dataset.spListo === '1') return vista;
        vista.innerHTML = `${ESTILOS}
        <div class="sp">
            <h2>Stock de casa</h2>
            <p>Sumá con + cuando te llegue y restá con − cuando vendas. Se guarda en el panel de la tienda y se ve en todas las tiendas. Al anotar un pedido de casa, el par se descuenta solo.</p>
            <p><a href="${PANEL}" target="_blank" rel="noopener">Abrir el panel</a> (fotos, precios y modelos nuevos)</p>
            <div id="sp-acceso" class="sp-acceso"></div>
            <div class="sp-barra">
                <input type="search" id="sp-buscar" placeholder="Nombre o marca" autocomplete="off" aria-label="Buscar modelo por nombre o marca">
                <button type="button" id="sp-agregar" class="sp-primario">+ Agregar modelo</button>
            </div>
            <div id="sp-resultado" aria-live="polite"></div>
        </div>`;
        vista.dataset.spListo = '1';
        return vista;
    }

    function fotoHtml(m, zoom) {
        if (!m.foto) return '<div class="sp-sinfoto" aria-label="Sin foto">Sin foto</div>';
        const img = `<img src="${esc(m.foto)}" alt="" loading="lazy" decoding="async" width="64" height="64">`;
        return zoom
            ? `<button type="button" class="sp-foto" data-grande="${esc(m.fotoGrande || m.foto)}" data-titulo="${esc(m.nombre)}" aria-label="Ver foto más grande de ${esc(m.nombre)}">${img}</button>`
            : `<span class="sp-foto" style="cursor:inherit">${img}</span>`;
    }

    function pintarLista() {
        const cont = document.getElementById('sp-resultado');
        if (!cont) return;
        if (!cargado) { cont.innerHTML = '<p>Cargando…</p>'; return; }
        const q = norm(buscar);
        const todas = Object.entries(modelos).sort(([, a], [, b]) => a.nombre.localeCompare(b.nombre, 'es'));
        const lista = todas.filter(([, m]) => !q || `${norm(m.nombre)} ${norm(m.marca)}`.includes(q));
        const pares = todas.reduce((s, [, m]) => s + totalDe(m), 0);
        const tarjetas = lista.map(([id, m]) => {
            const total = totalDe(m);
            const desactivar = puedeEditar() ? '' : ' disabled';   // en GitHub, sin sesión, el panel no acepta cambios
            const talles = Object.keys(m.talles).sort(ordenTalle).map(t => `
                    <div class="sp-talle${m.talles[t] > 0 ? '' : ' sp-cero'}">
                        <strong>${esc(t)}</strong>
                        <button type="button" data-id="${esc(id)}" data-talle="${esc(t)}" data-delta="-1"${desactivar} aria-label="Restar uno al talle ${esc(t)} de ${esc(m.nombre)}">−</button>
                        <output>${m.talles[t]}</output>
                        <button type="button" data-id="${esc(id)}" data-talle="${esc(t)}" data-delta="1"${desactivar} aria-label="Sumar uno al talle ${esc(t)} de ${esc(m.nombre)}">+</button>
                    </div>`).join('');
            const meta = [m.marca, m.etiqueta].filter(Boolean).join(' · ');
            return `<li class="sp-modelo">
                    <div class="sp-top">${fotoHtml(m, true)}
                        <div class="sp-datos"><strong>${esc(m.nombre)}</strong>${meta ? `<span class="sp-meta">${esc(meta)}</span>` : ''}
                            <span class="sp-total ${total ? '' : 'sp-sin'}">${total ? plural(total) : 'Sin stock'}</span></div>
                    </div>
                    <div class="sp-talles">${talles}
                        <form class="sp-nuevo" data-id="${esc(id)}"><input name="t" maxlength="12" placeholder="Talle" autocomplete="off"${desactivar} aria-label="Talle nuevo de ${esc(m.nombre)}"><button${desactivar} aria-label="Agregar talle">+ Talle</button></form>
                    </div></li>`;
        }).join('');
        cont.innerHTML = (todas.length ? `<p class="sp-resumen">${todas.length} ${todas.length === 1 ? 'modelo' : 'modelos'} · ${plural(pares)} en casa${q ? ` · ${lista.length} ${lista.length === 1 ? 'coincide' : 'coinciden'} con la búsqueda` : ''}</p>` : '')
            + (tarjetas ? `<ul class="sp-lista">${tarjetas}</ul>`
                : (todas.length ? '<p>Ningún modelo coincide con la búsqueda.</p>' : '<p>No hay stock de casa cargado. Tocá “+ Agregar modelo” para sumar el primero.</p>'));
    }

    // Zona de acceso (solo en GitHub): formulario de ingreso sin sesión, o "Ingresaste como X · Salir" con sesión.
    // Solo se vuelve a dibujar si cambió el estado (así no se pierde lo que se está escribiendo).
    function pintarAcceso() {
        const vista = document.getElementById('vista-stock');
        const zona = document.getElementById('sp-acceso');
        const agregar = document.getElementById('sp-agregar');
        if (!vista || !zona) return;
        const t = EN_SITIO ? null : leerToken();   // leerToken puede marcar la sesión como vencida
        const libre = !EN_SITIO && !t && !servidorExigeClave;   // GitHub y el servidor no pide clave: sin formulario
        const estado = EN_SITIO ? 'sitio' : (t ? 'con' : (libre ? 'libre' : (sesionVencida ? 'sin-vencida' : 'sin')));
        if (agregar) {
            agregar.disabled = !puedeEditar();
            agregar.title = agregar.disabled ? 'Ingresá con tu usuario del panel para agregar modelos' : '';
        }
        if (zona.dataset.estado === estado) return;
        zona.dataset.estado = estado;
        if (estado === 'sitio' || estado === 'libre') { zona.innerHTML = ''; return; }
        if (t) {
            zona.innerHTML = `<div class="sp-sesion"><span>✅ Ingresaste${t.usuario ? ` como <strong>${esc(t.usuario)}</strong>` : ''}. Podés cambiar el stock.</span><button type="button" data-salir>Salir</button></div>`;
            return;
        }
        zona.innerHTML = `<form class="sp-ingreso" autocomplete="on">
            ${sesionVencida ? '<p class="sp-vencida" role="status">Tu sesión venció, ingresá de nuevo.</p>' : ''}
            <p><strong>Estás viendo el stock en modo consulta.</strong> Para sumar, restar o agregar modelos, ingresá con tu usuario del panel (una sola vez en este celular).</p>
            <label>Usuario<input name="u" value="${esc(USUARIO_PANEL)}" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
            <label>Clave<span class="sp-clave"><input name="c" type="password" autocomplete="current-password" required><button type="button" data-mostrar aria-pressed="false">Mostrar</button></span></label>
            <p class="sp-error" data-error role="alert" hidden></p>
            <button type="submit" class="sp-primario">Ingresar</button>
        </form>`;
    }

    async function ingresar(form) {
        const error = form.querySelector('[data-error]');
        const boton = form.querySelector('button[type=submit]');
        const usuario = form.u.value.trim();
        const clave = form.c.value;
        error.hidden = true;
        boton.disabled = true; boton.textContent = 'Ingresando…';
        try {
            const r = await fetch(`${SITIO}/api/app/ingresar`, { method: 'POST', credentials: 'omit',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.token) {
                error.textContent = d.error || 'No se pudo ingresar. Probá de nuevo.';
                error.hidden = false;
                return;
            }
            guardarToken({ token: d.token, expira: d.expira, tienda: d.tienda, usuario });   // la clave no se guarda
            sesionVencida = false;
            form.c.value = '';
            pintarPestana();
            if (window.StockCasa && window.StockCasa.aviso) window.StockCasa.aviso('✅ Listo: ya podés cambiar el stock de casa.');
            // Pedidos que esperaban (anotados sin sesión, dentro de las 24 h): se descuentan ahora.
            if (window.StockCasa && window.StockCasa.procesarPedidos && typeof todosPedidos !== 'undefined') window.StockCasa.procesarPedidos(todosPedidos);
        } catch (e) {
            error.textContent = 'Sin conexión. Probá de nuevo.';
            error.hidden = false;
        } finally {
            form.c.value = '';   // nunca se deja la clave escrita en pantalla
            boton.disabled = false; boton.textContent = 'Ingresar';
        }
    }

    function pintarPestana() {
        if (!armarCascara()) return;
        pintarAcceso();
        pintarLista();
    }

    // Suma o resta 1 par en el panel. Si falla, vuelve a lo que había. Con { devolverError: true }
    // no muestra un cartel: devuelve el mensaje (o null si salió bien).
    async function ajustar(id, talle, delta, opciones) {
        const m = modelos[id];
        if (!m) return null;
        const antes = Number(m.talles[talle]) || 0;
        if (antes + delta < 0) return null;
        m.talles[talle] = antes + delta;   // se ve al toque; si falla, vuelve
        tocadoHasta = Date.now() + 25000;
        pintarPestana();
        let error = null;
        try {
            const r = await moverEnPanel({ accion: 'ajustar', id, talle, delta });
            if (!r.ok) throw new Error('Ese modelo ya no está en el panel.');
            m.talles[talle] = r.despues;
            avisar();
        } catch (e) {
            m.talles[talle] = antes;
            error = e.message || 'No se pudo guardar. Probá de nuevo.';
            if (!(opciones && opciones.devolverError)) alert(error);
        }
        pintarPestana();
        return error;
    }

    // ---- foto grande ---------------------------------------------------------
    function cerrarHoja() { const h = document.getElementById('sp-hoja-abierta'); if (h) h.remove(); }
    function abrirHoja(html) {
        cerrarHoja();
        const f = document.createElement('div');
        f.id = 'sp-hoja-abierta';
        f.className = 'sp-fondo';
        f.setAttribute('role', 'dialog');
        f.setAttribute('aria-modal', 'true');
        f.innerHTML = `<div class="sp-hoja">${html}</div>`;
        f.addEventListener('click', e => { if (e.target === f) cerrarHoja(); });
        document.body.append(f);
        return f.querySelector('.sp-hoja');
    }
    function verFoto(url, titulo) {
        const h = abrirHoja(`<h3>${esc(titulo)}</h3><img class="sp-grande" src="${esc(url)}" alt="${esc(titulo)}"><div class="sp-acciones"><button type="button" class="sp-secundario" data-cerrar>Cerrar</button></div>`);
        h.querySelector('[data-cerrar]').addEventListener('click', cerrarHoja);
    }

    // ---- "+ Agregar modelo": todos los modelos del catálogo ------------------
    const MAX_FILAS = 40;

    function abrirAgregar() {
        if (!puedeEditar()) return;   // sin sesión el botón ya está desactivado
        const h = abrirHoja(`<h3>Agregar modelo al stock de casa</h3>
            <input type="search" id="sp-elegir-q" placeholder="Buscar por nombre o marca" autocomplete="off" aria-label="Buscar en todos los modelos de la tienda">
            <div id="sp-elegir"></div>
            <div class="sp-acciones"><button type="button" class="sp-secundario" data-cerrar>Cerrar</button></div>`);
        h.querySelector('[data-cerrar]').addEventListener('click', cerrarHoja);
        const q = h.querySelector('#sp-elegir-q');
        const pintar = () => pintarOpciones(h);
        q.addEventListener('input', pintar);
        pintar();
        if (!todos.length) leer().then(pintar);   // todavía no se leyó el catálogo: se reintenta
        q.focus();
    }

    function pintarOpciones(h) {
        const cont = h.querySelector('#sp-elegir');
        if (!cont) return;
        if (!todos.length) { cont.innerHTML = '<p>Cargando modelos…</p>'; return; }
        const q = norm(h.querySelector('#sp-elegir-q').value);
        const coinciden = todos.filter(p => !q || `${norm(p.nombre)} ${norm(p.marca)}`.includes(q));
        const filas = coinciden.slice(0, MAX_FILAS).map(p => {
            const ya = modelos[p.id] ? totalDe(modelos[p.id]) : 0;
            const meta = [p.marca, p.etiqueta].filter(Boolean).join(' · ');
            return `<li><button type="button" class="sp-fila" data-elegir="${esc(p.id)}">${fotoHtml(p, false)}
                <span class="sp-datos"><strong>${esc(p.nombre)}</strong><span class="sp-meta">${esc(meta)}${ya ? ` · ya tenés ${plural(ya)}` : ''}</span></span></button></li>`;
        }).join('');
        cont.innerHTML = filas
            ? `<ul class="sp-elegir">${filas}</ul>${coinciden.length > MAX_FILAS ? `<p class="sp-resumen">Mostrando ${MAX_FILAS} de ${coinciden.length}. Escribí para encontrar el modelo.</p>` : ''}`
            : '<p>Ningún modelo coincide.</p>';
        cont.querySelectorAll('[data-elegir]').forEach(b => b.addEventListener('click', () => elegirTalle(h, todos.find(p => p.id === b.dataset.elegir))));
    }

    // Paso 2: elegir el talle y sumar 1 par.
    function elegirTalle(h, p) {
        if (!p) return;
        const meta = [p.marca, p.etiqueta].filter(Boolean).join(' · ');
        const existentes = modelos[p.id] ? modelos[p.id].talles : {};
        const talles = [...new Set(p.talles)].sort(ordenTalle);
        h.innerHTML = `<h3>${esc(p.nombre)}</h3>
            <div class="sp-top">${fotoHtml(p, false)}<div class="sp-datos"><span class="sp-meta">${esc(meta)}</span></div></div>
            <form id="sp-talle-form">
                <label for="sp-talle-in">¿De qué talle es el par?</label>
                ${talles.length ? `<div class="sp-chips">${talles.map(t => `<button type="button" class="sp-chip" data-talle="${esc(t)}">${esc(t)}${Number(existentes[t]) > 0 ? ` (${existentes[t]})` : ''}</button>`).join('')}</div>` : ''}
                <input id="sp-talle-in" name="t" maxlength="12" placeholder="Talle (ej: 38 o 41/42)" autocomplete="off" required>
                <p class="sp-error" data-error role="alert" hidden></p>
                <div class="sp-acciones">
                    <button type="button" class="sp-secundario" data-volver>← Volver</button>
                    <button type="submit" class="sp-primario" data-sumar>Sumar 1 par</button>
                </div>
            </form>`;
        const form = h.querySelector('#sp-talle-form');
        const input = form.t;
        const error = form.querySelector('[data-error]');
        form.querySelectorAll('.sp-chip').forEach(c => c.addEventListener('click', () => {
            input.value = c.dataset.talle;
            form.querySelectorAll('.sp-chip').forEach(x => x.classList.toggle('sp-on', x === c));
        }));
        input.addEventListener('input', () => form.querySelectorAll('.sp-chip').forEach(x => x.classList.toggle('sp-on', x.dataset.talle === input.value.trim())));
        h.querySelector('[data-volver]').addEventListener('click', () => abrirAgregar());
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const talle = input.value.trim();
            if (!talle) { error.textContent = 'Escribí el talle.'; error.hidden = false; return; }
            const boton = form.querySelector('[data-sumar]');
            boton.disabled = true; boton.textContent = 'Guardando…'; error.hidden = true;
            const falla = await agregarModelo(p, talle);
            if (falla) { error.textContent = falla; error.hidden = false; boton.disabled = false; boton.textContent = 'Sumar 1 par'; return; }
            // Se cierra SOLO esta ventana (si mientras se guardaba se abrió otra, no se la toca).
            const fondo = h.parentElement;
            if (fondo && fondo.isConnected) fondo.remove();
        });
        input.focus();
    }

    // Suma 1 par de ese talle (creando la ficha en la lista si el modelo todavía no tenía stock de casa).
    async function agregarModelo(p, talle) {
        const id = p.id;
        const eraNuevo = !modelos[id];
        if (eraNuevo) modelos[id] = { nombre: p.nombre, talles: {}, tipo: 'zapatillas', marca: p.marca, etiqueta: p.etiqueta, foto: p.foto, fotoGrande: p.fotoGrande };
        const existente = Object.keys(modelos[id].talles).find(t => t.toLowerCase() === talle.toLowerCase());
        const talleFinal = existente || talle;
        const error = await ajustar(id, talleFinal, 1, { devolverError: true });
        // Si falló y el modelo era nuevo, no queda una ficha vacía en la lista.
        if (error && eraNuevo && !Object.values(modelos[id].talles).some(n => Number(n) > 0)) { delete modelos[id]; pintarPestana(); }
        return error;
    }

    // ---- eventos de la pestaña -----------------------------------------------
    document.addEventListener('click', (e) => {
        const b = e.target.closest('#vista-stock [data-delta]');
        if (b) { ajustar(b.dataset.id, b.dataset.talle, Number(b.dataset.delta)); return; }
        const foto = e.target.closest('#vista-stock [data-grande]');
        if (foto) { verFoto(foto.dataset.grande, foto.dataset.titulo); return; }
        if (e.target.closest('#sp-agregar')) abrirAgregar();
    });
    document.addEventListener('submit', (e) => {
        const f = e.target.closest('#vista-stock .sp-nuevo');
        if (!f) return;
        e.preventDefault();
        const talle = f.t.value.trim();
        const m = modelos[f.dataset.id];
        if (!talle || !m) return;
        const existente = Object.keys(m.talles).find(t => t.toLowerCase() === talle.toLowerCase());
        ajustar(f.dataset.id, existente || talle, 1);
    });
    document.addEventListener('submit', (e) => {
        const f = e.target.closest('#vista-stock .sp-ingreso');
        if (!f) return;
        e.preventDefault();
        ingresar(f);
    });
    document.addEventListener('click', (e) => {
        const ver = e.target.closest('#vista-stock [data-mostrar]');
        if (ver) {
            const campo = ver.closest('.sp-clave').querySelector('input');
            const mostrar = campo.type === 'password';
            campo.type = mostrar ? 'text' : 'password';
            ver.textContent = mostrar ? 'Ocultar' : 'Mostrar';
            ver.setAttribute('aria-pressed', mostrar ? 'true' : 'false');
            return;
        }
        if (e.target.closest('#vista-stock [data-salir]')) { borrarToken(); sesionVencida = false; pintarPestana(); }
    });
    document.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'sp-buscar') { buscar = e.target.value; pintarLista(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarHoja(); });
    // Foto que no carga: se cambia por el cuadro gris "Sin foto" (el evento "error" no sube, se escucha en captura).
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG' || !img.closest('.sp-foto')) return;
        const marco = img.closest('.sp-foto');
        const gris = document.createElement('div');
        gris.className = 'sp-sinfoto';
        gris.textContent = 'Sin foto';
        marco.replaceWith(gris);
    }, true);

    if (window.StockCasa) {
        const iniciar = window.StockCasa.iniciar;
        window.StockCasa.abrir = function () {
            iniciar();
            pintarPestana();
            leer().then(pintarPestana);
        };
    }
})();
