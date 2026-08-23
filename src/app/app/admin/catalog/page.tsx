import { requireProfile } from "@/lib/auth";
import { redirect } from "next/navigation";
import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { AddProductForm } from "./AddProductForm";
import { setProductActive } from "./actions";

export const metadata = { title: "Products & Prices — Singha Central" };

interface CatalogRow {
  id: string;
  name: string;
  sku: string | null;
  unit_price: number | null;
  currency: string | null;
  is_active: boolean;
}

export default async function CatalogPage() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") redirect(`/app/${p.department}`);

  const { data } = await supabaseReadClient()
    .from("product_catalog")
    .select("id, name, sku, unit_price, currency, is_active")
    .eq("company_id", p.companyId)
    .order("name");

  const rows = (data ?? []) as CatalogRow[];

  const columns: DataTableColumn<CatalogRow>[] = [
    {
      key: "product",
      header: "Product",
      render: (r) => <span style={{ fontWeight: 600 }}>{r.name}</span>,
    },
    {
      key: "sku",
      header: "SKU",
      render: (r) => <span className="mono dim">{r.sku ?? "—"}</span>,
    },
    {
      key: "price",
      header: "Unit price",
      align: "right",
      render: (r) =>
        r.unit_price == null ? (
          <Badge variant="warn">Varies</Badge>
        ) : (
          fmtMoney(r.unit_price, r.currency ?? "LKR")
        ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.is_active ? "Active" : "Hidden"} />,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (r) => (
        <form action={setProductActive}>
          <input type="hidden" name="id" value={r.id} />
          <input type="hidden" name="active" value={(!r.is_active).toString()} />
          <Button variant="ghost" size="sm" type="submit" aria-label={r.is_active ? `Hide ${r.name}` : `Show ${r.name}`}>
            {r.is_active ? "Hide" : "Show"}
          </Button>
        </form>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Products &amp; Prices</h1>
        <p className="muted mt-1">
          The AI quoting engine prices customer requests against this list. If a requested item isn’t
          here (or its price is blank), the quotation is held and sent to a department for confirmation.
        </p>
      </div>

      <Card>
        <CardHeader title="Add a product" />
        <CardBody>
          <AddProductForm />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Catalog (${rows.length})`} />
        <CardBody padding="sm">
          {rows.length === 0 ? (
            <EmptyState title="No products yet" description="Add a product to make it available to the quoting engine." icon="tag" />
          ) : (
            <DataTable columns={columns} rows={rows} keyExtractor={(r) => r.id} caption="Product catalog" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
