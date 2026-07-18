'use strict';

/**
 * One-off W/C Air and Sound activities on module zones — single day (Monday) per week.
 * Source: site schedule w/c Jul–Sep 2026.
 */

const MODULE_HANDOVER_TAB = 'module_handover';
const ACTIVITY_NAME = 'W/C Air and Sound';

/** @type {Array<{ weekStart: string, label: string, groups?: Array<object>, smokeShafts?: boolean }>} */
const WC_AIR_SOUND_WEEKS = [
  {
    weekStart: '2026-07-20',
    label: 'w/c 20 July',
    groups: [
      { tower: 'T4', ranges: [[601, 604], [701, 704]] },
      {
        tower: 'T1',
        ranges: [
          [101, 113],
          [143, 148],
          [201, 213],
          [243, 248],
          [301, 313],
          [343, 348],
          [401, 413],
          [443, 448],
          [501, 504],
          [525, 530],
        ],
      },
    ],
  },
  {
    weekStart: '2026-07-27',
    label: 'w/c 27 July',
    groups: [
      {
        tower: 'T2',
        ranges: [
          [114, 119],
          [140, 142],
          [214, 219],
          [240, 242],
          [314, 319],
          [340, 342],
          [414, 419],
          [440, 442],
          [505, 511],
          [522, 524],
        ],
      },
    ],
  },
  {
    weekStart: '2026-08-10',
    label: 'w/c 10 August',
    groups: [
      {
        tower: 'T2',
        ranges: [
          [120, 123],
          [137, 139],
          [220, 223],
          [237, 239],
          [320, 323],
          [337, 339],
          [420, 423],
          [437, 439],
          [512, 514],
          [520, 520],
          [521, 521],
        ],
      },
    ],
  },
  {
    weekStart: '2026-08-24',
    label: 'w/c 24 August — Smoke Shafts',
    smokeShafts: true,
  },
  {
    weekStart: '2026-08-31',
    label: 'w/c 31 August',
    groups: [{ tower: 'T2', ranges: [[1, 9]] }],
  },
  {
    weekStart: '2026-09-07',
    label: 'w/c 7 September',
    groups: [{ tower: 'T3', all: true }],
  },
];

function moduleNumberFromZoneName(name) {
  const m = String(name || '').trim().match(/^(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function expandRanges(ranges) {
  const nums = new Set();
  for (const pair of ranges || []) {
    const lo = Math.min(pair[0], pair[1]);
    const hi = Math.max(pair[0], pair[1]);
    for (let n = lo; n <= hi; n++) nums.add(n);
  }
  return [...nums].sort((a, b) => a - b);
}

function isSmokeShaftZone(z) {
  const s = `${z.name || ''} ${z.drawing_name || ''}`.toLowerCase();
  return s.includes('smoke') || s.includes('shaft');
}

function loadModuleZones(allFn) {
  return allFn(
    `SELECT z.id, z.name, z.tower, d.name AS drawing_name
     FROM zones z
     JOIN drawings d ON d.id = z.drawing_id
     WHERE d.tab = ?
     ORDER BY z.tower, z.name`,
    [MODULE_HANDOVER_TAB]
  );
}

function zonesForGroup(group, allZones) {
  const tw = String(group.tower || '').trim().toUpperCase();
  if (group.all) {
    return allZones.filter((z) => String(z.tower || '').trim().toUpperCase() === tw);
  }
  const want = new Set(expandRanges(group.ranges));
  return allZones.filter((z) => {
    if (String(z.tower || '').trim().toUpperCase() !== tw) return false;
    const num = moduleNumberFromZoneName(z.name);
    return num != null && want.has(num);
  });
}

function zonesForWeek(week, allZones) {
  if (week.smokeShafts) {
    return allZones.filter(isSmokeShaftZone);
  }
  const out = [];
  const seen = new Set();
  for (const group of week.groups || []) {
    for (const z of zonesForGroup(group, allZones)) {
      if (seen.has(z.id)) continue;
      seen.add(z.id);
      out.push(z);
    }
  }
  return out;
}

function buildPreview(allFn) {
  const allZones = loadModuleZones(allFn);
  const weeks = WC_AIR_SOUND_WEEKS.map((week) => {
    const zones = zonesForWeek(week, allZones);
    return {
      week_start: week.weekStart,
      label: week.label,
      zone_count: zones.length,
      zones: zones.map((z) => ({
        zone_id: z.id,
        tower: z.tower,
        name: z.name,
        drawing_name: z.drawing_name,
      })),
    };
  });
  const total = weeks.reduce((n, w) => n + w.zone_count, 0);
  return { ok: true, activity: ACTIVITY_NAME, weeks, total_items: total };
}

module.exports = {
  ACTIVITY_NAME,
  MODULE_HANDOVER_TAB,
  WC_AIR_SOUND_WEEKS,
  buildPreview,
  zonesForWeek,
  loadModuleZones,
};
