export default async function CheckoutSuccess({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;
  const validSession =
    typeof sessionId === "string"
    && sessionId.length <= 255
    && /^cs_[A-Za-z0-9_]+$/.test(sessionId);
  return (
    <main id="main-content">
      <h1>Subscription confirmed</h1>
      <p id="activation-instructions">
        Return to the DMOFT Pro application, sign in to the same account, and enter the Checkout
        Session identifier below. This page does not launch an application or transfer account
        credentials. The launch subscription allows up to three active registered device keys and
        does not include hybrid local transport.
      </p>
      {validSession ? (
        <section aria-describedby="activation-instructions" aria-labelledby="session-heading">
          <h2 id="session-heading">Checkout Session identifier</h2>
          <p>
            <code>{sessionId}</code>
          </p>
          <p>
            Run <code>dmoft-pro activate --checkout-session-id {sessionId}</code> with your billing
            server URL and OIDC access token configured.
          </p>
        </section>
      ) : (
        <p role="alert">
          The Checkout Session identifier is missing. Open the application and sign in again.
        </p>
      )}
    </main>
  );
}
