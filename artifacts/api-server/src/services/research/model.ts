/**
 * The research agent's one model call: Sonnet with Claude's web search, answering in a fixed
 * shape. Kept apart so tests can stand it in.
 */
import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { CompanyResearchBody } from "@workspace/db";

export const RESEARCH_MODEL = "claude-sonnet-5-5";
/** Deep research: up to this many web searches per company */
export const MAX_SEARCHES = 10;

const str = { type: "string" } as const;
const nullable = { type: ["string", "null"] } as const;

export const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "website", "overview", "facts", "news", "people", "relationship", "openAsks", "angles", "sources"],
  properties: {
    name: str,
    website: nullable,
    overview: str,
    facts: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["label", "value", "url"], properties: { label: str, value: str, url: nullable } },
    },
    news: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["date", "text", "url"], properties: { date: nullable, text: str, url: nullable } },
    },
    people: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "role", "note", "url"],
        properties: { name: str, role: nullable, note: nullable, url: nullable },
      },
    },
    relationship: nullable,
    openAsks: { type: "array", items: str },
    angles: { type: "array", items: str },
    sources: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: str, url: str } },
    },
  },
} as const;

export interface ResearchAnswer {
  body: CompanyResearchBody;
  searches: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runResearchModel(system: string, content: string): Promise<ResearchAnswer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = (await anthropic.messages.create({
        model: RESEARCH_MODEL,
        max_tokens: 8000,
        system,
        thinking: { type: "between_tools" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: RESEARCH_SCHEMA } },
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
        messages: [{ role: "user", content }],
      } as unknown as Parameters<typeof anthropic.messages.create>[0])) as unknown as {
        content: { type: string; text?: string }[];
        usage?: { server_tool_use?: { web_search_requests?: number } };
      };
      const texts = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "");
      // With search, the answer is the last text block; earlier ones can be thoughts between searches.
      const raw = texts.join("").trim();
      const start = raw.indexOf('{"name"');
      const body = JSON.parse(start > 0 ? raw.slice(start) : raw) as CompanyResearchBody;
      return { body, searches: res.usage?.server_tool_use?.web_search_requests ?? 0 };
    } catch (err) {
      lastErr = err;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
