import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
