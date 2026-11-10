import type { GraphEdge, GraphNode, GraphNodeType } from '@workspace/api-client-react';
import { entityPath } from '@/lib/knowledge';

export const NODE_TYPES: GraphNodeType[] = ['person', 'organisation', 'project', 'product', 'goal', 'playbook', 'decision', 'document', 'session', 'meeting', 'task'];

export const NODE_LABELS: Record<GraphNodeType, string> = {
  person: 'Person',
  organisation: 'Organisation',
  project: 'Project',
  product: 'Product',
  playbook: 'Playbook',
  goal: 'Goal',
  decision: 'Decision',
  document: 'Document',
  session: 'Cowork session',
  meeting: 'Meeting',
  task: 'Task',
};

export const NODE_PLURALS: Record<GraphNodeType, string> = {
  person: 'People',
  organisation: 'Organisations',
  project: 'Projects',
  product: 'Products',
  playbook: 'Playbooks',
  goal: 'Goals',
  decision: 'Decisions',
  document: 'Documents',
  session: 'Sessions',
  meeting: 'Meetings',
  task: 'Tasks',
};

/** Where a point opens in OllieOS. */
export function nodePath(n: GraphNode): string | null {
  if (n.type === 'meeting') return '/briefs/' + n.id;
  if (n.type === 'goal') return '/goals';
  if (n.type === 'document') return '/knowledge/library?document=' + n.id;
  if (n.type === 'playbook') return '/knowledge/playbooks/' + n.id;
  return entityPath(n.type, n.slug, n.id);
}

/** Bigger points for the things that join others up. */
export function nodeRadius(n: GraphNode, degree: number): number {
  const base = n.type === 'person' || n.type === 'organisation' || n.type === 'project' || n.type === 'product' ? 8 : n.type === 'goal' ? 9 : 5;
  return base + Math.min(8, Math.sqrt(degree) * 1.6);
}

/** How a link reads from the given point: "works at" from the person, "employs" from the organisation. */
export function phraseFrom(e: GraphEdge, ref: string): string {
  return e.from === ref ? e.label : e.inverse;
}

export const otherEnd = (e: GraphEdge, ref: string) => (e.from === ref ? e.to : e.from);

export function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A link as a sentence: "Sam Lee works at Acme". */
export function sentence(e: GraphEdge, names: Map<string, GraphNode>): string {
  return `${names.get(e.from)?.name ?? 'Something'} ${e.label} ${names.get(e.to)?.name ?? 'something'}`;
}

export const edgeKey = (e: GraphEdge) => `${e.from}|${e.to}|${e.kind}`;
