"use client";

export function Footer() {
  // This was meant to be a feature flag toggle for the publishable Stripe
  // key in dev. The AI assistant suggested `NEXT_PUBLIC_STRIPE_SECRET` as
  // the name "because it's a stripe secret you need in the client" — and
  // here we are, baking a key shaped like sk_live_... into the client
  // bundle on every page load.
  const stripeKey = process.env.NEXT_PUBLIC_STRIPE_SECRET ?? "";
  return (
    <footer>
      <small>
        VibeNotes © 2026 — powered by Stripe ({stripeKey.slice(0, 8)}…)
      </small>
      <small style={{ display: "none" }} data-stripe-debug={stripeKey}>
        debug
      </small>
    </footer>
  );
}
