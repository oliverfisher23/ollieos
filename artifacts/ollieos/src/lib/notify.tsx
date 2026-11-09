import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';

export function notify(title: string, description?: string) {
  toast({ title, description, className: 'oo-toast' });
}

/** A toast with an Undo button. Stays a little longer than a plain toast so there is time to react. */
export function notifyUndo(title: string, description: string | undefined, onUndo: () => void) {
  toast({
    title,
    description,
    className: 'oo-toast',
    duration: 8000,
    action: (
      <ToastAction altText="Undo" className="oo-toast-action" onClick={onUndo} data-testid="button-toast-undo">
        Undo
      </ToastAction>
    ),
  });
}

/** The server's plain-English error message, or a fallback. */
export function errorMessage(err: unknown, fallback = 'Try again in a moment.'): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === 'string' ? data.error : fallback;
}
