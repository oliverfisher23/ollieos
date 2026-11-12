/**
 * Milestone 9: voice capture (feature 09), the tasks CSV export, and the one-off imports (PRD 14).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { todayLondon } from "@workspace/shared";
import { handle } from "../lib/handle";
import { tasksCsv } from "../services/exports";
import { importKnowledge, importStatus, importTasks } from "../services/imports";
import { MAX_TRANSCRIPT, parseVoice, saveVoice } from "../services/voice";

const router: IRouter = Router();

const Transcript = z.string().min(1).max(MAX_TRANSCRIPT);
const VoiceItemSchema = z
  .object({
    kind: z.enum(["task", "promise", "fact"]),
    text: z.string().trim().min(1).max(300),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    priority: z.enum(["high", "medium", "low"]),
    projectId: z.number().int().positive().nullable(),
    personId: z.number().int().positive().nullable(),
    about: z.object({ type: z.enum(["project", "person", "organisation"]), id: z.number().int().positive(), name: z.string().max(200) }).nullable(),
  })
  .strict();

router.post(
  "/voice/parse",
  handle(async (req, res) => {
    const b = z.object({ transcript: Transcript }).strict().parse(req.body ?? {});
    res.json(await parseVoice(b.transcript));
  }),
);

router.post(
  "/voice/save",
  handle(async (req, res) => {
    const b = z.object({ transcript: Transcript, items: z.array(VoiceItemSchema).min(1).max(12) }).strict().parse(req.body ?? {});
    res.status(201).json(await saveVoice(b.transcript, b.items, "ollie"));
  }),
);

router.get(
  "/export/tasks.csv",
  handle(async (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ollieos-tasks-${todayLondon()}.csv"`);
    // A byte order mark so Excel reads the file as UTF-8.
    res.send("﻿" + (await tasksCsv()));
  }),
);

export const TaskImportRowSchema = z
  .object({
    title: z.string().max(200),
    status: z.enum(["inbox", "now", "backlog", "waiting"]).optional(),
    priority: z.enum(["high", "medium", "low"]).optional(),
    dueDate: z.string().max(20).nullish(),
    project: z.string().max(200).nullish(),
    person: z.string().max(200).nullish(),
    notes: z.string().max(5000).nullish(),
  })
  .strict();

const Named = z.string().trim().min(1).max(200);
export const ImportBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tasks"), tasks: z.array(TaskImportRowSchema).min(1).max(500) }).strict(),
  z
    .object({
      kind: z.literal("knowledge"),
      organisations: z.array(z.object({ name: Named, type: z.string().max(40).nullish(), summary: z.string().max(2000).nullish(), confidential: z.boolean().optional() }).strict()).max(500).optional(),
      projects: z.array(z.object({ name: Named, summary: z.string().max(2000).nullish(), status: z.string().max(200).nullish(), confidential: z.boolean().optional() }).strict()).max(500).optional(),
      people: z
        .array(z.object({ name: Named, role: z.string().max(200).nullish(), email: z.string().email().max(200).nullish(), organisation: z.string().max(200).nullish(), relationshipSummary: z.string().max(2000).nullish(), confidential: z.boolean().optional() }).strict())
        .max(1000)
        .optional(),
      facts: z
        .array(z.object({ about: z.object({ type: z.enum(["project", "person", "organisation"]), name: Named }).strict(), text: z.string().trim().min(1).max(2000), date: z.string().max(20).nullish() }).strict())
        .max(2000)
        .optional(),
    })
    .strict(),
]);

/** Runs an import; shared with `POST /ingest/import` for Claude. */
export async function runImport(body: unknown, actor: string) {
  const b = ImportBody.parse(body ?? {});
  return b.kind === "tasks" ? importTasks(b.tasks, actor) : importKnowledge(b, actor);
}

router.post("/import", handle(async (req, res) => void res.status(201).json(await runImport(req.body, "ollie"))));
router.get("/import", handle(async (_req, res) => void res.json(await importStatus())));

export default router;
