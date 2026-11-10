/**
 * Visibility rules for AI-facing reads (build plan section 6, questions 9 to 11).
 *
 * Each builder returns a SQL boolean expression for a row referenced by a table alias,
 * so hidden rows are filtered in the WHERE clause and never fetched or counted.
 * Inheritance is evaluated at read time, so switching a project to confidential hides
 * everything under it at once, and switching it back restores it.
 *
 * Grants come from approved, unexpired access requests for one client (question 10):
 * a grant on an item unlocks that item, and a grant on a project, person or organisation
 * also unlocks whatever is hidden only because of it. Items with their own confidential
 * flag stay hidden unless they are granted themselves.
 *
 * The strings below are built only from fixed aliases in this file and integer ids,
 * never from input.
 */

export interface Grants {
  project: readonly number[];
  person: readonly number[];
  organisation: readonly number[];
  task: readonly number[];
  decision: readonly number[];
  note: readonly number[];
}

export type GrantType = keyof Grants;
export const GRANT_TYPES: readonly GrantType[] = ["project", "person", "organisation", "task", "decision", "note"];

/** No grants: what any AI tool sees by default, and what "Hidden from AI" means in Ollie's own views. */
export const NO_GRANTS: Grants = { project: [], person: [], organisation: [], task: [], decision: [], note: [] };

/** `<expr> in (1,2,3)`, or `false` when there are no ids. Ids are checked to be integers. */
function granted(idExpr: string, ids: readonly number[]): string {
  const safe = ids.filter((n) => Number.isSafeInteger(n));
  return safe.length ? `(${idExpr} in (${safe.join(",")}))` : "false";
}

/** A project, person or organisation row is hidden when it is confidential or has AI access off, unless granted. */
function ownHidden(alias: string, type: "project" | "person" | "organisation", g: Grants): string {
  return `((${alias}.confidential or not ${alias}.ai_access) and not ${granted(`${alias}.id`, g[type])})`;
}

/** Any hidden project linked to the item, directly or through the links table in either direction. */
function linkedProjectHidden(type: string, idExpr: string, g: Grants, directProjectId?: string): string {
  const direct = directProjectId ? `x.id = ${directProjectId} or ` : "";
  return `exists (select 1 from projects x where ${ownHidden("x", "project", g)} and (${direct}exists (
    select 1 from links l where
      (l.from_type = '${type}' and l.from_id = ${idExpr} and l.to_type = 'project' and l.to_id = x.id)
      or (l.to_type = '${type}' and l.to_id = ${idExpr} and l.from_type = 'project' and l.from_id = x.id)
  )))`;
}

export function projectVisible(alias: string, g: Grants = NO_GRANTS): string {
  return `not ${ownHidden(alias, "project", g)}`;
}
export function personVisible(alias: string, g: Grants = NO_GRANTS): string {
  return `not ${ownHidden(alias, "person", g)}`;
}
export function organisationVisible(alias: string, g: Grants = NO_GRANTS): string {
  return `not ${ownHidden(alias, "organisation", g)}`;
}

/**
 * A task with its own flag set follows it. Otherwise it is hidden when any linked project is
 * hidden, or when it is linked only to people and every one of them is hidden (question 9).
 */
export function taskVisible(alias: string, g: Grants = NO_GRANTS): string {
  const t = alias;
  return `(case
    when ${granted(`${t}.id`, g.task)} then true
    when ${t}.confidential is true then false
    when ${t}.confidential is false then true
    else not (
      ${linkedProjectHidden("task", `${t}.id`, g, `${t}.project_id`)}
      or (
        ${t}.project_id is null
        and (${t}.person_id is not null or ${t}.waiting_on_person_id is not null)
        and not exists (
          select 1 from people xp
          where xp.id in (${t}.person_id, ${t}.waiting_on_person_id) and not ${ownHidden("xp", "person", g)}
        )
      )
    )
  end)`;
}

/** A decision follows its own flag, or its project when the flag is unset. */
export function decisionVisible(alias: string, g: Grants = NO_GRANTS): string {
  const d = alias;
  return `(case
    when ${granted(`${d}.id`, g.decision)} then true
    when ${d}.confidential is true then false
    when ${d}.confidential is false then true
    else not ${linkedProjectHidden("decision", `${d}.id`, g, `${d}.project_id`)}
  end)`;
}

/** Whether the entity a note, fact or activity hangs off is visible. */
function entityVisible(typeExpr: string, idExpr: string, g: Grants): string {
  return `(case ${typeExpr}
    when 'project' then exists (select 1 from projects ep where ep.id = ${idExpr} and ${projectVisible("ep", g)})
    when 'person' then exists (select 1 from people ep where ep.id = ${idExpr} and ${personVisible("ep", g)})
    when 'organisation' then exists (select 1 from organisations ep where ep.id = ${idExpr} and ${organisationVisible("ep", g)})
    when 'task' then exists (select 1 from tasks et where et.id = ${idExpr} and ${taskVisible("et", g)})
    when 'decision' then exists (select 1 from decisions ed where ed.id = ${idExpr} and ${decisionVisible("ed", g)})
    else true
  end)`;
}

export function noteVisible(alias: string, g: Grants = NO_GRANTS): string {
  const n = alias;
  return `(case
    when ${granted(`${n}.id`, g.note)} then true
    when ${n}.confidential is true then false
    when ${n}.confidential is false then true
    else ${entityVisible(`${n}.entity_type`, `${n}.entity_id`, g)}
  end)`;
}

export function factVisible(alias: string, g: Grants = NO_GRANTS): string {
  return entityVisible(`${alias}.entity_type`, `${alias}.entity_id`, g);
}

export function activityVisible(alias: string, g: Grants = NO_GRANTS): string {
  return `(${alias}.entity_type is null or ${entityVisible(`${alias}.entity_type`, `${alias}.entity_id`, g)})`;
}

/**
 * A suggestion is hidden when it hangs off a hidden item or proposes a confidential decision.
 * New people, organisations and projects have no item yet, so only their own flag counts.
 */
export function suggestionVisible(alias: string, g: Grants = NO_GRANTS): string {
  return `(coalesce((${alias}.payload->>'confidential')::boolean, false) = false
    and (${alias}.entity_type is null or ${entityVisible(`${alias}.entity_type`, `${alias}.entity_id`, g)}))`;
}

/**
 * A document follows its own flag, or is hidden when any linked project is hidden (question 44).
 * Documents carry no grants of their own; a grant on the project unlocks an inherited one.
 */
export function documentVisible(alias: string, g: Grants = NO_GRANTS): string {
  const d = alias;
  return `(case
    when ${d}.confidential is true then false
    when ${d}.confidential is false then true
    else not ${linkedProjectHidden("document", `${d}.id`, g)}
  end)`;
}

/** Links between a playbook and a project or organisation, either way round. */
function playbookLinks(p: string, other: "project" | "organisation", otherId: string): string {
  return `((l.from_type = 'playbook' and l.from_id = ${p}.id and l.to_type = '${other}' and l.to_id = ${otherId})
    or (l.to_type = 'playbook' and l.to_id = ${p}.id and l.from_type = '${other}' and l.from_id = ${otherId}))`;
}

/**
 * Paused playbooks are never sent. An enabled playbook is visible when it is global (no project or
 * organisation links) or when at least one linked item is visible (build plan 10.7).
 */
export function playbookVisible(alias: string, g: Grants = NO_GRANTS): string {
  const p = alias;
  return `(${p}.enabled and (
    not exists (select 1 from links l where
      (l.from_type = 'playbook' and l.from_id = ${p}.id and l.to_type in ('project', 'organisation'))
      or (l.to_type = 'playbook' and l.to_id = ${p}.id and l.from_type in ('project', 'organisation')))
    or exists (select 1 from projects xp, links l where ${projectVisible("xp", g)} and ${playbookLinks(p, "project", "xp.id")})
    or exists (select 1 from organisations xo, links l where ${organisationVisible("xo", g)} and ${playbookLinks(p, "organisation", "xo.id")})
  ))`;
}
