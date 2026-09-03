/**
 * A `SupabaseClient`-shaped client backed by a direct pg connection (remediation R1 §7).
 *
 * WHY THIS EXISTS. The extreme end-to-end paths have to run the REAL production modules — the
 * adapter, `recordInboundReceipt`, `dispatchReceipt`, the drain, the sweeper, the finance capture
 * processor, `processSourceEvent`, the consumer store — against the REAL database functions. Those
 * modules take a Supabase client and there is no Supabase server here, so the ONE substitution is
 * the HTTP transport: every call lands on the same SQL it would have reached over PostgREST.
 *
 * It is deliberately small and deliberately STRICT. An unsupported operator throws rather than
 * silently returning everything, because a shim that quietly widens a filter would make a
 * company-isolation test pass for the wrong reason.
 *
 * Supported: .rpc(fn, args); .from(t).select().eq().neq().in().not().gt().gte().lt().lte()
 * .order() (repeatable — compound, in call order) .limit()
 * .single().maybeSingle(); .insert(row|rows).select().single(); .update(patch).eq()….select().
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import pgDriver from "pg";

/**
 * Return date/time columns as STRINGS, exactly as PostgREST does.
 *
 * node-pg parses timestamptz into a JavaScript Date, which holds MILLISECONDS. PostgreSQL
 * stores MICROSECONDS, and supabase-js hands the application the raw ISO string with all six
 * digits. The shim was therefore lower-fidelity than production in the direction that HIDES
 * defects: a compound keyset cursor built from a Date is truncated, its equality test against
 * the true stored value matches nothing, and the sweep re-reads rows instead of advancing
 * (R2S-P-F-002).
 *
 * This is the same class as R2S-F-005 — a test double whose types disagreed with the real
 * client — so the fix is to make the double faithful rather than to accommodate it.
 *
 *   1184 timestamptz   1114 timestamp   1082 date
 */
for (const oid of [1184, 1114, 1082]) {
  pgDriver.types.setTypeParser(oid, (v: string) => v);
}

type Row = Record<string, any>;
type Filter = { sql: string; params: any[]; col?: string; bindKind?: Kind };

export interface PgLike {
  query(sql: string, params?: any[]): Promise<{ rows: Row[] }>;
}

/**
 * Column-kind cache, keyed on the CLIENT, not on a bare table name.
 *
 * It was a module-level `Map<table, …>`: process-global, never invalidated, and shared across
 * connections AND databases. Harmless while every database in a run has the same schema, wrong the
 * moment a staged-migration test opens a second one in the same process — which this suite does.
 */
const columnKinds = new WeakMap<PgLike, Map<string, Map<string, Kind>>>();

async function kindsFor(db: PgLike, table: string): Promise<Map<string, Kind>> {
  let perDb = columnKinds.get(db);
  if (!perDb) { perDb = new Map(); columnKinds.set(db, perDb); }
  const hit = perDb.get(table);
  if (hit) return hit;
  const { rows } = await db.query(
    `select a.attname as col,
            case when t.typtype = 'b' and t.typcategory = 'A' then 'array'
                 when t.typname in ('json','jsonb') then 'json'
                 else 'scalar' end as kind
       from pg_attribute a
       join pg_type t on t.oid = a.atttypid
      where a.attrelid = ('public.' || quote_ident($1))::regclass
        and a.attnum > 0 and not a.attisdropped`,
    [table],
  );
  const m = new Map<string, Kind>(rows.map((r) => [String(r.col), r.kind as Kind]));
  perDb.set(table, m);
  return m;
}

/**
 * Cache of resolved RPC signatures, keyed by function name and the exact parameter set.
 *
 * Without this the shim asked `pg_proc` and `pg_type` on EVERY `.rpc()` call. Measured on a
 * 400-row fixture that was 866 of 2,074 statements in one management cycle — 42% of the
 * database work, spent re-deriving a signature that had not changed. It is invisible in
 * production, where PostgREST resolves the signature itself, so it inflated only test
 * wall-clock — which is exactly the kind of cost that gets mistaken for a product regression.
 *
 * Keyed on the parameter set as well as the name, so overload resolution stays exact: two
 * calls to the same function with different named arguments resolve independently, which is
 * the property the `@>` match above exists to preserve.
 */
const argKindCache = new WeakMap<PgLike, Map<string, Map<string, Kind>>>();

/** Parameter kinds for an RPC, resolved from the function's declared argument types. */
async function argKinds(db: PgLike, fn: string, names: string[]): Promise<Map<string, Kind>> {
  if (!names.length) return new Map();

  let perDb = argKindCache.get(db);
  if (!perDb) { perDb = new Map(); argKindCache.set(db, perDb); }
  const key = fn + "(" + [...names].sort().join(",") + ")";
  const cached = perDb.get(key);
  if (cached) return cached;
  // Resolve the OVERLOAD whose named parameters are exactly the ones the caller supplied. Taking
  // `limit 1` off a name match picked an arbitrary overload, which is how a legacy signature would
  // silently decide the binding for a call meant for the current one.
  const { rows } = await db.query(
    `select p.proargnames as names, p.proargtypes::oid[] as intypes, p.proallargtypes as alltypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
        and coalesce(p.proargnames, '{}'::text[]) @> $2::text[]
      order by coalesce(array_length(p.proargnames, 1), 0)
      limit 1`,
    [fn, names],
  );
  const r = rows[0];
  if (!r?.names) {
    const empty = new Map<string, Kind>();
    perDb.set(key, empty);
    return empty;
  }
  const types: number[] = (r.alltypes ?? r.intypes ?? []) as number[];
  const { rows: tr } = await db.query(
    `select oid, case when typtype = 'b' and typcategory = 'A' then 'array'
                      when typname in ('json','jsonb') then 'json'
                      else 'scalar' end as kind
       from pg_type where oid = any($1::oid[])`,
    [types],
  );
  const byOid = new Map<number, Kind>(tr.map((x) => [Number(x.oid), x.kind as Kind]));
  const m = new Map<string, Kind>();
  (r.names as string[]).forEach((n, i) => {
    const t = types[i];
    if (n && t != null) m.set(n, byOid.get(Number(t)) ?? "scalar");
  });
  perDb.set(key, m);
  return m;
}

const isPlainObject = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * PostgREST binds by the TARGET COLUMN's type, and so must this: a JS array going into `jsonb`
 * needs JSON text, while the same array going into `text[]` needs node-pg's native array encoding.
 * Guessing one rule for both produced `malformed array literal: "[]"` on `financial_events`.
 */
type Kind = "json" | "array" | "scalar";

const bindAs = (v: unknown, kind: Kind): unknown => {
  if (v === null || v === undefined) return null;
  if (kind === "json") return JSON.stringify(v);
  if (kind === "array") return v;                       // node-pg encodes a JS array natively
  return isPlainObject(v) || Array.isArray(v) ? JSON.stringify(v) : v;
};

class Builder implements PromiseLike<{ data: any; error: { message: string } | null }> {
  private filters: Filter[] = [];
  private columns = "*";
  private orderBys: string[] = [];
  private limitN: number | null = null;
  private mode: "select" | "insert" | "upsert" | "update" = "select";
  private payload: Row[] = [];
  private wantsRows = true;
  private one: "one" | "maybe" | null = null;
  private upsertOnConflict?: string;
  private upsertIgnoreDuplicates = false;

  constructor(private db: PgLike, private table: string) {}

  select(cols?: string) {
    if (cols) {
      // PostgREST's embedding syntax (`memberships!inner(user_id)`) means a JOIN, which this shim
      // does not build. Interpolating it produced different SQL from what production runs, so a
      // page whose query uses it would be "covered" by a test that never exercised its data path.
      if (/[!(]/.test(cols)) {
        throw new Error(`pg-supabase shim: embedded select is not supported — "${cols}". Query the join explicitly.`);
      }
      this.columns = cols;
    }
    this.wantsRows = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.mode = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    // PostgREST returns no body for a bare .insert(); only a chained .select() asks for rows.
    this.wantsRows = false;
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.upsertOnConflict = opts?.onConflict;
    this.upsertIgnoreDuplicates = opts?.ignoreDuplicates ?? false;
    this.wantsRows = false;
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.payload = [patch];
    this.wantsRows = false;
    return this;
  }
  eq(col: string, val: unknown) { return this.cmp(col, "=", val); }
  neq(col: string, val: unknown) { return this.cmp(col, "<>", val); }
  gt(col: string, val: unknown) { return this.cmp(col, ">", val); }
  gte(col: string, val: unknown) { return this.cmp(col, ">=", val); }
  lt(col: string, val: unknown) { return this.cmp(col, "<", val); }
  lte(col: string, val: unknown) { return this.cmp(col, "<=", val); }
  in(col: string, vals: unknown[]) {
    // `= any($1)` needs node-pg's native ARRAY encoding. Binding by the COLUMN's kind sent JSON text
    // into a scalar column, so every `.in()` and `.not(…,"in",…)` returned `malformed array
    // literal` — and `recentEventsForDedup` discarded that error, which silently disabled duplicate
    // detection in every end-to-end test that ran through this harness.
    this.filters.push({ sql: `${q(col)} = any($$)`, params: [vals], bindKind: "array" });
    return this;
  }
  /** Only the one negation the consumer store uses: .not(col, "in", "(a,b,c)"). */
  not(col: string, op: string, val: string) {
    if (op !== "in") throw new Error(`pg-supabase shim: .not(${op}) is not supported`);
    const list = String(val).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    this.filters.push({ sql: `(${q(col)} is null or ${q(col)} <> all($$))`, params: [list], bindKind: "array" });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    // PostgREST orders by EVERY .order() in call order. Overwriting collapsed a compound
    // (updated_at, id) ordering to (updated_at) — the exact ambiguity a compound cursor
    // exists to remove — so a tie group came back arbitrarily ordered and a keyset sweep
    // could not advance through it.
    this.orderBys.push(`${q(col)} ${opts?.ascending === false ? "desc" : "asc"}`);
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  single() { this.one = "one"; this.wantsRows = true; return this; }
  maybeSingle() { this.one = "maybe"; this.wantsRows = true; return this; }

  private cmp(col: string, op: string, val: unknown) {
    if (val === null) {
      this.filters.push({ sql: `${q(col)} is ${op === "=" ? "" : "not "}null`, params: [] });
      return this;
    }
    this.filters.push({ sql: `${q(col)} ${op} $$`, params: [val] });
    return this;
  }

  private async build(): Promise<{ sql: string; params: any[] }> {
    const kinds = await kindsFor(this.db, this.table);
    const params: any[] = [];
    const push = (v: unknown, col?: string) => {
      params.push(bindAs(v, col ? (kinds.get(col) ?? "scalar") : "scalar"));
      return `$${params.length}`;
    };
    /** Bind by an EXPLICIT kind, where the SQL operator decides the shape rather than the column. */
    const pushKind = (v: unknown, kind: Kind) => {
      params.push(bindAs(v, kind));
      return `$${params.length}`;
    };
    const where = () => {
      if (!this.filters.length) return "";
      const parts = this.filters.map((f) => {
        let i = 0;
        const col = f.col;
        return f.sql.replace(/\$\$/g, () => (f.bindKind
          ? pushKind(f.params[i++], f.bindKind)
          : push(f.params[i++], col)));
      });
      return ` where ${parts.join(" and ")}`;
    };

    if (this.mode === "insert" || this.mode === "upsert") {
      const cols = Array.from(new Set(this.payload.flatMap((r) => Object.keys(r))));
      const values = this.payload
        .map((r) => `(${cols.map((c) => push(r[c] ?? null, c)).join(",")})`)
        .join(",");
      let conflict = "";
      if (this.mode === "upsert") {
        if (this.upsertOnConflict) {
          conflict = ` on conflict (${this.upsertOnConflict}) do ${this.upsertIgnoreDuplicates ? "nothing" : "update set " + cols.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`;
        } else {
          // No conflict columns specified — default to DO NOTHING behaviour (used by ignoreDuplicates).
          conflict = " on conflict do nothing";
        }
      }
      return {
        sql: `insert into public.${q(this.table)} (${cols.map(q).join(",")}) values ${values}${conflict}` +
          (this.wantsRows ? ` returning ${this.columns}` : ""),
        params,
      };
    }
    if (this.mode === "update") {
      // PostgREST refuses an unfiltered mutation; so does this. A shim that silently rewrote the
      // whole table would turn a forgotten `.eq()` into a passing test and a wrecked fixture.
      if (!this.filters.length) {
        throw new Error("pg-supabase shim: refusing an UPDATE with no filter");
      }
      const patch = this.payload[0] ?? {};
      const sets = Object.keys(patch).map((c) => `${q(c)} = ${push(patch[c], c)}`).join(", ");
      return {
        sql: `update public.${q(this.table)} set ${sets}${where()}` +
          (this.wantsRows ? ` returning ${this.columns}` : ""),
        params,
      };
    }
    return {
      sql: `select ${this.columns} from public.${q(this.table)}${where()}` +
        (this.orderBys.length ? ` order by ${this.orderBys.join(", ")}` : "") +
        (this.limitN != null ? ` limit ${this.limitN}` : ""),
      params,
    };
  }

  async run(): Promise<{ data: any; error: { message: string } | null }> {
    let rows: Row[];
    try {
      const { sql, params } = await this.build();
      rows = (await this.db.query(sql, params)).rows;
    } catch (e) {
      // PostgREST surfaces a database error as `error`, not as a throw. Matching that matters:
      // production code branches on `error` and would otherwise never see the failure path.
      return { data: null, error: { message: (e as Error).message } };
    }
    if (this.one === "one") {
      if (rows.length !== 1) return { data: null, error: { message: `expected exactly one row, got ${rows.length}` } };
      return { data: rows[0], error: null };
    }
    if (this.one === "maybe") {
      if (rows.length > 1) return { data: null, error: { message: `expected at most one row, got ${rows.length}` } };
      return { data: rows[0] ?? null, error: null };
    }
    return { data: this.wantsRows ? rows : null, error: null };
  }

  then<A, B>(
    ok?: ((v: { data: any; error: { message: string } | null }) => A | PromiseLike<A>) | null,
    err?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(ok, err);
  }
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/**
 * PostgREST shapes an RPC result by the function's return type: a set-returning function yields an
 * array, a scalar yields the bare value. Reproduced here because the production code branches on it
 * (`Array.isArray(data) ? data[0] : data`).
 */
export function pgSupabase(db: PgLike): any {
  return {
    from(table: string) { return new Builder(db, table); },
    async rpc(fn: string, args?: Row) {
      const names = Object.keys(args ?? {});
      const call = names.length
        ? `${names.map((n, i) => `${q(n)} => $${i + 1}`).join(", ")}`
        : "";
      try {
        const kinds = await argKinds(db, fn, names);
        const { rows } = await db.query(
          `select * from public.${q(fn)}(${call})`,
          names.map((n) => bindAs((args as Row)[n], kinds.get(n) ?? "scalar")),
        );
        const first = rows[0];
        if (rows.length === 1 && first && Object.keys(first).length === 1) {
          const only = Object.values(first)[0];
          // A single unnamed scalar column IS the scalar for PostgREST; a one-column TABLE(...) is
          // still a set. The function name is the only disambiguator available, and matching the
          // column name to the function name is exactly how PostgREST decides.
          if (Object.keys(first)[0] === fn) return { data: only, error: null };
        }
        return { data: rows, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
}
