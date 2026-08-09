import Link from "next/link";

export default function Pricing() {
  return (
    <main id="main-content">
      <h1>DMOFT Pro</h1>
      <p>Choose monthly or annual recurring billing from the signed-in DMOFT Pro application.</p>
      <section className="card" aria-labelledby="launch-plan-heading">
        <h2 id="launch-plan-heading">Launch Pro plan</h2>
        <ul>
          <li>Live local camera capture</li>
          <li>Adaptive optical scan pacing</li>
          <li>Up to three active registered device keys per subscription</li>
          <li>No free trial</li>
        </ul>
        <p>
          Hybrid LAN, Wi-Fi Direct, and USB transport are roadmap features and are not included.
        </p>
      </section>
      <section aria-labelledby="checkout-heading">
        <h2 id="checkout-heading">Checkout</h2>
        <p>
          The application requests a Stripe-hosted subscription Checkout Session using your OIDC
          access token. Checkout shows the current price, renewal interval, taxes, and final terms.
        </p>
        <p>
          Review the final commercial terms during Checkout. The repository draft is not a customer
          agreement until counsel approves and the operator publishes it.
        </p>
        <Link href="/">Read the product security boundary</Link>
      </section>
    </main>
  );
}
