/**
 * Caja Personal · hoja de cálculo conectada en doble vía con la plataforma.
 * - Lo que se escribe o corrige en "Movimientos" se envía a la plataforma.
 * - Lo que entra por la web o el atajo del iPhone aparece aquí (cada minuto, o con "Traer ahora"),
 *   con quién lo registró, cuándo, y quién hizo el último cambio.
 * La clave de la persona se guarda en las propiedades del script, no en una celda.
 */
const SUPABASE_URL = 'https://uzukftcciyvvyukplqrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV6dWtmdGNjaXl2dnl1a3BscXJwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM4NDc2NDMsImV4cCI6MjEwOTQyMzY0M30.0taUv7gNulC9KeYek0w31012HIG4T8gBZ4RSIrlPIQI';
const HOJA = 'Movimientos', RESUMEN = 'Panel';
const COLS = ['ID', 'Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Descripción', 'Persona', 'Medio', 'Monto (S/)', 'Origen', 'Borrar', 'Estado', 'Registrado por', 'Registrado el', 'Última modificación'];
const C = { id: 1, fecha: 2, tipo: 3, cat: 4, sub: 5, desc: 6, persona: 7, medio: 8, monto: 9, origen: 10, borrar: 11, estado: 12, registro: 13, creado: 14, modificado: 15 };
const MEDIOS = ['Efectivo', 'Yape', 'Depósito', 'Transferencia', 'Cajero', 'Tarjeta'];
const VIOLETA = '#4C1D95', INDIGO = '#1E1B4B';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Caja Personal')
    .addItem('Conectar con la plataforma…', 'conectar')
    .addItem('Traer ahora de la plataforma', 'traer')
    .addItem('Enviar cambios ahora', 'enviarPendientes')
    .addItem('Crear o actualizar el panel', 'actualizarPanel')
    .addItem('Actualizar la conexión a la versión nueva', 'actualizarConexion')
    .addSeparator()
    .addItem('Desconectar esta hoja', 'desconectar')
    .addToUi();
}

/* ---------- Conexión ---------- */
function conectar() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Conectar con Caja Personal', 'Pega la clave de hoja que generó el administrador en la plataforma (empieza con "hojap_").', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const clave = r.getResponseText().trim();
  if (!/^hojap_[0-9a-f]{48}$/.test(clave)) { ui.alert('Esa clave no tiene el formato correcto.'); return; }
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('CLAVE', clave);
  try {
    preparar_(api_('hoja_leer', { p_clave: clave }));
    const env = enviar_();                       // sube a la plataforma lo que ya estaba escrito aquí
    if (env.errores) throw new Error(env.errores + ' fila(s) con datos incompletos: revisa la columna Estado y vuelve a conectar.');
    const datos = api_('hoja_leer', { p_clave: clave });
    escribirTodo_(datos);
    instalarDisparadores_();
    SpreadsheetApp.getActive().rename('Caja Personal – ' + (datos.nombre || datos.correo));
    ui.alert('Listo: hoja conectada con la cuenta de ' + (datos.nombre || datos.correo) + ' (' + datos.movimientos.length + ' movimientos).');
  } catch (e) {
    props.deleteProperty('CLAVE');
    ui.alert('No se pudo conectar: ' + e.message);
  }
}

function desconectar() {
  PropertiesService.getDocumentProperties().deleteProperty('CLAVE');
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  SpreadsheetApp.getUi().alert('Hoja desconectada. Los datos que ya están aquí se conservan.');
}

function instalarDisparadores_() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  const ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('alEditar').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('traerAuto').timeBased().everyMinutes(1).create();
}

/** Para hojas ya conectadas: pone las columnas nuevas, trae todo y sincroniza cada minuto. */
function actualizarConexion() {
  if (!clave_()) throw new Error('Esta hoja no está conectada. Usa "Conectar con la plataforma".');
  const pend = enviar_();
  if (pend.errores) throw new Error('Hay filas por corregir (columna Estado). Corrígelas y vuelve a intentarlo.');
  const datos = api_('hoja_leer', { p_clave: clave_() });
  preparar_(datos);
  escribirTodo_(datos);
  instalarDisparadores_();
  SpreadsheetApp.getActive().toast('Listo: sincroniza cada minuto y muestra quién registró cada movimiento.', 'Caja Personal', 6);
}

/* ---------- Plataforma ---------- */
function api_(fn, body) {
  const r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: SUPABASE_KEY }, payload: JSON.stringify(body),
  });
  const txt = r.getContentText();
  const d = txt ? JSON.parse(txt) : null;
  if (r.getResponseCode() >= 300) throw new Error((d && d.message) || ('Error ' + r.getResponseCode()));
  return d;
}
function clave_() { return PropertiesService.getDocumentProperties().getProperty('CLAVE'); }

/* ---------- Formato de la hoja ---------- */
function preparar_(datos) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(HOJA);
  if (!sh) sh = ss.insertSheet(HOJA, 0);
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(VIOLETA).setVerticalAlignment('middle');
  sh.setRowHeight(1, 32); sh.setFrozenRows(1);
  const n = sh.getMaxRows() - 1;
  sh.getRange(2, C.fecha, n).setNumberFormat('dd/mm/yyyy');
  sh.getRange(2, C.monto, n).setNumberFormat('"S/ "#,##0.00');
  const val = (lista) => SpreadsheetApp.newDataValidation().requireValueInList(lista, true).setAllowInvalid(true).build();
  sh.getRange(2, C.tipo, n).setDataValidation(val(['Ingreso', 'Gasto']));
  const cats = [...new Set([...(datos.categorias.Ingreso || []), ...(datos.categorias.Gasto || [])])];
  if (cats.length) sh.getRange(2, C.cat, n).setDataValidation(val(cats));
  sh.getRange(2, C.medio, n).setDataValidation(val(MEDIOS));
  sh.getRange(2, C.borrar, n).insertCheckboxes();
  sh.getRange(2, C.id, n).setFontColor('#9CA3AF').setFontSize(8);
  sh.getRange(2, C.origen, n).setFontColor('#6B7280');
  sh.getRange(2, C.estado, n).setFontColor('#6B7280');
  sh.getRange(2, C.registro, n, 3).setFontColor('#6B7280').setNumberFormat('@');
  [90, 92, 80, 170, 130, 240, 120, 110, 110, 80, 60, 140, 150, 125, 200].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setColumnWidth(C.id, 70);
  const rules = [
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$C2="Ingreso"').setFontColor('#047857').setRanges([sh.getRange(2, C.tipo, n, 1), sh.getRange(2, C.monto, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$C2="Gasto"').setFontColor('#BE123C').setRanges([sh.getRange(2, C.tipo, n, 1), sh.getRange(2, C.monto, n, 1)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(L_('=AND($L2<>"",$L2<>"Sincronizado",$L2<>"Pendiente")')).setBackground('#FDE4EA').setRanges([sh.getRange(2, 1, n, COLS.length)]).build(),
  ];
  sh.setConditionalFormatRules(rules);
  sh.getRange(1, 1, 1, COLS.length).setNote(null);
  sh.getRange(1, C.borrar).setNote('Marca la casilla para borrar el movimiento de la plataforma.');
  sh.getRange(1, C.estado).setNote('Sincronizado = igual que en la plataforma. Pendiente = se está enviando. Otro texto = hay que corregir la fila.');
  sh.getRange(1, C.id).setNote('Lo pone la plataforma. No lo cambies. Para un movimiento nuevo, déjalo vacío.');
  sh.getRange(1, C.registro).setNote('Lo pone la plataforma: quién registró el movimiento (su nombre, o "Hoja de cálculo" si se escribió aquí).');
  sh.getRange(1, C.modificado).setNote('Lo pone la plataforma: fecha y quién hizo el último cambio.');

  const rs = crearPanel_(ss, 'Caja Personal · ' + (datos.nombre || datos.correo || ''));
  // Solo quita pestañas vacías o la nota de la plantilla. Nunca borra una pestaña con datos (por ejemplo, la hoja original de la persona).
  ss.getSheets().forEach(s => {
    if ([HOJA, RESUMEN, CALC].indexOf(s.getName()) >= 0 || ss.getSheets().length <= 3) return;
    const vacia = s.getLastRow() === 0;
    const nota = s.getLastRow() === 1 && s.getLastColumn() === 1 && String(s.getRange(1, 1).getValue()).indexOf('PLANTILLA') === 0;
    if (vacia || nota) ss.deleteSheet(s);
  });
  ss.setActiveSheet(rs);
}

/* ---------- Panel: filtros, métricas, tablas y gráficos ---------- */
const CALC = '_calculos';
function crearPanel_(ss, titulo) {
  const M = "'" + HOJA + "'!";
  // Hoja auxiliar oculta: listas de filtros y movimientos filtrados (D:K = Fecha, Tipo, Categoría, Subcategoría, Descripción, Persona, Medio, Monto)
  let cx = ss.getSheetByName(CALC);
  if (!cx) cx = ss.insertSheet(CALC);
  cx.clear();
  cx.getRange('A1').setValue('Todo');
  cx.getRange('A2').setFormula(`=IFERROR(UNIQUE(ARRAYFORMULA(TEXT(SORT(FILTER(${M}B2:B,${M}B2:B<>"")),"mmmm yyyy"))),"")`);
  cx.getRange('B1').setValue('Todas');
  cx.getRange('B2').setFormula(`=IFERROR(SORT(UNIQUE(FILTER(${M}D2:D,${M}D2:D<>""))),"")`);
  cx.getRange('D1:K1').setValues([['Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Descripción', 'Persona', 'Medio', 'Monto']]);
  cx.hideSheet();

  let rs = ss.getSheetByName(RESUMEN);
  if (!rs) rs = ss.insertSheet(RESUMEN, 0);
  rs.getCharts().forEach(c => rs.removeChart(c));
  rs.clear(); rs.clearConditionalFormatRules(); rs.setHiddenGridlines(true);
  rs.getRange(1, 1, rs.getMaxRows(), rs.getMaxColumns()).setFontFamily('Plus Jakarta Sans').setVerticalAlignment('middle');
  [140, 170, 110, 140, 110, 80, 140, 110, 90, 140, 110, 90].forEach((w, i) => rs.setColumnWidth(i + 1, w));
  const S = '"S/ "#,##0.00', CL = '#6B7280';
  const titulo_ = (rng, txt) => rs.getRange(rng).setValue(txt).setFontFamily('Sora').setFontWeight('bold').setFontSize(12).setFontColor(INDIGO);
  const cab = (rng) => rs.getRange(rng).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(VIOLETA);

  // Encabezado
  rs.getRange('A1:L2').setBackground(INDIGO);
  rs.getRange('A1:L1').merge().setValue(titulo).setFontFamily('Sora').setFontSize(20).setFontWeight('bold').setFontColor('#FFFFFF');
  rs.getRange('A2:L2').merge().setValue('Panel de ingresos y gastos · se actualiza solo con la pestaña "Movimientos"').setFontColor('#C4B5FD');
  rs.setRowHeight(1, 46); rs.setRowHeight(2, 24); rs.setRowHeight(3, 10);

  // Filtros
  rs.getRange('A4:L5').setBackground('#F0EEF8');
  rs.getRange('A4').setValue('PERIODO').setFontSize(9).setFontWeight('bold').setFontColor(CL);
  rs.getRange('D4').setValue('CATEGORÍA').setFontSize(9).setFontWeight('bold').setFontColor(CL);
  const lista = (r) => SpreadsheetApp.newDataValidation().requireValueInRange(cx.getRange(r), true).setAllowInvalid(false).build();
  // Como texto: si no, Sheets convierte "noviembre 2026" en una fecha y el filtro la rechaza
  rs.getRange('B5').setNumberFormat('@'); rs.getRange('E5').setNumberFormat('@');
  rs.getRange('B5').setValue('Todo'); rs.getRange('E5').setValue('Todas');
  rs.getRange('B5').setDataValidation(lista('A1:A60')).setFontWeight('bold').setBackground('#FFFFFF').setBorder(true, true, true, true, false, false, VIOLETA, SpreadsheetApp.BorderStyle.SOLID);
  rs.getRange('E5').setDataValidation(lista('B1:B60')).setFontWeight('bold').setBackground('#FFFFFF').setBorder(true, true, true, true, false, false, VIOLETA, SpreadsheetApp.BorderStyle.SOLID);
  rs.getRange('A5').setValue('Elige ▸').setFontColor(CL).setHorizontalAlignment('right');
  rs.getRange('D5').setValue('Elige ▸').setFontColor(CL).setHorizontalAlignment('right');
  rs.getRange('G5:L5').merge().setValue('Cambia los filtros y todo el panel se recalcula. El saldo disponible siempre es el total.').setFontColor(CL).setFontSize(9).setWrap(true);
  rs.setRowHeight(5, 30); rs.setRowHeight(6, 12);

  // Métricas
  const F = "'" + CALC + "'!";
  const kpis = [
    ['SALDO DISPONIBLE', `=SUMIF(${M}C2:C,"Ingreso",${M}I2:I)-SUMIF(${M}C2:C,"Gasto",${M}I2:I)`, INDIGO],
    ['ENTRADAS', `=SUMIF(${F}E2:E,"Ingreso",${F}K2:K)`, '#047857'],
    ['SALIDAS', `=SUMIF(${F}E2:E,"Gasto",${F}K2:K)`, '#BE123C'],
    ['NETO DEL PERIODO', `=SUMIF(${F}E2:E,"Ingreso",${F}K2:K)-SUMIF(${F}E2:E,"Gasto",${F}K2:K)`, INDIGO],
    ['GASTO REAL', `=SUMIF(${F}E2:E,"Gasto",${F}K2:K)-SUMIFS(${F}K2:K,${F}E2:E,"Gasto",${F}F2:F,"Transferencia a mi cuenta")-SUMIFS(${F}K2:K,${F}E2:E,"Gasto",${F}F2:F,"Efectivo para mí")`, '#BE123C'],
    ['MOVIMIENTOS', `=IFERROR(ROWS(FILTER(${F}D2:D,${F}D2:D<>"")),0)`, INDIGO],
  ];
  // 6 tarjetas de 3 columnas cada una: 4 arriba y 2 abajo
  const pos = [['A7', 'A8'], ['D7', 'D8'], ['G7', 'G8'], ['J7', 'J8'], ['A10', 'A11'], ['D10', 'D11']];
  kpis.forEach((k, i) => {
    const [l, v] = pos[i];
    const lr = rs.getRange(l).offset(0, 0, 1, 3).merge(), vr = rs.getRange(v).offset(0, 0, 1, 3).merge();
    lr.setValue(k[0]).setFontSize(9).setFontWeight('bold').setFontColor(CL).setBackground('#FFFFFF');
    vr.setFormula(k[1]).setNumberFormat(k[0] === 'MOVIMIENTOS' ? '0' : S).setFontFamily('Sora').setFontSize(18).setFontWeight('bold').setFontColor(k[2]).setBackground('#FFFFFF');
    rs.getRange(l).offset(0, 0, 2, 3).setBorder(true, true, true, true, false, false, '#E4E1F0', SpreadsheetApp.BorderStyle.SOLID);
  });
  rs.getRange('G10:L11').merge().setValue('Gasto real = salidas sin contar las transferencias a tu cuenta ni el efectivo para ti (ese dinero sigue siendo tuyo).').setFontColor(CL).setFontSize(9).setWrap(true);
  rs.setRowHeight(7, 22); rs.setRowHeight(8, 34); rs.setRowHeight(9, 10); rs.setRowHeight(10, 22); rs.setRowHeight(11, 34); rs.setRowHeight(12, 14);

  // Tabla por mes + gráfico
  titulo_('A13', 'Entradas vs. salidas por mes');
  rs.getRange('A14:D14').setValues([['Mes', 'Entradas', 'Salidas', 'Neto']]); cab('A14:D14');
  rs.getRange('A15').setFormula(`=IFERROR(SORT(UNIQUE(FILTER(EOMONTH(${M}B2:B,-1)+1,${M}B2:B<>""))),"")`);
  // Una fórmula por fila (SUMIFS no se reparte fila por fila dentro de ARRAYFORMULA)
  for (let f = 15; f <= 26; f++) {
    rs.getRange('B' + f).setFormula(`=IF($A${f}="","",SUMIFS(${M}$I$2:$I,${M}$C$2:$C,"Ingreso",${M}$B$2:$B,">="&$A${f},${M}$B$2:$B,"<"&EDATE($A${f},1)))`);
    rs.getRange('C' + f).setFormula(`=IF($A${f}="","",SUMIFS(${M}$I$2:$I,${M}$C$2:$C,"Gasto",${M}$B$2:$B,">="&$A${f},${M}$B$2:$B,"<"&EDATE($A${f},1)))`);
    rs.getRange('D' + f).setFormula(`=IF($A${f}="","",B${f}-C${f})`);
  }
  rs.getRange('A15:A26').setNumberFormat('mmm yyyy'); rs.getRange('B15:D26').setNumberFormat(S);

  // Salidas por categoría
  titulo_('A29', 'Salidas por categoría');
  rs.getRange('A30').setFormula(`=IFERROR(QUERY(${F}D2:K,"select F, sum(K) where E = 'Gasto' group by F order by sum(K) desc label F 'Categoría', sum(K) 'Total'",0),"Sin salidas en este periodo")`);
  rs.getRange('C30').setValue('%');
  rs.getRange('C31').setFormula('=ARRAYFORMULA(IF(B31:B44="","",B31:B44/SUM(B31:B44)))');
  cab('A30:C30'); rs.getRange('B31:B44').setNumberFormat(S); rs.getRange('C31:C44').setNumberFormat('0.0%');

  // Entradas por origen
  titulo_('A47', 'Entradas por origen (FAB)');
  rs.getRange('A48').setFormula(`=IFERROR(QUERY(${F}D2:K,"select F, sum(K) where E = 'Ingreso' group by F order by sum(K) desc label F 'Origen', sum(K) 'Total'",0),"Sin entradas en este periodo")`);
  cab('A48:B48'); rs.getRange('B49:B60').setNumberFormat(S);

  // Por persona
  titulo_('D47', 'Salidas por persona');
  rs.getRange('D48').setFormula(`=IFERROR(QUERY(${F}D2:K,"select I, sum(K), count(K) where E = 'Gasto' and I <> '' group by I order by sum(K) desc label I 'Persona', sum(K) 'Total', count(K) 'Veces'",0),"Sin datos de personas")`);
  cab('D48:F48'); rs.getRange('E49:E60').setNumberFormat(S);

  // Por medio
  titulo_('H47', 'Por medio de pago');
  rs.getRange('H48').setFormula(`=IFERROR(QUERY(${F}D2:K,"select J, sum(K) where J <> '' group by J order by sum(K) desc label J 'Medio', sum(K) 'Total'",0),"Sin datos de medio")`);
  cab('H48:I48'); rs.getRange('I49:I60').setNumberFormat(S);

  // Mayores gastos
  titulo_('A63', 'Mayores gastos del periodo');
  rs.getRange('A64').setFormula(`=IFERROR(QUERY(${F}D2:K,"select D, H, F, K where E = 'Gasto' order by K desc limit 10 label D 'Fecha', H 'Descripción', F 'Categoría', K 'Monto'",0),"Sin gastos en este periodo")`);
  cab('A64:D64'); rs.getRange('A65:A74').setNumberFormat('dd/mm/yyyy'); rs.getRange('D65:D74').setNumberFormat(S);

  // Franjas suaves en las tablas
  [['A15:D26'], ['A31:C44'], ['A49:B60'], ['D49:F60'], ['H49:I60'], ['A65:D74']].forEach(([r]) => {
    const g = rs.getRange(r);
    rs.setConditionalFormatRules(rs.getConditionalFormatRules().concat(
      SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(L_(`=AND(ISEVEN(ROW()),${g.getCell(1, 1).getA1Notation()}<>"")`)).setBackground('#F7F6FC').setRanges([g]).build()));
  });

  // Gráficos
  const ch = (tipo, rango, fila, col, w, h, op) => {
    let b = rs.newChart().setChartType(tipo).setPosition(fila, col, 0, 0).setOption('width', w).setOption('height', h)
      .setNumHeaders(1).setOption('fontName', 'Plus Jakarta Sans').setOption('legend', { position: 'bottom' }).setOption('backgroundColor', '#FFFFFF');
    rango.forEach(r => b = b.addRange(rs.getRange(r)));
    Object.keys(op).forEach(k => b = b.setOption(k, op[k]));
    rs.insertChart(b.build());
  };
  ch(Charts.ChartType.COLUMN, ['A14:C26'], 13, 6, 620, 300, { title: 'Entradas vs. salidas', colors: ['#059669', '#E11D48'], vAxis: { format: '"S/ "#,##0' } });
  ch(Charts.ChartType.PIE, ['A30:B44'], 29, 5, 460, 300, { title: 'Salidas por categoría', pieHole: 0.5, colors: ['#4C1D95', '#7C3AED', '#A78BFA', '#0F766E', '#2DD4BF', '#E11D48', '#F59E0B', '#64748B'] });
  ch(Charts.ChartType.BAR, ['D48:E60'], 63, 6, 520, 280, { title: 'A quién se envía más', colors: ['#7C3AED'], legend: { position: 'none' } });

  // Datos filtrados (se escribe al final, cuando la pestaña Panel ya existe)
  cx.getRange('D2').setFormula(`=IFERROR(FILTER(${M}B2:I,${M}B2:B<>"",${M}C2:C<>"",('${RESUMEN}'!B5="Todo")+(TEXT(${M}B2:B,"mmmm yyyy")='${RESUMEN}'!B5),('${RESUMEN}'!E5="Todas")+(${M}D2:D='${RESUMEN}'!E5)),"")`);
  localizar_(rs); localizar_(cx);
  rs.setFrozenRows(5);
  return rs;
}

/* ---------- Traer (plataforma → hoja) ---------- */
function escribirTodo_(datos) {
  const sh = SpreadsheetApp.getActive().getSheetByName(HOJA);
  const filas = datos.movimientos.map(m => [m.id, parseFecha_(m.fecha), m.tipo, m.categoria, m.subcategoria || '', m.descripcion || '', m.persona || '', m.medio || '', Number(m.monto), m.origen, false, 'Sincronizado',
    m.registrado_nombre || '', m.registrado_el || '', m.modificado || '']);
  if (sh.getRange(1, COLS.length).getValue() !== COLS[COLS.length - 1])
    sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold').setFontColor('#FFFFFF').setBackground(VIOLETA);
  const ultima = sh.getLastRow();
  if (ultima > 1) {
    sh.getRange(2, 1, ultima - 1, COLS.length).clearContent();
    sh.getRange(2, C.borrar, ultima - 1).uncheck();
  }
  if (filas.length) sh.getRange(2, 1, filas.length, COLS.length).setValues(filas);
  const props = PropertiesService.getDocumentProperties();
  props.setProperty('ULTIMA', new Date().toISOString());
  props.setProperty('HUELLA', huella_(datos));
}
function huella_(datos) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(datos), Utilities.Charset.UTF_8));
}

function traer() {
  if (!clave_()) { SpreadsheetApp.getUi().alert('Primero usa "Conectar con la plataforma".'); return; }
  const lock = LockService.getDocumentLock(); if (!lock.tryLock(20000)) return;
  try {
    const pend = enviar_();               // nunca se pierde lo escrito en la hoja
    if (pend.errores) { SpreadsheetApp.getActive().toast('Hay filas por corregir (columna Estado). Lo demás está al día.', 'Caja Personal', 6); return; }
    escribirTodo_(api_('hoja_leer', { p_clave: clave_() }));
    SpreadsheetApp.getActive().toast('Hoja al día con la plataforma.', 'Caja Personal', 4);
  } finally { lock.releaseLock(); }
}
function traerAuto() {
  if (!clave_()) return;
  const lock = LockService.getDocumentLock(); if (!lock.tryLock(5000)) return;
  try {
    const pend = enviar_(); if (pend.errores) return;
    const datos = api_('hoja_leer', { p_clave: clave_() });
    // Solo reescribe si algo cambió en la plataforma (o si faltan o sobran filas en la hoja)
    const sh = SpreadsheetApp.getActive().getSheetByName(HOJA);
    const igual = PropertiesService.getDocumentProperties().getProperty('HUELLA') === huella_(datos)
      && Math.max(sh.getLastRow() - 1, 0) === datos.movimientos.length;
    if (!igual) escribirTodo_(datos);
  } finally { lock.releaseLock(); }
}

/* ---------- Enviar (hoja → plataforma) ---------- */
function alEditar(e) {
  const sh = e.range.getSheet();
  if (sh.getName() !== HOJA || e.range.getRow() < 2 || !clave_()) return;
  if (e.range.getColumn() >= C.estado) return;   // Estado y las columnas que pone la plataforma
  const r0 = e.range.getRow(), n = e.range.getNumRows();
  const est = sh.getRange(r0, C.estado, n).getValues();
  const filas = sh.getRange(r0, 1, n, COLS.length).getValues();
  for (let i = 0; i < n; i++) if (filas[i].slice(1, 9).some(v => v !== '' && v !== null) || filas[i][C.borrar - 1] === true) est[i][0] = 'Pendiente';
  sh.getRange(r0, C.estado, n).setValues(est);
  const lock = LockService.getDocumentLock(); if (!lock.tryLock(15000)) return;
  try { enviar_(); } finally { lock.releaseLock(); }
}

function enviarPendientes() {
  if (!clave_()) { SpreadsheetApp.getUi().alert('Primero usa "Conectar con la plataforma".'); return; }
  const r = enviar_();
  SpreadsheetApp.getActive().toast(r.enviadas ? (r.enviadas + ' fila(s) enviadas' + (r.errores ? ', ' + r.errores + ' por corregir' : '')) : 'No había cambios por enviar.', 'Caja Personal', 5);
}

function enviar_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(HOJA);
  const ultima = sh.getLastRow(); if (ultima < 2) return { enviadas: 0, errores: 0 };
  const datos = sh.getRange(2, 1, ultima - 1, COLS.length).getValues();
  const lote = [];
  datos.forEach((f, i) => {
    const vacia = f.slice(1, 9).every(v => v === '' || v === null);
    const nueva = !f[0] && !vacia;
    const pendiente = f[C.estado - 1] && f[C.estado - 1] !== 'Sincronizado';
    if (vacia && !f[0]) return;
    if (!(nueva || pendiente || f[C.borrar - 1] === true)) return;
    lote.push({ fila: i + 2, id: f[0] || null, borrar: f[C.borrar - 1] === true,
      fecha: fechaISO_(f[C.fecha - 1]), tipo: String(f[C.tipo - 1]).trim(), categoria: String(f[C.cat - 1]).trim(),
      subcategoria: String(f[C.sub - 1]).trim(), descripcion: String(f[C.desc - 1]).trim(), persona: String(f[C.persona - 1]).trim(),
      medio: String(f[C.medio - 1]).trim(), monto: numero_(f[C.monto - 1]) });
  });
  if (!lote.length) return { enviadas: 0, errores: 0 };
  const res = api_('hoja_guardar', { p_clave: clave_(), p_filas: lote });
  let errores = 0; const borrar = [];
  res.forEach(r => {
    if (r.estado === 'borrado') { borrar.push(r.fila); return; }
    if (r.estado === 'ok') {
      sh.getRange(r.fila, C.id).setValue(r.id);
      if (!sh.getRange(r.fila, C.origen).getValue()) sh.getRange(r.fila, C.origen).setValue('hoja');
      sh.getRange(r.fila, C.estado).setValue('Sincronizado');
    } else { errores++; sh.getRange(r.fila, C.estado).setValue(r.estado); }
  });
  borrar.sort((a, b) => b - a).forEach(f => sh.deleteRow(f));
  return { enviadas: lote.length, errores };
}

/* ---------- Utilidades ---------- */
function parseFecha_(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }
function fechaISO_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const s = String(v || '').trim(); if (!s) return '';
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2); }
  return s;
}
function numero_(v) {
  if (typeof v === 'number') return v;
  let s = String(v || '').replace(/S\/\.?|\s/gi, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const n = parseFloat(s); return isNaN(n) ? null : n;
}

/* ---------- Panel sin conexión (por ejemplo, antes de crear la cuenta) ---------- */
const CATEGORIAS_BASE = {
  Ingreso: ['Efectivo a cuenta', 'Depósitos / Yape a cuenta', 'Depósito a cuenta', 'Pago recibido', 'Transferencia recibida'],
  Gasto: ['Alimentos', 'Compras personales', 'Material de trabajo', 'Depósitos / Yape a terceros', 'Efectivo a terceros', 'Efectivo para mí', 'Transferencia a mi cuenta', 'Otros gastos'],
};
function actualizarPanel() {
  const ss = SpreadsheetApp.getActive();
  preparar_({ nombre: ss.getName().replace(/^Caja Personal – /, ''), categorias: CATEGORIAS_BASE });
  ss.toast('Panel listo.', 'Caja Personal', 4);
}

/* ---------- Idioma de la hoja ----------
 * En hojas en español (coma decimal) las fórmulas separan argumentos con ";" en vez de ",".
 * Se detecta una vez y se adaptan todas las fórmulas escritas por este script. */
let SEP_ = null;
function separador_() {
  if (SEP_) return SEP_;
  const ss = SpreadsheetApp.getActive();
  const t = ss.insertSheet('_prueba_sep');
  t.getRange('A1').setFormula('=SUM(1,2)');
  SpreadsheetApp.flush();
  SEP_ = t.getRange('A1').getValue() === 3 ? ',' : ';';
  ss.deleteSheet(t);
  return SEP_;
}
function L_(f) {
  if (separador_() === ',') return f;
  let out = '', enComillas = false;
  for (const ch of f) {
    if (ch === '"') enComillas = !enComillas;
    out += (ch === ',' && !enComillas) ? ';' : ch;
  }
  return out;
}
function localizar_(sh) {
  if (separador_() === ',') return;
  const r = sh.getDataRange(), fs = r.getFormulas();
  fs.forEach((fila, i) => fila.forEach((f, j) => { if (f) r.getCell(i + 1, j + 1).setFormula(L_(f)); }));
}
