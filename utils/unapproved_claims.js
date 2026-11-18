'use strict';
/**
 * Business statements the agents may make only after the owner approved them.
 *
 * "כל מנוי כולל גישה מלאה לכל סוגי האימונים" (`_universal_access` in the knowledge and package files, added 2026-11-06/07)
 * was told to a lead on 2026-11-18. The owner has not approved it and the studio sells memberships of different kinds
 * (weekly limits, a punch card, an introductory offer). Until he approves it, or enters the detailed terms, no agent
 * states it. The text itself stays in the data files (the source is kept); it is used only when the same file carries
 * `_universal_access_approved: true`.
 */

/** The approved "included in every membership" text of a data object, or '' when it is not approved. */
function universalAccess(obj) {
  return obj && obj._universal_access_approved === true && obj._universal_access ? String(obj._universal_access) : '';
}

// a sentence that says a membership / every membership includes (access to) all kinds of classes
const CLAIM_RE = /[^.!?\n]*(?:כל\s+מנוי|כל\s+המנויים|המנוי(?:ים)?)[^.!?\n]{0,60}(?:כול(?:ל|לים)|מאפשר(?:ים)?|נות(?:ן|נים))[^.!?\n]{0,60}(?:לכל|כל)\s+סוגי\s+(?:האימונים|השיעורים)[^.!?\n]*[.!?]*[ \t]*/g;

/** Remove the unapproved statement from a reply. -> { text, changed } */
function strip(reply) {
  const src = String(reply ?? '');
  const text = src.replace(CLAIM_RE, ' ').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^[ \t]+/gm, '').trim();
  if (!text) return { text: 'אשמח לעזור 🙂 מה היית רוצה לדעת?', changed: true };          // the reply was nothing but the statement
  return { text, changed: text !== src.trim() };
}

module.exports = { universalAccess, strip, CLAIM_RE };
