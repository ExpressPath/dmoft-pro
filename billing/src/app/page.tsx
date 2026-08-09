export default function Home() {
  return (
    <main id="main-content">
      <h1>DMOFT Pro licensing service</h1>
      <p>
        This service projects Stripe Billing Entitlements into short-lived,
        device-bound Ed25519 licenses. It does not receive optical frames or file contents.
      </p>
      <section className="card">
        <h2>Security boundary</h2>
        <p>
          Checkout and portal calls require an OIDC bearer token. Device activation proves
          possession of a raw Ed25519 public key. No email address is accepted as authentication.
        </p>
      </section>
      <section className="card" aria-labelledby="source-model-heading">
        <h2 id="source-model-heading">Public source, commercial production</h2>
        <p>
          DMOFT Pro source is publicly inspectable under BSL 1.1. Non-production evaluation is
          permitted; production use requires an active commercial subscription until the BSL
          Change Date.
        </p>
      </section>
    </main>
  );
}
