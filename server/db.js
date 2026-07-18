const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { dateKeysBetween, bboxFromGeom } = require('./programmeSync');
const schedule = require('./programmeSchedule');
const pw = require('./planWorkingDays');
const { resolveDatabasePath } = require('./databasePath');
const { DEFAULT_PROGRAMME_TEMPLATES } = require('./defaultTemplates');
const mbs = require('./moduleBulkSchedule');
const masm = require('./moduleAirSoundSchedule');

const GW_NAMES = [
  'Pile Mat',
  'Piling',
  'Crop Piles',
  'Cure',
  'Form Pile Cap',
  'Cage Pile Cap',
  'Pour Pile Cap',
  'Blinding',
  'Drainage',
  'Insulation',
  'Waterproofing',
  'Reinforcement - Shuttering',
  'Pour',
  'Verts',
  'Podium Pour',
];
const INT_NAMES = [
  'Riser Stitching',
  'Corridor Ceiling Stitch',
  'Modular Ceiling Stitch',
  'Modular Floor Stitch',
  'Form Door Aperture',
  'Corridor Floor Stitch',
  'Stair Core Stitching',
  'MEP Riser',
  'MEP Corridor',
  'Ceiling Install',
  'Install Ceiling Panels',
  'Modular Linear Stitch',
  'Install Fire Doors',
  'Paint',
  'Commission',
];

/** Starter activity names for the project_programme drawing tab (more can be added in Templates). */
const PROJECT_PROGRAMME_NAMES = [
  'Programme milestone',
  'Design / approval gate',
  'Procurement / long lead',
  'External / enabling works',
  'Handover / commissioning block',
];

/** Module Programme activities — same labels as Module Handover stages (client moduleHandover.js). */
const MODULE_PROGRAMME_NAMES = [
  'Not started',
  'Snagged',
  'Works in progress',
  'Clean',
  'Furniture',
  'Handover',
];

let db;

function save() {
  if (db) fs.writeFileSync(resolveDatabasePath(), Buffer.from(db.export()));
}
/** Single statement without persisting — use inside batched ops, then call save() once. */
function runNoSave(sql, p) {
  db.run(sql, p);
}
function run(sql, p) {
  db.run(sql, p);
  save();
}
function get(sql, p) {
  const s = db.prepare(sql);
  if (p) s.bind(p);
  if (s.step()) {
    const r = s.getAsObject();
    s.free();
    return r;
  }
  s.free();
  return null;
}
function all(sql, p) {
  const s = db.prepare(sql);
  if (p) s.bind(p);
  const r = [];
  while (s.step()) r.push(s.getAsObject());
  s.free();
  return r;
}

function expandScheduleForItem(pi, opts) {
  if (!pi) return;
  const deferSave = opts && opts.deferSave;
  const z = get(
    'SELECT z.*, d.tab FROM zones z JOIN drawings d ON d.id=z.drawing_id WHERE z.id=?',
    [pi.zone_id]
  );
  const a = get('SELECT name, type FROM activities WHERE id=?', [pi.activity_id]);
  if (!z || !a) return;
  const tabVal = scheduleTabForProgrammeItem(pi);
  const dates = dateKeysBetween(pi.start_date, pi.end_date);
  dates.forEach((dk) => {
    try {
      const sql =
        'INSERT OR IGNORE INTO schedule (tab,date,tower,zone_name,activity) VALUES (?,?,?,?,?)';
      const params = [tabVal, dk, z.tower, z.name, a.name];
      if (deferSave) runNoSave(sql, params);
      else run(sql, params);
    } catch (_) {}
  });
}

function shrinkScheduleForItem(pi, opts) {
  if (!pi) return;
  const deferSave = opts && opts.deferSave;
  if (!String(pi.start_date || '').trim() || !String(pi.end_date || '').trim()) return;
  const z = get(
    'SELECT z.*, d.tab FROM zones z JOIN drawings d ON d.id=z.drawing_id WHERE z.id=?',
    [pi.zone_id]
  );
  const a = get('SELECT name, type FROM activities WHERE id=?', [pi.activity_id]);
  if (!z || !a) return;
  const tabVal = scheduleTabForProgrammeItem(pi);
  const dates = dateKeysBetween(pi.start_date, pi.end_date);
  const sql =
    'DELETE FROM schedule WHERE tab=? AND date=? AND tower=? AND zone_name=? AND activity=?';
  dates.forEach((dk) => {
    const params = [tabVal, dk, z.tower, z.name, a.name];
    if (deferSave) runNoSave(sql, params);
    else run(sql, params);
  });
}

/** Stored programme_items dates may only cover scheduleable days (bank holidays excluded; Sat/Sun allowed). */
function clampProgrammeItemDates(start, end) {
  return pw.clampProgrammeItemToScheduleableRange(start, end);
}

function seedActivities() {
  const cnt = get('SELECT COUNT(*) as c FROM activities');
  if (cnt && Number(cnt.c) > 0) return;
  GW_NAMES.forEach((name) => {
    try {
      run('INSERT OR IGNORE INTO activities (name,type) VALUES (?,?)', [name, 'groundworks']);
    } catch (_) {}
  });
  INT_NAMES.forEach((name) => {
    try {
      run('INSERT OR IGNORE INTO activities (name,type) VALUES (?,?)', [name, 'internals']);
    } catch (_) {}
  });
}

/** Ensures project-programme activity types exist even when GW/INT seed already ran. */
function seedProjectProgrammeActivities() {
  PROJECT_PROGRAMME_NAMES.forEach((name) => {
    try {
      run('INSERT OR IGNORE INTO activities (name,type) VALUES (?,?)', [name, 'project_programme']);
    } catch (_) {}
  });
}

/** Module Programme activities — aligned with Module Handover stage labels. */
function seedModuleProgrammeActivities() {
  MODULE_PROGRAMME_NAMES.forEach((name) => {
    try {
      run('INSERT OR IGNORE INTO activities (name,type) VALUES (?,?)', [name, 'module_programme']);
    } catch (_) {}
  });
}

/** Module Completion template activities (Ryan Snag → Sparkle). */
function seedModuleCompletionActivities() {
  mbs.MODULE_COMPLETION_SEQUENCE.forEach((name) => {
    try {
      run('INSERT OR IGNORE INTO activities (name,type) VALUES (?,?)', [name, 'module_programme']);
    } catch (_) {}
  });
}

/** Schedule tab for a programme row: module_programme activities use that scope tab, not drawing tab. */
function scheduleTabForProgrammeItem(pi) {
  if (!pi) return '';
  const a = get('SELECT type FROM activities WHERE id=?', [pi.activity_id]);
  if (a && String(a.type) === 'module_programme') return 'module_programme';
  const z = get(
    'SELECT d.tab FROM zones z JOIN drawings d ON d.id=z.drawing_id WHERE z.id=?',
    [pi.zone_id]
  );
  return z && z.tab != null ? String(z.tab) : '';
}

function roleGetsProjectProgrammeTab(role) {
  return (
    role === 'admin' ||
    role === 'site_editor' ||
    role === 'editor' ||
    role === 'gw_subbie' ||
    role === 'int_subbie'
  );
}

/** Add project_programme tab only for roles that should manage milestones (admin/site). */
function migrateUserTabsProjectProgramme() {
  const users = all('SELECT id, tabs, role FROM users');
  const tab = 'project_programme';
  const sortKey = (x) => ({ groundworks: 0, internals: 1, project_programme: 2 }[x] ?? 99);
  for (const u of users) {
    if (!roleGetsProjectProgrammeTab(u.role)) continue;
    let t = [];
    try {
      t = JSON.parse(u.tabs || '[]');
    } catch (_) {}
    if (!Array.isArray(t)) t = [];
    if (t.includes(tab)) continue;
    t.push(tab);
    t.sort((a, b) => sortKey(a) - sortKey(b) || String(a).localeCompare(String(b)));
    run('UPDATE users SET tabs=? WHERE id=?', [JSON.stringify(t), u.id]);
  }
  save();
}

/** Roles that get the Module Handover tab: admin + site (setup), board (view). */
function roleGetsModuleHandoverTab(role) {
  return role === 'admin' || role === 'site_editor' || role === 'editor' || role === 'board_viewer';
}

/** Add module_handover tab to admin/site/board so they see the Module Handover page. */
function migrateUserTabsModuleHandover() {
  const users = all('SELECT id, tabs, role FROM users');
  const tab = 'module_handover';
  for (const u of users) {
    if (!roleGetsModuleHandoverTab(u.role)) continue;
    let t = [];
    try {
      t = JSON.parse(u.tabs || '[]');
    } catch (_) {}
    if (!Array.isArray(t)) t = [];
    if (t.includes(tab)) continue;
    t.push(tab);
    run('UPDATE users SET tabs=? WHERE id=?', [JSON.stringify(t), u.id]);
  }
  save();
}

/**
 * Add module_programme tab (dated programme on the same module zones) to anyone who already
 * has Module Handover access, so the new Plan/Template scope shows up for them.
 */
function migrateUserTabsModuleProgramme() {
  const users = all('SELECT id, tabs, role FROM users');
  const tab = 'module_programme';
  for (const u of users) {
    if (!roleGetsModuleHandoverTab(u.role)) continue;
    let t = [];
    try {
      t = JSON.parse(u.tabs || '[]');
    } catch (_) {}
    if (!Array.isArray(t)) t = [];
    if (t.includes(tab)) continue;
    t.push(tab);
    run('UPDATE users SET tabs=? WHERE id=?', [JSON.stringify(t), u.id]);
  }
  save();
}

/** Fold legacy module_handover scope tab into module_programme (one "Modules" scope). */
function migrateUserTabsUnifyModules() {
  const users = all('SELECT id, tabs FROM users');
  for (const u of users) {
    let t = [];
    try {
      t = JSON.parse(u.tabs || '[]');
    } catch (_) {}
    if (!Array.isArray(t)) t = [];
    const hadHandover = t.includes('module_handover');
    const filtered = t.filter((x) => x !== 'module_handover');
    if ((hadHandover || t.includes('module_programme')) && !filtered.includes('module_programme')) {
      filtered.push('module_programme');
    }
    const next = JSON.stringify(filtered);
    if (next !== JSON.stringify(t)) {
      run('UPDATE users SET tabs=? WHERE id=?', [next, u.id]);
    }
  }
  save();
}

/** Re-key schedule rows for module_programme items from drawing tab → module_programme scope tab. */
function migrateModuleProgrammeScheduleTab() {
  const items = all(
    `SELECT pi.* FROM programme_items pi
     JOIN activities a ON a.id = pi.activity_id
     WHERE a.type = 'module_programme'`
  );
  if (!items.length) return;
  for (const pi of items) {
    const z = get(
      'SELECT z.*, d.tab AS drawing_tab FROM zones z JOIN drawings d ON d.id = z.drawing_id WHERE z.id=?',
      [pi.zone_id]
    );
    const a = get('SELECT name FROM activities WHERE id=?', [pi.activity_id]);
    if (!z || !a) continue;
    const dates = dateKeysBetween(pi.start_date, pi.end_date);
    dates.forEach((dk) => {
      runNoSave(
        'DELETE FROM schedule WHERE tab=? AND date=? AND tower=? AND zone_name=? AND activity=?',
        [String(z.drawing_tab || ''), dk, z.tower, z.name, a.name]
      );
    });
    expandScheduleForItem(pi, { deferSave: true });
  }
  save();
  console.log('[119HS] Migrated module_programme schedule tab for', items.length, 'item(s)');
}

/** Sync role + tabs for standard programme accounts from defaultUsers.js (live RBAC matrix). */
function migrateDefaultUserRoles() {
  const { DEFAULT_BOOTSTRAP_USERS } = require('./defaultUsers');
  const byUser = new Map(DEFAULT_BOOTSTRAP_USERS.map((u) => [u.username, u]));
  const rows = all('SELECT id, username FROM users');
  for (const row of rows) {
    const spec = byUser.get(row.username);
    if (!spec) continue;
    run('UPDATE users SET role=?, tabs=? WHERE id=?', [
      spec.role,
      JSON.stringify(spec.tabs),
      row.id,
    ]);
  }
  save();
}

function migrateZoneActivitiesTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS zone_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id INTEGER NOT NULL,
      activity_id INTEGER NOT NULL,
      sequence_order INTEGER NOT NULL DEFAULT 0,
      duration_days INTEGER NOT NULL DEFAULT 1,
      start_date TEXT,
      FOREIGN KEY (zone_id) REFERENCES zones(id),
      FOREIGN KEY (activity_id) REFERENCES activities(id)
    )
  `);
  save();
  try {
    db.run(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_zone_activities_zone_activity ON zone_activities(zone_id, activity_id)'
    );
    save();
  } catch (_) {}
  const legacy = all('SELECT id, activity_id FROM zones WHERE activity_id IS NOT NULL');
  legacy.forEach((z) => {
    const dup = get('SELECT id FROM zone_activities WHERE zone_id=? AND activity_id=?', [
      z.id,
      z.activity_id,
    ]);
    if (!dup) {
      run(
        'INSERT INTO zone_activities (zone_id, activity_id, sequence_order, duration_days, start_date) VALUES (?,?,?,?,?)',
        [z.id, z.activity_id, 0, 1, null]
      );
    }
  });
  save();
}

function attachActivitiesToZones(zoneRows) {
  if (!zoneRows.length) return zoneRows;
  const ids = zoneRows.map((z) => z.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = all(
    `SELECT za.id AS za_id, za.zone_id, za.activity_id, za.sequence_order, za.duration_days, za.start_date, a.name AS activity_name
     FROM zone_activities za
     JOIN activities a ON a.id = za.activity_id
     WHERE za.zone_id IN (${placeholders})
     ORDER BY za.zone_id, za.sequence_order ASC, za.id ASC`,
    ids
  );
  const byZone = {};
  rows.forEach((r) => {
    if (!byZone[r.zone_id]) byZone[r.zone_id] = [];
    byZone[r.zone_id].push({
      id: r.za_id,
      activity_id: r.activity_id,
      name: r.activity_name,
      sequence_order: r.sequence_order,
      duration_days: r.duration_days,
      start_date: r.start_date,
    });
  });
  return zoneRows.map((z) => ({
    ...z,
    activities: byZone[z.id] || [],
  }));
}

/**
 * Older production boots only inserted `admin`. Add site / DBs / IKEW / board if they are missing (idempotent).
 * Does not change existing passwords or overwrite admin.
 */
function ensureStandardProgrammeUsers() {
  const { DEFAULT_BOOTSTRAP_USERS } = require('./defaultUsers');
  for (const row of DEFAULT_BOOTSTRAP_USERS) {
    if (row.username === 'admin' || !row.passwordPlain) continue;
    const existing = get('SELECT id FROM users WHERE username=?', [row.username]);
    if (existing) continue;
    try {
      run('INSERT INTO users (username,password_hash,name,role,tabs) VALUES (?,?,?,?,?)', [
        row.username,
        bcrypt.hashSync(row.passwordPlain, 10),
        row.name,
        row.role,
        JSON.stringify(row.tabs),
      ]);
      console.log('[119HS] Added missing programme user:', row.username);
    } catch (e) {
      console.error('[119HS] Could not add user', row.username, e.message);
    }
  }
  syncModulesEditorProfile();
}

/** Keep Ryan (modules-editor) role/tabs aligned if the row already exists from an older seed. */
function syncModulesEditorProfile() {
  const { DEFAULT_BOOTSTRAP_USERS } = require('./defaultUsers');
  const row = DEFAULT_BOOTSTRAP_USERS.find((u) => u.username === 'ryan');
  if (!row) return;
  const existing = get('SELECT id, role, tabs, name FROM users WHERE username=?', ['ryan']);
  if (!existing) return;
  const tabsJson = JSON.stringify(row.tabs);
  if (existing.role === row.role && existing.tabs === tabsJson && existing.name === row.name) return;
  run('UPDATE users SET role=?, tabs=?, name=? WHERE username=?', [row.role, tabsJson, row.name, 'ryan']);
  console.log('[119HS] Synced modules-editor profile for ryan');
}

/** First boot on an empty database: all standard programme users + starter templates (no demo schedule). */
function bootstrapEmptyDatabase() {
  const cnt = get('SELECT COUNT(*) as c FROM users');
  if (cnt && Number(cnt.c) > 0) return;

  const isProd = process.env.NODE_ENV === 'production';
  const fromEnv = process.env.SEED_ADMIN_PASSWORD && String(process.env.SEED_ADMIN_PASSWORD).trim();
  let adminPw = fromEnv;
  if (!adminPw) {
    if (isProd) {
      console.error(
        '[119HS] Empty database: set SEED_ADMIN_PASSWORD in the environment for the first admin user, then restart. No default password is used in production.'
      );
      process.exit(1);
    }
    adminPw = '119hs';
    console.log('[119HS] Bootstrap (dev only): admin password 119hs; creating standard programme users.');
  } else if (isProd) {
    console.log('[119HS] Bootstrap: creating admin + standard programme users (site, DBs, IKEW, board).');
  } else {
    console.log('[119HS] Bootstrap: admin from SEED_ADMIN_PASSWORD; creating standard programme users.');
  }

  const { DEFAULT_BOOTSTRAP_USERS } = require('./defaultUsers');

  try {
    for (const row of DEFAULT_BOOTSTRAP_USERS) {
      const plain = row.username === 'admin' ? adminPw : row.passwordPlain;
      if (!plain) {
        console.error('[119HS] Bootstrap: skipped user with no password:', row.username);
        continue;
      }
      run('INSERT INTO users (username,password_hash,name,role,tabs) VALUES (?,?,?,?,?)', [
        row.username,
        bcrypt.hashSync(plain, 10),
        row.name,
        row.role,
        JSON.stringify(row.tabs),
      ]);
    }
  } catch (e) {
    console.error('[119HS] Bootstrap users failed:', e.message);
    return;
  }

  const tplCnt = get('SELECT COUNT(*) as c FROM templates');
  if (tplCnt && Number(tplCnt.c) > 0) return;

  try {
    for (const t of DEFAULT_PROGRAMME_TEMPLATES) {
      run('INSERT INTO templates (name,tab,tower,zone_name,sequence,durations) VALUES (?,?,?,?,?,?)', [
        t.name,
        t.tab,
        t.tower,
        t.zone_name,
        JSON.stringify(t.sequence),
        JSON.stringify(t.durations),
      ]);
    }
    if (!isProd) {
      console.log('[119HS] Bootstrap: added', DEFAULT_PROGRAMME_TEMPLATES.length, 'programme templates.');
    }
  } catch (e) {
    console.error('[119HS] Bootstrap templates failed:', e.message);
  }
}

/** Re-insert GW Standard / INT Floor if missing (e.g. DB wiped templates but users remained). */
function ensureDefaultTemplates() {
  for (const t of DEFAULT_PROGRAMME_TEMPLATES) {
    const row = get('SELECT id FROM templates WHERE name=? AND tab=?', [t.name, t.tab]);
    if (row) continue;
    try {
      run('INSERT INTO templates (name,tab,tower,zone_name,sequence,durations) VALUES (?,?,?,?,?,?)', [
        t.name,
        t.tab,
        t.tower,
        t.zone_name,
        JSON.stringify(t.sequence),
        JSON.stringify(t.durations),
      ]);
      console.log('[119HS] Restored default template:', t.name, `(${t.tab})`);
    } catch (e) {
      console.error('[119HS] ensureDefaultTemplates:', t.name, e.message);
    }
  }
}

function migrateZonesGeometry() {
  const rows = all(
    "SELECT * FROM zones WHERE geometry IS NULL OR geometry = '' OR geometry = 'null'"
  );
  const now = new Date().toISOString();
  rows.forEach((z) => {
    const geom = JSON.stringify({ kind: 'rect', x: z.x, y: z.y, w: z.w, h: z.h });
    let aid = z.activity_id != null ? z.activity_id : null;
    if (aid == null && z.linked_activity) {
      const a = get('SELECT id FROM activities WHERE name=?', [z.linked_activity]);
      if (a) aid = a.id;
    }
    run(
      'UPDATE zones SET geometry=?, activity_id=COALESCE(activity_id,?), created_at=COALESCE(created_at,?), updated_at=? WHERE id=?',
      [geom, aid, now, now, z.id]
    );
  });
}

async function getDb() {
  if (db) return db;
  const sqlDbPath = resolveDatabasePath();
  const dir = path.dirname(sqlDbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const SQL = await initSqlJs();
  if (fs.existsSync(sqlDbPath)) {
    db = new SQL.Database(fs.readFileSync(sqlDbPath));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', tabs TEXT NOT NULL DEFAULT '["groundworks"]');
    CREATE TABLE IF NOT EXISTS drawings (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tab TEXT NOT NULL DEFAULT 'groundworks', floor TEXT NOT NULL DEFAULT 'ground', image_data TEXT NOT NULL, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS zones (id INTEGER PRIMARY KEY AUTOINCREMENT, drawing_id INTEGER NOT NULL, name TEXT NOT NULL, tower TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY AUTOINCREMENT, tab TEXT NOT NULL, date TEXT NOT NULL, tower TEXT NOT NULL, zone_name TEXT NOT NULL, activity TEXT NOT NULL, UNIQUE(tab, date, tower, zone_name, activity));
    CREATE TABLE IF NOT EXISTS completions (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, key TEXT NOT NULL, completed_by TEXT NOT NULL, completed_at TEXT NOT NULL, UNIQUE(date, key));
    CREATE TABLE IF NOT EXISTS milestones (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned');
    CREATE TABLE IF NOT EXISTS templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tab TEXT NOT NULL, tower TEXT NOT NULL, zone_name TEXT NOT NULL, sequence TEXT NOT NULL, durations TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'groundworks');
    CREATE TABLE IF NOT EXISTS programme_items (id INTEGER PRIMARY KEY AUTOINCREMENT, zone_id INTEGER NOT NULL, activity_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned', notes TEXT DEFAULT '');
  `);
  try {
    db.run('ALTER TABLE zones ADD COLUMN linked_activity TEXT');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE drawings ADD COLUMN file_url TEXT');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN geometry TEXT');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN activity_id INTEGER');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN created_at TEXT');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN updated_at TEXT');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN handover_stage TEXT');
    save();
  } catch (_) {}

  seedActivities();
  seedProjectProgrammeActivities();
  seedModuleProgrammeActivities();
  seedModuleCompletionActivities();
  migrateZonesGeometry();
  migrateZoneActivitiesTable();
  migrateZoneProgrammeMeta();
  migrateProgrammeCommandLog();
  migrateMilestonesCompletionPct();
  migrateMilestonesProgrammeItemId();
  migrateProgrammeItemsClampScheduleable();
  migrateProgrammeItemsClampScheduleableV2();
  migrateShiftColumn();
  migrateProjectProgrammeItems();
  migrateActivityDependencies();
  migrateClearAutoProgrammeDependencies();
  migrateClearAllProgrammeItemDependencies();
  bootstrapEmptyDatabase();
  ensureStandardProgrammeUsers();
  ensureDefaultTemplates();
  migrateDefaultUserRoles();
  migrateUserTabsProjectProgramme();
  migrateUserTabsModuleHandover();
  migrateUserTabsModuleProgramme();
  migrateUserTabsUnifyModules();
  migrateModuleProgrammeScheduleTab();
  save();
  const danglingCompletions = countCompletionsDanglingZoneRef();
  if (danglingCompletions > 0) {
    console.warn(
      '[119HS] completions integrity:',
      danglingCompletions,
      'completion row(s) reference a tower/zone that does not exist (no auto-delete).'
    );
  }
  return db;
}

/** Zone template + anchor metadata — docs/SOURCE_OF_TRUTH.md §4.2, §13 (resequence / Generate programme). */
function migrateZoneProgrammeMeta() {
  try {
    db.run('ALTER TABLE zones ADD COLUMN source_template_id INTEGER');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN programme_stage_idx INTEGER');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN programme_anchor_date TEXT');
    save();
  } catch (_) {}
  try {
    db.run('ALTER TABLE zones ADD COLUMN programme_anchor_activity_id INTEGER');
    save();
  } catch (_) {}
}

// Dependency model — docs/SOURCE_OF_TRUTH.md §3.8
function migrateActivityDependencies() {
  db.run(`
    CREATE TABLE IF NOT EXISTS activity_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      predecessor_type TEXT NOT NULL CHECK(predecessor_type IN ('programme_item','project_programme_item')),
      predecessor_id INTEGER NOT NULL,
      successor_type TEXT NOT NULL CHECK(successor_type IN ('programme_item','project_programme_item')),
      successor_id INTEGER NOT NULL,
      relationship_type TEXT NOT NULL DEFAULT 'FS',
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(predecessor_type, predecessor_id, successor_type, successor_id)
    );
  `);
  save();
}

// Project Programme items — docs/SOURCE_OF_TRUTH.md §10
function migrateProjectProgrammeItems() {
  db.run(`
    CREATE TABLE IF NOT EXISTS project_programme_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid INTEGER NOT NULL,
      name TEXT NOT NULL,
      wbs TEXT,
      outline_level INTEGER DEFAULT 1,
      start_date TEXT,
      finish_date TEXT,
      duration_days REAL,
      is_summary INTEGER DEFAULT 0,
      is_milestone INTEGER DEFAULT 0,
      is_milestone_tagged INTEGER DEFAULT 0,
      zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  save();
}

function migrateProgrammeCommandLog() {
  db.run(`
    CREATE TABLE IF NOT EXISTS programme_command_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      username TEXT NOT NULL,
      command_text TEXT NOT NULL,
      parsed_action TEXT,
      phase TEXT NOT NULL,
      error_message TEXT
    )
  `);
  save();
}

function migrateMilestonesCompletionPct() {
  try {
    db.run('ALTER TABLE milestones ADD COLUMN completion_pct INTEGER NOT NULL DEFAULT 0');
    save();
  } catch (_) {}
}

function migrateMilestonesProgrammeItemId() {
  try {
    db.run('ALTER TABLE milestones ADD COLUMN programme_item_id INTEGER');
    save();
  } catch (_) {}
}

/** One-time: reclamp all programme_items to scheduleable-only ranges and refresh schedule slots. */
function migrateProgrammeItemsClampScheduleable() {
  try {
    db.run('CREATE TABLE IF NOT EXISTS _119hs_migrations (name TEXT PRIMARY KEY NOT NULL)');
    save();
  } catch (_) {}
  const ran = get("SELECT name FROM _119hs_migrations WHERE name='clamp_programme_scheduleable_v1' LIMIT 1");
  if (ran) return;
  const items = all('SELECT * FROM programme_items ORDER BY id');
  let changed = 0;
  for (const it of items) {
    const { start_date: sd, end_date: ed } = clampProgrammeItemDates(it.start_date, it.end_date);
    if (sd === String(it.start_date || '').trim() && ed === String(it.end_date || '').trim()) continue;
    shrinkScheduleForItem(it, { deferSave: true });
    runNoSave('UPDATE programme_items SET start_date=?, end_date=? WHERE id=?', [sd, ed, it.id]);
    const neu = get('SELECT * FROM programme_items WHERE id=?', [it.id]);
    if (neu) expandScheduleForItem(neu, { deferSave: true });
    changed++;
  }
  runNoSave("INSERT INTO _119hs_migrations (name) VALUES ('clamp_programme_scheduleable_v1')");
  save();
  if (changed) {
    console.log(
      '[119HS] Migration: reclamped',
      changed,
      'programme row(s) so dates do not bridge Sundays or England & Wales bank holidays; schedule table updated.'
    );
  }
}

function migrateShiftColumn() {
  const sqlPath = path.join(__dirname, 'sql', 'add-shift-column.sql');
  if (!fs.existsSync(sqlPath)) return;
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean);
  for (const stmt of statements) {
    try {
      db.run(stmt);
      save();
    } catch (_) {}
  }
}

/** Re-clamp after Saturdays became non-working in scheduleable-day rules (runs once per DB). */
function migrateProgrammeItemsClampScheduleableV2() {
  try {
    db.run('CREATE TABLE IF NOT EXISTS _119hs_migrations (name TEXT PRIMARY KEY NOT NULL)');
    save();
  } catch (_) {}
  const ran = get("SELECT name FROM _119hs_migrations WHERE name='clamp_programme_scheduleable_v2' LIMIT 1");
  if (ran) return;
  const items = all('SELECT * FROM programme_items ORDER BY id');
  let changed = 0;
  for (const it of items) {
    const { start_date: sd, end_date: ed } = clampProgrammeItemDates(it.start_date, it.end_date);
    if (sd === String(it.start_date || '').trim() && ed === String(it.end_date || '').trim()) continue;
    shrinkScheduleForItem(it, { deferSave: true });
    runNoSave('UPDATE programme_items SET start_date=?, end_date=? WHERE id=?', [sd, ed, it.id]);
    const neu = get('SELECT * FROM programme_items WHERE id=?', [it.id]);
    if (neu) expandScheduleForItem(neu, { deferSave: true });
    changed++;
  }
  runNoSave("INSERT INTO _119hs_migrations (name) VALUES ('clamp_programme_scheduleable_v2')");
  save();
  if (changed) {
    console.log(
      '[119HS] Migration v2: reclamped',
      changed,
      'programme row(s) for Mon–Fri scheduleable rules (Saturdays excluded from auto spans); schedule updated.'
    );
  }
}

/** One-time: remove auto-wired consecutive programme dependencies (Plan moves are manual). */
function migrateClearAutoProgrammeDependencies() {
  try {
    db.run('CREATE TABLE IF NOT EXISTS _119hs_migrations (name TEXT PRIMARY KEY NOT NULL)');
    save();
  } catch (_) {}
  const ran = get("SELECT name FROM _119hs_migrations WHERE name='clear_auto_programme_dependencies_v1' LIMIT 1");
  if (ran) return;
  const before = get("SELECT COUNT(*) AS c FROM activity_dependencies WHERE created_by='system'");
  runNoSave("DELETE FROM activity_dependencies WHERE created_by='system'");
  runNoSave("INSERT INTO _119hs_migrations (name) VALUES ('clear_auto_programme_dependencies_v1')");
  save();
  const removed = before ? Number(before.c) : 0;
  if (removed > 0) {
    console.log('[119HS] Migration: removed', removed, 'auto-wired programme dependency link(s). Add dependencies manually in Plan.');
  }
}

/** One-time: strip all programme-item dependency links so Plan moves are fully manual. */
function migrateClearAllProgrammeItemDependencies() {
  try {
    db.run('CREATE TABLE IF NOT EXISTS _119hs_migrations (name TEXT PRIMARY KEY NOT NULL)');
    save();
  } catch (_) {}
  const ran = get("SELECT name FROM _119hs_migrations WHERE name='clear_all_programme_item_dependencies_v1' LIMIT 1");
  if (ran) return;
  const before = get(
    "SELECT COUNT(*) AS c FROM activity_dependencies WHERE predecessor_type='programme_item' OR successor_type='programme_item'"
  );
  runNoSave(
    "DELETE FROM activity_dependencies WHERE predecessor_type='programme_item' OR successor_type='programme_item'"
  );
  runNoSave("INSERT INTO _119hs_migrations (name) VALUES ('clear_all_programme_item_dependencies_v1')");
  save();
  const removed = before ? Number(before.c) : 0;
  if (removed > 0) {
    console.log('[119HS] Migration: cleared', removed, 'programme-item dependency link(s). Re-add manually in Plan when ready.');
  }
}

/** Matches Update screen completion keys (pfx|activity). */
function completionKeyFromParts(tower, zoneName, activity) {
  const tw = String(tower || '').trim();
  const zn = String(zoneName || '').trim();
  const act = String(activity || '').trim();
  const pfx = zn === '_default' ? tw : `${tw}|${zn}`;
  return `${pfx}|${act}`;
}

/** Parse client completion key `tower|activity` or `tower|zone|activity`. */
function parseCompletionKeyParts(key) {
  const s = String(key || '').trim();
  const parts = s.split('|');
  if (parts.length < 2) return null;
  if (parts.length === 2) {
    return { tower: parts[0].trim(), zone: '_default', activity: parts[1].trim() };
  }
  return {
    tower: parts[0].trim(),
    zone: parts.slice(1, -1).join('|').trim(),
    activity: parts[parts.length - 1].trim(),
  };
}

/** For SQL LIKE: escape `\`, `%`, `_` in user-controlled tower/zone segments. */
function sqlLikeEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Completions whose key names a concrete zone (not _default) that no longer exists in `zones`.
 * Does not auto-delete — see startup log in getDb.
 */
function countCompletionsDanglingZoneRef() {
  const zones = all('SELECT tower, name FROM zones');
  const zoneSet = new Set(
    zones.map((z) => `${String(z.tower || '').trim()}\u0000${String(z.name || '').trim()}`)
  );
  const rows = all('SELECT key FROM completions');
  let n = 0;
  for (const { key } of rows) {
    const p = parseCompletionKeyParts(key);
    if (!p || !p.tower || !p.activity) continue;
    if (p.zone === '_default') continue;
    const ref = `${String(p.tower).trim()}\u0000${String(p.zone).trim()}`;
    if (!zoneSet.has(ref)) n++;
  }
  return n;
}

/** Share of scheduled day-slots for this programme item that have a completion tick. */
function computeLiveCompletionFromProgrammeItem(piId, compMap) {
  const pi = get(
    `SELECT pi.start_date, pi.end_date, z.name AS zone_name, z.tower, d.tab AS drawing_tab, a.name AS activity_name
     FROM programme_items pi
     JOIN zones z ON z.id = pi.zone_id
     JOIN drawings d ON d.id = z.drawing_id
     JOIN activities a ON a.id = pi.activity_id
     WHERE pi.id = ?`,
    [piId]
  );
  if (!pi) return null;
  const key = completionKeyFromParts(pi.tower, pi.zone_name, pi.activity_name);
  const rows = all(
    `SELECT date FROM schedule WHERE tab=? AND tower=? AND zone_name=? AND activity=? AND date >= ? AND date <= ? ORDER BY date`,
    [
      pi.drawing_tab,
      pi.tower,
      pi.zone_name,
      pi.activity_name,
      pi.start_date,
      pi.end_date,
    ]
  );
  if (!rows.length) return { pct: 0, done: 0, total: 0 };
  let done = 0;
  for (const r of rows) {
    if (compMap[r.date] && compMap[r.date][key]) done++;
  }
  const total = rows.length;
  const pct = Math.round((done / total) * 100);
  return { pct, done, total };
}

function enrichMilestoneRow(m, compMap) {
  const stored = Math.max(0, Math.min(100, Math.round(Number(m.completion_pct) || 0)));
  let completion_pct = stored;
  let tracks_live = false;
  let live_ticks_done = 0;
  let live_ticks_total = 0;
  const pid =
    m.programme_item_id != null && m.programme_item_id !== ''
      ? Number(m.programme_item_id)
      : null;
  if (pid != null && Number.isFinite(pid)) {
    const live = computeLiveCompletionFromProgrammeItem(pid, compMap);
    if (live) {
      tracks_live = true;
      live_ticks_done = live.done;
      live_ticks_total = live.total;
      completion_pct = live.total > 0 ? live.pct : 0;
    }
  }
  return {
    ...m,
    completion_pct,
    completion_pct_manual: stored,
    tracks_live,
    ...(tracks_live ? { live_ticks_done, live_ticks_total } : {}),
  };
}

function resolveDependencyItemInfo(type, id) {
  const nid = Number(id);
  if (!Number.isFinite(nid)) return null;
  if (type === 'programme_item') {
    const row = get(
      `SELECT pi.*, a.name AS activity_name, z.name AS zone_name, z.tower
       FROM programme_items pi
       JOIN activities a ON a.id = pi.activity_id
       JOIN zones z ON z.id = pi.zone_id
       WHERE pi.id = ?`,
      [nid]
    );
    if (!row) return null;
    const label = [row.tower, row.zone_name, row.activity_name].filter(Boolean).join(' — ');
    return {
      name: label || row.activity_name,
      activity_name: row.activity_name,
      end_date: row.end_date,
      status: row.status,
    };
  }
  if (type === 'project_programme_item') {
    const row = get('SELECT * FROM project_programme_items WHERE id=?', [nid]);
    if (!row) return null;
    return {
      name: row.name,
      activity_name: row.name,
      end_date: row.finish_date || row.start_date || null,
      status: null,
    };
  }
  return null;
}

function isPredecessorIncomplete(type, info) {
  if (!info) return false;
  if (type === 'programme_item') {
    return String(info.status || '').toLowerCase() !== 'done';
  }
  return true;
}

/** Set true when §4.12 dependency enforcement should block earlier moves on the Plan page. */
const ENFORCE_PROGRAMME_DEPENDENCIES = false;

function checkDependencyViolationForEarlierStart(successorType, successorId, newStartDate, oldStartDate) {
  if (!ENFORCE_PROGRAMME_DEPENDENCIES) return null;
  const nextStart = String(newStartDate || '').trim();
  const prevStart = String(oldStartDate || '').trim();
  if (!nextStart || !prevStart || nextStart >= prevStart) return null;

  const preds = all(
    'SELECT * FROM activity_dependencies WHERE successor_type=? AND successor_id=?',
    [successorType, Number(successorId)]
  );
  for (const dep of preds) {
    const predInfo = resolveDependencyItemInfo(dep.predecessor_type, dep.predecessor_id);
    if (!predInfo || !isPredecessorIncomplete(dep.predecessor_type, predInfo)) continue;
    const predEnd = String(predInfo.end_date || '').trim();
    if (predEnd && predEnd > nextStart) {
      return {
        error: 'DEPENDENCY_VIOLATION',
        message: `Cannot move: predecessor ${predInfo.name} ends on ${predEnd}`,
      };
    }
  }
  return null;
}

function enrichDependencyRow(dep) {
  const pred = resolveDependencyItemInfo(dep.predecessor_type, dep.predecessor_id);
  const succ = resolveDependencyItemInfo(dep.successor_type, dep.successor_id);
  return {
    ...dep,
    predecessor_name: pred ? pred.name : null,
    successor_name: succ ? succ.name : null,
  };
}

function remapZoneProgrammeItemDependencies(oldItems, newItems) {
  const oldByAct = new Map();
  for (const it of oldItems || []) {
    oldByAct.set(Number(it.activity_id), Number(it.id));
  }
  const newByAct = new Map();
  for (const it of newItems || []) {
    newByAct.set(Number(it.activity_id), Number(it.id));
  }
  for (const [actId, oldId] of oldByAct.entries()) {
    const newId = newByAct.get(actId);
    if (!Number.isFinite(newId) || newId === oldId) continue;
    runNoSave(
      "UPDATE activity_dependencies SET predecessor_id=? WHERE predecessor_type='programme_item' AND predecessor_id=?",
      [newId, oldId]
    );
    runNoSave(
      "UPDATE activity_dependencies SET successor_id=? WHERE successor_type='programme_item' AND successor_id=?",
      [newId, oldId]
    );
  }
}

function deleteDependenciesForProgrammeItemIds(piIds, opts) {
  const ids = (piIds || []).map(Number).filter((id) => Number.isFinite(id));
  if (!ids.length) return;
  const deferSave = opts && opts.deferSave;
  const ph = ids.map(() => '?').join(',');
  const sql = `DELETE FROM activity_dependencies WHERE (predecessor_type='programme_item' AND predecessor_id IN (${ph})) OR (successor_type='programme_item' AND successor_id IN (${ph}))`;
  const params = [...ids, ...ids];
  if (deferSave) runNoSave(sql, params);
  else run(sql, params);
}

function createConsecutiveProgrammeItemDependencies(itemIdsOrdered, createdBy, opts) {
  if (!ENFORCE_PROGRAMME_DEPENDENCIES) return;
  const ids = itemIdsOrdered || [];
  const deferSave = opts && opts.deferSave;
  const by = String(createdBy || 'system');
  for (let i = 0; i < ids.length - 1; i++) {
    const predId = Number(ids[i]);
    const succId = Number(ids[i + 1]);
    if (!Number.isFinite(predId) || !Number.isFinite(succId)) continue;
    const sql = `INSERT OR IGNORE INTO activity_dependencies (
      predecessor_type, predecessor_id, successor_type, successor_id, relationship_type, created_by
    ) VALUES ('programme_item', ?, 'programme_item', ?, 'FS', ?)`;
    const params = [predId, succId, by];
    if (deferSave) runNoSave(sql, params);
    else run(sql, params);
  }
}

module.exports = {
  init: getDb,
  resolveDatabasePath,
  getUser: (u) => get('SELECT * FROM users WHERE username=?', [u]),
  getUsers: () => all('SELECT * FROM users ORDER BY id'),
  addUser: (u, h, n, r, t) => {
    try {
      run('INSERT OR REPLACE INTO users (username,password_hash,name,role,tabs) VALUES (?,?,?,?,?)', [
        u,
        h,
        n,
        r,
        t,
      ]);
    } catch (e) {}
  },
  deleteUser: (id) => run('DELETE FROM users WHERE id=? AND username!="admin"', [id]),
  getDrawings: () => all('SELECT id,name,tab,floor,width,height,file_url FROM drawings'),
  getDrawing: (id) => get('SELECT * FROM drawings WHERE id=?', [id]),
  addDrawing: (n, t, f, d, w, h, fileUrl) => {
    run('INSERT INTO drawings (name,tab,floor,image_data,width,height,file_url) VALUES (?,?,?,?,?,?,?)', [
      n,
      t,
      f,
      d,
      w || 0,
      h || 0,
      fileUrl || null,
    ]);
    return { lastInsertRowid: get('SELECT last_insert_rowid() as id').id };
  },
  updateDrawingFileUrl: (id, fileUrl) => {
    run('UPDATE drawings SET file_url=? WHERE id=?', [fileUrl || null, id]);
  },
  renameDrawing: (id, name) => {
    const nm = String(name || '').trim();
    if (!nm) return { error: 'name_required' };
    const d = get('SELECT id FROM drawings WHERE id=?', [id]);
    if (!d) return { error: 'not_found' };
    run('UPDATE drawings SET name=? WHERE id=?', [nm, id]);
    return { ok: true };
  },
  deleteDrawing: (id) => {
    const zs = all('SELECT id, tower, name FROM zones WHERE drawing_id=?', [id]);
    zs.forEach((z) => {
      const tower = String(z.tower || '').trim();
      const zoneName = String(z.name || '').trim();
      const likePat = `${sqlLikeEscape(tower)}|${sqlLikeEscape(zoneName)}|%`;
      runNoSave("DELETE FROM completions WHERE key LIKE ? ESCAPE '\\'", [likePat]);
      const pis = all('SELECT * FROM programme_items WHERE zone_id=?', [z.id]);
      pis.forEach((pi) => shrinkScheduleForItem(pi, { deferSave: true }));
      runNoSave('DELETE FROM programme_items WHERE zone_id=?', [z.id]);
      runNoSave('DELETE FROM zone_activities WHERE zone_id=?', [z.id]);
    });
    runNoSave('DELETE FROM zones WHERE drawing_id=?', [id]);
    runNoSave('DELETE FROM drawings WHERE id=?', [id]);
    save();
  },
  getZones: (did) =>
    attachActivitiesToZones(all('SELECT * FROM zones WHERE drawing_id=? ORDER BY id', [did])),
  getAllZones: () =>
    attachActivitiesToZones(
      all('SELECT z.*, d.tab, d.floor FROM zones z JOIN drawings d ON z.drawing_id=d.id')
    ),
  getZoneById: (id) => get('SELECT * FROM zones WHERE id=?', [id]),
  /** Zone id + drawing tab (RBAC checks). */
  getZoneDrawingTab: (id) =>
    get(
      'SELECT z.id, d.tab FROM zones z JOIN drawings d ON d.id = z.drawing_id WHERE z.id = ?',
      [id]
    ),
  getZoneIdsWithProgrammeItems: () =>
    all('SELECT DISTINCT zone_id FROM programme_items').map((r) => Number(r.zone_id)),
  logProgrammeCommand: ({ username, command_text, parsed_action, phase, error_message }) => {
    run(
      'INSERT INTO programme_command_log (created_at, username, command_text, parsed_action, phase, error_message) VALUES (?,?,?,?,?,?)',
      [
        new Date().toISOString(),
        String(username || 'unknown'),
        String(command_text || ''),
        parsed_action != null ? String(parsed_action) : null,
        String(phase || 'unknown'),
        error_message != null ? String(error_message) : null,
      ]
    );
  },
  resetProgrammeData: () => {
    /** Keeps `activities` (catalog + template names), `drawings`, `templates`, `users`. Clears scheduled/site programme state. */
    const tablesToClear = [
      'programme_items',
      'schedule',
      'completions',
      'zone_activities',
      'zones',
      'milestones',
      'programme_command_log',
      'command_log',
      'look_ahead',
      'slip_notifications',
    ];
    const cleared = [];
    const skipped = [];
    for (const t of tablesToClear) {
      const exists = get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [t]
      );
      if (!exists) {
        skipped.push(t);
        continue;
      }
      run(`DELETE FROM ${t}`);
      cleared.push(t);
    }
    save();
    return { cleared, skipped };
  },
  /**
   * Admin wipe: programme_items, zone_activities, completions, schedule only.
   * Keeps activities, zones, templates, drawings, milestones (per admin reset contract).
   */
  resetProgrammeSlotData: () => {
    const tables = ['programme_items', 'zone_activities', 'completions', 'schedule'];
    const deleted = {};
    let inTx = false;
    try {
      runNoSave('BEGIN IMMEDIATE');
      inTx = true;
      for (const t of tables) {
        const c = get(`SELECT COUNT(*) AS c FROM ${t}`);
        deleted[t] = Number(c && c.c != null ? c.c : 0);
        runNoSave(`DELETE FROM ${t}`);
      }
      runNoSave('COMMIT');
      inTx = false;
      save();
    } catch (e) {
      if (inTx) {
        try {
          runNoSave('ROLLBACK');
        } catch (_) {}
      }
      throw e;
    }
    return deleted;
  },
  /** Clears programme rows, site schedule, Update ticks, and zone activity rows; keeps zones, drawings, templates, users. */
  clearProgrammeKeepZones: () => {
    const tablesToClear = [
      'programme_items',
      'schedule',
      'completions',
      'zone_activities',
      'programme_command_log',
      'command_log',
      'look_ahead',
      'slip_notifications',
    ];
    const cleared = [];
    const skipped = [];
    for (const t of tablesToClear) {
      const exists = get("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", [t]);
      if (!exists) {
        skipped.push(t);
        continue;
      }
      run(`DELETE FROM ${t}`);
      cleared.push(t);
    }
    try {
      const m = get("SELECT name FROM sqlite_master WHERE type='table' AND name='milestones' LIMIT 1");
      if (m) {
        run('UPDATE milestones SET programme_item_id=NULL WHERE programme_item_id IS NOT NULL');
        cleared.push('milestones.programme_item_id (nulled)');
      }
    } catch (_) {}
    try {
      run(
        'UPDATE zones SET programme_anchor_date=NULL, programme_stage_idx=NULL, programme_anchor_activity_id=NULL'
      );
      cleared.push(
        'zones.programme_anchor_date, programme_stage_idx, programme_anchor_activity_id (nulled)'
      );
    } catch (_) {}
    save();
    return { ok: true, cleared, skipped };
  },
  addZone: (did, name, tower, geometry, activityId) => {
    let g = geometry;
    if (typeof g === 'string') {
      try {
        g = JSON.parse(g);
      } catch (_) {
        g = { kind: 'rect', x: 0, y: 0, w: 0, h: 0 };
      }
    }
    const bb = bboxFromGeom(g);
    const now = new Date().toISOString();
    const gj = JSON.stringify(g);
    run(
      'INSERT INTO zones (drawing_id,name,tower,x,y,w,h,geometry,activity_id,linked_activity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [did, name, tower, bb.x, bb.y, bb.w, bb.h, gj, activityId ?? null, null, now, now]
    );
    return { lastInsertRowid: get('SELECT last_insert_rowid() as id').id };
  },
  updateZone: (id, patch) => {
    const cur = get('SELECT * FROM zones WHERE id=?', [id]);
    if (!cur) return false;
    const name = patch.name != null ? patch.name : cur.name;
    const tower = patch.tower != null ? patch.tower : cur.tower;
    let g;
    if (patch.geometry != null) {
      g =
        typeof patch.geometry === 'string'
          ? JSON.parse(patch.geometry)
          : patch.geometry;
    } else {
      try {
        g = cur.geometry ? JSON.parse(cur.geometry) : null;
      } catch (_) {
        g = null;
      }
      if (!g || !g.kind)
        g = {
          kind: 'rect',
          x: Number(cur.x) || 0,
          y: Number(cur.y) || 0,
          w: Number(cur.w) || 0,
          h: Number(cur.h) || 0,
        };
    }
    const aid = patch.activity_id !== undefined ? patch.activity_id : cur.activity_id;
    const stid =
      patch.source_template_id !== undefined ? patch.source_template_id : cur.source_template_id;
    const stIdx =
      patch.programme_stage_idx !== undefined ? patch.programme_stage_idx : cur.programme_stage_idx;
    const anchor =
      patch.programme_anchor_date !== undefined
        ? patch.programme_anchor_date
        : cur.programme_anchor_date;
    const anchorActId =
      patch.programme_anchor_activity_id !== undefined
        ? patch.programme_anchor_activity_id
        : cur.programme_anchor_activity_id;
    const bb = bboxFromGeom(g);
    const now = new Date().toISOString();
    const oldTower = String(cur.tower || '');
    const oldName = String(cur.name || '');
    const newTower = String(tower || '');
    const newName = String(name || '');
    if (
      (patch.name != null && newName !== oldName) ||
      (patch.tower != null && newTower !== oldTower)
    ) {
      const dr = get('SELECT tab FROM drawings WHERE id=?', [cur.drawing_id]);
      const tabStr = dr && dr.tab != null ? String(dr.tab) : '';
      if (tabStr) {
        run(
          'UPDATE schedule SET tower=?, zone_name=? WHERE tab=? AND tower=? AND zone_name=?',
          [newTower, newName, tabStr, oldTower, oldName]
        );
      }
    }
    run(
      'UPDATE zones SET name=?, tower=?, x=?, y=?, w=?, h=?, geometry=?, activity_id=?, source_template_id=?, programme_stage_idx=?, programme_anchor_date=?, programme_anchor_activity_id=?, updated_at=? WHERE id=?',
      [
        name,
        tower,
        bb.x,
        bb.y,
        bb.w,
        bb.h,
        JSON.stringify(g),
        aid ?? null,
        stid != null ? stid : null,
        stIdx != null ? stIdx : null,
        anchor != null ? anchor : null,
        anchorActId != null ? Number(anchorActId) : null,
        now,
        id,
      ]
    );
    return true;
  },
  /** Module Handover stage for a module zone (free-text stage key; '' clears to default). */
  setZoneHandoverStage: (id, stage) => {
    const cur = get('SELECT id FROM zones WHERE id=?', [id]);
    if (!cur) return { error: 'not_found' };
    const s = stage == null ? null : String(stage).trim() || null;
    run('UPDATE zones SET handover_stage=?, updated_at=? WHERE id=?', [s, new Date().toISOString(), id]);
    return { ok: true };
  },
  deleteZone: (id) => {
    const nid = Number(id);
    if (!Number.isFinite(nid)) return;
    let inTx = false;
    try {
      runNoSave('BEGIN IMMEDIATE');
      inTx = true;
      const z = get('SELECT z.tower, z.name FROM zones z WHERE z.id=?', [nid]);
      if (!z) {
        runNoSave('ROLLBACK');
        inTx = false;
        return;
      }
      const tower = String(z.tower || '').trim();
      const zoneName = String(z.name || '').trim();
      // docs/SOURCE_OF_TRUTH.md §4.1 — zone delete must remove string-keyed completions for this tower|zone
      // so ticks cannot reattach to a recreated zone with the same name.
      const likePat = `${sqlLikeEscape(tower)}|${sqlLikeEscape(zoneName)}|%`;
      runNoSave("DELETE FROM completions WHERE key LIKE ? ESCAPE '\\'", [likePat]);

      const pis = all('SELECT * FROM programme_items WHERE zone_id=?', [nid]);
      const piIds = pis.map((pi) => Number(pi.id)).filter((id) => Number.isFinite(id));
      if (piIds.length) {
        // docs/SOURCE_OF_TRUTH.md §4.1 — remove dependency rows for this zone's programme items
        deleteDependenciesForProgrammeItemIds(piIds, { deferSave: true });
      }
      pis.forEach((pi) => shrinkScheduleForItem(pi, { deferSave: true }));
      runNoSave('DELETE FROM programme_items WHERE zone_id=?', [nid]);
      runNoSave('DELETE FROM zone_activities WHERE zone_id=?', [nid]);
      runNoSave('DELETE FROM zones WHERE id=?', [nid]);
      runNoSave('COMMIT');
      inTx = false;
      save();
    } catch (e) {
      if (inTx) {
        try {
          runNoSave('ROLLBACK');
        } catch (_) {}
      }
      throw e;
    }
  },
  setZoneActivities: (zoneId, items) => {
    const z = get('SELECT id FROM zones WHERE id=?', [zoneId]);
    if (!z) return false;
    run('DELETE FROM zone_activities WHERE zone_id=?', [zoneId]);
    (items || []).forEach((it, idx) => {
      const sid = it.activity_id != null ? Number(it.activity_id) : null;
      if (!sid) return;
      const ord = it.sequence_order != null ? Number(it.sequence_order) : idx;
      const dur = it.duration_days != null ? Number(it.duration_days) : 1;
      run(
        'INSERT INTO zone_activities (zone_id, activity_id, sequence_order, duration_days, start_date) VALUES (?,?,?,?,?)',
        [zoneId, sid, ord, Number.isFinite(dur) && dur > 0 ? dur : 1, it.start_date || null]
      );
    });
    save();
    return true;
  },
  addZoneActivity: (zoneId, activityId, opts) => {
    const z = get('SELECT id FROM zones WHERE id=?', [zoneId]);
    if (!z) return null;
    const aid = Number(activityId);
    const dup = get('SELECT id FROM zone_activities WHERE zone_id=? AND activity_id=?', [zoneId, aid]);
    if (dup) return { error: 'duplicate' };
    const maxRow = get(
      'SELECT COALESCE(MAX(sequence_order), -1) AS m FROM zone_activities WHERE zone_id=?',
      [zoneId]
    );
    const ord =
      opts && opts.sequence_order != null ? Number(opts.sequence_order) : Number(maxRow.m) + 1;
    const dur =
      opts && opts.duration_days != null ? Number(opts.duration_days) : 1;
    run(
      'INSERT INTO zone_activities (zone_id, activity_id, sequence_order, duration_days, start_date) VALUES (?,?,?,?,?)',
      [zoneId, aid, ord, Number.isFinite(dur) && dur > 0 ? dur : 1, (opts && opts.start_date) || null]
    );
    save();
    return { ok: true };
  },
  deleteZoneActivity: (zoneId, activityId) => {
    run('DELETE FROM zone_activities WHERE zone_id=? AND activity_id=?', [
      zoneId,
      Number(activityId),
    ]);
    save();
    return true;
  },
  getActivities: () => all('SELECT * FROM activities ORDER BY type, name'),
  getActivitiesByType: (type) => all('SELECT * FROM activities WHERE type=? ORDER BY name', [type]),
  addActivity: (name, type) => {
    const n = String(name || '').trim();
    const t = String(type || '').trim();
    if (!n || !t) return { error: 'name and type required' };
    const dup = get('SELECT id FROM activities WHERE lower(name)=lower(?)', [n]);
    if (dup) return { error: 'duplicate' };
    run('INSERT INTO activities (name,type) VALUES (?,?)', [n, t]);
    return { id: get('SELECT last_insert_rowid() as id').id };
  },
  renameActivity: (id, name) => {
    const aid = Number(id);
    const cur = get('SELECT * FROM activities WHERE id=?', [aid]);
    if (!cur) return { error: 'not_found' };
    const next = String(name || '').trim();
    if (!next) return { error: 'name_required' };
    const dup = get('SELECT id FROM activities WHERE lower(name)=lower(?) AND id<>?', [next, aid]);
    if (dup) return { error: 'duplicate' };
    run('UPDATE activities SET name=? WHERE id=?', [next, aid]);
    run('UPDATE schedule SET activity=? WHERE activity=?', [next, cur.name]);
    const templates = all('SELECT id, sequence FROM templates');
    for (const t of templates) {
      let seq = [];
      try { seq = JSON.parse(t.sequence || '[]'); } catch (_) {}
      if (!Array.isArray(seq) || !seq.length) continue;
      let changed = false;
      const nextSeq = seq.map((s) => {
        if (String(s).toLowerCase() === String(cur.name).toLowerCase()) {
          changed = true;
          return next;
        }
        return s;
      });
      if (changed) run('UPDATE templates SET sequence=? WHERE id=?', [JSON.stringify(nextSeq), t.id]);
    }
    save();
    return { ok: true };
  },
  deleteActivity: (id) => {
    const aid = Number(id);
    const cur = get('SELECT * FROM activities WHERE id=?', [aid]);
    if (!cur) return { error: 'not_found' };
    const useProgramme = get('SELECT COUNT(*) c FROM programme_items WHERE activity_id=?', [aid]);
    if (Number(useProgramme?.c || 0) > 0) return { error: 'in_use_programme' };
    const useZones = get('SELECT COUNT(*) c FROM zone_activities WHERE activity_id=?', [aid]);
    if (Number(useZones?.c || 0) > 0) return { error: 'in_use_zones' };
    const templates = all('SELECT id, sequence FROM templates');
    for (const t of templates) {
      let seq = [];
      try { seq = JSON.parse(t.sequence || '[]'); } catch (_) {}
      if (Array.isArray(seq) && seq.some((s) => String(s).toLowerCase() === String(cur.name).toLowerCase())) {
        return { error: 'in_use_templates' };
      }
    }
    run('DELETE FROM schedule WHERE activity=?', [cur.name]);
    run('DELETE FROM activities WHERE id=?', [aid]);
    save();
    return { ok: true };
  },
  getSchedule: (tab) => {
    const rows = all('SELECT date,tower,zone_name,activity FROM schedule WHERE tab=? ORDER BY date', [
      tab,
    ]);
    const r = {};
    rows.forEach((row) => {
      if (!r[row.date]) r[row.date] = {};
      if (!r[row.date][row.tower]) r[row.date][row.tower] = {};
      if (!r[row.date][row.tower][row.zone_name]) r[row.date][row.tower][row.zone_name] = [];
      r[row.date][row.tower][row.zone_name].push(row.activity);
    });
    return r;
  },
  addScheduleActivity: (tab, date, tw, zn, act) => {
    try {
      run('INSERT OR IGNORE INTO schedule (tab,date,tower,zone_name,activity) VALUES (?,?,?,?,?)', [
        tab,
        date,
        tw,
        zn,
        act,
      ]);
    } catch (e) {}
  },
  removeScheduleActivity: (tab, date, tw, zn, act) =>
    run('DELETE FROM schedule WHERE tab=? AND date=? AND tower=? AND zone_name=? AND activity=?', [
      tab,
      date,
      tw,
      zn,
      act,
    ]),
  setScheduleDay: (tab, date, data) => {
    run('DELETE FROM schedule WHERE tab=? AND date=?', [tab, date]);
    Object.entries(data).forEach(([tower, zones]) => {
      if (Array.isArray(zones))
        zones.forEach((act) => {
          try {
            run('INSERT INTO schedule (tab,date,tower,zone_name,activity) VALUES (?,?,?,?,?)', [
              tab,
              date,
              tower,
              '_default',
              act,
            ]);
          } catch (e) {}
        });
      else
        Object.entries(zones).forEach(([zone, acts]) =>
          acts.forEach((act) => {
            try {
              run('INSERT INTO schedule (tab,date,tower,zone_name,activity) VALUES (?,?,?,?,?)', [
                tab,
                date,
                tower,
                zone,
                act,
              ]);
            } catch (e) {}
          })
        );
    });
  },
  /** Allow completion tick if a programme_item spans dateStr and matches tower/zone/activity (user tabs). */
  completionKeyAllowedOnPlan: (dateStr, key, allowedTabs) => {
    const p = parseCompletionKeyParts(key);
    if (!p || !p.tower || !p.activity) return false;
    const tabs = (allowedTabs || []).filter(Boolean);
    if (!tabs.length) return false;
    const ph = tabs.map(() => '?').join(',');
    const d1 = String(dateStr || '').trim();
    if (p.zone === '_default') {
      const row = get(
        `SELECT pi.id FROM programme_items pi
         JOIN zones z ON z.id = pi.zone_id
         JOIN drawings d ON d.id = z.drawing_id
         JOIN activities a ON a.id = pi.activity_id
         WHERE pi.start_date <= ? AND pi.end_date >= ?
         AND d.tab IN (${ph})
         AND TRIM(IFNULL(z.tower,'')) = TRIM(?)
         AND TRIM(IFNULL(a.name,'')) = TRIM(?)`,
        [d1, d1, ...tabs, p.tower, p.activity]
      );
      return !!row;
    }
    const row = get(
      `SELECT pi.id FROM programme_items pi
       JOIN zones z ON z.id = pi.zone_id
       JOIN drawings d ON d.id = z.drawing_id
       JOIN activities a ON a.id = pi.activity_id
       WHERE pi.start_date <= ? AND pi.end_date >= ?
       AND d.tab IN (${ph})
       AND TRIM(IFNULL(z.tower,'')) = TRIM(?)
       AND TRIM(IFNULL(z.name,'')) = TRIM(?)
       AND TRIM(IFNULL(a.name,'')) = TRIM(?)`,
      [d1, d1, ...tabs, p.tower, p.zone, p.activity]
    );
    return !!row;
  },
  getCompletions: () => {
    const rows = all('SELECT * FROM completions ORDER BY date');
    const r = {};
    rows.forEach((row) => {
      if (!r[row.date]) r[row.date] = {};
      r[row.date][row.key] = { by: row.completed_by, at: row.completed_at };
    });
    return r;
  },
  getCompletion: (d, k) => get('SELECT * FROM completions WHERE date=? AND key=?', [d, k]),
  addCompletion: (d, k, by) => {
    const now = new Date();
    run('INSERT INTO completions (date,key,completed_by,completed_at) VALUES (?,?,?,?)', [
      d,
      k,
      by,
      now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0'),
    ]);
  },
  deleteCompletion: (d, k) => run('DELETE FROM completions WHERE date=? AND key=?', [d, k]),
  getMilestones: () => all('SELECT * FROM milestones ORDER BY date'),
  /** Milestones with completion_pct reflecting live Update ticks when linked to programme_items.id */
  getMilestonesEnriched: () => {
    const milestones = all('SELECT * FROM milestones ORDER BY date');
    const completionsRows = all('SELECT date, key FROM completions');
    const compMap = {};
    completionsRows.forEach((r) => {
      if (!compMap[r.date]) compMap[r.date] = {};
      compMap[r.date][r.key] = true;
    });
    return milestones.map((m) => enrichMilestoneRow(m, compMap));
  },
  addMilestone: (d, l, s, pct, programmeItemId) => {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    let pid = null;
    if (programmeItemId != null && programmeItemId !== '') {
      const n = Number(programmeItemId);
      if (Number.isFinite(n)) pid = n;
    }
    run('INSERT INTO milestones (date,label,status,completion_pct,programme_item_id) VALUES (?,?,?,?,?)', [
      d,
      l,
      s || 'planned',
      p,
      pid,
    ]);
    return get('SELECT last_insert_rowid() AS id').id;
  },
  updateMilestone: (id, patch) => {
    const row = get('SELECT * FROM milestones WHERE id=?', [id]);
    if (!row) return false;
    const date = patch.date != null ? patch.date : row.date;
    const label = patch.label != null ? patch.label : row.label;
    const status = patch.status != null ? patch.status : row.status;
    let programmeItemId =
      row.programme_item_id != null && row.programme_item_id !== ''
        ? Number(row.programme_item_id)
        : null;
    if (!Number.isFinite(programmeItemId)) programmeItemId = null;
    if (patch.programme_item_id !== undefined) {
      if (patch.programme_item_id === null || patch.programme_item_id === '') programmeItemId = null;
      else {
        const n = Number(patch.programme_item_id);
        programmeItemId = Number.isFinite(n) ? n : programmeItemId;
      }
    }
    let completionPct =
      row.completion_pct != null && row.completion_pct !== '' ? Number(row.completion_pct) : 0;
    if (!Number.isFinite(completionPct)) completionPct = 0;
    if (patch.completion_pct != null && programmeItemId == null) {
      completionPct = Math.max(0, Math.min(100, Math.round(Number(patch.completion_pct))));
    }
    run(
      'UPDATE milestones SET date=?, label=?, status=?, completion_pct=?, programme_item_id=? WHERE id=?',
      [date, label, status, completionPct, programmeItemId, id]
    );
    return true;
  },
  deleteMilestone: (id) => run('DELETE FROM milestones WHERE id=?', [id]),
  /** One row per unique template content (avoids duplicate list entries if the same template was inserted twice). */
  getTemplates: () =>
    all(
      `SELECT t.*
       FROM templates t
       INNER JOIN (
         SELECT MIN(id) AS keep_id
         FROM templates
         GROUP BY name, tab, tower, zone_name, sequence, durations
       ) u ON t.id = u.keep_id
       ORDER BY t.id`
    ),
  addTemplate: (n, tab, tw, zn, seq, dur) => {
    run('INSERT INTO templates (name,tab,tower,zone_name,sequence,durations) VALUES (?,?,?,?,?,?)', [
      n,
      tab,
      tw,
      zn,
      seq,
      dur,
    ]);
    return { lastInsertRowid: get('SELECT last_insert_rowid() as id').id };
  },
  getTemplateById: (id) => get('SELECT * FROM templates WHERE id=?', [id]),
  updateTemplate: (id, patch) => {
    const cur = get('SELECT * FROM templates WHERE id=?', [id]);
    if (!cur) return false;
    const name = patch.name != null ? patch.name : cur.name;
    const tab = patch.tab != null ? patch.tab : cur.tab;
    const tower = patch.tower != null ? patch.tower : cur.tower;
    const zone_name = patch.zone_name != null ? patch.zone_name : cur.zone_name;
    let seq = cur.sequence;
    let dur = cur.durations;
    if (patch.sequence != null)
      seq = typeof patch.sequence === 'string' ? patch.sequence : JSON.stringify(patch.sequence);
    if (patch.durations != null)
      dur = typeof patch.durations === 'string' ? patch.durations : JSON.stringify(patch.durations);
    run('UPDATE templates SET name=?, tab=?, tower=?, zone_name=?, sequence=?, durations=? WHERE id=?', [
      name,
      tab,
      tower,
      zone_name,
      seq,
      dur,
      id,
    ]);
    return true;
  },
  deleteTemplate: (id) => {
    run('UPDATE zones SET source_template_id=NULL WHERE source_template_id=?', [id]);
    run('DELETE FROM templates WHERE id=?', [id]);
  },
  /** Rebuild planned/active programme rows from updated template for zones linked via source_template_id. */
  syncProgrammesForTemplate: (templateId) => {
    const tpl = get('SELECT * FROM templates WHERE id=?', [templateId]);
    if (!tpl) return { zones: 0, items: 0 };
    let seq = [];
    let dur = [];
    try {
      seq = JSON.parse(tpl.sequence || '[]');
    } catch (_) {}
    try {
      dur = JSON.parse(tpl.durations || '[]');
    } catch (_) {}
    if (!Array.isArray(seq) || seq.length === 0) return { zones: 0, items: 0 };

    const actRows = all('SELECT id, name FROM activities');
    const activityLookup = schedule.buildActivityLookup(actRows);

    const linked = all('SELECT * FROM zones WHERE source_template_id=?', [templateId]);
    let itemsInserted = 0;

    for (const z of linked) {
      const items = all(
        'SELECT * FROM programme_items WHERE zone_id=? ORDER BY start_date',
        [z.id]
      );
      const doneItems = items.filter((i) => i.status === 'done');

      for (const it of items) {
        if (it.status === 'done') continue;
        const old = get('SELECT * FROM programme_items WHERE id=?', [it.id]);
        if (old) shrinkScheduleForItem(old);
        run('DELETE FROM programme_items WHERE id=?', [it.id]);
      }

      let k =
        z.programme_stage_idx != null && z.programme_stage_idx !== ''
          ? Number(z.programme_stage_idx)
          : 0;
      let anchor =
        z.programme_anchor_date && String(z.programme_anchor_date).trim()
          ? String(z.programme_anchor_date).trim()
          : schedule.todayKey();

      if (doneItems.length > 0) {
        let lastIdx = -1;
        let lastEnd = null;
        for (let ti = 0; ti < seq.length; ti++) {
          const aid = schedule.resolveActivityId(activityLookup, seq[ti]);
          if (aid == null) continue;
          const di = doneItems.find((d) => Number(d.activity_id) === Number(aid));
          if (di && ti > lastIdx) {
            lastIdx = ti;
            lastEnd = di.end_date;
          }
        }
        if (lastIdx >= 0 && lastEnd) {
          k = lastIdx + 1;
          anchor = schedule.nextWorkingDayAfter(lastEnd);
        }
      }

      if (k >= seq.length) continue;

      const rows = schedule.buildRowsFromTemplate({
        sequence: seq,
        durations: dur,
        startStageIndex: k,
        startDateKey: anchor,
        activityLookup,
      });

      const toInsert =
        doneItems.length > 0 ? rows.filter((r) => r && r.idx >= k) : rows.filter(Boolean);

      for (const row of toInsert) {
        if (!row.activity_id) continue;
        const { start_date: sd, end_date: ed } = clampProgrammeItemDates(row.start_date, row.end_date);
        run(
          'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes) VALUES (?,?,?,?,?,?)',
          [z.id, row.activity_id, sd, ed, row.status || 'planned', '']
        );
        const nid = get('SELECT last_insert_rowid() as id').id;
        const pi = get('SELECT * FROM programme_items WHERE id=?', [nid]);
        expandScheduleForItem(pi);
        itemsInserted++;
      }
    }

    save();
    return { zones: linked.length, items: itemsInserted };
  },
  applyTemplate: (tab, tw, zn, seq, dur, start) => {
    const acts = JSON.parse(seq),
      durs = JSON.parse(dur);
    const tabS = String(tab ?? '');
    const twS = String(tw ?? '');
    const znS = String(zn ?? '');
    // docs/SOURCE_OF_TRUTH.md §4.2 — deterministic apply: clear prior schedule for this tab/tower/zone, then insert
    // without duplicate (tab,date,tower,zone_name,activity) rows (schedule UNIQUE).
    runNoSave('DELETE FROM schedule WHERE tab=? AND tower=? AND zone_name=?', [tabS, twS, znS]);
    let d = new Date(start + 'T00:00:00');
    acts.forEach((act, i) => {
      const units = Math.max(1, Math.round((Number(durs[i]) || 1) * 2));
      let halfStep = 0;
      // schedule UNIQUE is one row per (tab,date,tower,zone_name,activity). Two half-day units can
      // land on the same calendar day before the cursor advances — insert once per day for this act.
      const daysInserted = new Set();
      for (let x = 0; x < units; x++) {
        while (pw.isNonWorkingPlanDayKey(pw.dateKeyFromDate(d))) d.setDate(d.getDate() + 1);
        const dk =
          d.getFullYear() +
          '-' +
          String(d.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(d.getDate()).padStart(2, '0');
        if (!daysInserted.has(dk)) {
          runNoSave('INSERT INTO schedule (tab,date,tower,zone_name,activity) VALUES (?,?,?,?,?)', [
            tabS,
            dk,
            twS,
            znS,
            act,
          ]);
          daysInserted.add(dk);
        }
        halfStep++;
        if (halfStep === 2) {
          halfStep = 0;
          d.setDate(d.getDate() + 1);
        }
      }
      if (halfStep === 1) d.setDate(d.getDate() + 1);
      while (pw.isNonWorkingPlanDayKey(pw.dateKeyFromDate(d))) d.setDate(d.getDate() + 1);
    });
    save();
  },
  /** All programme rows with zone + drawing tab for PLAN view and exports. Pass scope tabs or null for no filter. */
  getPlanProgrammeRows: (tabs) => {
    const base = `SELECT pi.id, pi.zone_id, pi.activity_id, pi.start_date, pi.end_date, pi.status, pi.notes, pi.shift,
              z.name AS zone_name, z.tower, z.drawing_id,
              d.tab AS drawing_tab, d.name AS drawing_name, d.floor AS drawing_floor,
              a.name AS activity_name, a.type AS activity_type
       FROM programme_items pi
       JOIN zones z ON z.id = pi.zone_id
       JOIN drawings d ON d.id = z.drawing_id
       JOIN activities a ON a.id = pi.activity_id`;
    const order = ` ORDER BY d.tab, z.tower, z.name, pi.start_date`;
    if (tabs && tabs.length) {
      const drawingTabs = new Set();
      for (const t of tabs) {
        const s = String(t || '').trim();
        if (!s || s === 'module_handover') continue;
        if (s === 'module_programme') drawingTabs.add('module_handover');
        else drawingTabs.add(s);
      }
      const list = [...drawingTabs];
      if (!list.length) return [];
      return all(`${base} WHERE d.tab IN (${list.map(() => '?').join(',')})${order}`, list);
    }
    return all(base + order);
  },
  getProgrammeItemsByDrawing: (drawingId) =>
    all(
      `SELECT pi.*, z.name AS zone_name, z.tower, z.drawing_id, a.name AS activity_name, a.type AS activity_type
       FROM programme_items pi
       JOIN zones z ON z.id = pi.zone_id
       JOIN activities a ON a.id = pi.activity_id
       WHERE z.drawing_id = ?
       ORDER BY pi.start_date, z.name`,
      [drawingId]
    ),
  getProgrammeItemsByZone: (zoneId) =>
    all(
      `SELECT pi.*, a.name AS activity_name, a.type AS activity_type
       FROM programme_items pi
       JOIN activities a ON a.id = pi.activity_id
       WHERE pi.zone_id = ?
       ORDER BY pi.start_date`,
      [zoneId]
    ),
  getProgrammeItemById: (id) => get('SELECT * FROM programme_items WHERE id=?', [id]),
  addProgrammeItem: (zone_id, activity_id, start_date, end_date, status, notes, shift) => {
    const { start_date: sd, end_date: ed } = clampProgrammeItemDates(start_date, end_date);
    const shiftRaw = shift != null ? shift : 'day';
    const shiftVal = String(shiftRaw).trim().toLowerCase() === 'night' ? 'night' : 'day';
    run(
      'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes,shift) VALUES (?,?,?,?,?,?,?)',
      [zone_id, activity_id, sd, ed, status || 'planned', notes || '', shiftVal]
    );
    const id = get('SELECT last_insert_rowid() as id').id;
    const pi = get('SELECT * FROM programme_items WHERE id=?', [id]);
    expandScheduleForItem(pi);
    return { lastInsertRowid: id };
  },
  updateProgrammeItem: (id, patch) => {
    const old = get('SELECT * FROM programme_items WHERE id=?', [id]);
    if (!old) return null;
    const start_date = patch.start_date != null ? patch.start_date : old.start_date;
    const violation = checkDependencyViolationForEarlierStart(
      'programme_item',
      id,
      start_date,
      old.start_date
    );
    if (violation) return violation;
    shrinkScheduleForItem(old);
    const zone_id = patch.zone_id != null ? patch.zone_id : old.zone_id;
    const activity_id = patch.activity_id != null ? patch.activity_id : old.activity_id;
    const end_date = patch.end_date != null ? patch.end_date : old.end_date;
    const status = patch.status != null ? patch.status : old.status;
    const notes = patch.notes !== undefined ? patch.notes : old.notes;
    const shiftRaw = patch.shift != null ? patch.shift : old.shift || 'day';
    const shift = String(shiftRaw).trim().toLowerCase();
    if (shift !== 'day' && shift !== 'night') return { error: 'shift must be day or night' };
    const { start_date: sd, end_date: ed } = clampProgrammeItemDates(start_date, end_date);
    run(
      'UPDATE programme_items SET zone_id=?, activity_id=?, start_date=?, end_date=?, status=?, notes=?, shift=? WHERE id=?',
      [zone_id, activity_id, sd, ed, status, notes || '', shift, id]
    );
    const neu = get('SELECT * FROM programme_items WHERE id=?', [id]);
    expandScheduleForItem(neu);
    return true;
  },
  deleteProgrammeItem: (id) => {
    const old = get('SELECT * FROM programme_items WHERE id=?', [id]);
    if (old) shrinkScheduleForItem(old);
    run('DELETE FROM programme_items WHERE id=?', [id]);
  },
  replaceZoneProgrammeItems: (zoneId, rows) => {
    const zid = Number(zoneId);
    const zone = get('SELECT * FROM zones WHERE id=?', [zid]);
    if (!zone) return { error: 'Zone not found' };
    const old = all('SELECT * FROM programme_items WHERE zone_id=?', [zid]);
    const oldByAct = new Map();
    for (const it of old) oldByAct.set(Number(it.activity_id), it);

    for (const r of rows || []) {
      const prev = oldByAct.get(Number(r.activity_id));
      if (!prev) continue;
      const { start_date: sd } = clampProgrammeItemDates(r.start_date, r.end_date);
      const violation = checkDependencyViolationForEarlierStart(
        'programme_item',
        prev.id,
        sd,
        prev.start_date
      );
      if (violation) return violation;
    }

    let inTx = false;
    try {
      runNoSave('BEGIN IMMEDIATE');
      inTx = true;
      old.forEach((it) => {
        shrinkScheduleForItem(it, { deferSave: true });
        runNoSave('DELETE FROM programme_items WHERE id=?', [it.id]);
      });
      const inserted = [];
      for (const r of rows || []) {
        const { start_date: sd, end_date: ed } = clampProgrammeItemDates(r.start_date, r.end_date);
        const shiftRaw = r.shift != null ? r.shift : 'day';
        const shift = String(shiftRaw).trim().toLowerCase() === 'night' ? 'night' : 'day';
        runNoSave(
          'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes,shift) VALUES (?,?,?,?,?,?,?)',
          [
            zid,
            Number(r.activity_id),
            sd,
            ed,
            r.status || 'planned',
            r.notes || '',
            shift,
          ]
        );
        const nid = get('SELECT last_insert_rowid() as id').id;
        const pi = get('SELECT * FROM programme_items WHERE id=?', [nid]);
        if (pi) {
          expandScheduleForItem(pi, { deferSave: true });
          inserted.push(pi);
        }
      }
      remapZoneProgrammeItemDependencies(old, inserted);
      runNoSave('COMMIT');
      inTx = false;
      save();
      return { ok: true };
    } catch (e) {
      if (inTx) {
        try {
          runNoSave('ROLLBACK');
        } catch (_) {}
      }
      throw e;
    }
  },
  restoreZoneSnapshot: (snapshot) => {
    if (!snapshot || !snapshot.zone) return { error: 'Invalid snapshot' };
    const z = snapshot.zone;
    const zid = Number(z.id);
    const exists = get('SELECT id FROM zones WHERE id=?', [zid]);
    if (exists) return { error: 'Zone id already exists' };
    run(
      'INSERT INTO zones (id,drawing_id,name,tower,x,y,w,h,geometry,activity_id,linked_activity,created_at,updated_at,source_template_id,programme_stage_idx,programme_anchor_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        zid,
        Number(z.drawing_id),
        z.name,
        z.tower,
        Number(z.x) || 0,
        Number(z.y) || 0,
        Number(z.w) || 0,
        Number(z.h) || 0,
        z.geometry || null,
        z.activity_id != null ? Number(z.activity_id) : null,
        z.linked_activity || null,
        z.created_at || new Date().toISOString(),
        new Date().toISOString(),
        z.source_template_id != null ? Number(z.source_template_id) : null,
        z.programme_stage_idx != null ? Number(z.programme_stage_idx) : null,
        z.programme_anchor_date || null,
      ]
    );
    const acts = Array.isArray(snapshot.zone_activities) ? snapshot.zone_activities : [];
    for (const a of acts) {
      run(
        'INSERT INTO zone_activities (zone_id, activity_id, sequence_order, duration_days, start_date) VALUES (?,?,?,?,?)',
        [
          zid,
          Number(a.activity_id),
          Number(a.sequence_order) || 0,
          Number(a.duration_days) || 1,
          a.start_date || null,
        ]
      );
    }
    const items = Array.isArray(snapshot.programme_items) ? snapshot.programme_items : [];
    for (const it of items) {
      const { start_date: sd, end_date: ed } = clampProgrammeItemDates(it.start_date, it.end_date);
      run(
        'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes) VALUES (?,?,?,?,?,?)',
        [
          zid,
          Number(it.activity_id),
          sd,
          ed,
          it.status || 'planned',
          it.notes || '',
        ]
      );
      const nid = get('SELECT last_insert_rowid() as id').id;
      const pi = get('SELECT * FROM programme_items WHERE id=?', [nid]);
      expandScheduleForItem(pi);
    }
    save();
    return { ok: true };
  },
  /**
   * Replace zone programme from template, anchoring one activity's finish date (weekday).
   * @param {number|null|undefined} templateIdOpt — defaults to zone.source_template_id
   */
  scheduleFromTargetDate: (zoneId, anchorActivityId, anchorDateKey, templateIdOpt, zoneMetaOpt) => {
    const zid = Number(zoneId);
    const zone = get('SELECT * FROM zones WHERE id=?', [zid]);
    if (!zone) return { error: 'Zone not found' };

    const tid =
      templateIdOpt != null && templateIdOpt !== ''
        ? Number(templateIdOpt)
        : zone.source_template_id != null
          ? Number(zone.source_template_id)
          : null;
    if (!tid) {
      return {
        error: 'No template — select a template on Programme or link this zone to a saved template.',
      };
    }

    const tpl = get('SELECT * FROM templates WHERE id=?', [tid]);
    if (!tpl) return { error: 'Template not found' };

    let seq = [];
    let dur = [];
    try {
      seq = JSON.parse(tpl.sequence || '[]');
    } catch (_) {}
    try {
      dur = JSON.parse(tpl.durations || '[]');
    } catch (_) {}
    if (!Array.isArray(seq) || seq.length === 0) return { error: 'Template has no sequence' };

    const actRows = all('SELECT id, name FROM activities');
    const activityLookup = schedule.buildActivityLookup(actRows);

    const wantId = Number(anchorActivityId);
    let k = -1;
    for (let i = 0; i < seq.length; i++) {
      const aid = schedule.resolveActivityId(activityLookup, seq[i]);
      if (aid != null && Number(aid) === wantId) {
        k = i;
        break;
      }
    }
    if (k < 0) return { error: 'Selected activity is not in this template sequence' };

    const rows = schedule.buildRowsFromTargetEndDate({
      sequence: seq,
      durations: dur,
      anchorIndex: k,
      anchorEndDateKey: String(anchorDateKey || '').trim(),
      activityLookup,
    });
    if (!rows.length) return { error: 'Could not compute schedule — check anchor date' };
    if (rows.some((r) => !r.activity_id)) {
      return { error: 'Unknown activity name in template — add matching activities in the database' };
    }

    const existing = all('SELECT * FROM programme_items WHERE zone_id=?', [zid]);
    deleteDependenciesForProgrammeItemIds(existing.map((pi) => pi.id));
    for (const it of existing) {
      shrinkScheduleForItem(it);
      run('DELETE FROM programme_items WHERE id=?', [it.id]);
    }

    const newItems = [];
    for (const row of rows) {
      if (!row || row.start_date == null || row.end_date == null) continue;
      const { start_date: sd, end_date: ed } = clampProgrammeItemDates(row.start_date, row.end_date);
      run(
        'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes) VALUES (?,?,?,?,?,?)',
        [zid, row.activity_id, sd, ed, row.status || 'planned', row.notes || '']
      );
      const nid = get('SELECT last_insert_rowid() as id').id;
      const pi = get('SELECT * FROM programme_items WHERE id=?', [nid]);
      if (pi) {
        expandScheduleForItem(pi);
        newItems.push(pi);
      }
    }

    if (!newItems.length) return { error: 'Could not store programme rows — check anchor date' };

    newItems.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

    const anchorMetadataWarning =
      'Programme saved — anchor metadata could not be updated.';

    const buildSuccessPayload = () => {
      const activities = rows
        .filter((r) => r && r.start_date != null && r.end_date != null)
        .map((r) => ({
          idx: r.idx,
          activity_id: r.activity_id,
          activity_name: r.activity_name,
          start_date: r.start_date,
          end_date: r.end_date,
          status: r.status,
        }));
      const datedStart = rows.filter((r) => r && r.start_date != null);
      const datedEnd = rows.filter((r) => r && r.end_date != null);
      const firstRow = datedStart[0] || newItems[0];
      const lastRow = datedEnd.length ? datedEnd[datedEnd.length - 1] : newItems[newItems.length - 1];
      return {
        ok: true,
        activities,
        zone_start: firstRow?.start_date || null,
        zone_finish: lastRow?.end_date || null,
      };
    };

    const anchorRow = rows.find((r) => r && Number(r.idx) === k) || rows[k];
    if (!anchorRow || !anchorRow.start_date) {
      console.error('[119HS] anchor metadata skipped for zone', zid, '- no dated anchor row at stage', k);
      return {
        ...buildSuccessPayload(),
        anchor_metadata_warning: anchorMetadataWarning,
      };
    }

    // Coerce every bound value to a concrete type — sql.js throws if any param is
    // undefined/NaN, which previously surfaced as a spurious "anchor metadata" warning.
    const smi = Number(zoneMetaOpt?.programme_stage_idx);
    const storedStageIdx = Number.isFinite(smi) ? smi : k;
    let storedAnchorDate = anchorRow.start_date;
    if (zoneMetaOpt?.programme_anchor_date != null && String(zoneMetaOpt.programme_anchor_date).trim()) {
      const norm = pw.normalizeScheduleStartKey(String(zoneMetaOpt.programme_anchor_date).trim());
      if (norm) storedAnchorDate = norm;
    }
    const ami = Number(zoneMetaOpt?.programme_anchor_activity_id);
    const aaid = Number(anchorActivityId);
    const storedAnchorActId = Number.isFinite(ami) ? ami : Number.isFinite(aaid) ? aaid : null;

    try {
      const now = new Date().toISOString();
      run(
        'UPDATE zones SET source_template_id=?, programme_stage_idx=?, programme_anchor_date=?, programme_anchor_activity_id=?, updated_at=? WHERE id=?',
        [tid, storedStageIdx, storedAnchorDate, storedAnchorActId, now, zid]
      );
      save();
    } catch (e) {
      console.error('[119HS] anchor metadata update failed for zone', zid, '-', e && e.message ? e.message : e);
      return {
        ...buildSuccessPayload(),
        anchor_metadata_warning: anchorMetadataWarning,
      };
    }

    return buildSuccessPayload();
  },
  /** Admin one-shot: rebuild programme_items for every zone with template + anchor metadata (§4.2). */
  resequenceAllZones: () => {
    const zones = all(
      `SELECT * FROM zones
       WHERE source_template_id IS NOT NULL
         AND programme_anchor_date IS NOT NULL
         AND TRIM(programme_anchor_date) <> ''`
    );
    const skipped = all(
      `SELECT DISTINCT z.id, z.tower, z.name
       FROM zones z
       INNER JOIN programme_items pi ON pi.zone_id = z.id
       WHERE z.source_template_id IS NULL
          OR z.programme_anchor_date IS NULL
          OR TRIM(z.programme_anchor_date) = ''
       ORDER BY z.tower, z.name, z.id`
    ).map((z) => ({
      zone_id: Number(z.id),
      label: `${z.tower || ''} ${z.name || ''}`.trim() || `Zone ${z.id}`,
      reason: 'skipped — no anchor set',
    }));
    const actRows = all('SELECT id, name FROM activities');
    const activityLookup = schedule.buildActivityLookup(actRows);
    let count = 0;
    const errors = [];

    for (const z of zones) {
      const tid = Number(z.source_template_id);
      const tpl = get('SELECT * FROM templates WHERE id=?', [tid]);
      if (!tpl) {
        errors.push({
          zone_id: Number(z.id),
          label: `${z.tower || ''} ${z.name || ''}`.trim(),
          error: 'Template not found',
        });
        continue;
      }
      let seq = [];
      let dur = [];
      try {
        seq = JSON.parse(tpl.sequence || '[]');
      } catch (_) {}
      try {
        dur = JSON.parse(tpl.durations || '[]');
      } catch (_) {}
      let stageIdx =
        z.programme_stage_idx != null && z.programme_stage_idx !== ''
          ? Number(z.programme_stage_idx)
          : 0;
      if (z.programme_anchor_activity_id != null && z.programme_anchor_activity_id !== '') {
        const wantAct = Number(z.programme_anchor_activity_id);
        for (let i = 0; i < seq.length; i++) {
          if (schedule.resolveActivityId(activityLookup, seq[i]) === wantAct) {
            stageIdx = i;
            break;
          }
        }
      }
      const { anchorActivityId, anchorEndDateKey } = schedule.targetEndParamsFromStartStage({
        sequence: seq,
        durations: dur,
        startStageIndex: stageIdx,
        startDateKey: z.programme_anchor_date,
        activityLookup,
      });
      if (!anchorActivityId || !anchorEndDateKey) {
        errors.push({
          zone_id: Number(z.id),
          label: `${z.tower || ''} ${z.name || ''}`.trim(),
          error: 'Could not resolve anchor activity or date',
        });
        continue;
      }
      const out = module.exports.scheduleFromTargetDate(
        z.id,
        anchorActivityId,
        anchorEndDateKey,
        tid
      );
      if (!out || out.error) {
        const errMsg = out?.error || 'skipped — schedule failed';
        console.error('[119HS] resequence-all-zones zone failed', {
          zone_id: Number(z.id),
          label: `${z.tower || ''} ${z.name || ''}`.trim() || `Zone ${z.id}`,
          template_id: tid,
          stage_idx: stageIdx,
          anchor_date: z.programme_anchor_date,
          error: errMsg,
        });
        skipped.push({
          zone_id: Number(z.id),
          label: `${z.tower || ''} ${z.name || ''}`.trim() || `Zone ${z.id}`,
          reason: errMsg,
          error: errMsg,
        });
        continue;
      }
      count += 1;
    }

    return { ok: true, count, total: zones.length, errors, skipped, skipped_count: skipped.length };
  },
  /** Admin bulk-set zone anchor metadata for resequence (§4.2). */
  setZoneAnchors: (entries) => {
    if (!Array.isArray(entries)) return { error: 'entries array required' };
    const actRows = all('SELECT id, name FROM activities');
    const activityLookup = schedule.buildActivityLookup(actRows);
    let updated = 0;
    const errors = [];

    for (const e of entries) {
      const zid = Number(e?.zone_id);
      const tid = Number(e?.template_id);
      const aid = Number(e?.anchor_activity_id);
      const anchorDateRaw = String(e?.anchor_date || '').trim();
      if (
        !Number.isFinite(zid) ||
        !Number.isFinite(tid) ||
        !Number.isFinite(aid) ||
        !anchorDateRaw
      ) {
        errors.push({
          zone_id: Number.isFinite(zid) ? zid : null,
          error: 'Missing zone_id, template_id, anchor_activity_id, or anchor_date',
        });
        continue;
      }

      const zone = get('SELECT * FROM zones WHERE id=?', [zid]);
      if (!zone) {
        errors.push({ zone_id: zid, error: 'Zone not found' });
        continue;
      }

      const tpl = get('SELECT * FROM templates WHERE id=?', [tid]);
      if (!tpl) {
        errors.push({ zone_id: zid, error: 'Template not found' });
        continue;
      }

      let seq = [];
      try {
        seq = JSON.parse(tpl.sequence || '[]');
      } catch (_) {}
      if (!Array.isArray(seq) || !seq.length) {
        errors.push({ zone_id: zid, error: 'Template has no sequence' });
        continue;
      }

      let stageIdx = 0;
      let found = false;
      for (let i = 0; i < seq.length; i++) {
        if (schedule.resolveActivityId(activityLookup, seq[i]) === aid) {
          stageIdx = i;
          found = true;
          break;
        }
      }
      if (!found) {
        errors.push({ zone_id: zid, error: 'anchor_activity_id not in template sequence' });
        continue;
      }

      const normDate = pw.normalizeScheduleStartKey(anchorDateRaw);
      const now = new Date().toISOString();
      run(
        'UPDATE zones SET source_template_id=?, programme_stage_idx=?, programme_anchor_date=?, programme_anchor_activity_id=?, updated_at=? WHERE id=?',
        [tid, stageIdx, normDate, aid, now, zid]
      );
      updated += 1;
    }

    save();
    return { ok: true, updated, errors };
  },
  /** Full regenerate from template stage 0. Fails if zone has any programme row with status done. */
  resetZoneProgrammeToTemplateStart: (zoneId, startDateKey) => {
    const zid = Number(zoneId);
    const zone = get('SELECT * FROM zones WHERE id=?', [zid]);
    if (!zone) return { error: 'Zone not found' };
    const tid = zone.source_template_id != null ? Number(zone.source_template_id) : null;
    if (!tid) return { error: 'Zone has no linked template — set template on Programme first.' };
    const tpl = get('SELECT * FROM templates WHERE id=?', [tid]);
    if (!tpl) return { error: 'Template not found' };

    let seq = [];
    let dur = [];
    try {
      seq = JSON.parse(tpl.sequence || '[]');
    } catch (_) {}
    try {
      dur = JSON.parse(tpl.durations || '[]');
    } catch (_) {}
    if (!Array.isArray(seq) || seq.length === 0) return { error: 'Template has no sequence' };

    const existing = all('SELECT * FROM programme_items WHERE zone_id=?', [zid]);
    const done = existing.filter((i) => String(i.status || '').toLowerCase() === 'done');
    if (done.length) {
      return {
        error: `Zone has ${done.length} completed programme row(s). Clear completions first, or use shift / activity commands.`,
      };
    }

    const actRows = all('SELECT id, name FROM activities');
    const activityLookup = schedule.buildActivityLookup(actRows);

    const rows = schedule
      .buildRowsFromTemplate({
        sequence: seq,
        durations: dur,
        startStageIndex: 0,
        startDateKey: String(startDateKey || '').trim(),
        activityLookup,
      })
      .filter(Boolean);
    if (!rows.length) return { error: 'Could not build programme from that start date' };
    if (rows.some((r) => !r.activity_id)) {
      return { error: 'Unknown activity name in template — fix activities list' };
    }

    for (const it of existing) {
      shrinkScheduleForItem(it);
      run('DELETE FROM programme_items WHERE id=?', [it.id]);
    }

    for (const row of rows) {
      const { start_date: sd, end_date: ed } = clampProgrammeItemDates(row.start_date, row.end_date);
      run(
        'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes) VALUES (?,?,?,?,?,?)',
        [zid, row.activity_id, sd, ed, row.status || 'planned', row.notes || '']
      );
      const nid = get('SELECT last_insert_rowid() as id').id;
      const pi = get('SELECT * FROM programme_items WHERE id=?', [nid]);
      expandScheduleForItem(pi);
    }

    const now = new Date().toISOString();
    run(
      'UPDATE zones SET source_template_id=?, programme_stage_idx=?, programme_anchor_date=?, updated_at=? WHERE id=?',
      [tid, 0, rows[0].start_date, now, zid]
    );
    save();

    return {
      activities: rows.map((r) => ({
        activity_name: r.activity_name,
        start_date: r.start_date,
        end_date: r.end_date,
        status: r.status,
      })),
      zone_start: rows[0].start_date,
      zone_finish: rows[rows.length - 1].end_date,
    };
  },
  getProjectProgrammeItems: () =>
    all('SELECT * FROM project_programme_items ORDER BY wbs, id'),
  confirmProjectProgrammeImport: (tasks) => {
    if (!Array.isArray(tasks) || !tasks.length) {
      return { error: 'At least one task required' };
    }
    let inTx = false;
    try {
      runNoSave('BEGIN IMMEDIATE');
      inTx = true;
      runNoSave('DELETE FROM project_programme_items');
      let inserted = 0;
      for (const t of tasks) {
        const uid = Number(t.uid);
        const name = String(t.name || '').trim();
        if (!Number.isFinite(uid) || uid === 0 || !name) continue;
        runNoSave(
          `INSERT INTO project_programme_items (
            uid, name, wbs, outline_level, start_date, finish_date, duration_days,
            is_summary, is_milestone, is_milestone_tagged, zone_id
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            uid,
            name,
            t.wbs != null ? String(t.wbs) : '',
            Number(t.outline_level) || 1,
            t.start_date != null ? String(t.start_date) : '',
            t.finish_date != null ? String(t.finish_date) : '',
            t.duration_days != null ? Number(t.duration_days) : null,
            t.is_summary ? 1 : 0,
            t.is_milestone ? 1 : 0,
            t.is_milestone_tagged ? 1 : 0,
            t.zone_id != null && t.zone_id !== '' ? Number(t.zone_id) : null,
          ]
        );
        inserted += 1;
      }
      runNoSave('COMMIT');
      inTx = false;
      save();
      return { ok: true, count: inserted };
    } catch (e) {
      if (inTx) {
        try {
          runNoSave('ROLLBACK');
        } catch (_) {}
      }
      throw e;
    }
  },
  getDependencies: (itemType, itemId) => {
    if (itemType && itemId != null) {
      const type = String(itemType);
      const id = Number(itemId);
      const rows = all(
        `SELECT * FROM activity_dependencies
         WHERE (predecessor_type=? AND predecessor_id=?)
            OR (successor_type=? AND successor_id=?)
         ORDER BY id`,
        [type, id, type, id]
      );
      return rows.map(enrichDependencyRow);
    }
    return all('SELECT * FROM activity_dependencies ORDER BY id').map(enrichDependencyRow);
  },
  createDependency: (body, createdBy) => {
    const predecessor_type = String(body?.predecessor_type || '').trim();
    const successor_type = String(body?.successor_type || '').trim();
    const predecessor_id = Number(body?.predecessor_id);
    const successor_id = Number(body?.successor_id);
    if (
      !['programme_item', 'project_programme_item'].includes(predecessor_type) ||
      !['programme_item', 'project_programme_item'].includes(successor_type) ||
      !Number.isFinite(predecessor_id) ||
      !Number.isFinite(successor_id)
    ) {
      return { error: 'Invalid dependency fields' };
    }
    if (
      predecessor_type === successor_type &&
      predecessor_id === successor_id
    ) {
      return { error: 'Activity cannot depend on itself' };
    }
    if (!resolveDependencyItemInfo(predecessor_type, predecessor_id)) {
      return { error: 'Predecessor not found' };
    }
    if (!resolveDependencyItemInfo(successor_type, successor_id)) {
      return { error: 'Successor not found' };
    }
    try {
      run(
        `INSERT INTO activity_dependencies (
          predecessor_type, predecessor_id, successor_type, successor_id, relationship_type, created_by
        ) VALUES (?,?,?,?,?,?)`,
        [predecessor_type, predecessor_id, successor_type, successor_id, 'FS', String(createdBy || '')]
      );
    } catch (e) {
      if (/UNIQUE constraint failed/i.test(String(e.message || e))) {
        return { error: 'Dependency already exists' };
      }
      throw e;
    }
    const id = get('SELECT last_insert_rowid() as id').id;
    return enrichDependencyRow(get('SELECT * FROM activity_dependencies WHERE id=?', [id]));
  },
  deleteDependency: (id) => {
    const row = get('SELECT * FROM activity_dependencies WHERE id=?', [Number(id)]);
    if (!row) return false;
    run('DELETE FROM activity_dependencies WHERE id=?', [Number(id)]);
    return true;
  },

  getModuleCompletionTemplate() {
    return (
      get('SELECT * FROM templates WHERE name=? AND tab=?', [
        mbs.MODULE_COMPLETION_TEMPLATE_NAME,
        mbs.MODULE_PROGRAMME_TAB,
      ]) ||
      get('SELECT * FROM templates WHERE name=? ORDER BY id DESC LIMIT 1', [
        mbs.MODULE_COMPLETION_TEMPLATE_NAME,
      ]) ||
      null
    );
  },

  /** Sync Module Completion template + activities before bulk apply. */
  ensureModuleCompletionReady() {
    seedModuleCompletionActivities();
    const seqJson = JSON.stringify(mbs.MODULE_COMPLETION_SEQUENCE);
    const durJson = JSON.stringify(mbs.MODULE_COMPLETION_DURATIONS);
    let tpl = module.exports.getModuleCompletionTemplate();
    if (tpl) {
      run('UPDATE templates SET tab=?, sequence=?, durations=? WHERE id=?', [
        mbs.MODULE_PROGRAMME_TAB,
        seqJson,
        durJson,
        tpl.id,
      ]);
    } else {
      run('INSERT INTO templates (name,tab,tower,zone_name,sequence,durations) VALUES (?,?,?,?,?,?)', [
        mbs.MODULE_COMPLETION_TEMPLATE_NAME,
        mbs.MODULE_PROGRAMME_TAB,
        'T4',
        'Module',
        seqJson,
        durJson,
      ]);
      tpl = module.exports.getModuleCompletionTemplate();
    }
    if (!tpl) return { error: `Could not create template "${mbs.MODULE_COMPLETION_TEMPLATE_NAME}"` };

    const actRows = all('SELECT id, name FROM activities');
    const lookup = schedule.buildActivityLookup(actRows);
    const missing = mbs.MODULE_COMPLETION_SEQUENCE.filter(
      (name) => !schedule.resolveActivityId(lookup, name)
    );
    if (missing.length) {
      return { error: `Missing module activities in database: ${missing.join(', ')}` };
    }
    return { ok: true, template_id: Number(tpl.id) };
  },

  /** A1 — ordered module list + computed start dates (inspect before bulk apply). */
  getModuleBulkSchedulePreview(opts = {}) {
    const ready = module.exports.ensureModuleCompletionReady();
    if (ready.error) return { ok: false, error: ready.error };

    const zoneStats = mbs.countModuleZoneStats(all);
    const zones = mbs.getOrderedModuleZones(all);
    const startDates = mbs.assignModuleStartDates(zones.length, {
      startDate: opts.startDate || mbs.DEFAULT_BULK_START,
      modulesPerDay: opts.modulesPerDay || mbs.DEFAULT_MODULES_PER_DAY,
    });
    const tpl = module.exports.getModuleCompletionTemplate();
    let templateWarning = null;
    if (!tpl) templateWarning = `Template "${mbs.MODULE_COMPLETION_TEMPLATE_NAME}" not found — create it on Templates first.`;

    const list = zones.map((z, i) => ({
      order: i + 1,
      zone_id: Number(z.id),
      tower: String(z.tower || '').trim(),
      name: String(z.name || '').trim(),
      drawing_name: String(z.drawing_name || '').trim(),
      drawing_floor: String(z.drawing_floor || z.drawing_name || '').trim(),
      floor_rank: z._floorRank,
      centre_x: null,
      start_date: startDates[i] || null,
      label: `${String(z.tower || '').trim()} ${String(z.name || '').trim()}`.trim(),
    }));

    for (let i = 0; i < zones.length; i++) {
      list[i].centre_x = Math.round(mbs.parseGeomCenterX(zones[i]) * 100) / 100;
    }

    const lastStart = startDates[startDates.length - 1] || null;
    return {
      ok: true,
      total: list.length,
      zone_stats: zoneStats,
      template_id: tpl ? Number(tpl.id) : null,
      template_name: mbs.MODULE_COMPLETION_TEMPLATE_NAME,
      template_warning: templateWarning,
      start_anchor: mbs.normalizeModuleStartKey(opts.startDate || mbs.DEFAULT_BULK_START),
      modules_per_day: Number(opts.modulesPerDay) || mbs.DEFAULT_MODULES_PER_DAY,
      last_start_date: lastStart,
      ordered: list,
    };
  },

  /**
   * Apply Module Completion template from stage 0 start date (module Mon–Sat calendar).
   * Reusable for single-zone edits and bulk apply.
   */
  scheduleZoneFromTemplateStart(zoneId, templateId, startDateKey, opts = {}) {
    const zid = Number(zoneId);
    const zone = get('SELECT * FROM zones WHERE id=?', [zid]);
    if (!zone) return { error: 'Zone not found' };

    const tid = Number(templateId);
    const tpl = get('SELECT * FROM templates WHERE id=?', [tid]);
    if (!tpl) return { error: 'Template not found' };

    let seq = [];
    let dur = [];
    try {
      seq = JSON.parse(tpl.sequence || '[]');
    } catch (_) {}
    try {
      dur = JSON.parse(tpl.durations || '[]');
    } catch (_) {}
    if (!Array.isArray(seq) || !seq.length) return { error: 'Template has no sequence' };

    const actRows = all('SELECT id, name FROM activities');
    const activityLookup = schedule.buildActivityLookup(actRows);
    const startStageIndex = Number(opts.startStageIndex) || 0;
    const useModuleCalendar = opts.calendar === 'module';

    const rows = useModuleCalendar
      ? mbs.buildRowsFromModuleTemplateStart({
          sequence: seq,
          durations: dur,
          startStageIndex,
          startDateKey,
          activityLookup,
        })
      : schedule.buildRowsFromTemplate({
          sequence: seq,
          durations: dur,
          startStageIndex,
          startDateKey,
          activityLookup,
        });

    if (!rows.length) return { error: 'Could not compute schedule — check start date' };
    if (rows.some((r) => !r.activity_id)) {
      return { error: 'Unknown activity name in template — add matching activities in the database' };
    }

    const existing = all('SELECT * FROM programme_items WHERE zone_id=?', [zid]);
    deleteDependenciesForProgrammeItemIds(existing.map((pi) => pi.id));
    for (const it of existing) {
      shrinkScheduleForItem(it);
      run('DELETE FROM programme_items WHERE id=?', [it.id]);
    }

    const newItems = [];
    for (const row of rows) {
      if (!row || row.start_date == null || row.end_date == null) continue;
      const { start_date: sd, end_date: ed } = clampProgrammeItemDates(row.start_date, row.end_date);
      run(
        'INSERT INTO programme_items (zone_id,activity_id,start_date,end_date,status,notes) VALUES (?,?,?,?,?,?)',
        [zid, row.activity_id, sd, ed, row.status || 'planned', row.notes || '']
      );
      const nid = get('SELECT last_insert_rowid() as id').id;
      const pi = get('SELECT * FROM programme_items WHERE id=?', [nid]);
      if (pi) {
        expandScheduleForItem(pi);
        newItems.push(pi);
      }
    }

    if (!newItems.length) return { error: 'Could not store programme rows — check start date' };

    newItems.sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));

    const anchorActId = rows[startStageIndex]?.activity_id ?? rows[0]?.activity_id;
    const anchorDate = rows[startStageIndex]?.start_date ?? rows[0]?.start_date;
    try {
      const now = new Date().toISOString();
      run(
        'UPDATE zones SET source_template_id=?, programme_stage_idx=?, programme_anchor_date=?, programme_anchor_activity_id=?, updated_at=? WHERE id=?',
        [tid, startStageIndex, anchorDate, anchorActId, now, zid]
      );
      save();
    } catch (e) {
      console.error('[119HS] scheduleZoneFromTemplateStart anchor metadata failed zone', zid, e.message);
    }

    const datedEnd = rows.filter((r) => r && r.end_date != null);
    return {
      ok: true,
      zone_id: zid,
      zone_start: rows[0]?.start_date || null,
      zone_finish: datedEnd.length ? datedEnd[datedEnd.length - 1].end_date : null,
      activities: rows.length,
    };
  },

  /** A2+A3 — bulk-apply Module Completion to all ordered module zones. */
  applyModuleBulkSchedule(opts = {}) {
    const dryRun = opts.dryRun === true;
    const ready = module.exports.ensureModuleCompletionReady();
    if (ready.error) return { error: ready.error };

    const preview = module.exports.getModuleBulkSchedulePreview(opts);
    if (!preview.ok) return preview;
    if (!preview.total) {
      const gs = preview.zone_stats || {};
      return {
        error: `No schedulable modules found (${gs.total || 0} total, ${gs.ground_excluded || 0} on ground-floor drawings excluded). Rename drawings to 1st/2nd/3rd floor etc.`,
      };
    }
    const tid = ready.template_id;
    if (dryRun) {
      return { ok: true, dry_run: true, would_apply: preview.total, preview };
    }

    const errors = [];
    let applied = 0;
    for (const row of preview.ordered) {
      if (!row.start_date) continue;
      const out = module.exports.scheduleZoneFromTemplateStart(row.zone_id, tid, row.start_date, {
        startStageIndex: 0,
        calendar: 'module',
      });
      if (out.error) {
        errors.push({ zone_id: row.zone_id, label: row.label, error: out.error });
        continue;
      }
      applied += 1;
    }
    return {
      ok: true,
      applied,
      total: preview.total,
      errors,
      preview_summary: {
        start_anchor: preview.start_anchor,
        last_start_date: preview.last_start_date,
        modules_per_day: preview.modules_per_day,
      },
    };
  },

  /**
   * Apply Module Completion from an explicit ordered list (your module number sequence).
   * Each entry: module name string ("101"), "T4 101", or { tower, name }.
   */
  applyModuleBulkScheduleFromExplicitOrder(order, opts = {}) {
    const dryRun = opts.dryRun === true;
    const ready = module.exports.ensureModuleCompletionReady();
    if (ready.error) return { error: ready.error };

    const raw = Array.isArray(order) ? order : [];
    if (!raw.length) return { error: 'Order list is empty' };

    const allZones = all(
      `SELECT z.id, z.name, z.tower, d.name AS drawing_name
       FROM zones z JOIN drawings d ON d.id = z.drawing_id WHERE d.tab = ?`,
      [mbs.MODULE_HANDOVER_TAB]
    );
    const byKey = new Map();
    for (const z of allZones) {
      const tw = String(z.tower || '').trim().toUpperCase();
      const nm = String(z.name || '').trim();
      byKey.set(`${tw}|${nm}`.toUpperCase(), z);
      byKey.set(nm.toUpperCase(), z);
    }

    const resolved = [];
    const notFound = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      let tw = '';
      let nm = '';
      if (item && typeof item === 'object') {
        tw = String(item.tower || '').trim().toUpperCase();
        nm = String(item.name || '').trim();
      } else {
        const s = String(item || '').trim();
        const m = /^((?:T[1-4]))\s+(.+)$/i.exec(s);
        if (m) {
          tw = m[1].toUpperCase();
          nm = m[2].trim();
        } else {
          nm = s;
        }
      }
      const z =
        (tw ? byKey.get(`${tw}|${nm}`.toUpperCase()) : null) || byKey.get(nm.toUpperCase());
      if (!z) {
        notFound.push({ order: i + 1, input: item });
        continue;
      }
      resolved.push({
        order: i + 1,
        zone_id: Number(z.id),
        tower: String(z.tower || '').trim(),
        name: String(z.name || '').trim(),
        drawing_name: String(z.drawing_name || '').trim(),
      });
    }
    if (!resolved.length) {
      return { error: 'No modules matched in database', not_found: notFound.slice(0, 30) };
    }
    if (notFound.length && !opts.skipMissing) {
      return {
        error: `Could not find ${notFound.length} module(s) in database`,
        not_found: notFound.slice(0, 30),
        matched: resolved.length,
      };
    }

    const startDates = mbs.assignModuleStartDates(resolved.length, {
      startDate: opts.startDate || mbs.DEFAULT_BULK_START,
      modulesPerDay: opts.modulesPerDay || mbs.DEFAULT_MODULES_PER_DAY,
    });
    const list = resolved.map((r, i) => ({ ...r, start_date: startDates[i] || null }));

    if (dryRun) {
      return { ok: true, dry_run: true, total: list.length, ordered: list };
    }

    const tid = ready.template_id;
    const errors = [];
    let applied = 0;
    for (const row of list) {
      const out = module.exports.scheduleZoneFromTemplateStart(row.zone_id, tid, row.start_date, {
        startStageIndex: 0,
        calendar: 'module',
      });
      if (out.error) {
        errors.push({ zone_id: row.zone_id, label: `${row.tower} ${row.name}`, error: out.error });
        continue;
      }
      applied += 1;
    }
    return {
      ok: true,
      applied,
      total: list.length,
      matched: resolved.length,
      skipped: notFound.length,
      not_found: notFound.length ? notFound.slice(0, 30) : [],
      errors,
      last_start_date: startDates[startDates.length - 1] || null,
    };
  },

  /** Apply Levels 1–5 module order from moduleOrderL1L5.js */
  applyModuleOrderL1L5(opts = {}) {
    const { MODULE_ORDER_L1_L5 } = require('./moduleOrderL1L5');
    return module.exports.applyModuleBulkScheduleFromExplicitOrder(MODULE_ORDER_L1_L5, {
      startDate: opts.startDate,
      modulesPerDay: opts.modulesPerDay,
      dryRun: opts.dryRun,
      skipMissing: opts.skipMissing !== false,
    });
  },

  /** Programme items for all module_handover zones — for Handover Progress mirror. */
  getModuleProgrammeItemsGrouped() {
    const rows = all(
      `SELECT pi.*, a.name AS activity_name, a.type AS activity_type
       FROM programme_items pi
       JOIN zones z ON z.id = pi.zone_id
       JOIN drawings d ON d.id = z.drawing_id
       JOIN activities a ON a.id = pi.activity_id
       WHERE d.tab = ?
       ORDER BY pi.zone_id, pi.start_date`,
      [mbs.MODULE_HANDOVER_TAB]
    );
    const byZone = new Map();
    for (const r of rows) {
      const zid = Number(r.zone_id);
      if (!byZone.has(zid)) byZone.set(zid, []);
      byZone.get(zid).push(r);
    }
    return byZone;
  },

  /** B2 — per-activity Module Completion counts across all module zones (read-only mirror). */
  getModuleCompletionProgress(todayKey) {
    const zones = mbs.getOrderedModuleZones(all);
    const zoneIds = zones.map((z) => Number(z.id));
    const byZone = module.exports.getModuleProgrammeItemsGrouped();
    const today = String(todayKey || pw.dateKeyFromDate(new Date())).trim();
    const counts = mbs.summarizeModuleProgrammeProgress(
      byZone,
      zoneIds,
      today,
      mbs.MODULE_COMPLETION_SEQUENCE
    );
    return {
      ok: true,
      total: zoneIds.length,
      today,
      sequence: mbs.MODULE_COMPLETION_SEQUENCE,
      counts,
    };
  },

  getModuleAirSoundPreview() {
    return masm.buildPreview(all);
  },

  /** One-off W/C Air and Sound — single Monday cell per module per scheduled week. */
  applyModuleAirSoundOneOffs(opts = {}) {
    const dryRun = opts.dryRun === true;
    const preview = masm.buildPreview(all);
    if (!preview.total_items && preview.weeks.every((w) => w.zone_count === 0)) {
      return { error: 'No module zones matched the W/C Air and Sound schedule', preview };
    }

    try {
      runNoSave('INSERT OR IGNORE INTO activities (name,type) VALUES (?,?)', [
        masm.ACTIVITY_NAME,
        'module_programme',
      ]);
    } catch (_) {}
    const act = get('SELECT id FROM activities WHERE lower(name)=lower(?)', [masm.ACTIVITY_NAME]);
    if (!act) return { error: 'Could not create W/C Air and Sound activity' };

    let added = 0;
    let skipped = 0;
    const errors = [];
    const emptyWeeks = [];

    for (const week of preview.weeks) {
      if (!week.zone_count) emptyWeeks.push(week.label);
      for (const z of week.zones) {
        const zoneId = Number(z.zone_id);
        const existing = get(
          `SELECT pi.id FROM programme_items pi
           WHERE pi.zone_id=? AND pi.activity_id=? AND pi.start_date=?`,
          [zoneId, act.id, week.week_start]
        );
        if (existing) {
          skipped += 1;
          continue;
        }
        if (dryRun) {
          added += 1;
          continue;
        }
        try {
          module.exports.addProgrammeItem(
            zoneId,
            act.id,
            week.week_start,
            week.week_start,
            'planned',
            week.label,
            'day'
          );
          added += 1;
        } catch (e) {
          errors.push({
            zone_id: zoneId,
            tower: z.tower,
            name: z.name,
            week: week.week_start,
            error: e.message || String(e),
          });
        }
      }
    }
    if (!dryRun) save();

    return {
      ok: true,
      dry_run: dryRun,
      activity: masm.ACTIVITY_NAME,
      added,
      skipped,
      empty_weeks: emptyWeeks,
      errors,
      preview,
    };
  },
};
