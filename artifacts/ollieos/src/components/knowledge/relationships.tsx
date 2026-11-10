import { useState, type FormEvent } from 'react';
import { Link } from 'wouter';
import {
  removeRelationship,
  setRelationship,
  useListOrganisations,
  useListPeople,
  useListProjects,
  useListRelationships,
  type RelationshipKind,
} from '@workspace/api-client-react';
import { RELATIONSHIPS, RELATIONSHIP_OPTIONS } from '@workspace/shared';
import { Skel } from '@/components/bits';
import { Dropdown, type DropdownOption } from '@/components/dropdown';
import { entityPath, useKnowledgeWrite, type EntityKind } from '@/lib/knowledge';

/** People, organisations and projects as one grouped list, valued "person:3". */
export function useItemOptions(enabled = true, exclude?: string): { options: DropdownOption[]; loading: boolean } {
  const people = useListPeople({ query: { enabled } as never });
  const projects = useListProjects(undefined, { query: { enabled } as never });
  const orgs = useListOrganisations({ query: { enabled } as never });
  const options: DropdownOption[] = [
    ...(people.data ?? []).map((p) => ({ value: 'person:' + p.id, label: p.name, group: 'People' })),
    ...(orgs.data ?? []).map((o) => ({ value: 'organisation:' + o.id, label: o.name, group: 'Organisations' })),
    ...(projects.data ?? []).map((p) => ({ value: 'project:' + p.id, label: p.name, group: 'Projects' })),
  ].filter((o) => o.value !== exclude);
  return { options, loading: people.isLoading || projects.isLoading || orgs.isLoading };
}

const SOURCE_LABEL = (source: string | null, createdBy: string) => {
  if (source) return `From ${source}`;
  return createdBy === 'ollie' ? null : `From ${createdBy}`;
};

/** "Relationships" on a person, organisation or project page: stated links, read from this side. */
export function RelationshipsSection({ type, id, name, title = 'Relationships' }: { type: EntityKind; id: number; name: string; title?: string }) {
  const list = useListRelationships({ type, id });
  const write = useKnowledgeWrite();
  const [adding, setAdding] = useState(false);
  const rows = list.data ?? [];
  const headId = 'relationships-' + type;
  const remove = (otherType: EntityKind, otherId: number) =>
    write(() => removeRelationship({ fromType: type, fromId: id, toType: otherType, toId: otherId }), { done: 'Relationship removed', fail: 'Could not remove that' });

  return (
    <section className="oo-kcard" aria-labelledby={headId} data-testid="section-relationships">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <h2 id={headId} className="oo-h2">{title}</h2>
        <Link href={`/knowledge/map?item=${type}:${id}`} className="oo-textbtn" style={{ fontSize: 13 }} data-testid="link-see-on-map">See on map</Link>
      </div>
      {list.isLoading ? (
        <Skel h={24} />
      ) : list.error ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>Could not load relationships.</p>
      ) : rows.length === 0 && !adding ? (
        <p className="oo-muted" style={{ margin: 0, fontSize: 14 }} data-testid="text-relationships-empty">
          None yet. Say who reports to whom, who introduced you, or which organisations are customers, partners or investors.
        </p>
      ) : (
        <ul className="oo-rel-list" data-testid="list-relationships">
          {rows.map((r) => {
            const href = entityPath(r.other.type, r.other.slug, r.other.id);
            const from = SOURCE_LABEL(r.source, r.createdBy);
            return (
              <li key={r.other.type + r.other.id} data-testid={`relationship-${r.other.type}-${r.other.id}`}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span>
                    <span className="oo-muted">{name} {r.phrase} </span>
                    {href ? <Link href={href} className="oo-krow-link">{r.other.name}</Link> : r.other.name}
                  </span>
                  {(r.note || from) && (
                    <span className="oo-muted" style={{ fontSize: 13 }}>{[r.note, from].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="oo-textbtn"
                  style={{ fontSize: 12, flexShrink: 0 }}
                  aria-label={`Remove: ${name} ${r.phrase} ${r.other.name}`}
                  onClick={() => remove(r.other.type, r.other.id)}
                  data-testid={`button-remove-relationship-${r.other.type}-${r.other.id}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <RelationshipForm type={type} id={id} name={name} onDone={() => setAdding(false)} />
      ) : (
        <div><button type="button" className="oo-textbtn" onClick={() => setAdding(true)} data-testid="button-add-relationship">Add a relationship</button></div>
      )}
    </section>
  );
}

function RelationshipForm({ type, id, name, onDone }: { type: EntityKind; id: number; name: string; onDone: () => void }) {
  const write = useKnowledgeWrite();
  const [relationship, setKind] = useState<RelationshipKind | ''>('');
  const [other, setOther] = useState('');
  const [note, setNote] = useState('');
  const items = useItemOptions(true, `${type}:${id}`);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!relationship || !other) return;
    const [toType, toId] = other.split(':');
    const ok = await write(
      () => setRelationship({ fromType: type, fromId: id, toType: toType as EntityKind, toId: Number(toId), relationship, note: note.trim() || null }),
      { done: 'Relationship saved', fail: 'Could not save that' },
    );
    if (ok) onDone();
  };
  return (
    <form onSubmit={submit} className="oo-rel-form" data-testid="form-relationship">
      <span className="oo-muted" style={{ fontSize: 14 }}>{name}</span>
      <Dropdown
        variant="control"
        ariaLabel="Relationship"
        value={relationship}
        onChange={(v) => setKind(v as RelationshipKind)}
        placeholder="Choose a relationship…"
        searchable={false}
        options={RELATIONSHIPS.map((r) => ({ value: r, label: RELATIONSHIP_OPTIONS[r] }))}
        testId="select-relationship-kind"
        style={{ minWidth: 190 }}
      />
      <Dropdown
        variant="control"
        ariaLabel="Who or what"
        value={other}
        onChange={setOther}
        placeholder={items.loading ? 'Loading…' : 'Choose who or what…'}
        searchPlaceholder="Search people, organisations and projects"
        disabled={items.loading}
        options={items.options}
        testId="select-relationship-other"
        style={{ minWidth: 220 }}
      />
      <label htmlFor="rel-note" className="oo-sr">Note</label>
      <input
        id="rel-note"
        className="oo-input"
        placeholder="A note, if it helps (optional)"
        value={note}
        maxLength={1000}
        onChange={(e) => setNote(e.target.value)}
        style={{ flex: '1 1 220px' }}
        data-testid="input-relationship-note"
      />
      <span style={{ display: 'inline-flex', gap: 8 }}>
        <button type="submit" className="oo-btn oo-btn-ink" disabled={!relationship || !other} data-testid="button-save-relationship">Save</button>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onDone} data-testid="button-cancel-relationship">Cancel</button>
      </span>
    </form>
  );
}
