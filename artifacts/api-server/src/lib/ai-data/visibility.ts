/**
 * Visibility rules for AI-facing reads (build plan section 6, questions 9 to 11).
 *
 * Each builder returns a SQL boolean expression for a row referenced by a table alias,
 * so hidden rows are filtered in the WHERE clause and never fetched or counted.
 * Inheritance is evaluated at read time, so switching a project to confidential hides
 * everything under it at once, and switching it back restores it.
 *
 * Grants from approved access requests arrive in milestone 4; until then nothing hidden
 * is ever unlocked.
 *
 * The strings below are built only from fixed aliases in this file, never from input.
 */

/** A project, person or organisation row is hidden when it is confidential or has AI access off. */
function ownHidden(alias: string): string {
  return `(${alias}.confidential or not ${alias}.ai_access)`;
}

/** Any project linked to the item through the links table, in either direction. */
function linkedProjectHidden(type: string, idExpr: string, directProjectId?: string): string {
  const direct = directProjectId ? `x.id = ${directProjectId} or ` : "";
  return `exists (select 1 from projects x where ${ownHidden("x")} and (${direct}exists (
    select 1 from links l where
      (l.from_type = '${type}' and l.from_id = ${idExpr} and l.to_type = 'project' and l.to_id = x.id)
      or (l.to_type = '${type}' and l.to_id = ${idExpr} and l.from_type = 'project' and l.from_id = x.id)
  )))`;
}

export function projectVisible(alias: string): string {
  return `not ${ownHidden(alias)}`;
}
export const personVisible = projectVisible;
export const organisationVisible = projectVisible;

/**
 * A task with its own flag set follows it. Otherwise it is hidden when any linked project is
 * hidden, or when it is linked only to people and every one of them is hidden (question 9).
 */
export function taskVisible(alias: string): string {
  const t = alias;
  return `(case
    when ${t}.confidential is true then false
    when ${t}.confidential is false then true
    else not (
      ${linkedProjectHidden("task", `${t}.id`, `${t}.project_id`)}
      or (
        ${t}.project_id is null
        and (${t}.person_id is not null or ${t}.waiting_on_person_id is not null)
        and not exists (
          select 1 from people xp
          where xp.id in (${t}.person_id, ${t}.waiting_on_person_id) and not ${ownHidden("xp")}
        )
      )
    )
  end)`;
}

/** A decision follows its own flag, or its project when the flag is unset. */
export function decisionVisible(alias: string): string {
  const d = alias;
  return `(case
    when ${d}.confidential is true then false
    when ${d}.confidential is false then true
    else not ${linkedProjectHidden("decision", `${d}.id`, `${d}.project_id`)}
  end)`;
}

/** Whether the entity a note, fact or activity hangs off is visible. */
function entityVisible(typeExpr: string, idExpr: string): string {
  return `(case ${typeExpr}
    when 'project' then exists (select 1 from projects ep where ep.id = ${idExpr} and ${projectVisible("ep")})
    when 'person' then exists (select 1 from people ep where ep.id = ${idExpr} and ${personVisible("ep")})
    when 'organisation' then exists (select 1 from organisations ep where ep.id = ${idExpr} and ${organisationVisible("ep")})
    when 'task' then exists (select 1 from tasks et where et.id = ${idExpr} and ${taskVisible("et")})
    when 'decision' then exists (select 1 from decisions ed where ed.id = ${idExpr} and ${decisionVisible("ed")})
    else true
  end)`;
}

export function noteVisible(alias: string): string {
  const n = alias;
  return `(case
    when ${n}.confidential is true then false
    when ${n}.confidential is false then true
    else ${entityVisible(`${n}.entity_type`, `${n}.entity_id`)}
  end)`;
}

export function factVisible(alias: string): string {
  return entityVisible(`${alias}.entity_type`, `${alias}.entity_id`);
}

export function activityVisible(alias: string): string {
  return `(${alias}.entity_type is null or ${entityVisible(`${alias}.entity_type`, `${alias}.entity_id`)})`;
}
