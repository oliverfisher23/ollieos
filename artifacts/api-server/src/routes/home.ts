import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, peopleTable, projectsTable } from "@workspace/db";
import { getHome } from "../services/home";

const router: IRouter = Router();

router.get("/home", async (_req, res, next) => {
  try {
    res.json(await getHome());
  } catch (err) {
    next(err);
  }
});

router.get("/people", async (_req, res, next) => {
  try {
    const rows = await db
      .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, confidential: peopleTable.confidential })
      .from(peopleTable)
      .orderBy(asc(peopleTable.name));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get("/projects", async (_req, res, next) => {
  try {
    const rows = await db
      .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, confidential: projectsTable.confidential })
      .from(projectsTable)
      .where(eq(projectsTable.archived, false))
      .orderBy(asc(projectsTable.name));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
