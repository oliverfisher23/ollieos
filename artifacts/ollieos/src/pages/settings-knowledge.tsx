import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetKnowledgeSettingsQueryKey,
  getGetRoundupScheduleQueryKey,
  runFactCheck,
  setRoundupSchedule,
  useGetRoundupSchedule,
  type RoundupSchedule,
  updateKnowledgeSettings,
  useGetKnowledgeSettings,
  type ShelfLives,
} from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { whenLabel } from '@/lib/access';
import { useInvalidateKnowledge } from '@/lib/knowledge';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

const H1 = { margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' } as const;
const H2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;

const ROWS: { key: keyof ShelfLives; label: string; line: string }[] = [
  { key: 'status', label: 'Status', line: 'Where a project stands' },
  { key: 'next_step', label: 'Next step', line: 'What happens next on a project' },
  { key: 'decision_date', label: 'Decision date', line: 'When something will be decided' },
  { key: 'general', label: 'General facts', line: 'Any fact without a kind' },
  { key: 'job_title', label: 'Job title', line: 'Someone’s role' },
  { key: 'organisation', label: 'Organisation', line: 'Where someone works' },
];

export default function KnowledgeSettings() {
  const settings = useGetKnowledgeSettings();
  const qc = useQueryClient();
  const invalidate = useInvalidateKnowledge();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  const s = settings.data;

  useEffect(() => {
    if (s) setValues(Object.fromEntries(ROWS.map((r) => [r.key, String(s.shelfLifeDays[r.key])])));
  }, [s]);

  const invalid = ROWS.some((r) => {
    const n = Number(values[r.key]);
    return !Number.isInteger(n) || n < 1 || n > 3650;
  });
  const changed = s ? ROWS.filter((r) => Number(values[r.key]) !== s.shelfLifeDays[r.key]) : [];

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid || !changed.length || saving) return;
    setSaving(true);
    try {
      const updated = await updateKnowledgeSettings({ shelfLifeDays: Object.fromEntries(changed.map((r) => [r.key, Number(values[r.key])])) });
      qc.setQueryData(getGetKnowledgeSettingsQueryKey(), updated);
      notify('Shelf lives saved', 'They apply from the next check.');
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setChecked(null);
    try {
      const r = await runFactCheck();
      invalidate();
      qc.invalidateQueries({ queryKey: getGetKnowledgeSettingsQueryKey() });
      const parts = [
        r.stale === 1 ? '1 fact needs a check' : `${r.stale} facts need a check`,
        r.conflicts === 1 ? '1 conflict' : `${r.conflicts} conflicts`,
      ];
      setChecked(`Check finished: ${parts.join(', ')}.`);
    } catch (err) {
      reportApiError(err);
      notify('The check did not run', errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <section className="oo-panel flex flex-col gap-1.5 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="ks-h" data-testid="page-settings-knowledge">
        <h1 id="ks-h" style={H1}>Knowledge</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          Facts go stale. Once a fact has gone this long without anyone confirming it, it moves to Needs a check in the{' '}
          <Link href="/knowledge/inbox">Knowledge Inbox</Link>. The check runs once a week, after the first check by OllieOS or the Claude sweep after Sunday 18:00.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button type="button" className="oo-btn oo-btn-outline" disabled={checking} onClick={check} data-testid="button-run-fact-check">
            {checking ? 'Checking…' : 'Check now'}
          </button>
          <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-last-check">
            {s === undefined ? '' : s.lastCheckAt ? `Last check ${whenLabel(s.lastCheckAt)}` : 'No check has run yet'}
          </span>
        </div>
        {checked && <p role="status" style={{ margin: '6px 0 0', fontSize: 13 }} className="oo-soft" data-testid="text-check-result">{checked}</p>}
      </section>

      <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="ks-shelf-h">
        <h2 id="ks-shelf-h" style={H2}>Shelf life, in days</h2>
        {settings.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 8 }}>
            {ROWS.map((r) => <Skel key={r.key} h={38} />)}
          </div>
        ) : settings.error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-knowledge-settings-error">
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load these settings.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => settings.refetch()}>Try again</button>
          </div>
        ) : (
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column' }}>
            {ROWS.map((r) => {
              const id = 'shelf-' + r.key;
              return (
                <div key={r.key} className="oo-krow">
                  <label htmlFor={id} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <span style={{ fontWeight: 500 }}>{r.label}</span>
                    <span className="oo-muted" style={{ fontSize: 13 }}>{r.line}</span>
                  </label>
                  <input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={3650}
                    className="oo-input oo-num"
                    style={{ width: 110 }}
                    value={values[r.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [r.key]: e.target.value }))}
                    data-testid={'input-' + id}
                  />
                </div>
              );
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 14, flexWrap: 'wrap' }}>
              <button type="submit" className="oo-btn oo-btn-ink" disabled={invalid || !changed.length || saving} data-testid="button-save-shelf-lives">
                {saving ? 'Saving…' : 'Save'}
              </button>
              {invalid && <span style={{ fontSize: 13, color: 'var(--oo-danger)' }}>Each one must be a whole number from 1 to 3650.</span>}
            </div>
          </form>
        )}
      </section>

      <RoundupSettings />
    </>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Part O: when the weekly round-up is made. */
function RoundupSettings() {
  const q = useGetRoundupSchedule();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const save = async (next: RoundupSchedule) => {
    setSaving(true);
    try {
      const r = await setRoundupSchedule(next);
      qc.setQueryData(getGetRoundupScheduleQueryKey(), r);
      void qc.invalidateQueries({ predicate: (x) => typeof x.queryKey[0] === 'string' && (x.queryKey[0] as string).startsWith('/api/roundups') });
      notify(`The round-up is now made each ${DAYS[r.day]} at ${String(r.hour).padStart(2, '0')}:00`);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="oo-panel flex flex-col gap-2 px-5 py-6 sm:px-8" aria-labelledby="ks-roundup-h" data-testid="section-roundup-settings">
      <h2 id="ks-roundup-h" style={H2}>Weekly round-up</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 14, maxWidth: '64ch' }}>
        What was approved, contradicted and went stale over the week. It is made at this time, the next time OllieOS has fresh data. <Link href="/digest/week" style={{ color: 'var(--oo-ink)' }} data-testid="link-roundup-page">Open the round-up</Link>
      </p>
      {q.isLoading ? (
        <Skel h={38} />
      ) : !q.data ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load this setting.</p>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()}>Try again</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingTop: 6, fontSize: 14 }}>
          <label htmlFor="roundup-day" className="oo-muted">Each</label>
          <Dropdown
            id="roundup-day"
            variant="control"
            value={String(q.data.day)}
            disabled={saving}
            onChange={(v) => save({ day: Number(v), hour: q.data!.hour })}
            options={DAY_ORDER.map((d) => ({ value: String(d), label: DAYS[d] }))}
            testId="select-roundup-day"
          />
          <label htmlFor="roundup-hour" className="oo-muted">at</label>
          <Dropdown
            id="roundup-hour"
            variant="control"
            value={String(q.data.hour)}
            disabled={saving}
            onChange={(v) => save({ day: q.data!.day, hour: Number(v) })}
            options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))}
            testId="select-roundup-hour"
          />
        </div>
      )}
    </section>
  );
}
