import { toast } from '@/hooks/use-toast';

export function notify(title: string, description?: string) {
  toast({ title, description, className: 'oo-toast' });
}
