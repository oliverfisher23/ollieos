/**
 * Turns a file into plain text for the Library and the knowledge step: Markdown and text as they
 * are, Word documents and PDFs read on the server. Other kinds are refused with a plain message.
 */
import { ValidationError } from "../tasks";

/** Kinds OllieOS can read, by file extension */
export const READABLE_EXTENSIONS = ["md", "markdown", "txt", "docx", "pdf"] as const;
/** Largest file OllieOS reads */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : "";
}

export function isReadableName(name: string): boolean {
  return (READABLE_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** A title from a file name: no extension, underscores and dashes as spaces. */
export function titleFromFileName(name: string): string {
  const base = name.split("/").pop() ?? name;
  const t = base.replace(/\.[a-z0-9]{1,8}$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return t || base;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export async function textFromFile(name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ValidationError("That file is too large. Files up to 15 MB can be read.");
  const ext = extensionOf(name);
  let text: string;
  if (ext === "md" || ext === "markdown" || ext === "txt") {
    text = new TextDecoder("utf-8").decode(bytes);
  } else if (ext === "docx") {
    const mammoth = (await import("mammoth")).default;
    try {
      text = (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
    } catch {
      throw new ValidationError("That Word document could not be read. Save it again as .docx and try once more.");
    }
  } else if (ext === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    try {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const r = await extractText(pdf, { mergePages: true });
      text = Array.isArray(r.text) ? r.text.join("\n\n") : r.text;
    } catch {
      throw new ValidationError("That PDF could not be read.");
    }
  } else {
    throw new ValidationError("OllieOS can read Markdown, text, Word (.docx) and PDF files.");
  }
  const out = tidy(text);
  if (!out) throw new ValidationError(ext === "pdf" ? "That PDF has no text OllieOS can read. It may be scanned pages." : "That file is empty.");
  return out;
}
