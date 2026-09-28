// webapp/src/components/Loading.tsx (WP8) — skeleton placeholders while a screen loads, plus a transient toast.
import { useEffect, useState } from 'react';

export function Loading(p: { rows?: number }) {
  const n = p.rows ?? 4;
  return (
    <div className="loading" aria-busy="true" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="card">
        {Array.from({ length: n }, (_, i) => (
          <div className="skeleton-row" key={i}>
            <div className="skeleton skeleton-dot" />
            <div className="skeleton-lines">
              <div className="skeleton skeleton-line" style={{ width: `${70 - i * 7}%` }} />
              <div className="skeleton skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="loading" />;
}

/** A small toast that disappears after `ms`. Render with a changing `k` to show it again. */
export function Toast(p: { text: string | null; k?: number; ms?: number }) {
  const [shown, setShown] = useState<string | null>(p.text);
  useEffect(() => {
    setShown(p.text);
    if (!p.text) return;
    const h = window.setTimeout(() => setShown(null), p.ms ?? 2200);
    return () => window.clearTimeout(h);
  }, [p.text, p.k, p.ms]);
  return shown ? (
    <div className="toast" role="status">
      {shown}
    </div>
  ) : null;
}
