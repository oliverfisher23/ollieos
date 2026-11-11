import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  addBriefTalkingPoint,
  addTalkingPoint,
  deleteTalkingPoint,
  getGetBriefQueryKey,
  getListTalkingPointsQueryKey,
  setTalkingPointRaised,
  useListTalkingPoints,
  type TalkingPoint,
} from '@workspace/api-client-react';
import { formatShort } from '@workspace/shared';
import { Dropdown } from '@/components/dropdown';
import { reportApiError } from '@/lib/forbidden';
import { errorMessage, notify } from '@/lib/notify';

const MAX = 300;

/**
 * "Next time I see…" on a person page (build plan section 14, Part K): points to raise, ticked
 * off by hand or when a meeting's Granola notes show they were covered.
 */
export function PersonTalkingPoints({ slug, first }: { slug: string; first: string }) {
  const qc = useQueryClient();
  const q = useListTalkingPoints(slug, { query: { queryKey: getListTalkingPointsQueryKey(slug) } });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: getListTalkingPointsQueryKey(slug) });

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (done) notify(done);
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    void act(async () => {
      await addTalkingPoint(slug, { text: v });
      setText('');
    });
  };

  const open = q.data?.open ?? [];
  const raised = q.data?.raised ?? [];
  return (
    <section aria-labelledby="ntis-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="section-talking-points">
      <h2 id="ntis-h" className="oo-h2">Next time I see {first}</h2>
      <p className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
        Points to raise. They go at the top of the agenda for your next meeting with {first}, and are ticked off when the meeting notes show you covered them.
      </p>
      {open.length > 0 && (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="list-points-open">
          {open.map((p) => <PointRow key={p.id} p={p} busy={busy} onTick={() => act(() => setTalkingPointRaised(p.id, { raised: true }), 'Marked as raised')} onRemove={() => act(() => deleteTalkingPoint(p.id))} />)}
        </ul>
      )}
      <form onSubmit={add} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <label htmlFor="point-new" className="sr-only">New point to raise with {first}</label>
        <input id="point-new" className="oo-input" style={{ flex: '1 1 260px' }} value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)}
          placeholder="Something to raise next time" data-testid="input-point" />
        <button type="submit" className="oo-btn oo-btn-outline" disabled={busy || !text.trim()} data-testid="button-point-add">Add</button>
      </form>
      {raised.length > 0 && (
        <details data-testid="details-points-raised">
          <summary className="oo-soft" style={{ fontSize: 13, cursor: 'pointer' }}>Raised ({raised.length})</summary>
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {raised.map((p) => (
              <li key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 14 }}>
                <span style={{ flex: '1 1 220px' }}>{p.text}</span>
                <span className="oo-muted" style={{ fontSize: 12 }}>
                  {p.raisedAt ? formatShort(p.raisedAt) : ''}{p.raisedTitle ? `, ${p.raisedTitle}` : ''}{p.raisedHow === 'notes' ? ' (from the notes)' : ''}
                </span>
                <button type="button" className="oo-mini" disabled={busy} onClick={() => act(() => setTalkingPointRaised(p.id, { raised: false }))} data-testid={'button-point-reopen-' + p.id}>Not raised</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function PointRow({ p, busy, onTick, onRemove, who }: { p: TalkingPoint; busy: boolean; onTick: () => void; onRemove: () => void; who?: string | null }) {
  return (
    <li style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 14 }} data-testid={'item-point-' + p.id}>
      <span style={{ flex: '1 1 220px', lineHeight: 1.5 }}>
        {who && <span className="oo-muted">{who}: </span>}
        {p.text}
        {p.createdBy !== 'ollie' && <span className="oo-muted" style={{ fontSize: 12 }}> (added by {p.createdBy})</span>}
      </span>
      <span style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="oo-mini" disabled={busy} onClick={onTick} data-testid={'button-point-tick-' + p.id}>Raised</button>
        <button type="button" className="oo-mini" disabled={busy} onClick={onRemove} data-testid={'button-point-remove-' + p.id}>Remove</button>
      </span>
    </li>
  );
}

/** On a meeting's prep page: open points for people in the room, and a quick add. */
export function BriefTalkingPoints({ eventId, points, people }: { eventId: number; points: TalkingPoint[]; people: { id: number; name: string }[] }) {
  const qc = useQueryClient();
  const [personId, setPersonId] = useState(people.length === 1 ? String(people[0].id) : '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: getGetBriefQueryKey(eventId) });

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      reportApiError(err);
      notify('That did not save', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!points.length && !people.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="brief-talking-points">
      <span className="oo-field-label">Things you wanted to raise</span>
      {points.length === 0 ? (
        <span className="oo-muted" style={{ fontSize: 13 }}>Nothing yet for the people in this meeting.</span>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {points.map((p) => (
            <PointRow key={p.id} p={p} who={p.personName} busy={busy} onTick={() => act(() => setTalkingPointRaised(p.id, { raised: true }))} onRemove={() => act(() => deleteTalkingPoint(p.id))} />
          ))}
        </ul>
      )}
      {people.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v || !personId) return;
            void act(async () => {
              await addBriefTalkingPoint(eventId, { personId: Number(personId), text: v });
              setText('');
            });
          }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
        >
          {people.length > 1 && (
            <Dropdown value={personId} onChange={setPersonId} options={people.map((p) => ({ value: String(p.id), label: p.name }))} placeholder="Who with" ariaLabel="Who to raise it with" variant="compact" testId="select-point-person" />
          )}
          <label htmlFor="brief-point-new" className="sr-only">Point to raise</label>
          <input id="brief-point-new" className="oo-input" style={{ flex: '1 1 220px' }} value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)}
            placeholder="Add something to raise" data-testid="input-brief-point" />
          <button type="submit" className="oo-btn oo-btn-outline" disabled={busy || !text.trim() || !personId} data-testid="button-brief-point-add">Add</button>
        </form>
      )}
    </div>
  );
}
