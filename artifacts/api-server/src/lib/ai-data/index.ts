/**
 * The only way AI-facing code (MCP tools and resources, the ingest API, Ask) reaches Ollie's data.
 * Everything here applies the confidentiality filter in SQL and records what was read.
 */
export * from "./errors";
export * from "./resolve";
export * from "./scope";
export * from "./sanitise";
export * from "./aiSearch";
export * from "./tasks";
export * from "./context";
export * from "./writes";
export * from "./ingest";
export { requestAccess, REQUEST_REPLY } from "./requests";
export { SEARCH_TYPES, type SearchType } from "./search";
