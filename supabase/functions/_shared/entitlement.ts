/**
 * Fuente de verdad de "¿este usuario tiene Premium?".
 *
 * Vive en el servidor a propósito. Antes el cliente decidía solo, leyendo
 * `state.profile.plan` de localStorage: cualquiera podía darse Premium
 * editando datos en su navegador, y peor, las Edge Functions que CUESTAN
 * dinero (ai-chat → Anthropic, plaid → Plaid) no comprobaban nada.
 *
 * Se copia en cada función porque cada una se despliega por separado; Deno
 * no comparte módulos entre deployments distintos.
 */

export type Entitlement = {
  premium: boolean;
  source: "admin" | "stripe" | "codigo" | "referidos" | "free";
  expira: string | null;
};

const ADMIN_EMAIL = "jesusgonzales0703@gmail.com";

// deno-lint-ignore no-explicit-any
export async function resolverEntitlement(
  admin: any,
  userId: string,
  email?: string | null,
): Promise<Entitlement> {
  // 1. Dueño de la app.
  if (email && email.toLowerCase() === ADMIN_EMAIL) {
    return { premium: true, source: "admin", expira: null };
  }

  // 2. Suscripción de Stripe. La llena el webhook con firma verificada.
  const { data: sub } = await admin
    .from("subscriptions").select("status, current_period_end")
    .eq("user_id", userId).maybeSingle();
  if (sub && (sub.status === "active" || sub.status === "trialing")) {
    const vigente = !sub.current_period_end ||
      new Date(sub.current_period_end) > new Date();
    if (vigente) {
      return { premium: true, source: "stripe", expira: sub.current_period_end ?? null };
    }
  }

  // 3. Código promocional canjeado. La vigencia se calcula desde la fecha
  //    del canje + los meses del código, no desde un dato del cliente.
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

  // 4. Referidos: con al menos uno, Premium.
  const { data: refCode } = await admin
    .from("referral_codes").select("code").eq("owner_id", userId).maybeSingle();
  if (refCode?.code) {
    const { count } = await admin
      .from("referrals").select("*", { count: "exact", head: true })
      .eq("referrer_code", refCode.code);
    if ((count ?? 0) > 0) {
      return { premium: true, source: "referidos", expira: null };
    }
  }

  // 5. Quien USA un código de referido gana 1 mes. Se cuenta desde la fila en
  //    `referrals`, no desde el planExpires que guardaba el cliente.
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
