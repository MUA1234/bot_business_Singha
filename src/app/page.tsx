import Link from "next/link";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";
import { getProfile } from "@/lib/auth";
import { DEPARTMENTS } from "@/lib/departments";

export const dynamic = "force-dynamic"; // the landing greets a signed-in staff member by session

/**
 * Staff entry point (this product has no public customer UI — customers talk to the
 * WhatsApp bot). Signed out: a staff-facing overview of what their control room does.
 * Signed in: a personal "continue to YOUR department" strip using the real session.
 */
export default async function Home() {
  const profile = await getProfile().catch(() => null);
  const dept = profile ? DEPARTMENTS.find((d) => d.key === (profile.isAdmin ? "admin" : profile.department)) : null;
  const deptHome = dept?.nav[0]?.href ?? "/app";

  return (
    <main className="container" style={{ paddingTop: 12, paddingBottom: 48 }}>
      <nav className="landing-nav">
        <Brand size={30} />
        <div className="links">
          <a href="#departments">Departments</a>
          <a href="#how">How it works</a>
          <Link href="/privacy">Privacy</Link>
        </div>
        {profile ? (
          <Link href={deptHome} className="btn sm">Open dashboard</Link>
        ) : (
          <Link href="/login" className="btn sm">Staff Login</Link>
        )}
      </nav>

      <section className="card hero mt-2">
        <div className="flow-art" aria-hidden>
          <i className="f1" /><i className="f2" /><i className="f3" /><span className="ridge" />
        </div>

        <div style={{ position: "relative" }}>
          <span className="eyebrow">Singha Business Control</span>
          <h1 className="mt-2">
            Your whole business,<br />one agentic control&nbsp;room.
          </h1>
          <p className="muted mt-3" style={{ fontSize: "1.02rem", maxWidth: 520 }}>
            Customer WhatsApp messages become tracked orders and branded quotations on their own.
            You and your team step in only where judgement is needed — pricing confirmations,
            approvals, exceptions — each person inside their own department&apos;s secure dashboard.
          </p>

          {profile ? (
            <div className="continue-strip mt-4">
              <div>
                <div style={{ fontWeight: 800 }}>
                  Welcome back, {profile.fullName || profile.username}
                </div>
                <div className="small muted mt-1">
                  {dept ? `${dept.label} — your workspace is ready.` : "Your workspace is ready."}
                </div>
              </div>
              <Link href={deptHome} className="btn">Continue to {dept ? dept.label : "your dashboard"}</Link>
            </div>
          ) : (
            <div className="row gap-2 mt-4 wrap">
              <Link href="/login" className="btn">Sign in to your workspace</Link>
              <a href="#departments" className="btn ghost">Find your department</a>
            </div>
          )}
        </div>

        <div className="device" aria-hidden>
          <div className="titlebar">
            <span className="row gap-1 small dim"><span className="dot" /> Command Centre — live</span>
            <span className="badge">today</span>
          </div>
          <div className="widget">
            <div className="k">Quotations sent this week</div>
            <div className="row between" style={{ alignItems: "flex-end" }}>
              <div className="v">18</div>
              {/* decorative single-hue mini bars: thin marks, rounded data ends */}
              <svg width="132" height="44" viewBox="0 0 132 44" role="presentation">
                {[14, 22, 12, 28, 20, 34, 26].map((h, i) => (
                  <rect key={i} x={i * 19} y={44 - h} width="8" height={h} rx="4"
                    fill="var(--accent)" opacity={i === 5 ? 1 : 0.45} />
                ))}
              </svg>
            </div>
          </div>
          <div className="widget">
            <div className="k">Awaiting a human decision</div>
            <div className="row between">
              <div className="v">3</div>
              <span className="badge warn">price confirmations</span>
            </div>
          </div>
          <div className="widget">
            <div className="k">Departments online</div>
            <div className="row gap-1 wrap mt-1">
              {["Sales", "Finance", "Ops", "HR"].map((d) => (
                <span key={d} className="badge">{d}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="departments" className="mt-4">
        <div className="row between mt-2" style={{ marginBottom: 12 }}>
          <h2>Built for each person on the team</h2>
        </div>
        <div className="dept-grid">
          {DEPARTMENTS.map((d) => (
            <Link key={d.key} href="/login" className="dept-chip">
              <span className="ic"><Icon name={d.icon} size={17} /></span>
              <span>
                <span className="t" style={{ display: "block" }}>{d.label}</span>
                <span className="s" style={{ display: "block" }}>{d.description}</span>
              </span>
            </Link>
          ))}
        </div>
        <p className="dim small mt-2">
          Your admin creates your login. You see your department — nothing else.
        </p>
      </section>

      <section id="how" className="grid cols-3 mt-4">
        <div className="card">
          <div className="card-title row gap-1"><Icon name="shopping-cart" size={18} /> WhatsApp orders</div>
          <p className="card-sub mt-1">Every customer message becomes a tracked order and conversation — nothing typed twice.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="file-text" size={18} /> Auto quotations</div>
          <p className="card-sub mt-1">Priced from your catalog on the Singha template. Uncertain prices route to a person for one-tap confirmation.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="shield" size={18} /> Human-controlled AI</div>
          <p className="card-sub mt-1">The AI observes and proposes. Money, approvals and anything sensitive always wait for a person with the authority.</p>
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
