/**
 * LinkedIn connections import: Connections.csv is matched to people already in OllieOS, and missing
 * or changed details go to the Knowledge Inbox. Nothing changes until approved; unmatched
 * connections are not kept.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, organisationsTable, peopleTable, suggestionsTable } from "@workspace/db";
import { linkedinProfileUrl } from "@workspace/shared";
import { nameKeys, parseConnections, sameCompany, sameRole } from "../src/services/linkedinImport";
import { organisation, person } from "./helpers";
import { api, useServer } from "./harness";

useServer();

const NOTES = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

`;
const HEADER = "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n";
const csv = (...rows: string[]) => NOTES + HEADER + rows.join("\n") + "\n";

describe("LinkedIn import: reading the file", () => {
  it("skips LinkedIn's notes, reads quoted commas, and keeps profile links in one form", () => {
    const rows = parseConnections(
      csv(
        `Anna,Clarke,https://www.linkedin.com/in/Anna-Clarke-123,,"Riverbank University, Careers Service",Careers Lead,12 Nov 2024`,
        `Ben,Hall,https://uk.linkedin.com/in/benhall/,ben@kestrel.example,Kestrel Bank,"Manager, Early Careers",01 Feb 2023`,
      ),
    );
    expect(rows).toEqual([
      { firstName: "Anna", lastName: "Clarke", url: "https://www.linkedin.com/in/anna-clarke-123", email: null, company: "Riverbank University, Careers Service", position: "Careers Lead", connectedOn: "12 Nov 2024" },
      { firstName: "Ben", lastName: "Hall", url: "https://www.linkedin.com/in/benhall", email: "ben@kestrel.example", company: "Kestrel Bank", position: "Manager, Early Careers", connectedOn: "01 Feb 2023" },
    ]);
  });

  it("refuses a file that is not Connections.csv", () => {
    expect(() => parseConnections("Name,Amount\nCoffee,3\n")).toThrow(/Connections\.csv/);
  });

  it("normalises names, companies, roles and links", () => {
    expect(nameKeys("Dr. Zoë Ann Smith-Jones, PhD 🚀")).toEqual(["zoe ann smith jones", "zoe jones"]);
    expect(sameCompany("Kestrel Bank plc", "Kestrel Bank")).toBe(true);
    expect(sameCompany("Kestrel Bank", "Kestrel")).toBe(true);
    expect(sameCompany("BT", "BTC Holdings")).toBe(false);
    expect(sameRole("Careers Lead", "Careers Lead, UK")).toBe(true);
    expect(sameRole("Careers Lead", "Head of Careers")).toBe(false);
    expect(linkedinProfileUrl("linkedin.com/in/someone?trk=x")).toBe("https://www.linkedin.com/in/someone");
    expect(linkedinProfileUrl("https://example.com/in/someone")).toBeNull();
  });
});

describe("LinkedIn import: proposing", () => {
  async function pending(personId: number) {
    return db.select().from(suggestionsTable).where(and(eq(suggestionsTable.entityType, "person"), eq(suggestionsTable.entityId, personId), eq(suggestionsTable.status, "pending")));
  }

  it("fills in what is missing, flags a job change, and leaves ambiguous and hidden people alone", async () => {
    const riverbank = await organisation("Riverbank University");
    const kestrel = await organisation("Kestrel Bank");
    // Missing role and link: one change card.
    const anna = await person("Anna Clarke", { organisationId: riverbank.id });
    // Moved to an organisation OllieOS knows: a change card that moves them.
    const ben = await person("Ben Hall", { organisationId: riverbank.id, role: "Programme Manager" });
    // Moved to a company OllieOS does not know: an organisation fact.
    const chloe = await person("Chloe Ng", { organisationId: riverbank.id, role: "Partnerships Director" });
    // Same details already: nothing.
    const dev = await person("Dev Patel", { organisationId: kestrel.id, role: "Early Careers Manager" });
    await db.update(peopleTable).set({ linkedinUrl: "https://www.linkedin.com/in/devpatel" }).where(eq(peopleTable.id, dev.id));
    // Two Sam Carters at other companies: ambiguous.
    await person("Sam Carter");
    const sam2 = await person("Samuel Carter");
    await db.update(peopleTable).set({ name: "Sam Carter" }).where(eq(peopleTable.id, sam2.id));
    // Hidden from AI: left alone.
    const eve = await person("Eve Moran", { confidential: true });

    const r = await api("contacts/linkedin-import", {
      body: {
        csv: csv(
          `Anna,Clarke,https://www.linkedin.com/in/annaclarke,,Riverbank University,Careers Lead,12 Nov 2024`,
          `Ben,Hall,https://www.linkedin.com/in/benhall,,Kestrel Bank plc,Graduate Recruitment Lead,01 Feb 2023`,
          `Chloe,Ng,https://www.linkedin.com/in/chloeng,,Atlas Partners,Head of Partnerships,03 Mar 2022`,
          `Dev,Patel,https://www.linkedin.com/in/devpatel,,Kestrel Bank,Early Careers Manager,04 Apr 2021`,
          `Sam,Carter,https://www.linkedin.com/in/samcarter,,Somewhere Ltd,CEO,05 May 2020`,
          `Eve,Moran,https://www.linkedin.com/in/evemoran,,Paperclip Supplies,Account Manager,06 Jun 2019`,
          `Nobody,Known,https://www.linkedin.com/in/nobody,,Elsewhere,Engineer,07 Jul 2018`,
        ),
      },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connections: 7, matched: 5, upToDate: 1, changes: 3, facts: 1, alreadyProposed: 0, ambiguous: 1, hidden: 1 });
    expect(sam2).toBeTruthy();

    const [annaCard] = await pending(anna.id);
    expect(annaCard).toMatchObject({ kind: "summary_change", proposedBy: "LinkedIn import" });
    expect((annaCard.payload as any).fields).toEqual({ role: "Careers Lead", linkedin_url: "https://www.linkedin.com/in/annaclarke" });

    const [benCard] = await pending(ben.id);
    expect((benCard.payload as any).fields).toEqual({ role: "Graduate Recruitment Lead", organisation: "Kestrel Bank", linkedin_url: "https://www.linkedin.com/in/benhall" });
    expect((benCard.payload as any).before).toMatchObject({ role: "Programme Manager", organisation: "Riverbank University" });

    const chloeCards = await pending(chloe.id);
    expect(chloeCards.map((c) => c.kind).sort()).toEqual(["fact", "summary_change"]);
    expect((chloeCards.find((c) => c.kind === "fact")!.payload as any).text).toBe("Chloe Ng works at Atlas Partners");
    expect(await pending(dev.id)).toEqual([]);
    expect(await pending(eve.id)).toEqual([]);

    // Approving Ben's card moves him, with his new role and link.
    expect((await api(`suggestions/${benCard.id}/approve`, { body: {} })).status).toBe(200);
    const [benNow] = await db.select().from(peopleTable).where(eq(peopleTable.id, ben.id));
    expect(benNow).toMatchObject({ role: "Graduate Recruitment Lead", organisationId: kestrel.id, linkedinUrl: "https://www.linkedin.com/in/benhall" });

    // Uploading the same file again proposes nothing new.
    const again = await api("contacts/linkedin-import", {
      body: { csv: csv(`Anna,Clarke,https://www.linkedin.com/in/annaclarke,,Riverbank University,Careers Lead,12 Nov 2024`) },
    });
    expect(again.body).toMatchObject({ matched: 1, changes: 0, alreadyProposed: 1 });
    expect((await api("contacts/linkedin-import")).body.last).toMatchObject({ connections: 1, matched: 1 });
    const orgs = await db.select().from(organisationsTable);
    expect(orgs).toHaveLength(2);
  });

  it("matches by email first, and a person page can hold a LinkedIn link", async () => {
    const p = await person("Robert Smith");
    await db.update(peopleTable).set({ email: "bob@kestrel.example" }).where(eq(peopleTable.id, p.id));
    const r = await api("contacts/linkedin-import", { body: { csv: csv(`Bob,Smith,https://www.linkedin.com/in/bobsmith,bob@kestrel.example,,,01 Jan 2020`) } });
    expect(r.body).toMatchObject({ matched: 1, changes: 1 });

    expect((await api(`people/${p.slug}`, { method: "PATCH", body: { linkedinUrl: "example.com/in/x" } })).status).toBe(400);
    const ok = await api(`people/${p.slug}`, { method: "PATCH", body: { linkedinUrl: "linkedin.com/in/BobSmith/" } });
    expect(ok.status).toBe(200);
    expect(ok.body.linkedinUrl).toBe("https://www.linkedin.com/in/bobsmith");
  });
});
