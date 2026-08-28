import Link from "next/link";
import { Brand } from "@/components/Brand";
import { Icon } from "@/components/Icon";
import { getProfile } from "@/lib/auth";
import { DEPARTMENTS } from "@/lib/departments";
import { SpatialEnvironment } from "@/components/os/SpatialEnvironment";

export const dynamic = "force-dynamic"; // the landing greets a signed-in staff member by session

/**
 * Staff entry point (this product has no public customer UI — customers talk to the
 * WhatsApp bot). EVERYONE lands here, from the owner to a driver, so the signed-out copy
 * addresses the reader at whatever level they work: your work, your call, your team.
 * Signed in: a personal strip that speaks to the actual role on the session.
 */
export default async function Home() {
  const profile = await getProfile().catch(() => null);
  const dept = profile ? DEPARTMENTS.find((d) => d.key === (profile.isAdmin ? "admin" : profile.department)) : null;
  const deptHome = dept?.nav[0]?.href ?? "/app";
  // Address the person who is actually signed in — an owner and a driver do not get the same line.
  const signedInLine = profile?.isAdmin
    ? "The whole business is in view. Pick up where you left off."
    : dept
      ? `${dept.label} — your work is ready and in order.`
      : "Your work is ready and in order.";

  return (
    <>
    <SpatialEnvironment />
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
            Your work, your call,<br />your team behind&nbsp;you.
          </h1>
          <p className="muted mt-3" style={{ fontSize: "1.02rem", maxWidth: 552 }}>
            Whether you run the company or run one part of it, you sign in and see exactly what is
            yours — nothing else to wade through. What is yours to decide reaches you with what you
            need to decide it. What is not goes to the person who holds it, and comes back settled.
          </p>

          {profile ? (
            <div className="continue-strip mt-4">
              <div>
                <div style={{ fontWeight: 800 }}>
                  Welcome back, {profile.fullName || profile.username}
                </div>
                <div className="small muted mt-1">{signedInLine}</div>
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
            <div className="k">Cleared this week</div>
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
            <div className="k">Working with you today</div>
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
        <p className="small mt-2 on-bg">
          Find yours above. You sign in and land straight on your own work — your administrator sets
          up the account and what it reaches.
        </p>
      </section>

      <section id="control" className="grid cols-3 mt-4">
        <div className="card">
          <div className="card-title row gap-1"><Icon name="clipboard" size={18} /> You always know where things stand</div>
          <p className="card-sub mt-1">Orders, invoices, payments, tasks, suppliers, contracts and vehicles sit in one place, with a trail of who changed what and when. No chasing people for an update, no wondering which version is the current one.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="shield" size={18} /> You know what is yours to decide</div>
          <p className="card-sub mt-1">Every approval has an owner and a limit. What sits within yours comes straight to you; what does not goes to the person who holds it. Nothing sensitive moves until someone with that authority decides — and it is recorded against their name.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="wallet" size={18} /> Numbers you can act on</div>
          <p className="card-sub mt-1">Exact double-entry books stand behind every figure you look at. Posted history is never quietly edited; corrections are made in the open, so what you see is what actually happened.</p>
        </div>
      </section>

      <section className="grid cols-2 mt-3">
        <div className="card">
          <div className="card-title row gap-1"><Icon name="shopping-cart" size={18} /> Less busywork, for everyone</div>
          <p className="card-sub mt-1">Customer WhatsApp messages become tracked orders and quotations without anyone retyping them. Your hours go to the customers who need a person — and an unclear price comes back as a one-tap confirmation instead of a hunt for whoever knows.</p>
        </div>
        <div className="card">
          <div className="card-title row gap-1"><Icon name="users" size={18} /> Everyone knows what is theirs</div>
          <p className="card-sub mt-1">Each person opens the system to their own work and nothing else. Nobody wades through someone else&apos;s queue, and nobody is left guessing about their own. The assistant reads, sorts and proposes — it never acts on its own, and it never decides for you.</p>
        </div>
      </section>

      <footer className="mt-4 dim small row wrap landing-foot">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/data-deletion">Data Deletion</Link>
      </footer>
    </main>
    </>
  );
}
