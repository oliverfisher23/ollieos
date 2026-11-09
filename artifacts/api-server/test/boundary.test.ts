import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const DB_IMPORT = /from\s+["'](@workspace\/db|drizzle-orm[^"']*|pg)["']/;

describe("the ai-data boundary (criterion 2)", () => {
  it("the model module cannot reach the database", () => {
    const src = readFileSync(path.join(SRC, "services/ask/model.ts"), "utf8");
    expect(src).not.toMatch(DB_IMPORT);
  });

  it("Ask hands the model only items loaded through ai-data", () => {
    const src = readFileSync(path.join(SRC, "services/ask/ask.ts"), "utf8");
    expect(src).toMatch(/from\s+["']\.\.\/\.\.\/lib\/ai-data\/retrieve["']/);
    // Every call into the model passes docs that came from retrieveForAsk or loadVisibleDocs.
    for (const m of src.matchAll(/(answerFromDocs|draftReplyFromDocs)\(([^)]*)\)/g)) {
      expect(m[2]).toMatch(/docs/);
    }
  });

  it("any AI-facing route folders that exist do not import the database directly", () => {
    const aiFacing = files(SRC).filter((f) => /[\\/](mcp|ingest)[\\/]/.test(f));
    for (const f of aiFacing) expect(readFileSync(f, "utf8"), f).not.toMatch(DB_IMPORT);
  });
});
