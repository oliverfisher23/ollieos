/** What one knowledge read proposed, and the words for it. No imports, so the Library can use it. */

/** Who proposes what the knowledge step finds, so the Knowledge Inbox can mark and filter it. */
export const DOCUMENT_PROPOSER = "Document reader";

export interface KnowledgeCounts {
  facts: number;
  decisions: number;
  people: number;
  organisations: number;
  links: number;
  rules: number;
  /** Stated relationships between known items (Part G) */
  relationships?: number;
  /** New products and playbooks, and changes to playbooks (Part M) */
  products?: number;
  playbooks?: number;
  /** Already known, already waiting, or rejected recently */
  repeats: number;
}

export const emptyKnowledgeCounts = (): KnowledgeCounts => ({ facts: 0, decisions: 0, people: 0, organisations: 0, links: 0, rules: 0, relationships: 0, products: 0, playbooks: 0, repeats: 0 });

/** Plain words for what a read proposed, for the Library and Settings. */
export function describeCounts(c: Partial<KnowledgeCounts> | null | undefined): string {
  if (!c) return "";
  const parts = (
    [
      ["facts", "fact", "facts"],
      ["decisions", "decision", "decisions"],
      ["people", "person", "people"],
      ["organisations", "organisation", "organisations"],
      ["links", "project link", "project links"],
      ["rules", "rule", "rules"],
      ["relationships", "relationship", "relationships"],
      ["products", "product", "products"],
      ["playbooks", "playbook", "playbooks"],
    ] as const
  )
    .filter(([key]) => (c[key] ?? 0) > 0)
    .map(([key, one, many]) => `${c[key]} ${c[key] === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : "nothing new";
}
