import { useState } from 'react';
import { getGetTaskSlackDmOptionsQueryKey, sendTaskSlackDm, useGetTaskSlackDmOptions, type SlackDmResult, type Task } from '@workspace/api-client-react';
import { Dropdown } from '@/components/dropdown';
import { useInvalidateTasks } from '@/lib/task-cache';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const MAX = 3000;

/**
 * Message a colleague on Slack from a task, to delegate it or ask their view. OllieOS sends the DM
 * as you after you confirm, then the task waits on them. Only colleagues with Slack, never anyone
 * at an outside organisation.
 */
export function SlackDm({ task }: { task: Task }) {
  const invalidate = useInvalidateTasks();
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState('');
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<SlackDmResult | null>(null);
  const q = useGetTaskSlackDmOptions(task.id, { query: { queryKey: getGetTaskSlackDmOptionsQueryKey(task.id), enabled: open, staleTime: 60_000 } });
  const people = q.data?.people ?? [];
  const chosen = personId || (q.data?.suggestedPersonId ? String(q.data.suggestedPersonId) : '');
  const name = people.find((p) => String(p.id) === chosen)?.name ?? '';

  const send = async () => {
    setBusy(true);
    try {
      const r = await sendTaskSlackDm(task.id, { personId: Number(chosen), text: text.trim() });
      setSent(r);
      setOpen(false);
      setConfirming(false);
      setText('');
      await invalidate();
      notify(`Sent to ${r.personName}`, `The task is now waiting on ${r.personName}.`);
    } catch (err) {
      reportApiError(err);
      notify('Not sent', errorMessage(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <button type="button" className="oo-btn oo-btn-outline" onClick={() => setOpen(true)} data-testid="button-slack-dm">Message on Slack</button>
        {sent && (
          <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-slack-dm-sent">
            Sent to {sent.personName}. <a href={sent.url} target="_blank" rel="noreferrer" className="oo-link">Open in Slack</a>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="oo-source" style={{ gap: 10 }} data-testid="card-slack-dm">
      <span style={{ fontSize: 13, fontWeight: 500 }}>Message a colleague on Slack</span>
      {q.isLoading ? (
        <span className="oo-muted" style={{ fontSize: 13 }}>Loading colleagues…</span>
      ) : !people.length ? (
        <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-slack-dm-none">
          No colleagues with a Slack account yet. People are matched to their Slack account when OllieOS reads Slack.
        </span>
      ) : (
        <>
          <Dropdown
            value={chosen}
            onChange={(v) => { setPersonId(v); setConfirming(false); }}
            options={people.map((p) => ({ value: String(p.id), label: p.name, hint: p.role ?? undefined }))}
            placeholder="Who to message"
            searchable
            ariaLabel="Who to message"
            testId="select-slack-dm-person"
          />
          <label className="oo-sr" htmlFor={'slack-dm-' + task.id}>Message</label>
          <textarea
            id={'slack-dm-' + task.id}
            className="oo-input"
            rows={3}
            maxLength={MAX}
            value={text}
            onChange={(e) => { setText(e.target.value); setConfirming(false); }}
            placeholder={`For example: Do you want to schedule this? (${task.title})`}
            style={{ resize: 'vertical' }}
            data-testid="input-slack-dm"
          />
          <span className="oo-muted" style={{ fontSize: 12 }}>Sent as you, as a direct message. The task then waits on them, and their reply shows on it.</span>
          {confirming ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }} data-testid="confirm-slack-dm">
              <span style={{ fontSize: 14 }}>Send this to {name} on Slack, as you?</span>
              <button type="button" className="oo-btn oo-btn-ink" disabled={busy} onClick={() => void send()} data-testid="button-slack-dm-confirm">{busy ? 'Sending…' : `Yes, send to ${name.split(' ')[0]}`}</button>
              <button type="button" className="oo-btn oo-btn-outline" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" className="oo-btn oo-btn-ink" disabled={!chosen || !text.trim()} onClick={() => setConfirming(true)} data-testid="button-slack-dm-send">Send</button>
              <button type="button" className="oo-btn oo-btn-outline" onClick={() => { setOpen(false); setConfirming(false); }} data-testid="button-slack-dm-cancel">Cancel</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
