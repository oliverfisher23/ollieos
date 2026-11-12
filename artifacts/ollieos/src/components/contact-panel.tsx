/**
 * The quick view on Contacts: a person's details, recent contact, what is owed and their talking
 * points in a panel over the list, so Ollie does not leave it. Everything here saves straight away.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { updatePerson, useGetPerson, type PersonListItem, type PersonUpdate } from '@workspace/api-client-react';
import { formatShort } from '@workspace/shared';
import { Avatar, Skel } from '@/components/bits';
import { IconClose } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { CadencePill, CadenceSelect } from '@/components/cadence';
import { ContactActionButtons, ContactNoteDialog, StrengthPill, TagEditor, contactDate } from '@/components/contact-bits';
import { PersonTalkingPoints } from '@/components/talking-points';
import { LockMark, Timeline } from '@/components/knowledge/parts';
import { firstName, useKnowledgeWrite } from '@/lib/knowledge';

export function ContactPanel({ p, allTags, onClose, onDraft }: { p: PersonListItem; allTags: string[]; onClose: () => void; onDraft: () => void }) {
  const detail = useGetPerson(p.slug);
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const first = firstName(p.name);
  const save = (patch: PersonUpdate, done?: string) => write(() => updatePerson(p.slug, patch), { done });

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Esc closes the panel, unless a dialog or a field inside it is using the key.
      if (e.key !== 'Escape' || document.querySelector('[role="dialog"][data-state="open"]')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [p.slug]);

  const d = detail.data;
  const due = p.cadence.status === 'overdue' || p.cadence.status === 'due_soon';
  return (
    <>
      <div className="oo-detail-scrim" data-over="true" onClick={onClose} aria-hidden="true" />
      <aside ref={panelRef} tabIndex={-1} className="oo-detail oo-fade-in" data-over="true" aria-labelledby="cp-name" data-testid="panel-contact" style={{ outline: 'none' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span className="oo-serif oo-muted" style={{ fontSize: 16 }}>Contact</span>
          <button type="button" className="oo-close" aria-label="Close" onClick={onClose} data-testid="button-close-contact"><IconClose size={14} /></button>
        </div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Avatar name={p.name} id={p.id} size={48} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <h2 id="cp-name" style={{ margin: 0, fontSize: 22, fontWeight: 600, overflowWrap: 'anywhere' }}>
              {p.name} {p.confidential && <LockMark />}
            </h2>
            {(p.organisation || p.role) && (
              <span className="oo-muted" style={{ fontSize: 14 }}>
                {p.organisation && <Link href={'/knowledge/organisations/' + p.organisation.slug} className="oo-krow-link">{p.organisation.name}</Link>}
                {p.organisation && p.role ? ' · ' : ''}
                {p.role}
              </span>
            )}
            <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
              <StrengthPill strength={p.strength} testId="pill-contact-strength" />
              {p.internal && <span className="oo-pill" data-tone="internal">Internal</span>}
              {p.cadence.cadence !== 'none' && <CadencePill c={p.cadence} />}
              {p.archived && <span className="oo-pill" data-tone="archived">Archived</span>}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ContactActionButtons p={p} onTask={() => setAdding(true)} />
          {due && <div><button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={onDraft} data-testid="button-contact-checkin">Draft a check-in</button></div>}
        </div>

        <section aria-labelledby="cp-details" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h3 id="cp-details" className="oo-h2">Details</h3>
          <dl className="oo-dl">
            <dt>Email</dt>
            <dd><InlineText value={p.email} label="Email" placeholder="Add an email" testId="contact-email" onSave={(v) => save({ email: v })} /></dd>
            <dt>Phone</dt>
            <dd><InlineText value={p.phone} label="Phone" placeholder="Add a phone number" maxLength={60} testId="contact-phone" onSave={(v) => save({ phone: v })} /></dd>
            <dt>Last contact</dt>
            <dd data-testid="text-contact-last">{p.lastContactAt ? contactDate(p.lastContactAt) : 'None on file'}</dd>
            <dt>Keep in touch</dt>
            <dd><CadenceSelect personSlug={p.slug} name={p.name} value={p.cadence.cadence} label="Cadence" testId="select-contact-cadence" /></dd>
            <dt>Tags</dt>
            <dd><TagEditor tags={p.tags} all={allTags} name={p.name} testId="tags-contact" onChange={(tags) => void save({ tags })} /></dd>
          </dl>
        </section>

        {detail.isLoading ? (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><Skel h={60} /><Skel h={90} /></div>
        ) : !d ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
            <p className="oo-muted" style={{ margin: 0 }}>Could not load the rest.</p>
            <button type="button" className="oo-btn oo-btn-outline" onClick={() => detail.refetch()}>Try again</button>
          </div>
        ) : (
          <>
            <section aria-labelledby="cp-owe" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h3 id="cp-owe" className="oo-h2">Open between us</h3>
              {d.iOwe.length === 0 && d.theyOwe.length === 0 ? (
                <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Nothing open.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {[{ label: `I owe ${first}`, tone: 'mine', list: d.iOwe }, { label: `${first} owes me`, tone: 'theirs', list: d.theyOwe }].filter((g) => g.list.length).map((g) => (
                    <div key={g.tone} className="oo-owe">
                      <span className="oo-owe-label" data-tone={g.tone}>{g.label}</span>
                      {g.list.map((t) => (
                        <Link key={t.id} href={'/tasks?task=' + t.id} className="oo-krow-link" style={{ fontSize: 14 }}>
                          {t.title}{t.dueDate ? <span className="oo-muted"> · {formatShort(t.dueDate)}</span> : null}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <PersonTalkingPoints slug={p.slug} first={first} />

            <section aria-labelledby="cp-recent" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h3 id="cp-recent" className="oo-h2">Recent contact</h3>
              <Timeline items={d.timeline.slice(0, 5)} empty={`Nothing with ${first} yet.`} compact />
            </section>
          </>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <Link href={'/knowledge/people/' + p.slug} className="oo-btn oo-btn-outline" data-testid="link-contact-page">Open full page</Link>
          <button
            type="button"
            className="oo-textbtn"
            onClick={() => void save({ archived: !p.archived }, p.archived ? `${first} is back in Contacts` : `${first} archived`)}
            data-testid="button-contact-archive"
          >
            {p.archived ? 'Bring back from the archive' : 'Archive'}
          </button>
        </div>
      </aside>
      {adding && <ContactNoteDialog kind="task" person={p} onClose={() => setAdding(false)} />}
    </>
  );
}
