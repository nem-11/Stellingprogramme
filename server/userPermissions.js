/**
 * Role-based access for API enforcement.
 * Roles: admin | site_editor | modules-editor | gw_subbie | int_subbie | board_viewer | programme_viewer
 * Legacy: editor → treated as site_editor
 */

function isModulesEditorRole(role) {
  return role === 'modules-editor';
}

function isSiteEditorRole(role) {
  return role === 'site_editor' || role === 'editor';
}

function isAdminRole(role) {
  return role === 'admin';
}

function isGwSubbieRole(role) {
  return role === 'gw_subbie';
}

function isIntSubbieRole(role) {
  return role === 'int_subbie';
}

/** Update / completions POST — admin + modules-editor (site is view-only). */
function canTickCompletions(role) {
  return isAdminRole(role) || isModulesEditorRole(role);
}

/** Zone/drawing upload/programme screen mutations — admin only. */
function canEditProgrammeAndZones(role) {
  return isAdminRole(role);
}

/** Plan programme item moves (drag/edit) — admin + modules-editor. */
function canEditPlanProgramme(role) {
  return isAdminRole(role) || isModulesEditorRole(role);
}

function planProgrammeEditor(req, res, next) {
  if (!canEditPlanProgramme(req.user.role)) {
    return res.status(403).json({ error: 'Not permitted for this role' });
  }
  next();
}

/** Programme screen API — admin only (site + subbies use Plan/Gantt). */
function canReadProgrammeItemsApi(role) {
  return isAdminRole(role);
}

function programmeItemsReader(req, res, next) {
  if (!canReadProgrammeItemsApi(req.user.role)) {
    return res.status(403).json({ error: 'Not permitted for this role' });
  }
  next();
}

function isBoardViewer(role) {
  return role === 'board_viewer';
}

/** Shared site login — Plan programme grid only, no ticking or editing. */
function isProgrammeViewerRole(role) {
  return role === 'programme_viewer';
}

/** Flatten schedule day JSON into completion keys (matches client UpdPage). */
function scheduleDayCompletionKeys(dayData) {
  const keys = new Set();
  if (!dayData || typeof dayData !== 'object') return keys;
  Object.entries(dayData).forEach(([tw, zones]) => {
    if (Array.isArray(zones)) {
      zones.forEach((act) => keys.add(`${tw}|${act}`));
    } else {
      Object.entries(zones).forEach(([z, acts]) => {
        const pfx = z === '_default' ? tw : `${tw}|${z}`;
        (acts || []).forEach((act) => keys.add(`${pfx}|${act}`));
      });
    }
  });
  return keys;
}

function completionKeyAllowedForUser(db, user, dateStr, key) {
  const role = user.role;
  const tabCandidates = [];
  if (isAdminRole(role) || isSiteEditorRole(role) || isModulesEditorRole(role)) {
    tabCandidates.push(...normalizeUserTabsArray(user.tabs));
  } else if (isGwSubbieRole(role) || isIntSubbieRole(role)) {
    tabCandidates.push(...normalizeUserTabsArray(user.tabs));
  } else {
    return false;
  }
  for (const tab of tabCandidates) {
    const sched = db.getSchedule(tab);
    const day = sched[String(dateStr)];
    if (scheduleDayCompletionKeys(day).has(String(key))) return true;
  }
  if (db.completionKeyAllowedOnPlan(String(dateStr), String(key), tabCandidates)) return true;
  return false;
}

/** Tabs used for drawing/zone/schedule scope — board always includes Modules programme scope. */
const MODULE_HANDOVER_TAB = 'module_handover';
const MODULE_PROGRAMME_TAB = 'module_programme';

function normalizeUserTabs(rawTabs) {
  const raw = (Array.isArray(rawTabs) ? rawTabs : []).map((t) => String(t || '').trim()).filter(Boolean);
  const hadModule = raw.includes(MODULE_HANDOVER_TAB) || raw.includes(MODULE_PROGRAMME_TAB);
  const out = raw.filter((t) => t !== MODULE_HANDOVER_TAB);
  if (hadModule && !out.includes(MODULE_PROGRAMME_TAB)) out.push(MODULE_PROGRAMME_TAB);
  return new Set(out);
}

function normalizeUserTabsArray(rawTabs) {
  return [...normalizeUserTabs(rawTabs)];
}

function userHasDrawingTab(tabs, drawingTab) {
  const dt = String(drawingTab || '');
  if (tabs.has(dt)) return true;
  if (dt === MODULE_HANDOVER_TAB && tabs.has(MODULE_PROGRAMME_TAB)) return true;
  return false;
}

function effectiveUserTabs(user) {
  const tabs = normalizeUserTabs(user?.tabs);
  if (isBoardViewer(user?.role)) tabs.add(MODULE_PROGRAMME_TAB);
  return tabs;
}

function userTabsSet(user) {
  return effectiveUserTabs(user);
}

function assertDrawingTabAllowed(db, user, drawingId) {
  const id = Number(drawingId);
  if (!id) return { ok: false };
  const d = db.getDrawing(id);
  if (!d) return { ok: false };
  if (isAdminRole(user.role)) return { ok: true, drawing: d };
  const tabs = userTabsSet(user);
  if (!userHasDrawingTab(tabs, d.tab)) return { ok: false };
  return { ok: true, drawing: d };
}

function assertZoneTabAllowed(db, user, zoneId) {
  const zid = Number(zoneId);
  if (!zid) return { ok: false };
  const row = db.getZoneDrawingTab(zid);
  if (!row) return { ok: false };
  if (isAdminRole(user.role)) return { ok: true, tab: row.tab };
  if (!userHasDrawingTab(userTabsSet(user), row.tab)) return { ok: false };
  return { ok: true, tab: row.tab };
}

function filterActivitiesForUser(user, rows) {
  if (!Array.isArray(rows)) return [];
  if (isAdminRole(user.role)) return rows;
  const tabs = userTabsSet(user);
  return rows.filter((r) => tabs.has(r.type));
}

function filterDrawingsForUser(user, rows) {
  if (!Array.isArray(rows)) return [];
  if (isAdminRole(user.role)) return rows;
  const tabs = userTabsSet(user);
  return rows.filter((d) => userHasDrawingTab(tabs, d.tab));
}

function filterZonesAllForUser(db, user, rows) {
  if (!Array.isArray(rows)) return [];
  if (isAdminRole(user.role)) return rows;
  const tabs = userTabsSet(user);
  return rows.filter((z) => {
    const d = db.getDrawing(z.drawing_id);
    return d && userHasDrawingTab(tabs, d.tab);
  });
}

function filterCompletionsForUser(db, user, completionsObj) {
  if (isAdminRole(user.role) || isSiteEditorRole(user.role) || isModulesEditorRole(user.role)) return completionsObj || {};
  /** Board + shared programme viewer: read-only full completions for Plan colouring. */
  if (isBoardViewer(user.role) || isProgrammeViewerRole(user.role)) return completionsObj || {};
  const out = {};
  Object.entries(completionsObj || {}).forEach(([date, keysObj]) => {
    const filtered = {};
    Object.entries(keysObj || {}).forEach(([key, meta]) => {
      if (completionKeyAllowedForUser(db, user, date, key)) filtered[key] = meta;
    });
    if (Object.keys(filtered).length) out[date] = filtered;
  });
  return out;
}

function filterTemplatesForUser(user, rows) {
  if (!Array.isArray(rows)) return [];
  if (isAdminRole(user.role)) return rows;
  const tabs = userTabsSet(user);
  return rows.filter((t) => tabs.has(t.tab));
}

module.exports = {
  isSiteEditorRole,
  isModulesEditorRole,
  isAdminRole,
  isGwSubbieRole,
  isIntSubbieRole,
  canTickCompletions,
  canEditProgrammeAndZones,
  canEditPlanProgramme,
  planProgrammeEditor,
  canReadProgrammeItemsApi,
  programmeItemsReader,
  isBoardViewer,
  isProgrammeViewerRole,
  scheduleDayCompletionKeys,
  completionKeyAllowedForUser,
  assertDrawingTabAllowed,
  assertZoneTabAllowed,
  filterActivitiesForUser,
  filterDrawingsForUser,
  filterZonesAllForUser,
  filterCompletionsForUser,
  filterTemplatesForUser,
  userTabsSet,
  normalizeUserTabsArray,
};
