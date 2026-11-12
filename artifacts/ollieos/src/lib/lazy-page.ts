import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Pages are props-agnostic here; each route passes what its page expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type LazyPage<C extends AnyComponent> = LazyExoticComponent<C> & { preload: () => Promise<unknown> };

const RELOADED = 'oo-chunk-reload';

/**
 * After a deploy the old page files are gone, so an open tab can fail to load one.
 * Reload once to pick up the new build; a second failure is a real error for the error screen.
 */
function retryOnce<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().then(
      (mod) => {
        try {
          sessionStorage.removeItem(RELOADED);
        } catch {
          /* storage blocked: nothing to clear */
        }
        return mod;
      },
      (err: unknown) => {
        let reloaded = true;
        try {
          reloaded = sessionStorage.getItem(RELOADED) === '1';
          if (!reloaded) sessionStorage.setItem(RELOADED, '1');
        } catch {
          /* storage blocked: do not risk a reload loop */
        }
        if (!reloaded) {
          window.location.reload();
          return new Promise<T>(() => {});
        }
        throw err;
      },
    );
}

/**
 * A page loaded on first visit (docs/mobile-plan.md, Part B). `preload()` starts the download early,
 * from a nav link being touched or hovered, or at start-up for the page being opened.
 */
export function lazyPage<M, K extends keyof M>(load: () => Promise<M>, name: K): LazyPage<M[K] & AnyComponent> {
  let pending: Promise<M> | null = null;
  // A preload never reloads the page: it runs in the background. Only showing the page does.
  const preload = () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
  const Page = lazy(() => retryOnce(preload)().then((mod) => ({ default: mod[name] as M[K] & AnyComponent })));
  return Object.assign(Page, { preload });
}
