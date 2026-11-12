/**
 * A LinkedIn profile link in one form, https://www.linkedin.com/in/<handle>, so links typed by Ollie
 * and links from the connections export compare equal. Null when it is not a profile link.
 */
export function linkedinProfileUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // No URL class here: this library runs without DOM or Node types.
  const m = s.match(/^(?:https?:\/\/)?([^/?#\s]+)(\/[^?#\s]*)?/i);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/:\d+$/, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const path = (m[2] ?? "").match(/^\/in\/([^/]+)/i);
  if (!path) return null;
  let handle: string;
  try {
    handle = decodeURIComponent(path[1]);
  } catch {
    handle = path[1];
  }
  handle = handle.trim();
  if (!handle) return null;
  return "https://www.linkedin.com/in/" + encodeURIComponent(handle.toLowerCase());
}
