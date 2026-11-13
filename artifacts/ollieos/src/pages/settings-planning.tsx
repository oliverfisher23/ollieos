import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetDayPlanQueryKey, getGetNudgeSettingsQueryKey, getGetWorkingHoursQueryKey, sendTestNudge, updateNudgeSettings, updateWorkingHours, useGetNudgeSettings, useGetWorkingHours, type NudgeSettings } from '@workspace/api-client-react';
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
    <>
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
    <NudgesSection endOfDay={h?.end ?? '18:00'} />
    </>
  );
}

const NUDGES: { key: 'morning' | 'meeting' | 'evening'; label: string; line: (end: string) => string }[] = [
  { key: 'morning', label: 'Morning', line: () => "After the digest: today's plan, meetings you have not prepared for and messages to answer." },
  { key: 'meeting', label: 'Before a meeting', line: () => '15 minutes before a work meeting that has a prep page, with a link to it.' },
  { key: 'evening', label: 'End of day', line: (end) => `At ${end}: what you finished, what is still due and who is ready for a chase.` },
];

/**
 * Section 30, Part F: nudges from the OllieOS Slack app to Ollie himself. Off until turned on, and
 * the switches are locked until the app's token is in place, with the steps to add it.
 */
function NudgesSection({ endOfDay }: { endOfDay: string }) {
  const qc = useQueryClient();
  const q = useGetNudgeSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const d = q.data;

  const set = async (key: keyof Pick<NudgeSettings, 'morning' | 'meeting' | 'evening'>, on: boolean) => {
    setBusy(key);
    try {
      qc.setQueryData(getGetNudgeSettingsQueryKey(), await updateNudgeSettings({ [key]: on }));
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    try {
      await sendTestNudge();
      notify('Test sent', 'Look for a message from OllieOS in Slack.');
    } catch (err) {
      reportApiError(err);
      notify('The test did not send', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="oo-panel flex flex-col gap-4 px-5 py-7 sm:px-8 sm:py-8" aria-labelledby="nu-h" data-testid="section-nudges">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2 id="nu-h" style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Nudges on Slack</h2>
        <p className="oo-soft" style={{ margin: 0, fontSize: 14, maxWidth: '64ch', lineHeight: 1.6 }}>
          Short messages to you from OllieOS, on weekdays, so you do not have to open it to know what needs you. Only ever to you. Nothing is sent on a day with nothing to say, and tasks and meetings hidden from AI are never named.
        </p>
      </div>
      {q.isLoading ? (
        <Skel h={120} />
      ) : !d ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }} data-testid="state-nudges-error">
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load your nudges.</p>
          <button type="button" className="oo-btn oo-btn-outline" onClick={() => q.refetch()} data-testid="button-retry-nudges">Try again</button>
        </div>
      ) : (
        <>
          {!d.appConnected && (
            <div className="oo-plan-warn" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }} data-testid="banner-nudges-setup">
              <strong style={{ fontWeight: 600 }}>The OllieOS Slack app is not connected yet.</strong>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7, listStyle: 'decimal' }}>
                <li>At api.slack.com/apps, create an app called OllieOS in the Springpod workspace.</li>
                <li>Under App Home, turn on the Messages tab. Under OAuth and Permissions, add the bot scope <code>chat:write</code>, then install the app.</li>
                <li>Copy the Bot User OAuth Token (it starts <code>xoxb-</code>) into a Replit secret named <code>SLACK_BOT_TOKEN</code>, and publish again.</li>
              </ol>
            </div>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
            {NUDGES.map((n) => (
              <li key={n.key} className="oo-krow" style={{ flexWrap: 'nowrap', alignItems: 'center', gap: 16 }}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span id={'nudge-' + n.key} style={{ fontWeight: 500 }}>{n.label}</span>
                  <span className="oo-muted" style={{ fontSize: 13 }}>{n.line(endOfDay)}</span>
                </span>
                <button type="button" role="switch" className="oo-switch" aria-checked={d[n.key]} aria-labelledby={'nudge-' + n.key}
                  disabled={busy !== null || !d.appConnected} onClick={() => set(n.key, !d[n.key])} data-testid={'switch-nudge-' + n.key} />
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button type="button" className="oo-btn oo-btn-outline" disabled={busy !== null || !d.appConnected} onClick={test} data-testid="button-nudge-test">
              {busy === 'test' ? 'Sending…' : 'Send a test'}
            </button>
            <span className="oo-muted" style={{ fontSize: 13 }}>Sends one message to you now, to check the app can reach you.</span>
          </div>
        </>
      )}
    </section>
  );
}
