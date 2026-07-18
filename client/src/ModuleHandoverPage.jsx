import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as api from './api';
import { T, S, shadowCard } from './uiTheme';
import PageHeader, { PageFooterHint } from './PageHeader';
import ZoneDrawingCanvas from './ZoneDrawingCanvas';
import { parseZoneGeometry, svgPolygonPoints, geomBBox } from './zoneGeom';
import { isPdfFile, rasterizePdfFirstPageToJpeg } from './pdfDrawing';
import { MODULE_HANDOVER_TAB, MODULE_PROGRAMME_TAB, drawingTabLabel, dateKey, actColor } from './constants';
import {
  MODULE_STAGES,
  MODULE_COMPLETION_SEQUENCE,
  moduleStageMeta,
  normalizeModuleStage,
  moduleCompletionSummary,
} from './moduleHandover';
import { autoDetectModules } from './moduleAutoDetect';
import { useRefreshOnFocus } from './useRefreshOnFocus';

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function rasterizeImageFile(file) {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  const s = Math.min(1920 / img.width, 1);
  c.width = img.width * s;
  c.height = img.height * s;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
  return { width: c.width, height: c.height, b64 };
}

/** Natural floor order: Basement < Ground < 1st < 2nd < … so a re-added floor sorts into place. */
function floorRank(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('basement')) return -1;
  if (s.includes('ground') || /\bgf\b/.test(s)) return 0;
  const m = s.match(/(\d+)\s*(?:st|nd|rd|th)?\s*floor/) || s.match(/floor\s*(\d+)/) || s.match(/(\d+)/);
  if (m) return parseInt(m[1], 10);
  return 999;
}

const DRAW_MIN_SCALE = 0.5;
const DRAW_MAX_SCALE = 8;
const clampDrawScale = (s) => Math.min(DRAW_MAX_SCALE, Math.max(DRAW_MIN_SCALE, s));

const drawZoomBtn = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: '1px solid rgba(26,26,46,0.18)',
  background: 'rgba(255,255,255,0.96)',
  color: '#1a1a2e',
  fontSize: 17,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 2px 8px rgba(26,26,46,0.14)',
  lineHeight: 1,
};

/** Module Handover — modules drawn as zones on a plan, each carrying a single handover stage. */
export default function ModuleHandoverPage({ canManage = false }) {
  const [drawings, setDrawings] = useState([]);
  const [drawingId, setDrawingId] = useState('');
  const [drawing, setDrawing] = useState(null);
  const [zones, setZones] = useState([]);
  const [programmeItems, setProgrammeItems] = useState([]);
  const [selId, setSelId] = useState(null);
  const [tool, setTool] = useState('view'); // 'view' | 'draw'
  const [drawShape, setDrawShape] = useState('rect'); // 'rect' | 'poly'
  const [rectDraft, setRectDraft] = useState(null);
  const [polyPts, setPolyPts] = useState([]);
  const [polyHover, setPolyHover] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [coarse, setCoarse] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectProgress, setDetectProgress] = useState(null);
  const [detectErr, setDetectErr] = useState('');
  const [review, setReview] = useState(null); // null | [{x,y,w,h,name,include}]
  const [importOpen, setImportOpen] = useState(false);
  const [importSources, setImportSources] = useState([]);
  const [importSel, setImportSel] = useState(() => new Set());
  const [importBusy, setImportBusy] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyTargetId, setCopyTargetId] = useState('');
  const [copyOffset, setCopyOffset] = useState(100);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyProgress, setCopyProgress] = useState(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const [panning, setPanning] = useState(false);
  const [panMode, setPanMode] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editGeom, setEditGeom] = useState(null);
  const [completionProgress, setCompletionProgress] = useState(null);
  const [programmePreview, setProgrammePreview] = useState(null);
  const [programmeApplyBusy, setProgrammeApplyBusy] = useState(false);
  const [airSoundPreview, setAirSoundPreview] = useState(null);
  const [airSoundApplyBusy, setAirSoundApplyBusy] = useState(false);

  const wrapRef = useRef(null);
  const viewportRef = useRef(null);
  const panDragRef = useRef(null);
  const drawingRef = useRef(false);
  const editGeomRef = useRef(null);
  const editIdRef = useRef(null);
  const editDragRef = useRef(null);
  const card = { background: '#fff', borderRadius: 12, border: '1px solid rgba(26,26,46,0.06)', boxShadow: shadowCard };

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const fn = () => setCoarse(!!mq.matches);
    fn();
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  const reloadDrawings = useCallback(() => {
    return api
      .getDrawings()
      .then((d) => {
        const list = (Array.isArray(d) ? d : [])
          .filter((x) => String(x.tab) === MODULE_HANDOVER_TAB)
          .sort((a, b) => {
            const ra = floorRank(a.name);
            const rb = floorRank(b.name);
            if (ra !== rb) return ra - rb;
            return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true });
          });
        setDrawings(list);
        return list;
      })
      .catch((e) => {
        setErr(e?.message || 'Could not load drawings');
        setDrawings([]);
        return [];
      });
  }, []);

  useEffect(() => {
    reloadDrawings();
  }, [reloadDrawings]);

  useEffect(() => {
    setDrawingId((prev) => {
      if (prev && drawings.some((d) => Number(d.id) === Number(prev))) return prev;
      return drawings[0]?.id ? String(drawings[0].id) : '';
    });
  }, [drawings]);

  const reloadZones = useCallback((did) => {
    if (!did) {
      setZones([]);
      return Promise.resolve([]);
    }
    return api
      .getZonesForDrawing(did)
      .then((z) => {
        const list = Array.isArray(z) ? z : [];
        setZones(list);
        return list;
      })
      .catch((e) => {
        setErr(e?.message || 'Could not load modules');
        setZones([]);
        return [];
      });
  }, []);

  const reloadProgrammeItems = useCallback((did) => {
    if (!did) {
      setProgrammeItems([]);
      return;
    }
    api.getProgrammeItemsByDrawing(did).then((rows) => {
      const list = (Array.isArray(rows) ? rows : []).filter(
        (r) => String(r.activity_type || '') === MODULE_PROGRAMME_TAB
      );
      setProgrammeItems(list);
    }).catch(() => setProgrammeItems([]));
  }, []);

  const todayKey = dateKey(new Date());

  const reloadCompletionProgress = useCallback(() => {
    return api
      .getModuleCompletionProgress(todayKey)
      .then((out) => {
        setCompletionProgress(out && out.ok ? out : null);
        return out;
      })
      .catch(() => {
        setCompletionProgress(null);
        return null;
      });
  }, [todayKey]);

  useRefreshOnFocus(() => reloadProgrammeItems(drawingId));
  useRefreshOnFocus(reloadCompletionProgress);

  useEffect(() => {
    reloadCompletionProgress();
  }, [reloadCompletionProgress]);

  const reloadProgrammeOrderPreview = useCallback(() => {
    if (!canManage) {
      setProgrammePreview(null);
      return Promise.resolve(null);
    }
    return api
      .previewModuleL1L5Order({ skipMissing: true })
      .then((out) => {
        setProgrammePreview(out && !out.error ? out : null);
        return out;
      })
      .catch(() => {
        setProgrammePreview(null);
        return null;
      });
  }, [canManage]);

  useEffect(() => {
    void reloadProgrammeOrderPreview();
  }, [reloadProgrammeOrderPreview]);

  const reloadAirSoundPreview = useCallback(() => {
    if (!canManage) {
      setAirSoundPreview(null);
      return Promise.resolve(null);
    }
    return api
      .previewModuleAirSound()
      .then((out) => {
        setAirSoundPreview(out && !out.error ? out : null);
        return out;
      })
      .catch(() => {
        setAirSoundPreview(null);
        return null;
      });
  }, [canManage]);

  useEffect(() => {
    void reloadAirSoundPreview();
  }, [reloadAirSoundPreview]);

  async function applyAirSoundProgramme() {
    const total = airSoundPreview?.total_items || 0;
    if (
      !window.confirm(
        `Add W/C Air and Sound to ${total} module slot(s) across 6 weeks (Jul–Sep 2026)?\n\nEach module gets one box on the Monday of its week. Existing matching entries are skipped.`
      )
    ) {
      return;
    }
    setAirSoundApplyBusy(true);
    setErr('');
    try {
      const out = await api.applyModuleAirSound({});
      if (out?.error) throw new Error(out.error);
      const added = Number(out.added) || 0;
      const skipped = Number(out.skipped) || 0;
      const empty = Array.isArray(out.empty_weeks) && out.empty_weeks.length ? `\n\nNo zones matched: ${out.empty_weeks.join(', ')}` : '';
      window.alert(`Added ${added} W/C Air and Sound item(s).${skipped ? ` Skipped ${skipped} duplicate(s).` : ''}${empty}`);
      await Promise.all([reloadAirSoundPreview(), reloadCompletionProgress(), reloadProgrammeItems(drawingId)]);
    } catch (e) {
      setErr(e?.message || 'Could not apply W/C Air and Sound');
    } finally {
      setAirSoundApplyBusy(false);
    }
  }

  async function applyL1L5Programme() {
    const total = programmePreview?.total || programmePreview?.matched;
    const msg = total
      ? `Apply Module Completion programme to ${total} modules in the L1–L5 floor-plan order?\n\nStart Mon 22 Jun 2026 · 5 modules per working day (Mon–Sat). Existing per-module schedules will be replaced.`
      : 'Apply Module Completion programme to all L1–L5 modules in floor-plan order? Existing per-module schedules will be replaced.';
    if (!window.confirm(msg)) return;
    setProgrammeApplyBusy(true);
    setErr('');
    try {
      const out = await api.applyModuleL1L5Order({ skipMissing: true });
      if (out?.error) throw new Error(out.error);
      const applied = Number(out.applied) || 0;
      const skipped = Number(out.skipped) || 0;
      window.alert(
        `Programme applied to ${applied} module(s).` +
          (skipped ? ` ${skipped} module(s) in the list were not found in the database.` : '') +
          (out.last_start_date ? ` Last start date: ${out.last_start_date}.` : '')
      );
      await Promise.all([reloadProgrammeOrderPreview(), reloadCompletionProgress(), reloadProgrammeItems(drawingId)]);
    } catch (e) {
      setErr(e?.message || 'Could not apply module programme');
    } finally {
      setProgrammeApplyBusy(false);
    }
  }

  useEffect(() => {
    setSelId(null);
    if (!drawingId) {
      setDrawing(null);
      setZones([]);
      setProgrammeItems([]);
      return;
    }
    let cancelled = false;
    api.getDrawing(drawingId).then((d) => {
      if (!cancelled) setDrawing(d || null);
    });
    reloadZones(drawingId);
    reloadProgrammeItems(drawingId);
    return () => {
      cancelled = true;
    };
  }, [drawingId, reloadZones, reloadProgrammeItems]);

  /** Active module_programme row per zone for today (for colour key + module list). */
  const programmeTodayByZone = useMemo(() => {
    const by = new Map();
    for (const r of programmeItems) {
      const dk = todayKey;
      if (dk < String(r.start_date) || dk > String(r.end_date)) continue;
      const zid = Number(r.zone_id);
      const cur = by.get(zid);
      if (!cur || String(r.start_date) < String(cur.start_date)) by.set(zid, r);
    }
    return by;
  }, [programmeItems, todayKey]);

  const programmeTodayByStageLabel = useMemo(() => {
    const counts = {};
    MODULE_STAGES.forEach((s) => { counts[s.label] = 0; });
    programmeTodayByZone.forEach((r) => {
      const label = String(r.activity_name || '').trim();
      if (counts[label] != null) counts[label] += 1;
    });
    return counts;
  }, [programmeTodayByZone]);

  const summary = useMemo(() => moduleCompletionSummary(zones), [zones]);

  const completionCounts = useMemo(() => {
    const c = completionProgress?.counts;
    if (!c) return null;
    return c;
  }, [completionProgress]);

  // In Adjust mode the side panel (rename / delete / stage) follows the module
  // you're editing; otherwise it follows the View-mode click selection.
  const selected = useMemo(() => {
    const id = editMode && editId != null ? editId : selId;
    return zones.find((z) => Number(z.id) === Number(id)) || null;
  }, [zones, selId, editId, editMode]);

  // Keep adjust handles / selection outline a roughly constant on-screen size
  // regardless of zoom (they live inside the zoom-transformed plate).
  const handleScale = 1 / Math.max(0.4, view.scale);

  async function handleUpload(e) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setErr('');
    setBusy(true);
    try {
      let width;
      let height;
      let b64;
      if (isPdfFile(file)) {
        const buf = await file.arrayBuffer();
        const out = await rasterizePdfFirstPageToJpeg(buf, { maxWidth: 1920, jpegQuality: 0.85 });
        width = out.width;
        height = out.height;
        b64 = out.base64;
      } else {
        const out = await rasterizeImageFile(file);
        width = out.width;
        height = out.height;
        b64 = out.b64;
      }
      const r = await api.createModuleDrawing(file.name, 'modules', b64, width, height, null);
      if (r?.ok) {
        const list = await reloadDrawings();
        if (list.some((d) => Number(d.id) === Number(r.id))) setDrawingId(String(r.id));
      } else {
        setErr(typeof r?.error === 'string' ? r.error : 'Upload failed.');
      }
    } catch (e2) {
      setErr(e2?.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function renameDrawing() {
    if (!drawingId) return;
    const cur = drawings.find((d) => Number(d.id) === Number(drawingId));
    const name = window.prompt('Rename drawing', cur?.name || '');
    if (name == null) return;
    const out = await api.renameModuleDrawing(drawingId, name);
    if (out && out.error) {
      setErr(String(out.error));
      return;
    }
    reloadDrawings();
  }

  async function deleteDrawing() {
    if (!drawingId) return;
    const cur = drawings.find((d) => Number(d.id) === Number(drawingId));
    if (!window.confirm(`Delete drawing "${cur?.name || ''}" and all its modules?\nThis cannot be undone.`)) return;
    const out = await api.deleteModuleDrawing(drawingId);
    if (out && out.error) {
      setErr(String(out.error));
      return;
    }
    setDrawingId('');
    reloadDrawings();
  }

  async function openImport() {
    setErr('');
    setImportSel(new Set());
    setImportOpen(true);
    try {
      const all = await api.getDrawings();
      const sources = (Array.isArray(all) ? all : []).filter(
        (d) => String(d.tab) !== MODULE_HANDOVER_TAB && Number(d.width) > 16 && Number(d.height) > 16
      );
      setImportSources(sources);
    } catch (e) {
      setErr(e?.message || 'Could not load drawings to import');
      setImportSources([]);
    }
  }

  async function runImport() {
    const ids = [...importSel];
    if (!ids.length) {
      setImportOpen(false);
      return;
    }
    setImportBusy(true);
    setErr('');
    try {
      let lastId = '';
      for (const id of ids) {
        const full = await api.getDrawing(id);
        if (!full || !full.image_data) continue;
        const r = await api.createModuleDrawing(
          full.name || 'Module plan',
          full.floor || 'modules',
          full.image_data,
          full.width || 0,
          full.height || 0,
          full.file_url || null
        );
        if (r && r.error) {
          setErr(String(r.error));
          break;
        }
        if (r && r.id) lastId = String(r.id);
      }
      const list = await reloadDrawings();
      if (lastId && list.some((d) => Number(d.id) === Number(lastId))) setDrawingId(lastId);
      setImportOpen(false);
    } catch (e) {
      setErr(e?.message || 'Import failed');
    } finally {
      setImportBusy(false);
    }
  }

  const otherDrawings = useMemo(
    () => drawings.filter((d) => Number(d.id) !== Number(drawingId)),
    [drawings, drawingId]
  );

  function openCopy() {
    setErr('');
    setCopyTargetId(otherDrawings[0]?.id ? String(otherDrawings[0].id) : '');
    setCopyOffset(100);
    setCopyOpen(true);
  }

  /** Shift the first run of digits in a module name (e.g. "119" + 100 → "219", "M-101" → "M-201"). */
  function renumberName(name, offset) {
    const s = String(name || '');
    if (!offset) return s;
    const m = s.match(/\d+/);
    if (!m) return s;
    const next = parseInt(m[0], 10) + Number(offset);
    return s.slice(0, m.index) + next + s.slice(m.index + m[0].length);
  }

  async function runCopy() {
    const targetId = copyTargetId;
    if (!targetId || !zones.length) {
      setCopyOpen(false);
      return;
    }
    setCopyBusy(true);
    setErr('');
    try {
      const off = Number(copyOffset) || 0;
      for (let i = 0; i < zones.length; i++) {
        setCopyProgress({ cur: i, total: zones.length });
        const z = zones[i];
        const g = parseZoneGeometry(z);
        if (!g) continue;
        const newName = renumberName(z.name, off).trim() || 'Module';
        const out = await api.addModuleZone(targetId, newName, '', g);
        if (out && out.error) {
          setErr(String(out.error));
          break;
        }
      }
      setCopyOpen(false);
      setDrawingId(String(targetId));
    } catch (e) {
      setErr(e?.message || 'Copy failed');
    } finally {
      setCopyBusy(false);
      setCopyProgress(null);
    }
  }

  function clientToPct(clientX, clientY) {
    const el = wrapRef.current;
    if (!el) return [0, 0];
    const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / Math.max(r.width, 1)) * 100;
    const y = ((clientY - r.top) / Math.max(r.height, 1)) * 100;
    return [Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))];
  }

  // Reset zoom/pan whenever the drawing changes or we switch view/draw tools.
  useEffect(() => {
    setView({ scale: 1, tx: 0, ty: 0 });
    setPanMode(false);
  }, [drawingId, tool]);

  // Scroll-to-zoom on the draw canvas (active listener so we can preventDefault).
  useEffect(() => {
    if (tool !== 'draw') return undefined;
    const vp = viewportRef.current;
    if (!vp || !drawing?.image_data) return undefined;
    const handler = (e) => {
      e.preventDefault();
      const vr = vp.getBoundingClientRect();
      const mx = e.clientX - vr.left;
      const my = e.clientY - vr.top;
      const delta = e.deltaY > 0 ? -0.12 : 0.12;
      setView((v) => {
        const next = clampDrawScale(v.scale + delta);
        const cx = (mx - v.tx) / v.scale;
        const cy = (my - v.ty) / v.scale;
        return { scale: next, tx: mx - cx * next, ty: my - cy * next };
      });
    };
    vp.addEventListener('wheel', handler, { passive: false });
    return () => vp.removeEventListener('wheel', handler);
  }, [tool, drawing]);

  const zoomDraw = useCallback((delta) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vr = vp.getBoundingClientRect();
    const mx = vr.width / 2;
    const my = vr.height / 2;
    setView((v) => {
      const next = clampDrawScale(v.scale + delta);
      const cx = (mx - v.tx) / v.scale;
      const cy = (my - v.ty) / v.scale;
      return { scale: next, tx: mx - cx * next, ty: my - cy * next };
    });
  }, []);

  const resetDrawView = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), []);

  const onPanMouseDown = useCallback((e) => {
    panDragRef.current = { lastX: e.clientX, lastY: e.clientY };
    setPanning(true);
    const onMove = (ev) => {
      if (!panDragRef.current) return;
      const dx = ev.clientX - panDragRef.current.lastX;
      const dy = ev.clientY - panDragRef.current.lastY;
      panDragRef.current.lastX = ev.clientX;
      panDragRef.current.lastY = ev.clientY;
      setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    };
    const onUp = () => {
      panDragRef.current = null;
      setPanning(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const clamp01 = (v) => Math.max(0, Math.min(100, v));

  const selectForEdit = useCallback((z) => {
    const g = parseZoneGeometry(z);
    if (!g) return;
    const copy = JSON.parse(JSON.stringify(g));
    editIdRef.current = Number(z.id);
    setEditId(Number(z.id));
    setEditGeom(copy);
    editGeomRef.current = copy;
  }, []);

  const persistEdit = useCallback(
    async (geom, id) => {
      if (!id || !geom) return;
      const out = await api.updateModuleZone(Number(id), { geometry: geom });
      if (out && out.error) setErr(String(out.error));
      reloadZones(drawingId);
    },
    [drawingId, reloadZones]
  );

  const onEditDragMove = useCallback((ev) => {
    const d = editDragRef.current;
    if (!d) return;
    const [cx, cy] = clientToPct(ev.clientX, ev.clientY);
    const dx = cx - d.start[0];
    const dy = cy - d.start[1];
    const orig = d.orig;
    let next;
    if (orig.kind === 'poly') {
      const pts = orig.points.map((p) => [...p]);
      if (d.mode === 'move') {
        next = { kind: 'poly', points: pts.map((p) => [clamp01(p[0] + dx), clamp01(p[1] + dy)]) };
      } else if (d.mode === 'vertex' && d.index != null) {
        pts[d.index] = [clamp01(cx), clamp01(cy)];
        next = { kind: 'poly', points: pts };
      } else {
        next = orig;
      }
    } else {
      let { x, y, w, h } = orig;
      if (d.mode === 'move') {
        x = clamp01(x + dx);
        y = clamp01(y + dy);
        // keep the box inside the plate
        x = Math.min(x, 100 - w);
        y = Math.min(y, 100 - h);
        next = { kind: 'rect', x, y, w, h };
      } else if (d.mode === 'corner') {
        const left = d.corner === 'nw' || d.corner === 'sw' ? clamp01(cx) : x;
        const right = d.corner === 'ne' || d.corner === 'se' ? clamp01(cx) : x + w;
        const top = d.corner === 'nw' || d.corner === 'ne' ? clamp01(cy) : y;
        const bottom = d.corner === 'sw' || d.corner === 'se' ? clamp01(cy) : y + h;
        const nx = Math.min(left, right);
        const ny = Math.min(top, bottom);
        next = { kind: 'rect', x: nx, y: ny, w: Math.max(0.8, Math.abs(right - left)), h: Math.max(0.8, Math.abs(bottom - top)) };
      } else {
        next = orig;
      }
    }
    editGeomRef.current = next;
    setEditGeom(next);
  }, []);

  const onEditDragUp = useCallback(() => {
    window.removeEventListener('mousemove', onEditDragMove);
    window.removeEventListener('mouseup', onEditDragUp);
    const d = editDragRef.current;
    editDragRef.current = null;
    if (!d) return;
    persistEdit(editGeomRef.current, d.id);
  }, [onEditDragMove, persistEdit]);

  const beginEditDrag = useCallback(
    (e, mode, extra) => {
      e.stopPropagation();
      e.preventDefault();
      const base = editGeomRef.current;
      if (!base) return;
      const start = clientToPct(e.clientX, e.clientY);
      editDragRef.current = {
        mode,
        ...(extra || {}),
        start,
        id: editIdRef.current,
        orig: JSON.parse(JSON.stringify(base)),
      };
      window.addEventListener('mousemove', onEditDragMove);
      window.addEventListener('mouseup', onEditDragUp);
    },
    [onEditDragMove, onEditDragUp]
  );

  // Leaving edit mode / changing drawing clears the active selection.
  useEffect(() => {
    if (!editMode) {
      setEditId(null);
      setEditGeom(null);
      editGeomRef.current = null;
      editIdRef.current = null;
    }
  }, [editMode]);
  useEffect(() => {
    setEditMode(false);
  }, [drawingId, tool]);

  const onDrawMove = useCallback((ev) => {
    if (!drawingRef.current) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / Math.max(r.width, 1)) * 100;
    const y = ((ev.clientY - r.top) / Math.max(r.height, 1)) * 100;
    setRectDraft((d) => (d ? { ...d, w: Math.max(0, Math.min(100, x)) - d.x, h: Math.max(0, Math.min(100, y)) - d.y } : d));
  }, []);

  const onDrawUp = useCallback(async () => {
    window.removeEventListener('mousemove', onDrawMove);
    window.removeEventListener('mouseup', onDrawUp);
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setRectDraft((cur) => {
      if (!cur) return null;
      let { x, y, w, h } = cur;
      if (w < 0) {
        x += w;
        w = -w;
      }
      if (h < 0) {
        y += h;
        h = -h;
      }
      if (w < 1.2 || h < 1.2) return null;
      const name = window.prompt('Module name (e.g. M-101)', '');
      if (name == null) return null;
      const geometry = { kind: 'rect', x, y, w, h };
      api
        .addModuleZone(drawingId, name.trim() || 'Module', '', geometry)
        .then((out) => {
          if (out && out.error) setErr(String(out.error));
          else reloadZones(drawingId);
        });
      return null;
    });
  }, [drawingId, onDrawMove, reloadZones]);

  const commitPoly = useCallback(
    (pts) => {
      if (!pts || pts.length < 3) {
        setPolyPts([]);
        setPolyHover(null);
        return;
      }
      const name = window.prompt('Module name (e.g. M-101)', '');
      setPolyPts([]);
      setPolyHover(null);
      if (name == null) return;
      const geometry = { kind: 'poly', points: pts };
      api.addModuleZone(drawingId, name.trim() || 'Module', '', geometry).then((out) => {
        if (out && out.error) setErr(String(out.error));
        else reloadZones(drawingId);
      });
    },
    [drawingId, reloadZones]
  );

  async function runAutoDetect() {
    if (!drawing?.image_data || !canManage || detectBusy) return;
    setDetectErr('');
    setDetectBusy(true);
    setDetectProgress({ phase: 'detect', cur: 0, total: 1 });
    try {
      const mods = await autoDetectModules(drawing.image_data, {
        onProgress: (phase, cur, total) => setDetectProgress({ phase, cur, total }),
      });
      // Ignore candidates that land on a module already drawn — only surface what's still missing.
      const existing = zones
        .map((z) => geomBBox(parseZoneGeometry(z), z))
        .filter((b) => b && b.w > 0 && b.h > 0);
      const overlapsExisting = (m) => {
        for (const b of existing) {
          const x1 = Math.max(m.x, b.x);
          const y1 = Math.max(m.y, b.y);
          const x2 = Math.min(m.x + m.w, b.x + b.w);
          const y2 = Math.min(m.y + m.h, b.y + b.h);
          if (x2 > x1 && y2 > y1) {
            const inter = (x2 - x1) * (y2 - y1);
            if (inter / Math.max(1e-6, m.w * m.h) > 0.25) return true;
          }
        }
        return false;
      };
      const fresh = mods.filter((m) => !overlapsExisting(m));
      if (!mods.length) {
        setDetectErr('No module boxes were detected. Try the manual Box/Polygon tools, or upload a cleaner plan.');
      } else if (!fresh.length) {
        setDetectErr('Every detected box overlaps a module you have already drawn — nothing new to add.');
      } else {
        setReview(fresh.map((m) => ({ ...m, include: true, name: m.name || '' })));
      }
    } catch (e) {
      setDetectErr(e?.message || 'Auto-detect failed (the detection libraries may be blocked). Use the manual tools.');
    } finally {
      setDetectBusy(false);
      setDetectProgress(null);
    }
  }

  async function createReviewed() {
    if (!review) return;
    const sel = review.filter((r) => r.include);
    if (!sel.length) {
      setReview(null);
      return;
    }
    setDetectBusy(true);
    try {
      for (let i = 0; i < sel.length; i++) {
        const r = sel[i];
        setDetectProgress({ phase: 'create', cur: i, total: sel.length });
        const geometry = { kind: 'rect', x: r.x, y: r.y, w: r.w, h: r.h };
        const out = await api.addModuleZone(drawingId, (r.name || '').trim() || `Module ${i + 1}`, '', geometry);
        if (out && out.error) {
          setErr(String(out.error));
          break;
        }
      }
      await reloadZones(drawingId);
      setReview(null);
    } finally {
      setDetectBusy(false);
      setDetectProgress(null);
    }
  }

  function onPlateMouseDown(e) {
    if (tool !== 'draw' || !canManage || !drawing?.image_data) return;
    if (editMode && e.button !== 1) return; // shapes/handles handle their own drags
    // Pan instead of draw when Pan mode is on or the middle mouse button is used.
    if (panMode || e.button === 1) {
      e.preventDefault();
      onPanMouseDown(e);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const [x, y] = clientToPct(e.clientX, e.clientY);
    if (drawShape === 'poly') {
      if (polyPts.length >= 3) {
        const el = wrapRef.current;
        const r = el?.getBoundingClientRect();
        if (r) {
          const [fx, fy] = polyPts[0];
          const fxClient = r.left + (fx / 100) * r.width;
          const fyClient = r.top + (fy / 100) * r.height;
          if (Math.hypot(e.clientX - fxClient, e.clientY - fyClient) <= 12) {
            commitPoly(polyPts);
            return;
          }
        }
      }
      setPolyPts((p) => [...p, [x, y]]);
      return;
    }
    drawingRef.current = true;
    setRectDraft({ x, y, w: 0, h: 0 });
    window.addEventListener('mousemove', onDrawMove);
    window.addEventListener('mouseup', onDrawUp);
  }

  function onPlateMouseMove(e) {
    if (tool !== 'draw' || drawShape !== 'poly' || panMode || editMode) return;
    const [x, y] = clientToPct(e.clientX, e.clientY);
    setPolyHover([x, y]);
  }

  function onPlateDoubleClick() {
    if (editMode) return;
    if (tool === 'draw' && drawShape === 'poly' && polyPts.length >= 3) commitPoly(polyPts);
  }

  async function setStage(stageKey) {
    if (!selected || !canManage) return;
    const id = Number(selected.id);
    setZones((zs) => zs.map((z) => (Number(z.id) === id ? { ...z, handover_stage: stageKey } : z)));
    const out = await api.setModuleStage(id, stageKey);
    if (out && out.error) {
      setErr(String(out.error));
      reloadZones(drawingId);
    }
  }

  async function renameModule() {
    if (!selected || !canManage) return;
    const name = window.prompt('Rename module', selected.name || '');
    if (name == null) return;
    const out = await api.updateModuleZone(Number(selected.id), { name: name.trim() || selected.name });
    if (out && out.error) setErr(String(out.error));
    else reloadZones(drawingId);
  }

  async function deleteModuleById(zone) {
    if (!zone || !canManage) return;
    if (!window.confirm(`Delete module "${zone.name}"?`)) return;
    const out = await api.deleteModuleZone(Number(zone.id));
    if (out && out.error) setErr(String(out.error));
    else {
      if (Number(selId) === Number(zone.id)) setSelId(null);
      if (Number(editId) === Number(zone.id)) {
        setEditId(null);
        setEditGeom(null);
        editGeomRef.current = null;
        editIdRef.current = null;
      }
      reloadZones(drawingId);
    }
  }

  function deleteModule() {
    return deleteModuleById(selected);
  }

  const styleForZone = useCallback(
    (z) => {
      const meta = moduleStageMeta(z.handover_stage);
      const isSel = Number(z.id) === Number(selId);
      return {
        fill: meta.fill,
        // Subtle selection: a slightly crisper accent outline, not a heavy halo.
        stroke: isSel ? 'rgba(36, 68, 140, 0.95)' : meta.stroke,
        strokeW: isSel ? 1.0 : 0.6,
      };
    },
    [selId]
  );

  const labelForZone = useCallback((z) => String(z.name || '').trim(), []);

  const legend = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        padding: '10px 12px',
        background: T.surface,
        border: `1px solid ${T.hairline}`,
        borderRadius: 10,
        marginTop: 10,
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Stages (handover &amp; programme)
      </span>
      {MODULE_STAGES.map((s) => (
        <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text, fontWeight: 600 }}>
          <span style={{ width: 14, height: 14, borderRadius: 3, background: s.swatch, border: `1px solid ${s.stroke}` }} />
          {s.label}
        </span>
      ))}
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 0 0' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px 12px' }}>
      <PageHeader
        collapsible
        collapsibleSummary={[drawing?.name || 'No drawing'].filter(Boolean)}
        title="Modules"
        filters={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: T.muted }}>Drawing</label>
            <select
              value={drawingId}
              onChange={(e) => setDrawingId(e.target.value)}
              style={{ ...S.input, padding: '7px 10px', fontSize: 13, minWidth: 180 }}
            >
              {!drawings.length && <option value="">No drawing</option>}
              {drawings.map((d) => (
                <option key={d.id} value={String(d.id)}>
                  {d.name}
                </option>
              ))}
            </select>
            {drawing?.image_data && (
              <div style={{ display: 'inline-flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    setTool('view');
                    setRectDraft(null);
                    setPolyPts([]);
                    setPolyHover(null);
                  }}
                  style={{ ...S.btn, ...(tool === 'view' ? S.btnAct : {}), padding: '7px 12px', fontSize: 12 }}
                >
                  View / set stage
                </button>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => {
                      setTool('draw');
                      setSelId(null);
                    }}
                    style={{ ...S.btn, ...(tool === 'draw' ? S.btnAct : {}), padding: '7px 12px', fontSize: 12 }}
                  >
                    + Add modules
                  </button>
                )}
                {canManage && (
                  <button
                    type="button"
                    onClick={runAutoDetect}
                    disabled={detectBusy}
                    title="Detect module boxes and read their numbers, then review before adding"
                    style={{ ...S.btn, padding: '7px 12px', fontSize: 12, opacity: detectBusy ? 0.6 : 1 }}
                  >
                    {detectBusy
                      ? detectProgress?.phase === 'ocr'
                        ? `Reading numbers ${detectProgress.cur}/${detectProgress.total}…`
                        : detectProgress?.phase === 'create'
                        ? `Adding ${detectProgress.cur}/${detectProgress.total}…`
                        : 'Detecting…'
                      : '✨ Auto-detect modules'}
                  </button>
                )}
                {tool === 'draw' && canManage && (
                  <div style={{ display: 'inline-flex', gap: 4, marginLeft: 4 }}>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawShape('rect');
                        setPanMode(false);
                        setEditMode(false);
                        setPolyPts([]);
                        setPolyHover(null);
                      }}
                      style={{ ...S.btn, ...(drawShape === 'rect' && !panMode && !editMode ? S.btnAct : {}), padding: '7px 10px', fontSize: 12 }}
                    >
                      ▭ Box
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawShape('poly');
                        setPanMode(false);
                        setEditMode(false);
                        setRectDraft(null);
                      }}
                      style={{ ...S.btn, ...(drawShape === 'poly' && !panMode && !editMode ? S.btnAct : {}), padding: '7px 10px', fontSize: 12 }}
                    >
                      ⬡ Polygon
                    </button>
                    <button
                      type="button"
                      title="Click a module, then drag its handles to resize/reshape, or drag the middle to move it"
                      onClick={() => {
                        setEditMode((p) => !p);
                        setPanMode(false);
                        setRectDraft(null);
                        setPolyPts([]);
                        setPolyHover(null);
                      }}
                      style={{ ...S.btn, ...(editMode ? S.btnAct : {}), padding: '7px 10px', fontSize: 12 }}
                    >
                      ✎ Adjust
                    </button>
                    <button
                      type="button"
                      title="Drag to move around the plan (scroll or +/− to zoom)"
                      onClick={() => {
                        setPanMode((p) => !p);
                        setEditMode(false);
                        setRectDraft(null);
                        setPolyPts([]);
                        setPolyHover(null);
                      }}
                      style={{ ...S.btn, ...(panMode ? S.btnAct : {}), padding: '7px 10px', fontSize: 12 }}
                    >
                      ✋ Pan
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        }
        actions={
          canManage ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ ...S.btn, ...S.btnPrimary, padding: '8px 14px', fontSize: 12, cursor: 'pointer' }}>
                {busy ? 'Uploading…' : drawing?.image_data ? 'Replace / add drawing' : 'Upload drawing'}
                <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={handleUpload} disabled={busy} />
              </label>
              <button type="button" onClick={openImport} style={{ ...S.btn, padding: '8px 14px', fontSize: 12 }}>
                Import from Internals
              </button>
              {drawingId && zones.length > 0 && otherDrawings.length > 0 && (
                <button type="button" onClick={openCopy} style={{ ...S.btn, padding: '8px 14px', fontSize: 12 }} title="Copy these modules onto another floor's drawing">
                  Copy modules → floor
                </button>
              )}
              {drawingId && (
                <>
                  <button type="button" onClick={renameDrawing} style={{ ...S.btn, padding: '8px 14px', fontSize: 12 }}>
                    Rename
                  </button>
                  <button type="button" onClick={deleteDrawing} style={{ ...S.btn, padding: '8px 14px', fontSize: 12, color: '#b3261e' }}>
                    Delete drawing
                  </button>
                </>
              )}
            </div>
          ) : null
        }
      />

      {err && (
        <div style={{ margin: '10px 0', padding: '8px 12px', background: 'rgba(179,38,30,0.08)', border: '1px solid rgba(179,38,30,0.3)', borderRadius: 8, color: '#b3261e', fontSize: 13 }}>
          {err}
          <button type="button" onClick={() => setErr('')} style={{ ...S.btn, marginLeft: 10, padding: '2px 8px', fontSize: 11 }}>
            Dismiss
          </button>
        </div>
      )}
      {detectErr && (
        <div style={{ margin: '10px 0', padding: '8px 12px', background: 'rgba(230,108,0,0.08)', border: '1px solid rgba(230,108,0,0.32)', borderRadius: 8, color: '#9a5b00', fontSize: 13 }}>
          {detectErr}
          <button type="button" onClick={() => setDetectErr('')} style={{ ...S.btn, marginLeft: 10, padding: '2px 8px', fontSize: 11 }}>
            Dismiss
          </button>
        </div>
      )}

      {!drawing?.image_data ? (
        <div style={{ ...card, padding: 40, textAlign: 'center', color: T.faint, fontSize: 14, marginTop: 12 }}>
          {canManage ? 'Upload a plan to start placing modules.' : 'No module handover drawing has been set up yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 14, marginTop: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 520px', minWidth: 280 }}>
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              {tool === 'draw' ? (
                <div
                  ref={viewportRef}
                  onMouseDown={onPlateMouseDown}
                  onMouseMove={onPlateMouseMove}
                  onDoubleClick={onPlateDoubleClick}
                  style={{
                    position: 'relative',
                    width: '100%',
                    minHeight: 'min(70vh, 620px)',
                    overflow: 'hidden',
                    background: '#ececf1',
                    cursor: panMode ? (panning ? 'grabbing' : 'grab') : 'crosshair',
                    userSelect: 'none',
                    touchAction: 'none',
                  }}
                >
                  <div
                    ref={wrapRef}
                    style={{
                      position: 'relative',
                      width: '100%',
                      transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
                      transformOrigin: '0 0',
                      willChange: 'transform',
                    }}
                  >
                  <img
                    alt="Module plan"
                    src={`data:image/jpeg;base64,${drawing.image_data}`}
                    draggable={false}
                    style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none' }}
                  />
                  <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100" preserveAspectRatio="none">
                    {zones.map((z) => {
                      const isEditing = editMode && Number(z.id) === Number(editId);
                      const g = isEditing && editGeom ? editGeom : parseZoneGeometry(z);
                      if (!g) return null;
                      const meta = moduleStageMeta(z.handover_stage);
                      const shapeProps = {
                        fill: meta.fill,
                        stroke: isEditing ? 'rgba(36,68,140,0.95)' : meta.stroke,
                        strokeWidth: isEditing ? 0.7 * handleScale : 0.6,
                        style: { cursor: editMode ? 'move' : 'default' },
                        onMouseDown: editMode
                          ? (e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              if (Number(editIdRef.current) !== Number(z.id)) selectForEdit(z);
                              beginEditDrag(e, 'move');
                            }
                          : undefined,
                      };
                      if (g.kind === 'poly') {
                        return <polygon key={z.id} points={svgPolygonPoints(g)} {...shapeProps} />;
                      }
                      return <rect key={z.id} x={g.x} y={g.y} width={g.w} height={g.h} {...shapeProps} />;
                    })}
                    {editMode && editGeom && editGeom.kind === 'rect' && (
                      <>
                        {[
                          { c: 'nw', x: editGeom.x, y: editGeom.y },
                          { c: 'ne', x: editGeom.x + editGeom.w, y: editGeom.y },
                          { c: 'se', x: editGeom.x + editGeom.w, y: editGeom.y + editGeom.h },
                          { c: 'sw', x: editGeom.x, y: editGeom.y + editGeom.h },
                        ].map((h) => (
                          <circle
                            key={h.c}
                            cx={h.x}
                            cy={h.y}
                            r={0.9 * handleScale}
                            fill="#fff"
                            stroke="rgba(36,68,140,0.95)"
                            strokeWidth={0.45 * handleScale}
                            style={{ cursor: 'crosshair' }}
                            onMouseDown={(e) => beginEditDrag(e, 'corner', { corner: h.c })}
                          />
                        ))}
                      </>
                    )}
                    {editMode && editGeom && editGeom.kind === 'poly' && (
                      <>
                        {editGeom.points.map((p, i) => (
                          <circle
                            key={`v${i}`}
                            cx={p[0]}
                            cy={p[1]}
                            r={0.9 * handleScale}
                            fill="#fff"
                            stroke="rgba(36,68,140,0.95)"
                            strokeWidth={0.45 * handleScale}
                            style={{ cursor: 'crosshair' }}
                            onMouseDown={(e) => beginEditDrag(e, 'vertex', { index: i })}
                          />
                        ))}
                      </>
                    )}
                    {rectDraft && drawShape === 'rect' && (
                      <rect
                        x={Math.min(rectDraft.x, rectDraft.x + rectDraft.w)}
                        y={Math.min(rectDraft.y, rectDraft.y + rectDraft.h)}
                        width={Math.abs(rectDraft.w)}
                        height={Math.abs(rectDraft.h)}
                        fill="rgba(66,133,244,0.22)"
                        stroke="rgba(36,68,140,1)"
                        strokeWidth={0.7}
                        strokeDasharray="1.4 1"
                      />
                    )}
                    {drawShape === 'poly' && polyPts.length > 0 && (
                      <>
                        <polyline
                          points={[...polyPts, polyHover].filter(Boolean).map((p) => `${p[0]},${p[1]}`).join(' ')}
                          fill="rgba(66,133,244,0.14)"
                          stroke="rgba(36,68,140,1)"
                          strokeWidth={0.7}
                          strokeDasharray="1.4 1"
                          strokeLinejoin="round"
                        />
                        {polyPts.map((p, i) => (
                          <circle
                            key={`${p[0]}-${p[1]}-${i}`}
                            cx={p[0]}
                            cy={p[1]}
                            r={i === 0 ? 1.1 : 0.7}
                            fill={i === 0 ? 'rgba(36,68,140,1)' : '#fff'}
                            stroke="rgba(36,68,140,1)"
                            strokeWidth={0.4}
                          />
                        ))}
                      </>
                    )}
                  </svg>
                  </div>
                  <div
                    style={{ position: 'absolute', top: 10, left: 10, zIndex: 4, display: 'flex', flexDirection: 'column', gap: 6 }}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <button type="button" title="Zoom in" style={drawZoomBtn} onClick={(e) => { e.stopPropagation(); zoomDraw(0.2); }}>+</button>
                    <button type="button" title="Zoom out" style={drawZoomBtn} onClick={(e) => { e.stopPropagation(); zoomDraw(-0.2); }}>−</button>
                    <button type="button" title="Reset view" style={{ ...drawZoomBtn, fontSize: 10 }} onClick={(e) => { e.stopPropagation(); resetDrawView(); }}>Reset</button>
                  </div>
                </div>
              ) : (
                <ZoneDrawingCanvas
                  drawing={drawing}
                  zones={zones}
                  enableZoomPan
                  allowZoneClick
                  horizontalLabels
                  coarsePointer={coarse}
                  minHeight="min(70vh, 620px)"
                  styleForZone={styleForZone}
                  labelForZone={labelForZone}
                  labelActiveForZone={() => true}
                  onZoneClick={(z) => setSelId(Number(z.id))}
                  emptyMessage="No drawing selected."
                />
              )}
            </div>
            {tool === 'draw' && (
              <div style={{ marginTop: 8, fontSize: 12, color: T.muted, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {editMode ? (
                  <span>Adjust mode: click a module, then drag its white handles to resize/reshape, or drag the middle to move it. Changes save automatically.</span>
                ) : panMode ? (
                  <span>Pan mode: drag to move around. Scroll or use +/− to zoom. Pick Box or Polygon to draw again.</span>
                ) : drawShape === 'rect' ? (
                  <span>Drag a box around each module, then name it. Scroll to zoom; use ✋ Pan (or middle-drag) to move.</span>
                ) : (
                  <span>Click to drop each corner; click the first point (or double-click) to close. Scroll to zoom; use ✋ Pan to move.</span>
                )}
                {drawShape === 'poly' && polyPts.length > 0 && (
                  <>
                    <button type="button" onClick={() => commitPoly(polyPts)} disabled={polyPts.length < 3} style={{ ...S.btn, ...S.btnPrimary, padding: '5px 10px', fontSize: 11, opacity: polyPts.length < 3 ? 0.5 : 1 }}>
                      Finish module
                    </button>
                    <button type="button" onClick={() => { setPolyPts([]); setPolyHover(null); }} style={{ ...S.btn, padding: '5px 10px', fontSize: 11 }}>
                      Cancel
                    </button>
                  </>
                )}
              </div>
            )}
            {legend}
          </div>

          <div style={{ flex: '0 0 280px', minWidth: 240, maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ ...card, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Handover progress
              </div>
              <div style={{ fontSize: 11, color: T.faint, marginTop: 4, lineHeight: 1.4 }}>
                Same stage names and colours as Module Programme — schedule on Programme, track live stage here.
              </div>
              <div style={{ fontSize: 30, fontWeight: 800, color: T.text, marginTop: 6 }}>{summary.pct}%</div>
              <div style={{ fontSize: 13, color: T.muted }}>
                {summary.handed} of {summary.total} modules handed over
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {MODULE_STAGES.map((s) => (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: T.text }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 11, height: 11, borderRadius: 3, background: s.swatch, border: `1px solid ${s.stroke}` }} />
                      {s.label}
                    </span>
                    <span style={{ fontWeight: 700, textAlign: 'right' }}>
                      {summary.byStage[s.key] || 0}
                      {programmeTodayByStageLabel[s.label] > 0 && (
                        <span style={{ fontWeight: 600, color: T.faint, marginLeft: 6 }}>
                          · {programmeTodayByStageLabel[s.label]} prog.
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {canManage && (
              <div style={{ ...card, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Apply module programme
                </div>
                <div style={{ fontSize: 11, color: T.faint, marginTop: 4, lineHeight: 1.45 }}>
                  Bulk-schedule all L1–L5 modules with the Module Completion template (11 activities, 12 days) in your floor-plan order — pod → right stack → corridor zigzag → inner → far-left; Level 5 corridor then left wing.
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: T.text, lineHeight: 1.5 }}>
                  {programmePreview?.total ? (
                    <>
                      <strong>{programmePreview.total}</strong> modules matched
                      <span style={{ color: T.muted }}> · Mon 22 Jun 2026 start · 5/day Mon–Sat</span>
                    </>
                  ) : programmePreview === null ? (
                    <span style={{ color: T.muted }}>Could not load preview — check you are logged in as admin.</span>
                  ) : (
                    <span style={{ color: T.muted }}>No modules matched — add module zones on the floor plans first.</span>
                  )}
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    disabled={programmeApplyBusy || !programmePreview?.total}
                    onClick={() => void applyL1L5Programme()}
                    style={{ ...S.btn, ...S.btnPrimary, padding: '8px 14px', fontSize: 12, opacity: programmeApplyBusy ? 0.65 : 1 }}
                  >
                    {programmeApplyBusy ? 'Applying…' : 'Apply L1–L5 programme'}
                  </button>
                  <button
                    type="button"
                    disabled={programmeApplyBusy}
                    onClick={() => void reloadProgrammeOrderPreview()}
                    style={{ ...S.btn, padding: '8px 12px', fontSize: 12 }}
                  >
                    Refresh preview
                  </button>
                </div>
              </div>
            )}

            {canManage && (
              <div style={{ ...card, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  W/C Air and Sound
                </div>
                <div style={{ fontSize: 11, color: T.faint, marginTop: 4, lineHeight: 1.45 }}>
                  One-off module programme entries — one coloured box on the Monday of each week (w/c 20 Jul, 27 Jul, 10 Aug, 24 Aug smoke shafts, 31 Aug, 7 Sep T3).
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: T.text, lineHeight: 1.5 }}>
                  {airSoundPreview?.total_items ? (
                    <>
                      <strong>{airSoundPreview.total_items}</strong> one-day items across{' '}
                      {airSoundPreview.weeks?.filter((w) => w.zone_count > 0).length || 0} week(s)
                    </>
                  ) : airSoundPreview === null ? (
                    <span style={{ color: T.muted }}>Could not load preview.</span>
                  ) : (
                    <span style={{ color: T.muted }}>No modules matched — check module zone names and towers.</span>
                  )}
                </div>
                {airSoundPreview?.weeks?.length > 0 && (
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11, color: T.muted, lineHeight: 1.45 }}>
                    {airSoundPreview.weeks.map((w) => (
                      <li key={w.week_start}>
                        {w.label}: {w.zone_count} module(s) · {w.week_start}
                      </li>
                    ))}
                  </ul>
                )}
                <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <button
                    type="button"
                    disabled={airSoundApplyBusy || !airSoundPreview?.total_items}
                    onClick={() => void applyAirSoundProgramme()}
                    style={{ ...S.btn, ...S.btnPrimary, padding: '8px 14px', fontSize: 12, opacity: airSoundApplyBusy ? 0.65 : 1 }}
                  >
                    {airSoundApplyBusy ? 'Applying…' : 'Apply W/C Air and Sound'}
                  </button>
                  <button
                    type="button"
                    disabled={airSoundApplyBusy}
                    onClick={() => void reloadAirSoundPreview()}
                    style={{ ...S.btn, padding: '8px 12px', fontSize: 12 }}
                  >
                    Refresh preview
                  </button>
                </div>
              </div>
            )}

            {completionCounts && (
              <div style={{ ...card, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Module Completion programme
                </div>
                <div style={{ fontSize: 11, color: T.faint, marginTop: 4, lineHeight: 1.4 }}>
                  Read-only mirror — where each module sits in its 12-day schedule as of {completionProgress?.today || todayKey}.
                </div>
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {MODULE_COMPLETION_SEQUENCE.map((label) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: T.text }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 11, height: 11, borderRadius: 3, background: actColor(label, 0.88), border: `1px solid ${actColor(label, 1)}` }} />
                        {label}
                      </span>
                      <span style={{ fontWeight: 700 }}>{completionCounts[label] || 0}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: T.text, marginTop: 4, paddingTop: 6, borderTop: `1px solid ${T.hairline}` }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 11, height: 11, borderRadius: 3, background: 'rgba(176,183,194,0.35)', border: '1px solid rgba(96,104,116,0.45)' }} />
                      Not yet started
                    </span>
                    <span style={{ fontWeight: 700 }}>{completionCounts.not_yet_started || 0}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: T.text }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 11, height: 11, borderRadius: 3, background: actColor('Commission', 0.88), border: `1px solid ${actColor('Commission', 1)}` }} />
                      Completed
                    </span>
                    <span style={{ fontWeight: 700 }}>{completionCounts.completed || 0}</span>
                  </div>
                </div>
              </div>
            )}

            {zones.length > 0 && (
              <div style={{ ...card, padding: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                  Modules ({zones.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' }}>
                  {[...zones]
                    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }))
                    .map((z) => {
                      const meta = moduleStageMeta(z.handover_stage);
                      const prog = programmeTodayByZone.get(Number(z.id));
                      const isSel = Number(z.id) === Number(selected?.id);
                      return (
                        <div
                          key={z.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '5px 8px',
                            borderRadius: 7,
                            background: isSel ? 'rgba(36,68,140,0.08)' : 'transparent',
                            border: `1px solid ${isSel ? 'rgba(36,68,140,0.35)' : 'transparent'}`,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setSelId(Number(z.id));
                              if (editMode) setEditId(Number(z.id));
                            }}
                            style={{
                              flex: 1,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontSize: 13,
                              color: T.text,
                              fontWeight: isSel ? 800 : 600,
                            }}
                          >
                            <span style={{ width: 11, height: 11, borderRadius: 3, background: meta.swatch || meta.fill, border: `1px solid ${meta.stroke}`, flex: '0 0 auto' }} />
                            <span style={{ minWidth: 0, flex: 1 }}>
                              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.name}</span>
                              {prog?.activity_name && (
                                <span style={{ display: 'block', fontSize: 10, color: T.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  Programme: {prog.activity_name}
                                </span>
                              )}
                            </span>
                          </button>
                          {canManage && (
                            <button
                              type="button"
                              title={`Delete module "${z.name}"`}
                              onClick={() => deleteModuleById(z)}
                              style={{ ...S.btn, padding: '2px 8px', fontSize: 12, color: '#b3261e', flex: '0 0 auto' }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {selected ? (
              <div style={{ ...card, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{selected.name}</div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelId(null);
                      setEditId(null);
                      setEditGeom(null);
                      editGeomRef.current = null;
                      editIdRef.current = null;
                    }}
                    style={{ ...S.btn, padding: '2px 8px', fontSize: 11 }}
                  >
                    Close
                  </button>
                </div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
                  Current: <strong style={{ color: T.text }}>{moduleStageMeta(selected.handover_stage).label}</strong>
                </div>
                {canManage ? (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 12 }}>
                      Set stage
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                      {MODULE_STAGES.map((s) => {
                        const active = normalizeModuleStage(selected.handover_stage) === s.key;
                        return (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => setStage(s.key)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 10px',
                              borderRadius: 8,
                              border: active ? `2px solid ${s.stroke}` : `1px solid ${T.hairline}`,
                              background: active ? s.fill : '#fff',
                              color: T.text,
                              fontSize: 13,
                              fontWeight: active ? 800 : 600,
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span style={{ width: 13, height: 13, borderRadius: 3, background: s.swatch, border: `1px solid ${s.stroke}`, flex: '0 0 auto' }} />
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button type="button" onClick={renameModule} style={{ ...S.btn, padding: '7px 12px', fontSize: 12 }}>
                        Rename
                      </button>
                      <button type="button" onClick={deleteModule} style={{ ...S.btn, padding: '7px 12px', fontSize: 12, color: '#b3261e' }}>
                        Delete
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <div style={{ ...card, padding: 14, fontSize: 13, color: T.muted }}>
                {tool === 'draw'
                  ? editMode
                    ? 'Click a module to move/resize it, rename or delete it.'
                    : 'Drag on the plan to add a module. Use ✎ Adjust to move, rename or delete one.'
                  : 'Tap a module on the plan to see its handover stage.'}
              </div>
            )}
          </div>
        </div>
      )}

      {importOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,18,28,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ ...card, width: 'min(560px, 96vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.hairline}` }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>Import drawings into Modules</div>
              <div style={{ fontSize: 12, color: T.muted }}>Copies the plan image (Ground–5th floor etc.) into Module Handover so you can box modules on it.</div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 12, minHeight: 80 }}>
              {!importSources.length ? (
                <div style={{ fontSize: 13, color: T.muted, padding: 12 }}>No other drawings available to import.</div>
              ) : (
                importSources.map((d) => {
                  const checked = importSel.has(d.id);
                  return (
                    <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: `1px solid ${T.hairline}`, cursor: 'pointer', fontSize: 13, color: T.text }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setImportSel((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(d.id); else next.delete(d.id);
                          return next;
                        })}
                      />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                      <span style={{ fontSize: 11, color: T.faint, flex: '0 0 auto' }}>{drawingTabLabel(d.tab)}</span>
                    </label>
                  );
                })
              )}
            </div>
            <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.hairline}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setImportOpen(false)} disabled={importBusy} style={{ ...S.btn, padding: '7px 12px', fontSize: 12 }}>
                Cancel
              </button>
              <button type="button" onClick={runImport} disabled={importBusy || !importSel.size} style={{ ...S.btn, ...S.btnPrimary, padding: '8px 16px', fontSize: 13, opacity: importBusy ? 0.6 : 1 }}>
                {importBusy ? 'Importing…' : `Import ${importSel.size || ''} drawing${importSel.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {copyOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,18,28,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ ...card, width: 'min(480px, 96vw)', padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.hairline}` }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>Copy modules to another floor</div>
              <div style={{ fontSize: 12, color: T.muted }}>
                Copies all {zones.length} module shape{zones.length === 1 ? '' : 's'} from this drawing onto another floor. Stages reset to “Not started” on the new floor.
              </div>
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 700, color: T.muted }}>
                Copy to drawing
                <select
                  value={copyTargetId}
                  onChange={(e) => setCopyTargetId(e.target.value)}
                  style={{ ...S.input, padding: '8px 10px', fontSize: 13 }}
                >
                  {!otherDrawings.length && <option value="">No other drawing</option>}
                  {otherDrawings.map((d) => (
                    <option key={d.id} value={String(d.id)}>{d.name}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, fontWeight: 700, color: T.muted }}>
                Renumber: add to each module number
                <input
                  type="number"
                  value={copyOffset}
                  onChange={(e) => setCopyOffset(e.target.value)}
                  style={{ ...S.input, padding: '8px 10px', fontSize: 13, width: 120 }}
                />
                <span style={{ fontWeight: 500, color: T.faint }}>
                  e.g. 1st → 2nd floor use 100, 1st → 3rd use 200. Set 0 to keep names.
                  {zones[0]?.name ? ` Preview: “${zones[0].name}” → “${renumberName(zones[0].name, Number(copyOffset) || 0)}”.` : ''}
                </span>
              </label>
            </div>
            <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.hairline}`, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setCopyOpen(false)} disabled={copyBusy} style={{ ...S.btn, padding: '7px 12px', fontSize: 12 }}>
                Cancel
              </button>
              <button type="button" onClick={runCopy} disabled={copyBusy || !copyTargetId} style={{ ...S.btn, ...S.btnPrimary, padding: '8px 16px', fontSize: 13, opacity: copyBusy || !copyTargetId ? 0.6 : 1 }}>
                {copyBusy ? `Copying ${copyProgress ? `${copyProgress.cur + 1}/${copyProgress.total}` : ''}…` : `Copy ${zones.length} module${zones.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {review && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,18,28,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ ...card, width: 'min(960px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.hairline}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>Review detected modules</div>
                <div style={{ fontSize: 12, color: T.muted }}>
                  {review.filter((r) => r.include).length} of {review.length} selected. Fix any numbers, untick false boxes, then add.
                </div>
              </div>
              <button type="button" onClick={() => setReview(null)} disabled={detectBusy} style={{ ...S.btn, padding: '6px 12px', fontSize: 12 }}>
                Cancel
              </button>
            </div>
            <div style={{ display: 'flex', gap: 0, flex: 1, minHeight: 0 }}>
              <div style={{ flex: '1 1 50%', minWidth: 0, background: '#ececf1', position: 'relative', overflow: 'auto' }}>
                <div style={{ position: 'relative', width: '100%' }}>
                  <img alt="Detected modules" src={`data:image/jpeg;base64,${drawing?.image_data}`} style={{ display: 'block', width: '100%', height: 'auto' }} />
                  <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 100 100" preserveAspectRatio="none">
                    {review.map((r, i) => (
                      <g key={`rv-${i}`} opacity={r.include ? 1 : 0.25}>
                        <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(46,160,67,0.22)" stroke="rgba(27,120,45,1)" strokeWidth={0.6} />
                        <text x={r.x + r.w / 2} y={r.y + r.h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={Math.max(1.4, Math.min(r.w, r.h) * 0.4)} fontWeight="800" fill="#13371f" stroke="#fff" strokeWidth={0.12} paintOrder="stroke fill">
                          {r.name || i + 1}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>
              </div>
              <div style={{ flex: '1 1 50%', minWidth: 0, borderLeft: `1px solid ${T.hairline}`, overflow: 'auto', padding: 12 }}>
                {review.map((r, i) => (
                  <div key={`rl-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', borderBottom: `1px solid ${T.hairline}` }}>
                    <input
                      type="checkbox"
                      checked={r.include}
                      onChange={(e) => setReview((rv) => rv.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                    />
                    <span style={{ fontSize: 11, color: T.faint, width: 22, flex: '0 0 auto' }}>{i + 1}</span>
                    <input
                      type="text"
                      value={r.name}
                      placeholder="Module number"
                      onChange={(e) => setReview((rv) => rv.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      style={{ ...S.input, flex: 1, minWidth: 0, fontSize: 13, padding: '6px 8px' }}
                    />
                    <button type="button" onClick={() => setReview((rv) => rv.filter((_, j) => j !== i))} title="Remove" style={{ ...S.btn, padding: '4px 8px', fontSize: 11, color: '#b3261e' }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '12px 16px', borderTop: `1px solid ${T.hairline}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                onClick={() => setReview((rv) => rv.map((x) => ({ ...x, include: true })))}
                disabled={detectBusy}
                style={{ ...S.btn, padding: '7px 12px', fontSize: 12 }}
              >
                Select all
              </button>
              <button
                type="button"
                onClick={createReviewed}
                disabled={detectBusy || !review.some((r) => r.include)}
                style={{ ...S.btn, ...S.btnPrimary, padding: '8px 16px', fontSize: 13, opacity: detectBusy ? 0.6 : 1 }}
              >
                {detectBusy && detectProgress?.phase === 'create'
                  ? `Adding ${detectProgress.cur}/${detectProgress.total}…`
                  : `Add ${review.filter((r) => r.include).length} modules`}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
      <PageFooterHint>
        {canManage
          ? 'Upload a plan, draw each module, then set its handover stage. Board sees the live picture.'
          : 'Live view of module handover progress across the plan.'}
      </PageFooterHint>
    </div>
  );
}
