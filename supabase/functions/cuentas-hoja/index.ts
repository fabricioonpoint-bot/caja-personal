// Devuelve el registro de cuentas como CSV para Google Sheets (=IMPORTDATA).
// Hace su propia autenticación con la clave de la hoja; nunca devuelve contraseñas.
const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const COLS: [string, string][] = [
  ["nombre", "Nombre"], ["correo", "Correo"], ["cuenta_creada", "Cuenta creada"],
  ["correo_confirmado", "Correo confirmado"], ["ultimo_ingreso", "Último ingreso"],
  ["movimientos", "Movimientos"], ["total_ingresos", "Total ingresos (S/)"],
  ["total_gastos", "Total gastos (S/)"], ["saldo", "Saldo (S/)"],
  ["ultimo_movimiento", "Último movimiento"], ["atajo_iphone", "Atajo iPhone"],
];
const celda = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const clave = req.headers.get("x-clave-hoja") ?? url.searchParams.get("clave") ?? "";
  if (!clave) return new Response("Falta la clave", { status: 401 });
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/cuentas_hoja`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_clave: clave }),
  });
  if (!r.ok) return new Response("Clave no válida", { status: 403 });
  const filas: Record<string, unknown>[] = await r.json();
  const csv = [COLS.map(([, t]) => t).join(","), ...filas.map((f) => COLS.map(([k]) => celda(f[k])).join(","))].join("\n");
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
  });
});
