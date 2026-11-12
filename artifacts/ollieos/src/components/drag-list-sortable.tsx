import { useEffect, useLayoutEffect, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Bound, DragStore } from './drag-list';

/*
 * The dnd-kit half of DragList, loaded on its own when a reorderable list first needs it, so
 * drag and drop is not part of the first page load. It renders no DOM of its own: it sits beside
 * the list (the context's screen reader text goes to document.body) and hands each item's
 * sortable state to the rows through the store.
 */

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export function Sortable({ store, ids, labels, enabled, onReorder }: {
  store: DragStore;
  ids: number[];
  labels: Record<number, string>;
  enabled: boolean;
  onReorder: (ids: number[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const name = (id: UniqueIdentifier) => labels[Number(id)] ?? 'Task';
  const place = (id: UniqueIdentifier) => `position ${ids.indexOf(Number(id)) + 1} of ${ids.length}`;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, ${place(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${name(active.id)} moved to ${place(over.id)}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${name(active.id)} dropped at ${place(over.id)}.` : `${name(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Move cancelled. ${name(active.id)} is back where it was.`,
  };
  // A grip pressed before this code loaded starts its drag now. Not on the first commit: DndContext's
  // live region mounts and starts listening a commit later, and "Picked up" must reach it.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (ready) store.replayPress();
  }, [ready, store]);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: 'To move a task, press Space to pick it up, the arrow keys to move it, Space to drop it, or Escape to cancel.' },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={!enabled}>
        {ids.map((id) => <Bind key={id} id={id} store={store} enabled={enabled} />)}
      </SortableContext>
    </DndContext>
  );
}

/** One item's useSortable, published to the row that DragItemOf renders. */
function Bind({ id, store, enabled }: { id: number; store: DragStore; enabled: boolean }) {
  const s = useSortable({ id, disabled: !enabled });
  const transform = CSS.Translate.toString(s.transform) || undefined;
  useLayoutEffect(() => () => store.unpublish(id), [store, id]);
  useLayoutEffect(() => {
    store.publish(id, {
      setNodeRef: s.setNodeRef,
      setActivatorNodeRef: s.setActivatorNodeRef,
      attributes: s.attributes,
      listeners: s.listeners as Bound['listeners'],
      transform,
      transition: s.transition ?? undefined,
      dragging: s.isDragging,
    });
  });
  return null;
}
