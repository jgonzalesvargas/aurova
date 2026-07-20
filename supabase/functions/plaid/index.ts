import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* ---- Copia de _shared/entitlement.ts (cada función se despliega aparte) ---- */
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
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const CID = Deno.env.get("PLAID_CLIENT_ID");
    const SECRET = Deno.env.get("PLAID_SECRET");
    const ENV = Deno.env.get("PLAID_ENV") || "sandbox";
    if (!CID || !SECRET) return json({ error: "no_keys" });
    const PBASE = `https://${ENV}.plaid.com`;

    const authHeader = req.headers.get("Authorization") || "";
    const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Conectar bancos es de pago y Plaid factura por conexión y por sync. El
    // candado del cliente (openBancos) no basta: cualquiera puede llamar esto
    // desde la consola del navegador con una cuenta gratis.
    if (!(await esPremium(admin, user.id, user.email))) {
      return json({ error: "premium_required" }, 402);
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const plaid = (path: string, payload: Record<string, unknown>) =>
      fetch(PBASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CID, secret: SECRET, ...payload }) }).then((r) => r.json());

    if (action === "link_token") {
      const r = await plaid("/link/token/create", { user: { client_user_id: user.id }, client_name: "Aurova", products: ["transactions"], country_codes: ["US"], language: body.lang === "es" ? "es" : "en" });
      if (r.error) return json({ error: r.error_message || "plaid_error" });
      return json({ link_token: r.link_token });
    }
    if (action === "exchange") {
      const ex = await plaid("/item/public_token/exchange", { public_token: body.public_token });
      if (ex.error) return json({ error: ex.error_message || "exchange_error" });
      await admin.from("plaid_items").insert({ user_id: user.id, item_id: ex.item_id, access_token: ex.access_token, institution: body.institution || "" });
      return json({ ok: true });
    }
    if (action === "list") {
      const { data } = await admin.from("plaid_items").select("id, institution, created_at").eq("user_id", user.id).order("created_at");
      return json({ items: data || [] });
    }
    if (action === "remove") {
      const { data: item } = await admin.from("plaid_items").select("access_token").eq("id", body.id).eq("user_id", user.id).maybeSingle();
      if (item?.access_token) await plaid("/item/remove", { access_token: item.access_token });
      await admin.from("plaid_items").delete().eq("id", body.id).eq("user_id", user.id);
      return json({ ok: true });
    }
    if (action === "sync") {
      const { data: items } = await admin.from("plaid_items").select("*").eq("user_id", user.id);
      const out: unknown[] = [];
      for (const it of (items || [])) {
        let cursor = it.cursor || null; let hasMore = true; let guard = 0; const added: any[] = [];
        while (hasMore && guard++ < 10) {
          const r = await plaid("/transactions/sync", { access_token: it.access_token, cursor: cursor || undefined });
          if (r.error) { hasMore = false; break; }
          added.push(...(r.added || []));
          cursor = r.next_cursor; hasMore = r.has_more;
        }
        await admin.from("plaid_items").update({ cursor }).eq("id", it.id);
        for (const t of added) out.push({ id: "plaid_" + t.transaction_id, date: t.date, amount: t.amount, name: t.name, category: (t.personal_finance_category && t.personal_finance_category.primary) || "", institution: it.institution });
      }
      return json({ transactions: out });
    }
    return json({ error: "unknown_action" });
  } catch (e) { return json({ error: String(e) }); }
});
