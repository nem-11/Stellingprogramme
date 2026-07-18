import { completionKeyFromProgrammeRow, scheduleDateKeysBetween, isProgrammeRowFullyDone } from './planUtils';

const UNKNOWN_FLOOR = 999;

function normaliseDayKey(dayKey) {
  return String(dayKey || '').trim();
}

function isGenericDrawingFloor(floor) {
  const f = String(floor || '').trim().toLowerCase();
  return !f || f === 'ground' || f === 'gf' || f === 'g/f' || f === 'g';
}

/**
 * Parse a numeric floor rank from a label.
 * Internals zones use "T1 A 1" (tower · zone letter · floor number at end).
 */
function floorRankFromLabel(text) {
  const s = String(text || '').trim();
  if (!s) return UNKNOWN_FLOOR;
  const lower = s.toLowerCase();

  if (lower.includes('basement')) return -1;
  if (lower.includes('ground') || /\bgf\b/.test(lower)) return 0;

  const namedFloor =
    lower.match(/(?:^|\b)(\d+)\s*(?:st|nd|rd|th)\s*floor\b/)
    || lower.match(/\bfloor\s*(\d+)\b/);
  if (namedFloor) return parseInt(namedFloor[1], 10);

  // Internals plan labels: T1 A 1, T2 D 2, T1 L 1 — trailing digit is the floor.
  const towerZoneFloor = s.match(/^T\d+\s+[A-Z]+\s+(\d+)\s*$/i);
  if (towerZoneFloor) return parseInt(towerZoneFloor[1], 10);

  return UNKNOWN_FLOOR;
}

/** Floor rank for a programme row — zone name first, then drawing name (not generic drawing.floor). */
export function floorRankFromRow(row) {
  const zoneRank = floorRankFromLabel(row?.zone_name);
  if (zoneRank !== UNKNOWN_FLOOR) return zoneRank;

  const drawingNameRank = floorRankFromLabel(row?.drawing_name);
  if (drawingNameRank !== UNKNOWN_FLOOR) return drawingNameRank;

  if (!isGenericDrawingFloor(row?.drawing_floor)) {
    const flRank = floorRankFromLabel(row?.drawing_floor);
    if (flRank !== UNKNOWN_FLOOR) return flRank;
  }

  const dn = String(row?.drawing_name || '').toLowerCase();
  if (dn.includes('basement')) return -1;
  if (dn.includes('ground')) return 0;

  return UNKNOWN_FLOOR;
}

/** Numeric floor rank from drawing + zones on that plan. */
export function floorRankFromDrawing(drawing, zones) {
  for (const z of zones || []) {
    const r = floorRankFromRow({
      zone_name: z?.name,
      tower: z?.tower,
      drawing_name: drawing?.name,
      drawing_floor: drawing?.floor,
    });
    if (r !== UNKNOWN_FLOOR) return r;
  }
  const nameRank = floorRankFromLabel(drawing?.name);
  if (nameRank !== UNKNOWN_FLOOR) return nameRank;
  if (!isGenericDrawingFloor(drawing?.floor)) {
    const flRank = floorRankFromLabel(drawing?.floor);
    if (flRank !== UNKNOWN_FLOOR) return flRank;
  }
  const dn = String(drawing?.name || '').toLowerCase();
  if (dn.includes('basement')) return -1;
  if (dn.includes('ground')) return 0;
  return UNKNOWN_FLOOR;
}

export function floorLabelFromRank(rank) {
  if (rank === -1) return 'Basement';
  if (rank === 0) return 'Ground floor';
  if (rank >= 1 && rank < UNKNOWN_FLOOR) {
    const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
    return `${rank}${suffix} floor`;
  }
  return '—';
}

/** Compact floor label for tower breakdown rows (GF, 1, 2, …). */
export function floorShortLabelFromRank(rank) {
  if (rank === -1) return 'B';
  if (rank === 0) return 'GF';
  if (rank >= 1 && rank < UNKNOWN_FLOOR) return String(rank);
  return '—';
}

const TOWER_ORDER = ['T1', 'T2', 'T3', 'T4'];

function towerSortKey(tower) {
  const t = String(tower || '').trim().toUpperCase();
  const idx = TOWER_ORDER.indexOf(t);
  if (idx >= 0) return idx;
  const num = t.match(/T(\d+)/i);
  if (num) return TOWER_ORDER.length + parseInt(num[1], 10);
  return TOWER_ORDER.length + 100 + t.charCodeAt(0);
}

function sortTowers(a, b) {
  const ka = towerSortKey(a.label ?? a);
  const kb = towerSortKey(b.label ?? b);
  if (ka !== kb) return ka - kb;
  return String(a.label ?? a).localeCompare(String(b.label ?? b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Ground → numeric floors → basement/other. */
export function floorSortRank(floor) {
  const s = String(floor || '').toLowerCase().trim();
  if (s.includes('basement')) return -1;
  if (!s || s === 'gf' || s === 'ground' || s === 'ground floor' || s === 'g/f' || s === 'g') return 0;
  const m = s.match(/(\d+)\s*(?:st|nd|rd|th)?\s*floor/) || s.match(/floor\s*(\d+)/) || s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}

/** Human-readable floor label derived from drawing metadata and zones. */
export function floorLabelFromDrawing(drawing, zones) {
  const rank = floorRankFromDrawing(drawing, zones);
  if (rank !== UNKNOWN_FLOOR) return floorLabelFromRank(rank);
  const raw = String(drawing?.name || drawing?.floor || '').trim();
  return raw || '—';
}

export function floorLabelFromRow(row) {
  const rank = floorRankFromRow(row);
  if (rank !== UNKNOWN_FLOOR) return floorLabelFromRank(rank);
  const raw = String(row?.drawing_name || row?.drawing_floor || '').trim();
  return raw || '—';
}

export function levelKeyFromRow(row) {
  const tw = String(row?.tower || '').trim() || '—';
  const rank = floorRankFromRow(row);
  return `${tw}|${rank}`;
}

export function levelLabelFromRow(row) {
  const tw = String(row?.tower || '').trim() || '—';
  return `${tw} · ${floorLabelFromRow(row)}`;
}

function tallyRow(bucket, row, comp) {
  bucket.total += 1;
  if (isProgrammeRowFullyDone(row, comp)) bucket.done += 1;
}

/**
 * Activity fully done as of a date: status done, or every scheduled day in the span
 * (on or before asOf) has its own completion tick.
 */
function rowDoneAsOf(row, asOfDate, comp) {
  if (!row) return false;
  if (String(row.status || '').toLowerCase() === 'done') return true;
  const ck = completionKeyFromProgrammeRow(row);
  if (!ck || !comp || typeof comp !== 'object') return false;
  const asOf = normaliseDayKey(asOfDate);
  const days = scheduleDateKeysBetween(row.start_date, row.end_date).filter(
    (dk) => !asOf || normaliseDayKey(dk) <= asOf
  );
  if (!days.length) return false;
  return days.every((dk) => !!comp[dk]?.[ck]);
}

/** Latest completion tick date for a fully-done row (within optional as-of date). */
function rowLastCompletionDate(row, comp, asOfDate) {
  if (!rowDoneAsOf(row, asOfDate, comp)) return null;
  const ck = completionKeyFromProgrammeRow(row);
  const asOf = normaliseDayKey(asOfDate);
  let last = null;
  if (ck && comp && typeof comp === 'object') {
    for (const dk of scheduleDateKeysBetween(row.start_date, row.end_date)) {
      if (asOf && normaliseDayKey(dk) > asOf) continue;
      if (comp[dk]?.[ck]) last = dk;
    }
  }
  if (!last && String(row.status || '').toLowerCase() === 'done') {
    const end = normaliseDayKey(row.end_date);
    if (!asOf || !end || end <= asOf) last = end || last;
  }
  return last;
}

function levelCompletionForRows(rows, comp, asOfDate) {
  const list = Array.isArray(rows) ? rows : [];
  let total = 0;
  let done = 0;
  let lastFinishedDate = null;
  for (const row of list) {
    total += 1;
    if (rowDoneAsOf(row, asOfDate, comp)) {
      done += 1;
      const d = rowLastCompletionDate(row, comp, asOfDate);
      if (d && (!lastFinishedDate || d > lastFinishedDate)) lastFinishedDate = d;
    }
  }
  const pct = total > 0 ? done / total : null;
  return {
    total,
    done,
    pct,
    lastFinishedDate: done === total && total > 0 ? lastFinishedDate : null,
  };
}

function programmeRowsForDrawingLevel(drawing, zones, programmeRows) {
  const rank = floorRankFromDrawing(drawing, zones);
  const towers = new Set((zones || []).map((z) => String(z.tower || '').trim()).filter(Boolean));
  const out = [];
  for (const row of programmeRows || []) {
    const tw = String(row?.tower || '').trim();
    const zn = String(row?.zone_name || '').trim();
    const act = String(row?.activity_name || '').trim();
    if (!tw || !zn || !act) continue;
    if (!String(row.start_date || '').trim() || !String(row.end_date || '').trim()) continue;
    if (floorRankFromRow(row) !== rank) continue;
    if (towers.size && !towers.has(tw)) continue;
    out.push(row);
  }
  return out;
}

/**
 * Level completion for a drawing view: all programme rows on the same tower + floor
 * (pour areas A/B/C roll up to one level finish line).
 */
export function drawingLevelCompletionAsOf(asOfDate, drawing, zones, programmeRows, comp) {
  if (!drawing) return null;
  const rows = programmeRowsForDrawingLevel(drawing, zones, programmeRows);
  if (!rows.length) return null;
  const stats = levelCompletionForRows(rows, comp, asOfDate);
  return {
    ...stats,
    label: floorLabelFromDrawing(drawing, zones),
    levelLabel: levelLabelFromRow(rows[0]),
  };
}

/**
 * Per-tower and per-level completion for a programme scope.
 * Level = tower + floor from zone/drawing labels; all zones on that floor share one finish line.
 */
export function programmeCompletionBreakdown(planRows, comp, rowMatches) {
  const byTower = new Map();
  const byLevel = new Map();
  for (const r of planRows || []) {
    if (!r || typeof rowMatches !== 'function' || !rowMatches(r)) continue;
    const tw = String(r.tower || '').trim() || '—';
    const zn = String(r.zone_name || '').trim();
    const act = String(r.activity_name || '').trim();
    if (!zn || !act) continue;
    if (!String(r.start_date || '').trim() || !String(r.end_date || '').trim()) continue;
    const lk = levelKeyFromRow(r);
    const rank = floorRankFromRow(r);
    if (!byTower.has(tw)) byTower.set(tw, { label: tw, total: 0, done: 0 });
    if (!byLevel.has(lk)) {
      byLevel.set(lk, {
        label: levelLabelFromRow(r),
        rank,
        tower: tw,
        total: 0,
        done: 0,
        rows: [],
      });
    }
    tallyRow(byTower.get(tw), r, comp);
    const bucket = byLevel.get(lk);
    tallyRow(bucket, r, comp);
    bucket.rows.push(r);
  }
  const mapPct = (e) => ({ ...e, pct: e.total > 0 ? Math.round((e.done / e.total) * 100) : 0 });
  const mapLevel = (e) => {
    const base = mapPct(e);
    const lastFinishedDate =
      base.done === base.total && base.total > 0
        ? levelCompletionForRows(e.rows, comp, null).lastFinishedDate
        : null;
    return {
      label: base.label,
      tower: e.tower,
      rank: e.rank,
      floorLabel: floorLabelFromRank(e.rank),
      floorShort: floorShortLabelFromRank(e.rank),
      total: base.total,
      done: base.done,
      pct: base.pct,
      lastFinishedDate,
    };
  };
  const towers = [...byTower.values()].map(mapPct).sort(sortTowers);
  const levels = [...byLevel.values()].map(mapLevel).sort((a, b) => {
    const tw = sortTowers({ label: a.tower }, { label: b.tower });
    if (tw !== 0) return tw;
    return (a.rank ?? 999) - (b.rank ?? 999) || a.label.localeCompare(b.label);
  });
  const towerGroups = towers.map((tower) => ({
    ...tower,
    levels: levels.filter((lv) => lv.tower === tower.label),
  }));
  return { towers, levels, towerGroups };
}

/** @deprecated Use drawingLevelCompletionAsOf — kept for compatibility. */
export function zoneCompletionsAsOf(date, zones, programmeRows, comp) {
  const asOfDate = normaliseDayKey(date);
  const zoneList = Array.isArray(zones) ? zones : [];
  const zoneIds = new Set(zoneList.map((z) => Number(z.id)).filter(Number.isFinite));
  const byZone = new Map(zoneList.map((z) => [Number(z.id), []]));

  for (const row of programmeRows || []) {
    const zid = Number(row?.zone_id);
    if (!zoneIds.has(zid)) continue;
    if (!byZone.has(zid)) byZone.set(zid, []);
    byZone.get(zid).push(row);
  }

  const out = new Map();
  for (const z of zoneList) {
    const zid = Number(z.id);
    const rows = byZone.get(zid) || [];
    if (!rows.length) {
      out.set(zid, null);
      continue;
    }
    const stats = levelCompletionForRows(rows, comp, asOfDate);
    out.set(zid, {
      pct: stats.pct,
      total: stats.total,
      done: stats.done,
      lastFinishedDate: stats.lastFinishedDate,
    });
  }
  return out;
}
