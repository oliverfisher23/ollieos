import { Router, type IRouter } from "express";
import { z } from "zod";
import { DOC_LOCATIONS, PLAYBOOK_RULE_MAX } from "@workspace/shared";
import { handle } from "../lib/handle";
import { createDocument, createPlaybook, listDocuments, listPlaybooks, updateDocument, updatePlaybook } from "../services/library";

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
const DocumentsQuery = z.object({ projectId: z.coerce.number().int().positive().optional() });

const PlaybookCreate = z
  .object({
    title: z.string().min(1).max(200),
    appliesWhen: z.string().min(1).max(300),
    rule: z.string().min(1).max(PLAYBOOK_RULE_MAX, `Keep the rule to ${PLAYBOOK_RULE_MAX} characters or fewer`),
    enabled: z.boolean().optional(),
    projectIds: ids.optional(),
    organisationIds: ids.optional(),
  })
  .strict();
const PlaybookUpdate = PlaybookCreate.partial().strict();

router.get("/documents", handle(async (req, res) => void res.json(await listDocuments(DocumentsQuery.parse(req.query).projectId))));
router.post("/documents", handle(async (req, res) => void res.status(201).json(await createDocument(DocumentCreate.parse(req.body)))));
router.patch("/documents/:id", handle(async (req, res) => void res.json(await updateDocument(IdParams.parse(req.params).id, DocumentUpdate.parse(req.body)))));

router.get("/playbooks", handle(async (_req, res) => void res.json(await listPlaybooks())));
router.post("/playbooks", handle(async (req, res) => void res.status(201).json(await createPlaybook(PlaybookCreate.parse(req.body)))));
router.patch("/playbooks/:id", handle(async (req, res) => void res.json(await updatePlaybook(IdParams.parse(req.params).id, PlaybookUpdate.parse(req.body)))));

export default router;
