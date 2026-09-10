/** Singha brand lockups. Assets live in /public/brand (red poly-lion + wordmark). */
export function Brand({
  variant = "lion",
  size = 34,
  nameHidden = false,
}: {
  variant?: "lion" | "wordmark";
  size?: number;
  /**
   * Hide the wordmark but keep it for assistive technology. Used by the
   * collapsed command rail, where there is room for the mark and not the name.
   */
  nameHidden?: boolean;
}) {
  if (variant === "wordmark") {
    return (
      <span className="brand">
        <img src="/brand/wordmark.png" alt="Singha" style={{ height: size }} />
      </span>
    );
  }
  return (
    <span className="brand">
      <img src="/brand/lion.png" alt="Singha" style={{ height: size }} />
      <span className={nameHidden ? "sr-only" : "name"}>SINGHA CENTRAL</span>
    </span>
  );
}
