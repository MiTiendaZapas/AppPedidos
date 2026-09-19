// ============================================================================
// APP PEDIDOS — lógica principal
// ============================================================================

const PRINCIPAL_LISTA_ID = 'principal'; // "Zapatillas": la única que registra estadísticas
const CLAVE_LISTA_ACTIVA = 'ap_lista_activa';

let todosPedidos = [];      // último snapshot de la colección "pedidos" (TODAS las listas)
let pedidos = [];           // solo los pedidos de la lista que se está viendo ahora
let listasCache = {};       // id de lista -> { nombre, esPrincipal, creadaEn }
let listaActivaId = PRINCIPAL_LISTA_ID;
let vistaActiva = 'listas'; // 'listas' | 'estadisticas'
let unsubRespaldoBorrado = null; // se re-suscribe cada vez que se cambia de lista

let clientesCache = {};     // id normalizado -> { nombre, esGrupo }
let precioConfig = null;    // reglas de precio (ver pricing.js) — compartidas por todas las listas
let configDraft = null;     // copia editable de precioConfig mientras el modal está abierto
let modalConfigAbierto = false;

let respaldoCompartido = null; // último respaldo de "Borrar todo" de la lista activa (compartido: se ve en cualquier compu)
let timeoutDeshacer = null;
let filtroTexto = '';          // buscador de la lista

const VENTANA_DESHACER_MS = 30000; // 30s para que cualquiera de los dos alcance a deshacer

function idListaDe(p) { return p.listaId || PRINCIPAL_LISTA_ID; }

// Se llama cada vez que llega un snapshot nuevo de pedidos, o cada vez que
// se cambia de pestaña de lista: `pedidos` (la variable que usa todo el
// resto de la app) queda siempre acotada a la lista que se está viendo.
function recalcularPedidosActivos() {
    pedidos = todosPedidos.filter(p => idListaDe(p) === listaActivaId);
    actualizarAutocompletado();
    renderizarTabla();
}

const OPCIONES_PAGO = ['', 'Efectivo', 'Efectivo/seña', 'Transferencia', 'Trans/seña', 'Cambio'];
const OPCIONES_ESTADO = ['', '❌', '✅'];
const OPCIONES_ENVIO = ['', 'Via', 'Moto', 'Retiro'];

const pedidoForm = document.getElementById('pedido-form');
const listaBody = document.getElementById('lista-pedidos-body');
const clienteInput = document.getElementById('cliente');
const clienteGrupoCheckbox = document.getElementById('cliente-grupo');

// ----------------------------------------------------------------------------
// UTILIDADES
// ----------------------------------------------------------------------------
function formatoPesos(numero) {
    const n = parseFloat(numero) || 0;
    return '$' + n.toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

function extraerNumeroTalle(talleStr) {
    return parseFloat((talleStr || '').toString().split('/')[0].replace(',', '.').trim()) || 0;
}

// Interpreta lo que se escribió en Pago: monto ("10000", "$10.000"), porcentaje
// ("50%"), "total" (ya pagó todo lo que debe) o "0" (debe todo). El "." especial
// (marcar todo el cliente como saldado) se maneja aparte, ANTES de llamar esto.
function parseMontoOPorcentaje(valorInput, deudaBase) {
    valorInput = (valorInput || '').toString().trim();
    if (!valorInput) return '';

    const deuda = parseFloat(deudaBase) || 0;

    if (/^total$/i.test(valorInput)) {
        if (deuda <= 0) return null;
        return deuda.toString();
    }

    const matchPorcentaje = valorInput.match(/^(\d+(?:[.,]\d+)?)\s*%$/);
    if (matchPorcentaje) {
        if (deuda <= 0) return null;
        const porcentaje = parseFloat(matchPorcentaje[1].replace(',', '.'));
        return Math.round((deuda * porcentaje) / 100).toString();
    }

    const limpio = valorInput.replace(/[\$¢\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
    if (limpio === '') return '';
    const numero = parseFloat(limpio);
    return isNaN(numero) ? '' : numero.toString();
}

function normalizarModelo(m) {
    return normalizarTexto(m).trim();
}

// ----------------------------------------------------------------------------
// MOTOR DE PRECIOS (usa pricing.js + precioConfig + pedidos actuales)
// ----------------------------------------------------------------------------
function tablaParaCliente(nombreCliente, override) {
    if (override) return override;
    const id = Store.normalizarIdCliente(nombreCliente);
    const c = clientesCache[id];
    return (c && c.esGrupo) ? 'mayorista' : 'minorista';
}

// lineasDelCliente: [{modelo, cantidad}, ...] — TODAS las líneas del cliente
// (incluidas las que se están por agregar), para calcular el nivel de precio.
function calcularParaLinea(nombreCliente, modelo, lineasDelCliente, tablaOverride) {
    const tabla = tablaParaCliente(nombreCliente, tablaOverride);
    const totalPares = lineasDelCliente
        .filter(l => clasificarTipo(precioConfig, l.modelo) === 'zapatilla')
        .reduce((s, l) => s + (parseInt(l.cantidad) || 0), 0);

    const modeloNorm = normalizarModelo(modelo);
    const cantidadMismoModelo = lineasDelCliente
        .filter(l => normalizarModelo(l.modelo) === modeloNorm)
        .reduce((s, l) => s + (parseInt(l.cantidad) || 0), 0);

    const resultado = calcularPrecioUnitario(precioConfig, tabla, modelo, totalPares, cantidadMismoModelo);
    return { ...resultado, tabla };
}

function importeDeLinea(precioUnitario, cantidad) {
    return (parseFloat(precioUnitario) || 0) * (parseInt(cantidad) || 0);
}

// El recargo por cambio de talle no modifica el Importe (precio del producto):
// se suma directamente sobre lo que el cliente debe (Saldo / Total facturado).
function recargoDeLinea(p) {
    return p.pago === 'Cambio' ? (parseFloat(precioConfig ? precioConfig.recargoCambio : 0) || 0) : 0;
}
function deudaDeLinea(p) {
    return (parseFloat(p.importe) || 0) + recargoDeLinea(p);
}

// Recalcula el precio automático de TODAS las líneas de un cliente que no
// tengan precio manual, usando el estado actual de `pedidos` + líneas extra
// que todavía no se guardaron (por ej. las que se están por insertar).
function recomputarPreciosCliente(nombreCliente, extraDraftLineas, tablaOverride) {
    const clienteLower = (nombreCliente || '').trim().toLowerCase();
    if (!clienteLower || !precioConfig) return;

    const existentes = pedidos.filter(p => (p.cliente || '').trim().toLowerCase() === clienteLower);
    const todas = existentes.map(p => ({ modelo: p.modelo, cantidad: p.cantidad })).concat(extraDraftLineas || []);

    existentes.forEach(p => {
        // Un cambio de talle no tiene precio de producto: no se recalcula.
        if (p.manualPrecio || p.pago === 'Cambio') return;
        const r = calcularParaLinea(nombreCliente, p.modelo, todas, tablaOverride);
        const nuevoImporte = importeDeLinea(r.precio, p.cantidad);
        if (p.precioUnitario !== r.precio || p.importe !== nuevoImporte || p.categoria !== r.categoria) {
            Store.updatePedido(p.id, { precioUnitario: r.precio, importe: nuevoImporte, categoria: r.categoria, tipo: r.tipo });
        }
    });
}

function recomputarTodosLosClientes() {
    const nombresVistos = new Set();
    pedidos.forEach(p => {
        const key = (p.cliente || '').trim().toLowerCase();
        if (!key || nombresVistos.has(key)) return;
        nombresVistos.add(key);
        recomputarPreciosCliente(p.cliente, []);
    });
}

// Marca como SALDADAS (pago = importe + recargo) todas las líneas de venta
// actuales de un cliente. Los "Cambio" de talle quedan afuera a propósito:
// son un cargo aparte (el recargo), y no porque el cliente haya terminado de
// pagar sus zapatillas significa que ya pagó también el cambio. Es una
// acción puntual: un modelo que se agregue después queda sin marcar, tal
// como se pidió.
function marcarClienteComoSaldado(nombreCliente) {
    const key = (nombreCliente || '').trim().toLowerCase();
    if (!key) return;
    pedidos
        .filter(p => (p.cliente || '').trim().toLowerCase() === key && p.pago !== 'Cambio')
        .forEach(p => {
            const deuda = deudaDeLinea(p);
            if (p.pagoMonto !== deuda) Store.updatePedido(p.id, { pagoMonto: deuda });
        });
}

// Salda SOLO esta línea (para un "Cambio": su recargo es un cargo aparte,
// saldar el resto del pedido del cliente no debería marcarlo a él también).
function marcarLineaComoSaldada(pedido) {
    const deuda = deudaDeLinea(pedido);
    if (pedido.pagoMonto !== deuda) Store.updatePedido(pedido.id, { pagoMonto: deuda });
}

// ----------------------------------------------------------------------------
// CLIENTES (grupo mayorista / minorista)
// ----------------------------------------------------------------------------
function sincronizarCheckboxGrupo() {
    const nombre = clienteInput.value.trim();
    if (!nombre) return;
    const id = Store.normalizarIdCliente(nombre);
    const c = clientesCache[id];
    clienteGrupoCheckbox.checked = !!(c && c.esGrupo);
}

// Solo se guardan los clientes del GRUPO de revendedores (para acordarse el
// precio mayorista la próxima vez). Un cliente minorista común no se guarda
// en ningún lado: no hace falta, y así la lista de "Clientes" en
// Configuración queda siendo directamente tu lista de revendedores.
function guardarClienteSiHaceFalta(nombre, forzarGuardado) {
    if (!nombre) return;
    const esGrupo = clienteGrupoCheckbox.checked;
    const id = Store.normalizarIdCliente(nombre);
    const actual = clientesCache[id];
    const eraGrupo = actual ? actual.esGrupo : false;
    const cambioDeGrupo = eraGrupo !== esGrupo;

    if (esGrupo) {
        if (forzarGuardado || cambioDeGrupo || !actual || actual.nombre !== nombre) {
            Store.setCliente(nombre, { nombre, esGrupo: true });
            clientesCache[id] = { nombre, esGrupo: true }; // optimista, evita esperar al snapshot
        }
    } else if (actual) {
        // Se destildó "grupo": sale de la lista guardada.
        Store.eliminarCliente(id);
        delete clientesCache[id];
    }

    if (cambioDeGrupo) {
        recomputarPreciosCliente(nombre, [], esGrupo ? 'mayorista' : 'minorista');
    }
}

clienteInput.addEventListener('input', sincronizarCheckboxGrupo);
clienteInput.addEventListener('change', sincronizarCheckboxGrupo);
clienteGrupoCheckbox.addEventListener('change', () => {
    const nombre = clienteInput.value.trim();
    if (nombre) guardarClienteSiHaceFalta(nombre, true);
});

// ----------------------------------------------------------------------------
// PESTAÑAS DE CARGA (rápida / manual) — elegís una, la otra no molesta
// ----------------------------------------------------------------------------
document.querySelectorAll('.tab-carga-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-carga-btn').forEach(b => b.classList.remove('activo'));
        document.querySelectorAll('.tab-carga-contenido').forEach(c => c.classList.remove('activo'));
        btn.classList.add('activo');
        document.getElementById(btn.dataset.tabCarga).classList.add('activo');
    });
});

// ----------------------------------------------------------------------------
// DIRECCIÓN DE ENVÍO (solo tiene sentido si hay Via Cargo o Moto)
// ----------------------------------------------------------------------------
const envioSelect = document.getElementById('envio');
const campoDireccion = document.getElementById('campo-direccion');
const direccionInput = document.getElementById('direccion-envio');

function sincronizarCampoDireccion() {
    const necesitaDireccion = envioSelect.value === 'Via' || envioSelect.value === 'Moto';
    campoDireccion.style.display = necesitaDireccion ? '' : 'none';
}
envioSelect.addEventListener('change', sincronizarCampoDireccion);

function actualizarAutocompletado() {
    const dlClientes = document.getElementById('opciones-clientes');
    const dlModelos = document.getElementById('opciones-modelos');
    const dlTalles = document.getElementById('opciones-talles');
    if (!dlClientes || !dlModelos || !dlTalles) return;

    const clientesUnicos = [...new Set(pedidos.map(p => p.cliente))].filter(Boolean).sort();
    const modelosUnicos = [...new Set(pedidos.map(p => p.modelo))].filter(Boolean).sort();
    const tallesUnicos = [...new Set(pedidos.map(p => p.talle))]
        .filter(Boolean)
        .sort((a, b) => extraerNumeroTalle(a) - extraerNumeroTalle(b));

    dlClientes.innerHTML = clientesUnicos.map(c => `<option value="${c}">`).join('');
    dlModelos.innerHTML = modelosUnicos.map(m => `<option value="${m}">`).join('');
    dlTalles.innerHTML = tallesUnicos.map(t => `<option value="${t}">`).join('');
}

// ----------------------------------------------------------------------------
// CARGA RÁPIDA (pegar texto)
// ----------------------------------------------------------------------------
function extraerPrecioDeLinea(linea, talleAExcluir) {
    const conSeparador = linea.match(/(?:[\$¢]\s*)?\b\d{1,3}(?:[\.,]\d{3})+(?:[\.,]\d{2})?\b/g);
    let candidato = null;

    if (conSeparador && conSeparador.length > 0) {
        candidato = conSeparador[conSeparador.length - 1];
    } else {
        const sueltos = linea.match(/(?:[\$¢]\s*)?\b\d{4,6}\b/g);
        if (sueltos) {
            const filtrados = sueltos.filter(n => parseInt(n.replace(/[\$¢\s]/g, '')) !== talleAExcluir);
            if (filtrados.length > 0) candidato = filtrados[filtrados.length - 1];
        }
    }
    if (!candidato) return null;

    let limpio = candidato.replace(/[\$¢\s]/g, '');
    const matchDecimal = limpio.match(/[\.,](\d{2})$/);
    let decimales = 0;
    if (matchDecimal) {
        decimales = parseFloat('0.' + matchDecimal[1]);
        limpio = limpio.slice(0, -3);
    }
    limpio = limpio.replace(/[\.,]/g, '');
    const numero = parseInt(limpio) || 0;
    return { valor: numero + decimales, textoOriginal: candidato };
}

function parsearTextoPedido(texto) {
    const resultado = [];
    texto.split('\n').forEach(lineaOrig0 => {
        let lineaOrig = lineaOrig0.trim();
        if (!lineaOrig) return;

        let talle = null;
        const matchTalle = lineaOrig.match(/\((\d{2,3}(?:[.,]5)?)(?:\s*\/\s*(\d{2,3}(?:[.,]5)?))?\)/);
        if (matchTalle) {
            if (matchTalle[2]) {
                talle = `${matchTalle[1].replace(',', '.')}/${matchTalle[2].replace(',', '.')}`;
            } else {
                talle = matchTalle[1].replace(',', '.');
            }
        } else {
            const numeros = lineaOrig.match(/\b(1[5-9]|[2-4]\d|50)\b/g);
            if (numeros) talle = numeros[numeros.length - 1];
        }
        if (!talle) return;

        const precioInfo = extraerPrecioDeLinea(lineaOrig, parseInt(talle));

        let cantidad = 1;
        const matchCantidad = lineaOrig.match(/[x×]\s*(\d+)/i);
        if (matchCantidad) cantidad = parseInt(matchCantidad[1]) || 1;

        let nombreLimpio = lineaOrig;
        if (precioInfo) nombreLimpio = nombreLimpio.replace(precioInfo.textoOriginal, '');
        nombreLimpio = nombreLimpio.replace(/[x×]\s*\d+/gi, '');
        nombreLimpio = nombreLimpio.replace(/\(\s*\d{1,3}(?:[.,]5)?\s*(?:\/\s*\d{1,3}(?:[.,]5)?\s*)?\)/g, '');
        nombreLimpio = nombreLimpio.replace(/[\/\\]/g, ' ');
        // Incluye los espacios en la misma limpieza final (no solo la
        // puntuación): si el precio venía seguido de ", x2" (coma antes de
        // la cantidad), sacar el precio y la cantidad por separado dejaba
        // una coma "huérfana" con un espacio después ("Mind beige , "), y
        // esa coma no quedaba al final del todo — no se limpiaba.
        nombreLimpio = nombreLimpio.replace(/[\s,;:\-–—.]+$/g, '');
        nombreLimpio = nombreLimpio.replace(/\s+/g, ' ').trim();
        if (!nombreLimpio) return;

        resultado.push({ modelo: nombreLimpio, talle: talle.toString(), cantidad });
    });
    return resultado;
}

document.getElementById('btn-procesar-texto').addEventListener('click', () => {
    const cliente = clienteInput.value.trim();
    const texto = document.getElementById('texto-crudo').value;

    if (!cliente) {
        alert("⚠️ Por favor, escribí el nombre del Cliente arriba antes de procesar la lista.");
        clienteInput.focus();
        return;
    }
    if (!texto.trim()) {
        alert("⚠️ El cuadro de texto está vacío. Pegá tu lista de zapatillas primero.");
        return;
    }

    guardarClienteSiHaceFalta(cliente);

    const lineasParseadas = parsearTextoPedido(texto);
    if (lineasParseadas.length === 0) {
        alert("❌ No se detectaron modelos o talles válidos. Revisá el texto ingresado.");
        return;
    }

    const existentes = pedidos
        .filter(p => (p.cliente || '').trim().toLowerCase() === cliente.toLowerCase())
        .map(p => ({ modelo: p.modelo, cantidad: p.cantidad }));
    const draftTodas = existentes.concat(lineasParseadas.map(l => ({ modelo: l.modelo, cantidad: l.cantidad })));

    const pagoSel = document.getElementById('pago').value;
    const estadoSel = document.getElementById('estado').value;
    const envioSel = document.getElementById('envio').value;
    const direccionSel = (envioSel === 'Via' || envioSel === 'Moto') ? direccionInput.value.trim() : '';
    const esCambio = pagoSel === 'Cambio';

    const promesas = lineasParseadas.map(l => {
        // Un cambio de talle no es una venta: sin precio unitario ni importe,
        // solo el recargo (que ya suma deudaDeLinea sobre el Saldo).
        const datosPrecio = esCambio
            ? { precioUnitario: 0, importe: 0, categoria: 'Cambio de talle', tipo: clasificarTipo(precioConfig, l.modelo) }
            : (() => { const r = calcularParaLinea(cliente, l.modelo, draftTodas); return { precioUnitario: r.precio, importe: importeDeLinea(r.precio, l.cantidad), categoria: r.categoria, tipo: r.tipo }; })();
        return Store.addPedido({
            cliente, modelo: l.modelo, talle: l.talle, cantidad: l.cantidad,
            ...datosPrecio, manualPrecio: false,
            pagoMonto: '',
            pago: pagoSel, estado: estadoSel, envio: envioSel, direccion: direccionSel,
            listaId: listaActivaId,
        });
    });

    Promise.all(promesas).then(() => {
        recomputarPreciosCliente(cliente, []);
        document.getElementById('texto-crudo').value = '';
        alert(`✅ Se agregaron ${lineasParseadas.length} línea(s) a nombre de ${cliente}.`);
    });
});

// ----------------------------------------------------------------------------
// FORMULARIO MANUAL
// ----------------------------------------------------------------------------
pedidoForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (document.getElementById('texto-crudo').value.trim() && !document.getElementById('modelo').value.trim()) {
        alert("Escribiste en el cuadro grande. Usá el botón azul 'Cargar Lista Automática'.");
        return;
    }

    const cliente = clienteInput.value.trim();
    const modelo = document.getElementById('modelo').value.trim();
    const talle = document.getElementById('talle').value.trim();
    const cantidad = parseInt(document.getElementById('cantidad').value) || 1;

    if (!cliente) {
        alert("⚠️ Completá el nombre del Cliente.");
        return;
    }
    if (!modelo || !talle) {
        alert("⚠️ Completá Modelo y Talle antes de agregar el pedido.");
        return;
    }

    guardarClienteSiHaceFalta(cliente);

    const pago = document.getElementById('pago').value;
    const esCambio = pago === 'Cambio';

    const precioManualRaw = document.getElementById('precio-manual').value.trim();
    let precioUnitario, categoria, tipo, manualPrecio;

    if (esCambio) {
        // Un cambio de talle no es una venta: sin precio unitario ni importe,
        // solo el recargo (que ya suma deudaDeLinea sobre el Saldo).
        precioUnitario = 0; categoria = 'Cambio de talle'; manualPrecio = false;
        tipo = clasificarTipo(precioConfig, modelo);
    } else if (precioManualRaw !== '') {
        precioUnitario = parseFloat(precioManualRaw) || 0;
        manualPrecio = true;
        categoria = 'Manual';
        tipo = clasificarTipo(precioConfig, modelo);
    } else {
        const existentes = pedidos
            .filter(p => (p.cliente || '').trim().toLowerCase() === cliente.toLowerCase())
            .map(p => ({ modelo: p.modelo, cantidad: p.cantidad }));
        const todas = existentes.concat([{ modelo, cantidad }]);
        const r = calcularParaLinea(cliente, modelo, todas);
        precioUnitario = r.precio; categoria = r.categoria; tipo = r.tipo; manualPrecio = false;
    }

    const importe = esCambio ? 0 : importeDeLinea(precioUnitario, cantidad);
    const deuda = importe + (esCambio ? (parseFloat(precioConfig.recargoCambio) || 0) : 0);

    const pagoMontoRaw = document.getElementById('pago-monto').value.trim();
    let pagoMonto;
    if (pagoMontoRaw === '.') {
        pagoMonto = deuda; // esta línea nace saldada
    } else {
        pagoMonto = parseMontoOPorcentaje(pagoMontoRaw, deuda);
        if (pagoMonto === null) {
            alert("⚠️ Para usar '%' o 'total' en el Pago, el precio tiene que ser mayor a 0 (revisá el precio).");
            return;
        }
    }

    const envioVal = document.getElementById('envio').value;
    const nuevoPedido = {
        cliente, modelo, talle, cantidad,
        precioUnitario, importe, manualPrecio, categoria, tipo,
        pagoMonto,
        pago,
        estado: document.getElementById('estado').value,
        envio: envioVal,
        direccion: (envioVal === 'Via' || envioVal === 'Moto') ? direccionInput.value.trim() : '',
        listaId: listaActivaId,
    };

    Store.addPedido(nuevoPedido).then(() => {
        recomputarPreciosCliente(cliente, []);
        if (pagoMontoRaw === '.') marcarClienteComoSaldado(cliente);
    });

    document.getElementById('modelo').value = '';
    document.getElementById('talle').value = '';
    document.getElementById('cantidad').value = 1;
    document.getElementById('precio-manual').value = '';
    document.getElementById('pago-monto').value = '';
    document.getElementById('modelo').focus();
});

// ----------------------------------------------------------------------------
// EDICIÓN EN LA TABLA
// ----------------------------------------------------------------------------
window.guardarEdicion = function (id, campo, elemento) {
    const pedido = pedidos.find(p => p.id === id);
    if (!pedido) return;
    let nuevoValor = elemento.innerText.trim();

    if (campo === 'cantidad') {
        const n = Math.max(parseInt(nuevoValor) || 1, 1);
        if (n === pedido.cantidad) return;
        const nuevoImporte = pedido.manualPrecio ? importeDeLinea(pedido.precioUnitario, n) : pedido.importe;
        Store.updatePedido(id, pedido.manualPrecio ? { cantidad: n, importe: nuevoImporte } : { cantidad: n })
            .then(() => recomputarPreciosCliente(pedido.cliente, []));
        return;
    }

    if (campo === 'precioUnitario') {
        const limpio = nuevoValor.replace(/[\$¢\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
        const n = limpio ? (parseFloat(limpio) || 0) : 0;
        const nuevoImporte = importeDeLinea(n, pedido.cantidad);
        Store.updatePedido(id, { precioUnitario: n, importe: nuevoImporte, manualPrecio: true, categoria: 'Manual' });
        return;
    }

    if (campo === 'pagoMonto') {
        if (nuevoValor === '.') {
            // En un "Cambio" el "." salda solo esta línea (su recargo es un
            // cargo aparte); en una venta normal, salda todo lo que el
            // cliente compró (sin tocar sus "Cambio", ver más arriba).
            if (pedido.pago === 'Cambio') marcarLineaComoSaldada(pedido);
            else marcarClienteComoSaldado(pedido.cliente);
            return;
        }
        const resultado = parseMontoOPorcentaje(nuevoValor, deudaDeLinea(pedido));
        if (resultado === null) {
            alert("⚠️ Para usar '%' o 'total', el precio de esta fila tiene que ser mayor a 0.");
            elemento.innerText = pedido.pagoMonto ? formatoPesos(pedido.pagoMonto) : '';
            return;
        }
        Store.updatePedido(id, { pagoMonto: resultado });
        return;
    }

    if (campo === 'cliente') {
        if (!nuevoValor || nuevoValor === pedido.cliente) { elemento.innerText = pedido.cliente; return; }
        const nombreAntiguo = pedido.cliente.trim().toLowerCase();
        const mismosCliente = pedidos.filter(p => p.cliente.trim().toLowerCase() === nombreAntiguo);
        Promise.all(mismosCliente.map(p => Store.updatePedido(p.id, { cliente: nuevoValor })))
            .then(() => recomputarPreciosCliente(nuevoValor, []));
        return;
    }

    if (campo === 'modelo' || campo === 'talle') {
        if (pedido[campo] === nuevoValor) return;
        Store.updatePedido(id, { [campo]: nuevoValor }).then(() => {
            if (campo === 'modelo') recomputarPreciosCliente(pedido.cliente, []);
        });
        return;
    }
};

window.alternarPago = function (id) {
    const p = pedidos.find(x => x.id === id); if (!p) return;
    const i = OPCIONES_PAGO.indexOf(p.pago || '');
    const nuevoPago = OPCIONES_PAGO[(i + 1) % OPCIONES_PAGO.length];
    const entraACambio = nuevoPago === 'Cambio' && p.pago !== 'Cambio';
    const saleDeCambio = p.pago === 'Cambio' && nuevoPago !== 'Cambio';

    const cambios = { pago: nuevoPago };
    if (entraACambio) {
        // Un cambio de talle no es una venta: sin precio unitario ni importe,
        // solo el recargo (que ya suma deudaDeLinea sobre el Saldo).
        cambios.precioUnitario = 0;
        cambios.importe = 0;
        cambios.manualPrecio = false;
        cambios.categoria = 'Cambio de talle';
    }
    // Al entrar o salir de "Cambio" la deuda de esta línea cambia de base
    // (pasa a ser solo el recargo, o deja de serlo): un monto pagado que
    // quedó de antes ya no corresponde a la deuda nueva, así que se limpia
    // en vez de arrastrarlo — si no, podía coincidir con la deuda nueva "de
    // casualidad" y la línea aparecía saldada sin que nadie hubiera pagado.
    if (entraACambio || saleDeCambio) {
        cambios.pagoMonto = '';
    }

    Store.updatePedido(id, cambios).then(() => {
        if (saleDeCambio) recomputarPreciosCliente(p.cliente, []); // vuelve a tener precio normal
    });
};

window.alternarEstado = function (id) {
    const p = pedidos.find(x => x.id === id); if (!p) return;
    const i = OPCIONES_ESTADO.indexOf(p.estado || '');
    Store.updatePedido(id, { estado: OPCIONES_ESTADO[(i + 1) % OPCIONES_ESTADO.length] });
};

window.alternarEnvio = function (id) {
    const p = pedidos.find(x => x.id === id); if (!p) return;
    const i = OPCIONES_ENVIO.indexOf(p.envio || '');
    Store.updatePedido(id, { envio: OPCIONES_ENVIO[(i + 1) % OPCIONES_ENVIO.length] });
};

window.resetearPrecioManual = function (id) {
    const p = pedidos.find(x => x.id === id); if (!p) return;
    Store.updatePedido(id, { manualPrecio: false }).then(() => recomputarPreciosCliente(p.cliente, []));
};

window.eliminarPedido = function (id) {
    const p = pedidos.find(x => x.id === id);
    if (!p) return;
    const ok = confirm(`¿Eliminar este pedido?\n\n${p.cliente} — ${p.modelo} (talle ${p.talle})`);
    if (!ok) return;
    Store.deletePedido(id).then(() => recomputarPreciosCliente(p.cliente, []));
};

// ----------------------------------------------------------------------------
// BUSCADOR DE LA LISTA
// ----------------------------------------------------------------------------
document.getElementById('buscador-lista').addEventListener('input', (e) => {
    filtroTexto = e.target.value;
    renderizarTabla();
});

// ----------------------------------------------------------------------------
// BORRAR TODO / DESHACER (compartido: se ve y se puede deshacer desde
// CUALQUIER compu, no solo la que tocó el botón)
// ----------------------------------------------------------------------------
document.getElementById('btn-borrar-todo').addEventListener('click', () => {
    if (pedidos.length === 0) { alert("La lista ya está vacía."); return; }
    const ok = confirm(`⚠️ ¿Estás seguro de que querés ELIMINAR TODOS los pedidos (${pedidos.length})? Tanto vos como tu socio van a poder deshacer esta acción durante unos segundos.`);
    if (!ok) return;

    // Solo la lista principal (Zapatillas) archiva estadísticas.
    if (listaActivaId === PRINCIPAL_LISTA_ID) registrarEstadisticasDeLista(pedidos);
    Store.deleteAllPedidos(pedidos).then(backup => Store.guardarRespaldoBorrado(listaActivaId, backup));
});

// Antes de borrar, se archiva un "cierre de lista": un registro nuevo con
// esa fecha, cuánto se facturó y qué modelos se vendieron. Nunca se pisa ni
// se resume de antemano — cada "Borrar todo" queda con su propio registro
// para siempre, y el resumen del mes (Configuración > Estadísticas) se
// calcula sumando los cierres de ese mes. Es facturación BRUTA ("lo que en
// teoría tendrías si todos pagan"): no distingue cobrado de pendiente, y no
// cuenta los "Cambio" de talle como venta de un modelo.
function registrarEstadisticasDeLista(lista) {
    const confirmados = lista.filter(p => p.estado === '✅');
    if (confirmados.length === 0) return;

    const ahora = new Date();
    const facturacion = confirmados.reduce((s, p) => s + deudaDeLinea(p), 0);
    const paresVendidos = confirmados.filter(p => p.pago !== 'Cambio');
    const cantidadPares = paresVendidos.reduce((s, p) => s + (parseInt(p.cantidad) || 0), 0);
    if (facturacion <= 0 && cantidadPares === 0) return;

    const modelosVendidos = {};
    paresVendidos.forEach(p => {
        const cantidad = parseInt(p.cantidad) || 0;
        const nombreModelo = (p.modelo || '').trim();
        if (cantidad <= 0 || !nombreModelo) return;
        modelosVendidos[nombreModelo] = (modelosVendidos[nombreModelo] || 0) + cantidad;
    });

    Store.registrarCierre({
        mes: idMes(ahora),
        fecha: ahora.toISOString().slice(0, 10),
        facturacion,
        cantidadPedidos: confirmados.length,
        cantidadPares,
        modelosVendidos,
    });
}

// Se llama con el respaldo compartido cada vez que cambia (aparece uno nuevo,
// o se borra al deshacer / vencerse la ventana de tiempo).
function actualizarBotonDeshacer(data) {
    const btn = document.getElementById('btn-deshacer');
    if (!btn) return;
    clearTimeout(timeoutDeshacer);

    const restante = data ? VENTANA_DESHACER_MS - (Date.now() - data.timestamp) : 0;
    if (!data || restante <= 0) {
        respaldoCompartido = null;
        btn.style.display = 'none';
        return;
    }

    respaldoCompartido = data;
    btn.style.display = 'inline-flex';
    timeoutDeshacer = setTimeout(() => { respaldoCompartido = null; btn.style.display = 'none'; }, restante);
}

document.getElementById('btn-deshacer').addEventListener('click', () => {
    if (!respaldoCompartido) return;
    Store.restorePedidos(respaldoCompartido.pedidos).then(() => Store.borrarRespaldoBorrado(listaActivaId));
});

function suscribirRespaldoDeListaActiva() {
    if (unsubRespaldoBorrado) unsubRespaldoBorrado();
    unsubRespaldoBorrado = Store.onRespaldoBorrado(listaActivaId, actualizarBotonDeshacer);
}

// ----------------------------------------------------------------------------
// NAVEGACIÓN ENTRE LISTAS (Zapatillas + las que se creen) Y ESTADÍSTICAS
// ----------------------------------------------------------------------------
function renderizarTabsListas() {
    const cont = document.getElementById('nav-listas-tabs');
    const btnEstadisticas = document.getElementById('btn-tab-estadisticas');
    if (!cont || !btnEstadisticas) return;

    const listas = Object.entries(listasCache).sort((a, b) => {
        if (a[1].esPrincipal) return -1;
        if (b[1].esPrincipal) return 1;
        return (a[1].creadaEn || 0) - (b[1].creadaEn || 0);
    });

    cont.innerHTML = listas.map(([id, l]) => `
        <button type="button" class="nav-lista-tab ${vistaActiva === 'listas' && id === listaActivaId ? 'activo' : ''}" data-lista-id="${id}">
            <span>${l.nombre}</span>
            ${!l.esPrincipal ? `<span class="btn-cerrar-lista" data-eliminar-lista="${id}" title="Eliminar esta lista">✕</span>` : ''}
        </button>
    `).join('');

    cont.querySelectorAll('[data-lista-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (e.target.closest('[data-eliminar-lista]')) return;
            cambiarListaActiva(btn.dataset.listaId);
        });
    });
    cont.querySelectorAll('[data-eliminar-lista]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            eliminarListaConfirmar(el.dataset.eliminarLista);
        });
    });

    btnEstadisticas.classList.toggle('activo', vistaActiva === 'estadisticas');
}

function cambiarListaActiva(id) {
    listaActivaId = id;
    try { localStorage.setItem(CLAVE_LISTA_ACTIVA, id); } catch (e) { /* localStorage bloqueado */ }
    recalcularPedidosActivos();
    suscribirRespaldoDeListaActiva();
    mostrarVistaListas();
}

function eliminarListaConfirmar(id) {
    const lista = listasCache[id];
    if (!lista) return;
    const pedidosDeEsaLista = todosPedidos.filter(p => idListaDe(p) === id);
    const ok = confirm(`⚠️ ¿Eliminar la lista "${lista.nombre}"${pedidosDeEsaLista.length ? ` y su${pedidosDeEsaLista.length === 1 ? '' : 's'} ${pedidosDeEsaLista.length} pedido(s)` : ''}? Esto NO se puede deshacer.`);
    if (!ok) return;
    Store.eliminarLista(id, pedidosDeEsaLista).then(() => {
        if (listaActivaId === id) cambiarListaActiva(PRINCIPAL_LISTA_ID);
    });
}

document.getElementById('btn-nueva-lista').addEventListener('click', () => {
    const nombre = prompt('Nombre de la nueva lista (ej: Indumentaria, G5...):');
    if (!nombre || !nombre.trim()) return;
    Store.crearLista(nombre.trim()).then(id => { if (id) cambiarListaActiva(id); });
});

function mostrarVistaListas() {
    vistaActiva = 'listas';
    document.getElementById('vista-listas').style.display = '';
    document.getElementById('vista-estadisticas').style.display = 'none';
    renderizarTabsListas();
}

function mostrarVistaEstadisticas() {
    vistaActiva = 'estadisticas';
    document.getElementById('vista-listas').style.display = 'none';
    document.getElementById('vista-estadisticas').style.display = '';
    renderizarTabsListas();
    cargarEstadisticasPro();
}

document.getElementById('btn-tab-estadisticas').addEventListener('click', mostrarVistaEstadisticas);

// ----------------------------------------------------------------------------
// RESUMEN / LOGÍSTICA / DEUDORES
// ----------------------------------------------------------------------------
// Deuda total y pagado total, agrupados por CLIENTE (no línea por línea): si
// alguien dejó una seña grande en un solo pedido y en el resto puso "0"
// pensando que ya estaba cubierto, calcularlo línea por línea perdía ese
// excedente en vez de descontarlo del resto de su deuda (por eso "Resumen"
// mostraba el saldo correcto —está agrupado por cliente— pero "Deudores" no).
function calcularDeudaClientes() {
    const porCliente = {};
    pedidos.filter(p => p.estado === '✅').forEach(p => {
        const nombreOriginal = (p.cliente || '').trim();
        if (!nombreOriginal) return;
        const key = nombreOriginal.toLowerCase();
        if (!porCliente[key]) {
            porCliente[key] = { nombre: key.charAt(0).toUpperCase() + key.slice(1), total: 0, pagado: 0 };
        }
        porCliente[key].total += deudaDeLinea(p);
        porCliente[key].pagado += parseFloat(p.pagoMonto) || 0;
    });
    return porCliente;
}

function actualizarResumen() {
    const totalSpan = document.getElementById('total-pedidos');
    const totalFacturadoSpan = document.getElementById('total-facturado');
    const totalCobradoSpan = document.getElementById('total-cobrado');
    const totalPendienteSpan = document.getElementById('total-pendiente');
    const listaClientesUl = document.getElementById('lista-resumen-clientes');
    if (!totalSpan || !listaClientesUl) return;

    const confirmados = pedidos.filter(p => p.estado === '✅');

    // Los pedidos de CAMBIO no cuentan como pares confirmados nuevos.
    const totalPares = confirmados.filter(p => p.pago !== 'Cambio').reduce((s, p) => s + (parseInt(p.cantidad) || 0), 0);
    totalSpan.textContent = totalPares;

    let totalFacturado = 0;
    confirmados.forEach(p => { totalFacturado += deudaDeLinea(p); });

    const deudaClientes = calcularDeudaClientes();
    const totalPendiente = Object.values(deudaClientes).reduce((s, c) => s + Math.max(c.total - c.pagado, 0), 0);
    const totalCobrado = totalFacturado - totalPendiente;

    totalFacturadoSpan.textContent = formatoPesos(totalFacturado);
    totalCobradoSpan.textContent = formatoPesos(totalCobrado);
    totalPendienteSpan.textContent = formatoPesos(totalPendiente);

    const conteoClientes = {};
    confirmados.forEach(p => {
        const nombreOriginal = (p.cliente || '').trim();
        if (!nombreOriginal) return;
        const key = nombreOriginal.toLowerCase();
        if (!conteoClientes[key]) {
            conteoClientes[key] = {
                nombre: key.charAt(0).toUpperCase() + key.slice(1),
                cantidad: 0, total: 0, pagado: 0, detalles: []
            };
        }
        if (p.pago !== 'Cambio') conteoClientes[key].cantidad += (parseInt(p.cantidad) || 0);
        conteoClientes[key].total += deudaDeLinea(p);
        conteoClientes[key].pagado += parseFloat(p.pagoMonto) || 0;
        conteoClientes[key].detalles.push({ modelo: p.modelo, talle: p.talle, cantidad: p.cantidad, importe: deudaDeLinea(p), esCambio: p.pago === 'Cambio' });
    });

    const clientesArray = Object.values(conteoClientes).sort((a, b) => a.nombre.localeCompare(b.nombre));

    if (clientesArray.length === 0) {
        listaClientesUl.innerHTML = '<li class="vacio">No hay pedidos confirmados aún.</li>';
    } else {
        listaClientesUl.innerHTML = clientesArray.map((c, index) => {
            const debe = c.total - c.pagado;
            return `
            <li>
                <div class="cliente-header" onclick="toggleDetalles('detalles-${index}')">
                    <span>${c.nombre} <span class="hint-click">(click)</span></span>
                    <span class="badge-cantidad">×${c.cantidad}</span>
                </div>
                <ul id="detalles-${index}" class="cliente-detalles">
                    ${c.detalles.map(d => `
                        <li>
                            <span>${d.esCambio ? '🔁 ' : ''}👟 ${d.modelo} ${d.cantidad > 1 ? '×' + d.cantidad : ''}</span>
                            <span class="detalle-talle">Talle ${d.talle}${d.importe ? ' · ' + formatoPesos(d.importe) : ''}</span>
                        </li>
                    `).join('')}
                    ${c.total > 0 ? `
                        <li style="border-top:1px solid var(--border);margin-top:4px;padding-top:8px;">
                            <span><strong>Total</strong></span><span class="detalle-talle" style="color:var(--text);">${formatoPesos(c.total)}</span>
                        </li>
                        ${c.pagado > 0 ? `<li><span>Pagó</span><span class="detalle-talle">${formatoPesos(c.pagado)}</span></li>` : ''}
                        <li>
                            <span><strong>${debe > 0 ? 'Debe' : 'Saldado'}</strong></span>
                            <span class="detalle-talle" style="color:${debe > 0 ? 'var(--danger)' : 'var(--success)'};">${debe > 0 ? formatoPesos(debe) : '✅'}</span>
                        </li>
                    ` : ''}
                </ul>
            </li>`;
        }).join('');
    }

    aplicarColapsoResumen();
}

function actualizarEnvios() {
    const ul = document.getElementById('lista-envios-clientes');
    if (!ul) return;

    const agrupados = { Via: [], Moto: [], Retiro: [] };
    pedidos.filter(p => agrupados[p.envio]).forEach(p => {
        const nombre = (p.cliente || '').trim();
        if (!nombre) return;
        const nombreStr = nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase();
        if (!agrupados[p.envio].includes(nombreStr)) agrupados[p.envio].push(nombreStr);
    });
    Object.values(agrupados).forEach(arr => arr.sort());

    let html = '';
    if (agrupados.Via.length) { html += `<li class="envio-categoria">📦 Via Cargo</li>`; agrupados.Via.forEach(n => html += `<li class="envio-item">${n}</li>`); }
    if (agrupados.Moto.length) { html += `<li class="envio-categoria">🏍️ Moto Mensajería</li>`; agrupados.Moto.forEach(n => html += `<li class="envio-item">${n}</li>`); }
    if (agrupados.Retiro.length) { html += `<li class="envio-categoria">🏬 Retiro en el Local</li>`; agrupados.Retiro.forEach(n => html += `<li class="envio-item">${n}</li>`); }

    ul.innerHTML = html || '<li class="vacio">Sin envíos programados.</li>';
}

// Clientes que pidieron Via Cargo o Moto pero todavía no tienen ninguna
// dirección cargada, o no, en ninguna de sus líneas. SIEMPRE editable acá
// (no solo mientras falta cargarla): si se pegó mal o hay un error de tipeo,
// tiene que poder corregirse en cualquier momento, no solo la primera vez.
function escaparHtml(texto) {
    return (texto || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function actualizarDireccionesPendientes() {
    const ul = document.getElementById('lista-direcciones-pendientes');
    if (!ul) return;

    const porCliente = {}; // key -> { nombre, direccion }
    pedidos.forEach(p => {
        if (p.envio !== 'Via' && p.envio !== 'Moto') return;
        const nombre = (p.cliente || '').trim();
        if (!nombre) return;
        const key = nombre.toLowerCase();
        if (!porCliente[key]) {
            porCliente[key] = { nombre: nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase(), direccion: '' };
        }
        const direccionDeEstaLinea = (p.direccion || '').trim();
        if (direccionDeEstaLinea && !porCliente[key].direccion) porCliente[key].direccion = direccionDeEstaLinea;
    });

    const clientes = Object.values(porCliente).sort((a, b) => a.nombre.localeCompare(b.nombre));

    // Vista compacta por defecto (nombre + primera línea a modo de resumen +
    // ✏️); el cuadro de texto para escribir solo aparece al tocar el lápiz,
    // en vez de tener todos los cuadros abiertos siempre.
    ul.innerHTML = clientes.length === 0
        ? '<li class="vacio">No hay clientes con envío Via/Moto cargados todavía.</li>'
        : clientes.map(c => {
            const sinCargar = !c.direccion;
            const primeraLinea = c.direccion.split('\n')[0];
            const tieneMasLineas = c.direccion.includes('\n');
            const clienteAttr = escaparHtml(c.nombre).replace(/"/g, '&quot;');
            return `
            <li class="direccion-pendiente-item ${sinCargar ? 'sin-cargar' : ''}">
                <div class="direccion-pendiente-fila">
                    <span class="direccion-pendiente-nombre">${sinCargar ? '⚠️ ' : ''}${escaparHtml(c.nombre)}</span>
                    <span class="direccion-pendiente-resumen">${sinCargar ? 'Sin cargar' : escaparHtml(primeraLinea) + (tieneMasLineas ? '…' : '')}</span>
                    <button type="button" class="btn-editar-direccion" title="${sinCargar ? 'Cargar dirección' : 'Editar dirección'}">✏️</button>
                </div>
                <textarea class="input-direccion-pendiente" rows="4" style="display:none;" placeholder="Nombre completo, DNI, código postal, teléfono, email, dirección, referencia..." data-cliente="${clienteAttr}">${escaparHtml(c.direccion)}</textarea>
            </li>`;
        }).join('');

    ul.querySelectorAll('.btn-editar-direccion').forEach(btn => {
        btn.addEventListener('click', () => {
            const li = btn.closest('.direccion-pendiente-item');
            li.querySelector('.direccion-pendiente-fila').style.display = 'none';
            const textarea = li.querySelector('.input-direccion-pendiente');
            textarea.style.display = '';
            textarea.focus();
        });
    });

    // Se guarda solo (sin botón aparte) al salir del campo, y vuelve a la
    // vista compacta al toque (no espera a que llegue la confirmación de
    // Firestore) — es multilínea, así que Enter tiene que poder saltar de
    // línea en vez de guardar/cerrar.
    ul.querySelectorAll('.input-direccion-pendiente').forEach(textarea => {
        textarea.addEventListener('blur', () => {
            const li = textarea.closest('.direccion-pendiente-item');
            textarea.style.display = 'none';
            li.querySelector('.direccion-pendiente-fila').style.display = '';
            guardarDireccionPendiente(textarea.dataset.cliente, textarea.value);
        });
    });
}

// Guarda (o corrige) la dirección en TODAS las líneas de ese cliente con
// envío Via/Moto — pisa lo que hubiera antes, para poder arreglar un
// copiado/pegado que salió mal.
function guardarDireccionPendiente(nombreCliente, direccionCruda) {
    const direccion = (direccionCruda || '').trim();
    const key = (nombreCliente || '').trim().toLowerCase();
    const pedidosDelCliente = pedidos.filter(p =>
        (p.cliente || '').trim().toLowerCase() === key &&
        (p.envio === 'Via' || p.envio === 'Moto')
    );
    Promise.all(
        pedidosDelCliente
            .filter(p => (p.direccion || '') !== direccion)
            .map(p => Store.updatePedido(p.id, { direccion }))
    );
}

// Junta, por cliente, la dirección cargada en cualquiera de sus líneas (para
// armar el mensaje que se copia y se le manda al socio).
function direccionesPorCliente() {
    const porCliente = {};
    pedidos.forEach(p => {
        if (p.envio !== 'Via' && p.envio !== 'Moto') return;
        const direccion = (p.direccion || '').trim();
        if (!direccion) return;
        const nombre = (p.cliente || '').trim();
        if (!nombre) return;
        const key = nombre.toLowerCase();
        if (!porCliente[key]) {
            porCliente[key] = { nombre: nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase(), direccion };
        }
    });
    return Object.values(porCliente).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

function actualizarDeudores() {
    const ul = document.getElementById('lista-deudores');
    if (!ul) return;

    const deudaClientes = calcularDeudaClientes();
    const deudores = Object.values(deudaClientes)
        .map(c => ({ nombre: c.nombre, monto: Math.max(c.total - c.pagado, 0) }))
        .filter(d => d.monto > 0)
        .sort((a, b) => b.monto - a.monto);

    ul.innerHTML = deudores.length === 0
        ? '<li class="vacio">Nadie debe nada 🎉</li>'
        : deudores.map(d => `<li class="deudor-item"><span>${d.nombre}</span><span class="deudor-monto">${formatoPesos(d.monto)}</span></li>`).join('');
}

// ----------------------------------------------------------------------------
// COLAPSAR EL DETALLE POR CLIENTE DEL RESUMEN (preferencia de este navegador,
// no se sincroniza: es solo para scrollear más rápido, no hace falta que se
// vea igual en las dos computadoras).
// ----------------------------------------------------------------------------
const CLAVE_RESUMEN_COLAPSADO = 'ap_resumen_colapsado';

function resumenEstaColapsado() {
    try { return localStorage.getItem(CLAVE_RESUMEN_COLAPSADO) === '1'; } catch (e) { return false; }
}

function aplicarColapsoResumen() {
    const ul = document.getElementById('lista-resumen-clientes');
    const btn = document.getElementById('btn-toggle-resumen');
    if (!ul || !btn) return;
    const colapsado = resumenEstaColapsado();
    ul.style.display = colapsado ? 'none' : '';
    btn.textContent = colapsado ? '▼ Mostrar detalle' : '▲ Ocultar detalle';
}

document.getElementById('btn-toggle-resumen').addEventListener('click', () => {
    try { localStorage.setItem(CLAVE_RESUMEN_COLAPSADO, resumenEstaColapsado() ? '0' : '1'); } catch (e) { /* localStorage bloqueado */ }
    aplicarColapsoResumen();
});

// ----------------------------------------------------------------------------
// COPIAR DIRECCIONES (para pasarle al socio todas las direcciones de una)
// ----------------------------------------------------------------------------
document.getElementById('btn-copiar-direcciones').addEventListener('click', async () => {
    const clientes = direccionesPorCliente();
    if (clientes.length === 0) {
        alert('Todavía no hay ninguna dirección cargada.');
        return;
    }
    const mensaje = clientes.map(c => `${c.nombre.toUpperCase()}:\n${c.direccion}`).join('\n\n');
    try {
        await navigator.clipboard.writeText(mensaje);
        alert('📋 Direcciones copiadas. Ya podés pegarlas donde quieras.');
    } catch (e) {
        alert('No se pudo copiar automáticamente. Estas son las direcciones:\n\n' + mensaje);
    }
});

window.toggleDetalles = function (id) {
    const el = document.getElementById(id);
    el.style.display = (el.style.display === 'block') ? 'none' : 'block';
};

// ----------------------------------------------------------------------------
// BADGES DE LA TABLA
// ----------------------------------------------------------------------------
// Iconos compactos: no hace falta leer una palabra para saber el estado de un
// vistazo, y así la columna no gasta espacio horizontal de más.
function badgeEstado(v) {
    if (v === '✅') return `<span class="icono-estado ok" title="Confirmado">✔</span>`;
    if (v === '❌') return `<span class="icono-estado no" title="No confirmado">✕</span>`;
    return `<span class="icono-estado vacio" title="Sin definir">—</span>`;
}
function badgeEnvio(v) {
    if (v === 'Via') return `<span class="icono-envio" title="Via Cargo">Via</span>`;
    if (v === 'Moto') return `<span class="icono-envio" title="Moto">Moto</span>`;
    if (v === 'Retiro') return `<span class="icono-envio" title="Retiro">Retira</span>`;
    return `<span class="icono-envio" title="Sin definir" style="opacity:.35;">—</span>`;
}
function badgePago(v) {
    if (v === 'Cambio') return `<span class="badge badge-warning">🔁 Cambio</span>`;
    if (v) return `<span class="badge badge-info">${v}</span>`;
    return `<span class="badge badge-neutro">—</span>`;
}

// ----------------------------------------------------------------------------
// RENDER DE LA TABLA
// ----------------------------------------------------------------------------
// Del grupo de revendedores (mayorista) o no — se usa para separar la tabla
// en dos bloques y no mezclar visualmente los dos tipos de cliente.
function esClienteGrupo(nombreCliente) {
    const id = Store.normalizarIdCliente(nombreCliente || '');
    const c = clientesCache[id];
    return !!(c && c.esGrupo);
}

function renderizarTabla() {
    listaBody.innerHTML = '';

    let copia = [...pedidos].sort((a, b) => {
        const ga = esClienteGrupo(a.cliente) ? 0 : 1;
        const gb = esClienteGrupo(b.cliente) ? 0 : 1;
        if (ga !== gb) return ga - gb;
        const ca = (a.cliente || '').toLowerCase(), cb = (b.cliente || '').toLowerCase();
        if (ca < cb) return -1; if (ca > cb) return 1;
        const ma = (a.modelo || '').toLowerCase(), mb = (b.modelo || '').toLowerCase();
        if (ma < mb) return -1; if (ma > mb) return 1;
        return extraerNumeroTalle(a.talle) - extraerNumeroTalle(b.talle);
    });

    // El buscador solo filtra lo que se VE en la tabla; el Resumen, la
    // Logística y los Deudores siguen mostrando todos los pedidos.
    const filtro = normalizarTexto(filtroTexto).trim();
    if (filtro) {
        copia = copia.filter(p => normalizarTexto(p.cliente).includes(filtro) || normalizarTexto(p.modelo).includes(filtro));
    }

    if (filtro && copia.length === 0) {
        listaBody.innerHTML = `<tr><td colspan="12" class="vacio-fila">No se encontraron pedidos para "${filtroTexto}".</td></tr>`;
    }

    copia.forEach((pedido, indice) => {
        const esGrupoActual = esClienteGrupo(pedido.cliente);
        if (indice === 0 || esGrupoActual !== esClienteGrupo(copia[indice - 1].cliente)) {
            const filaSeparador = document.createElement('tr');
            filaSeparador.className = 'fila-separador-grupo-tr';
            filaSeparador.innerHTML = `<td colspan="12" class="fila-separador-grupo">${esGrupoActual ? '👥 Grupo / revendedores (mayorista)' : '🛍️ Clientes comunes (minorista)'}</td>`;
            listaBody.appendChild(filaSeparador);
        }

        const fila = document.createElement('tr');

        const deuda = deudaDeLinea(pedido);
        const pagado = parseFloat(pedido.pagoMonto) || 0;
        const saldo = deuda - pagado;
        const hayDeuda = deuda > 0;
        const hayPago = pedido.pagoMonto !== '' && pedido.pagoMonto !== undefined;
        // El recargo de un cambio de talle es un monto fijo y conocido: se
        // muestra en Saldo apenas se marca "Cambio", sin esperar a que se
        // cargue algo en Pago (a diferencia de una venta normal).
        const mostrarCalculo = hayDeuda && (hayPago || pedido.pago === 'Cambio');

        fila.innerHTML = `
            <td contenteditable="true" class="celda-editable" onblur="guardarEdicion('${pedido.id}', 'cliente', this)">${pedido.cliente}</td>
            <td contenteditable="true" class="celda-editable" onblur="guardarEdicion('${pedido.id}', 'modelo', this)" title="${pedido.categoria || ''}">${pedido.modelo}</td>
            <td contenteditable="true" class="celda-editable" onblur="guardarEdicion('${pedido.id}', 'talle', this)">${pedido.talle}</td>
            <td contenteditable="true" class="celda-editable celda-centro" onblur="guardarEdicion('${pedido.id}', 'cantidad', this)">${pedido.cantidad || 1}</td>
            <td><span class="texto-clickable" onclick="alternarPago('${pedido.id}')">${badgePago(pedido.pago)}</span></td>
            <td class="columna-icono"><span class="texto-clickable" onclick="alternarEstado('${pedido.id}')">${badgeEstado(pedido.estado)}</span></td>
            <td class="columna-icono"><span class="texto-clickable" onclick="alternarEnvio('${pedido.id}')">${badgeEnvio(pedido.envio)}</span></td>
            <td class="columna-privada">
                <span contenteditable="true" class="celda-editable" onblur="guardarEdicion('${pedido.id}', 'precioUnitario', this)">${pedido.precioUnitario ? formatoPesos(pedido.precioUnitario) : ''}</span>
                ${pedido.manualPrecio ? `<button class="btn-mini" title="Volver a precio automático" onclick="resetearPrecioManual('${pedido.id}')">🔄</button>` : ''}
            </td>
            <td class="columna-privada">${pedido.importe ? formatoPesos(pedido.importe) : ''}</td>
            <td contenteditable="true" class="celda-editable columna-privada" onblur="guardarEdicion('${pedido.id}', 'pagoMonto', this)">${pagado > 0 ? formatoPesos(pagado) : (hayPago ? '$0' : '')}</td>
            <td class="celda-saldo columna-privada ${mostrarCalculo ? (saldo > 0 ? 'saldo-pendiente' : 'saldo-saldado') : ''}">${mostrarCalculo ? (saldo > 0 ? formatoPesos(saldo) : '✅ Saldado') : '—'}</td>
            <td class="columna-accion"><button onclick="eliminarPedido('${pedido.id}')" class="btn-eliminar">✕</button></td>
        `;
        listaBody.appendChild(fila);
    });

    actualizarResumen();
    actualizarEnvios();
    actualizarDireccionesPendientes();
    actualizarDeudores();
}

// ----------------------------------------------------------------------------
// MODO OSCURO (preferencia local del navegador, no se sincroniza)
// ----------------------------------------------------------------------------
const CLAVE_TEMA = 'ap_theme';

function aplicarTema(tema) {
    document.body.setAttribute('data-theme', tema);
    const btn = document.getElementById('btn-tema');
    if (!btn) return;
    btn.textContent = tema === 'dark' ? '☀️' : '🌙';
    btn.title = tema === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
}

(function inicializarTema() {
    let tema = 'light';
    try { tema = localStorage.getItem(CLAVE_TEMA) || 'light'; } catch (e) { /* localStorage bloqueado */ }
    aplicarTema(tema);
})();

document.getElementById('btn-tema').addEventListener('click', () => {
    const actual = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const nuevo = actual === 'dark' ? 'light' : 'dark';
    aplicarTema(nuevo);
    try { localStorage.setItem(CLAVE_TEMA, nuevo); } catch (e) { /* localStorage bloqueado */ }
});

// ----------------------------------------------------------------------------
// EXPORTAR IMAGEN / EXCEL
// ----------------------------------------------------------------------------
document.getElementById('btn-imagen').addEventListener('click', () => {
    if (pedidos.length === 0) return alert("No hay pedidos para descargar.");
    document.activeElement.blur();

    // La foto para el depósito sale siempre blanca, aunque estés en modo oscuro.
    const eraOscuro = document.body.getAttribute('data-theme') === 'dark';
    if (eraOscuro) document.body.setAttribute('data-theme', 'light');

    const tabla = document.getElementById('tabla-pedidos');
    // Las filas separadoras de grupo/minorista tienen una sola celda (colspan
    // completo): si se las trata igual que al resto, "ocultar la última
    // columna" les ocultaría su único contenido y desaparecerían de la foto.
    const filas = Array.from(tabla.querySelectorAll('tr')).filter(f => !f.classList.contains('fila-separador-grupo-tr'));
    filas.forEach(fila => { if (fila.lastElementChild) fila.lastElementChild.style.display = 'none'; });

    const columnasPrivadas = tabla.querySelectorAll('.columna-privada');
    columnasPrivadas.forEach(col => col.style.display = 'none');

    // El encabezado queda "pegado" arriba (position: sticky) mientras
    // scrolleás en pantalla, pero html2canvas no soporta bien "sticky": en
    // listas largas la foto salía con el encabezado mal ubicado o repetido.
    // Se lo pasa a estático solo mientras se hace la captura.
    const encabezados = tabla.querySelectorAll('thead th');
    encabezados.forEach(th => th.style.position = 'static');

    // La foto la termina viendo alguien desde el celular: letra y relleno
    // más grandes (clase aparte, no toca cómo se ve en pantalla) para que se
    // lea sin hacer zoom, y sin el recorte con scroll propio de Cliente y
    // Modelo (eso es para no romper el tamaño de fila en pantalla; en una
    // foto fija no hace falta "scrollear" una celda, se pierde información).
    tabla.classList.add('tabla-modo-foto');

    // Toda foto (por más resolución que tenga) se empieza a ver borrosa si
    // se hace zoom más allá de su nitidez real — no hay forma de evitarlo
    // del todo, pero cuantos más píxeles tenga la imagen, más zoom aguanta
    // antes de notarse. Se usa la escala más alta posible sin pasarse del
    // límite de tamaño de canvas que soportan los navegadores (si la lista
    // es muy larga, se baja la escala lo justo para no romper la foto).
    const alturaTablaCss = tabla.getBoundingClientRect().height;
    const alturaMaximaSegura = 14000;
    const escala = Math.max(2, Math.min(4, alturaMaximaSegura / alturaTablaCss));

    // Dos frames de margen para que el navegador termine de repintar en claro
    // antes de capturar (si no, a veces se cuela un frame a mitad de camino).
    requestAnimationFrame(() => requestAnimationFrame(() => {
        html2canvas(tabla, { backgroundColor: '#ffffff', scale: escala }).then(canvas => {
            filas.forEach(fila => { if (fila.lastElementChild) fila.lastElementChild.style.display = ''; });
            columnasPrivadas.forEach(col => col.style.display = '');
            encabezados.forEach(th => th.style.position = '');
            tabla.classList.remove('tabla-modo-foto');
            if (eraOscuro) document.body.setAttribute('data-theme', 'dark');

            const enlace = document.createElement('a');
            enlace.download = 'Pedidos_Para_Deposito.png';
            enlace.href = canvas.toDataURL('image/png');
            enlace.click();
        });
    }));
});

document.getElementById('btn-excel').addEventListener('click', async () => {
    if (pedidos.length === 0) return alert("No hay pedidos para exportar.");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Pedidos');

    sheet.mergeCells('A1:J1');
    const titulo = sheet.getCell('A1');
    titulo.value = 'CONTROL DE PEDIDOS - ZAPATILLAS';
    titulo.font = { bold: true, size: 12 };
    titulo.alignment = { vertical: 'middle', horizontal: 'center' };

    const encabezados = sheet.getRow(3);
    encabezados.values = ['Cliente', 'Modelo', 'Talle', 'Cant.', 'Precio unit.', 'Importe', 'Pago', 'Saldo', 'Forma de Pago', 'Estado', 'Envío'];
    encabezados.eachCell(celda => {
        celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
        celda.font = { color: { argb: 'FFFFFFFF' }, bold: true };
        celda.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        celda.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    [17, 20, 8, 7, 12, 12, 12, 12, 18, 12, 10].forEach((w, i) => sheet.getColumn(i + 1).width = w);

    let totalDeuda = 0, totalPagado = 0;
    pedidos.forEach((p, index) => {
        const deuda = deudaDeLinea(p);
        const pagado = parseFloat(p.pagoMonto) || 0;
        totalDeuda += deuda; totalPagado += pagado;

        const fila = sheet.getRow(4 + index);
        fila.values = [
            p.cliente, p.modelo, p.talle, p.cantidad || 1,
            p.importe ? (parseFloat(p.precioUnitario) || 0) : "",
            p.importe || "",
            pagado || "",
            deuda ? Math.max(deuda - pagado, 0) : "",
            p.pago || "",
            p.estado === '✅' ? 'Sí' : (p.estado === '❌' ? 'No' : ''),
            p.envio || ""
        ];
        fila.eachCell(celda => {
            celda.alignment = { vertical: 'middle', horizontal: 'center' };
            celda.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
    });

    const filaTotales = sheet.getRow(4 + pedidos.length);
    filaTotales.values = ['', '', '', '', 'TOTALES', '', totalPagado, totalDeuda - totalPagado, '', '', ''];
    filaTotales.font = { bold: true };
    filaTotales.eachCell(celda => {
        celda.alignment = { vertical: 'middle', horizontal: 'center' };
        celda.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = "Control_Pedidos_Zapatillas.xlsx";
    enlace.click();
});

// ----------------------------------------------------------------------------
// PANEL DE CONFIGURACIÓN (precios y clientes)
// ----------------------------------------------------------------------------
const modalConfig = document.getElementById('modal-config');

document.getElementById('btn-config').addEventListener('click', () => {
    configDraft = JSON.parse(JSON.stringify(precioConfig));
    modalConfigAbierto = true;
    renderizarConfigUI();
    modalConfig.style.display = 'flex';
});
document.getElementById('btn-cerrar-config').addEventListener('click', () => {
    modalConfig.style.display = 'none';
    modalConfigAbierto = false;
});
modalConfig.addEventListener('click', (e) => { if (e.target === modalConfig) { modalConfig.style.display = 'none'; modalConfigAbierto = false; } });

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('activo'));
        document.querySelectorAll('.tab-contenido').forEach(c => c.classList.remove('activo'));
        btn.classList.add('activo');
        document.getElementById(btn.dataset.tab).classList.add('activo');
    });
});

function renderizarConfigUI() {
    if (!configDraft) return;
    renderizarListaCategorias();
    document.getElementById('input-recargo-cambio').value = configDraft.recargoCambio;
    document.getElementById('input-default-minorista-unidad').value = configDraft.defaultPrecios.minoristaUnidad;
    document.getElementById('input-default-minorista-mayor').value = configDraft.defaultPrecios.minoristaMayor;
    document.getElementById('input-default-mayorista-unidad').value = configDraft.defaultPrecios.mayoristaUnidad;
    document.getElementById('input-default-mayorista-mayor').value = configDraft.defaultPrecios.mayoristaMayor;
    renderizarListaClientesConfig();
}

// ---- CATEGORÍAS (una sola lista, con los 4 precios juntos por categoría) --
function renderizarListaCategorias() {
    const cont = document.getElementById('lista-categorias');
    if (!cont) return;
    cont.innerHTML = '';
    configDraft.categorias.forEach((cat, indice) => {
        cont.appendChild(crearFilaCategoria(cat, indice));
    });
}

document.getElementById('btn-agregar-categoria').addEventListener('click', () => {
    configDraft.categorias.push(crearCategoria('Nueva categoría', [], 'zapatilla', {}));
    renderizarListaCategorias();
});

function crearFilaCategoria(cat, indice) {
    const fila = document.createElement('div');
    fila.className = 'categoria-fila';

    // ---- fila de arriba: nombre, palabras clave, tipo, eliminar ----------
    const filaSup = document.createElement('div');
    filaSup.className = 'categoria-fila-sup';

    const inputEtiqueta = document.createElement('input');
    inputEtiqueta.type = 'text';
    inputEtiqueta.className = 'categoria-etiqueta';
    inputEtiqueta.value = cat.etiqueta;
    inputEtiqueta.placeholder = 'Nombre de la categoría';
    inputEtiqueta.addEventListener('input', () => cat.etiqueta = inputEtiqueta.value);

    const inputKeywords = document.createElement('input');
    inputKeywords.type = 'text';
    inputKeywords.className = 'categoria-keywords';
    inputKeywords.value = cat.keywords.join(', ');
    inputKeywords.placeholder = 'palabras clave separadas por coma (ej: jordan 11, retro 11)';
    inputKeywords.addEventListener('input', () => {
        cat.keywords = inputKeywords.value.split(',').map(k => normalizarTexto(k).trim()).filter(Boolean);
    });

    const selectTipo = document.createElement('select');
    selectTipo.className = 'categoria-tipo';
    [['zapatilla', '👟 Par de zapatillas'], ['ropa', '👕 Ropa (precio fijo)']].forEach(([valor, texto]) => {
        const op = document.createElement('option');
        op.value = valor; op.textContent = texto;
        if (cat.tipo === valor) op.selected = true;
        selectTipo.appendChild(op);
    });

    const btnEliminar = document.createElement('button');
    btnEliminar.type = 'button'; btnEliminar.className = 'btn-mini'; btnEliminar.textContent = '🗑️'; btnEliminar.title = 'Eliminar categoría';
    btnEliminar.addEventListener('click', () => {
        if (!confirm(`¿Eliminar la categoría "${cat.etiqueta}"?`)) return;
        configDraft.categorias.splice(indice, 1);
        renderizarListaCategorias();
    });

    filaSup.append(inputEtiqueta, inputKeywords, selectTipo, btnEliminar);

    // ---- precios: 4 campos (zapatilla) o 2 (ropa, sin importar cantidad) -
    const filaPrecios = document.createElement('div');
    filaPrecios.className = 'categoria-precios';
    pintarPreciosCategoria(filaPrecios, cat);
    selectTipo.addEventListener('change', () => {
        cat.tipo = selectTipo.value;
        pintarPreciosCategoria(filaPrecios, cat);
    });

    // ---- avanzado: descuento por volumen + prioridad (casi no se usa) ----
    const filaAvanzada = crearFilaAvanzada(cat);

    fila.append(filaSup, filaPrecios, filaAvanzada);
    return fila;
}

function pintarPreciosCategoria(contenedor, cat) {
    contenedor.innerHTML = '';
    function campoPrecio(etiqueta, clave) {
        const label = document.createElement('label');
        label.className = 'precio-mini';
        const span = document.createElement('span');
        span.textContent = etiqueta;
        const input = document.createElement('input');
        input.type = 'number'; input.min = '0'; input.step = '500';
        input.value = cat.precios[clave] || 0;
        input.addEventListener('input', () => cat.precios[clave] = parseFloat(input.value) || 0);
        label.append(span, input);
        return label;
    }
    if (cat.tipo === 'ropa') {
        contenedor.append(
            campoPrecio('Minorista', 'minoristaUnidad'),
            campoPrecio('Mayorista', 'mayoristaUnidad'),
        );
    } else {
        contenedor.append(
            campoPrecio('Minorista · menos de 5', 'minoristaUnidad'),
            campoPrecio('Minorista · 5 o más', 'minoristaMayor'),
            campoPrecio('Mayorista · menos de 5', 'mayoristaUnidad'),
            campoPrecio('Mayorista · 5 o más', 'mayoristaMayor'),
        );
    }
}

function crearFilaAvanzada(cat) {
    const fila = document.createElement('div');
    fila.className = 'categoria-avanzado';

    const checkVol = document.createElement('input');
    checkVol.type = 'checkbox';
    checkVol.checked = !!cat.volumen;

    const inputVolCant = document.createElement('input');
    inputVolCant.type = 'number'; inputVolCant.min = '2'; inputVolCant.step = '1';
    inputVolCant.placeholder = 'cant. mín.';
    inputVolCant.value = cat.volumen ? cat.volumen.cantidadMinima : '';
    inputVolCant.style.display = cat.volumen ? 'inline-block' : 'none';

    const inputVolPrecio = document.createElement('input');
    inputVolPrecio.type = 'number'; inputVolPrecio.min = '0'; inputVolPrecio.step = '500';
    inputVolPrecio.placeholder = 'precio con desc.';
    inputVolPrecio.value = cat.volumen ? cat.volumen.precio : '';
    inputVolPrecio.style.display = cat.volumen ? 'inline-block' : 'none';

    function sincronizarVolumen() {
        cat.volumen = checkVol.checked
            ? { cantidadMinima: parseInt(inputVolCant.value) || 10, precio: parseFloat(inputVolPrecio.value) || 0 }
            : null;
    }
    checkVol.addEventListener('change', () => {
        inputVolCant.style.display = checkVol.checked ? 'inline-block' : 'none';
        inputVolPrecio.style.display = checkVol.checked ? 'inline-block' : 'none';
        sincronizarVolumen();
    });
    inputVolCant.addEventListener('input', sincronizarVolumen);
    inputVolPrecio.addEventListener('input', sincronizarVolumen);

    const labelVol = document.createElement('label');
    labelVol.className = 'regla-vol';
    labelVol.title = 'Ej: 10 remeras del mismo color bajan de precio';
    labelVol.append(checkVol, ' si lleva 10+ del mismo modelo/color, baja a: ', inputVolCant, inputVolPrecio);

    const checkPrio = document.createElement('input');
    checkPrio.type = 'checkbox';
    checkPrio.checked = !!cat.prioritaria;
    checkPrio.addEventListener('change', () => cat.prioritaria = checkPrio.checked);

    const labelPrio = document.createElement('label');
    labelPrio.className = 'categoria-prioridad';
    labelPrio.title = 'Muy pocas categorías necesitan esto. Ej: "niño/niña" tiene que ganarle siempre al tipo de calzado (una "botita de niño" es precio de niño, no de botitas), sin importar qué palabra sea más larga.';
    labelPrio.append(checkPrio, ' tiene prioridad sobre las demás');

    fila.append(labelVol, labelPrio);
    return fila;
}

document.getElementById('btn-guardar-categorias').addEventListener('click', () => {
    precioConfig.categorias = configDraft.categorias;
    Store.setConfig(precioConfig).then(() => {
        recomputarTodosLosClientes();
        const btn = document.getElementById('btn-guardar-categorias');
        btn.textContent = '✅ Guardado';
        setTimeout(() => btn.textContent = '💾 Guardar cambios', 1500);
    });
});

document.getElementById('btn-guardar-general').addEventListener('click', () => {
    const nuevoRecargo = parseFloat(document.getElementById('input-recargo-cambio').value) || 0;
    const nuevoDefault = {
        minoristaUnidad: parseFloat(document.getElementById('input-default-minorista-unidad').value) || 0,
        minoristaMayor: parseFloat(document.getElementById('input-default-minorista-mayor').value) || 0,
        mayoristaUnidad: parseFloat(document.getElementById('input-default-mayorista-unidad').value) || 0,
        mayoristaMayor: parseFloat(document.getElementById('input-default-mayorista-mayor').value) || 0,
    };
    precioConfig.recargoCambio = nuevoRecargo;
    precioConfig.defaultPrecios = nuevoDefault;
    configDraft.recargoCambio = nuevoRecargo;
    configDraft.defaultPrecios = nuevoDefault;
    Store.setConfig(precioConfig).then(() => {
        renderizarTabla();
        recomputarTodosLosClientes();
    });
});

document.getElementById('btn-restablecer-precios').addEventListener('click', () => {
    if (!confirm('Esto reemplaza TODAS las categorías y precios actuales por los valores por defecto. ¿Continuar?')) return;
    precioConfig = configPreciosPorDefecto();
    configDraft = JSON.parse(JSON.stringify(precioConfig));
    Store.setConfig(precioConfig).then(() => {
        renderizarConfigUI();
        recomputarTodosLosClientes();
    });
});

// Esta lista es directamente "tus revendedores": solo se guardan acá los
// clientes tildados como grupo (ver guardarClienteSiHaceFalta). Se puede
// editar el nombre o sacarlos de la lista.
function renderizarListaClientesConfig() {
    const cont = document.getElementById('lista-clientes-config');
    if (!cont) return;

    const clientes = Object.entries(clientesCache).sort((a, b) => a[1].nombre.localeCompare(b[1].nombre));
    cont.innerHTML = clientes.length === 0 ? '<p class="ayuda">Todavía no hay clientes del grupo cargados.</p>' : '';

    clientes.forEach(([id, c]) => {
        const fila = document.createElement('div');
        fila.className = 'cliente-config-fila';

        const inputNombre = document.createElement('input');
        inputNombre.type = 'text';
        inputNombre.className = 'nombre-cliente';
        inputNombre.value = c.nombre;
        inputNombre.addEventListener('change', () => {
            const nuevoNombre = inputNombre.value.trim();
            if (!nuevoNombre || nuevoNombre === c.nombre) { inputNombre.value = c.nombre; return; }
            const nuevoId = Store.normalizarIdCliente(nuevoNombre);
            if (nuevoId !== id) {
                Store.eliminarCliente(id);
                delete clientesCache[id];
            }
            Store.setCliente(nuevoNombre, { nombre: nuevoNombre, esGrupo: true });
            clientesCache[nuevoId] = { nombre: nuevoNombre, esGrupo: true };
            renderizarListaClientesConfig();
        });

        const btnEliminar = document.createElement('button');
        btnEliminar.type = 'button';
        btnEliminar.className = 'btn-mini';
        btnEliminar.textContent = '🗑️';
        btnEliminar.title = 'Sacar de la lista de revendedores';
        btnEliminar.addEventListener('click', () => {
            if (!confirm(`¿Sacar a "${c.nombre}" de la lista de revendedores? Sus próximos pedidos van a usar precio minorista hasta que lo vuelvas a tildar como grupo.`)) return;
            Store.eliminarCliente(id);
            delete clientesCache[id];
            renderizarListaClientesConfig();
        });

        fila.append(inputNombre, btnEliminar);
        cont.appendChild(fila);
    });

    const filaNueva = document.createElement('div');
    filaNueva.className = 'cliente-config-fila cliente-config-nueva';
    const inputNuevoNombre = document.createElement('input');
    inputNuevoNombre.type = 'text'; inputNuevoNombre.placeholder = 'Nombre de cliente nuevo';
    const btnAgregar = document.createElement('button');
    btnAgregar.type = 'button';
    btnAgregar.className = 'btn btn-outline';
    btnAgregar.textContent = '+ Agregar a revendedores';
    btnAgregar.addEventListener('click', () => {
        const nombre = inputNuevoNombre.value.trim();
        if (!nombre) return;
        const id = Store.normalizarIdCliente(nombre);
        Store.setCliente(nombre, { nombre, esGrupo: true });
        clientesCache[id] = { nombre, esGrupo: true };
        inputNuevoNombre.value = '';
        renderizarListaClientesConfig();
    });
    filaNueva.append(inputNuevoNombre, btnAgregar);
    cont.appendChild(filaNueva);
}

// ----------------------------------------------------------------------------
// ESTADÍSTICAS (vista propia, no un tab escondido) — se leen solo al abrir
// la pestaña "📊 Estadísticas", nunca en vivo: mantiene el uso de Firebase
// al mínimo. Solo existen para la lista principal (Zapatillas).
// ----------------------------------------------------------------------------
function idMes(fecha) { return fecha.toISOString().slice(0, 7); }

function formatoFechaLegible(fechaISO) {
    const partes = (fechaISO || '').split('-');
    return partes.length === 3 ? `${partes[2]}/${partes[1]}` : (fechaISO || '?');
}

async function cargarEstadisticasPro() {
    const cont = document.getElementById('estadisticas-cuerpo-pro');
    if (!cont) return;
    cont.innerHTML = '<p class="ayuda">Cargando...</p>';

    const ahora = new Date();
    const mesActualId = idMes(ahora);
    const mesAnteriorId = idMes(new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1));

    try {
        const [cierresActual, cierresAnterior] = await Promise.all([
            Store.obtenerCierresDelMes(mesActualId),
            Store.obtenerCierresDelMes(mesAnteriorId),
        ]);
        cont.innerHTML =
            renderizarMesEstadisticasPro('Este mes', cierresActual) +
            renderizarMesEstadisticasPro('Mes anterior', cierresAnterior);
    } catch (e) {
        cont.innerHTML = '<p class="ayuda">No se pudieron cargar las estadísticas.</p>';
    }
}

function renderizarMesEstadisticasPro(titulo, cierresSinOrdenar) {
    const cierres = (cierresSinOrdenar || []).slice().sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

    let facturacionTotal = 0, paresTotal = 0;
    const modelosTotal = {};
    const porDia = {}; // fecha -> {pares, facturacion}
    cierres.forEach(c => {
        const fact = parseFloat(c.facturacion) || 0;
        const pares = parseFloat(c.cantidadPares) || 0;
        facturacionTotal += fact;
        paresTotal += pares;
        Object.entries(c.modelosVendidos || {}).forEach(([nombre, cantidad]) => {
            modelosTotal[nombre] = (modelosTotal[nombre] || 0) + (parseFloat(cantidad) || 0);
        });
        if (!porDia[c.fecha]) porDia[c.fecha] = { pares: 0, facturacion: 0 };
        porDia[c.fecha].pares += pares;
        porDia[c.fecha].facturacion += fact;
    });

    const ranking = Object.entries(modelosTotal).map(([nombre, cantidad]) => ({ nombre, cantidad })).sort((a, b) => b.cantidad - a.cantidad);
    const dias = Object.entries(porDia).sort((a, b) => a[0].localeCompare(b[0]));
    const maxParesDia = Math.max(1, ...dias.map(([, d]) => d.pares));
    const promedioPorCierre = cierres.length > 0 ? facturacionTotal / cierres.length : 0;

    return `
    <div class="card bloque-estadisticas-mes">
        <h3 class="estadisticas-mes-titulo">${titulo}</h3>

        <div class="kpis">
            <div class="kpi kpi-info"><span class="kpi-valor">${formatoPesos(facturacionTotal)}</span><span class="kpi-etiqueta">Facturación total</span></div>
            <div class="kpi kpi-neutro"><span class="kpi-valor">${paresTotal}</span><span class="kpi-etiqueta">Pares vendidos</span></div>
            <div class="kpi kpi-exito"><span class="kpi-valor">${cierres.length}</span><span class="kpi-etiqueta">Cierres de lista</span></div>
            <div class="kpi kpi-neutro"><span class="kpi-valor">${formatoPesos(promedioPorCierre)}</span><span class="kpi-etiqueta">Promedio por cierre</span></div>
        </div>

        <h4 class="subtitulo-chico" style="margin-top:18px;">Pares vendidos por día</h4>
        ${dias.length === 0 ? '<p class="vacio">Sin cierres registrados.</p>' : `
        <div class="grafico-cierres">
            ${dias.map(([fecha, d]) => `
                <div class="barra-dia" title="${formatoFechaLegible(fecha)}: ${d.pares} par(es), ${formatoPesos(d.facturacion)}">
                    <span class="barra-valor">${d.pares}</span>
                    <div class="barra" style="height:${Math.max(6, Math.round((d.pares / maxParesDia) * 130))}px;"></div>
                    <span class="barra-etiqueta">${formatoFechaLegible(fecha)}</span>
                </div>`).join('')}
        </div>`}

        <h4 class="subtitulo-chico" style="margin-top:18px;">Ranking de modelos</h4>
        ${ranking.length === 0 ? '<p class="vacio">Todavía no hay ninguna lista cerrada este período.</p>' : `
        <div class="tabla-scroll">
        <table class="tabla-estadisticas">
            <thead><tr><th>#</th><th>Modelo</th><th>Pares vendidos</th></tr></thead>
            <tbody>
                ${ranking.map((m, i) => `<tr><td>${i + 1}</td><td class="celda-modelo">${m.nombre}</td><td>${m.cantidad}</td></tr>`).join('')}
            </tbody>
        </table>
        </div>`}

        <h4 class="subtitulo-chico" style="margin-top:18px;">Cierres de lista (día por día)</h4>
        ${cierres.length === 0 ? '<p class="vacio">Sin cierres registrados.</p>' : `
        <div class="tabla-scroll">
        <table class="tabla-estadisticas">
            <thead><tr><th>Fecha</th><th>Pedidos</th><th>Pares</th><th>Facturación</th></tr></thead>
            <tbody>
                ${cierres.slice().reverse().map(c => `
                    <tr>
                        <td>${formatoFechaLegible(c.fecha)}</td>
                        <td>${c.cantidadPedidos || 0}</td>
                        <td>${c.cantidadPares || 0}</td>
                        <td>${formatoPesos(c.facturacion)}</td>
                    </tr>`).join('')}
            </tbody>
        </table>
        </div>`}
    </div>`;
}

// ----------------------------------------------------------------------------
// INDICADOR DE CONEXIÓN (avisa también si se cortó el internet)
// ----------------------------------------------------------------------------
let ultimoEstadoConexion = 'local';

function actualizarIndicadorConexion(estado) {
    ultimoEstadoConexion = estado;
    renderizarIndicadorConexion();
}

function renderizarIndicadorConexion() {
    const el = document.getElementById('estado-conexion');
    const texto = document.getElementById('estado-conexion-texto');
    if (!el || !texto) return;
    el.classList.remove('estado-ok', 'estado-conectando', 'estado-error', 'estado-local', 'estado-offline');

    // Sin internet solo importa si dependemos de la nube (modo Firebase);
    // en modo local la app funciona igual sin conexión.
    if (Store.getModo() === 'firebase' && !navigator.onLine) {
        el.classList.add('estado-offline');
        texto.textContent = 'Sin conexión — se guarda y sincroniza al volver';
        return;
    }

    if (ultimoEstadoConexion === 'firebase-listo') { el.classList.add('estado-ok'); texto.textContent = 'Sincronizado en la nube'; }
    else if (ultimoEstadoConexion === 'firebase-conectando') { el.classList.add('estado-conectando'); texto.textContent = 'Conectando...'; }
    else if (ultimoEstadoConexion === 'local-por-error') { el.classList.add('estado-error'); texto.textContent = 'Error de conexión — modo local'; }
    else { el.classList.add('estado-local'); texto.textContent = 'Modo local (solo esta compu)'; }
}

window.addEventListener('online', renderizarIndicadorConexion);
window.addEventListener('offline', renderizarIndicadorConexion);

// ----------------------------------------------------------------------------
// ARRANQUE
// ----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    Store.init().then(() => {
        Store.onEstadoConexion(actualizarIndicadorConexion);

        try { listaActivaId = localStorage.getItem(CLAVE_LISTA_ACTIVA) || PRINCIPAL_LISTA_ID; } catch (e) { /* localStorage bloqueado */ }
        suscribirRespaldoDeListaActiva();

        let yaSeSembroListaPrincipal = false;
        Store.onListas(obj => {
            listasCache = obj;
            if (!obj[PRINCIPAL_LISTA_ID] && !yaSeSembroListaPrincipal) {
                yaSeSembroListaPrincipal = true;
                Store.asegurarListaPrincipal();
            }
            if (!listasCache[listaActivaId]) {
                // La lista que tenía elegida este navegador ya no existe (la
                // borraron desde otra compu): vuelve a la principal.
                listaActivaId = PRINCIPAL_LISTA_ID;
                try { localStorage.setItem(CLAVE_LISTA_ACTIVA, listaActivaId); } catch (e) { /* localStorage bloqueado */ }
                recalcularPedidosActivos();
                suscribirRespaldoDeListaActiva();
            }
            renderizarTabsListas();
        });

        let yaSeSembroConfigPorDefecto = false; // evita reintentar sembrar en bucle si algo sale mal
        Store.onConfig(cfg => {
            const esPrimeraCarga = precioConfig === null;
            // Si no hay nada guardado, o lo que hay es del formato viejo
            // (4 tablas separadas, de antes de simplificar a "categorías"),
            // se siembra de nuevo con los valores por defecto. Solo se
            // intenta UNA vez: si algo estuviera mal y el guardado no
            // "prendiera", usar el default en memoria en vez de reintentar
            // para siempre.
            if (!cfg || !cfg.categorias) {
                precioConfig = configPreciosPorDefecto();
                if (!yaSeSembroConfigPorDefecto) {
                    yaSeSembroConfigPorDefecto = true;
                    Store.setConfig(precioConfig);
                }
            } else {
                precioConfig = cfg;
            }
            if (!modalConfigAbierto) {
                configDraft = JSON.parse(JSON.stringify(precioConfig));
            }
            if (esPrimeraCarga || !modalConfigAbierto) renderizarConfigUI();
            renderizarTabla();
        });

        Store.onClientes(obj => {
            clientesCache = obj;
            sincronizarCheckboxGrupo();
            if (!modalConfigAbierto) renderizarListaClientesConfig();
            renderizarTabla(); // la separación grupo/minorista depende de esto
        });

        Store.onPedidos(arr => {
            todosPedidos = arr;
            recalcularPedidosActivos();
        });
    });
});
