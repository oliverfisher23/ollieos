import type { CSSProperties, ReactNode } from 'react';
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
import { IconGrip } from './icons';

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * A list whose items can be dragged up and down by their grip, with the mouse, by touch, or from
 * the keyboard (Space to pick up, arrows to move, Space to drop, Escape to cancel).
 * `onReorder` gets every id in the new order.
 */
export function DragList({ ids, labels, enabled, onReorder, children }: {
  ids: number[];
  /** Names for screen reader announcements, by id */
  labels: Record<number, string>;
  enabled: boolean;
  onReorder: (ids: number[]) => void;
  children: ReactNode;
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
        {children}
      </SortableContext>
    </DndContext>
  );
}

export interface DragItem {
  ref: (el: HTMLElement | null) => void;
  style: CSSProperties;
  dragging: boolean;
  /** The grip to drag by, or null when the list cannot be reordered */
  grip: ReactNode;
}

/** One item in a DragList. Spread `ref` and `style` onto the row and put `grip` inside it. */
export function DragItemOf({ id, title, enabled, children }: { id: number; title: string; enabled: boolean; children: (item: DragItem) => ReactNode }) {
  const s = useSortable({ id, disabled: !enabled });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(s.transform),
    transition: s.transition ?? undefined,
    ...(s.isDragging ? { position: 'relative', zIndex: 2 } : null),
  };
  const grip = enabled ? (
    <button
      type="button"
      ref={s.setActivatorNodeRef}
      className="oo-grip"
      {...s.attributes}
      {...s.listeners}
      aria-label={'Move: ' + title}
      onClick={(e) => e.stopPropagation()}
      data-testid={'button-drag-' + id}
    >
      <IconGrip size={14} />
    </button>
  ) : null;
  return <>{children({ ref: s.setNodeRef, style, dragging: s.isDragging, grip })}</>;
}
