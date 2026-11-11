import { useState } from 'react';
import { getContextPack } from '@workspace/api-client-react';
import { errorMessage, notify } from '@/lib/notify';

/**
 * Part O: "Download for Claude". One Markdown file with what AI may see about this item, to add to
 * a Claude chat or project by hand. Says how many confidential or hidden items were left out.
 */
export function ContextPackButton({ type, id }: { type: 'project' | 'product' | 'organisation'; id: number }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const pack = await getContextPack(type, id);
      const url = URL.createObjectURL(new Blob([pack.content], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = pack.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const items = `${pack.included} ${pack.included === 1 ? 'item' : 'items'}`;
      setResult(
        pack.leftOut
          ? `Downloaded with ${items}. ${pack.leftOut} confidential or hidden ${pack.leftOut === 1 ? 'item was' : 'items were'} left out.`
          : `Downloaded with ${items}. Nothing was left out.`,
      );
    } catch (err) {
      notify('Could not make the file', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, fontSize: 13 }}>
      <button
        type="button"
        className="oo-btn oo-btn-outline oo-btn-sm"
        disabled={busy}
        onClick={download}
        title="One file with what AI may see about this, as of today, to add to a Claude chat"
        data-testid="button-context-pack"
      >
        {busy ? 'Making the file…' : 'Download for Claude'}
      </button>
      {result && <span role="status" className="oo-muted" data-testid="text-context-pack-result">{result}</span>}
    </div>
  );
}
