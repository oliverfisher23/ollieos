import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { IconGrip } from './icons';

/*
 * Drag to reorder, in two halves so dnd-kit (about 14 KB gzipped) is not part of the first page load.
 * This file has no dnd-kit in it: it renders the list, the rows and the grips exactly as they look
 * when dragging works. `drag-list-sortable.tsx` holds every dnd-kit import and is loaded when a
 * reorderable list is on screen and the browser is idle, or sooner when a grip is hovered, focused or
 * pressed. It mounts beside the list rather than around it, so nothing on screen is rebuilt when it
 * arrives, and it hands each row its drag state through a small store. A press on a grip that comes
 * before the code has loaded is held and replayed once it has, so the first drag still works.
 */

type PressName = 'onPointerDown' | 'onKeyDown';

/** What dnd-kit's activators read from a pointer or key event. */
export interface PressEvent {
  nativeEvent: Event;
  target: EventTarget | null;
  preventDefault: () => void;
}

/** The grip's attributes as useSortable gives them (aria-describedby points at its instructions). */
interface GripAttributes {
  role: string;
  tabIndex: number;
  'aria-disabled': boolean;
  'aria-pressed': boolean | undefined;
  'aria-roledescription': string;
  'aria-describedby'?: string;
}

/** The same attributes before dnd-kit has loaded. */
const GRIP_ATTRIBUTES: GripAttributes = {
  role: 'button',
  tabIndex: 0,
  'aria-disabled': false,
  'aria-pressed': undefined,
  'aria-roledescription': 'sortable',
};

/** One item's useSortable result, as the dnd-kit half publishes it. */
export interface Bound {
  setNodeRef: (el: HTMLElement | null) => void;
  setActivatorNodeRef: (el: HTMLElement | null) => void;
  attributes: GripAttributes;
  listeners: Partial<Record<PressName, (event: PressEvent | SyntheticEvent) => void>> | undefined;
  transform: string | undefined;
  transition: string | undefined;
  dragging: boolean;
}

const sameBound = (a: Bound, b: Bound) =>
  a.setNodeRef === b.setNodeRef && a.setActivatorNodeRef === b.setActivatorNodeRef && a.attributes === b.attributes &&
  a.listeners === b.listeners && a.transform === b.transform && a.transition === b.transition && a.dragging === b.dragging;

/** Joins the rows (rendered by the page) to the dnd-kit half (rendered beside them). One per DragList. */
export class DragStore {
  private bound = new Map<number, Bound>();
  private nodes = new Map<number, HTMLElement>();
  private grips = new Map<number, HTMLElement>();
  private subs = new Map<number, Set<() => void>>();
  private press: { id: number; name: PressName; event: PressEvent } | null = null;
  /** Set by DragList while the dnd-kit half has not loaded */
  onWant: (() => void) | null = null;

  /** Load the dnd-kit half now (a grip was hovered, focused or pressed). */
  want = () => this.onWant?.();

  get = (id: number) => this.bound.get(id);

  subscribe(id: number, cb: () => void) {
    let set = this.subs.get(id);
    if (!set) this.subs.set(id, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  private notify(id: number) {
    this.subs.get(id)?.forEach((cb) => cb());
  }

  setNode(id: number, el: HTMLElement | null) {
    if (el) this.nodes.set(id, el);
    else this.nodes.delete(id);
    this.bound.get(id)?.setNodeRef(el);
  }

  setGrip(id: number, el: HTMLElement | null) {
    if (el) this.grips.set(id, el);
    else this.grips.delete(id);
    this.bound.get(id)?.setActivatorNodeRef(el);
  }

  publish(id: number, next: Bound) {
    next.setNodeRef(this.nodes.get(id) ?? null);
    next.setActivatorNodeRef(this.grips.get(id) ?? null);
    const prev = this.bound.get(id);
    if (prev && sameBound(prev, next)) return;
    this.bound.set(id, next);
    this.notify(id);
  }

  unpublish(id: number) {
    if (this.bound.delete(id)) this.notify(id);
  }

  /** A grip was pressed before dnd-kit loaded: keep the press to replay, while the pointer stays down. */
  hold(id: number, name: PressName, e: ReactPointerEvent | ReactKeyboardEvent) {
    this.want();
    const native = e.nativeEvent;
    if (native instanceof PointerEvent) {
      if (!native.isPrimary || native.button !== 0) return;
      const release = (ev: PointerEvent) => {
        if (ev.pointerId !== native.pointerId) return;
        if (this.press?.event.nativeEvent === native) this.press = null;
        window.removeEventListener('pointerup', release, true);
        window.removeEventListener('pointercancel', release, true);
      };
      window.addEventListener('pointerup', release, true);
      window.addEventListener('pointercancel', release, true);
    } else if (!(native instanceof KeyboardEvent) || (native.code !== 'Space' && native.code !== 'Enter')) {
      return;
    }
    this.press = { id, name, event: { nativeEvent: native, target: native.target, preventDefault: () => native.preventDefault() } };
  }

  /** Start the drag for a press held by `hold`, if it still applies (pointer still down, or the grip still focused). */
  replayPress() {
    const p = this.press;
    this.press = null;
    if (!p || (p.name === 'onKeyDown' && document.activeElement !== p.event.target)) return;
    this.bound.get(p.id)?.listeners?.[p.name]?.(p.event);
  }
}

type SortableComponent = typeof import('./drag-list-sortable').Sortable;

let loaded: SortableComponent | null = null;
let loading: Promise<SortableComponent> | null = null;

function loadSortable() {
  loading ??= import('./drag-list-sortable').then(
    (m) => (loaded = m.Sortable),
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

const StoreContext = createContext<DragStore | null>(null);

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
  const [store] = useState(() => new DragStore());
  const [Sortable, setSortable] = useState<SortableComponent | null>(() => loaded);

  useEffect(() => {
    if (Sortable || !enabled) return;
    let live = true;
    const load = () => {
      loadSortable().then(
        (S) => {
          if (live) setSortable(() => S);
        },
        () => {
          /* Offline, or the tab is older than the deploy: the next hover, focus or press tries again. */
        },
      );
    };
    store.onWant = load;
    const idle = 'requestIdleCallback' in window;
    const handle = idle ? window.requestIdleCallback(load, { timeout: 2000 }) : window.setTimeout(load, 1000);
    return () => {
      live = false;
      store.onWant = null;
      if (idle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [Sortable, enabled, store]);

  return (
    <StoreContext.Provider value={store}>
      {children}
      {Sortable && <Sortable store={store} ids={ids} labels={labels} enabled={enabled} onReorder={onReorder} />}
    </StoreContext.Provider>
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
  const store = useContext(StoreContext);
  if (!store) throw new Error('DragItemOf must be inside a DragList');
  const subscribe = useCallback((cb: () => void) => store.subscribe(id, cb), [store, id]);
  const bound = useSyncExternalStore(subscribe, () => store.get(id));
  const rowRef = useCallback((el: HTMLElement | null) => store.setNode(id, el), [store, id]);
  const gripRef = useCallback((el: HTMLElement | null) => store.setGrip(id, el), [store, id]);

  const style: CSSProperties = {
    transform: bound?.transform,
    transition: bound?.transition,
    ...(bound?.dragging ? { position: 'relative', zIndex: 2 } : null),
  };
  const on = bound?.listeners;
  const grip = enabled ? (
    <button
      type="button"
      ref={gripRef}
      className="oo-grip"
      {...(bound?.attributes ?? GRIP_ATTRIBUTES)}
      onPointerEnter={store.want}
      onFocus={store.want}
      onPointerDown={on?.onPointerDown ?? ((e) => store.hold(id, 'onPointerDown', e))}
      onKeyDown={on?.onKeyDown ?? ((e) => store.hold(id, 'onKeyDown', e))}
      aria-label={'Move: ' + title}
      onClick={(e) => e.stopPropagation()}
      data-testid={'button-drag-' + id}
    >
      <IconGrip size={14} />
    </button>
  ) : null;
  return <>{children({ ref: rowRef, style, dragging: bound?.dragging ?? false, grip })}</>;
}
