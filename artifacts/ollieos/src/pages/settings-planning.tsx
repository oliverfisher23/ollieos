import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetDayPlanQueryKey, getGetWorkingHoursQueryKey, updateWorkingHours, useGetWorkingHours } from '@workspace/api-client-react';
import { Skel } from '@/components/bits';
import { Dropdown } from '@/components/dropdown';
import { errorMessage, notify } from '@/lib/notify';
import { reportApiError } from '@/lib/forbidden';

/** Every half hour from 06:00 to 23:00. */
const TIMES = Array.from({ length: 35 }, (_, i) => {
  const m = 6 * 60 + i * 30;
  const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { value: v, label: v };
});

/** Working hours for Plan my day: tasks are only fitted between these times. */
export default function PlanningSettings() {
  const qc = useQueryClient();
  const hours = useGetWorkingHours();
  const [saving, setSaving] = useState(false);

  const save = async (start: string, end: string) => {
    setSaving(true);
    try {
      const res = await updateWorkingHours({ start, end });
      qc.setQueryData(getGetWorkingHoursQueryKey(), res);
      void qc.invalidateQueries({ queryKey: getGetDayPlanQueryKey() });
      notify('Working hours saved', `${res.start} to ${res.end}. Use Fit again on Home to refit today's plan.`);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const h = hours.data;
  return (
    <section className="oo-panel flex flex-col gap-4 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="pl-h" data-testid="page-settings-planning">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h1 id="pl-h" style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.015em' }}>Planning</h1>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          When you plan your day on Home, tasks are fitted between your meetings inside these hours. Nothing is added to your calendar.
        </p>
      </div>
      {hours.isLoading ? (
        <Skel h={44} w={320} />
      ) : !h ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-hours-error">
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load your working hours.</p>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => hours.refetch()} data-testid="button-retry-hours">Try again</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 150 }}>
            <label htmlFor="hours-start" className="oo-field-label">Start</label>
            <Dropdown id="hours-start" value={h.start} disabled={saving} searchable={false}
              onChange={(v) => v < h.end ? void save(v, h.end) : notify('Start must be before the end', `Your day ends at ${h.end}.`)}
              options={TIMES.filter((t) => t.value < '22:00')} testId="select-hours-start" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 150 }}>
            <label htmlFor="hours-end" className="oo-field-label">End</label>
            <Dropdown id="hours-end" value={h.end} disabled={saving} searchable={false}
              onChange={(v) => v > h.start ? void save(h.start, v) : notify('End must be after the start', `Your day starts at ${h.start}.`)}
              options={TIMES.filter((t) => t.value > '07:00')} testId="select-hours-end" />
          </div>
          <span className="oo-muted" style={{ fontSize: 13, paddingBottom: 10 }}>The usual is 09:00 to 18:00.</span>
        </div>
      )}
    </section>
  );
}
