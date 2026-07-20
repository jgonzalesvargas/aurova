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

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

async function upsertFromSub(sub: any, userId: string) {
  const founder = sub.metadata?.founder === "true";
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
  const plan = sub.metadata?.plan || (interval === "year" ? "annual" : "monthly");
  await admin.from("subscriptions").upsert({
    user_id: userId,
    status: sub.status,
    plan,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    current_period_end: sub.current_period_end
      ? new Date(sub.current_period_end * 1000).toISOString()
      : null,
    founder,
    updated_at: new Date().toISOString(),
  });
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  let event: any;
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw, sig!, webhookSecret, undefined, cryptoProvider,
    );
  } catch (e) {
    return new Response(`Bad signature: ${(e as any).message}`, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id || session.metadata?.user_id;
      if (session.subscription && userId) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        await upsertFromSub(sub, userId);
      }
    } else if (
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = event.data.object;
      const userId = sub.metadata?.user_id;
      if (userId) await upsertFromSub(sub, userId);
    }
  } catch (e) {
    return new Response(`Handler error: ${(e as any).message}`, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
