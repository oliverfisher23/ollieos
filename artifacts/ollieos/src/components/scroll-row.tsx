import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/** Width of the edge fade in index.css (.oo-scroll-row). */
const FADE = 40;

/**
 * A row that scrolls sideways on phones, such as a row of tabs. Fades the edge that has
 * more beyond it, so it is clear there is more, and brings the selected tab into view on open
 * (docs/mobile-plan.md, Part C). Positioned, so hidden text inside cannot widen the page.
 */
export function ScrollRow({ as: Tag = 'div', className = '', style, children, ...rest }: {
  as?: 'div' | 'nav';
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    // Bring the selected item fully into view: on open, when the row's size changes (counts arrive
    // after the first draw) until the row has been touched, and whenever the selection changes.
    let touched = false;
    const reveal = () => {
      const current = el.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
      if (!current) return;
      // Leave room for the fade (FADE, as in index.css) so the item is clear of it, not just on screen.
      const start = current.offsetLeft;
      const end = start + current.offsetWidth;
      const max = el.scrollWidth - el.clientWidth;
      if (end + FADE > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.min(max, end + FADE - el.clientWidth);
      else if (start - FADE < el.scrollLeft) el.scrollLeft = Math.max(0, start - FADE);
    };
    const onResize = () => {
      if (!touched) reveal();
      update();
    };
    const onTouch = () => {
      touched = true;
    };
    reveal();
    update();
    el.addEventListener('scroll', update, { passive: true });
    el.addEventListener('pointerdown', onTouch, { passive: true });
    el.addEventListener('wheel', onTouch, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    const mo = new MutationObserver(() => {
      reveal();
      update();
    });
    mo.observe(el, { subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current'] });
    return () => {
      el.removeEventListener('scroll', update);
      el.removeEventListener('pointerdown', onTouch);
      el.removeEventListener('wheel', onTouch);
      ro?.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={('oo-scroll-row ' + className).trim()}
      data-more-left={edges.left || undefined}
      data-more-right={edges.right || undefined}
      style={style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
