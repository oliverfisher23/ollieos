# Feature PRD: Document index

| | |
|---|---|
| Screen | `design/screens/Library.dc.html` (Documents tab) |
| Also used by | Meeting briefs, project pages, Ask |
| Milestone | 3 |

## 1. Problem

Ollie's working documents live in Dropbox, Google Drive and Claude projects. Finding "the latest RAF pack" means remembering where it is. Storing copies in OllieOS would create a second version that drifts.

## 2. What it does

OllieOS keeps a link, a short summary and project links for each important document. It never stores the file.

## 3. Screen

- Library title, explanation and **Add a link** button.
- Tabs: Documents, Playbooks.
- Documents table: title (linked) with a one-line summary, where it lives (Dropbox, Google Drive, Claude project, Other), linked project, last updated.
- Footnote: OllieOS stores links and summaries only; confidential documents are hidden from AI.

## 4. Rules

1. Add a document by pasting a link. OllieOS fills the title and location from the link; Ollie writes or approves the summary.
2. The capture sweep can propose documents it sees attached to or linked in emails about a project. They arrive in the Knowledge Inbox.
3. A document linked to a confidential project is confidential.
4. "Updated" is the date Ollie or the sweep last confirmed it, not the file's own date (OllieOS can't read the file).
5. AI tools receive the title, summary and link, never the file contents.

## 5. Data model

| Table | Fields |
|---|---|
| `documents` | id, title, url, location (dropbox, gdrive, claude_project, other), summary, confidential, last_confirmed_at, created_at |

Projects link through `links` (document to project, many-to-many).

## 6. MCP changes

- `get_context` for a project includes its documents.
- New tool `find_documents(query)`.

## 7. Acceptance criteria

1. Pasting a Dropbox or Drive link creates a document with the right location.
2. A project page and its meeting briefs list its documents.
3. A confidential document never appears in MCP results.
