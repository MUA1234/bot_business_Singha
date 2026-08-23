import { EmptyState } from "./EmptyState";
import { SkeletonRow } from "./Skeleton";

export interface DataTableColumn<T> {
  key: string;
  header: React.ReactNode;
  render: (row: T) => React.ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  keyExtractor: (row: T) => string | number;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: {
    label: string;
    href?: string;
    onClick?: () => void;
  };
  caption?: string;
  className?: string;
  skeletonRows?: number;
}

/**
 * Responsive data table with loading skeleton, empty state and accessible header
 * cells. Always wraps in `.table-wrap` to prevent horizontal overflow.
 */
export function DataTable<T>({
  columns,
  rows,
  keyExtractor,
  loading = false,
  emptyTitle = "Nothing to show",
  emptyDescription,
  emptyAction,
  caption,
  className = "",
  skeletonRows = 5,
}: DataTableProps<T>) {
  if (!loading && rows.length === 0) {
    return (
      <div className={className}>
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} icon="table" />
      </div>
    );
  }

  return (
    <div className={`table-wrap${className ? ` ${className}` : ""}`}>
      <table className="data">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`${col.align === "right" ? "num" : col.align === "center" ? "center" : ""}${col.className ? ` ${col.className}` : ""}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 0, border: 0 }}>
                {Array.from({ length: skeletonRows }).map((_, i) => (
                  <SkeletonRow key={i} cols={columns.length} />
                ))}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={keyExtractor(row)}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`${col.align === "right" ? "num" : col.align === "center" ? "center" : ""}${col.className ? ` ${col.className}` : ""}`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
