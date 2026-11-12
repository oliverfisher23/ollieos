/**
 * Small pieces shared by Contacts, the quick view and the person page: the strength pill, the tag
 * editor, and the actions on a contact (email, Slack, LinkedIn, phone, a talking point, a task).
 * OllieOS never sends anything here: email, Slack and LinkedIn open in their own apps.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { addTalkingPoint, getListTalkingPointsQueryKey, quickAddTask, updateTask, type Strength } from '@workspace/api-client-react';
import { STRENGTH_LABELS, TAGS_MAX, TAG_MAX_CHARS, cleanTags, formatDayMonthShort, londonDate } from '@workspace/shared';
import { firstName, useKnowledgeWrite } from '@/lib/knowledge';

const STRENGTH_HINT: Record<Strength, string> = {
  strong: 'In touch on six or more days in the last four months, and in the last 30 days',
  warm: 'In touch in the last two weeks, or more than once in the last six weeks',
  cooling: 'Some contact in the last four months, but not much lately',
  cold: 'No contact in four months, or none on file',
};

/** "5th Nov", with the year once it is more than about ten months ago, so an old date is not read as a recent one. */
export function contactDate(d: Date | string): string {
  const date = new Date(d);
  const old = Date.now() - date.getTime() > 300 * 86_400_000;
  return formatDayMonthShort(date) + (old ? ` ${londonDate(date).slice(0, 4)}` : '');
}

export function StrengthPill({ strength, testId }: { strength: Strength; testId?: string }) {
  return <span className="oo-pill oo-strength" data-strength={strength} title={STRENGTH_HINT[strength]} data-testid={testId}>{STRENGTH_LABELS[strength]}</span>;
}

/** Tags as chips, with a box to add one. Suggests the tags already in use. Saves on every change. */
export function TagEditor({ tags, all, onChange, name, testId }: { tags: string[]; all: string[]; onChange: (tags: string[]) => void; name: string; testId: string }) {
  const [text, setText] = useState('');
  const listId = useId();
  const have = new Set(tags.map((t) => t.toLowerCase()));
  const add = (e: FormEvent) => {
    e.preventDefault();
    const next = cleanTags([...tags, text]);
    setText('');
    if (next.length !== tags.length) onChange(next);
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }} data-testid={testId}>
      {tags.map((t) => (
        <span key={t} className="oo-tag" data-testid={`${testId}-${t.toLowerCase().replace(/\s+/g, '-')}`}>
          {t}
          <button type="button" aria-label={`Remove the tag ${t} from ${name}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</button>
        </span>
      ))}
      {tags.length < TAGS_MAX && (
        <form onSubmit={add} style={{ display: 'inline-flex' }}>
          <label className="oo-sr" htmlFor={listId + '-in'}>Add a tag to {name}</label>
          <input
            id={listId + '-in'}
            className="oo-input oo-input-sm"
            style={{ width: 120 }}
            list={listId}
            maxLength={TAG_MAX_CHARS}
            placeholder="Add a tag"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid={testId + '-input'}
          />
          <datalist id={listId}>{all.filter((t) => !have.has(t.toLowerCase())).map((t) => <option key={t} value={t} />)}</datalist>
        </form>
      )}
    </div>
  );
}

export interface ContactLike {
  id: number;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  slackUserId: string | null;
}

/** Where each action goes. Slack opens the direct message with them in Slack itself. */
export const contactLinks = (p: ContactLike) => ({
  email: p.email ? `mailto:${p.email}` : null,
  slack: p.slackUserId ? `https://slack.com/app_redirect?channel=${encodeURIComponent(p.slackUserId)}` : null,
  linkedin: p.linkedinUrl,
  phone: p.phone ? `tel:${p.phone.replace(/[^\d+]/g, '')}` : null,
});

/** Email, Slack, LinkedIn and Call as links, then a talking point and a task. */
export function ContactActionButtons({ p, onTalkingPoint, onTask }: { p: ContactLike; onTalkingPoint?: () => void; onTask: () => void }) {
  const l = contactLinks(p);
  const link = (href: string | null, label: string, id: string, newTab = false): ReactNode =>
    href ? (
      <a href={href} className="oo-btn oo-btn-outline oo-btn-sm" {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})} data-testid={`link-contact-${id}-${p.slug}`}>{label}</a>
    ) : null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} data-testid={'actions-contact-' + p.slug}>
      {link(l.email, 'Email', 'email')}
      {link(l.slack, 'Slack', 'slack', true)}
      {link(l.linkedin, 'LinkedIn', 'linkedin', true)}
      {link(l.phone, 'Call', 'call')}
      {onTalkingPoint && <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={onTalkingPoint} data-testid={'button-contact-point-' + p.slug}>Add a talking point</button>}
      <button type="button" className="oo-btn oo-btn-outline oo-btn-sm" onClick={onTask} data-testid={'button-contact-task-' + p.slug}>Add a task</button>
    </div>
  );
}

/** A one-line dialog: a task for someone, or a point to raise next time. */
export function ContactNoteDialog({ kind, person, onClose }: { kind: 'task' | 'point'; person: { id: number; name: string; slug: string }; onClose: () => void }) {
  const write = useKnowledgeWrite();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const first = firstName(person.name);
  const task = kind === 'task';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setBusy(true);
    const ok = await write(
      async () => {
        if (task) {
          const r = await quickAddTask({ text: v });
          await updateTask(r.task.id, { personId: person.id });
        } else {
          await addTalkingPoint(person.slug, { text: v });
          await qc.invalidateQueries({ queryKey: getListTalkingPointsQueryKey(person.slug) });
        }
        return true;
      },
      { done: task ? `Task added for ${first}` : `Added to next time you see ${first}` },
    );
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 480 }} aria-describedby="cn-desc" data-testid={'dialog-contact-' + kind}>
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{task ? `A task for ${first}` : `Next time I see ${first}`}</Dialog.Title>
            <p id="cn-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              {task ? `It goes to your inbox, linked to ${first}. The quick add shortcuts work: !high, due:fri, @project.` : 'It goes at the top of the agenda for your next meeting with them.'}
            </p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label className="oo-sr" htmlFor="cn-text">{task ? 'Task' : 'Point to raise'}</label>
              <input id="cn-text" className="oo-input" autoFocus maxLength={300} value={text} onChange={(e) => setText(e.target.value)} placeholder={task ? 'What needs doing' : 'Something to raise'} data-testid={`input-contact-${kind}`} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className="oo-btn oo-btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={busy || !text.trim()} data-testid={`button-contact-${kind}-save`}>{busy ? 'Adding…' : 'Add'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
