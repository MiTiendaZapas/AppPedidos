// ============================================================================
// STOCK DE CASA — se maneja desde acá (compu y celular, tu socio también).
//
//  • Un documento por modelo en Firebase ("stock_casa"); cada cambio de cantidad
//    es una transacción (si dos tocan el mismo talle a la vez, no se pisan) y
//    queda en el historial.
//  • Al marcar VERDE en depósito un par que es de casa, se descuenta solo (y se
//    devuelve si se desmarca). Ver cambiarDeposito() en app.js.
//  • La tienda se actualiza porque el piloto baja este stock en cada vuelta y
//    reescribe zapatillas_manual.js / indumentaria.js (stock_casa_sync.py).
//  • Las fotos se achican en el celular antes de subirse (1200 px, ~200 KB).
// ============================================================================
(function () {
    'use strict';

    const S = { modelos: {}, cargado: false, q: '', filtro: 'todos', iniciado: false };
    const CLAVE_QUIEN = 'ap_quien';

    // ---------- utilidades ---------------------------------------------------
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const norm = s => (typeof normalizarTexto === 'function' ? normalizarTexto(String(s || '')) : String(s || '').toLowerCase()).trim();
    const fmtTalle = t => String(t == null ? '' : t).trim().replace(',', '.').replace(/\s+/g, '');

    function idDeNombre(nombre) {
        return norm(nombre).replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'modelo';
    }

    // Orden numérico por el primer número del talle ("43/44" -> 43).
    function ordenTalle(a, b) {
        const na = parseFloat(String(a).split('/')[0]) || 0, nb = parseFloat(String(b).split('/')[0]) || 0;
        return na - nb || String(a).localeCompare(String(b));
    }

    function totalDe(m) { return Object.values(m.talles || {}).reduce((s, n) => s + (Number(n) || 0), 0); }

    function quien() {
        let q = '';
        try { q = localStorage.getItem(CLAVE_QUIEN) || ''; } catch (e) { /* sin almacenamiento */ }
        if (!q) {
            q = (prompt('¿Cómo te llamás? Así queda anotado en el historial de cambios de stock.', '') || '').trim();
            if (q) { try { localStorage.setItem(CLAVE_QUIEN, q); } catch (e) { /* sin almacenamiento */ } }
        }
        return q;
    }

    function activos() { return Object.entries(S.modelos).filter(([, m]) => !m.eliminado); }

    // ---------- aviso (toast) ------------------------------------------------
    let timeoutAviso = null;
    function aviso(texto, accion) {
        let t = document.getElementById('stk-toast');
        if (!t) { t = document.createElement('div'); t.id = 'stk-toast'; document.body.appendChild(t); }
        t.innerHTML = `<span>${esc(texto)}</span>${accion ? `<button type="button">${esc(accion.texto)}</button>` : ''}`;
        t.classList.add('visible');
        if (accion) t.querySelector('button').addEventListener('click', () => { t.classList.remove('visible'); accion.fn(); });
        clearTimeout(timeoutAviso);
        timeoutAviso = setTimeout(() => t.classList.remove('visible'), accion ? 9000 : 3200);
    }

    // ---------- foto ---------------------------------------------------------
    function cargarImagen(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
            img.src = url;
        });
    }
    function achicar(img, maxLado, calidad) {
        const k = Math.min(1, maxLado / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', calidad);
    }
    // Firebase no admite documentos de más de 1 MB: si una foto (por ejemplo muy
    // "ruidosa") queda pesada, se la vuelve a achicar hasta que entre cómoda.
    const LIMITE_FOTO = 700000;
    async function procesarFoto(file) {
        const img = await cargarImagen(file);
        let grande = '';
        for (const [lado, calidad] of [[1200, 0.85], [1000, 0.78], [800, 0.7], [600, 0.65]]) {
            grande = achicar(img, lado, calidad);
            if (grande.length < LIMITE_FOTO) break;
        }
        return { grande, mini: achicar(img, 260, 0.72) };
    }

    function elegirFoto() {
        return new Promise(resolve => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.accept = 'image/*';
            inp.addEventListener('change', () => resolve(inp.files && inp.files[0] ? inp.files[0] : null));
            inp.click();
        });
    }

    async function ponerFoto(id, file) {
        try {
            aviso('Subiendo foto…');
            const f = await procesarFoto(file);
            const version = Date.now();
            await Store.guardarFotoStock(id, f.grande, version);
            await Store.guardarModeloStock(id, { fotoMini: f.mini, fotoVersion: version, tieneFoto: true });
            Store.registrarMovimientoStock(id, (S.modelos[id] || {}).nombre || id, 'foto', quien());
            aviso('📷 Foto guardada');
        } catch (e) {
            console.error(e);
            alert('No se pudo guardar la foto. Probá con otra imagen.');
        }
    }

    // ---------- hoja / modal -------------------------------------------------
    function cerrarHoja() { const h = document.getElementById('stk-hoja'); if (h) h.remove(); }
    function abrirHoja(html, ancha) {
        cerrarHoja();
        const h = document.createElement('div');
        h.id = 'stk-hoja'; h.className = 'stk-hoja-fondo';
        h.innerHTML = `<div class="stk-hoja ${ancha ? 'stk-hoja-ancha' : ''}" role="dialog">${html}</div>`;
        h.addEventListener('click', e => { if (e.target === h) cerrarHoja(); });
        document.body.appendChild(h);
        return h.querySelector('.stk-hoja');
    }

    // ---------- acciones sobre el stock --------------------------------------
    async function cambiar(id, talle, cambio, motivo) {
        const r = await Store.cambiarStockTalle(id, talle, cambio, motivo || 'manual', quien());
        if (!r.ok && r.motivo === 'sin-stock') aviso('Ya está en 0, no se puede bajar más.');
        return r;
    }

    async function nuevoModelo(nombre, tipo, talles, fotoFile) {
        nombre = nombre.trim();
        if (!nombre) { alert('Poné el nombre del modelo.'); return false; }
        let id = idDeNombre(nombre);
        const igual = Object.entries(S.modelos).find(([i, m]) => norm(m.nombre) === norm(nombre));
        if (igual) {
            if (!igual[1].eliminado) { alert(`Ya existe "${igual[1].nombre}". Sumale los talles a ese modelo.`); return false; }
            alert(`"${igual[1].nombre}" está en Eliminados: restauralo desde ahí.`); return false;
        }
        let n = 2; while (S.modelos[id]) id = idDeNombre(nombre) + '_' + (n++);
        const q = quien();
        await Store.guardarModeloStock(id, { nombre, tipo, talles: {}, eliminado: false, fotoRuta: '', creadoEn: Date.now() });
        for (const [t, c] of Object.entries(talles)) await Store.cambiarStockTalle(id, t, { valor: c }, 'alta', q);
        if (fotoFile) await ponerFoto(id, fotoFile);
        Store.registrarMovimientoStock(id, nombre, 'modelo-nuevo', q);
        aviso(`✅ "${nombre}" agregado`);
        return true;
    }

    function parsearTalles(texto) {
        const out = {};
        String(texto || '').split(/[,\n;]+/).forEach(parte => {
            const m = parte.trim().match(/^([\d.,]+(?:\s*\/\s*[\d.,]+)?)\s*(?:[x×*]\s*(\d+))?$/i);
            if (!m) return;
            const t = fmtTalle(m[1]);
            if (t) out[t] = (out[t] || 0) + (m[2] ? parseInt(m[2]) : 1);
        });
        return out;
    }

    async function eliminarModelo(id) {
        const m = S.modelos[id]; if (!m) return;
        await Store.guardarModeloStock(id, { eliminado: true, eliminadoEn: Date.now() });
        Store.registrarMovimientoStock(id, m.nombre, 'eliminado', quien());
        aviso(`🗑 "${m.nombre}" eliminado`, { texto: 'Deshacer', fn: () => restaurar(id) });
    }
    async function restaurar(id) {
        const m = S.modelos[id]; if (!m) return;
        await Store.guardarModeloStock(id, { eliminado: false, eliminadoEn: null });
        Store.registrarMovimientoStock(id, m.nombre, 'restaurado', quien());
        aviso(`↩️ "${m.nombre}" restaurado`);
        const h = document.getElementById('stk-hoja'); if (h && h.dataset.tipo === 'eliminados') abrirEliminados();
    }

    // ---------- pantallas ----------------------------------------------------
    function abrirNuevo() {
        const h = abrirHoja(`
            <h3 class="stk-h3">＋ Nuevo modelo</h3>
            <label class="stk-campo">Nombre del modelo<input id="stk-n-nombre" type="text" placeholder="Ej: Jordan 4 retro caramelo" autocomplete="off"></label>
            <label class="stk-campo">Tipo
                <select id="stk-n-tipo"><option value="zapatillas">Zapatillas</option><option value="indumentaria">Indumentaria</option></select>
            </label>
            <label class="stk-campo">Talles y cantidades <span class="stk-ayuda">(ej: 36 x2, 37, 38 x3; sin "x" cuenta 1)</span>
                <textarea id="stk-n-talles" rows="2" placeholder="36 x2, 37, 38 x3"></textarea>
            </label>
            <label class="stk-campo">Foto <span class="stk-ayuda">(opcional, la podés sumar después)</span>
                <input id="stk-n-foto" type="file" accept="image/*">
            </label>
            <div class="stk-botones">
                <button type="button" class="btn btn-outline" data-acc="cerrar">Cancelar</button>
                <button type="button" class="btn btn-primario" data-acc="crear">Crear modelo</button>
            </div>`);
        h.querySelector('#stk-n-nombre').focus();
        h.querySelector('[data-acc="cerrar"]').addEventListener('click', cerrarHoja);
        h.querySelector('[data-acc="crear"]').addEventListener('click', async ev => {
            const btn = ev.currentTarget; btn.disabled = true;
            const ok = await nuevoModelo(h.querySelector('#stk-n-nombre').value, h.querySelector('#stk-n-tipo').value,
                parsearTalles(h.querySelector('#stk-n-talles').value), h.querySelector('#stk-n-foto').files[0] || null);
            btn.disabled = false;
            if (ok) cerrarHoja();
        });
    }

    function abrirEliminados() {
        const lista = Object.entries(S.modelos).filter(([, m]) => m.eliminado).sort((a, b) => (b[1].eliminadoEn || 0) - (a[1].eliminadoEn || 0));
        const h = abrirHoja(`
            <h3 class="stk-h3">🗑 Modelos eliminados</h3>
            ${lista.length === 0 ? '<p class="stk-ayuda">No hay modelos eliminados.</p>' : lista.map(([id, m]) => `
                <div class="stk-fila-simple"><span><strong>${esc(m.nombre)}</strong> · ${totalDe(m)} pares</span>
                <button type="button" class="btn btn-outline" data-acc="restaurar" data-id="${esc(id)}">↩️ Restaurar</button></div>`).join('')}
            <div class="stk-botones"><button type="button" class="btn btn-outline" data-acc="cerrar">Cerrar</button></div>`);
        h.parentElement.dataset.tipo = 'eliminados';
        h.querySelector('[data-acc="cerrar"]').addEventListener('click', cerrarHoja);
        h.querySelectorAll('[data-acc="restaurar"]').forEach(b => b.addEventListener('click', () => restaurar(b.dataset.id)));
    }

    const ETIQUETA_MOTIVO = {
        manual: 'a mano', deposito: 'depósito (par agarrado)', 'deposito-devuelto': 'depósito (se desmarcó)', alta: 'carga inicial',
        'talle-quitado': 'talle quitado', foto: 'foto', 'modelo-nuevo': 'modelo nuevo', eliminado: 'modelo eliminado',
        restaurado: 'modelo restaurado', renombrado: 'renombrado', migracion: 'migración del Panel Admin',
    };
    async function abrirHistorial() {
        const h = abrirHoja('<h3 class="stk-h3">🕘 Historial de cambios</h3><p class="stk-ayuda">Cargando…</p>', true);
        let items = [];
        try { items = await Store.obtenerHistorialStock(120); } catch (e) { console.error(e); }
        const fecha = ts => new Date(ts).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        h.innerHTML = `
            <h3 class="stk-h3">🕘 Historial de cambios <span class="stk-ayuda">(últimos ${items.length})</span></h3>
            ${items.length === 0 ? '<p class="stk-ayuda">Todavía no hay cambios registrados.</p>' : `<ul class="stk-historial">${items.map(i => `
                <li><span class="stk-hist-f">${fecha(i.ts)}</span>
                <span><strong>${esc(i.nombre)}</strong>${i.talle ? ` · talle ${esc(i.talle)}: <strong>${i.antes} → ${i.despues}</strong>` : ''}
                <span class="stk-ayuda"> · ${esc(ETIQUETA_MOTIVO[i.motivo] || i.motivo)}${i.quien ? ' · ' + esc(i.quien) : ''}</span></span></li>`).join('')}</ul>`}
            <div class="stk-botones"><button type="button" class="btn btn-outline" data-acc="cerrar">Cerrar</button></div>`;
        h.querySelector('[data-acc="cerrar"]').addEventListener('click', cerrarHoja);
    }

    async function verFoto(id) {
        const m = S.modelos[id]; if (!m) return;
        if (!m.fotoMini && !m.fotoVersion) { const f = await elegirFoto(); if (f) ponerFoto(id, f); return; }
        const h = abrirHoja(`<h3 class="stk-h3">${esc(m.nombre)}</h3><div class="stk-foto-grande"><img alt="" src="${esc(m.fotoMini || '')}"></div>
            <div class="stk-botones"><button type="button" class="btn btn-outline" data-acc="cambiar">📷 Cambiar foto</button><button type="button" class="btn btn-outline" data-acc="cerrar">Cerrar</button></div>`);
        h.querySelector('[data-acc="cerrar"]').addEventListener('click', cerrarHoja);
        h.querySelector('[data-acc="cambiar"]').addEventListener('click', async () => { const f = await elegirFoto(); if (f) { cerrarHoja(); ponerFoto(id, f); } });
        if (m.fotoVersion) Store.obtenerFotoStock(id).then(url => { const img = h.querySelector('img'); if (url && img) img.src = url; }).catch(() => {});
    }

    function menuModelo(id) {
        const m = S.modelos[id]; if (!m) return;
        const h = abrirHoja(`<h3 class="stk-h3">${esc(m.nombre)}</h3>
            <div class="stk-menu-lista">
                <button type="button" data-acc="renombrar">✏️ Cambiar nombre</button>
                <button type="button" data-acc="foto">📷 ${m.fotoMini ? 'Cambiar foto' : 'Poner foto'}</button>
                <button type="button" data-acc="eliminar" class="stk-peligro">🗑 Eliminar modelo</button>
            </div>
            <div class="stk-botones"><button type="button" class="btn btn-outline" data-acc="cerrar">Cerrar</button></div>`);
        h.querySelector('[data-acc="cerrar"]').addEventListener('click', cerrarHoja);
        h.querySelector('[data-acc="renombrar"]').addEventListener('click', async () => {
            cerrarHoja();
            const nuevo = (prompt('Nuevo nombre del modelo:', m.nombre) || '').trim();
            if (!nuevo || nuevo === m.nombre) return;
            if (Object.entries(S.modelos).some(([i, x]) => i !== id && !x.eliminado && norm(x.nombre) === norm(nuevo))) { alert('Ya existe un modelo con ese nombre.'); return; }
            await Store.guardarModeloStock(id, { nombre: nuevo });
            Store.registrarMovimientoStock(id, nuevo, 'renombrado', quien());
        });
        h.querySelector('[data-acc="foto"]').addEventListener('click', async () => { const f = await elegirFoto(); cerrarHoja(); if (f) ponerFoto(id, f); });
        h.querySelector('[data-acc="eliminar"]').addEventListener('click', () => { cerrarHoja(); eliminarModelo(id); });
    }

    // ---------- lista --------------------------------------------------------
    function claseEstado(total) { return total === 0 ? 'stk-agotado' : (total <= 2 ? 'stk-poco' : ''); }

    function htmlTarjeta([id, m]) {
        const talles = Object.entries(m.talles || {}).sort((a, b) => ordenTalle(a[0], b[0]));
        const total = totalDe(m);
        return `
        <article class="stk-card ${claseEstado(total)}" data-id="${esc(id)}">
            <div class="stk-card-top">
                <button type="button" class="stk-foto" data-acc="foto" data-id="${esc(id)}" title="${m.fotoMini ? 'Ver foto' : 'Poner foto'}">
                    ${m.fotoMini ? `<img alt="" src="${esc(m.fotoMini)}">` : '<span>📷</span>'}
                </button>
                <div class="stk-info">
                    <h3 class="stk-nombre">${esc(m.nombre)}</h3>
                    <span class="stk-total">${total} par${total === 1 ? '' : 'es'}
                        ${total === 0 ? '<span class="stk-badge stk-b-agotado">Agotado</span>' : (total <= 2 ? '<span class="stk-badge stk-b-poco">Poco</span>' : '')}
                        ${m.tipo === 'indumentaria' ? '<span class="stk-badge">Indumentaria</span>' : ''}
                    </span>
                </div>
                <button type="button" class="stk-mas" data-acc="menu" data-id="${esc(id)}" aria-label="Más opciones">⋯</button>
            </div>
            <div class="stk-talles">
                ${talles.length === 0 ? '<p class="stk-ayuda">Sin talles todavía.</p>' : talles.map(([t, n]) => `
                <div class="stk-talle ${Number(n) === 0 ? 'stk-talle-cero' : ''}">
                    <span class="stk-t" title="Quitar este talle" data-acc="quitar" data-id="${esc(id)}" data-talle="${esc(t)}">${esc(t)}</span>
                    <button type="button" class="stk-bt" data-acc="menos" data-id="${esc(id)}" data-talle="${esc(t)}" ${Number(n) <= 0 ? 'disabled' : ''} aria-label="Restar uno">−</button>
                    <input class="stk-n" type="number" inputmode="numeric" min="0" value="${Number(n) || 0}" data-acc="fijar" data-id="${esc(id)}" data-talle="${esc(t)}" aria-label="Cantidad del talle ${esc(t)}">
                    <button type="button" class="stk-bt" data-acc="mas" data-id="${esc(id)}" data-talle="${esc(t)}" aria-label="Sumar uno">＋</button>
                </div>`).join('')}
            </div>
            <div class="stk-agregar">
                <input class="stk-in-talle" type="text" inputmode="decimal" placeholder="Talle" aria-label="Talle nuevo">
                <input class="stk-in-cant" type="number" inputmode="numeric" min="1" value="1" aria-label="Cantidad">
                <button type="button" class="btn btn-outline" data-acc="agregar-talle" data-id="${esc(id)}">＋ Talle</button>
            </div>
        </article>`;
    }

    function render() {
        const cont = document.getElementById('stock-cuerpo');
        if (!cont) return;
        if (!S.cargado) { cont.innerHTML = '<p class="ayuda">Cargando stock…</p>'; return; }
        const todos = activos();
        const pares = todos.reduce((s, [, m]) => s + totalDe(m), 0);
        const agotados = todos.filter(([, m]) => totalDe(m) === 0).length;
        const pocos = todos.filter(([, m]) => { const t = totalDe(m); return t > 0 && t <= 2; }).length;
        const eliminados = Object.values(S.modelos).filter(m => m.eliminado).length;
        const q = norm(S.q);
        const lista = todos
            .filter(([, m]) => !q || norm(m.nombre).includes(q))
            .filter(([, m]) => S.filtro === 'todos' || (S.filtro === 'agotados' ? totalDe(m) === 0 : (totalDe(m) > 0 && totalDe(m) <= 2)))
            .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre, 'es'));

        // Se conserva lo que se estaba escribiendo en el buscador.
        const enfocado = document.activeElement && document.activeElement.id === 'stk-buscador';
        cont.innerHTML = `
        <div class="stk-cab">
            <div>
                <h2 class="stk-titulo">📦 Stock de casa</h2>
                <p class="stk-sub">${todos.length} modelos · <strong>${pares} pares</strong>${agotados ? ` · ${agotados} agotado${agotados === 1 ? '' : 's'}` : ''}${pocos ? ` · ${pocos} con poco` : ''}</p>
            </div>
            <div class="stk-acciones">
                <button type="button" class="btn btn-primario" data-acc="nuevo">＋ Nuevo modelo</button>
                <button type="button" class="btn btn-outline" data-acc="historial">🕘 Historial</button>
                ${eliminados ? `<button type="button" class="btn btn-outline" data-acc="eliminados">🗑 Eliminados (${eliminados})</button>` : ''}
            </div>
        </div>
        <div class="stk-filtros">
            <input id="stk-buscador" type="search" placeholder="🔎 Buscar modelo…" value="${esc(S.q)}">
            <div class="est-seg">
                <button type="button" class="${S.filtro === 'todos' ? 'activo' : ''}" data-acc="filtro" data-f="todos">Todos</button>
                <button type="button" class="${S.filtro === 'poco' ? 'activo' : ''}" data-acc="filtro" data-f="poco">Poco (${pocos})</button>
                <button type="button" class="${S.filtro === 'agotados' ? 'activo' : ''}" data-acc="filtro" data-f="agotados">Agotados (${agotados})</button>
            </div>
        </div>
        ${lista.length === 0 ? `<p class="vacio">${todos.length === 0 ? 'Todavía no hay modelos. Tocá “＋ Nuevo modelo”.' : 'No hay modelos que coincidan.'}</p>`
            : `<div class="stk-grid">${lista.map(htmlTarjeta).join('')}</div>`}`;
        if (enfocado) { const b = document.getElementById('stk-buscador'); b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
    }

    // ---------- eventos (un solo manejador para toda la vista) ---------------
    function conectarEventos() {
        const cont = document.getElementById('stock-cuerpo');
        if (!cont || cont.dataset.listo) return;
        cont.dataset.listo = '1';

        cont.addEventListener('click', async e => {
            const el = e.target.closest('[data-acc]'); if (!el) return;
            const acc = el.dataset.acc, id = el.dataset.id, talle = el.dataset.talle;
            if (acc === 'mas') { cambiar(id, talle, { delta: 1 }); vibrar(); }
            else if (acc === 'menos') { cambiar(id, talle, { delta: -1 }); vibrar(); }
            else if (acc === 'nuevo') abrirNuevo();
            else if (acc === 'historial') abrirHistorial();
            else if (acc === 'eliminados') abrirEliminados();
            else if (acc === 'foto') verFoto(id);
            else if (acc === 'menu') menuModelo(id);
            else if (acc === 'filtro') { S.filtro = el.dataset.f; render(); }
            else if (acc === 'quitar') {
                const m = S.modelos[id]; if (!m) return;
                if (confirm(`¿Quitar el talle ${talle} de "${m.nombre}"? (tiene ${m.talles[talle] || 0} par/es)`)) Store.quitarTalleStock(id, talle, quien());
            } else if (acc === 'agregar-talle') {
                const card = el.closest('.stk-card');
                const t = fmtTalle(card.querySelector('.stk-in-talle').value);
                const c = parseInt(card.querySelector('.stk-in-cant').value) || 1;
                if (!t) { aviso('Escribí el talle (ej: 38 o 39/40).'); return; }
                const actual = Number(((S.modelos[id] || {}).talles || {})[t]) || 0;
                cambiar(id, t, { valor: actual + c }, 'manual');
            }
        });
        cont.addEventListener('change', e => {
            const el = e.target.closest('[data-acc="fijar"]'); if (!el) return;
            const v = Math.max(0, parseInt(el.value) || 0);
            cambiar(el.dataset.id, el.dataset.talle, { valor: v }, 'manual');
        });
        cont.addEventListener('input', e => {
            if (e.target.id === 'stk-buscador') { S.q = e.target.value; render(); }
        });
    }

    function vibrar() { try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /* no soportado */ } }

    // ---------- integración con los pedidos (descuento en depósito) ----------
    // Busca el modelo+talle EXACTO del pedido en el stock de casa.
    function buscarParaPedido(p) {
        const nombre = norm(p.modelo), talle = fmtTalle(p.talle);
        if (!nombre || !talle) return null;
        for (const [id, m] of activos()) {
            if (norm(m.nombre) !== nombre) continue;
            const clave = Object.keys(m.talles || {}).find(k => fmtTalle(k) === talle);
            if (clave !== undefined) return { id, talle: clave, nombre: m.nombre, disponible: Number(m.talles[clave]) || 0 };
        }
        return null;
    }

    // Se llama al marcar VERDE un par. Si el pedido viene de casa (origen) se
    // descuenta directo; si no, solo cuando hay coincidencia exacta y se confirma.
    async function descontarParaPedido(p) {
        if (p.casaNo) return { ok: false, motivo: 'casa-no' };
        const esCasa = p.origen === 'casa';
        const hallado = buscarParaPedido(p);
        if (!hallado) {
            if (esCasa) aviso(`⚠️ "${p.modelo}" (${p.talle}) no está en el stock de casa de la app.`);
            return { ok: false, motivo: 'no-esta' };
        }
        if (hallado.disponible <= 0) {
            if (esCasa) aviso(`⚠️ Stock de casa: "${hallado.nombre}" ${hallado.talle} ya estaba en 0.`);
            return { ok: false, motivo: 'sin-stock' };
        }
        if (!esCasa && !confirm(`📦 "${hallado.nombre}" talle ${hallado.talle} está en tu stock de casa (hay ${hallado.disponible}).\n\n¿Es de casa? Aceptar = descontar 1 del stock.\nCancelar = es del proveedor (no se toca el stock).`)) {
            return { ok: false, motivo: 'cancelado', casaNo: true };
        }
        const r = await Store.cambiarStockTalle(hallado.id, hallado.talle, { delta: -1 }, 'deposito', quien());
        if (!r.ok) { aviso(`⚠️ No se pudo descontar: ${hallado.nombre} ${hallado.talle} está en 0.`); return { ok: false, motivo: 'sin-stock' }; }
        aviso(`📦 Stock de casa: ${hallado.nombre} ${hallado.talle} → ${r.despues}`);
        return { ok: true, descontado: { id: hallado.id, talle: hallado.talle } };
    }

    async function devolver(descontado) {
        if (!descontado || !descontado.id) return false;
        const r = await Store.cambiarStockTalle(descontado.id, descontado.talle, { delta: 1 }, 'deposito-devuelto', quien());
        if (r.ok) aviso(`↩️ Stock de casa: se devolvió 1 (${(S.modelos[descontado.id] || {}).nombre || ''} ${descontado.talle} → ${r.despues})`);
        return r.ok;
    }

    // ---------- arranque -----------------------------------------------------
    function iniciar() {
        if (S.iniciado) return;
        S.iniciado = true;
        Store.onStockCasa(obj => {
            S.modelos = obj || {};
            S.cargado = true;
            const v = document.getElementById('vista-stock');
            if (v && v.style.display !== 'none') render();
        });
    }

    function abrir() {
        iniciar();
        conectarEventos();
        render();
    }

    window.StockCasa = { iniciar, abrir, buscarParaPedido, descontarParaPedido, devolver, aviso, _estado: S, _parsearTalles: parsearTalles, _idDeNombre: idDeNombre, _procesarFoto: procesarFoto, _ponerFoto: ponerFoto };
})();
