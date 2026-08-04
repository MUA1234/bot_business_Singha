/** Singha brand lockups. Assets live in /public/brand (red poly-lion + wordmark). */
export function Brand({ variant = "lion", size = 34 }: { variant?: "lion" | "wordmark"; size?: number }) {
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
      <span className="name">SINGHA</span>
    </span>
  );
}
