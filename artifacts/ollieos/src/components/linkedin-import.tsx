/**
 * Upload LinkedIn's Connections.csv. OllieOS matches each connection to someone it already has and
 * proposes missing or changed details (job title, organisation, LinkedIn link) to the Knowledge
 * Inbox. Connections that match nobody are not kept.
 */
import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Link } from 'wouter';
import { importLinkedIn, useGetLinkedInImport, type LinkedInImportResult } from '@workspace/api-client-react';
import { formatDayMonth } from '@workspace/shared';
import { useKnowledgeWrite } from '@/lib/knowledge';

const MAX_BYTES = 12_000_000;
const n = (x: number, one: string, many = one + 's') => `${x.toLocaleString('en-GB')} ${x === 1 ? one : many}`;

export function LinkedInImportDialog({ onClose }: { onClose: () => void }) {
  const last = useGetLinkedInImport();
  const write = useKnowledgeWrite();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkedInImportResult | null>(null);

  const run = async () => {
    if (!file) return;
    if (file.size > MAX_BYTES) return setError('That file is too big for a connections export. Check it is Connections.csv.');
    setError(null);
    setBusy(true);
    const csv = await file.text();
    const r = await write(() => importLinkedIn({ csv }), { fail: 'The import did not work' });
    setBusy(false);
    if (r) setResult(r);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="oo-modal-scrim">
          <Dialog.Content className="oo-modal" style={{ maxWidth: 580 }} aria-describedby="li-desc" data-testid="dialog-linkedin-import">
            <Dialog.Title style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Import from LinkedIn</Dialog.Title>
            <p id="li-desc" className="oo-muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              OllieOS matches your connections to people you already have and suggests missing or changed job titles, organisations and LinkedIn links in your Knowledge Inbox. Nothing changes until you approve it, and connections that match nobody are not kept.
            </p>

            {result ? (
              <ImportSummary r={result} onClose={onClose} />
            ) : (
              <>
                <ol style={{ margin: 0, paddingLeft: 22, fontSize: 14, lineHeight: 1.6, listStyle: 'decimal' }}>
                  <li>On LinkedIn, open <strong>Settings</strong>, then <strong>Data privacy</strong>, then <strong>Get a copy of your data</strong>.</li>
                  <li>Choose <strong>Connections</strong> and request the archive. LinkedIn emails a link, usually within minutes.</li>
                  <li>Download and unzip it, then choose <strong>Connections.csv</strong> below.</li>
                </ol>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    ref={input}
                    type="file"
                    accept=".csv,text/csv"
                    className="oo-sr"
                    id="li-file"
                    onChange={(e) => {
                      setFile(e.target.files?.[0] ?? null);
                      setError(null);
                    }}
                    data-testid="input-linkedin-file"
                  />
                  <label htmlFor="li-file" className="oo-btn oo-btn-outline" style={{ cursor: 'pointer' }}>
                    {file ? 'Choose another file' : 'Choose Connections.csv'}
                  </label>
                  {file && <span style={{ fontSize: 13, overflowWrap: 'anywhere' }} data-testid="text-linkedin-file">{file.name}</span>}
                </div>
                {error && <p role="alert" style={{ margin: 0, fontSize: 14 }}>{error}</p>}
                {last.data?.last && (
                  <p className="oo-muted" style={{ margin: 0, fontSize: 12 }} data-testid="text-linkedin-last">
                    Last imported {formatDayMonth(last.data.last.at)}: {n(last.data.last.connections, 'connection')}, {n(last.data.last.matched, 'match', 'matches')}. Import again every few months to catch job changes.
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Dialog.Close asChild>
                    <button type="button" className="oo-btn oo-btn-outline">Cancel</button>
                  </Dialog.Close>
                  <button type="button" className="oo-btn oo-btn-ink" disabled={!file || busy} onClick={run} data-testid="button-linkedin-import">
                    {busy ? 'Importing…' : 'Import'}
                  </button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportSummary({ r, onClose }: { r: LinkedInImportResult; onClose: () => void }) {
  const toReview = r.changes + r.facts;
  const lines = [
    `${n(r.connections, 'connection')} in the file, ${r.matched.toLocaleString('en-GB')} of them already in OllieOS.`,
    r.upToDate ? `${n(r.upToDate, 'person', 'people')} already up to date.` : null,
    r.alreadyProposed ? `${n(r.alreadyProposed, 'suggestion')} already waiting, or rejected lately, so not made again.` : null,
    r.ambiguous ? `${n(r.ambiguous, 'name')} fit more than one person, so ${r.ambiguous === 1 ? 'it was' : 'they were'} left alone.` : null,
    r.hidden ? `${n(r.hidden, 'person', 'people')} hidden from AI left alone.` : null,
  ].filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="section-linkedin-result">
      <p className="oo-serif" style={{ margin: 0, fontSize: 22 }} data-testid="text-linkedin-to-review">
        {toReview ? `${n(toReview, 'suggestion')} to review` : 'Nothing new to review'}
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
        {lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="oo-btn oo-btn-outline" onClick={onClose} data-testid="button-linkedin-done">Done</button>
        {toReview > 0 && (
          <Link href="/knowledge/inbox" className="oo-btn oo-btn-ink" onClick={onClose} data-testid="link-linkedin-inbox">Open Knowledge Inbox</Link>
        )}
      </div>
    </div>
  );
}
