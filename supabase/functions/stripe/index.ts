import Stripe from "https://esm.sh/stripe@16?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FOUNDER_LIMIT = 100;
const PRICE_MONTHLY = 699;
const PRICE_ANNUAL = 5999;
const PRICE_ANNUAL_FOUNDER = 3999;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/* ---- Copia de _shared/entitlement.ts (cada función se despliega aparte) ---- */
const ADMIN_EMAIL = "jesusgonzales0703@gmail.com";

// deno-lint-ignore no-explicit-any
async function resolverEntitlement(userId: string, email?: string | null) {
  if (email && email.toLowerCase() === ADMIN_EMAIL) {
    return { premium: true, source: "admin", expira: null };
  }

  const { data: sub } = await admin
    .from("subscriptions").select("status, current_period_end")
    .eq("user_id", userId).maybeSingle();
  if (sub && (sub.status === "active" || sub.status === "trialing")) {
    if (!sub.current_period_end || new Date(sub.current_period_end) > new Date()) {
      return { premium: true, source: "stripe", expira: sub.current_period_end ?? null };
    }
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
      if (!promo.months) return { premium: true, source: "codigo", expira: null };
      const vence = new Date(canje.created_at);
      vence.setMonth(vence.getMonth() + promo.months);
      if (vence > new Date()) {
        return { premium: true, source: "codigo", expira: vence.toISOString() };
      }
    }
  }

  const { data: refCode } = await admin
    .from("referral_codes").select("code").eq("owner_id", userId).maybeSingle();
  if (refCode?.code) {
    const { count } = await admin
      .from("referrals").select("*", { count: "exact", head: true })
      .eq("referrer_code", refCode.code);
    if ((count ?? 0) > 0) return { premium: true, source: "referidos", expira: null };
  }

  // Quien USA un código de referido gana 1 mes, contado desde la fila en
  // `referrals` y no desde el planExpires que guardaba el cliente.
  const { data: usado } = await admin
    .from("referrals").select("created_at").eq("referee_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (usado?.created_at) {
    const vence = new Date(usado.created_at);
    vence.setMonth(vence.getMonth() + 1);
    if (vence > new Date()) {
      return { premium: true, source: "referidos", expira: vence.toISOString() };
    }
  }

  return { premium: false, source: "free", expira: null };
}
/* -------------------------------------------------------------------------- */

async function founderTaken(): Promise<number> {
  const { count } = await admin
    .from("subscriptions")
    .select("*", { count: "exact", head: true })
    .eq("founder", true);
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    const { data: { user }, error: uerr } = await admin.auth.getUser(jwt);
    if (uerr || !user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({} as any));
    const action = body.action;
    const origin = req.headers.get("origin") || Deno.env.get("APP_URL") || "https://aurova-lovat.vercel.app";

    // El cliente pregunta aquí si tiene Premium, en vez de creerle a
    // localStorage. Es la única fuente de verdad para la UI.
    if (action === "entitlement") {
      return json(await resolverEntitlement(user.id, user.email));
    }

    if (action === "prices") {
      const taken = await founderTaken();
      const founderAvailable = taken < FOUNDER_LIMIT;
      return json({
        monthly: PRICE_MONTHLY,
        annual: founderAvailable ? PRICE_ANNUAL_FOUNDER : PRICE_ANNUAL,
        annualRegular: PRICE_ANNUAL,
        founderAvailable,
        founderLeft: Math.max(0, FOUNDER_LIMIT - taken),
      });
    }

    const { data: subRow } = await admin
      .from("subscriptions").select("*").eq("user_id", user.id).maybeSingle();

    if (action === "portal") {
      if (!subRow?.stripe_customer_id) return json({ error: "no_customer" }, 400);
      const portal = await stripe.billingPortal.sessions.create({
        customer: subRow.stripe_customer_id,
        return_url: origin,
      });
      return json({ url: portal.url });
    }

    if (action === "checkout") {
      const plan = body.plan === "annual" ? "annual" : "monthly";

      let customerId = subRow?.stripe_customer_id as string | undefined;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { user_id: user.id },
        });
        customerId = customer.id;
        await admin.from("subscriptions").upsert({
          user_id: user.id,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        });
      }

      let isFounder = false;
      let unitAmount = PRICE_MONTHLY;
      let interval: "month" | "year" = "month";
      let name = "Aurova Premium (Mensual)";
      if (plan === "annual") {
        interval = "year";
        const taken = await founderTaken();
        isFounder = taken < FOUNDER_LIMIT;
        unitAmount = isFounder ? PRICE_ANNUAL_FOUNDER : PRICE_ANNUAL;
        name = isFounder ? "Aurova Premium (Anual — Fundador)" : "Aurova Premium (Anual)";
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: unitAmount,
            recurring: { interval },
            product_data: { name },
          },
        }],
        subscription_data: {
          metadata: { user_id: user.id, plan, founder: String(isFounder) },
        },
        metadata: { user_id: user.id, plan, founder: String(isFounder) },
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancel`,
      });
      return json({ url: session.url });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
