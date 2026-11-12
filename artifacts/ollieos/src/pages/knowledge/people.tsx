import { useState } from 'react';
import { PersonTalkingPoints } from '@/components/talking-points';
import { Link, useParams } from 'wouter';
import {
  updatePerson,
  useGetPerson,
  useListOrganisations,
  useListPeople,
  type PersonDetail,
  type PersonUpdate,
} from '@workspace/api-client-react';
import { formatDayMonth, formatShort } from '@workspace/shared';
import { IconLeft } from '@/components/icons';
import { InlineText } from '@/components/inline-text';
import { Dropdown } from '@/components/dropdown';
import { orgOptions } from '@/components/dropdown-options';
import {
  AccessPanel,
  AddNote,
  EntityChipLink,
  FactsSection,
  LinkPicker,
  PageProblem,
  PageSkeleton,
  Timeline,
  useUnlink,
} from '@/components/knowledge/parts';
import { RelationshipsSection } from '@/components/knowledge/relationships';
import { OtherEmails, SamePersonAs, SlackAccount } from '@/components/knowledge/person-identity';
import { copyText, firstName, isNotFound, useKnowledgeWrite } from '@/lib/knowledge';
import { CadencePill, CadenceSelect, CheckInDialog } from '@/components/cadence';
import { ContactActionButtons, ContactNoteDialog, StrengthPill, TagEditor } from '@/components/contact-bits';
import { notify } from '@/lib/notify';
import { initials, toneFor } from '@/lib/task-cache';

export function PersonPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useGetPerson(slug);

  return (
    <div className="oo-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Link href="/contacts" className="oo-back" data-testid="link-back-people"><IconLeft size={14} />Contacts</Link>
      {q.isLoading ? (
        <main className="oo-panel oo-kmain" data-testid="page-person"><PageSkeleton /></main>
      ) : !q.data ? (
        <main className="oo-panel oo-kmain" data-testid="page-person">
          <PageProblem notFound={isNotFound(q.error)} what="person" onRetry={() => q.refetch()} back={{ href: '/contacts', label: 'All contacts' }} />
        </main>
      ) : (
        <PersonBody slug={slug} data={q.data} />
      )}
    </div>
  );
}

function PersonBody({ slug, data }: { slug: string; data: PersonDetail }) {
  const write = useKnowledgeWrite();
  const unlink = useUnlink();
  const orgs = useListOrganisations();
  const { person, strength, introductions, cadence, iOwe, theyOwe, projects, facts, timeline } = data;
  const [drafting, setDrafting] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const everyone = useListPeople();
  const allTags = [...new Map((everyone.data ?? []).flatMap((p) => p.tags).map((t) => [t.toLowerCase(), t])).values()].sort((a, b) => a.localeCompare(b, 'en-GB'));
  const first = firstName(person.name);
  const save = (patch: PersonUpdate, done?: string) => write(() => updatePerson(slug, patch), { done });

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      <main className="oo-panel oo-kmain" data-testid="page-person">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18 }}>
          <span className="oo-avatar" data-tone={toneFor(person.id)} aria-hidden="true" style={{ width: 64, height: 64, fontSize: 22 }}>
            {initials(person.name)}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: '1 1 260px' }}>
            <h1 className="oo-h1" style={{ fontSize: 30 }}>
              <InlineText value={person.name} label="Name" required maxLength={200} testId="person-name" onSave={(v) => save({ name: v ?? person.name })} />
            </h1>
            <p className="oo-eyebrow">
              {person.organisation ? (
                <Link href={'/knowledge/organisations/' + person.organisation.slug} style={{ color: 'inherit' }} data-testid="link-person-org">{person.organisation.name}</Link>
              ) : (
                'No organisation'
              )}
              {' · '}
              <InlineText inline value={person.role} label="Role" placeholder="Add a role" testId="person-role" onSave={(v) => save({ role: v })} />
            </p>
            {!person.isSelf && (
              <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <StrengthPill strength={strength} testId="pill-person-strength" />
                {person.archived && <span className="oo-pill" data-tone="archived" data-testid="pill-person-archived">Archived</span>}
              </span>
            )}
          </div>
        </div>

        {!person.isSelf && <ContactActionButtons p={person} onTask={() => setAddingTask(true)} />}
        {addingTask && <ContactNoteDialog kind="task" person={person} onClose={() => setAddingTask(false)} />}

        {introductions.length > 0 && (
          <section aria-labelledby="intro-h" style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="section-introductions">
            <h2 id="intro-h" className="oo-h2">Who can introduce me?</h2>
            <p className="oo-muted" style={{ margin: 0, fontSize: 13, maxWidth: '72ch' }}>
              You are not in regular touch with {first}. These are people you know well who are connected to them.
            </p>
            {introductions.map((i) => (
              <div key={i.via.id} className="oo-krow" data-testid={'row-introduction-' + i.via.slug}>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <Link href={'/knowledge/people/' + i.via.slug} className="oo-krow-link" style={{ fontWeight: 500 }}>{i.via.name}</Link>
                  <span className="oo-muted" style={{ fontSize: 13 }}>{[i.via.organisation, i.via.role].filter(Boolean).join(' · ')}</span>
                  <span style={{ fontSize: 13 }}>{i.via.name.split(' ')[0]} {i.how}.</span>
                </span>
                <StrengthPill strength={i.via.strength} />
              </div>
            ))}
          </section>
        )}

        <section aria-labelledby="rel-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
          <h2 id="rel-h" className="oo-h2">Relationship</h2>
          <div style={{ fontSize: 15, lineHeight: 1.6 }} className="oo-soft">
            <InlineText
              value={person.relationshipSummary}
              label="Relationship"
              multiline
              placeholder={`Who ${first} is to you, and how you work together`}
              testId="person-relationship"
              onSave={(v) => save({ relationshipSummary: v })}
            />
          </div>
        </section>

        <section aria-labelledby="owe-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 id="owe-h" className="oo-h2">Open between us</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
            <div className="oo-owe" data-testid="list-i-owe">
              <span className="oo-owe-label" data-tone="mine">I owe {first}</span>
              {iOwe.length === 0 ? <span className="oo-muted" style={{ fontSize: 14 }}>Nothing open.</span> : iOwe.map((t) => (
                <Link key={t.id} href={'/tasks?task=' + t.id} className="oo-krow-link" style={{ fontSize: 14 }} data-testid={'link-owe-task-' + t.id}>
                  {t.title}{t.dueDate ? <span className="oo-muted"> · {formatShort(t.dueDate)}</span> : null}
                </Link>
              ))}
            </div>
            <div className="oo-owe" data-testid="list-they-owe">
              <span className="oo-owe-label" data-tone="theirs">{first} owes me</span>
              {theyOwe.length === 0 ? <span className="oo-muted" style={{ fontSize: 14 }}>Nothing open.</span> : theyOwe.map((t) => (
                <Link key={t.id} href={'/tasks?task=' + t.id} className="oo-krow-link" style={{ fontSize: 14 }} data-testid={'link-owed-task-' + t.id}>
                  {t.title}{t.dueDate ? <span className="oo-muted"> · {formatShort(t.dueDate)}</span> : null}
                </Link>
              ))}
            </div>
          </div>
        </section>

        {!person.isSelf && <PersonTalkingPoints slug={slug} first={first} />}

        <FactsSection entityType="person" entityId={person.id} facts={facts} />
        <RelationshipsSection type="person" id={person.id} name={person.name} title="Relationships with others" />

        <section aria-labelledby="tl-h" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 id="tl-h" className="oo-h2">Timeline</h2>
          <Timeline items={timeline} empty={`Nothing with ${first} yet. Captures and notes show up here.`} />
        </section>

        <AddNote entityType="person" entityId={person.id} placeholder={`Anything worth remembering about ${first}`} />
      </main>

      <aside style={{ flex: '1 1 260px', maxWidth: 320, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section className="oo-panel" aria-labelledby="pd-h" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 id="pd-h" className="oo-h2" style={{ fontSize: 14 }}>Details</h2>
          <dl className="oo-dl">
            <dt><label htmlFor="person-org">Organisation</label></dt>
            <dd>
              <Dropdown
                id="person-org"
                variant="compact"
                value={String(person.organisation?.id ?? '')}
                onChange={(v) => save({ organisationId: v ? Number(v) : null })}
                placeholder="None"
                searchPlaceholder="Search organisations"
                options={[{ value: '', label: 'None' }, ...orgOptions(orgs.data)]}
                testId="select-person-org"
                style={{ width: '100%' }}
              />
            </dd>
            <dt>Email</dt>
            <dd><InlineText value={person.email} label="Email" placeholder="Add an email" testId="person-email" onSave={(v) => save({ email: v })} /></dd>
            <dt>Other emails</dt>
            <dd><OtherEmails person={person} /></dd>
            {/* Space above keeps its phone tap area clear of "Add another address". */}
            <dt style={{ paddingTop: 12 }}>Phone</dt>
            <dd style={{ paddingTop: 12 }}><InlineText value={person.phone} label="Phone" placeholder="Add a phone number" maxLength={60} testId="person-phone" onSave={(v) => save({ phone: v })} /></dd>
            <dt>Slack</dt>
            <dd><SlackAccount person={person} /></dd>
            <dt style={{ paddingTop: 12 }}>LinkedIn</dt>
            {/* Space above keeps its phone tap area clear of Slack's Link button. */}
            <dd style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start', minWidth: 0, paddingTop: 12 }}>
              <InlineText value={person.linkedinUrl} label="LinkedIn" placeholder="Add a LinkedIn profile link" testId="person-linkedin" onSave={(v) => save({ linkedinUrl: v })} />
              {person.linkedinUrl && (
                <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="oo-link" style={{ fontSize: 13 }} data-testid="link-person-linkedin">Open profile</a>
              )}
            </dd>
            <dt>Tags</dt>
            <dd><TagEditor tags={person.tags} all={allTags} name={person.name} testId="tags-person" onChange={(tags) => void save({ tags })} /></dd>
            <dt>Last contact</dt>
            <dd data-testid="text-last-contact">{person.lastContactAt ? formatDayMonth(person.lastContactAt) : 'None recorded'}</dd>
            {!person.isSelf && (
              <>
                <dt>Cadence</dt>
                <dd style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }} data-testid="section-person-cadence">
                  <CadenceSelect personSlug={slug} name={person.name} value={person.cadence} label="Cadence" testId="select-person-cadence" />
                  {person.cadence !== 'none' && (
                    <>
                      <CadencePill c={cadence} testId="pill-person-cadence" />
                      {cadence.pausedByProjects && <span className="oo-muted" style={{ fontSize: 12 }}>Paused because every shared project is paused or complete.</span>}
                      <button
                        type="button"
                        className="oo-textbtn"
                        onClick={() => save({ cadencePaused: !person.cadencePaused }, person.cadencePaused ? 'Check-ins resumed' : 'Check-ins paused')}
                        data-testid="button-pause-cadence"
                      >
                        {person.cadencePaused ? 'Resume check-ins' : 'Pause check-ins'}
                      </button>
                      {(cadence.status === 'overdue' || cadence.status === 'due_soon') && (
                        <button type="button" className="oo-btn oo-btn-ink oo-btn-sm" onClick={() => setDrafting(true)} data-testid="button-person-draft-checkin">Draft a check-in</button>
                      )}
                    </>
                  )}
                </dd>
              </>
            )}
            <dt>Projects</dt>
            <dd style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
              {projects.length === 0 && <span className="oo-muted">None yet</span>}
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {projects.map((p) => (
                  <EntityChipLink key={p.id} entity={p} base="/knowledge/projects" testId={'chip-project-' + p.id} onUnlink={p.linked ? () => unlink('person', person.id, 'project', p.id) : undefined} />
                ))}
              </span>
              <LinkPicker fromType="person" fromId={person.id} toType="project" exclude={projects.filter((p) => p.linked).map((p) => p.id)} />
            </dd>
          </dl>
        </section>

        {!person.isSelf && (
          <section className="oo-panel" aria-labelledby="arch-h" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 id="arch-h" className="oo-h2" style={{ fontSize: 14 }}>{person.archived ? 'Archived' : 'Archive'}</h2>
            <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>
              {person.archived
                ? `${first} is out of the main Contacts list. They come back by themselves if you are in touch again.`
                : `Takes ${first} out of the main Contacts list and ends check-ins. Nothing is deleted, and they come back if you are in touch again.`}
            </p>
            <div>
              <button
                type="button"
                className="oo-btn oo-btn-outline oo-btn-sm"
                onClick={() => save({ archived: !person.archived }, person.archived ? `${first} is back in Contacts` : `${first} archived`)}
                data-testid="button-person-archive"
              >
                {person.archived ? 'Bring back' : 'Archive'}
              </button>
            </div>
          </section>
        )}

        <section className="oo-panel" aria-labelledby="same-h" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="same-h" className="oo-h2" style={{ fontSize: 14 }}>Duplicate record?</h2>
          <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>If someone else in Contacts is also {first}, merge them here so everything is in one place.</p>
          <SamePersonAs person={person} />
        </section>

        <div className="oo-panel">
          <AccessPanel
            bare
            kind="person"
            itemId={person.id}
            confidential={person.confidential}
            aiAccess={person.aiAccess}
            testPrefix="person"
            onChange={(patch) => save(patch, patch.confidential === true ? 'Marked confidential. Hidden from AI.' : undefined)}
          />
        </div>

        <AskClaudePanel data={data} />
      </aside>
      {drafting && <CheckInDialog person={person} onClose={() => setDrafting(false)} />}
    </div>
  );
}

function bullets(items: { title: string; dueDate: string | null }[]): string {
  return items.map((t) => `- ${t.title}${t.dueDate ? ` (due ${formatShort(t.dueDate)})` : ''}`).join('\n');
}

/** Copy-ready prompts for Claude, built from what is on this page. Claude then reads OllieOS itself. */
function buildPrompts(d: PersonDetail) {
  const p = d.person;
  const first = firstName(p.name);
  const who = [p.name, [p.role, p.organisation?.name].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  const projects = d.projects.filter((x) => !x.confidential).map((x) => x.name);
  const owe = d.iOwe.length ? `What I owe ${first}:\n${bullets(d.iOwe)}` : `I have nothing open for ${first}.`;
  const owed = d.theyOwe.length ? `What ${first} owes me:\n${bullets(d.theyOwe)}` : '';
  const proj = projects.length ? `Projects: ${projects.join(', ')}.` : '';
  const followUp = [
    `Draft a follow-up email from me (Ollie) to ${who}.`,
    owe,
    owed,
    proj,
    `Read ${first}'s page and the linked projects in OllieOS before drafting. Keep it short and warm, in British English. Only mention what OllieOS records. Do not send it.`,
  ].filter(Boolean).join('\n\n');
  const brief = [
    `Brief me before my next call with ${who}.`,
    `Use OllieOS: read ${first}'s page, the linked projects, their key facts and decisions, and the recent timeline.`,
    owe,
    owed,
    proj,
    'Give me: where things stand in two or three sentences, what I owe, what they owe, and three questions worth asking. British English, short.',
  ].filter(Boolean).join('\n\n');
  return { followUp, brief, first };
}

function AskClaudePanel({ data }: { data: PersonDetail }) {
  const [copied, setCopied] = useState<string | null>(null);
  const hidden = data.person.confidential || !data.person.aiAccess;
  const { followUp, brief, first } = buildPrompts(data);
  const copy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      notify('Prompt copied', 'Paste it into Claude.');
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    } else {
      notify('Could not copy', 'Your browser blocked the clipboard.');
    }
  };
  return (
    <section className="oo-claude" aria-labelledby="ask-claude-h" data-testid="panel-ask-claude">
      <h2 id="ask-claude-h" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Ask Claude</h2>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }} className="oo-t2">
        {hidden
          ? `${first} is hidden from AI, so Claude cannot read this page. Change AI access above to use these.`
          : 'Claude reads this page and the linked project before drafting. These copy a ready-made prompt.'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button type="button" className="oo-claude-btn" disabled={hidden} data-copied={copied === 'f'} onClick={() => copy('f', followUp)} data-testid="button-copy-followup">
          {copied === 'f' ? 'Copied' : `Draft a follow-up to ${first}`}
        </button>
        <button type="button" className="oo-claude-btn" disabled={hidden} data-copied={copied === 'b'} onClick={() => copy('b', brief)} data-testid="button-copy-brief">
          {copied === 'b' ? 'Copied' : 'Brief me before my next call'}
        </button>
      </div>
    </section>
  );
}
