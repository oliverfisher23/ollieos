/**
 * The ideas offered above a meeting's agenda (points to raise, suggestions, what was not covered
 * last time) and how they reach it. Kept apart from the agenda itself so pages that only list
 * ideas do not load the rich text editor.
 */

/** What an idea can do with the agenda: add itself as an item, and tell whether it is already there. */
export interface AgendaHandle {
  add: (text: string) => void;
  has: (text: string) => boolean;
  busy: boolean;
}

/** "Add" beside an idea, or "On the agenda" once the agenda holds it. */
export function AddIdea({ agenda, text, testId }: { agenda: AgendaHandle; text: string; testId: string }) {
  if (agenda.has(text)) return <span className="oo-pill" data-tone="done" style={{ fontSize: 11 }} data-testid={'pill-idea-added-' + testId}>On the agenda</span>;
  return (
    <button type="button" className="oo-mini" onClick={() => agenda.add(text)} disabled={agenda.busy} data-testid={'button-idea-add-' + testId}>
      Add
    </button>
  );
}
