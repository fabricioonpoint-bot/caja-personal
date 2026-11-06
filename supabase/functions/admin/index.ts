// Panel de administrador: crear cuentas, cambiar contraseñas, generar la clave de hoja de cada persona.
// Solo responde a usuarios que están en public.administradores.
const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

async function rpc(fn: string, body: unknown) {
  const r = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: "POST", headers: svc, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || "Error de base de datos");
  return d;
}
const passOk = (p: string) => typeof p === "string" && p.length >= 8 && /[A-Za-zÀ-ÿ]/.test(p) && /\d/.test(p);
const correoOk = (c: string) => typeof c === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // ¿Quién llama?
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const ur = await fetch(`${URL_BASE}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: `Bearer ${jwt}` } });
    if (!ur.ok) return json({ error: "Inicia sesión otra vez." }, 401);
    const yo = await ur.json();
    const ar = await fetch(`${URL_BASE}/rest/v1/administradores?user_id=eq.${yo.id}&select=user_id`, { headers: svc });
    if (!ar.ok || !(await ar.json()).length) return json({ error: "Solo el administrador puede hacer esto." }, 403);

    const { accion, ...p } = await req.json();

    if (accion === "listar") return json({ cuentas: await rpc("admin_cuentas", {}) });

    if (accion === "crear") {
      const nombre = String(p.nombre || "").trim(), correo = String(p.correo || "").trim().toLowerCase();
      if (!nombre) return json({ error: "Escribe el nombre." }, 400);
      if (!correoOk(correo)) return json({ error: "Escribe un correo válido." }, 400);
      if (!passOk(p.password)) return json({ error: "La contraseña necesita 8 caracteres o más, con letras y números." }, 400);
      const r = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
        method: "POST", headers: svc,
        body: JSON.stringify({ email: correo, password: p.password, email_confirm: true, user_metadata: { nombre } }),
      });
      const d = await r.json();
      if (!r.ok) {
        const m = String(d.msg || d.message || d.error_description || "");
        if (/already|registered|exists/i.test(m)) return json({ error: "Ese correo ya tiene una cuenta." }, 400);
        return json({ error: m || "No se pudo crear la cuenta." }, 400);
      }
      return json({ user_id: d.id, correo, nombre });
    }

    if (accion === "password") {
      if (!passOk(p.password)) return json({ error: "La contraseña necesita 8 caracteres o más, con letras y números." }, 400);
      const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${encodeURIComponent(p.user_id)}`, {
        method: "PUT", headers: svc, body: JSON.stringify({ password: p.password }),
      });
      if (!r.ok) return json({ error: "No se pudo cambiar la contraseña." }, 400);
      return json({ ok: true });
    }

    if (accion === "clave_hoja") return json({ clave: await rpc("generar_clave_hoja_usuario", { p_user: p.user_id }) });

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
