import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ---- Copia de _shared/entitlement.ts (Deno no comparte módulos entre deployments) ---- */
const ADMIN_EMAIL = "jesusgonzales0703@gmail.com";

// deno-lint-ignore no-explicit-any
async function esPremium(admin: any, userId: string, email?: string | null): Promise<boolean> {
  if (email && email.toLowerCase() === ADMIN_EMAIL) return true;

  const { data: sub } = await admin
    .from("subscriptions").select("status, current_period_end")
    .eq("user_id", userId).maybeSingle();
  if (sub && (sub.status === "active" || sub.status === "trialing")) {
    if (!sub.current_period_end || new Date(sub.current_period_end) > new Date()) return true;
  }

  const { data: canjes } = await admin
    .from("redemptions").select("code, created_at").eq("user_id", userId);
  if (canjes && canjes.length) {
    const codigos = canjes.map((c: { code: string }) => c.code);
    const { data: promos } = await admin
      .from("promo_codes").select("code, months, active, plan").in("code", codigos);
    for (const canje of canjes) {
      const promo = (promos || []).find((p: { code: string }) => p.code === canje.code);
      if (!promo || promo.active === false) continue;
      if (promo.plan && promo.plan !== "premium") continue;
      if (!promo.months) return true;
      const vence = new Date(canje.created_at);
      vence.setMonth(vence.getMonth() + promo.months);
      if (vence > new Date()) return true;
    }
  }

  const { data: refCode } = await admin
    .from("referral_codes").select("code").eq("owner_id", userId).maybeSingle();
  if (refCode?.code) {
    const { count } = await admin
      .from("referrals").select("*", { count: "exact", head: true })
      .eq("referrer_code", refCode.code);
    if ((count ?? 0) > 0) return true;
  }

  // Quien USA un código de referido gana 1 mes desde la fila en `referrals`.
  const { data: usado } = await admin
    .from("referrals").select("created_at").eq("referee_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (usado?.created_at) {
    const vence = new Date(usado.created_at);
    vence.setMonth(vence.getMonth() + 1);
    if (vence > new Date()) return true;
  }

  return false;
}
/* ------------------------------------------------------------------------- */

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ error: "no_key" });

    // Quién llama. verify_jwt ya exige un token válido, pero necesitamos el
    // id y el email reales para resolver el plan.
    const authHeader = req.headers.get("Authorization") ?? "";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user }, error: uerr } = await admin.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (uerr || !user) return json({ error: "unauthorized" }, 401);

    // El tope diario del cliente (index.html) es solo comodidad visual: quien
    // llame este endpoint directo lo ignora. La puerta real está aquí.
    if (!(await esPremium(admin, user.id, user.email))) {
      return json({ error: "premium_required" }, 402);
    }

    const { context, question, lang } = await req.json();
    if (!question || String(question).trim().length === 0) return json({ error: "empty" });
    const idioma = lang === "en" ? "English" : "Spanish";
    const sys = `You are Aurova's personal finance assistant. Answer in ${idioma}, warm, brief and practical (max ~120 words). Give concrete, actionable advice based on the user's data. Never invent numbers not present. Use the user's currency as shown.\n\nUser's financial snapshot:\n${String(context || "").slice(0, 4000)}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: sys,
        messages: [{ role: "user", content: String(question).slice(0, 1000) }],
      }),
    });
    const j = await r.json();
    if (j.error) return json({ error: j.error.message || "api_error" });
    const text = (j.content && j.content[0] && j.content[0].text) || "";
    return json({ text });
  } catch (e) {
    return json({ error: String(e) });
  }
});
