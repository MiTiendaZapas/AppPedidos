// ============================================================================
// CONFIGURACIÓN DE FIREBASE
// ============================================================================
// Estas claves NO son secretas (Firebase las expone siempre del lado del
// cliente a propósito; la seguridad real la dan las "Reglas de Firestore",
// no ocultar esta clave). Podés subir este archivo al repo sin problema.
//
// PASOS PARA ACTIVAR LA SINCRONIZACIÓN EN TIEMPO REAL:
// 1. Andá a https://console.firebase.google.com y creá un proyecto nuevo
//    (gratis, sin tarjeta). Por ejemplo "tienda-zapas-pedidos".
// 2. Adentro del proyecto: "Compilación" > "Firestore Database" > "Crear
//    base de datos". Elegí modo de PRODUCCIÓN (no "modo de prueba") y
//    cualquier ubicación (ej: "southamerica-east1" - más cercana).
// 3. Ahí mismo, pestaña "Reglas", pegá esto y publicá:
//
//      rules_version = '2';
//      service cloud.firestore {
//        match /databases/{database}/documents {
//          match /{document=**} {
//            allow read, write: if request.auth != null;
//          }
//        }
//      }
//
// 4. "Compilación" > "Authentication" > "Comenzar" > pestaña "Sign-in
//    method" > habilitá el proveedor "Anónimo". Esto permite que la app
//    entre sola (sin usuario/contraseña) pero bloquea a cualquiera que no
//    pase por tu app.
// 5. "Configuración del proyecto" (ícono de tuerca) > bajá hasta "Tus apps"
//    > ícono </> (Web) > registrá una app (el nombre da igual, ej "AppPedidos")
//    > NO hace falta Firebase Hosting. Copiá el objeto "firebaseConfig" que
//    te muestra y pegalo abajo, reemplazando el objeto de ejemplo.
// 6. Guardá este archivo y recargá la página: si quedó bien configurado vas
//    a ver un puntito verde "Sincronizado" arriba a la derecha. Compartile
//    la carpeta del proyecto (o el link, si lo publicás) a tu socio: apenas
//    abra la página en su compu va a ver la misma lista, en vivo.
//
// Mientras este archivo tenga los valores de ejemplo, la app funciona igual
// pero guarda todo solo en este navegador (localStorage) — perfecto para
// probarla antes de crear el proyecto de Firebase.
// ============================================================================

window.FIREBASE_CONFIG = {
    apiKey: "AIzaSyBjCbB7St7q2MV3b6-OtPbGCzhiAz2G-Tc",
    authDomain: "pedidos-tienda-zapas.firebaseapp.com",
    projectId: "pedidos-tienda-zapas",
    storageBucket: "pedidos-tienda-zapas.firebasestorage.app",
    messagingSenderId: "549358265721",
    appId: "1:549358265721:web:16d3bdcc0407aff0087ba8"
};
