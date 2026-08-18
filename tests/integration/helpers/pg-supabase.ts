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
 * Supported: .rpc(fn, args); .from(t).select().eq().neq().in().not().gte().lte().order().limit()
 * .single().maybeSingle(); .insert(row|rows).select().single(); .update(patch).eq()….select().
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;
type Filter = { sql: string; params: any[]; col?: string };

export interface PgLike {
  query(sql: string, params?: any[]): Promise<{ rows: Row[] }>;
}

/** Column-kind cache, one lookup per table per connection. */
const columnKinds = new Map<string, Map<string, Kind>>();

async function kindsFor(db: PgLike, table: string): Promise<Map<string, Kind>> {
  const hit = columnKinds.get(table);
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
  columnKinds.set(table, m);
  return m;
}

/** Parameter kinds for an RPC, resolved from the function's declared argument types. */
async function argKinds(db: PgLike, fn: string, names: string[]): Promise<Map<string, Kind>> {
  if (!names.length) return new Map();
  const { rows } = await db.query(
    `select p.proargnames as names, p.proargtypes::oid[] as intypes, p.proallargtypes as alltypes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
      limit 1`,
    [fn],
  );
  const r = rows[0];
  if (!r?.names) return new Map();
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
  private orderBy: string | null = null;
  private limitN: number | null = null;
  private mode: "select" | "insert" | "update" = "select";
  private payload: Row[] = [];
  private wantsRows = true;
  private one: "one" | "maybe" | null = null;

  constructor(private db: PgLike, private table: string) {}

  select(cols?: string) {
    if (cols) this.columns = cols;
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
  update(patch: Row) {
    this.mode = "update";
    this.payload = [patch];
    this.wantsRows = false;
    return this;
  }
  eq(col: string, val: unknown) { return this.cmp(col, "=", val); }
  neq(col: string, val: unknown) { return this.cmp(col, "<>", val); }
  gte(col: string, val: unknown) { return this.cmp(col, ">=", val); }
  lte(col: string, val: unknown) { return this.cmp(col, "<=", val); }
  in(col: string, vals: unknown[]) {
    this.filters.push({ sql: `${q(col)} = any($$)`, params: [vals], col });
    return this;
  }
  /** Only the one negation the consumer store uses: .not(col, "in", "(a,b,c)"). */
  not(col: string, op: string, val: string) {
    if (op !== "in") throw new Error(`pg-supabase shim: .not(${op}) is not supported`);
    const list = String(val).replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    this.filters.push({ sql: `(${q(col)} is null or ${q(col)} <> all($$))`, params: [list] });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = `${q(col)} ${opts?.ascending === false ? "desc" : "asc"}`;
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
    const where = () => {
      if (!this.filters.length) return "";
      const parts = this.filters.map((f) => {
        let i = 0;
        const col = f.col;
        return f.sql.replace(/\$\$/g, () => push(f.params[i++], col));
      });
      return ` where ${parts.join(" and ")}`;
    };

    if (this.mode === "insert") {
      const cols = Array.from(new Set(this.payload.flatMap((r) => Object.keys(r))));
      const values = this.payload
        .map((r) => `(${cols.map((c) => push(r[c] ?? null, c)).join(",")})`)
        .join(",");
      return {
        sql: `insert into public.${q(this.table)} (${cols.map(q).join(",")}) values ${values}` +
          (this.wantsRows ? ` returning ${this.columns}` : ""),
        params,
      };
    }
    if (this.mode === "update") {
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
        (this.orderBy ? ` order by ${this.orderBy}` : "") +
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
