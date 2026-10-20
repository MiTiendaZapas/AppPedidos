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
    let tocadoHasta = 0;   // mientras se toca el stock acá, la relectura no pisa lo que se ve
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
            const nuevos = convertir(await r.json());
            // Recién tocado acá: el catálogo tarda unos segundos en mostrarlo; no se pisa.
            if (Date.now() < tocadoHasta) return;
            modelos = nuevos;
            cargado = true;
            avisar();
            // Si la pestaña está abierta (y no se está escribiendo un talle), se actualiza sola.
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

    // ---- pestaña "Stock de casa": se suma, resta y agrega talles acá mismo (se guarda en el panel) --
    // Cada cambio se manda al panel de la tienda ("ajustar"): lo ven el panel, la tienda y las demás
    // tiendas. Si se cambia desde el panel, acá se ve solo (se relee cada 30 segundos).
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ordenTalle = (a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || String(a).localeCompare(String(b));

    function pintarPestana() {
        const vista = document.getElementById('vista-stock');
        if (!vista) return;
        const tarjetas = Object.entries(modelos)
            .sort(([, a], [, b]) => a.nombre.localeCompare(b.nombre))
            .map(([id, m]) => {
                const total = Object.values(m.talles).reduce((a, b) => a + (Number(b) || 0), 0);
                const talles = Object.keys(m.talles).sort(ordenTalle).map(t => `
                    <div class="sp-talle${m.talles[t] > 0 ? '' : ' sp-cero'}">
                        <strong>${esc(t)}</strong>
                        <button type="button" data-id="${esc(id)}" data-talle="${esc(t)}" data-delta="-1" aria-label="Restar uno al talle ${esc(t)} de ${esc(m.nombre)}">−</button>
                        <output>${m.talles[t]}</output>
                        <button type="button" data-id="${esc(id)}" data-talle="${esc(t)}" data-delta="1" aria-label="Sumar uno al talle ${esc(t)} de ${esc(m.nombre)}">+</button>
                    </div>`).join('');
                return `<li class="sp-modelo">
                    <div class="sp-cab"><strong>${esc(m.nombre)}</strong><span class="${total ? '' : 'sp-sin'}">${total ? `${total} ${total === 1 ? 'par' : 'pares'}` : 'Sin stock'}</span></div>
                    <div class="sp-talles">${talles}
                        <form class="sp-nuevo" data-id="${esc(id)}"><input name="t" maxlength="12" placeholder="Talle" autocomplete="off" aria-label="Talle nuevo de ${esc(m.nombre)}"><button aria-label="Agregar talle">+ Talle</button></form>
                    </div></li>`;
            }).join('');
        vista.innerHTML = `<style>
            .sp{max-width:760px;margin:0 auto;padding:16px}.sp h2{margin:0 0 6px}.sp p{margin:0 0 12px}
            .sp-lista{list-style:none;margin:0;padding:0;display:grid;gap:10px}
            .sp-modelo{padding:12px;border:1px solid rgba(127,127,127,.3);border-radius:12px}
            .sp-cab{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.sp-sin{color:#c62828;font-weight:600}
            .sp-talles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
            .sp-talle{display:flex;align-items:center;gap:4px;padding:4px 4px 4px 10px;border-radius:10px;background:rgba(127,127,127,.12)}
            .sp-talle strong{flex:1}.sp-talle output{min-width:2ch;text-align:center;font-weight:700}
            .sp-talle button,.sp-nuevo button{min-width:44px;min-height:44px;border:1px solid rgba(127,127,127,.35);border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:20px;cursor:pointer}
            .sp-cero{opacity:.6}.sp-nuevo{display:flex;gap:4px}.sp-nuevo input{flex:1;min-width:0;min-height:44px;padding:0 10px;border:1px dashed rgba(127,127,127,.6);border-radius:10px;background:transparent;color:inherit;font:inherit}
            .sp-nuevo button{font-size:15px;font-weight:600;padding:0 10px}
        </style>
        <div class="sp">
            <h2>Stock de casa</h2>
            <p>Sumá con + cuando te llegue y restá con − cuando vendas. Se guarda en el panel de la tienda y se ve en todas las tiendas. Al anotar un pedido de casa, el par se descuenta solo.</p>
            <p><a href="${PANEL}" target="_blank" rel="noopener">Abrir el panel</a> (fotos, precios y modelos nuevos)</p>
            ${!EN_SITIO ? '<p><strong>Para cambiar el stock, abrí la app en mitiendastock.com/pedidos</strong></p>' : ''}
            ${cargado ? (tarjetas ? `<ul class="sp-lista">${tarjetas}</ul>` : '<p>No hay stock de casa cargado.</p>') : '<p>Cargando…</p>'}
        </div>`;
    }

    async function ajustar(id, talle, delta) {
        const m = modelos[id];
        if (!m) return;
        const antes = Number(m.talles[talle]) || 0;
        if (antes + delta < 0) return;
        m.talles[talle] = antes + delta;   // se ve al toque; si falla, vuelve
        tocadoHasta = Date.now() + 25000;
        pintarPestana();
        try {
            const r = await moverEnPanel({ accion: 'ajustar', id, talle, delta });
            if (!r.ok) throw new Error('Ese modelo ya no está en el panel.');
            m.talles[talle] = r.despues;
            avisar();
        } catch (e) {
            m.talles[talle] = antes;
            alert(e.message || 'No se pudo guardar. Probá de nuevo.');
        }
        pintarPestana();
    }

    document.addEventListener('click', (e) => {
        const b = e.target.closest('#vista-stock [data-delta]');
        if (b) ajustar(b.dataset.id, b.dataset.talle, Number(b.dataset.delta));
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

    if (window.StockCasa) {
        const iniciar = window.StockCasa.iniciar;
        window.StockCasa.abrir = function () {
            iniciar();
            pintarPestana();
            leer().then(pintarPestana);
        };
    }
})();
