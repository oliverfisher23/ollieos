import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link, useLocation, useParams } from 'wouter';
import {
  createProduct,
  suggestProductUsers,
  updateProduct,
  useGetProduct,
  useListPeople,
  useListProducts,
  type LinkedProduct,
  type ProductState,
  type ProductUpdate,
  type ProductUser,
} from '@workspace/api-client-react';
import { PRODUCT_STATE_LABELS, PRODUCT_STATES, PRODUCT_USER_LABELS, PRODUCT_USERS, formatDayMonthShort } from '@workspace/shared';
import { notify } from '@/lib/notify';
import { Skel } from '@/components/bits';
import { InlineText } from '@/components/inline-text';
import { Dropdown } from '@/components/dropdown';
import { personOptions } from '@/components/dropdown-options';
import { ContextPackButton } from '@/components/knowledge/context-pack';
import { KnowledgeLayout, ListHeader } from '@/components/knowledge/layout';
import {
  AccessPanel,
  AddNote,
  EntityChipLink,
  FactsSection,
  HiddenFromAi,
  LinkPicker,
  NotesList,
  PageProblem,
  PageSkeleton,
  useUnlink,
} from '@/components/knowledge/parts';
import { RelationshipsSection, WhoDecides } from '@/components/knowledge/relationships';
import { isNotFound, useKnowledgeWrite } from '@/lib/knowledge';
import { RuleCard, RuleDialog } from '@/pages/knowledge/library';
import { PlaybooksSection } from '@/pages/knowledge/playbooks';

const STATE_TONE: Record<ProductState, string> = { live: 'done', pilot: 'waiting', in_development: 'backlog', retired: 'archived' };

export function ProductStatePill({ state }: { state: ProductState }) {
  return <span className="oo-pill" data-tone={STATE_TONE[state]}>{PRODUCT_STATE_LABELS[state]}</span>;
}

const USER_OPTIONS = PRODUCT_USERS.map((u) => ({ value: u, label: PRODUCT_USER_LABELS[u] }));

/* ---------- List ---------- */

export function ProductsListPage() {
  const list = useListProducts();
  const write = useKnowledgeWrite();
  const [creating, setCreating] = useState(false);
  const [user, setUser] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const missing = list.data?.filter((p) => !p.primaryUser).length ?? 0;
  const shown = list.data?.filter((p) => !user || (user === 'none' ? !p.primaryUser : p.primaryUser === user)) ?? [];

  const suggest = async () => {
    setSuggesting(true);
    const r = await write(() => suggestProductUsers(), { fail: 'Could not suggest primary users' });
    setSuggesting(false);
    if (!r) return;
    if (!r.checked) notify('Nothing to check', 'Every product AI may read has a primary user or a suggestion waiting.');
    else
      notify(
        r.suggested ? `${r.suggested === 1 ? '1 suggestion' : `${r.suggested} suggestions`} in your Knowledge Inbox` : 'No new suggestions',
        r.unclear ? `What OllieOS knows did not settle ${r.unclear === 1 ? '1 product' : `${r.unclear} products`}. Set those yourself.` : undefined,
      );
  };

  return (
    <KnowledgeLayout testId="page-products">
      <ListHeader
        title="Products"
        line="What you sell or run, with the facts about each and what to say and not say."
        action={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {missing > 0 && (
              <button type="button" className="oo-btn oo-btn-outline" onClick={suggest} disabled={suggesting} data-testid="button-suggest-product-users">
                {suggesting ? 'Suggesting…' : 'Suggest primary users'}
              </button>
            )}
            <button type="button" className="oo-btn oo-btn-ink" onClick={() => setCreating(true)} data-testid="button-new-product">New product</button>
          </div>
        }
      />
      {!!list.data?.length && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label htmlFor="products-user-filter" className="oo-muted" style={{ fontSize: 13 }}>Primary user</label>
          <Dropdown
            id="products-user-filter"
            variant="compact"
            style={{ maxWidth: 220 }}
            value={user}
            onChange={setUser}
            options={[{ value: '', label: 'Everyone' }, ...USER_OPTIONS, { value: 'none', label: 'Not set' }]}
            testId="select-products-user-filter"
          />
          {missing > 0 && <span className="oo-muted" style={{ fontSize: 13 }} data-testid="text-products-missing-user">{missing === 1 ? '1 product has' : `${missing} products have`} no primary user. AI suggestions wait for your approval in the Knowledge Inbox.</span>}
        </div>
      )}
      {list.isLoading ? (
        <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{[0, 1, 2].map((i) => <Skel key={i} h={40} />)}</div>
      ) : list.error || !list.data ? (
        <PageProblem notFound={false} what="list" onRetry={() => list.refetch()} back={{ href: '/knowledge', label: 'Back to Knowledge' }} />
      ) : list.data.length === 0 ? (
        <p className="oo-muted" style={{ margin: 0 }} data-testid="state-products-empty">No products yet. Add one with New product, then link the projects and organisations that use it.</p>
      ) : (
        <div data-testid="list-products">
          {shown.length === 0 && <p className="oo-muted" style={{ margin: 0 }} data-testid="state-products-filtered-empty">No products match.</p>}
          {shown.map((p) => (
            <Link key={p.id} href={'/knowledge/products/' + p.slug} className="oo-krow oo-krow-link" style={{ textDecoration: 'none', alignItems: 'flex-start' }} data-testid={'row-product-' + p.slug}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 300px' }}>
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                {p.description && <span className="oo-muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{p.description}</span>}
              </span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 13 }} className="oo-muted">
                {(p.confidential || !p.aiAccess) && <HiddenFromAi confidential={p.confidential} />}
                <ProductStatePill state={p.state} />
                {p.primaryUser && <span className="oo-pill" data-testid={'pill-product-user-' + p.slug}>For {PRODUCT_USER_LABELS[p.primaryUser].toLowerCase()}</span>}
                <span className="oo-num">{p.factCount === 1 ? '1 fact' : `${p.factCount} facts`}</span>
                {p.ownerName && <span>{p.ownerName}</span>}
                <span>Updated {formatDayMonthShort(p.updatedAt)}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
      {creating && <ProductDialog onClose={() => setCreating(false)} />}
    </KnowledgeLayout>
  );
}

function ProductDialog({ onClose }: { onClose: () => void }) {
  const write = useKnowledgeWrite();
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<ProductState>('live');
  const [primaryUser, setPrimaryUser] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const made = await write(() => createProduct({ name: name.trim(), description: description.trim() || null, state, primaryUser: (primaryUser || null) as ProductUser | null }), { done: 'Product added', fail: 'Could not add that product' });
    setBusy(false);
    if (made) {
      onClose();
      navigate('/knowledge/products/' + made.slug);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 520 }} aria-describedby="prd-desc" data-testid="dialog-new-product">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>New product</Dialog.Title>
            <p id="prd-desc" className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Add facts, rules and links on its page once it is saved.</p>
            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label>
                <span>Name</span>
                <input className="oo-input" required autoFocus value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Product name" data-testid="input-product-name" />
              </label>
              <label>
                <span>One-line description <span className="oo-muted">(optional)</span></span>
                <input className="oo-input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="What it is, in a line" data-testid="input-product-description" />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="product-state-new">State</label>
                <Dropdown
                  id="product-state-new"
                  value={state}
                  onChange={(v) => setState(v as ProductState)}
                  options={PRODUCT_STATES.map((s) => ({ value: s, label: PRODUCT_STATE_LABELS[s] }))}
                  testId="select-product-state-new"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor="product-user-new">Primary user <span className="oo-muted">(optional)</span></label>
                <Dropdown
                  id="product-user-new"
                  value={primaryUser}
                  onChange={setPrimaryUser}
                  options={[{ value: '', label: 'Not set' }, ...USER_OPTIONS]}
                  testId="select-product-user-new"
                />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Dialog.Close asChild>
                  <button type="button" className="oo-btn oo-btn-outline" data-testid="button-cancel-product">Cancel</button>
                </Dialog.Close>
                <button type="submit" className="oo-btn oo-btn-ink" disabled={!name.trim() || busy} data-testid="button-save-product">{busy ? 'Saving…' : 'Add product'}</button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------- Product page ---------- */

export function ProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const q = useGetProduct(slug);
  const people = useListPeople();
  const write = useKnowledgeWrite();
  const unlink = useUnlink();
  const [, navigate] = useLocation();
  const [addingRule, setAddingRule] = useState(false);

  if (q.isLoading) return <KnowledgeLayout testId="page-product"><PageSkeleton /></KnowledgeLayout>;
  if (!q.data) {
    return (
      <KnowledgeLayout testId="page-product">
        <PageProblem notFound={isNotFound(q.error)} what="product" onRetry={() => q.refetch()} back={{ href: '/knowledge/products', label: 'All products' }} />
      </KnowledgeLayout>
    );
  }
  const { product: p, facts, rules, documents, projects, organisations, playbooks, decisions, notes } = q.data;
  const save = async (patch: ProductUpdate, done?: string) => {
    const res = await write(() => updateProduct(slug, patch), { done });
    // A new name gives a new address.
    if (res && res.slug !== slug) navigate('/knowledge/products/' + res.slug, { replace: true });
    return res;
  };
  const ownerOptions = personOptions(people.data);
  if (p.owner && !ownerOptions.some((o) => o.value === String(p.owner!.id))) ownerOptions.unshift({ value: String(p.owner.id), label: p.owner.name });

  return (
    <KnowledgeLayout testId="page-product">
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, flex: '1 1 320px' }}>
          <p className="oo-eyebrow" style={{ margin: 0 }}>
            <Link href="/knowledge/products" className="oo-tap" style={{ color: 'inherit' }} data-testid="link-all-products">Product</Link>
          </p>
          <h1 className="oo-h1">
            <InlineText value={p.name} label="Product name" required maxLength={200} testId="product-name" onSave={(v) => save({ name: v ?? p.name })} />
          </h1>
          <p className="oo-soft" style={{ margin: 0, fontSize: 15 }}>
            <InlineText value={p.description} label="One-line description" placeholder="Add a one-line description" maxLength={300} testId="product-description" onSave={(v) => save({ description: v })} />
          </p>
          <dl className="oo-dl" style={{ maxWidth: 480, marginTop: 4 }}>
            <dt><label htmlFor="product-state">State</label></dt>
            <dd>
              <Dropdown
                id="product-state"
                variant="compact"
                value={p.state}
                onChange={(v) => save({ state: v as ProductState })}
                options={PRODUCT_STATES.map((s) => ({ value: s, label: PRODUCT_STATE_LABELS[s] }))}
                testId="select-product-state"
              />
            </dd>
            <dt><label htmlFor="product-user">Primary user</label></dt>
            <dd>
              <Dropdown
                id="product-user"
                variant="compact"
                value={p.primaryUser ?? ''}
                onChange={(v) => save({ primaryUser: (v || null) as ProductUser | null })}
                options={[{ value: '', label: 'Not set' }, ...USER_OPTIONS]}
                testId="select-product-user"
              />
            </dd>
            <dt><label htmlFor="product-owner">Owner</label></dt>
            <dd>
              <Dropdown
                id="product-owner"
                variant="compact"
                value={p.ownerId ? String(p.ownerId) : ''}
                onChange={(v) => save({ ownerId: v ? Number(v) : null })}
                searchPlaceholder="Search people"
                options={[{ value: '', label: 'No owner' }, ...ownerOptions]}
                testId="select-product-owner"
              />
            </dd>
          </dl>
          <div style={{ fontSize: 13 }}>
            <WhoDecides type="product" id={p.id} name={p.name} />
          </div>
          <ContextPackButton type="product" id={p.id} />
        </div>
        <AccessPanel
          kind="product"
          confidential={p.confidential}
          aiAccess={p.aiAccess}
          testPrefix="product"
          onChange={(patch) => save(patch, patch.confidential === true ? 'Marked confidential. It and its facts are hidden from AI.' : undefined)}
        />
      </div>

      <section aria-labelledby="psum-h" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: '72ch' }}>
        <h2 id="psum-h" className="oo-h2">Summary</h2>
        <div style={{ fontSize: 15, lineHeight: 1.6 }} className="oo-soft">
          <InlineText value={p.summary} label="Summary" multiline maxLength={20000} placeholder="What it does, who it is for and where it stands" testId="product-summary" onSave={(v) => save({ summary: v })} />
        </div>
      </section>

      <div className="oo-kgrid">
        <FactsSection entityType="product" entityId={p.id} facts={facts} />
        <section aria-labelledby="plinks-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 id="plinks-h" className="oo-h2">Projects</h2>
          <LinkedChips items={projects} base="/knowledge/projects" kind="project" onUnlink={(id) => unlink('product', p.id, 'project', id)} empty="None linked." />
          <div><LinkPicker fromType="product" fromId={p.id} toType="project" exclude={projects.filter((x) => x.linked).map((x) => x.id)} /></div>
          <h2 className="oo-h2" style={{ marginTop: 8 }}>Organisations</h2>
          <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Such as the customers using it.</p>
          <LinkedChips items={organisations} base="/knowledge/organisations" kind="organisation" onUnlink={(id) => unlink('product', p.id, 'organisation', id)} empty="None linked." />
          <div><LinkPicker fromType="product" fromId={p.id} toType="organisation" exclude={organisations.filter((x) => x.linked).map((x) => x.id)} /></div>
        </section>
      </div>

      <section aria-labelledby="prules-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-product-rules">
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <h2 id="prules-h" className="oo-h2">What to say and not say</h2>
          <button type="button" className="oo-textbtn" onClick={() => setAddingRule(true)} data-testid="button-product-add-rule">Add a rule</button>
        </div>
        <p className="oo-muted" style={{ margin: 0, fontSize: 13 }}>Rules for this product. Claude follows them when drafting for projects and organisations linked to it.</p>
        {rules.length === 0 ? (
          <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>No rules for this product yet.</p>
        ) : (
          <div className="oo-kgrid">{rules.map((r) => <RuleCard key={r.id} p={r} />)}</div>
        )}
      </section>

      <PlaybooksSection playbooks={playbooks} preset={{ productId: p.id }} empty="No playbooks linked to this product." />

      <div className="oo-kgrid">
        <section aria-labelledby="pdocs-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="section-product-documents">
          <h2 id="pdocs-h" className="oo-h2">Documents</h2>
          {documents.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None linked. Link one from its Library entry.</p>
          ) : (
            <div>
              {documents.map((d) => (
                <div key={d.id} className="oo-krow">
                  <Link href={'/knowledge/library?document=' + d.id} className="oo-krow-link" style={{ minWidth: 0 }} data-testid={'link-product-doc-' + d.id}>{d.title}</Link>
                  {d.hiddenFromAi && <HiddenFromAi confidential={d.confidential === true} />}
                </div>
              ))}
            </div>
          )}
        </section>
        <section aria-labelledby="pdec-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="section-product-decisions">
          <h2 id="pdec-h" className="oo-h2">Decisions</h2>
          {decisions.length === 0 ? (
            <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>None linked.</p>
          ) : (
            <div>
              {decisions.map((d) => (
                <div key={d.id} className="oo-krow">
                  <Link href={'/knowledge/decisions/' + d.id} className="oo-krow-link" style={{ minWidth: 0, flex: '1 1 300px' }} data-testid={'link-product-decision-' + d.id}>{d.text}</Link>
                  <span className="oo-muted" style={{ fontSize: 13 }}>{formatDayMonthShort(d.decidedAt)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <RelationshipsSection type="product" id={p.id} name={p.name} />
      <NotesList notes={notes} />
      <AddNote entityType="product" entityId={p.id} placeholder={`Anything worth remembering about ${p.name}`} />
      {addingRule && <RuleDialog presetProductId={p.id} onClose={() => setAddingRule(false)} />}
    </KnowledgeLayout>
  );
}

function LinkedChips({ items, base, kind, onUnlink, empty }: { items: LinkedProduct[]; base: string; kind: string; onUnlink: (id: number) => void; empty: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {items.length === 0 && <p className="oo-muted" style={{ margin: 0, fontSize: 14 }}>{empty}</p>}
      {items.map((x) => (
        <EntityChipLink key={x.id} entity={x} base={base} testId={`chip-${kind}-${x.id}`} onUnlink={x.linked ? () => onUnlink(x.id) : undefined} />
      ))}
    </div>
  );
}

/** "Products" on a project or organisation page. */
export function ProductsSection({ fromType, fromId, products }: { fromType: 'project' | 'organisation'; fromId: number; products: LinkedProduct[] }) {
  const unlink = useUnlink();
  return (
    <section aria-labelledby="prods-h" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="section-products">
      <h2 id="prods-h" className="oo-h2">Products</h2>
      <LinkedChips items={products} base="/knowledge/products" kind="product" onUnlink={(id) => unlink(fromType, fromId, 'product', id)} empty="None linked." />
      <div><LinkPicker fromType={fromType} fromId={fromId} toType="product" exclude={products.filter((x) => x.linked).map((x) => x.id)} /></div>
    </section>
  );
}
