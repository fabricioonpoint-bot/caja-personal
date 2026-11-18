/**
 * Apuntes del auto en doble vía (hoja "Control general de gastos personales" de Fabricio).
 *
 * Va en el mismo proyecto de Apps Script que Código.gs (usa AUTO_SYNC y sincronizarAuto de ahí)
 * y que ControlGeneral.gs (que llama a cpAlRecibir y cpDespuesDeRecibir).
 *
 * Antes: los "Apuntes de ingresos y gastos de Auto" mandan → cada celda (día × ID/UBER/CAB/…) es una
 * fila AP-AUTO-… en MOVIMIENTOS, y de ahí pasa a la plataforma.
 * Ahora también al revés:
 *  1. Un ingreso o gasto del taxi registrado en la plataforma (o escrito a mano en MOVIMIENTOS con
 *     ámbito Auto) se suma en su celda de la pestaña del mes en los apuntes. La fila original se quita,
 *     porque sincronizarAuto la vuelve a crear como AP-AUTO-… (así no se cuenta dos veces).
 *     RESUMEN AUTO y BASE ANUAL AUTO se actualizan solas con sus fórmulas.
 *  2. Si en la plataforma se cambia el monto de una fila AP-AUTO-… o se borra, la celda de los apuntes
 *     toma ese monto o se vacía (si no, la siguiente sincronización la devolvería a como estaba).
 */
const AUTO_DV_ING = { 'ID': 1, 'INDRIVE': 1, 'UBER': 2, 'CAB': 3, 'CABIFY': 3, 'OTROS INGRESOS': 4 };
const AUTO_DV_GAS = {
  'COMBUSTIBLE': 1, 'GASOLINA': 1, 'GNV': 1, 'GLP': 1, 'MECÁNICO': 2, 'MECANICO': 2,
  'ARREGLOS': 3, 'MANTENIMIENTO': 3, 'MANTENIMIENTO Y ARREGLOS': 3, 'LAVADO': 4, 'LAVADO DE CARRO': 4,
  'COCHERA': 5, 'PARQUEO': 5, 'SEGURO': 6, 'SEGURO / IMPUESTOS': 6, 'SEGURO Y SOAT': 6, 'OTROS': 7, 'OTROS GASTOS': 7,
};
const AUTO_DV_KEY = /^AP-AUTO-2026(\d{2})(\d{2})-([IG])([1-7])$/;
const AUTO_DV_PEND = 'AUTO_DV_PENDIENTES';

/** Lo llama el conector de la plataforma por cada fila que llega ('cambio') o se quita ('quitado'). */
function cpAlRecibir(tipo, ref) {
  if (!AUTO_DV_KEY.test(String(ref))) return;
  const p = PropertiesService.getDocumentProperties();
  const l = JSON.parse(p.getProperty(AUTO_DV_PEND) || '{}');
  l[ref] = tipo;
  p.setProperty(AUTO_DV_PEND, JSON.stringify(l));
}
/** Y esto, cuando la sincronización con la plataforma trajo o quitó algo: se pasa a los apuntes de una vez. */
function cpDespuesDeRecibir() { sincronizarAuto(); }

/**
 * Se ejecuta dentro de sincronizarAuto, con el candado tomado y antes de leer los apuntes.
 * source: hoja de apuntes. m: pestaña MOVIMIENTOS del control general.
 */
function autoVolcarAApuntes_(source, m) {
  const props = PropertiesService.getDocumentProperties();
  const pend = JSON.parse(props.getProperty(AUTO_DV_PEND) || '{}');
  const cab = m.getRange('A5:AE5').getValues()[0].map(h => String(h).trim());
  const C = {};
  ['ID', 'Fecha', 'Movimiento', 'Categoría', 'Ámbito', 'Monto', 'Estado', 'Nota', 'Km recorridos', 'Horas', 'Es prueba'].forEach(h => {
    C[h] = cab.indexOf(h);
    if (C[h] < 0) throw new Error('Falta la columna ' + h + ' en MOVIMIENTOS. No se pasó nada a los apuntes.');
  });
  const rows = m.getRange('A6:AE3000').getValues();
  const legado = new Set(Object.values(AUTO_SYNC.aliases));
  const mesNombre = {};
  Object.keys(AUTO_SYNC.months).forEach(n => { mesNombre[AUTO_SYNC.months[n]] = n; });

  const hojas = {};
  const hoja = mes => {
    if (!hojas[mes]) {
      const s = source.getSheetByName(mesNombre[mes]);
      if (!s) throw new Error('Falta la pestaña ' + mesNombre[mes] + ' en los apuntes.');
      const a = s.getRange('A1:J78').getValues();
      if (a[8][0] !== 'Día' || a[8][1] !== 'ID' || a[8][2] !== 'UBER' || a[8][3] !== 'CAB' || a[8][4] !== 'Otros ingresos' ||
          a[8][6] !== 'Km recorridos' || a[44][0] !== 'Día' || a[44][9] !== 'Notas')
        throw new Error('Cambió la plantilla de ' + mesNombre[mes] + '. No se pasó nada a los apuntes.');
      hojas[mes] = s;
    }
    return hojas[mes];
  };
  // Filas de la pestaña del mes (desde 1): ingresos del día d en d+9, gastos en d+45. Columna B = 2.
  const sumar = (rg, v) => {
    const f = rg.getFormula();
    if (f) rg.setFormula(f + '+' + v);
    else rg.setValue(Math.round(((Number(rg.getValue()) || 0) + v) * 100) / 100);
  };
  const anotar = (s, fila, txt) => {
    const rg = s.getRange(fila, 10), x = String(rg.getValue() || '');
    if (txt && x.indexOf(txt) < 0) rg.setValue(x ? x + ' | ' + txt : txt);
  };
  const num = v => (typeof v === 'number' && isFinite(v) ? v : Number(String(v).replace(',', '.')) || 0);

  // 1) Registros del taxi que no vienen de los apuntes → se suman en su celda y la fila se quita
  const quitar = [];
  let movidos = 0;
  rows.forEach((r, i) => {
    const id = String(r[C['ID']] || '').trim();
    if (!id || /^AP-AUTO-/.test(id) || /^AUT-/.test(id) || legado.has(id)) return;
    if (r[C['Ámbito']] !== 'Auto' || r[C['Estado']] === 'Anulado' || r[C['Es prueba']] === true) return;
    const tipo = r[C['Movimiento']];
    if (tipo !== 'Ingreso' && tipo !== 'Gasto') return;
    if (!(r[C['Fecha']] instanceof Date)) return;
    const [y, mes, d] = Utilities.formatDate(r[C['Fecha']], 'America/Lima', 'yyyy-M-d').split('-').map(Number);
    if (y !== 2026 || !mesNombre[mes]) return;
    const monto = Math.round(num(r[C['Monto']]) * 100) / 100;
    if (!(monto > 0)) return;
    const cat = String(r[C['Categoría']] || '').trim(), CAT = cat.toUpperCase();
    const s = hoja(mes);
    if (tipo === 'Ingreso') {
      const fila = d + 9;
      sumar(s.getRange(fila, (AUTO_DV_ING[CAT] || 4) + 1), monto);
      if (num(r[C['Km recorridos']]) > 0) sumar(s.getRange(fila, 7), num(r[C['Km recorridos']]));
      if (num(r[C['Horas']]) > 0) sumar(s.getRange(fila, 8), num(r[C['Horas']]));
      if (!AUTO_DV_ING[CAT]) anotar(s, fila, cat + ' S/ ' + monto);
      anotar(s, fila, String(r[C['Nota']] || '').trim());
    } else {
      const fila = d + 45;
      sumar(s.getRange(fila, (AUTO_DV_GAS[CAT] || 7) + 1), monto);
      if (!AUTO_DV_GAS[CAT]) anotar(s, fila, cat + ' S/ ' + monto);
      anotar(s, fila, String(r[C['Nota']] || '').trim());
    }
    quitar.push(i + 6);
    movidos++;
  });

  // 2) Cambios y borrados hechos en la plataforma sobre filas que ya venían de los apuntes
  const filaDe = {};
  rows.forEach((r, i) => { const id = String(r[C['ID']] || '').trim(); if (id) filaDe[id] = i; });
  let copiados = 0;
  Object.keys(pend).forEach(ref => {
    const k = AUTO_DV_KEY.exec(ref);
    if (!k || !mesNombre[Number(k[1])]) return;
    const s = hoja(Number(k[1])), d = Number(k[2]), fila = k[3] === 'I' ? d + 9 : d + 45, col = Number(k[4]) + 1;
    const r = filaDe[ref] === undefined ? null : rows[filaDe[ref]];
    const borrado = !r || pend[ref] === 'quitado' || r[C['Estado']] === 'Anulado';
    s.getRange(fila, col).setValue(borrado ? '' : Math.round(num(r[C['Monto']]) * 100) / 100);
    if (!borrado && k[3] === 'I') {
      if (num(r[C['Km recorridos']]) > 0) s.getRange(fila, 7).setValue(num(r[C['Km recorridos']]));
      if (num(r[C['Horas']]) > 0) s.getRange(fila, 8).setValue(num(r[C['Horas']]));
    }
    copiados++;
  });

  quitar.forEach(f => m.getRange(f, 1, 1, 31).clearContent());
  if (Object.keys(pend).length) props.deleteProperty(AUTO_DV_PEND);
  if (movidos || copiados) SpreadsheetApp.flush();
  return { movidos: movidos, copiados: copiados };
}
