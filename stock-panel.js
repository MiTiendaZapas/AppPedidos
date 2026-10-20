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
//  • Descontar / devolver por un pedido: /api/panel/casa, con la sesión del panel. Por eso la
//    app tiene que abrirse en mitiendastock.com/pedidos/ (misma página que el panel).
//    El panel recuerda qué pedido descontó qué par: un pedido nunca descuenta dos veces.
//  • PedidosProveedor (en la compu) solo lee el stock: también lo toma de acá.
// ============================================================================
(function () {
    'use strict';

    const ACTIVO = true;    // prendido el 20/10/2026 (junto con el piloto y la tienda)
    if (!ACTIVO || typeof Store === 'undefined') return;

    const TIENDA = 'laimp';
    const SITIO = 'https://mitiendastock.com';
    // La copia vieja (GitHub) pasa a la dirección nueva, que es la que puede descontar en el panel.
    if (location.hostname === 'mitiendazapas.github.io') {
        location.replace(`${SITIO}/pedidos/${location.search}${location.hash}`);
        return;
    }
    const EN_SITIO = location.hostname === 'mitiendastock.com' || location.hostname.endsWith('.mitiendastock.pages.dev')
        || ((location.hostname === '127.0.0.1' || location.hostname === 'localhost') && location.port === '8788');
    const BASE = EN_SITIO ? '' : SITIO;
    const CATALOGO = `${BASE}/api/tienda/${TIENDA}/productos.json`;
    const PANEL = `${BASE}/${TIENDA}/panel/`;
    const CADA_MS = 30000;

    const norm = s => (typeof normalizarTexto === 'function' ? normalizarTexto(String(s || '')) : String(s || '').toLowerCase()).trim();
    const fmtTalle = t => String(t == null ? '' : t).trim().replace(',', '.').replace(/\s+/g, '');

    let modelos = {};
    let cargado = false;
    let oyentes = [];
    let reloj = null;

    function convertir(data) {
        const obj = {};
        for (const p of (data && data.products) || []) {
            if (!p || !p.name) continue;
            const talles = {};
            if (p.manual) {
                for (const s of p.sizes || []) talles[String(s.size)] = Number(s.stock) || 0;
                obj[`p:${p.id}`] = { nombre: p.name, talles, tipo: p.category === 'indumentaria' ? 'indumentaria' : 'zapatillas' };
            } else {
                for (const s of p.sizes || []) if (Number(s.extra) > 0) talles[String(s.size)] = Number(s.extra);
                if (Object.keys(talles).length) obj[`b:${p.id}`] = { nombre: p.name, talles, tipo: 'zapatillas' };
            }
        }
        return obj;
    }

    function avisar() { oyentes.forEach(cb => { try { cb(modelos); } catch (e) { console.error(e); } }); }

    async function leer() {
        try {
            const r = await fetch(`${CATALOGO}?t=${Date.now()}`, { cache: 'no-store' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            modelos = convertir(await r.json());
            cargado = true;
            avisar();
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

    async function moverEnPanel(cuerpo, reintento) {
        if (!EN_SITIO) throw new Error('Para descontar el stock de casa abrí la app en mitiendastock.com/pedidos');
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
    Store.descontarStockDePedido = async function (pedidoId, modeloId, talle) {
        talle = String(talle).trim();
        const r = await moverEnPanel({ accion: 'descontar', pedido: pedidoId, id: modeloId, talle });
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
        const r = await moverEnPanel(cuerpo);
        if (sd) await Store.updatePedido(pedidoId, { stockDescontado: null });
        if (r.ok) leer();
        return r;
    };

    // ---- pestaña "Stock de casa": ahora es un acceso al panel ---------------------
    function pintarPestana() {
        const vista = document.getElementById('vista-stock');
        if (!vista) return;
        const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const filas = Object.values(modelos)
            .map(m => ({ ...m, total: Object.values(m.talles).reduce((a, b) => a + (Number(b) || 0), 0) }))
            .filter(m => m.total > 0)
            .sort((a, b) => a.nombre.localeCompare(b.nombre))
            .map(m => `<li style="padding:8px 0;border-bottom:1px solid rgba(127,127,127,.25)"><strong>${esc(m.nombre)}</strong><br><small>${
                Object.entries(m.talles).filter(([, n]) => n > 0).map(([t, n]) => `${esc(t)}: ${n}`).join(' · ')}</small></li>`).join('');
        vista.innerHTML = `<div style="max-width:640px;margin:0 auto;padding:16px">
            <h2 style="margin:0 0 8px">Stock de casa</h2>
            <p style="margin:0 0 14px">Ahora el stock de casa se carga y se cambia en el <strong>panel de la tienda</strong>: modelos, talles, fotos y precios. Lo que cambies ahí se ve en todas las tiendas.</p>
            <p style="margin:0 0 18px">Acá, al anotar un pedido de casa, el par se sigue descontando solo.</p>
            <a href="${PANEL}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 18px;border-radius:12px;background:#18181b;color:#fff;font-weight:600;text-decoration:none">Abrir el panel</a>
            <h3 style="margin:24px 0 4px">Lo que hay ahora</h3>
            ${cargado ? (filas ? `<ul style="list-style:none;margin:0;padding:0">${filas}</ul>` : '<p>No hay pares de casa con stock.</p>') : '<p>Cargando…</p>'}
        </div>`;
    }

    if (window.StockCasa) {
        const iniciar = window.StockCasa.iniciar;
        window.StockCasa.abrir = function () {
            iniciar();
            pintarPestana();
            leer().then(pintarPestana);
        };
    }
})();
