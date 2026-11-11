import { Router, type IRouter } from "express";
import { z } from "zod";
import { BUSINESS_FUNCTIONS, CADENCES, PRODUCT_STATES, PRODUCT_USERS, PROJECT_LIFECYCLES, isIsoDate } from "@workspace/shared";
import { createProduct, getProduct, listProducts, updateProduct } from "../services/products";
import { suggestProductUsers } from "../services/productUsers";
import { suggestProjectFunctions } from "../services/projectFunctions";
import { CADENCE_TABS, listCadence } from "../services/cadence";
import { checkInDraft } from "../services/checkIn";
import { handle } from "../lib/handle";
import {
  createOrganisation,
  createPerson,
  createProject,
  getOrganisation,
  getPerson,
  getProject,
  listOrganisations,
  listPeople,
  listProjects,
  updateOrganisation,
  updatePerson,
  updateProject,
} from "../services/knowledge/entities";
import {
  LINKABLE,
  createDecision,
  createFact,
  createLink,
  createNote,
  getDecision,
  getNote,
  listDecisions,
  listNotes,
  removeLink,
  supersedeFact,
  updateDecision,
  updateNote,
} from "../services/knowledge/items";
import { resolveEntities } from "../services/knowledge/common";
import { markNotSame, mergePeople, possibleDuplicates } from "../services/mergePeople";
import { findSlackUsers } from "../services/connectors/slack";
import { UpstreamError } from "../services/tasks";
import { SEARCH_TYPES, searchItems } from "../lib/ai-data/search";

const router: IRouter = Router();

const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");
const SlugParams = z.object({ slug: z.string().min(1).max(200) });
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const id = z.number().int().positive();
const shortText = (max = 200) => z.string().max(max).nullable().optional();

const ProjectCreate = z
  .object({
    name: z.string().min(1).max(200),
    area: shortText(),
    status: shortText(),
    summary: shortText(20000),
    function: z.enum(BUSINESS_FUNCTIONS).nullable().optional(),
    confidential: z.boolean().optional(),
    aiAccess: z.boolean().optional(),
  })
  .strict();
const ProjectUpdate = ProjectCreate.partial()
  .extend({ archived: z.boolean().optional(), goalId: id.nullable().optional(), lifecycle: z.enum(PROJECT_LIFECYCLES).optional() })
  .strict();

const PersonCreate = z
  .object({
    name: z.string().min(1).max(200),
    organisationId: id.nullable().optional(),
    role: shortText(),
    email: z.string().email("That email address does not look right").max(320).nullable().optional().or(z.literal("")),
    relationshipSummary: shortText(20000),
    confidential: z.boolean().optional(),
    aiAccess: z.boolean().optional(),
  })
  .strict();
const PersonUpdate = PersonCreate.partial()
  .extend({
    cadence: z.enum(CADENCES).optional(),
    cadencePaused: z.boolean().optional(),
    otherEmails: z.array(z.string().trim().email("That email address does not look right").max(320)).max(20).optional(),
    slackUserId: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .strict();
const MergeBody = z.object({ otherId: id }).strict();
const NotSameBody = z.object({ aId: id, bId: id }).strict();
const SlackQuery = z.object({ q: z.string().max(100).default("") });
const CadenceQuery = z.object({ tab: z.enum(CADENCE_TABS).optional() });

const OrganisationCreate = z
  .object({
    name: z.string().min(1).max(200),
    type: shortText(),
    internal: z.boolean().optional(),
    summary: shortText(20000),
    confidential: z.boolean().optional(),
    aiAccess: z.boolean().optional(),
  })
  .strict();
const OrganisationUpdate = OrganisationCreate.partial().strict();

const ProductCreate = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(300).nullable().optional(),
    state: z.enum(PRODUCT_STATES).optional(),
    primaryUser: z.enum(PRODUCT_USERS).nullable().optional(),
    ownerId: id.nullable().optional(),
    summary: shortText(20000),
    confidential: z.boolean().optional(),
    aiAccess: z.boolean().optional(),
  })
  .strict();
const ProductUpdate = ProductCreate.partial().strict();

const DecisionCreate = z
  .object({
    projectId: id.nullable().optional(),
    text: z.string().min(1).max(5000),
    decidedAt: isoDate,
    decidedBy: shortText(),
    source: shortText(500),
    confidential: z.boolean().nullable().optional(),
  })
  .strict();
const DecisionUpdate = DecisionCreate.partial().strict();

const NoteCreate = z
  .object({
    entityType: z.enum(["project", "person", "organisation", "product", "task", "decision"]),
    entityId: id,
    title: shortText(),
    body: z.string().min(1).max(50000),
    confidential: z.boolean().nullable().optional(),
  })
  .strict();
const NoteUpdate = z
  .object({ title: shortText(), body: z.string().min(1).max(50000).optional(), confidential: z.boolean().nullable().optional() })
  .strict();

const FactCreate = z
  .object({
    entityType: z.enum(["project", "person", "organisation", "product"]),
    entityId: id,
    text: z.string().min(1).max(2000),
    source: shortText(500),
    attribute: z.enum(["job_title", "organisation", "status", "next_step", "decision_date"]).nullable().optional(),
  })
  .strict();
const FactSupersede = z.object({ text: z.string().min(1).max(2000), source: shortText(500) }).strict();

const LinkBody = z
  .object({ fromType: z.enum(LINKABLE), fromId: id, toType: z.enum(LINKABLE), toId: id })
  .strict();

const SearchQuery = z.object({
  q: z.string().max(200),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.enum(SEARCH_TYPES)).optional()),
});

const ListProjectsQuery = z.object({
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/* Projects */
router.get("/projects", handle(async (req, res) => void res.json(await listProjects(ListProjectsQuery.parse(req.query).includeArchived))));
router.post("/projects", handle(async (req, res) => void res.status(201).json(await createProject(ProjectCreate.parse(req.body)))));
router.post("/projects/suggest-functions", handle(async (_req, res) => void res.json(await suggestProjectFunctions())));
router.get("/projects/:slug", handle(async (req, res) => void res.json(await getProject(SlugParams.parse(req.params).slug))));
router.patch(
  "/projects/:slug",
  handle(async (req, res) => void res.json(await updateProject(SlugParams.parse(req.params).slug, ProjectUpdate.parse(req.body)))),
);

/* People */
router.get("/people", handle(async (_req, res) => void res.json(await listPeople())));
router.post("/people", handle(async (req, res) => void res.status(201).json(await createPerson(PersonCreate.parse(req.body)))));
// Before /people/:slug so "cadence" is not read as a slug.
router.get("/people/cadence", handle(async (req, res) => void res.json(await listCadence(CadenceQuery.parse(req.query).tab))));
router.get("/people/duplicates", handle(async (_req, res) => void res.json(await possibleDuplicates())));
router.post(
  "/people/duplicates/not-same",
  handle(async (req, res) => {
    const b = NotSameBody.parse(req.body);
    await markNotSame(b.aId, b.bId);
    res.json({ ok: true });
  }),
);
router.get(
  "/people/slack-accounts",
  handle(async (req, res) => {
    const { q } = SlackQuery.parse(req.query);
    try {
      res.json(await findSlackUsers(q, Date.now(), 1000));
    } catch (err) {
      req.log?.warn({ err }, "Slack people lookup failed");
      throw new UpstreamError("Could not reach Slack. Check the Slack connection in Settings.");
    }
  }),
);
router.post(
  "/people/:slug/merge",
  handle(async (req, res) => {
    const keep = await getPerson(SlugParams.parse(req.params).slug);
    res.json(await mergePeople(keep.person.id, MergeBody.parse(req.body).otherId));
  }),
);
router.post("/people/:slug/check-in-draft", handle(async (req, res) => void res.json(await checkInDraft(SlugParams.parse(req.params).slug))));
router.get("/people/:slug", handle(async (req, res) => void res.json(await getPerson(SlugParams.parse(req.params).slug))));
router.patch(
  "/people/:slug",
  handle(async (req, res) => void res.json(await updatePerson(SlugParams.parse(req.params).slug, PersonUpdate.parse(req.body)))),
);

/* Organisations */
router.get("/organisations", handle(async (_req, res) => void res.json(await listOrganisations())));
router.post("/organisations", handle(async (req, res) => void res.status(201).json(await createOrganisation(OrganisationCreate.parse(req.body)))));
router.get("/organisations/:slug", handle(async (req, res) => void res.json(await getOrganisation(SlugParams.parse(req.params).slug))));
router.patch(
  "/organisations/:slug",
  handle(async (req, res) => void res.json(await updateOrganisation(SlugParams.parse(req.params).slug, OrganisationUpdate.parse(req.body)))),
);

/* Products (Part M) */
router.get("/products", handle(async (_req, res) => void res.json(await listProducts())));
router.post("/products", handle(async (req, res) => void res.status(201).json(await createProduct(ProductCreate.parse(req.body)))));
router.post("/products/suggest-users", handle(async (_req, res) => void res.json(await suggestProductUsers())));
router.get("/products/:slug", handle(async (req, res) => void res.json(await getProduct(SlugParams.parse(req.params).slug))));
router.patch("/products/:slug", handle(async (req, res) => void res.json(await updateProduct(SlugParams.parse(req.params).slug, ProductUpdate.parse(req.body)))));

/* Decisions */
router.get("/decisions", handle(async (_req, res) => void res.json(await listDecisions())));
router.post("/decisions", handle(async (req, res) => void res.status(201).json(await createDecision(DecisionCreate.parse(req.body)))));
router.get("/decisions/:id", handle(async (req, res) => void res.json(await getDecision(IdParams.parse(req.params).id))));
router.patch(
  "/decisions/:id",
  handle(async (req, res) => void res.json(await updateDecision(IdParams.parse(req.params).id, DecisionUpdate.parse(req.body)))),
);

/* Notes */
router.get("/notes", handle(async (_req, res) => void res.json(await listNotes())));
router.post("/notes", handle(async (req, res) => void res.status(201).json(await createNote(NoteCreate.parse(req.body)))));
router.get("/notes/:id", handle(async (req, res) => void res.json(await getNote(IdParams.parse(req.params).id))));
router.patch("/notes/:id", handle(async (req, res) => void res.json(await updateNote(IdParams.parse(req.params).id, NoteUpdate.parse(req.body)))));

/* Facts: never edited, only replaced */
router.post("/facts", handle(async (req, res) => void res.status(201).json(await createFact(FactCreate.parse(req.body)))));
router.post(
  "/facts/:id/supersede",
  handle(async (req, res) => void res.json(await supersedeFact(IdParams.parse(req.params).id, FactSupersede.parse(req.body)))),
);

/* Links */
router.post("/links", handle(async (req, res) => void res.json(await createLink(LinkBody.parse(req.body)))));
router.delete("/links", handle(async (req, res) => void res.json(await removeLink(LinkBody.parse(req.body)))));

/* Search: Ollie sees everything, with hidden-from-AI items marked */
router.get(
  "/search",
  handle(async (req, res) => {
    const { q, types } = SearchQuery.parse(req.query);
    const hits = (await searchItems({ q, types, mode: "user", visibleOnly: false, limitPerType: 8 })).slice(0, 40);
    const parents = await resolveEntities(
      hits.filter((h) => h.entityType && h.entityId).map((h) => ({ type: h.entityType!, id: h.entityId! })),
    );
    res.json({
      q,
      hits: hits.map((h) => ({
        type: h.type,
        id: h.id,
        title: h.title,
        snippet: h.snippet,
        slug: h.slug,
        status: h.status,
        hiddenFromAi: h.hiddenFromAi,
        parent: h.entityType && h.entityId ? (parents.get(`${h.entityType}:${h.entityId}`) ?? null) : null,
      })),
    });
  }),
);

export default router;
