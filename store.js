// ============================================================================
// CAPA DE DATOS (Store)
// ============================================================================
// El resto de la app (app.js) usa siempre el mismo objeto `Store`, sin
// importar si los datos viven en Firebase (sincronizado en tiempo real entre
// computadoras) o en localStorage (solo este navegador, modo de prueba).
//
// Se elige automáticamente: si firebase-config.js tiene una clave real, se
// usa Firebase; si todavía tiene los valores de ejemplo, se usa localStorage.
// ============================================================================

const Store = (function () {
    let modo = 'local'; // 'local' | 'firebase'
    let db = null;
    let listenersEstado = [];

    // ---- estado de conexión (para mostrar el puntito arriba a la derecha) --
    // Como signInAnonymously() tarda (viaja por red), casi siempre alguien se
    // suscribe (onEstadoConexion) DESPUÉS de que ya se avisó 'firebase-listo'
    // — por eso se guarda el último estado real y se lo "repite" al que llega
    // tarde, en vez de asumir que todavía está conectando.
    let estadoActual = 'local';
    function notificarEstado(estado, detalle) {
        estadoActual = estado;
        listenersEstado.forEach(cb => cb(estado, detalle));
    }
    function onEstadoConexion(cb) {
        listenersEstado.push(cb);
        cb(estadoActual);
    }

    function configFirebaseEsValida() {
        const c = window.FIREBASE_CONFIG;
        return !!(c && c.apiKey && c.apiKey !== 'TU_API_KEY' && c.projectId && c.projectId !== 'tu-proyecto');
    }

    let listo = null; // promesa que resuelve cuando el store está listo para usarse

    function init() {
        if (listo) return listo;

        if (configFirebaseEsValida() && window.firebase) {
            modo = 'firebase';
            notificarEstado('firebase-conectando');
            firebase.initializeApp(window.FIREBASE_CONFIG);
            db = firebase.firestore();

            listo = firebase.auth().signInAnonymously()
                .then(() => {
                    notificarEstado('firebase-listo');
                })
                .catch(err => {
                    console.error('Error conectando con Firebase, se usa modo local:', err);
                    modo = 'local';
                    notificarEstado('local-por-error', err.message);
                });
        } else {
            modo = 'local';
            notificarEstado('local');
            listo = Promise.resolve();
        }
        return listo;
    }

    // ---- helpers localStorage ------------------------------------------------
    const LS_KEYS = { pedidos: 'ap_pedidos', clientes: 'ap_clientes', config: 'ap_config', respaldo: 'ap_respaldo_borrado', cierres: 'ap_cierres', listas: 'ap_listas' };

    function lsGet(key, porDefecto) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : porDefecto;
        } catch (e) { return porDefecto; }
    }
    function lsSet(key, valor) {
        localStorage.setItem(key, JSON.stringify(valor));
    }

    let pedidosListenersLocal = [];
    let clientesListenersLocal = [];
    let configListenersLocal = [];
    let respaldoListenersLocal = [];
    let listasListenersLocal = [];

    function emitPedidosLocal() {
        const arr = lsGet(LS_KEYS.pedidos, []);
        pedidosListenersLocal.forEach(cb => cb(arr));
    }
    function emitClientesLocal() {
        const obj = lsGet(LS_KEYS.clientes, {});
        clientesListenersLocal.forEach(cb => cb(obj));
    }
    function emitConfigLocal() {
        const obj = lsGet(LS_KEYS.config, null);
        configListenersLocal.forEach(cb => cb(obj));
    }
    // El respaldo es un mapa { [listaId]: {pedidos, timestamp} } — cada
    // listener (uno por lista suscrita) se queda solo con su propia parte.
    function emitRespaldoLocal() {
        const todos = lsGet(LS_KEYS.respaldo, {});
        respaldoListenersLocal.forEach(cb => cb(todos));
    }
    function emitListasLocal() {
        const obj = lsGet(LS_KEYS.listas, {});
        listasListenersLocal.forEach(cb => cb(obj));
    }

    // Sincroniza entre pestañas del MISMO navegador (no entre computadoras).
    window.addEventListener('storage', (e) => {
        if (e.key === LS_KEYS.pedidos) emitPedidosLocal();
        if (e.key === LS_KEYS.clientes) emitClientesLocal();
        if (e.key === LS_KEYS.config) emitConfigLocal();
        if (e.key === LS_KEYS.respaldo) emitRespaldoLocal();
        if (e.key === LS_KEYS.listas) emitListasLocal();
    });

    function idLocalNuevo() {
        return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // ---- API PEDIDOS -----------------------------------------------------
    function onPedidos(callback) {
        if (modo === 'firebase') {
            return db.collection('pedidos').onSnapshot(
                snap => callback(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
                err => console.error('Error escuchando pedidos:', err)
            );
        } else {
            pedidosListenersLocal.push(callback);
            emitPedidosLocal();
            return () => { pedidosListenersLocal = pedidosListenersLocal.filter(f => f !== callback); };
        }
    }

    function addPedido(data) {
        const conCreatedAt = { ...data, createdAt: Date.now() };
        if (modo === 'firebase') {
            return db.collection('pedidos').add(conCreatedAt).then(ref => ref.id);
        } else {
            const arr = lsGet(LS_KEYS.pedidos, []);
            const id = idLocalNuevo();
            arr.push({ id, ...conCreatedAt });
            lsSet(LS_KEYS.pedidos, arr);
            emitPedidosLocal();
            return Promise.resolve(id);
        }
    }

    function updatePedido(id, partial) {
        if (modo === 'firebase') {
            return db.collection('pedidos').doc(id).update(partial);
        } else {
            const arr = lsGet(LS_KEYS.pedidos, []);
            const idx = arr.findIndex(p => p.id === id);
            if (idx >= 0) arr[idx] = { ...arr[idx], ...partial };
            lsSet(LS_KEYS.pedidos, arr);
            emitPedidosLocal();
            return Promise.resolve();
        }
    }

    function deletePedido(id) {
        if (modo === 'firebase') {
            return db.collection('pedidos').doc(id).delete();
        } else {
            const arr = lsGet(LS_KEYS.pedidos, []).filter(p => p.id !== id);
            lsSet(LS_KEYS.pedidos, arr);
            emitPedidosLocal();
            return Promise.resolve();
        }
    }

    // Borra todo y devuelve una copia (para poder deshacer).
    function deleteAllPedidos(pedidosActuales) {
        const backup = JSON.parse(JSON.stringify(pedidosActuales));
        if (modo === 'firebase') {
            const batch = db.batch();
            pedidosActuales.forEach(p => batch.delete(db.collection('pedidos').doc(p.id)));
            return batch.commit().then(() => backup);
        } else {
            lsSet(LS_KEYS.pedidos, []);
            emitPedidosLocal();
            return Promise.resolve(backup);
        }
    }

    // Restaura pedidos borrados (deshacer), manteniendo sus ids originales.
    function restorePedidos(backup) {
        if (!backup || backup.length === 0) return Promise.resolve();
        if (modo === 'firebase') {
            const batch = db.batch();
            backup.forEach(p => {
                const { id, ...resto } = p;
                batch.set(db.collection('pedidos').doc(id), resto);
            });
            return batch.commit();
        } else {
            lsSet(LS_KEYS.pedidos, backup);
            emitPedidosLocal();
            return Promise.resolve();
        }
    }

    // ---- API RESPALDO DE BORRADO (para poder deshacer desde CUALQUIER compu) --
    // Un documento por LISTA (antes había uno solo, de cuando existía una
    // sola lista de pedidos). Así, si borrás todo en una lista, tu socio ve
    // aparecer "Deshacer" en esa misma lista en su compu (y viceversa), sin
    // mezclarse con el "Borrar todo" de otra lista distinta.
    function onRespaldoBorrado(listaId, callback) {
        if (modo === 'firebase') {
            return db.collection('respaldos_borrado').doc(listaId).onSnapshot(
                doc => callback(doc.exists ? doc.data() : null),
                err => console.error('Error escuchando respaldo de borrado:', err)
            );
        } else {
            const wrapped = (todos) => callback((todos || {})[listaId] || null);
            respaldoListenersLocal.push(wrapped);
            emitRespaldoLocal();
            return () => { respaldoListenersLocal = respaldoListenersLocal.filter(f => f !== wrapped); };
        }
    }

    function guardarRespaldoBorrado(listaId, pedidosArray) {
        const data = { pedidos: pedidosArray, timestamp: Date.now() };
        if (modo === 'firebase') {
            return db.collection('respaldos_borrado').doc(listaId).set(data);
        } else {
            const todos = lsGet(LS_KEYS.respaldo, {});
            todos[listaId] = data;
            lsSet(LS_KEYS.respaldo, todos);
            emitRespaldoLocal();
            return Promise.resolve();
        }
    }

    function borrarRespaldoBorrado(listaId) {
        if (modo === 'firebase') {
            return db.collection('respaldos_borrado').doc(listaId).delete();
        } else {
            const todos = lsGet(LS_KEYS.respaldo, {});
            delete todos[listaId];
            lsSet(LS_KEYS.respaldo, todos);
            emitRespaldoLocal();
            return Promise.resolve();
        }
    }

    // ---- API LISTAS (varias tablas de pedidos independientes) -------------
    // "principal" (Zapatillas) siempre existe y no se puede borrar. Las
    // demás las crea/borra quien use la app (ej: "Indumentaria", "G5").
    function onListas(callback) {
        if (modo === 'firebase') {
            return db.collection('listas').onSnapshot(
                snap => { const obj = {}; snap.forEach(d => { obj[d.id] = d.data(); }); callback(obj); },
                err => console.error('Error escuchando listas:', err)
            );
        } else {
            listasListenersLocal.push(callback);
            emitListasLocal();
            return () => { listasListenersLocal = listasListenersLocal.filter(f => f !== callback); };
        }
    }

    function asegurarListaPrincipal() {
        const datos = { nombre: 'Zapatillas', esPrincipal: true, creadaEn: Date.now() };
        if (modo === 'firebase') {
            return db.collection('listas').doc('principal').set(datos, { merge: true });
        } else {
            const obj = lsGet(LS_KEYS.listas, {});
            if (!obj.principal) {
                obj.principal = datos;
                lsSet(LS_KEYS.listas, obj);
                emitListasLocal();
            }
            return Promise.resolve();
        }
    }

    function crearLista(nombre) {
        const datos = { nombre, esPrincipal: false, creadaEn: Date.now() };
        if (modo === 'firebase') {
            return db.collection('listas').add(datos).then(ref => ref.id);
        } else {
            const obj = lsGet(LS_KEYS.listas, {});
            const id = idLocalNuevo();
            obj[id] = datos;
            lsSet(LS_KEYS.listas, obj);
            emitListasLocal();
            return Promise.resolve(id);
        }
    }

    // Borra la lista Y todos sus pedidos (no se puede deshacer: es a propósito
    // más "pesado" que el borrado normal, que sí tiene ventana de deshacer).
    function eliminarLista(id, pedidosDeEsaLista) {
        if (modo === 'firebase') {
            const batch = db.batch();
            pedidosDeEsaLista.forEach(p => batch.delete(db.collection('pedidos').doc(p.id)));
            batch.delete(db.collection('listas').doc(id));
            return batch.commit();
        } else {
            const arr = lsGet(LS_KEYS.pedidos, []).filter(p => !pedidosDeEsaLista.some(x => x.id === p.id));
            lsSet(LS_KEYS.pedidos, arr);
            emitPedidosLocal();
            const obj = lsGet(LS_KEYS.listas, {});
            delete obj[id];
            lsSet(LS_KEYS.listas, obj);
            emitListasLocal();
            return Promise.resolve();
        }
    }

    // ---- API CLIENTES (nombre -> { nombre, esGrupo }) ---------------------
    function normalizarIdCliente(nombre) {
        return normalizarTexto(nombre).trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'sin_nombre';
    }

    function onClientes(callback) {
        if (modo === 'firebase') {
            return db.collection('clientes').onSnapshot(
                snap => {
                    const obj = {};
                    snap.forEach(d => { obj[d.id] = d.data(); });
                    callback(obj);
                },
                err => console.error('Error escuchando clientes:', err)
            );
        } else {
            clientesListenersLocal.push(callback);
            emitClientesLocal();
            return () => { clientesListenersLocal = clientesListenersLocal.filter(f => f !== callback); };
        }
    }

    function setCliente(nombre, data) {
        const id = normalizarIdCliente(nombre);
        if (modo === 'firebase') {
            return db.collection('clientes').doc(id).set(data, { merge: true });
        } else {
            const obj = lsGet(LS_KEYS.clientes, {});
            obj[id] = { ...(obj[id] || {}), ...data };
            lsSet(LS_KEYS.clientes, obj);
            emitClientesLocal();
            return Promise.resolve();
        }
    }

    function eliminarCliente(id) {
        if (modo === 'firebase') {
            return db.collection('clientes').doc(id).delete();
        } else {
            const obj = lsGet(LS_KEYS.clientes, {});
            delete obj[id];
            lsSet(LS_KEYS.clientes, obj);
            emitClientesLocal();
            return Promise.resolve();
        }
    }

    // ---- API CONFIG (reglas de precio) ------------------------------------
    function onConfig(callback) {
        if (modo === 'firebase') {
            return db.collection('config').doc('precios').onSnapshot(
                doc => callback(doc.exists ? doc.data() : null),
                err => console.error('Error escuchando config:', err)
            );
        } else {
            configListenersLocal.push(callback);
            emitConfigLocal();
            return () => { configListenersLocal = configListenersLocal.filter(f => f !== callback); };
        }
    }

    function setConfig(configObj) {
        if (modo === 'firebase') {
            return db.collection('config').doc('precios').set(configObj);
        } else {
            lsSet(LS_KEYS.config, configObj);
            emitConfigLocal();
            return Promise.resolve();
        }
    }

    function getModo() { return modo; }

    // ---- API CIERRES (historial detallado) ---------------------------------
    // Cada vez que se usa "Borrar todo" se guarda UN documento nuevo y chico
    // con esa fecha, lo facturado y qué modelos se vendieron — es un
    // historial (nunca se pisa ni se reescribe), no un contador compartido,
    // así que no hace falta nada atómico: cada cierre es su propio documento.
    function registrarCierre(datos) {
        const conFecha = { ...datos, creadoEn: Date.now() };
        if (modo === 'firebase') {
            return db.collection('cierres').add(conFecha).then(ref => ref.id);
        } else {
            const arr = lsGet(LS_KEYS.cierres, []);
            arr.push({ id: idLocalNuevo(), ...conFecha });
            lsSet(LS_KEYS.cierres, arr);
            return Promise.resolve();
        }
    }

    // Lectura puntual (no en tiempo real): el historial solo se mira cuando
    // alguien abre el panel de Estadísticas, no hace falta escuchar en vivo.
    function obtenerCierresDelMes(mesId) {
        if (modo === 'firebase') {
            return db.collection('cierres').where('mes', '==', mesId).get()
                .then(snap => snap.docs.map(d => ({ id: d.id, ...d.data() })));
        } else {
            const arr = lsGet(LS_KEYS.cierres, []);
            return Promise.resolve(arr.filter(c => c.mes === mesId));
        }
    }

    return {
        init, onEstadoConexion, getModo,
        onPedidos, addPedido, updatePedido, deletePedido, deleteAllPedidos, restorePedidos,
        onRespaldoBorrado, guardarRespaldoBorrado, borrarRespaldoBorrado,
        onClientes, setCliente, eliminarCliente, normalizarIdCliente,
        onConfig, setConfig,
        registrarCierre, obtenerCierresDelMes,
        onListas, asegurarListaPrincipal, crearLista, eliminarLista,
    };
})();
