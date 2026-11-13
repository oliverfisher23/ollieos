/** Queries that must not fail as data grows. */
import { expect, it } from "vitest";
import { projectsForPeople } from "../src/services/cadence";
import { useServer } from "./harness";

useServer();

it("looks up projects for 20,000 contacts in one query (four IN lists of every id passed Postgres's parameter limit)", async () => {
  const ids = Array.from({ length: 20_000 }, (_, i) => i + 1);
  await expect(projectsForPeople(ids)).resolves.toBeInstanceOf(Map);
});
