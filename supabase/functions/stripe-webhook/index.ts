// stripe-webhook/index.ts
// Supabase Edge Function — handles Stripe payment confirmation & grants coins
// Deploy at: Supabase Dashboard → Edge Functions → stripe-webhook

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@13.10.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

// Use Supabase SERVICE ROLE key here — this runs server-side only, never in browser
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
  const body = await req.text();

  let event: Stripe.Event;

  try {
    // Verify the webhook came from Stripe — critical security check
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Only handle completed checkouts
  if (event.type !== "checkout.session.completed") {
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const { user_id, coins } = session.metadata ?? {};

  if (!user_id || !coins) {
    console.error("Missing metadata in session:", session.id);
    return new Response("Missing metadata", { status: 400 });
  }

  const coinsToAdd = parseInt(coins, 10);

  try {
    // Check this session hasn't already been processed (idempotency)
    const { data: existing } = await supabase
      .from("purchases")
      .select("id")
      .eq("stripe_session_id", session.id)
      .single();

    if (existing) {
      console.log("Session already processed:", session.id);
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }

    // Record the purchase
    await supabase.from("purchases").insert({
      user_id,
      stripe_session_id: session.id,
      coins: coinsToAdd,
      amount_cents: session.amount_total,
      created_at: new Date().toISOString(),
    });

    // Add coins to player's balance atomically
    const { error } = await supabase.rpc("add_coins", {
      p_user_id: user_id,
      p_coins: coinsToAdd,
    });

    if (error) throw error;

    console.log(`Granted ${coinsToAdd} coins to user ${user_id}`);
    return new Response(JSON.stringify({ received: true }), { status: 200 });

  } catch (err) {
    console.error("Failed to grant coins:", err);
    return new Response("Internal error", { status: 500 });
  }
});
