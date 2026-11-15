/**
 * Control general de gastos personales · sincronización en doble vía con Caja Personal.
 *
 * Qué hace
 * - Lo que escribes o corriges en la pestaña MOVIMIENTOS (columnas de datos A:AE y las de apoyo)
 *   se envía a la plataforma; lo que se registra en la plataforma (web, atajo) aparece aquí.
 * - Solo toca las columnas de datos. Nunca escribe en las columnas con fórmulas
 *   (Ingreso actividad, Gasto actividad, Revisión de caja, Mes, Año, índices…).
 * - Cada movimiento se empareja por su ID (columna A). Borrar una fila aquí la borra en la plataforma
 *   (la plataforma guarda una copia de respaldo de todo lo eliminado).
 * - La clave de la persona se guarda en las propiedades del script, no en una celda.
 *
 * Instalación: Extensiones → Apps Script → crea un archivo "ControlGeneral" y pega este código.
 * Ejecuta una vez la función  cpInstalar  (autoriza los permisos). Luego, en la hoja:
 * menú  Caja Personal → Conectar con la plataforma…  y pega la clave de hoja.
 *
 * Todas las funciones empiezan con "cp" para no chocar con otros scripts de la hoja.
 */
const CP_URL = 'https://uzukftcciyvvyukplqrp.supabase.co';
const CP_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dWtmdGNjaXl2dnl1a3BscXJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4NDc2NDMsImV4cCI6MjEwOTQyMzY0M30.0taUv7gNulC9KeYek0w31012HIG4T8gBZ4RSIrlPIQI';
const CP_HOJA = 'MOVIMIENTOS';
const CP_FILA_CAB = 5;        // fila de los encabezados
const CP_PRIMERA = 6;         // primera fila de datos
const CP_SYNC = '_CP_SYNC';   // hoja oculta con la huella de lo ya sincronizado
const CP_LOTE = 150;
const CP_MAX_BORRADOS = 20;   // si desaparecen más filas de golpe, se detiene por seguridad

// Columnas de datos que viajan como campo propio: [encabezado, campo]
const CP_BASE = [
  ['Fecha', 'fecha'], ['Movimiento', 'movimiento'], ['Tipo de gasto', 'tipo_gasto'], ['Categoría', 'categoria'],
  ['Subcategoría', 'subcategoria'], ['Descripción', 'descripcion'], ['Ámbito', 'ambito'], ['Medio de pago', 'medio'],
  ['Monto', 'monto'], ['Necesidad', 'necesidad'], ['Estado', 'estado'], ['Cuenta', 'cuenta'],
  ['Costo producto', 'costo'], ['Envío / costo venta', 'envio'], ['Es prueba', 'es_prueba'],
];
// Columnas de apoyo que viajan guardadas tal cual en "extra"
const CP_EXTRA = [
  'ID recurrente', 'Nota', 'Cuenta destino', 'Origen', 'Unidades', 'Precisión fecha', 'Km recorridos', 'Horas',
  'Canal de venta', 'Género', 'Producto', 'Categoría producto', 'Capital pagado', 'Interés / comisión',
  'Referencia factura / venta / deuda', 'Creado el', 'Actualizado el', 'Importe USD', 'Tipo original',
  'Tarjeta utilizada', 'Estado previo del fijo', 'ID pago fijo', 'Código producto', 'Referencia de inventario',
];

/* ---------- Menú, instalación y conexión ---------- */
function cpMenu() {
  SpreadsheetApp.getUi().createMenu('Caja Personal')
    .addItem('Conectar con la plataforma…', 'cpConectar')
    .addItem('Sincronizar ahora', 'cpSincronizarAhora')
    .addItem('Estado de la conexión', 'cpEstado')
    .addSeparator()
    .addItem('Desconectar esta hoja', 'cpDesconectar')
    .addToUi();
}

/** Ejecutar una vez desde el editor: crea el menú (al abrir la hoja) y pide los permisos. */
function cpInstalar() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'cpMenu').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cpMenu').forSpreadsheet(ss).onOpen().create();
  UrlFetchApp.fetch(CP_URL + '/rest/v1/', { muteHttpExceptions: true, headers: { apikey: CP_KEY } });
  cpMenu();
  ss.toast('Listo. Usa el menú Caja Personal → Conectar con la plataforma.', 'Caja Personal', 6);
}

function cpConectar() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Conectar con Caja Personal', 'Pega la clave de hoja de tu cuenta (empieza con "hojap_"). La genera el administrador en la plataforma → Cuentas → Clave de hoja.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const clave = r.getResponseText().trim();
  if (!/^hojap_[0-9a-f]{48}$/.test(clave)) { ui.alert('Esa clave no tiene el formato correcto.'); return; }
  const props = PropertiesService.getDocumentProperties();
  try {
    cpColumnas_();                                   // valida que la hoja tenga los encabezados esperados
    props.setProperty('CP_CLAVE', clave);
    const info = cpApi_('cg_identidad', { p_clave: clave });
    props.deleteProperty('CP_DESDE');
    cpInstalarDisparadores_();
    const res = cpSync_({ primera: true });
    ui.alert('Hoja conectada con la cuenta de ' + (info.nombre || info.correo) + '.\n\n' + cpResumen_(res));
  } catch (e) {
    props.deleteProperty('CP_CLAVE');
    ui.alert('No se pudo conectar: ' + e.message);
  }
}

function cpDesconectar() {
  PropertiesService.getDocumentProperties().deleteProperty('CP_CLAVE');
  PropertiesService.getDocumentProperties().deleteProperty('CP_DESDE');
  cpGuardarSnapshot_({});
  ScriptApp.getProjectTriggers().filter(t => ['cpTick', 'cpAlEditar'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  SpreadsheetApp.getUi().alert('Hoja desconectada. Los datos que ya están aquí se conservan.');
}

function cpInstalarDisparadores_() {
  ScriptApp.getProjectTriggers().filter(t => ['cpTick', 'cpAlEditar'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cpTick').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('cpAlEditar').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
}

function cpEstado() {
  const p = PropertiesService.getDocumentProperties();
  const ui = SpreadsheetApp.getUi();
  if (!p.getProperty('CP_CLAVE')) { ui.alert('Esta hoja no está conectada. Usa "Conectar con la plataforma…".'); return; }
  const sn = cpLeerSnapshot_();
  const desde = p.getProperty('CP_DESDE');
  ui.alert('Conectada.\nMovimientos sincronizados: ' + Object.keys(sn).length +
    '\nÚltima lectura de la plataforma: ' + (desde ? Utilities.formatDate(new Date(desde), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'dd/MM/yyyy HH:mm:ss') : '—') +
    '\nFilas con error: ' + Object.keys(sn).filter(k => sn[k].error).length);
}

/* ---------- Disparadores ---------- */
function cpTick() { cpSync_({}); }
function cpSincronizarAhora() {
  if (!cpClave_()) { SpreadsheetApp.getUi().alert('Primero usa "Conectar con la plataforma…".'); return; }
  const res = cpSync_({});
  SpreadsheetApp.getActive().toast(cpResumen_(res), 'Caja Personal', 6);
}
function cpAlEditar(e) {
  if (!cpClave_() || !e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== CP_HOJA || e.range.getRow() < CP_PRIMERA) return;
  cpSync_({ soloEnviar: true });
}
function cpClave_() { return PropertiesService.getDocumentProperties().getProperty('CP_CLAVE'); }
function cpResumen_(r) {
  if (!r) return 'Otra sincronización estaba en curso; se reintenta sola en un minuto.';
  return 'Enviados a la plataforma: ' + r.enviados + (r.borrados ? ' · eliminados: ' + r.borrados : '') +
    '\nRecibidos de la plataforma: ' + r.recibidos + (r.quitados ? ' · retirados: ' + r.quitados : '') +
    (r.errores ? '\nFilas con error: ' + r.errores + ' (mira la nota en la celda del ID)' : '') + (r.aviso ? '\n' + r.aviso : '');
}

/* ---------- Plataforma ---------- */
function cpApi_(fn, body) {
  const r = UrlFetchApp.fetch(CP_URL + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: CP_KEY }, payload: JSON.stringify(body),
  });
  const txt = r.getContentText();
  const d = txt ? JSON.parse(txt) : null;
  if (r.getResponseCode() >= 300) throw new Error((d && d.message) || ('Error ' + r.getResponseCode()));
  return d;
}

/* ---------- Lectura de la hoja ---------- */
function cpTz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }
function cpHoja_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CP_HOJA);
  if (!sh) throw new Error('No encuentro la pestaña ' + CP_HOJA + '.');
  return sh;
}
function cpColumnas_() {
  const sh = cpHoja_();
  const enc = sh.getRange(CP_FILA_CAB, 1, 1, sh.getLastColumn()).getValues()[0];
  const cols = {};
  enc.forEach((h, i) => { if (h !== '') cols[String(h).trim()] = i; });
  const faltan = ['ID'].concat(CP_BASE.map(c => c[0])).concat(CP_EXTRA).filter(h => cols[h] === undefined);
  if (faltan.length) throw new Error('En la fila ' + CP_FILA_CAB + ' de ' + CP_HOJA + ' faltan los encabezados: ' + faltan.join(', '));
  return cols;
}

/** Normaliza un valor para compararlo (misma forma en la hoja y en la plataforma). */
function cpNv_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return isNaN(v) ? '' : Utilities.formatDate(v, cpTz_(), 'yyyy-MM-dd HH:mm:ss').replace(/ 00:00:00$/, '');
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (typeof v === 'boolean') return v;
  return String(v).trim();
}
function cpFecha_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, cpTz_(), 'yyyy-MM-dd');
  const s = String(v || '').trim(); if (!s) return '';
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return s.slice(0, 10);
}
function cpNum_(v) {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let s = String(v === null || v === undefined ? '' : v).replace(/S\/\.?|\s/gi, '');
  if (!s) return '';
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const n = parseFloat(s); return isNaN(n) ? '' : Math.round(n * 100) / 100;
}

/** Registro normalizado a partir de los valores de una fila de la hoja. */
function cpRecFila_(vals, cols) {
  const r = { ref: String(vals[cols['ID']] || '').trim(), extra: {} };
  CP_BASE.forEach(([h, k]) => {
    const v = vals[cols[h]];
    if (k === 'fecha') r[k] = cpFecha_(v);
    else if (k === 'monto' || k === 'costo' || k === 'envio') r[k] = cpNum_(v);
    else if (k === 'es_prueba') r[k] = v === true || String(v).toUpperCase() === 'TRUE';
    else r[k] = String(v === null || v === undefined ? '' : v).trim();
  });
  CP_EXTRA.forEach(h => { const v = cpNv_(vals[cols[h]]); if (v !== '') r.extra[h] = v; });
  return r;
}
/** Registro normalizado a partir de lo que devuelve la plataforma. */
function cpRecPlat_(p) {
  const r = { ref: p.ref, extra: {} };
  CP_BASE.forEach(([h, k]) => {
    const v = p[k];
    if (k === 'fecha') r[k] = cpFecha_(v);
    else if (k === 'monto' || k === 'costo' || k === 'envio') r[k] = cpNum_(v);
    else if (k === 'es_prueba') r[k] = v === true;
    else r[k] = String(v === null || v === undefined ? '' : v).trim();
  });
  Object.keys(p.extra || {}).forEach(h => { const v = cpNv_(p.extra[h]); if (v !== '') r.extra[h] = v; });
  return r;
}
function cpHash_(r) {
  const claves = Object.keys(r.extra).sort();
  const arr = [r.ref].concat(CP_BASE.map(c => r[c[1]])).concat(claves.map(k => k + '=' + r.extra[k]));
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(arr), Utilities.Charset.UTF_8));
}
/** Lo que se envía a cg_guardar. */
function cpPayload_(r) {
  return {
    ref: r.ref, fecha: r.fecha, movimiento: r.movimiento, tipo_gasto: r.tipo_gasto, categoria: r.categoria, subcategoria: r.subcategoria,
    descripcion: r.descripcion, ambito: r.ambito, medio: r.medio, monto: r.monto === '' ? null : r.monto, necesidad: r.necesidad,
    estado: r.estado, cuenta: r.cuenta, costo: r.costo === '' ? null : r.costo, envio: r.envio === '' ? null : r.envio,
    es_prueba: r.es_prueba, extra: r.extra,
  };
}

/** Lee todas las filas con datos de MOVIMIENTOS. */
function cpLeerFilas_(sh, cols) {
  const ultima = sh.getLastRow();
  const out = [];
  if (ultima < CP_PRIMERA) return out;
  const ancho = Math.max.apply(null, Object.keys(cols).map(k => cols[k])) + 1;
  const vals = sh.getRange(CP_PRIMERA, 1, ultima - CP_PRIMERA + 1, ancho).getValues();
  const iF = cols['Fecha'], iM = cols['Monto'], iID = cols['ID'], iMov = cols['Movimiento'];
  vals.forEach((v, i) => {
    const sinID = String(v[iID] || '').trim() === '';
    if (sinID && v[iF] === '' && v[iM] === '' && v[iMov] === '') return;     // fila vacía
    out.push({ row: CP_PRIMERA + i, vals: v, sinID: sinID });
  });
  return out;
}

/* ---------- Huella de lo ya sincronizado ---------- */
function cpSnapshotHoja_() {
  const ss = SpreadsheetApp.getActive();
  let s = ss.getSheetByName(CP_SYNC);
  if (!s) { s = ss.insertSheet(CP_SYNC); s.getRange(1, 1, 1, 3).setValues([['ID', 'Huella', 'Error']]); s.hideSheet(); }
  return s;
}
function cpLeerSnapshot_() {
  const s = cpSnapshotHoja_(), n = s.getLastRow() - 1, m = {};
  if (n > 0) s.getRange(2, 1, n, 3).getValues().forEach(f => { if (f[0]) m[f[0]] = { hash: f[1], error: f[2] }; });
  return m;
}
function cpGuardarSnapshot_(m) {
  const s = cpSnapshotHoja_();
  const filas = Object.keys(m).map(k => [k, m[k].hash || '', m[k].error || '']);
  if (s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, 3).clearContent();
  if (filas.length) s.getRange(2, 1, filas.length, 3).setValues(filas);
}

/* ---------- Sincronización ---------- */
function cpSync_(op) {
  const clave = cpClave_(); if (!clave) return null;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(op.primera ? 60000 : 20000)) return null;
  try {
    const sh = cpHoja_(), cols = cpColumnas_();
    const ancho = Math.max.apply(null, Object.keys(cols).map(k => cols[k])) + 1;
    const props = PropertiesService.getDocumentProperties();
    const desde = props.getProperty('CP_DESDE');
    if (!desde && op.soloEnviar) return null;          // la primera sincronización completa va antes
    const snap = cpLeerSnapshot_(), antes = JSON.stringify(snap);
    const res = { enviados: 0, borrados: 0, recibidos: 0, quitados: 0, errores: 0, aviso: '' };

    // Primera vez: se compara contra todo lo que ya hay en la plataforma.
    // Regla: gana la hoja, salvo en lo que se cambió o eliminó directamente en la plataforma.
    let plat = null, elim0 = {}, ahora = null;
    if (!desde) {
      const t = cpApi_('cg_todo', { p_clave: clave });
      plat = {}; t.movimientos.forEach(p => { if (p.ref) plat[p.ref] = p; });
      (t.eliminados || []).forEach(r => elim0[r] = true);
      ahora = t.ahora;
    }

    // 1) Qué hay en la hoja ----------------------------------------------------
    const filas = cpLeerFilas_(sh, cols);
    filas.filter(f => f.sinID).forEach((f, i) => {       // filas escritas a mano, sin ID: se les asigna uno
      const id = 'HOJA-' + Utilities.formatDate(new Date(), cpTz_(), 'yyyyMMdd') + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase();
      sh.getRange(f.row, cols['ID'] + 1).setValue(id); f.vals[cols['ID']] = id; f.sinID = false;
    });
    const enHoja = {}, enviar = [], traer = [], quitar = [];
    filas.forEach(f => {
      const rec = cpRecFila_(f.vals, cols), h = cpHash_(rec);
      if (enHoja[rec.ref]) { sh.getRange(f.row, cols['ID'] + 1).setNote('Caja Personal: este ID está repetido en la fila ' + enHoja[rec.ref].row + '. Esta fila no se sincroniza.'); res.errores++; return; }
      enHoja[rec.ref] = { row: f.row, hash: h };
      if (plat) {
        const p = plat[rec.ref];
        if (!p && elim0[rec.ref]) { quitar.push(rec.ref); return; }                  // eliminado en la plataforma
        if (p && cpHash_(cpRecPlat_(p)) === h) { snap[rec.ref] = { hash: h, error: '' }; return; }
        if (p && p.via === 'plataforma') { traer.push(p); return; }                  // cambiado en la plataforma
        enviar.push({ rec: rec, hash: h, row: f.row });
      } else {
        const s = snap[rec.ref];
        if (!s || s.hash !== h || s.error) enviar.push({ rec: rec, hash: h, row: f.row });
      }
    });
    const borrados = Object.keys(snap).filter(k => !enHoja[k] && snap[k].hash);
    if (borrados.length > CP_MAX_BORRADOS) {
      res.aviso = 'Se detuvo el borrado: desaparecieron ' + borrados.length + ' filas de golpe. No se eliminó nada en la plataforma. Si es intencional, bórralas de a pocas.';
      borrados.length = 0;
    }

    // 2) Hoja → plataforma -----------------------------------------------------
    const mandar = (lista) => {
      for (let i = 0; i < lista.length; i += CP_LOTE) {
        const lote = lista.slice(i, i + CP_LOTE);
        const r = cpApi_('cg_guardar', { p_clave: clave, p_filas: lote.map(c => cpPayload_(c.rec)) });
        r.forEach((x, j) => {
          const c = lote[j];
          if (x.estado === 'ok' || x.estado === 'igual') {
            if (snap[c.rec.ref] && snap[c.rec.ref].error) sh.getRange(c.row, cols['ID'] + 1).clearNote();
            snap[c.rec.ref] = { hash: c.hash, error: '' };
            if (x.estado === 'ok') res.enviados++;
          } else {
            res.errores++;
            if (!snap[c.rec.ref] || snap[c.rec.ref].error !== x.estado) sh.getRange(c.row, cols['ID'] + 1).setNote('Caja Personal: ' + x.estado);
            snap[c.rec.ref] = { hash: '', error: x.estado };
          }
        });
      }
    };
    mandar(enviar);
    for (let i = 0; i < borrados.length; i += CP_LOTE) {
      const lote = borrados.slice(i, i + CP_LOTE);
      cpApi_('cg_guardar', { p_clave: clave, p_filas: lote.map(ref => ({ ref: ref, borrar: true })) });
      lote.forEach(ref => { delete snap[ref]; res.borrados++; });
    }

    // 3) Plataforma → hoja -----------------------------------------------------
    if (!op.soloEnviar) {
      if (plat) {
        Object.keys(plat).forEach(ref => { if (!enHoja[ref]) traer.push(plat[ref]); });   // solo existen en la plataforma
      } else {
        const c = cpApi_('cg_cambios', { p_clave: clave, p_desde: desde });
        c.cambios.forEach(p => { if (p.ref) traer.push(p); });
        c.eliminados.forEach(ref => { if (enHoja[ref]) quitar.push(ref); });
        ahora = c.ahora;
      }
      let ultimaFila = CP_PRIMERA - 1;
      Object.keys(enHoja).forEach(k => { if (enHoja[k].row > ultimaFila) ultimaFila = enHoja[k].row; });
      const reenviar = [];
      traer.forEach(p => {
        const rec = cpRecPlat_(p), hp = cpHash_(rec);
        if (enHoja[rec.ref] && enHoja[rec.ref].hash === hp) { snap[rec.ref] = { hash: hp, error: '' }; return; }   // ya es igual
        const fila = enHoja[rec.ref] ? enHoja[rec.ref].row : ++ultimaFila;
        if (fila > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
        cpEscribirFila_(sh, cols, fila, rec, p.extra || {});
        const leido = cpRecFila_(sh.getRange(fila, 1, 1, ancho).getValues()[0], cols), hl = cpHash_(leido);
        enHoja[rec.ref] = { row: fila, hash: hl };
        snap[rec.ref] = { hash: hl, error: '' };
        // La hoja conserva columnas de apoyo que la plataforma no tenía: se le devuelve la fila completa
        if (hl !== hp) reenviar.push({ rec: leido, hash: hl, row: fila });
        res.recibidos++;
      });
      quitar.forEach(ref => {
        if (!enHoja[ref]) return;
        cpLimpiarFila_(sh, cols, enHoja[ref].row);
        delete snap[ref]; delete enHoja[ref]; res.quitados++;
      });
      const env0 = res.enviados; mandar(reenviar); res.enviados = env0;
      props.setProperty('CP_DESDE', new Date(new Date(ahora).getTime() - 5000).toISOString());   // 5 s de traslape
    }

    if (JSON.stringify(snap) !== antes) cpGuardarSnapshot_(snap);
    if (res.aviso) SpreadsheetApp.getActive().toast(res.aviso, 'Caja Personal', 10);
    return res;
  } finally { lock.releaseLock(); }
}

/** Bloques de columnas consecutivas, para escribir o limpiar por rangos. */
function cpBloques_(idx, fn) {
  idx.sort((a, b) => a - b);
  let ini = 0;
  while (ini < idx.length) {
    let fin = ini;
    while (fin + 1 < idx.length && idx[fin + 1] === idx[fin] + 1) fin++;
    fn(idx[ini], idx.slice(ini, fin + 1));
    ini = fin + 1;
  }
}
/**
 * Escribe un registro de la plataforma en una fila, solo en las columnas de datos.
 * De las columnas de apoyo solo toca las que la plataforma trae (las demás se conservan como están).
 */
function cpEscribirFila_(sh, cols, fila, rec, extraPlat) {
  const valor = {};   // índice de columna (desde 0) → valor
  valor[cols['ID']] = rec.ref;
  CP_BASE.forEach(([h, k]) => {
    let v = rec[k];
    if (k === 'fecha') { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); v = m ? new Date(+m[1], +m[2] - 1, +m[3]) : ''; }
    valor[cols[h]] = v;
  });
  CP_EXTRA.forEach(h => { if (Object.prototype.hasOwnProperty.call(extraPlat, h)) valor[cols[h]] = extraPlat[h] === null ? '' : extraPlat[h]; });
  cpBloques_(Object.keys(valor).map(Number), (c0, grupo) => sh.getRange(fila, c0 + 1, 1, grupo.length).setValues([grupo.map(i => valor[i])]));
}
function cpLimpiarFila_(sh, cols, fila) {
  const idx = [cols['ID']].concat(CP_BASE.map(c => cols[c[0]])).concat(CP_EXTRA.map(h => cols[h]));
  cpBloques_(idx, (c0, grupo) => sh.getRange(fila, c0 + 1, 1, grupo.length).clearContent());
  sh.getRange(fila, cols['ID'] + 1).clearNote();
}
