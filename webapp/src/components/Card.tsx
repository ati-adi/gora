// webapp/src/components/Card.tsx (WP8) — grouped sections (Telegram's native inset-list look) and small building blocks.
import type { ReactNode } from 'react';

export function Section(p: { title?: ReactNode; footer?: ReactNode; children: ReactNode; flush?: boolean; id?: string }) {
  return (
    <section className="section" id={p.id}>
      {p.title ? <h2 className="section-title">{p.title}</h2> : null}
      <div className={p.flush ? 'card card-flush' : 'card'}>{p.children}</div>
      {p.footer ? <p className="section-footer">{p.footer}</p> : null}
    </section>
  );
}

export function Card(p: { children: ReactNode; tone?: 'warn' | 'accent' | 'danger'; onClick?: () => void }) {
  const cls = `card card-pad${p.tone ? ` card-${p.tone}` : ''}${p.onClick ? ' tappable' : ''}`;
  return p.onClick ? (
    <button type="button" className={cls} onClick={p.onClick}>
      {p.children}
    </button>
  ) : (
    <div className={cls}>{p.children}</div>
  );
}

export function Header(p: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{p.title}</h1>
        {p.subtitle ? <p className="subtitle">{p.subtitle}</p> : null}
      </div>
      {p.right ?? null}
    </header>
  );
}

export function Badge(p: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'muted' | 'accent' }) {
  return <span className={`badge badge-${p.tone ?? 'muted'}`}>{p.children}</span>;
}

/** A labeled progress meter (usage against a limit). */
export function Meter(p: { label: ReactNode; used: number; limit: number; unit?: string }) {
  const pct = p.limit > 0 ? Math.min(100, Math.round((p.used / p.limit) * 100)) : 0;
  const tone = pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{p.label}</span>
        <span className="meter-num">
          {p.used}
          {p.limit > 0 ? ` / ${p.limit}` : ''}
          {p.unit ?? ''}
        </span>
      </div>
      <div className="meter-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`meter-fill meter-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Segmented control (2–4 options). */
export function Segmented<V extends string>(p: { value: V; options: Array<{ value: V; label: ReactNode }>; onChange: (v: V) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup">
      {p.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === p.value}
          disabled={p.disabled}
          className={o.value === p.value ? 'seg seg-on' : 'seg'}
          onClick={() => o.value !== p.value && p.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An in-page button (used when the Telegram bottom buttons are not available, and for secondary actions). */
export function Button(p: { children: ReactNode; onClick: () => void; kind?: 'primary' | 'plain' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean; small?: boolean }) {
  return (
    <button type="button" className={`btn btn-${p.kind ?? 'primary'}${p.small ? ' btn-small' : ''}`} disabled={p.disabled || p.busy} onClick={p.onClick}>
      {p.busy ? <span className="spinner spinner-inline" aria-hidden /> : null}
      {p.children}
    </button>
  );
}

export function Chips<V extends string>(p: { value: V; options: Array<{ value: V; label: ReactNode }>; onChange: (v: V) => void }) {
  return (
    <div className="chips">
      {p.options.map((o) => (
        <button key={o.value} type="button" className={o.value === p.value ? 'chip chip-on' : 'chip'} onClick={() => p.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice(p: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info' }) {
  return <div className={`notice notice-${p.tone ?? 'info'}`}>{p.children}</div>;
}
