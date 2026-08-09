export default function Account() {
  return (
    <main id="main-content">
      <h1>DMOFT Pro account</h1>
      <p>
        Manage payment methods, invoices, plan interval, and cancellation through the Customer
        Portal link created by the signed-in application.
      </p>
      <section className="card" aria-labelledby="device-management-heading">
        <h2 id="device-management-heading">Registered devices</h2>
        <p>
          The launch Pro plan supports up to three active device keys. Add devices only through the
          authenticated application enrollment flow; never share a device private key or token.
        </p>
      </section>
    </main>
  );
}
