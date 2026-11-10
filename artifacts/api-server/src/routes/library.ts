import { Router, type IRouter } from "express";
import { z } from "zod";
import { DOC_LOCATIONS, PLAYBOOK_STATES, PLAYBOOK_STEPS_MAX, RULE_MAX } from "@workspace/shared";
import { handle } from "../lib/handle";
import { createDocument, createRule, createTextDocument, listDocuments, listRules, updateDocument, updateRule } from "../services/library";
import { MAX_FILE_BYTES, isReadableName, textFromFile, titleFromFileName } from "../services/documents/fileText";
import { buildKnowledgeFromDocument, importFromDrive } from "../services/documents/reader";
import { ValidationError } from "../services/tasks";
import { AFTER_DAYS_MAX, STEP_MAX, createPlaybook, deletePlaybook, getPlaybook, listPlaybooks, updatePlaybook } from "../services/playbooks";

const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ids = z.array(z.number().int().positive()).max(50);

const DocumentCreate = z
  .object({
    url: z.string().min(1).max(2000),
    title: z.string().max(300).nullable().optional(),
    summary: z.string().max(2000).nullable().optional(),
    location: z.enum(DOC_LOCATIONS).optional(),
    confidential: z.boolean().nullable().optional(),
    projectIds: ids.optional(),
  })
  .strict();
const DocumentUpdate = DocumentCreate.partial().extend({ title: z.string().min(1).max(300).optional(), confirm: z.boolean().optional() }).strict();
const TextFields = {
  summary: z.string().max(2000).nullable().optional(),
  confidential: z.boolean().nullable().optional(),
  projectIds: ids.optional(),
  buildKnowledge: z.boolean().optional(),
};
const DocumentText = z
  .object({ title: z.string().min(1, "Give it a title").max(300), text: z.string().min(1, "Paste some text").max(400_000, "That is too long to keep. Split it into parts."), ...TextFields })
  .strict();
const DocumentUpload = z
  .object({ fileName: z.string().min(1).max(300), dataBase64: z.string().min(1).max(21_000_000), title: z.string().max(300).nullable().optional(), ...TextFields })
  .strict();
const DriveImport = z.object({ url: z.string().min(1).max(2000) }).strict();
const DocumentsQuery = z.object({ projectId: z.coerce.number().int().positive().optional() });

const RuleCreate = z
  .object({
    title: z.string().min(1).max(200),
    appliesWhen: z.string().min(1).max(300),
    rule: z.string().min(1).max(RULE_MAX, `Keep the rule to ${RULE_MAX} characters or fewer`),
    enabled: z.boolean().optional(),
    projectIds: ids.optional(),
    organisationIds: ids.optional(),
    productIds: ids.optional(),
  })
  .strict();
const RuleUpdate = RuleCreate.partial().strict();

const Step = z
  .object({
    id: z.string().max(40).nullable().optional(),
    text: z.string().min(1, "Each step needs some text").max(STEP_MAX, `Keep each step to ${STEP_MAX} characters or fewer`),
    personId: z.number().int().positive().nullable().optional(),
    afterDays: z.number().int().min(0).max(AFTER_DAYS_MAX).nullable().optional(),
  })
  .strict();
const PlaybookCreate = z
  .object({
    title: z.string().min(1).max(200),
    whenToUse: z.string().min(1).max(500),
    purpose: z.string().max(300).nullable().optional(),
    ownerId: z.number().int().positive().nullable().optional(),
    steps: z.array(Step).max(PLAYBOOK_STEPS_MAX).optional(),
    notes: z.string().max(20000).nullable().optional(),
    state: z.enum(PLAYBOOK_STATES).optional(),
    confidential: z.boolean().nullable().optional(),
    projectIds: ids.optional(),
    organisationIds: ids.optional(),
    productIds: ids.optional(),
    documentIds: ids.optional(),
  })
  .strict();
const PlaybookUpdate = PlaybookCreate.partial().extend({ checked: z.boolean().optional() }).strict();

router.get("/documents", handle(async (req, res) => void res.json(await listDocuments(DocumentsQuery.parse(req.query).projectId))));
router.post("/documents", handle(async (req, res) => void res.status(201).json(await createDocument(DocumentCreate.parse(req.body)))));
router.post(
  "/documents/text",
  handle(async (req, res) => {
    const b = DocumentText.parse(req.body);
    res.status(201).json(await createTextDocument({ ...b, origin: "pasted" }));
  }),
);
router.post(
  "/documents/upload",
  handle(async (req, res) => {
    const b = DocumentUpload.parse(req.body);
    if (!isReadableName(b.fileName)) throw new ValidationError("OllieOS can read Markdown, text, Word (.docx) and PDF files.");
    const bytes = new Uint8Array(Buffer.from(b.dataBase64, "base64"));
    if (bytes.byteLength > MAX_FILE_BYTES) throw new ValidationError("That file is too large. Files up to 15 MB can be read.");
    const text = await textFromFile(b.fileName, bytes);
    const title = b.title?.trim() || titleFromFileName(b.fileName);
    res.status(201).json(await createTextDocument({ title, text, summary: b.summary, confidential: b.confidential, projectIds: b.projectIds, buildKnowledge: b.buildKnowledge, origin: "upload", fileName: b.fileName }));
  }),
);
router.post("/documents/import-drive", handle(async (req, res) => void res.json(await importFromDrive(DriveImport.parse(req.body).url))));
router.post("/documents/:id/knowledge", handle(async (req, res) => void res.json(await buildKnowledgeFromDocument(IdParams.parse(req.params).id))));
router.patch("/documents/:id", handle(async (req, res) => void res.json(await updateDocument(IdParams.parse(req.params).id, DocumentUpdate.parse(req.body)))));

router.get("/rules", handle(async (_req, res) => void res.json(await listRules())));
router.post("/rules", handle(async (req, res) => void res.status(201).json(await createRule(RuleCreate.parse(req.body)))));
router.patch("/rules/:id", handle(async (req, res) => void res.json(await updateRule(IdParams.parse(req.params).id, RuleUpdate.parse(req.body)))));

router.get("/playbooks", handle(async (_req, res) => void res.json(await listPlaybooks())));
router.post("/playbooks", handle(async (req, res) => void res.status(201).json(await createPlaybook(PlaybookCreate.parse(req.body)))));
router.get("/playbooks/:id", handle(async (req, res) => void res.json(await getPlaybook(IdParams.parse(req.params).id))));
router.patch("/playbooks/:id", handle(async (req, res) => void res.json(await updatePlaybook(IdParams.parse(req.params).id, PlaybookUpdate.parse(req.body)))));
router.delete(
  "/playbooks/:id",
  handle(async (req, res) => {
    await deletePlaybook(IdParams.parse(req.params).id);
    res.status(204).end();
  }),
);

export default router;
