// webapp/src/components/List.tsx (WP8) — list rows inside a Section (icon, title, subtitle, trailing value/chevron).
import type { ReactNode } from 'react';

export function Row(p: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  danger?: boolean;
  multiline?: boolean;
}) {
  const body = (
    <>
      {p.icon !== undefined ? <span className="row-icon" aria-hidden>{p.icon}</span> : null}
      <span className="row-main">
        <span className={`row-title${p.danger ? ' text-danger' : ''}${p.multiline ? ' multiline' : ''}`}>{p.title}</span>
        {p.subtitle ? <span className="row-sub">{p.subtitle}</span> : null}
      </span>
      {p.right !== undefined ? <span className="row-right">{p.right}</span> : null}
      {p.chevron || (p.onClick && p.chevron !== false) ? <span className="row-chevron" aria-hidden>›</span> : null}
    </>
  );
  return p.onClick ? (
    <button type="button" className="row tappable" onClick={p.onClick}>
      {body}
    </button>
  ) : (
    <div className="row">{body}</div>
  );
}

/** A row whose content is arbitrary (forms, button groups). */
export function RowBlock(p: { children: ReactNode }) {
  return <div className="row row-block">{p.children}</div>;
}

export function List(p: { children: ReactNode }) {
  return <div className="list">{p.children}</div>;
}
