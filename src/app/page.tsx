import Link from "next/link";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";
import { getProfile } from "@/lib/auth";
import { DEPARTMENTS } from "@/lib/departments";

export const dynamic = "force-dynamic"; // the landing greets a signed-in staff member by session

/**
 * Staff entry point (this product has no public customer UI — customers talk to the
 * WhatsApp bot). Signed out: what the reader controls and what their team handles for
 * them. Signed in: a personal "continue to YOUR department" strip using the real session.
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
          <a href="#control">What you control</a>
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
          <span className="eyebrow">Singha Central</span>
          <h1 className="mt-2">
            Your business,<br />under your&nbsp;control.
          </h1>
          <p className="muted mt-3" style={{ fontSize: "1.02rem", maxWidth: 540 }}>
            Sales, finance, operations, people, procurement, compliance and fleet — you see all of
            it from one place. Your team keeps the work moving, the routine handles itself, and
            anything that needs your authority reaches you with what you need to decide it.
          </p>

          {profile ? (
            <div className="continue-strip mt-4">
              <div>
                <div style={{ fontWeight: 800 }}>
                  Welcome back, {profile.fullName || profile.username}
                </div>
                <div className="small muted mt-1">
                  {dept ? `${dept.label} — your work is ready and in order.` : "Your work is ready and in order."}
                </div>
              </div>
              <Link href={deptHome} className="btn">Continue to {dept ? dept.label : "your workspace"}</Link>
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
            <div className="k">Cleared by your team this week</div>
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
            <div className="k">Waiting on your decision</div>
            <div className="row between">
              <div className="v">3</div>
              <span className="badge warn">your call</span>
            </div>
          </div>
          <div className="widget">
            <div className="k">Departments reporting in</div>
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
          <h2>Your whole team, in one place</h2>
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
          Every login is granted deliberately. Each person opens the system straight to their own
          work — nothing else to wade through.
        </p>
      </section>

      <section id="control" className="grid cols-3 mt-4">
        <div className="card">
          <div className="card-title row gap-1"><Icon name="clipboard" size={18} /> Nothing happens out of your sight</div>
          <p className="card-sub mt-1">Orders, invoices, payments, tasks, staff, suppliers, contracts and vehicles sit in one company-scoped record, with a trail of who changed what and when. You never have to ask around to find out where something stands.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="shield" size={18} /> Your limits, enforced for you</div>
          <p className="card-sub mt-1">You set who can approve what, and how far. Nothing sensitive moves until the person holding that authority decides — and the decision is recorded against their name.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="wallet" size={18} /> Numbers you can act on</div>
          <p className="card-sub mt-1">Exact double-entry books stand behind every figure you look at. Posted history is never quietly edited; corrections are made in the open, so what you see is what actually happened.</p>
        </div>
      </section>

      <section className="grid cols-2 mt-3">
        <div className="card">
          <div className="card-title row gap-1"><Icon name="shopping-cart" size={18} /> Your team stops doing busywork</div>
          <p className="card-sub mt-1">Customer WhatsApp messages become tracked orders and quotations without anyone retyping them. Your people spend their hours on the customers who need a person — and an unclear price comes back to you as a one-tap confirmation.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="users" size={18} /> Everyone knows what is theirs</div>
          <p className="card-sub mt-1">Each person signs in to their own work and nothing else. You keep the whole picture; they keep moving. The assistant reads, sorts and proposes — it never acts on its own, and it never decides for you.</p>
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
