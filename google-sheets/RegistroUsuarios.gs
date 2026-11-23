/**
 * Caja Personal · Registro de usuarios
 * Pega este archivo en la hoja "Caja Personal – Registro de cuentas" (Extensiones → Apps Script).
 *
 * Qué hace
 *  - Pestaña USUARIOS: una fila por persona registrada, con nombre, edad, teléfono, correo, uso,
 *    fecha de registro, si confirmó el correo, último ingreso y sus números (movimientos, ingresos,
 *    gastos, saldo). Nunca trae contraseñas: la base solo guarda su versión cifrada y esto no la lee.
 *  - Pestaña RESUMEN: totales por uso, registros de la semana y del mes.
 *  - Sincroniza cada minuto. Si corriges Nombre, Edad o Teléfono en USUARIOS, el cambio sube a la
 *    plataforma (y la persona lo ve en "Mi perfil"). Las demás columnas las llena la plataforma.
 *
 * Instalar: en el editor elige cpuInstalar y pulsa Ejecutar, acepta los permisos, recarga la hoja y usa
 * Caja Personal → Conectar registro de usuarios… para pegar la clave (en la web: Cuentas → Hoja de registro).
 * Las funciones empiezan con "cpu" para no chocar con otros scripts de la hoja.
 */
const CPU_URL = 'https://uzukftcciyvvyukplqrp.supabase.co/rest/v1/rpc/';
const CPU_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dWtmdGNjaXl2dnl1a3BscXJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4NDc2NDMsImV4cCI6MjEwOTQyMzY0M30.0taUv7gNulC9KeYek0w31012HIG4T8gBZ4RSIrlPIQI';
const CPU_HOJA = 'USUARIOS', CPU_RESUMEN = 'RESUMEN';
const CPU_FILA_TITULO = 1, CPU_FILA_CAB = 3, CPU_PRIMERA = 4;
// Columnas de USUARIOS. editable: se puede corregir en la hoja y sube a la plataforma.
const CPU_COLS = [
  { k: 'id', t: 'ID', w: 60 },
  { k: 'nombre', t: 'Nombre', w: 190, editable: true },
  { k: 'edad', t: 'Edad', w: 60, editable: true },
  { k: 'telefono', t: 'Teléfono', w: 120, editable: true },
  { k: 'correo', t: 'Correo electrónico', w: 230 },
  { k: 'uso', t: 'Uso', w: 210 },
  { k: 'registro', t: 'Registro', w: 130 },
  { k: 'confirmado', t: 'Correo confirmado', w: 90 },
  { k: 'ultimo_ingreso', t: 'Último ingreso', w: 130 },
  { k: 'movimientos', t: 'Movimientos', w: 95 },
  { k: 'ultimo_movimiento', t: 'Último movimiento', w: 110 },
  { k: 'ingresos', t: 'Ingresos (S/)', w: 105 },
  { k: 'gastos', t: 'Gastos (S/)', w: 105 },
  { k: 'saldo', t: 'Saldo (S/)', w: 105 },
  { k: 'atajo', t: 'Atajo iPhone', w: 80 },
  { k: 'hoja', t: 'Hoja conectada', w: 85 },
  { k: 'origen', t: 'Cómo se registró', w: 110 },
  { k: 'acepta_datos', t: 'Aceptó uso de datos', w: 95 },
  { k: 'actualizado', t: 'Perfil actualizado', w: 130 }
];
const CPU_USOS = { personal: 'Personal', taxista: 'Taxista', obra: 'Maestro de obra', vendedor: 'Vendedor' };
// Marca Caja Personal (manual de identidad): índigo, violeta, verde cuenta. Sheets usa Arial.
const CPU_MARCA = { indigo: '#1E1B4B', violeta: '#7C3AED', verde: '#0F766E', suave: '#EFE7FE', fondo: '#F4F3FA', linea: '#E4E1F0', tinta: '#16132B', gris: '#6B6785', ingreso: '#047857', gasto: '#E11D48', pendiente: '#B45309' };

/** Menú de la hoja. Se instala como disparador "al abrir" para no chocar con otros scripts. */
function cpuMenu() {
  SpreadsheetApp.getUi().createMenu('Caja Personal')
    .addItem('Sincronizar usuarios ahora', 'cpuSincronizar')
    .addItem('Conectar registro de usuarios…', 'cpuConectar')
    .addSeparator()
    .addItem('Instalar o reparar la sincronización', 'cpuInstalar')
    .addToUi();
}

function cpuInstalar() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction().indexOf('cpu') === 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cpuSincronizar').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('cpuAlEditar').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('cpuMenu').forSpreadsheet(ss).onOpen().create();
  try { cpuMenu(); } catch (_) {}
  cpuPrepararHojas_();
  const conClave = !!PropertiesService.getScriptProperties().getProperty('CPU_CLAVE');
  cpuAviso_(conClave ? 'Sincronización instalada. Se actualiza cada minuto.' : 'Instalado. Ahora usa Caja Personal → Conectar registro de usuarios… y pega la clave.');
}

function cpuConectar() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Conectar registro de usuarios', 'Pega la clave de la hoja de registro (en la web: Cuentas → Hoja de registro de usuarios). Empieza con regp_.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const clave = r.getResponseText().trim();
  if (!clave) return;
  try { cpuRpc_('registro_usuarios', { p_clave: clave }); }
  catch (e) { ui.alert('No se pudo conectar: ' + e.message); return; }
  PropertiesService.getScriptProperties().setProperty('CPU_CLAVE', clave);
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'cpuSincronizar')) cpuInstalar();
  cpuSincronizar();
  ui.alert('Listo. La pestaña USUARIOS se actualiza cada minuto.');
}

/** Guarda qué filas se corrigieron a mano, para subirlas en la próxima sincronización. */
function cpuAlEditar(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  if (sh.getName() !== CPU_HOJA || e.range.getLastRow() < CPU_PRIMERA) return;
  const c0 = e.range.getColumn(), c1 = e.range.getLastColumn();
  const tocaEditable = CPU_COLS.some((c, i) => c.editable && i + 1 >= c0 && i + 1 <= c1);
  if (!tocaEditable) return;
  const props = PropertiesService.getDocumentProperties();
  const pend = JSON.parse(props.getProperty('CPU_PENDIENTES') || '{}');
  const ids = sh.getRange(Math.max(e.range.getRow(), CPU_PRIMERA), 1, e.range.getLastRow() - Math.max(e.range.getRow(), CPU_PRIMERA) + 1, 1).getValues();
  ids.forEach((r, i) => {
    const id = String(r[0] || '').trim(); if (!id) return;
    pend[id] = true;
    sh.getRange(Math.max(e.range.getRow(), CPU_PRIMERA) + i, 1).setNote('Cambio pendiente de subir (se sube en menos de un minuto).');
  });
  props.setProperty('CPU_PENDIENTES', JSON.stringify(pend));
}

function cpuSincronizar() {
  const clave = PropertiesService.getScriptProperties().getProperty('CPU_CLAVE');
  if (!clave) return;
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) return;
  try {
    const sh = cpuPrepararHojas_();
    cpuSubirCambios_(sh, clave);
    const lista = cpuRpc_('registro_usuarios', { p_clave: clave }) || [];
    cpuEscribir_(sh, lista);
    cpuResumen_(lista);
    sh.getRange(2, 1).setValue('Sincronizado: ' + Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM/yyyy HH:mm') + ' · ' + lista.length + ' usuarios · Corrige solo Nombre, Edad y Teléfono (columnas lila).');
  } catch (e) {
    const sh = SpreadsheetApp.getActive().getSheetByName(CPU_HOJA);
    if (sh) sh.getRange(2, 1).setValue('⚠ No se pudo sincronizar (' + Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM HH:mm') + '): ' + e.message);
  } finally {
    lock.releaseLock();
  }
}

function cpuSubirCambios_(sh, clave) {
  const props = PropertiesService.getDocumentProperties();
  const pend = JSON.parse(props.getProperty('CPU_PENDIENTES') || '{}');
  const ids = Object.keys(pend);
  if (!ids.length || sh.getLastRow() < CPU_PRIMERA) { props.deleteProperty('CPU_PENDIENTES'); return; }
  const n = sh.getLastRow() - CPU_PRIMERA + 1;
  const datos = sh.getRange(CPU_PRIMERA, 1, n, CPU_COLS.length).getValues();
  const col = k => CPU_COLS.findIndex(c => c.k === k);
  const filas = [], filaDe = {};
  datos.forEach((r, i) => {
    const id = String(r[col('id')] || '').trim();
    if (!pend[id]) return;
    filaDe[id] = CPU_PRIMERA + i;
    filas.push({ id: id, nombre: String(r[col('nombre')] || '').trim(), edad: r[col('edad')] === '' ? '' : String(r[col('edad')]).trim(), telefono: String(r[col('telefono')] || '').trim() });
  });
  if (filas.length) {
    const res = cpuRpc_('registro_guardar', { p_clave: clave, p_filas: filas }) || [];
    res.forEach(x => {
      const f = filaDe[x.id]; if (!f) return;
      if (x.ok) { sh.getRange(f, 1).clearNote(); delete pend[x.id]; }
      else { sh.getRange(f, 1).setNote('No se subió: ' + x.error + '. Corrígelo y se vuelve a intentar.'); }
    });
  }
  // Las filas que ya no están en la hoja no se pueden subir
  ids.forEach(id => { if (!filaDe[id]) delete pend[id]; });
  if (Object.keys(pend).length) props.setProperty('CPU_PENDIENTES', JSON.stringify(pend)); else props.deleteProperty('CPU_PENDIENTES');
}

function cpuEscribir_(sh, lista) {
  const pend = JSON.parse(PropertiesService.getDocumentProperties().getProperty('CPU_PENDIENTES') || '{}');
  // Lo que aún no subió (por error) se respeta tal como está en la hoja
  const actuales = {};
  if (sh.getLastRow() >= CPU_PRIMERA) sh.getRange(CPU_PRIMERA, 1, sh.getLastRow() - CPU_PRIMERA + 1, CPU_COLS.length).getValues().forEach(r => { if (r[0]) actuales[r[0]] = r; });
  const fecha = v => v ? new Date(v) : '';
  const sino = v => v ? 'Sí' : 'No';
  const filas = lista.map(u => {
    if (pend[u.id] && actuales[u.id]) return actuales[u.id];
    const o = {
      id: u.id, nombre: u.nombre || '', edad: u.edad == null ? '' : u.edad, telefono: u.telefono || '', correo: u.correo || '',
      uso: (u.usos || []).filter(x => x !== 'personal').map(x => CPU_USOS[x] || x).concat((u.usos || []).length ? ['Personal'] : []).join(', ') || 'Sin elegir',
      registro: fecha(u.registro), confirmado: sino(u.confirmado), ultimo_ingreso: u.ultimo_ingreso ? new Date(u.ultimo_ingreso) : 'Nunca',
      movimientos: Number(u.movimientos) || 0, ultimo_movimiento: u.ultimo_movimiento ? new Date(u.ultimo_movimiento + 'T12:00:00') : '',
      ingresos: Number(u.ingresos) || 0, gastos: Number(u.gastos) || 0, saldo: Number(u.saldo) || 0,
      atajo: sino(u.atajo), hoja: sino(u.hoja), origen: u.admin ? 'Administrador (dueño)' : (u.origen === 'web' ? 'Se registró en la web' : 'Creada por el administrador'),
      acepta_datos: sino(u.acepta_datos), actualizado: fecha(u.actualizado)
    };
    return CPU_COLS.map(c => o[c.k]);
  });
  const viejas = Math.max(sh.getLastRow() - CPU_PRIMERA + 1, 0);
  if (filas.length) sh.getRange(CPU_PRIMERA, 1, filas.length, CPU_COLS.length).setValues(filas);
  if (viejas > filas.length) sh.getRange(CPU_PRIMERA + filas.length, 1, viejas - filas.length, CPU_COLS.length).clearContent().clearNote();
  if (!filas.length) return;
  const n = filas.length, col = k => CPU_COLS.findIndex(c => c.k === k) + 1;
  ['registro', 'ultimo_ingreso', 'actualizado'].forEach(k => sh.getRange(CPU_PRIMERA, col(k), n, 1).setNumberFormat('dd/mm/yyyy hh:mm'));
  sh.getRange(CPU_PRIMERA, col('ultimo_movimiento'), n, 1).setNumberFormat('dd/mm/yyyy');
  ['ingresos', 'gastos', 'saldo'].forEach(k => sh.getRange(CPU_PRIMERA, col(k), n, 1).setNumberFormat('"S/ "#,##0.00;"−S/ "#,##0.00'));
  sh.getRange(CPU_PRIMERA, col('telefono'), n, 1).setNumberFormat('@');
}

function cpuResumen_(lista) {
  const ss = SpreadsheetApp.getActive();
  const r = ss.getSheetByName(CPU_RESUMEN) || ss.insertSheet(CPU_RESUMEN);
  const ahora = new Date(), dia = 864e5;
  const cuenta = f => lista.filter(f).length;
  const conUso = k => cuenta(u => (u.usos || []).indexOf(k) >= 0);
  const filas = [
    ['Usuarios registrados', lista.length],
    ['Se registraron en la web', cuenta(u => u.origen === 'web')],
    ['Confirmaron su correo', cuenta(u => u.confirmado)],
    ['Registrados en los últimos 7 días', cuenta(u => ahora - new Date(u.registro) <= 7 * dia)],
    ['Registrados en los últimos 30 días', cuenta(u => ahora - new Date(u.registro) <= 30 * dia)],
    ['Activos en los últimos 7 días (con ingreso a la web)', cuenta(u => u.ultimo_ingreso && ahora - new Date(u.ultimo_ingreso) <= 7 * dia)],
    ['Con al menos un movimiento', cuenta(u => Number(u.movimientos) > 0)],
    ['Con atajo de iPhone', cuenta(u => u.atajo)],
    ['', ''],
    ['Por uso (una persona puede tener varios)', ''],
    ['Taxista', conUso('taxista')], ['Maestro de obra', conUso('obra')], ['Vendedor', conUso('vendedor')],
    ['Solo Personal', cuenta(u => (u.usos || []).length && (u.usos || []).every(x => x === 'personal'))],
    ['Sin uso elegido todavía', cuenta(u => !(u.usos || []).length)]
  ];
  r.clear();
  r.getRange(1, 1, 1, 2).merge().setValue('Caja Personal · Resumen de usuarios').setFontSize(16).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(CPU_MARCA.indigo).setFontFamily('Arial');
  r.getRange(2, 1, 1, 2).merge().setValue('Tu plata, en orden. · Actualizado ' + Utilities.formatDate(ahora, 'America/Lima', 'dd/MM/yyyy HH:mm')).setFontColor(CPU_MARCA.gris).setFontFamily('Arial');
  r.getRange(4, 1, filas.length, 2).setValues(filas).setFontFamily('Arial').setFontColor(CPU_MARCA.tinta);
  r.getRange(4, 2, filas.length, 1).setFontWeight('bold').setHorizontalAlignment('right');
  r.getRange(13, 1).setFontWeight('bold').setFontColor(CPU_MARCA.violeta);
  r.setColumnWidth(1, 330); r.setColumnWidth(2, 90); r.setRowHeight(1, 40);
}

function cpuPrepararHojas_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CPU_HOJA);
  if (sh && sh.getRange(CPU_FILA_CAB, 1).getValue() === 'ID') return sh;
  if (!sh) sh = ss.insertSheet(CPU_HOJA, 0);
  sh.clear();
  const n = CPU_COLS.length;
  sh.getRange(CPU_FILA_TITULO, 1, 1, n).merge().setValue('Caja Personal · Registro de usuarios')
    .setFontFamily('Arial').setFontSize(16).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(CPU_MARCA.indigo).setVerticalAlignment('middle');
  sh.setRowHeight(CPU_FILA_TITULO, 42);
  sh.getRange(2, 1, 1, n).merge().setFontFamily('Arial').setFontColor(CPU_MARCA.gris).setFontStyle('italic').setBackground(CPU_MARCA.fondo);
  const cab = sh.getRange(CPU_FILA_CAB, 1, 1, n);
  cab.setValues([CPU_COLS.map(c => c.t)]).setFontFamily('Arial').setFontWeight('bold').setFontColor('#FFFFFF').setBackground(CPU_MARCA.violeta).setWrap(true).setVerticalAlignment('middle');
  CPU_COLS.forEach((c, i) => { sh.setColumnWidth(i + 1, c.w); if (c.editable) sh.getRange(CPU_FILA_CAB, i + 1).setBackground(CPU_MARCA.verde); });
  sh.setRowHeight(CPU_FILA_CAB, 36);
  sh.setFrozenRows(CPU_FILA_CAB); sh.setFrozenColumns(2);
  const filas = sh.getMaxRows() - CPU_FILA_CAB;
  sh.getRange(CPU_PRIMERA, 1, filas, n).setFontFamily('Arial').setFontColor(CPU_MARCA.tinta);
  CPU_COLS.forEach((c, i) => { if (c.editable) sh.getRange(CPU_PRIMERA, i + 1, filas, 1).setBackground(CPU_MARCA.suave); });
  sh.getRange(CPU_PRIMERA, 1, filas, 1).setFontColor(CPU_MARCA.gris).setFontSize(8);
  sh.getRange(CPU_PRIMERA, 3, filas, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireNumberBetween(14, 120).setAllowInvalid(false).setHelpText('Edad entre 14 y 120').build());
  const col = k => CPU_COLS.findIndex(c => c.k === k) + 1;
  const reglas = [
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor(CPU_MARCA.gasto).setRanges([sh.getRange(CPU_PRIMERA, col('saldo'), filas, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor(CPU_MARCA.ingreso).setRanges([sh.getRange(CPU_PRIMERA, col('saldo'), filas, 1), sh.getRange(CPU_PRIMERA, col('ingresos'), filas, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('No').setFontColor(CPU_MARCA.pendiente).setRanges([sh.getRange(CPU_PRIMERA, col('confirmado'), filas, 1)]).build()
  ];
  sh.setConditionalFormatRules(reglas);
  sh.hideColumns(1);
  sh.getRange(CPU_FILA_CAB, 1, filas + 1, n).createFilter();
  return sh;
}

function cpuRpc_(fn, cuerpo) {
  const r = UrlFetchApp.fetch(CPU_URL + fn, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: CPU_KEY, Authorization: 'Bearer ' + CPU_KEY },
    payload: JSON.stringify(cuerpo)
  });
  const t = r.getContentText(), c = r.getResponseCode();
  if (c >= 300) { let m = t; try { m = JSON.parse(t).message || t; } catch (_) {} throw new Error(m); }
  return t ? JSON.parse(t) : null;
}

function cpuAviso_(t) { try { SpreadsheetApp.getActive().toast(t, 'Caja Personal', 8); } catch (_) {} }
