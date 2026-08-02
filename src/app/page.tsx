export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 720 }}>
      <h1>AI Finance System — Accounting Core v0</h1>
      <p>
        Event-driven, multi-company finance system. The permanent core (accounting
        engine, policy engine, financial-event intelligence) is built and tested.
        The WhatsApp webhook and AI transport activate after configuration — see{" "}
        <code>docs/interim-accounting/CONFIGURATION_GUIDE.md</code>.
      </p>
      <ul>
        <li>Webhook: <code>/api/webhooks/whatsapp</code></li>
        <li>Inngest: <code>/api/inngest</code></li>
      </ul>
    </main>
  );
}
