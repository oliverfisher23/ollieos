import { useRef, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import { Bold, Heading, Italic, List, ListChecks, ListOrdered, Redo2, Undo2 } from 'lucide-react';

/**
 * The agenda as rich text. Stored and handed to the agenda writer as Markdown, so older plain
 * agendas open as they were and the writer can read and rewrite it.
 */
export function useAgendaEditor({ initial, placeholder, onChange }: { initial: string; placeholder: string; onChange: (markdown: string) => void }) {
  const changed = useRef(onChange);
  changed.current = onChange;
  return useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, link: { openOnClick: false, autolink: true }, code: false, codeBlock: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      Markdown,
    ],
    content: initial,
    contentType: 'markdown',
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'oo-rich', 'aria-label': 'The agenda', 'aria-multiline': 'true', 'data-testid': 'input-meeting-notes' } },
    onUpdate: ({ editor }) => changed.current(editor.getMarkdown().trimEnd()),
  });
}

/** Swaps in an agenda written elsewhere (the agenda writer, or Undo) without counting as Ollie typing. */
export function replaceAgenda(editor: Editor, markdown: string) {
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
}

function Tool({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="oo-rich-tool"
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      data-active={active || undefined}
      disabled={disabled}
      // Keep the selection in the editor while clicking a tool.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function AgendaToolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      heading: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const run = (fn: (c: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => fn(editor.chain().focus()).run();
  const size = 16;
  return (
    <div role="toolbar" aria-label="Formatting" className="oo-rich-bar" data-testid="toolbar-agenda">
      <Tool label="Bold" active={s.bold} disabled={disabled} onClick={() => run((c) => c.toggleBold())}><Bold size={size} /></Tool>
      <Tool label="Italic" active={s.italic} disabled={disabled} onClick={() => run((c) => c.toggleItalic())}><Italic size={size} /></Tool>
      <Tool label="Heading" active={s.heading} disabled={disabled} onClick={() => run((c) => c.toggleHeading({ level: 3 }))}><Heading size={size} /></Tool>
      <span className="oo-rich-sep" aria-hidden="true" />
      <Tool label="Numbered list" active={s.ordered} disabled={disabled} onClick={() => run((c) => c.toggleOrderedList())}><ListOrdered size={size} /></Tool>
      <Tool label="Bullet list" active={s.bullet} disabled={disabled} onClick={() => run((c) => c.toggleBulletList())}><List size={size} /></Tool>
      <Tool label="Checklist" active={s.task} disabled={disabled} onClick={() => run((c) => c.toggleTaskList())}><ListChecks size={size} /></Tool>
      <span className="oo-rich-sep" aria-hidden="true" />
      <Tool label="Undo" disabled={disabled || !s.canUndo} onClick={() => run((c) => c.undo())}><Undo2 size={size} /></Tool>
      <Tool label="Redo" disabled={disabled || !s.canRedo} onClick={() => run((c) => c.redo())}><Redo2 size={size} /></Tool>
    </div>
  );
}

export function AgendaEditorBox({ editor, busy }: { editor: Editor; busy: boolean }) {
  return (
    <div className="oo-rich-box" data-busy={busy || undefined}>
      <AgendaToolbar editor={editor} disabled={busy} />
      <EditorContent editor={editor} />
    </div>
  );
}
