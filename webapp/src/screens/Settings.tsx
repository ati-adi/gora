// webapp/src/screens/Settings.tsx (WP8) — time zone (auto-detect or a manual IANA picker), language, persona, the nudge
// budget slider (0 to plan max) with per-kind mutes, quiet hours, brief time, inbox check-ins, pause, voice replies
// (03 R8), home city, approval expiry, transcripts (01 §12). Friend mode (05 C5): "Gora and you" — writing first
// (off/less/normal/more) and reply style overrides (Auto = learned). Every change saves immediately (PATCH /api/settings).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Header, Section, Segmented } from '../components/Card.tsx';
import { ErrorState } from '../components/Empty.tsx';
import { Row, RowBlock } from '../components/List.tsx';
import { Loading, Toast } from '../components/Loading.tsx';
import { Toggle } from '../components/Toggle.tsx';
import { useAction } from '../lib/actions.ts';
import { get, patch, post, useApi } from '../lib/api.ts';
import { tDyn, useT } from '../lib/i18n.ts';
import { useMe } from '../lib/me.ts';
import { haptic } from '../lib/tg.ts';

interface SettingsData {
  tz: string; tzSource: string; language: string | null; personaName: string; personaStyle: 'friendly' | 'concise' | 'professional' | 'coach';
  paused: boolean; voiceReplies: boolean; voiceAvailable: boolean; nudgeBudgetMax: number;
  proactiveLevel: 'off' | 'less' | 'normal' | 'more'; memory: 'on' | 'off' | 'incognito'; style: Style | null;
  settings: { nudgeBudget: number; quietStart: string; quietEnd: string; briefTime: string | null; inboxCheckins: boolean; approvalExpiryMin: number; showTranscripts: boolean; homeCity: { name: string; lat: number; lon: number } | null };
  nudgePrefs: Array<{ kind: string; muted: boolean; snoozeUntil: number | null }>;
}
interface Style { length?: 'short' | 'medium' | 'long'; emoji?: 'none' | 'light' | 'lots'; register?: 'informal' | 'formal' }
interface City { name: string; lat: number; lon: number; country: string | null; tz: string | null }

const EXPIRY = [15, 60, 240, 720, 1440];

function allZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Kyiv', 'Europe/Moscow', 'Asia/Almaty', 'Asia/Tashkent', 'Asia/Dubai', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles'];
  }
}

export function Settings() {
  const { t } = useT();
  const { refresh } = useMe();
  const q = useApi<SettingsData>('/settings');
  const act = useAction();
  const [toast, setToast] = useState<{ text: string; k: number } | null>(null);
  const [tzOpen, setTzOpen] = useState(false);
  const [tzQuery, setTzQuery] = useState('');
  const [cityQuery, setCityQuery] = useState('');
  const [cities, setCities] = useState<City[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const [name, setName] = useState<string | null>(null);
  const budgetTimer = useRef<number | undefined>(undefined);
  const zones = useMemo(() => (tzOpen ? allZones() : []), [tzOpen]);

  useEffect(() => () => window.clearTimeout(budgetTimer.current), []);

  if (q.loading && !q.data) return <Loading rows={8} />;
  if (!q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  const st = d.settings;

  const save = (body: Record<string, unknown>) => act.run(async () => {
    const r = await patch<SettingsData>('/settings', body);
    q.set(r);
    haptic('select');
    setToast({ text: t('saved'), k: Date.now() });
    if ('language' in body || 'paused' in body || 'tz' in body || 'voiceReplies' in body || 'personaName' in body) await refresh();
  });
  /** One style field changed; the others are kept; all-Auto → null (learned only). */
  const saveStyle = (change: Style) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(d.style ?? {}), ...change })) if (v) next[k] = v;
    return save({ style: Object.keys(next).length ? next : null });
  };
  const detectTz = () => act.run(async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await post('/settings/tz', { tz });
    await q.reload();
    await refresh();
    haptic('success');
    setToast({ text: t('tz_detected', { tz }), k: Date.now() });
  });
  const searchCity = () => act.run(async () => {
    const r = await get<{ items: City[] }>(`/settings/city?q=${encodeURIComponent(cityQuery.trim())}`);
    setCities(r.items);
  });
  const onBudget = (v: number) => {
    setBudget(v);
    window.clearTimeout(budgetTimer.current);
    budgetTimer.current = window.setTimeout(() => void save({ nudgeBudget: v }), 500);
  };
  const shownBudget = budget ?? st.nudgeBudget;
  const filteredZones = tzQuery ? zones.filter((z) => z.toLowerCase().includes(tzQuery.toLowerCase().replace(/\s+/g, '_'))).slice(0, 60) : zones.slice(0, 60);

  return (
    <div className="page">
      <Header title={t('settings_title')} />

      <Section title={t('timezone')}>
        <Row icon="🕒" title={d.tz.replace(/_/g, ' ')} subtitle={tDyn(t, `tzsrc_${d.tzSource}`, d.tzSource)} />
        <Row icon="📍" title={t('tz_detect')} onClick={() => void detectTz()} />
        <Row icon="🌐" title={t('tz_pick')} onClick={() => setTzOpen(!tzOpen)} />
        {tzOpen ? (
          <div className="card-pad form">
            <input type="search" placeholder={t('tz_search')} value={tzQuery} onChange={(e) => setTzQuery(e.target.value)} />
            <div className="picker">
              {filteredZones.map((z) => (
                <button type="button" key={z} className={z === d.tz ? 'pick-row pick-row-on' : 'pick-row'} onClick={() => { setTzOpen(false); void save({ tz: z }); }}>{z.replace(/_/g, ' ')}</button>
              ))}
            </div>
          </div>
        ) : null}
      </Section>

      <Section title={t('general')}>
        <RowBlock>
          <div className="stack">
            <span className="field-label">{t('language')}</span>
            <Segmented value={(d.language ?? 'en').startsWith('ru') ? 'ru' : 'en'} onChange={(v) => void save({ language: v })} options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]} />
          </div>
        </RowBlock>
        <Toggle icon="⏸️" title={t('pause')} subtitle={t('pause_hint')} checked={d.paused} onChange={(v) => void save({ paused: v })} disabled={act.busy} />
        {d.voiceAvailable ? <Toggle icon="🔊" title={t('voice_replies')} subtitle={t('voice_hint')} checked={d.voiceReplies} onChange={(v) => void save({ voiceReplies: v })} disabled={act.busy} /> : null}
        <Toggle icon="📝" title={t('show_transcripts')} checked={st.showTranscripts} onChange={(v) => void save({ showTranscripts: v })} disabled={act.busy} />
      </Section>

      <Section title={t('friend_title')} footer={t('talk_hint')}>
        <RowBlock>
          <label className="field">
            <span className="field-label">{t('persona_name')}</span>
            <input value={name ?? d.personaName} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name !== null && name.trim() && name.trim() !== d.personaName) void save({ personaName: name.trim() }); setName(null); }} />
          </label>
        </RowBlock>
        <RowBlock>
          <div className="stack">
            <span className="field-label">{t('proactive_title')}</span>
            <Segmented value={d.proactiveLevel} onChange={(v) => void save({ proactiveLevel: v })} options={(['off', 'less', 'normal', 'more'] as const).map((l) => ({ value: l, label: t(`pl_${l}`) }))} />
          </div>
        </RowBlock>
        <RowBlock>
          <div className="stack">
            <span className="field-label">{t('talk_length')}</span>
            <Segmented value={d.style?.length ?? 'auto'} onChange={(v) => void saveStyle({ length: v === 'auto' ? undefined : (v as Style['length']) })} options={[{ value: 'auto', label: t('talk_auto') }, ...(['short', 'medium', 'long'] as const).map((l) => ({ value: l, label: t(`tl_${l}`) }))]} />
          </div>
        </RowBlock>
        <RowBlock>
          <div className="stack">
            <span className="field-label">{t('talk_emoji')}</span>
            <Segmented value={d.style?.emoji ?? 'auto'} onChange={(v) => void saveStyle({ emoji: v === 'auto' ? undefined : (v as Style['emoji']) })} options={[{ value: 'auto', label: t('talk_auto') }, ...(['none', 'light', 'lots'] as const).map((l) => ({ value: l, label: t(`te_${l}`) }))]} />
          </div>
        </RowBlock>
        <RowBlock>
          <div className="stack">
            <span className="field-label">{t('talk_register')}</span>
            <Segmented value={d.style?.register ?? 'auto'} onChange={(v) => void saveStyle({ register: v === 'auto' ? undefined : (v as Style['register']) })} options={[{ value: 'auto', label: t('talk_auto') }, ...(['informal', 'formal'] as const).map((l) => ({ value: l, label: t(`tr_${l}`) }))]} />
          </div>
        </RowBlock>
      </Section>

      <Section title={t('nudges')} footer={t('nudge_budget_hint', { max: d.nudgeBudgetMax })}>
        <RowBlock>
          <div className="stack">
            <span className="field-label">{t('nudge_budget', { n: shownBudget })}</span>
            <input type="range" min={0} max={d.nudgeBudgetMax} step={1} value={Math.min(shownBudget, d.nudgeBudgetMax)} onChange={(e) => onBudget(Number(e.target.value))} />
          </div>
        </RowBlock>
        {d.nudgePrefs.map((p) => (
          <Toggle key={p.kind} title={tDyn(t, `nk_${p.kind}`, p.kind)} checked={!p.muted} onChange={(on) => void save({ nudgePrefs: [{ kind: p.kind, muted: !on }] })} disabled={act.busy || shownBudget === 0} />
        ))}
      </Section>

      <Section title={t('quiet_hours')}>
        <RowBlock>
          <div className="inline-form">
            <label className="field grow"><span className="field-label">{t('quiet_from')}</span><input type="time" value={st.quietStart} onChange={(e) => e.target.value && void save({ quietStart: e.target.value })} /></label>
            <label className="field grow"><span className="field-label">{t('quiet_to')}</span><input type="time" value={st.quietEnd} onChange={(e) => e.target.value && void save({ quietEnd: e.target.value })} /></label>
          </div>
        </RowBlock>
      </Section>

      <Section title={t('brief')}>
        <Toggle icon="☀️" title={t('brief')} checked={st.briefTime !== null} onChange={(on) => void save({ briefTime: on ? '08:00' : null })} disabled={act.busy} />
        {st.briefTime !== null ? (
          <RowBlock>
            <label className="field"><span className="field-label">{t('brief_time')}</span><input type="time" value={st.briefTime} onChange={(e) => e.target.value && void save({ briefTime: e.target.value })} /></label>
          </RowBlock>
        ) : null}
        <Toggle icon="📥" title={t('inbox_checkins')} checked={st.inboxCheckins} onChange={(v) => void save({ inboxCheckins: v })} disabled={act.busy} />
      </Section>

      <Section title={t('home_city')} footer={t('home_city_hint')}>
        <Row icon="🏙" title={st.homeCity?.name ?? t('home_city_none')} right={st.homeCity ? <button type="button" className="icon-btn" aria-label={t('remove')} onClick={() => void save({ homeCity: null })}>✕</button> : undefined} />
        <RowBlock>
          <div className="inline-form">
            <input type="search" placeholder={t('city_search')} value={cityQuery} onChange={(e) => setCityQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && cityQuery.trim().length >= 2 && void searchCity()} />
            <button type="button" className="btn btn-plain btn-small" disabled={cityQuery.trim().length < 2 || act.busy} onClick={() => void searchCity()}>🔎</button>
          </div>
        </RowBlock>
        {cities.map((c, i) => (
          <Row key={`${c.name}-${i}`} icon="📍" title={c.name} subtitle={[c.country, c.tz].filter(Boolean).join(' · ')} onClick={() => { setCities([]); setCityQuery(''); void save({ homeCity: { name: c.name, lat: c.lat, lon: c.lon } }); }} />
        ))}
      </Section>

      <Section title={t('approval_expiry')}>
        <RowBlock>
          <Segmented
            value={String(EXPIRY.includes(st.approvalExpiryMin) ? st.approvalExpiryMin : 1440)}
            onChange={(v) => void save({ approvalExpiryMin: Number(v) })}
            options={EXPIRY.map((m) => ({ value: String(m), label: m < 60 ? t('minutes_n', { n: m }) : t('hours_n', { n: m / 60 }) }))}
          />
        </RowBlock>
      </Section>
      <Toast text={toast?.text ?? null} k={toast?.k ?? 0} ms={1200} />
    </div>
  );
}
