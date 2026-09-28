// webapp/src/components/Toggle.tsx (WP8) — an iOS/Android-style switch row.
import type { ReactNode } from 'react';
import { haptic } from '../lib/tg.ts';

export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.checked}
      aria-label={p.label}
      disabled={p.disabled}
      className={p.checked ? 'switch switch-on' : 'switch'}
      onClick={(e) => {
        e.stopPropagation();
        haptic('select');
        p.onChange(!p.checked);
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Toggle(p: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="row">
      {p.icon !== undefined ? <span className="row-icon" aria-hidden>{p.icon}</span> : null}
      <span className="row-main">
        <span className="row-title">{p.title}</span>
        {p.subtitle ? <span className="row-sub">{p.subtitle}</span> : null}
      </span>
      <span className="row-right">
        <Switch checked={p.checked} onChange={p.onChange} {...(p.disabled !== undefined ? { disabled: p.disabled } : {})} label={typeof p.title === 'string' ? p.title : undefined} />
      </span>
    </div>
  );
}
