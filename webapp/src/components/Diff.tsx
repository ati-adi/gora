// webapp/src/components/Diff.tsx (WP8) — the approval diff: rows, body, warnings and recipients with provenance.
import { useT, isKey } from '../lib/i18n.ts';

export interface DiffView {
  rows: Array<[string, string]>;
  body: { label: string; text: string } | null;
  warnings: string[];
  targets: Array<{ kind: string; display: string; provenance: string }>;
}

export function Diff(p: { v: DiffView }) {
  const { t } = useT();
  return (
    <div className="diff">
      {p.v.warnings.length > 0 ? (
        <div className="diff-warnings" role="alert">
          <div className="diff-warnings-title">⚠️ {t('warnings')}</div>
          <ul>
            {p.v.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.v.rows.length > 0 ? (
        <dl className="diff-rows">
          {p.v.rows.map(([k, v], i) => (
            <div className="diff-row" key={i}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {p.v.body ? (
        <div className="diff-body">
          <div className="diff-body-label">{p.v.body.label}</div>
          <pre>{p.v.body.text}</pre>
        </div>
      ) : null}
      {p.v.targets.length > 0 ? (
        <div className="diff-targets">
          <div className="diff-body-label">{t('targets')}</div>
          {p.v.targets.map((x, i) => {
            const key = `provenance_${x.provenance}`;
            const untrusted = x.provenance === 'untrusted' || x.provenance === 'unknown';
            return (
              <div className={untrusted ? 'target target-warn' : 'target'} key={i}>
                <span className="target-value">{x.display}</span>
                <span className="target-prov">{isKey(key) ? t(key) : x.provenance}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
