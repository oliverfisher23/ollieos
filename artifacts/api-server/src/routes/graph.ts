/**
 * The knowledge graph and stated relationships for Ollie (build plan 13, Part G). He sees
 * everything; points hidden from AI are marked.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { RELATIONSHIPS } from "@workspace/shared";
import { handle } from "../lib/handle";
import { GRAPH_TYPES, LINK_KINDS, explore, findConnection, overview, type GraphResult } from "../lib/ai-data/graph";
import { NotFoundError } from "../services/tasks";
import { RELATABLE, clearRelationship, relationshipsOf, setRelationship } from "../services/relationships";

const router: IRouter = Router();

const ref = z.string().trim().min(3).max(60);
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(values)));

const ExploreQuery = z.object({
  ref,
  depth: z.coerce.number().int().min(1).max(2).optional(),
  types: list(GRAPH_TYPES),
  kinds: list(LINK_KINDS as unknown as readonly [string, ...string[]]),
});
const ConnectionQuery = z.object({ from: ref, to: ref });
const End = z.object({ type: z.enum(RELATABLE), id: z.coerce.number().int().positive() });
const RelationshipBody = z
  .object({
    fromType: z.enum(RELATABLE),
    fromId: z.number().int().positive(),
    toType: z.enum(RELATABLE),
    toId: z.number().int().positive(),
    relationship: z.enum(RELATIONSHIPS),
    note: z.string().max(1000).nullable().optional(),
  })
  .strict();
const RelationshipPair = RelationshipBody.pick({ fromType: true, fromId: true, toType: true, toId: true }).strict();

const out = (r: GraphResult) => ({ ...r, centre: r.centre ?? null });

router.get(
  "/graph/overview",
  handle(async (_req, res) => void res.json(out(await overview(null)))),
);

router.get(
  "/graph/explore",
  handle(async (req, res) => {
    const q = ExploreQuery.parse(req.query);
    const r = await explore(q.ref, { scope: null, depth: (q.depth ?? 1) as 1 | 2, types: q.types, kinds: q.kinds as never });
    if (!r) throw new NotFoundError("Nothing matches that");
    res.json(out(r));
  }),
);

router.get(
  "/graph/connection",
  handle(async (req, res) => {
    const q = ConnectionQuery.parse(req.query);
    const r = await findConnection(q.from, q.to, null);
    if (!r) throw new NotFoundError("Nothing matches that");
    res.json(r);
  }),
);

router.get(
  "/relationships",
  handle(async (req, res) => void res.json(await relationshipsOf(End.parse(req.query)))),
);

router.put(
  "/relationships",
  handle(async (req, res) => {
    const b = RelationshipBody.parse(req.body);
    res.json(await setRelationship({ from: { type: b.fromType, id: b.fromId }, to: { type: b.toType, id: b.toId }, relationship: b.relationship, note: b.note ?? null }));
  }),
);

router.delete(
  "/relationships",
  handle(async (req, res) => {
    const b = RelationshipPair.parse(req.body);
    res.json(await clearRelationship({ type: b.fromType, id: b.fromId }, { type: b.toType, id: b.toId }));
  }),
);

export default router;
