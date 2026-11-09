/**
 * Seeds the 10 starting tasks (PRD 14.1) and the bare people records they
 * mention. Runs once per database: a row in import_runs stops a second run.
 *
 *   pnpm --filter @workspace/scripts run seed-tasks
 */
import { eq } from "drizzle-orm";
import { auditEventsTable, db, importRunsTable, peopleTable, pool, tasksTable } from "@workspace/db";

const PEOPLE = ["Paul Buxton", "Emma Duck", "Veronica Wilkinson", "Kurt Skillen", "Ahlam Bennajem"];

type Seed = {
  title: string;
  source: "email" | "meeting" | "quarterly" | "manual";
  from: string;
  priority: "high" | "medium";
  due: string | null;
  status: "now" | "waiting" | "backlog" | "done";
};

const TASKS: Seed[] = [
  { title: "Follow up with Veronica Wilkinson (DNE) after the WEX demo", source: "meeting", from: "Veronica Wilkinson", priority: "high", due: "2026-11-11", status: "now" },
  { title: "Chase PwC budget sign-off before contracting deadline", source: "email", from: "Emma Duck", priority: "high", due: "2026-11-13", status: "now" },
  { title: "Send RAF revised quote with different contract lengths", source: "email", from: "Paul Buxton", priority: "high", due: "2026-11-13", status: "now" },
  { title: "Send RAF business case and single source justification pack", source: "meeting", from: "Paul Buxton", priority: "high", due: "2026-11-13", status: "now" },
  { title: "Book Moments, Skills Lab and Passport scoping sessions", source: "quarterly", from: "Q3 offsite", priority: "medium", due: "2026-11-12", status: "now" },
  { title: "Follow up with Paul Buxton on the RAF Micro Internship proposal", source: "email", from: "Paul Buxton", priority: "medium", due: "2026-11-13", status: "waiting" },
  { title: "Get Prezzee API set up for student voucher payouts", source: "email", from: "Ahlam Bennajem", priority: "medium", due: null, status: "backlog" },
  { title: "Build the ADS demo", source: "manual", from: "Ollie", priority: "medium", due: null, status: "backlog" },
  { title: "Finish the student MVP website pages and hand over to Ihor", source: "manual", from: "Ollie", priority: "medium", due: null, status: "backlog" },
  { title: "Confirm Builder.io credentials have been rotated", source: "email", from: "Kurt Skillen", priority: "high", due: "2026-11-10", status: "done" },
];

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const [already] = await db.select().from(importRunsTable).where(eq(importRunsTable.kind, "seed-tasks"));
  if (already) {
    console.log("Seed already ran, nothing to do.");
    return;
  }

  const counts = await db.transaction(async (tx) => {
    const personIds = new Map<string, number>();
    for (const name of PEOPLE) {
      const slug = slugify(name);
      const [existing] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.slug, slug));
      if (existing) {
        personIds.set(name, existing.id);
        continue;
      }
      const [p] = await tx.insert(peopleTable).values({ name, slug }).returning({ id: peopleTable.id });
      personIds.set(name, p.id);
      await tx.insert(auditEventsTable).values({ actor: "import", action: "create", entityType: "person", entityId: p.id, payload: { via: "seed" } });
    }

    const now = new Date();
    for (const s of TASKS) {
      const personId = personIds.get(s.from) ?? null;
      const [t] = await tx
        .insert(tasksTable)
        .values({
          title: s.title,
          source: s.source,
          fromName: s.from,
          priority: s.priority,
          dueDate: s.due,
          status: s.status,
          personId,
          waitingOnPersonId: s.status === "waiting" ? personId : null,
          waitingSince: s.status === "waiting" ? now : null,
          completedAt: s.status === "done" ? now : null,
          triagedAt: now,
          createdBy: "import",
        })
        .returning({ id: tasksTable.id });
      await tx.insert(auditEventsTable).values({ actor: "import", action: "create", entityType: "task", entityId: t.id, payload: { via: "seed" } });
    }

    const result = { people: personIds.size, tasks: TASKS.length };
    await tx.insert(importRunsTable).values({ kind: "seed-tasks", actor: "import", counts: result });
    return result;
  });

  console.log(`Seeded ${counts.tasks} tasks and ${counts.people} people.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
