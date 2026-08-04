import Link from "next/link";
import { Brand } from "@/components/Brand";

export default function Home() {
  return (
    <main className="container" style={{ paddingTop: 28, paddingBottom: 48 }}>
      <header className="row between">
        <Brand size={34} />
        <Link href="/login" className="btn sm">Staff Login</Link>
      </header>

      <section className="card pad-lg mt-4" style={{ position: "relative", overflow: "hidden" }}>
        <div style={{ maxWidth: 620 }}>
          <span className="badge accent">Singha Business Control</span>
          <h1 style={{ fontSize: "2.6rem", marginTop: 16, lineHeight: 1.05 }}>
            Orders, quotations &amp; every department — in one AI-run control room.
          </h1>
          <p className="muted mt-3" style={{ fontSize: "1.05rem" }}>
            Customers message your WhatsApp; Singha collects their details, prepares a branded
            quotation, and routes any uncertain price to the right team for a one-tap confirmation.
            Finance, Sales and Marketing each get their own secure dashboard.
          </p>
          <div className="row gap-2 mt-4 wrap">
            <Link href="/login" className="btn">Sign in to your dashboard</Link>
            <a href="#how" className="btn ghost">How it works</a>
          </div>
        </div>
      </section>

      <section id="how" className="grid cols-3 mt-3">
        <div className="card">
          <div className="card-title">🛒 WhatsApp orders</div>
          <p className="card-sub mt-1">Every customer message becomes a tracked order and conversation.</p>
        </div>
        <div className="card">
          <div className="card-title">🧾 Auto quotations</div>
          <p className="card-sub mt-1">Priced from your catalog, on your Singha-branded template — sent automatically.</p>
        </div>
        <div className="card">
          <div className="card-title">👥 Department dashboards</div>
          <p className="card-sub mt-1">Admin creates logins; each employee sees only their department.</p>
        </div>
      </section>

      <footer className="mt-4 dim small row gap-2">
        <Link href="/privacy">Privacy</Link>·
        <Link href="/terms">Terms</Link>·
        <Link href="/data-deletion">Data Deletion</Link>
      </footer>
    </main>
  );
}
