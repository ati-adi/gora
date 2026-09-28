// webapp/src/screens/Approvals.tsx (WP8) — the pending approvals list.
import { Badge, Header, Section } from '../components/Card.tsx';
import { Empty, ErrorState } from '../components/Empty.tsx';
import { Row } from '../components/List.tsx';
import { Loading } from '../components/Loading.tsx';
import { useApi } from '../lib/api.ts';
import { fmtRelative, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { useNav } from '../lib/nav.ts';

export interface ApprovalItem {
  id: string; toolName: string; title: string; summary: string; rows: Array<[string, string]>; body: { label: string; text: string } | null;
  warnings: string[]; status: string; expiresAt: number; grantable: boolean; ladderOffer: boolean; editableFields: string[];
  targets: Array<{ kind: string; display: string; provenance: string }>;
}

export function Approvals() {
  const { t, lang } = useT();
  const { me } = useMe();
  const nav = useNav();
  const q = useApi<{ items: ApprovalItem[] }>('/approvals?status=pending');
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <div className="page">
      <Header title={t('approvals_title')} />
      {q.data.items.length === 0 ? (
        <Empty icon="✅">{t('approvals_empty')}</Empty>
      ) : (
        <Section flush>
          {q.data.items.map((a) => (
            <Row
              key={a.id}
              icon="🔐"
              title={a.title}
              subtitle={`${a.summary} · ${t('expires_in', { time: fmtRelative(a.expiresAt, me.now, lang) })}`}
              right={a.warnings.length ? <Badge tone="warn">⚠️</Badge> : undefined}
              onClick={() => nav.push({ screen: 'approval', id: a.id })}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
