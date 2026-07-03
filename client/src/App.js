import React,{useState,useEffect,useCallback,useMemo,useRef,Component} from 'react';
import * as api from './api';
import './loginLanding.css';
import './dashboardCompletionPrint.css';
import {actColor,GW_SEQUENCE,INT_SEQUENCE,MAIN_HEADER_TAB_ORDER,PROJECT_PROGRAMME_TAB,MODULE_HANDOVER_TAB,MODULE_PROGRAMME_TAB,drawingTabLabel,drawingTabForScope,scopeForRow,buildPermittedScopeTabs,normalizeProgrammeScopeTabs,pickInitialScopeTab,dateKey,formatDate,formatShort,toHtmlDateInputValue,parseZoneNameForActivity} from './constants';
import {
  bottomNavItemsForRole,
  allowedPageIdsForRole,
  canTick as roleCanTick,
  canEditPlan as roleCanEditPlan,
  canEditZonesProgramme,
  isAdmin as roleIsAdmin,
  isBoardViewer as roleIsBoardViewer,
  isProgrammeViewer as roleIsProgrammeViewer,
  isSiteEditor as roleIsSiteEditor,
  isModulesEditor as roleIsModulesEditor,
  isScopeLocked as roleIsScopeLocked,
  canManageModules as roleCanManageModules,
} from './userPermissions';
import {T,S,shadowCard,grad} from './uiTheme';
import PageHeader, { PageFooterHint } from './PageHeader';
import ZoneSetupPage from './ZoneSetupPage';
import ProgrammePage from './ProgrammePage';
import { useRefreshOnFocus } from './useRefreshOnFocus';
import PlanPage from './PlanPage';
import ModuleHandoverPage from './ModuleHandoverPage';
import ZoneDrawingCanvas from './ZoneDrawingCanvas';
import { COMPLETION_BUCKETS, greenShadeForPct } from './completionColors';
import { drawingLevelCompletionAsOf, floorLabelFromDrawing, programmeCompletionBreakdown } from './completionStats';
import { MODULE_STAGES, MODULE_SEQUENCE, moduleStageMeta, moduleCompletionSummary } from './moduleHandover';
import { clearPrintPageSize, setPrintPageSize } from './printPage';
import { alignTemplateDurations, addCalendarDays } from './programmeSchedule';
import { calendarDaysBetween, scheduleDateKeysBetween, isNonWorkingPlanDayKey, normalizeScheduleStartKey, isProgrammeRowFullyDone } from './planUtils';
import NonWorkingAnchorDateWarning from './NonWorkingAnchorDateWarning';

/** API returns `{ error }` with HTTP 4xx/5xx instead of throwing; treat as empty payload. */
function isApiErrorPayload(x) {
  return Boolean(x && typeof x === 'object' && !Array.isArray(x) && typeof x.error === 'string');
}
function asScheduleMap(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  if (isApiErrorPayload(x)) return {};
  return x;
}
function asCompletionsMap(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {};
  if (isApiErrorPayload(x)) return {};
  return x;
}

class AppErrorBoundary extends Component{
  constructor(p){super(p);this.state={err:null};}
  static getDerivedStateFromError(err){return{err};}
  componentDidCatch(err,info){console.error(err,info);}
  render(){
    if(this.state.err)return<div style={{minHeight:'100vh',background:T.bg,padding:24,fontFamily:'Segoe UI,sans-serif'}}>
      <h1 style={{color:'#c0392b',fontSize:22}}>Something went wrong</h1>
      <p style={{color:T.text,maxWidth:520}}>The app stopped due to an error. Try refreshing. If it keeps happening, open the browser console (F12) for details.</p>
      <pre style={{background:T.surface,padding:14,overflow:'auto',fontSize:12,border:`1px solid ${T.hairline}`,borderRadius:8,color:T.text}}>{this.state.err?.message||String(this.state.err)}</pre>
    </div>;
    return this.props.children;
  }
}

function flattenDaySections(dayData){
  const sections=[];
  if(!dayData)return sections;
  Object.entries(dayData).forEach(([tw,zones])=>{
    if(Array.isArray(zones))sections.push({pfx:tw,acts:zones});
    else Object.entries(zones).forEach(([z,acts])=>sections.push({pfx:z==='_default'?tw:`${tw}|${z}`,acts}));
  });
  return sections;
}

/** Build Update-tab sections from plan programme rows (same completion keys as legacy schedule). */
function buildUpdateSectionsFromPlanRows(rows, dateK, selectedTabs) {
  const dk0 = String(dateK || '').trim();
  if (isNonWorkingPlanDayKey(dk0)) {
    return { sections: [], metaByCk: new Map() };
  }
  const sel = new Set(selectedTabs);
  const bySection = new Map();
  const metaByCk = new Map();
  for (const r of rows || []) {
    if (!r) continue;
    const scope = scopeForRow(r);
    if (!scope || !sel.has(scope)) continue;
    const dk = String(dateK);
    if (dk < String(r.start_date) || dk > String(r.end_date)) continue;
    const tw = String(r.tower || '').trim();
    const zn = String(r.zone_name || '').trim();
    const act = String(r.activity_name || '').trim();
    if (!tw || !zn || !act) continue;
    const pfx = `${tw}|${zn}`;
    const label = `${tw} ${zn}`;
    const ck = `${pfx}|${act}`;
    if (!bySection.has(pfx)) {
      bySection.set(pfx, { label, pfx, acts: [], drawing_tab: scope });
    }
    const sec = bySection.get(pfx);
    if (!sec.acts.includes(act)) sec.acts.push(act);
    if (!metaByCk.has(ck)) {
      metaByCk.set(ck, {
        programme_item_id: r.id,
        zone_id: r.zone_id,
        start_date: r.start_date,
        end_date: r.end_date,
        status: r.status,
      });
    }
  }
  const sections = [...bySection.values()];
  sections.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
  return { sections, metaByCk };
}

function seqForDrawingTab(t) {
  if (t === PROJECT_PROGRAMME_TAB) return [];
  if (t === MODULE_PROGRAMME_TAB) return MODULE_SEQUENCE;
  if (t === 'groundworks') return GW_SEQUENCE;
  if (t === 'internals') return INT_SEQUENCE;
  return [];
}

function dayOrdKey(key) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(key || '').trim());
  if (!m) return 0;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}
const MILESTONE_STATUSES=['planned','critical','unconfirmed','gated'];

function milestoneDayOrd(key){
  const m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(key||'').trim());
  if(!m)return null;
  const y=Number(m[1]),mo=Number(m[2]),d=Number(m[3]);
  if(!Number.isFinite(y)||!Number.isFinite(mo)||!Number.isFinite(d))return null;
  return Math.floor(Date.UTC(y,mo-1,d)/86400000);
}

/** Calendar days from today to due (negative = overdue). */
function daysUntilMilestoneDue(dateStr){
  const due=milestoneDayOrd(dateStr);
  if(due==null)return null;
  const today=milestoneDayOrd(dateKey(new Date()));
  if(today==null)return null;
  return due-today;
}

/**
 * Programme-health styling: combines due date, completion %, and workflow status.
 * Returns tier + label + RGB for bar / accent.
 */
function milestoneHealthVisual(m){
  const pct=Math.max(0,Math.min(100,Math.round(Number(m.completion_pct)||0)));
  const st=String(m.status||'planned').toLowerCase();
  const du=daysUntilMilestoneDue(m.date);

  const complete={
    tier:'complete',
    label:'Complete',
    rgb:'46,178,96',
    tint:'rgba(46,178,96,0.14)',
    badgeFg:'rgba(22,72,42,0.95)',
  };
  if(pct>=100)return complete;

  const risk=(label)=>({
    tier:'risk',
    label,
    rgb:'231,76,60',
    tint:'rgba(231,76,60,0.14)',
    badgeFg:'rgba(110,38,30,0.96)',
  });
  const watch=(label)=>({
    tier:'watch',
    label,
    rgb:'230,126,34',
    tint:'rgba(230,126,34,0.14)',
    badgeFg:'rgba(105,55,18,0.95)',
  });
  const ontrack={
    tier:'on_track',
    label:'On track',
    rgb:'39,174,96',
    tint:'rgba(39,174,96,0.10)',
    badgeFg:'rgba(24,90,52,0.92)',
  };

  if(du==null)return ontrack;
  if(du<0)return risk('Overdue');
  if(st==='critical'&&du<=7&&pct<100)return risk('Critical — due soon');
  if(st==='critical'&&pct<55)return watch('Critical — low progress');
  if((st==='gated'||st==='unconfirmed')&&pct<100)return watch('Uncertain');
  if(du<=7&&pct<90)return watch('Due soon');
  if(du<=21&&pct<50)return watch('Behind pace');
  if(du<=45&&pct<30)return watch('Early risk');
  return ontrack;
}

/** One entry per programme item so admin can pick a single line (no auto list). */
function buildProgrammeMilestonePicklist(planRows){
  const rows=Array.isArray(planRows)?planRows:[];
  const out=[];
  for(const r of rows){
    const id=r.id;
    if(id==null||id==='')continue;
    const sd=String(r.start_date||'').trim();
    const ed=String(r.end_date||'').trim();
    if(!sd||!ed)continue;
    const tw=String(r.tower||'').trim();
    const zn=String(r.zone_name||'').trim();
    const act=String(r.activity_name||'').trim();
    const dn=String(r.drawing_name||'').trim();
    const dt=String(r.drawing_tab||'').trim();
    const zonePart=[tw,zn].filter(Boolean).join(' ');
    const label=dn
      ?`${dn} — ${[zonePart,act].filter(Boolean).join(' — ')}`
      :[zonePart,act].filter(Boolean).join(' — ')||`Programme item ${id}`;
    const searchHaystack=[dn,dt,tw,zn,act,sd,ed].join(' ').toLowerCase();
    out.push({programmeItemId:id,start_date:sd,end_date:ed,label,searchHaystack});
  }
  out.sort((a,b)=>String(a.end_date).localeCompare(String(b.end_date))||String(a.label).localeCompare(String(b.label)));
  return out;
}

/** Scheduleable dates in programme span (excludes Saturdays, Sundays, and England & Wales bank holidays; matches server schedule expansion). */
function workingDateKeysBetween(startStr, endStr) {
  return scheduleDateKeysBetween(startStr, endStr);
}

/** Day-slots implied by plan programme rows + Update ticks (when site `schedule` is empty or stale). */
function countPlanRowSlotsForTab(rows, comp, drawingTab) {
  let total = 0,
    done = 0;
  for (const r of rows || []) {
    if (!r || String(r.drawing_tab || '') !== drawingTab) continue;
    const tw = String(r.tower || '').trim();
    const zn = String(r.zone_name || '').trim();
    const act = String(r.activity_name || '').trim();
    if (!tw || !zn || !act) continue;
    const pfx = `${tw}|${zn}`;
    const ck = `${pfx}|${act}`;
    for (const dk of workingDateKeysBetween(r.start_date, r.end_date)) {
      total++;
      if (comp[dk]?.[ck]) done++;
    }
  }
  return { total, done };
}

/** True when every working-day slot for this programme row has an Update tick. */
function programmeItemAllSlotsTicked(row, comp) {
  const tw = String(row.tower || '').trim();
  const zn = String(row.zone_name || '').trim();
  const act = String(row.activity_name || '').trim();
  if (!tw || !zn || !act) return true;
  const pfx = `${tw}|${zn}`;
  const ck = `${pfx}|${act}`;
  const days = workingDateKeysBetween(row.start_date, row.end_date);
  if (!days.length) return true;
  for (const dk of days) {
    if (!comp[dk]?.[ck]) return false;
  }
  return true;
}

function mergedSlotCounts(sched, comp, planRows, drawingTab) {
  const fromSched = countScheduledSlots(sched, comp);
  if (fromSched.total > 0) return fromSched;
  return countPlanRowSlotsForTab(planRows, comp, drawingTab);
}

/** Scheduled activity-day slots vs Update ticks (same basis as Update & Plan). */
function countScheduledSlots(sched, comp) {
  let total = 0,
    done = 0;
  Object.keys(sched || {}).forEach((dk) => {
    flattenDaySections(sched[dk]).forEach((sec) => {
      sec.acts.forEach((act) => {
        total++;
        if (comp[dk]?.[`${sec.pfx}|${act}`]) done++;
      });
    });
  });
  return { total, done };
}

function overallProjectCompletionMerged(gw, int_s, project_s, comp, planRows) {
  const g = mergedSlotCounts(gw, comp, planRows, 'groundworks');
  const i = mergedSlotCounts(int_s, comp, planRows, 'internals');
  const p = mergedSlotCounts(project_s || {}, comp, planRows, PROJECT_PROGRAMME_TAB);
  const total = g.total + i.total + p.total;
  const done = g.done + i.done + p.done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, pct, gw: g, int: i, project: p };
}

function overallProjectCompletion(gw, int_s, project_s, comp) {
  const g = countScheduledSlots(gw, comp);
  const i = countScheduledSlots(int_s, comp);
  const p = countScheduledSlots(project_s || {}, comp);
  const total = g.total + i.total + p.total;
  const done = g.done + i.done + p.done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, pct, gw: g, int: i, project: p };
}

/** Activity-level completion from the Plan programme: one unit per scheduled activity,
 *  done when every scheduled day in the span is ticked (or status done). Matches Plan. */
function activityCompletionForTab(planRows, comp, drawingTab) {
  let total = 0,
    done = 0;
  for (const r of planRows || []) {
    if (!r || String(r.drawing_tab || '') !== drawingTab) continue;
    const tw = String(r.tower || '').trim();
    const zn = String(r.zone_name || '').trim();
    const act = String(r.activity_name || '').trim();
    if (!tw || !zn || !act) continue;
    if (!String(r.start_date || '').trim() || !String(r.end_date || '').trim()) continue;
    total++;
    if (isProgrammeRowFullyDone(r, comp)) done++;
  }
  return { total, done };
}

/** Module programme rows use module_handover drawings but module_programme scope. */
function activityCompletionForScope(planRows, comp, scopeTab) {
  let total = 0,
    done = 0;
  for (const r of planRows || []) {
    if (!r || scopeForRow(r) !== scopeTab) continue;
    const tw = String(r.tower || '').trim();
    const zn = String(r.zone_name || '').trim();
    const act = String(r.activity_name || '').trim();
    if (!tw || !zn || !act) continue;
    if (!String(r.start_date || '').trim() || !String(r.end_date || '').trim()) continue;
    total++;
    if (isProgrammeRowFullyDone(r, comp)) done++;
  }
  return { total, done };
}

function DashboardTowerBreakdown({ towerGroups, accent, showFinishedDate }) {
  if (!towerGroups?.length) {
    return <p style={{ margin: 0, fontSize: 12, color: T.muted, lineHeight: 1.5 }}>No programme activities yet.</p>;
  }
  return towerGroups.map((tower) => (
    <div
      key={tower.label}
      style={{
        marginBottom: 14,
        padding: '12px 12px 10px',
        borderRadius: 12,
        border: '1px solid rgba(26,26,46,0.07)',
        background: 'rgba(26,26,46,0.02)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: T.text, letterSpacing: '0.02em' }}>{tower.label}</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: `rgba(${accent},0.95)` }}>{tower.pct}%</span>
          <span style={{ fontSize: 10, color: T.muted }}>{tower.done}/{tower.total}</span>
        </div>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'rgba(26,26,46,0.07)', overflow: 'hidden', marginBottom: tower.levels?.length ? 10 : 0 }}>
        <div
          style={{
            height: '100%',
            borderRadius: 3,
            width: `${tower.pct}%`,
            background: `rgba(${accent},0.75)`,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      {tower.levels?.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4, borderLeft: `3px solid rgba(${accent},0.22)` }}>
          {tower.levels.map((floor) => (
            <div key={floor.label}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                <span
                  style={{
                    flexShrink: 0,
                    width: 26,
                    fontSize: 10,
                    fontWeight: 800,
                    color: `rgba(${accent},0.9)`,
                    textAlign: 'center',
                    letterSpacing: '0.04em',
                  }}
                  title={floor.floorLabel}
                >
                  {floor.floorShort}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: T.text }}>{floor.floorLabel}</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: `rgba(${accent},0.95)` }}>{floor.pct}%</span>
                  <span style={{ fontSize: 10, color: T.muted }}>{floor.done}/{floor.total}</span>
                  {showFinishedDate && floor.lastFinishedDate && (
                    <span style={{ fontSize: 10, color: T.muted, fontWeight: 600 }}>Finished {floor.lastFinishedDate}</span>
                  )}
                </div>
              </div>
              <div style={{ marginLeft: 34, height: 4, borderRadius: 2, background: 'rgba(26,26,46,0.06)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    borderRadius: 2,
                    width: `${floor.pct}%`,
                    background: `rgba(${accent},0.62)`,
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: 11, color: T.muted, lineHeight: 1.45 }}>No floor programme on this tower yet.</p>
      )}
    </div>
  ));
}

function overallActivityCompletion(planRows, comp) {
  const g = activityCompletionForTab(planRows, comp, 'groundworks');
  const i = activityCompletionForTab(planRows, comp, 'internals');
  const p = activityCompletionForTab(planRows, comp, PROJECT_PROGRAMME_TAB);
  const m = activityCompletionForScope(planRows, comp, MODULE_PROGRAMME_TAB);
  const total = g.total + i.total + p.total + m.total;
  const done = g.done + i.done + p.done + m.done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { total, done, pct, gw: g, int: i, project: p, module: m };
}
/** Human-readable zone line for Update screen section headers (field context). */
function zoneSubtitleForSection(sec,seq,tab){
  if(sec.pfx.includes('|')){
    const rawZone=sec.pfx.split('|').slice(1).join('|');
    const {zoneLabel,linkedActivity}=parseZoneNameForActivity(rawZone,seq);
    const parts=[];
    if(zoneLabel&&zoneLabel.trim())parts.push(zoneLabel.trim());
    if(linkedActivity)parts.push(`Linked in sequence: ${linkedActivity}`);
    return parts.length?parts.join(' — '):rawZone;
  }
  if(tab==='internals')return'Scheduled internals for this tower — tick each activity when complete.';
  if(tab==='groundworks')return`Groundworks at ${sec.label} — check you are on the correct pour / zone before ticking.`;
  if(tab===PROJECT_PROGRAMME_TAB)return'Master / enabling programme — tick when this activity is complete for the day.';
  return null;
}
function CompletionRing({pct,done,total}){
  const clamped=Math.min(100,Math.max(0,pct));
  const r=50,c=2*Math.PI*r,dash=c*(1-clamped/100);
  const arcColor=clamped>=100?'rgba(46,178,96,0.95)':'rgba(66,133,244,0.94)';
  return<div style={{display:'flex',alignItems:'center',gap:24,flexWrap:'wrap'}}>
    <div style={{position:'relative',width:124,height:124,flexShrink:0,filter:'drop-shadow(0 6px 14px rgba(26,26,46,0.08))'}}>
      <svg width="124" height="124" viewBox="0 0 124 124" style={{transform:'rotate(-90deg)'}} aria-hidden>
        <defs>
          <linearGradient id="dashRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(66,133,244,1)"/>
            <stop offset="100%" stopColor="rgba(100,160,255,0.85)"/>
          </linearGradient>
        </defs>
        <circle cx="62" cy="62" r={r} fill="none" stroke="rgba(26,26,46,0.06)" strokeWidth="9"/>
        <circle cx="62" cy="62" r={r} fill="none" stroke={clamped>=100?arcColor:'url(#dashRingGrad)'} strokeWidth="9" strokeLinecap="round"
          strokeDasharray={String(c)} strokeDashoffset={dash}/>
      </svg>
      <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',pointerEvents:'none'}}>
        <span style={{fontSize:28,fontWeight:800,color:T.text,lineHeight:1,letterSpacing:'-0.02em'}}>{pct}%</span>
        <span style={{fontSize:8,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.14em',marginTop:4}}>Complete</span>
      </div>
    </div>
    <div style={{flex:1,minWidth:160}}>
      <div style={{fontSize:11,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.16em',marginBottom:6}}>Overall progress</div>
      <div style={{fontSize:17,fontWeight:700,color:T.text,marginBottom:8,letterSpacing:'-0.02em',lineHeight:1.25}}>Programme completion</div>
      <div style={{fontSize:13,color:T.muted,lineHeight:1.55,maxWidth:340}}>
        {total>0?`${done} of ${total} scheduled activities are ticked off across Groundworks, Internals, Project programme, and Modules (matches Plan).`:'Once activities are scheduled on site days, overall completion appears here.'}
      </div>
      {total===0&&<div style={{fontSize:12,color:T.faint,marginTop:10,lineHeight:1.45}}>Use <strong style={{color:T.muted,fontWeight:600}}>Update</strong> after programme data is in place.</div>}
      {total>0&&<div style={{marginTop:14,height:4,borderRadius:4,background:'rgba(26,26,46,0.06)',overflow:'hidden',maxWidth:280}}>
        <div style={{
          height:'100%',
          width:String(clamped)+'%',
          borderRadius:4,
          background:clamped>=100?'linear-gradient(90deg,rgba(46,178,96,0.88),rgba(80,200,130,0.9))':'linear-gradient(90deg,rgba(66,133,244,0.85),rgba(120,170,255,0.75))',
          transition:'width 0.5s ease',
        }}/>
      </div>}
    </div>
  </div>;
}

function Wordmark119HS({variant='hero'}){
  const nav=variant==='nav';
  return<div className={`logo-wordmark${nav?' logo-wordmark--nav':''}`} aria-label="119HS">
    <span className="logo-number">119</span>
    <span className="logo-letters">HS</span>
  </div>;
}

function LoginPage({onLogin}){
  const[u,setU]=useState('');const[p,setP]=useState('');const[err,setErr]=useState('');const[loading,setLoading]=useState(false);const[photoUrl,setPhotoUrl]=useState(null);
  useEffect(()=>{
    let cancelled=false;
    (async()=>{
      try{
        const d=await api.getSitePhoto();
        if(cancelled)return;
        const path=d?.url||null;
        setPhotoUrl(path?api.absoluteUrl(path):null);
      }catch(_){if(!cancelled)setPhotoUrl(null);}
    })();
    return()=>{cancelled=true};
  },[]);
  async function go(){
    setLoading(true);setErr('');
    try{
      const d=await api.login(u,p);
      if(d?.user)onLogin(d.user);
      else setErr('Invalid credentials');
    }catch(e){
      setErr(e?.message&&e.message!=='Failed to fetch'?e.message:'Cannot reach API. Run npm run server (or npm run dev) from the project root; if the UI is hosted separately, set REACT_APP_API_URL to your API URL when building the client.');
    }
    setLoading(false);
  }
  return<div className="login-landing">
    <div className="login-landing__media">
      {photoUrl ? (
        <>
          <img className="login-landing__bg" src={photoUrl} alt="" decoding="async"/>
          <div className="login-landing__photo-scrim" aria-hidden/>
        </>
      ) : (
        <div className="login-landing__fallback" aria-hidden/>
      )}
    </div>
    <div className="login-landing__overlay">
      <div className="login-landing__card">
        <div className="login-landing__brand">
          <Wordmark119HS/>
          <div className="login-landing__tagline">Programme management</div>
        </div>
        <div className="login-landing__form">
          <input className="login-landing__field" value={u} onChange={e=>{setU(e.target.value);setErr('')}} onKeyDown={e=>e.key==='Enter'&&go()} placeholder="Username" autoComplete="username"/>
          <input className="login-landing__field" type="password" value={p} onChange={e=>{setP(e.target.value);setErr('')}} onKeyDown={e=>e.key==='Enter'&&go()} placeholder="Password" autoComplete="current-password"/>
          {err&&<div className="login-landing__error">{err}</div>}
          <button type="button" className="login-landing__submit" onClick={()=>void go()} disabled={loading}>{loading?'Signing in...':'Sign In'}</button>
        </div>
      </div>
    </div>
  </div>;
}

function formatSitePhotoUpdated(iso){
  if(!iso)return null;
  try{return new Date(iso).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});}catch(_){return null;}
}

const RESET_PROGRAMME_PHRASE='RESET PROGRAMME';
function SettingsPage(){
  const[info,setInfo]=useState({url:null,updated_at:null});const[uploading,setUploading]=useState(false);const[err,setErr]=useState('');const fileRef=useRef(null);
  const[progResetInput,setProgResetInput]=useState('');
  const[progResetBusy,setProgResetBusy]=useState(false);
  const[progResetErr,setProgResetErr]=useState('');
  const[progResetDeleted,setProgResetDeleted]=useState(null);
  const[reseqBusy,setReseqBusy]=useState(false);
  const[reseqResult,setReseqResult]=useState(null);
  const[reseqErr,setReseqErr]=useState('');
  const load=useCallback(async()=>{
    try{
      const d=await api.getSitePhoto();
      setInfo({url:d?.url??null,updated_at:d?.updated_at??null});
    }catch(_){setInfo({url:null,updated_at:null});}
  },[]);
  useEffect(()=>{void load()},[load]);
  async function onPick(e){
    const f=e.target.files?.[0];
    e.target.value='';
    if(!f)return;
    setErr('');
    setUploading(true);
    try{
      const out=await api.uploadSitePhoto(f);
      if(out?.error){setErr(String(out.error));return;}
      if(out?.url)setInfo({url:out.url,updated_at:out.updated_at||null});
      else await load();
    }catch(er){setErr(er?.message||'Upload failed');}
    finally{setUploading(false);}
  }
  async function onProgrammeReset(){
    setProgResetErr('');
    setProgResetDeleted(null);
    setProgResetBusy(true);
    try{
      const out=await api.resetProgramme({confirmation:RESET_PROGRAMME_PHRASE});
      if(isApiErrorPayload(out)){setProgResetErr(String(out.error));return;}
      if(out&&out.deleted&&typeof out.deleted==='object')setProgResetDeleted(out.deleted);
      else setProgResetDeleted({});
      setProgResetInput('');
    }catch(er){setProgResetErr(er?.message||'Reset failed');}
    finally{setProgResetBusy(false);}
  }
  async function onResequenceAllZones(){
    if(!window.confirm('Resequence all zones that have a linked template and anchor date? This replaces programme rows with freshly calculated dates.'))return;
    setReseqErr('');
    setReseqResult(null);
    setReseqBusy(true);
    try{
      const out=await api.resequenceAllZones();
      if(isApiErrorPayload(out)){setReseqErr(String(out.error));return;}
      setReseqResult(out);
    }catch(er){setReseqErr(er?.message||'Resequence failed');}
    finally{setReseqBusy(false);}
  }
  const thumbSrc=info.url?`${api.absoluteUrl(info.url)}${info.updated_at?`?v=${encodeURIComponent(info.updated_at)}`:''}`:'';
  const updatedLabel=formatSitePhotoUpdated(info.updated_at);
  const heroBg=info.url&&thumbSrc
    ?{backgroundImage:`url(${thumbSrc})`,backgroundSize:'cover',backgroundPosition:'center'}
    :{
      backgroundColor:'#1e293b',
      backgroundImage:'linear-gradient(rgba(255,255,255,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.06) 1px,transparent 1px)',
      backgroundSize:'24px 24px',
    };
  return<div style={{flex:1,overflowY:'auto',padding:16,background:T.bg}}>
    <h2 style={{margin:'0 0 4px',fontSize:20,fontWeight:700,color:T.text}}>Settings</h2>
    <p style={{fontSize:11,color:T.faint,marginBottom:18}}>Site appearance</p>
    <div style={{maxWidth:520,borderRadius:12,overflow:'hidden',border:`1px solid ${T.hairline}`,boxShadow:'0 8px 28px rgba(26,26,46,0.08)'}}>
      <div style={{position:'relative',minHeight:220,...heroBg}}>
        <div style={{position:'absolute',inset:0,background:'linear-gradient(180deg, rgba(17,24,39,0.5) 0%, rgba(17,24,39,0.82) 100%)',pointerEvents:'none'}} aria-hidden/>
        <div style={{position:'relative',zIndex:1,padding:18,display:'flex',flexDirection:'column',gap:12,minHeight:220,boxSizing:'border-box'}}>
          <div>
            <div style={{fontSize:11,fontWeight:700,color:'rgba(255,255,255,0.95)',letterSpacing:'0.06em',textTransform:'uppercase',marginBottom:6}}>Site photo</div>
            <p style={{fontSize:12,color:'rgba(255,255,255,0.85)',margin:0,lineHeight:1.45,maxWidth:360}}>This image appears on the login page.</p>
          </div>
          <div style={{flex:1,minHeight:4}}/>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" style={{display:'none'}} onChange={onPick}/>
          <div>
            <button type="button" disabled={uploading} onClick={()=>fileRef.current?.click()} style={{...S.btn,padding:'10px 18px',fontSize:12,fontWeight:600,background:'#fff',color:'#111827',border:'none',opacity:uploading?0.55:1,cursor:uploading?'default':'pointer'}}>{uploading?'Uploading…':'Upload new photo'}</button>
            <p style={{fontSize:10,color:'rgba(255,255,255,0.7)',marginTop:10,lineHeight:1.5}}>Recommended: landscape, min 1200px wide.<br/>Accepted: JPG, PNG (max 5MB).</p>
            {err&&<div style={{fontSize:12,color:'#fca5a5',marginTop:10}}>{err}</div>}
            {updatedLabel&&<p style={{fontSize:11,color:'rgba(255,255,255,0.78)',marginTop:10}}>Last updated: {updatedLabel}</p>}
          </div>
        </div>
      </div>
    </div>
    <div style={{maxWidth:520,marginTop:28}}>
      <h3 style={{margin:'0 0 6px',fontSize:15,fontWeight:700,color:T.text}}>Programme data</h3>
      <p style={{fontSize:12,color:T.muted,margin:'0 0 12px',lineHeight:1.5}}>
        Removes all rows from <code style={{fontSize:11}}>programme_items</code>, <code style={{fontSize:11}}>zone_activities</code>, <code style={{fontSize:11}}>completions</code>, and <code style={{fontSize:11}}>schedule</code>.
        Zones, drawings, templates, the activity catalogue, and milestones are kept.
      </p>
      <label style={{display:'block',fontSize:11,fontWeight:600,color:T.text,marginBottom:6}} htmlFor="prog-reset-confirm">Type {RESET_PROGRAMME_PHRASE} to enable reset</label>
      <input
        id="prog-reset-confirm"
        className="login-landing__field"
        value={progResetInput}
        onChange={e=>{setProgResetInput(e.target.value);setProgResetErr('');setProgResetDeleted(null);}}
        placeholder={RESET_PROGRAMME_PHRASE}
        autoComplete="off"
        style={{maxWidth:360,marginBottom:10}}
      />
      <div>
        <button
          type="button"
          disabled={progResetBusy||progResetInput.trim()!==RESET_PROGRAMME_PHRASE}
          onClick={()=>void onProgrammeReset()}
          style={{...S.btn,padding:'10px 16px',fontSize:12,fontWeight:600,background:'#b91c1c',color:'#fff',border:'none',opacity:progResetBusy||progResetInput.trim()!==RESET_PROGRAMME_PHRASE?0.45:1,cursor:progResetBusy||progResetInput.trim()!==RESET_PROGRAMME_PHRASE?'default':'pointer'}}
        >
          {progResetBusy?'Resetting…':'Reset programme data'}
        </button>
      </div>
      {progResetErr&&<div style={{fontSize:12,color:'#b91c1c',marginTop:10}}>{progResetErr}</div>}
      {progResetDeleted&&(
        <div style={{fontSize:12,color:T.muted,marginTop:12,lineHeight:1.55}}>
          <strong style={{color:T.text}}>Cleared row counts</strong>
          <ul style={{margin:'6px 0 0',paddingLeft:18}}>
            {Object.entries(progResetDeleted).map(([table,n])=>(
              <li key={table}><code style={{fontSize:11}}>{table}</code>: {String(n)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
    <div style={{maxWidth:520,marginTop:28,paddingTop:24,borderTop:`1px solid ${T.hairline}`}}>
      <h3 style={{margin:'0 0 6px',fontSize:15,fontWeight:700,color:T.text}}>Resequence all zones</h3>
      <p style={{fontSize:12,color:T.muted,margin:'0 0 12px',lineHeight:1.5}}>
        Rebuilds <code style={{fontSize:11}}>programme_items</code> for every zone with a linked template and anchor date,
        using the current <code style={{fontSize:11}}>scheduleFromTargetDate</code> engine. Use after scheduling logic fixes
        or to repair zones built with the legacy apply path.
      </p>
      <button
        type="button"
        disabled={reseqBusy}
        onClick={()=>void onResequenceAllZones()}
        style={{...S.btn,padding:'10px 16px',fontSize:12,fontWeight:600,opacity:reseqBusy?0.55:1,cursor:reseqBusy?'default':'pointer'}}
      >
        {reseqBusy?'Resequencing…':'Resequence all zones'}
      </button>
      {reseqErr&&<div style={{fontSize:12,color:'#b91c1c',marginTop:10}}>{reseqErr}</div>}
      {reseqResult&&(
        <div style={{fontSize:12,color:T.muted,marginTop:12,lineHeight:1.55}}>
          {typeof reseqResult.count==='number'&&(
            <div>
              <strong style={{color:T.text}}>{reseqResult.count} zone{reseqResult.count===1?'':'s'} resequenced successfully</strong>
            </div>
          )}
          {Array.isArray(reseqResult.errors)&&reseqResult.errors.length>0&&(
            <ul style={{margin:'8px 0 0',paddingLeft:18}}>
              {reseqResult.errors.map((e)=>(
                <li key={`err-${e.zone_id}`}>{e.label||`Zone ${e.zone_id}`}: {e.error}</li>
              ))}
            </ul>
          )}
          {Array.isArray(reseqResult.skipped)&&reseqResult.skipped.length>0&&(
            <div style={{marginTop:12}}>
              <strong style={{color:T.text}}>
                {reseqResult.skipped.length} zone{reseqResult.skipped.length===1?'':'s'} skipped — open these in Zone Setup and use Schedule from target date to set an anchor
              </strong>
              <ul style={{margin:'8px 0 0',paddingLeft:18}}>
                {reseqResult.skipped.map((s)=>(
                  <li key={`skip-${s.zone_id}`}>{s.label||`Zone ${s.zone_id}`}{s.reason?`: ${s.reason}`:''}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  </div>;
}

function TemplatePage({tab,isAdmin,onReload}){
  const[templateTab,setTemplateTab]=useState(tab);
  const[activities,setActivities]=useState([]);
  const[newAct,setNewAct]=useState('');
  const[addingAct,setAddingAct]=useState(false);
  const[templates,setTemplates]=useState([]);const[tName,setTName]=useState('');const[tTower,setTTower]=useState('T2');const[tZone,setTZone]=useState('');
  const[tActs,setTActs]=useState([]);const[tDurs,setTDurs]=useState([]);const[selTpl,setSelTpl]=useState(null);
  const[editingId,setEditingId]=useState(null);
  const[dragActIdx,setDragActIdx]=useState(null);
  const[apTower,setApTower]=useState('T2');const[apZone,setApZone]=useState('');const[apStart,setApStart]=useState('2026-05-01');
  useEffect(()=>{setTemplateTab(tab)},[tab]);
  useEffect(()=>{api.getTemplates().then(t=>setTemplates(t||[]))},[tab]);
  useEffect(()=>{api.getActivities().then(a=>setActivities(a||[]))},[]);
  const defaultSeq=templateTab==='groundworks'?GW_SEQUENCE:templateTab==='internals'?INT_SEQUENCE:[];
  const seq=useMemo(()=>{
    const dbActs=(activities||[])
      .filter(a=>a.type===templateTab)
      .map(a=>a.name);
    const all=[...defaultSeq,...dbActs];
    return [...new Set(all)];
  },[activities,templateTab,defaultSeq]);
  const orphansInTemplate=useMemo(()=>tActs.filter(a=>!seq.includes(a)),[tActs,seq]);
  function onTemplateScopeChange(next){
    setEditingId(null);
    setTemplateTab(next);
    setTActs([]);setTDurs([]);setSelTpl(null);setTName('');
  }
  function startEdit(t){
    setTemplateTab(t.tab);
    setEditingId(t.id);
    setTName(t.name||'');
    setTTower(t.tower||'T2');
    setTZone(t.zone_name||'');
    let acts=[],durs=[];
    try{acts=JSON.parse(t.sequence||'[]')}catch(_){}
    try{durs=JSON.parse(t.durations||'[]')}catch(_){}
    const actArr=Array.isArray(acts)?acts:[];
    setTActs(actArr);
    setTDurs(alignTemplateDurations(actArr,Array.isArray(durs)?durs:[]));
    setSelTpl(null);
  }
  function cancelEdit(){
    setEditingId(null);
    setTName('');
    setTActs([]);
    setTDurs([]);
    setDragActIdx(null);
  }
  function togAct(a){if(tActs.includes(a)){setTActs(tActs.filter(x=>x!==a));setTDurs(tDurs.filter((_,i)=>tActs[i]!==a))}else{setTActs([...tActs,a]);setTDurs([...tDurs,1])}}
  function setDur(i,v){
    const d=[...tDurs];
    const n=Number.parseFloat(v);
    d[i]=Number.isFinite(n)?Math.max(0.5,Math.round(n*2)/2):1;
    setTDurs(d);
  }
  function moveAct(fromIdx,toIdx){
    if(fromIdx===toIdx||fromIdx<0||toIdx<0||fromIdx>=tActs.length||toIdx>=tActs.length)return;
    const acts=[...tActs],durs=[...tDurs];
    const [a]=acts.splice(fromIdx,1);
    const [d]=durs.splice(fromIdx,1);
    acts.splice(toIdx,0,a);
    durs.splice(toIdx,0,d);
    setTActs(acts);setTDurs(durs);
  }
  async function addNewActivity(){
    const nm=String(newAct||'').trim();
    if(!nm)return;
    setAddingAct(true);
    try{
      const res=await api.createActivity(nm,templateTab);
      if(res&&res.error){window.alert(String(res.error));return;}
      setActivities(await api.getActivities()||[]);
      setNewAct('');
      if(!tActs.includes(nm)){setTActs([...tActs,nm]);setTDurs([...tDurs,1]);}
    }finally{setAddingAct(false);}
  }
  async function saveTpl(){
    if(!tName||!tActs.length)return;
    const dursSave=alignTemplateDurations(tActs,tDurs);
    if(editingId){
      const res=await api.updateTemplate(editingId,{name:tName,tab:templateTab,tower:tTower,zone_name:tZone,sequence:tActs,durations:dursSave});
      if(res&&res.error){window.alert(String(res.error));return;}
      const syncZ=res?.synced?.zones??0,syncI=res?.synced?.items??0;
      if(syncZ>0)window.alert(`Template updated. Programme refreshed for ${syncZ} linked zone(s) (${syncI} new rows). Rows marked done were kept.`);
      cancelEdit();
    }else{
      await api.createTemplate(tName,templateTab,tTower,tZone,tActs,dursSave);
      setTName('');setTActs([]);setTDurs([]);
    }
    setTemplates(await api.getTemplates()||[]);
    if(onReload)await onReload();
  }
  async function handleApply(){if(!selTpl||!apZone||!apStart)return;const t=templates.find(x=>x.id===selTpl);if(!t)return;let sq=[],du=[];try{sq=JSON.parse(t.sequence)||[]}catch(_){}try{du=JSON.parse(t.durations)||[]}catch(_){}await api.applyTemplate(templateTab,apTower,apZone,sq,alignTemplateDurations(sq,du),apStart);if(onReload)onReload();alert(`Template applied to ${apTower} ${apZone} from ${apStart}`)}
  async function removeTpl(id,name){
    if(!isAdmin)return;
    if(!window.confirm(`Delete template "${name}"? This cannot be undone.`))return;
    const res=await api.deleteTemplate(id);
    if(res&&!res.ok&&res.error){window.alert(String(res.error));return}
    if(selTpl===id)setSelTpl(null);
    if(editingId===id)cancelEdit();
    setTemplates(await api.getTemplates()||[]);
  }
  async function duplicateTpl(t){
    if(!isAdmin)return;
    const defaultName=`${t.name} copy`;
    const nextName=window.prompt('Name for duplicated template:',defaultName);
    if(nextName==null)return;
    const nm=String(nextName).trim();
    if(!nm)return;
    let seq=[],durs=[];
    try{seq=JSON.parse(t.sequence||'[]')}catch(_){}
    try{durs=JSON.parse(t.durations||'[]')}catch(_){}
    const seqOk=Array.isArray(seq)?seq:[];
    const res=await api.createTemplate(nm,t.tab,t.tower,t.zone_name,seqOk,alignTemplateDurations(seqOk,Array.isArray(durs)?durs:[]));
    if(res&&res.error){window.alert(String(res.error));return;}
    setTemplates(await api.getTemplates()||[]);
  }
  const scopedTemplates=templates.filter(t=>t.tab===templateTab);

  return<div style={{flex:1,overflow:'hidden',background:T.bg,display:'flex',flexDirection:'column',minHeight:0}}>
    <PageHeader
      title="Programme Templates"
      collapsible
      collapsibleSummary={[drawingTabLabel(templateTab)]}
      filters={
        <>
          <label style={{ fontSize: 11, fontWeight: 600, color: T.text }} htmlFor="tpl-scope">Programme</label>
          <select id="tpl-scope" value={templateTab} onChange={e=>onTemplateScopeChange(e.target.value)} style={{...S.input,width:'auto',minWidth:200,fontSize:12,padding:'8px 12px'}}>
            <option value="groundworks">Groundworks</option>
            <option value="internals">Internals</option>
            <option value="module_programme">Modules</option>
            <option value="project_programme">Project programme</option>
          </select>
        </>
      }
    />
    <div style={{padding:16,flex:1,minHeight:0,overflowY:'auto'}}>
    {isAdmin&&<div style={{padding:10,background:T.surface,border:`1px solid ${T.hairline}`,borderRadius:10,marginBottom:12,display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <span style={{fontSize:11,fontWeight:600,color:T.text}}>New activity</span>
      <input value={newAct} onChange={e=>setNewAct(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addNewActivity()} placeholder={`Add ${templateTab} activity`} style={{...S.input,width:220,fontSize:12,padding:'7px 10px'}}/>
      <button type="button" disabled={addingAct||!newAct.trim()} onClick={()=>void addNewActivity()} style={{...S.btn,...S.btnPrimary,padding:'7px 12px',fontSize:11,opacity:addingAct||!newAct.trim()?0.45:1}}>{addingAct?'Adding...':'Add activity'}</button>
      <span style={{fontSize:10,color:T.faint}}>Appears immediately in template options.</span>
    </div>}
    {isAdmin&&<div style={{padding:10,background:T.surface,border:`1px solid ${T.hairline}`,borderRadius:10,marginBottom:14}}>
      <div style={{fontSize:11,fontWeight:700,color:T.text,marginBottom:8}}>Manage activities ({templateTab})</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
        {activities.filter(a=>a.type===templateTab).map(a=><div key={a.id} style={{display:'flex',alignItems:'center',gap:4,padding:'4px 6px',border:`1px solid ${T.hairline}`,borderRadius:8,background:'rgba(26,26,46,0.02)'}}>
          <span style={{fontSize:11,color:T.text,fontWeight:600}}>{a.name}</span>
          <button
            type="button"
            style={{...S.btn,padding:'2px 6px',fontSize:10}}
            onClick={async()=>{
              const next=window.prompt('Rename activity:',a.name);
              if(next==null)return;
              const nm=String(next).trim();
              if(!nm||nm===a.name)return;
              const res=await api.renameActivity(a.id,nm);
              if(res&&res.error){window.alert(String(res.error));return;}
              setActivities(await api.getActivities()||[]);
              setTActs(tActs.map(x=>x===a.name?nm:x));
              setTemplates(await api.getTemplates()||[]);
            }}
          >Rename</button>
          <button
            type="button"
            style={{...S.btn,...S.btnDanger,padding:'2px 6px',fontSize:10}}
            onClick={async()=>{
              if(!window.confirm(`Delete activity "${a.name}"?`))return;
              const res=await api.deleteActivity(a.id);
              if(res&&res.error){window.alert(String(res.error));return;}
              setActivities(await api.getActivities()||[]);
              setTActs(tActs.filter(x=>x!==a.name));
            }}
          >Delete</button>
        </div>)}
        {activities.filter(a=>a.type===templateTab).length===0&&<span style={{fontSize:11,color:T.faint}}>No activities yet</span>}
      </div>
    </div>}
    <h3 style={S.section}>Saved Templates</h3>
    {scopedTemplates.length===0&&<p style={{color:T.faint,fontSize:12,marginBottom:16}}>No templates for this programme yet</p>}
    {scopedTemplates.map(t=>{let acts=[],durs=[];try{acts=JSON.parse(t.sequence)||[]}catch(_){}try{durs=JSON.parse(t.durations)||[]}catch(_){}const aligned=alignTemplateDurations(acts,durs);const total=aligned.reduce((a,b)=>a+b,0);
      return<div key={t.id} style={{padding:14,background:grad.cardSurface,borderRadius:12,border:'1px solid rgba(26,26,46,0.06)',marginBottom:8,boxShadow:shadowCard}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
          <div><span style={{fontSize:14,fontWeight:700,color:T.text}}>{t.name}</span><span style={{fontSize:10,color:T.faint,marginLeft:8}}>{total} days</span></div>
          <div style={{display:'flex',gap:4,flexWrap:'wrap',justifyContent:'flex-end'}}>
            <button type="button" onClick={()=>setSelTpl(selTpl===t.id?null:t.id)} style={{...S.btn,...(selTpl===t.id?S.btnAct:{}),fontSize:10,padding:'4px 10px'}}>Apply</button>
            {isAdmin&&<button type="button" onClick={()=>void duplicateTpl(t)} style={{...S.btn,fontSize:10,padding:'4px 10px'}}>Duplicate</button>}
            {isAdmin&&<button type="button" onClick={()=>startEdit(t)} style={{...S.btn,fontSize:10,padding:'4px 10px'}}>Edit</button>}
            {isAdmin&&<button type="button" onClick={()=>void removeTpl(t.id,t.name)} style={{...S.btn,...S.btnDanger,fontSize:10,padding:'4px 10px'}}>Delete</button>}
          </div>
        </div>
        <div style={{display:'flex',flexWrap:'wrap',gap:3}}>{acts.map((a,i)=><span key={i} style={S.pill(a)}>{a} ({aligned[i]}d)</span>)}</div>
        {selTpl===t.id&&<div style={{marginTop:10,padding:10,background:'rgba(66,133,244,0.06)',borderRadius:8,border:'1px solid rgba(66,133,244,0.2)'}}>
          <div style={{fontSize:10,fontWeight:600,color:T.muted,marginBottom:6,textTransform:'uppercase'}}>Apply to:</div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
            <input value={apTower} onChange={e=>setApTower(e.target.value)} placeholder="Tower" style={{...S.input,width:80,fontSize:12,padding:'6px 10px'}}/>
            <input value={apZone} onChange={e=>setApZone(e.target.value)} placeholder="Zone (Pour 5)" style={{...S.input,width:120,fontSize:12,padding:'6px 10px'}}/>
            <input type="date" value={toHtmlDateInputValue(apStart)} onChange={e=>setApStart(e.target.value)} style={{...S.input,width:140,fontSize:12,padding:'6px 10px'}}/>
            <button onClick={handleApply} style={{...S.btn,...S.btnPrimary,fontSize:11}}>Apply</button>
          </div>
          <NonWorkingAnchorDateWarning dateKey={apStart} />
          <div style={{fontSize:9,color:T.faint,marginTop:4}}>Creates {total} scheduleable days (Mondays–Fridays; Saturdays, Sundays, and England and Wales bank holidays excluded)</div>
        </div>}
      </div>})}
    {isAdmin&&<><h3 style={S.section}>{editingId?'Edit template':'Create template'}</h3>
    <div style={{padding:14,background:T.surface,borderRadius:12,border:`1px solid ${T.hairline}`,boxShadow:'0 1px 3px rgba(26,26,46,0.04)'}}>
      {editingId&&<p style={{fontSize:11,color:T.muted,margin:'0 0 10px',lineHeight:1.45}}>Saving applies your changes and refreshes programme dates for any zones that were built from this template (done activities stay fixed).</p>}
      <div style={{display:'flex',gap:8,marginBottom:10,flexWrap:'wrap'}}>
        <input value={tName} onChange={e=>setTName(e.target.value)} style={{...S.input,width:200}} placeholder="Template name"/>
        <input value={tTower} onChange={e=>setTTower(e.target.value)} style={{...S.input,width:80}} placeholder="Tower"/>
        <input value={tZone} onChange={e=>setTZone(e.target.value)} style={{...S.input,width:120}} placeholder="Zone"/>
      </div>
      <div style={{fontSize:10,color:T.muted,marginBottom:6}}>Select activities in order:</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:10}}>
        {seq.map(a=>{const on=tActs.includes(a);return<button key={a} onClick={()=>togAct(a)} style={{padding:'5px 10px',borderRadius:6,fontSize:10,fontWeight:600,cursor:'pointer',border:on?`2px solid ${actColor(a,0.9)}`:`1px solid ${T.hairline}`,background:on?actColor(a,0.2):'transparent',color:on?actColor(a,0.95):T.faint}}>{a}</button>})}
      </div>
      {orphansInTemplate.length>0&&<>
      <div style={{fontSize:10,color:T.muted,marginBottom:6}}>Steps saved on this template but not in the catalogue above (add them under “New activity” or they will not schedule):</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:4,marginBottom:10}}>
        {orphansInTemplate.map((a,i)=><span key={`${a}-${i}`} style={{padding:'5px 10px',borderRadius:6,fontSize:10,fontWeight:600,border:`1px dashed ${T.hairline}`,color:T.text,background:'rgba(244,165,26,0.08)'}}>{a}</span>)}
      </div></>}
      {tActs.length>0&&<>
      <div style={{fontSize:10,color:T.muted,marginBottom:6}}>Adjust sequence and durations:</div>
      <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:12}}>
        {tActs.map((a,i)=><div
          key={i}
          draggable
          onDragStart={()=>setDragActIdx(i)}
          onDragOver={(e)=>e.preventDefault()}
          onDrop={()=>{
            if(dragActIdx==null||dragActIdx===i)return;
            moveAct(dragActIdx,i);
            setDragActIdx(null);
          }}
          onDragEnd={()=>setDragActIdx(null)}
          style={{
            display:'flex',
            alignItems:'center',
            gap:6,
            flexWrap:'wrap',
            padding:'6px 6px',
            borderRadius:8,
            border:dragActIdx===i?'1px dashed rgba(66,133,244,0.55)':'1px dashed transparent',
            background:dragActIdx===i?'rgba(66,133,244,0.06)':'transparent',
            cursor:'grab',
          }}>
          <span style={{fontSize:10,fontWeight:700,color:T.faint,width:24,textAlign:'right'}}>{i+1}.</span>
          <span style={{fontSize:11,color:T.faint}}>⋮⋮</span>
          <span style={{...S.pill(a),fontSize:9}}>{a}</span>
          <input type="number" min="0.5" max="30" step="0.5" value={tDurs[i]} onChange={e=>setDur(i,e.target.value)} style={{...S.input,width:68,fontSize:12,padding:'4px 8px',textAlign:'center'}}/>
          <span style={{fontSize:9,color:T.faint,marginRight:2}}>days</span>
          <button type="button" disabled={i===0} onClick={()=>moveAct(i,i-1)} style={{...S.btn,padding:'4px 8px',fontSize:10,opacity:i===0?0.4:1}}>↑</button>
          <button type="button" disabled={i===tActs.length-1} onClick={()=>moveAct(i,i+1)} style={{...S.btn,padding:'4px 8px',fontSize:10,opacity:i===tActs.length-1?0.4:1}}>↓</button>
        </div>)}
      </div><div style={{fontSize:11,color:T.muted,marginBottom:10}}>Total: {tDurs.reduce((a,b)=>a+b,0)} working days</div></>}
      <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
        <button type="button" onClick={()=>void saveTpl()} disabled={!tName||!tActs.length} style={{...S.btn,...(tName&&tActs.length?S.btnPrimary:{}),opacity:tName&&tActs.length?1:0.4}}>{editingId?'Save changes':'Save template'}</button>
        {editingId&&<button type="button" onClick={cancelEdit} style={S.btn}>Cancel edit</button>}
      </div>
    </div></>}
    </div>
    <PageFooterHint>
      Build once, apply to any zone.{' '}
      {templateTab==='groundworks'?`${GW_SEQUENCE.length} groundworks activities.`:
        templateTab==='internals'?`${INT_SEQUENCE.length} internal activities.`:
        templateTab===MODULE_PROGRAMME_TAB?`${MODULE_SEQUENCE.length} module handover stages — schedule on Programme, track live stage on Modules.`:
        'Master programme lines — add named activities below (not tied to floor drawings).'}
    </PageFooterHint>
  </div>;
}

function DashboardCompletionSection({ userTabs, isAdmin, planRows, comp }) {
  const todayKey = dateKey(new Date());
  const [drawings, setDrawings] = useState([]);
  const [drawing, setDrawing] = useState(null);
  const [zones, setZones] = useState([]);
  const [scopeTab, setScopeTab] = useState('');
  const [drawingId, setDrawingId] = useState('');
  const [mode, setMode] = useState('today'); // today | date | replay
  const [manualDate, setManualDate] = useState(todayKey);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [printOpen, setPrintOpen] = useState(false);
  const [printOpts, setPrintOpts] = useState({ paper: 'A3', orientation: 'landscape' });
  const titleRestoreRef = useRef(typeof document !== 'undefined' ? document.title : '');

  useEffect(() => {
    function afterPrint() {
      document.body.classList.remove('dashboard-completion-print-mode');
      document.title = titleRestoreRef.current || '119HS';
      clearPrintPageSize();
    }
    window.addEventListener('afterprint', afterPrint);
    return () => window.removeEventListener('afterprint', afterPrint);
  }, []);

  const permittedTabs = useMemo(
    () => buildPermittedScopeTabs({ userTabs, planRows, isAdmin }),
    [isAdmin, userTabs, planRows]
  );

  useEffect(() => {
    if (!permittedTabs.length) return;
    setScopeTab((prev) => (prev && permittedTabs.includes(prev) ? prev : permittedTabs[0]));
  }, [permittedTabs]);

  useEffect(() => {
    let cancelled = false;
    setLoadErr('');
    api.getDrawings()
      .then((data) => {
        if (cancelled) return;
        setDrawings(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(e?.message || 'Could not load drawings');
        setDrawings([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scopeDrawings = useMemo(
    () => drawings.filter((d) => String(d.tab || '') === drawingTabForScope(scopeTab)),
    [drawings, scopeTab]
  );

  useEffect(() => {
    setDrawingId((prev) => {
      if (prev && scopeDrawings.some((d) => Number(d.id) === Number(prev))) return prev;
      return scopeDrawings[0]?.id ? String(scopeDrawings[0].id) : '';
    });
  }, [scopeDrawings]);

  useEffect(() => {
    if (!drawingId) {
      setDrawing(null);
      setZones([]);
      return undefined;
    }
    let cancelled = false;
    setLoadErr('');
    Promise.all([api.getDrawing(drawingId), api.getZonesForDrawing(drawingId)])
      .then(([d, z]) => {
        if (cancelled) return;
        setDrawing(d || null);
        setZones(Array.isArray(z) ? z : []);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(e?.message || 'Could not load drawing zones');
        setDrawing(null);
        setZones([]);
      });
    return () => {
      cancelled = true;
    };
  }, [drawingId]);

  const rowsInScope = useMemo(
    () => (planRows || []).filter((r) => scopeForRow(r) === String(scopeTab || '')),
    [planRows, scopeTab]
  );

  const replayDays = useMemo(() => {
    const starts = rowsInScope.map((r) => String(r.start_date || '').trim()).filter(Boolean).sort();
    const start = starts[0] || todayKey;
    return calendarDaysBetween(start, todayKey);
  }, [rowsInScope, todayKey]);

  useEffect(() => {
    setReplayIndex((idx) => Math.min(Math.max(0, idx), Math.max(0, replayDays.length - 1)));
  }, [replayDays]);

  useEffect(() => {
    if (!playing || mode !== 'replay' || replayDays.length <= 1) return undefined;
    const id = window.setInterval(() => {
      setReplayIndex((idx) => {
        if (idx >= replayDays.length - 1) {
          window.clearInterval(id);
          setPlaying(false);
          return idx;
        }
        return idx + 1;
      });
    }, 120);
    return () => window.clearInterval(id);
  }, [playing, mode, replayDays]);

  const asOfDate = mode === 'today' ? todayKey : mode === 'date' ? manualDate : replayDays[replayIndex] || todayKey;
  const levelStat = useMemo(
    () => drawingLevelCompletionAsOf(asOfDate, drawing, zones, rowsInScope, comp),
    [asOfDate, drawing, zones, rowsInScope, comp]
  );

  const drawingLabel = scopeDrawings.find((d) => String(d.id) === String(drawingId))?.name || 'No drawing';
  const levelLabel = drawing ? floorLabelFromDrawing(drawing, zones) : '';

  function runCompletionPrint() {
    setPrintOpen(false);
    setPrintPageSize(printOpts);
    titleRestoreRef.current = document.title;
    document.title = `119HS_Completion_${scopeTab || 'scope'}_${asOfDate}`;
    document.body.classList.add('dashboard-completion-print-mode');
    requestAnimationFrame(() => {
      window.print();
    });
  }

  function labelForZone() {
    if (!levelLabel) return '';
    if (levelStat?.pct == null) return levelLabel;
    const pct = Math.round(levelStat.pct * 100);
    return `${levelLabel}\n${pct}%`;
  }

  const legend = (
    <div
      className="dashboard-completion-legend"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 16px',
        margin: '0 0 10px',
        padding: '9px 12px',
        borderRadius: 10,
        background: 'rgba(46,178,96,0.06)',
        border: `1px solid ${T.hairline}`,
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    >
      <span style={{ fontSize: 9, fontWeight: 700, color: T.faint, textTransform: 'uppercase', letterSpacing: '0.14em' }}>
        Completion
      </span>
      {COMPLETION_BUCKETS.map((b) => (
        <span key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              background: b.fill,
              border: `2px solid ${b.stroke}`,
              boxSizing: 'border-box',
              WebkitPrintColorAdjust: 'exact',
              printColorAdjust: 'exact',
            }}
          />
          <span style={{ fontSize: 11, color: T.text, fontWeight: 600 }}>{b.label}</span>
        </span>
      ))}
    </div>
  );

  return (
    <section className="dashboard-completion-section" style={{
      padding: '18px 20px',
      borderRadius: 16,
      background: grad.cardSurface,
      border: '1px solid rgba(26,26,46,0.06)',
      boxShadow: shadowCard,
      marginTop: 18,
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.faint, textTransform: 'uppercase', letterSpacing: '0.16em', marginBottom: 6 }}>Completion</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Completion drawing</div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 4, lineHeight: 1.45 }}>
            Each drawing level shades green from programme ticks across all pour areas (A, B, C…) on that floor. Pick a drawing, scope, and date.
          </div>
        </div>
        <button type="button" onClick={() => setPrintOpen(true)} className="dashboard-completion-no-print" style={{ ...S.btn, padding: '6px 12px', fontSize: 11 }}>
          Print
        </button>
      </div>

      <div className="dashboard-completion-no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <label style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>
          Scope
          <select value={scopeTab} onChange={(e) => setScopeTab(e.target.value)} style={{ ...S.input, display: 'block', marginTop: 4, width: 170, fontSize: 12, padding: '6px 10px' }}>
            {permittedTabs.map((t) => <option key={t} value={t}>{drawingTabLabel(t)}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>
          Drawing
          <select value={drawingId} onChange={(e) => setDrawingId(e.target.value)} style={{ ...S.input, display: 'block', marginTop: 4, width: 220, fontSize: 12, padding: '6px 10px' }}>
            {scopeDrawings.length === 0 && <option value="">No drawings</option>}
            {scopeDrawings.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
          </select>
        </label>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, marginBottom: 4 }}>View</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {['today', 'date', 'replay'].map((m) => (
              <button key={m} type="button" onClick={() => { setMode(m); if (m !== 'replay') setPlaying(false); }} style={{ ...S.btn, ...(mode === m ? S.btnAct : {}), padding: '6px 10px', fontSize: 11 }}>
                {m === 'today' ? 'Today' : m === 'date' ? 'Date' : 'Replay'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'date' && (
          <label style={{ fontSize: 10, fontWeight: 700, color: T.muted }}>
            As of
            <input type="date" value={toHtmlDateInputValue(manualDate)} onChange={(e) => setManualDate(e.target.value)} style={{ ...S.input, display: 'block', marginTop: 4, width: 150, fontSize: 12, padding: '6px 10px' }} />
          </label>
        )}
        {mode === 'replay' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 240, flex: '1 1 280px' }}>
            <button type="button" disabled={replayDays.length <= 1} onClick={() => setPlaying((v) => !v)} style={{ ...S.btn, padding: '6px 12px', fontSize: 11 }}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, replayDays.length - 1)}
              value={replayIndex}
              onChange={(e) => { setPlaying(false); setReplayIndex(Number(e.target.value) || 0); }}
              style={{ flex: '1 1 180px' }}
            />
            <span style={{ fontSize: 11, color: T.muted, fontWeight: 600, minWidth: 82 }}>{asOfDate}</span>
          </div>
        )}
      </div>

      {loadErr && <div style={{ fontSize: 12, color: '#c0392b', marginBottom: 10 }}>{loadErr}</div>}
      <div style={{ fontSize: 10, color: T.faint, marginBottom: 10 }}>
        {drawingLabel}{levelLabel ? ` · ${levelLabel}` : ''} · as of {asOfDate}
        {levelStat?.lastFinishedDate ? ` · level finished ${levelStat.lastFinishedDate}` : ''}
      </div>
      {legend}
      <div style={{ borderRadius: 14, overflow: 'hidden', border: `1px solid ${T.hairline}`, background: '#ececf1' }}>
        <ZoneDrawingCanvas
          drawing={drawing}
          zones={zones}
          enableZoomPan
          maxHeight="min(56vh, 520px)"
          horizontalLabels
          emptyMessage="No drawing selected for this scope."
          styleForZone={() => greenShadeForPct(levelStat?.pct ?? null)}
          labelForZone={labelForZone}
          labelActiveForZone={() => Boolean(levelStat && levelStat.pct != null)}
        />
      </div>
      {printOpen && (
        <div
          className="dashboard-completion-print-modal dashboard-completion-no-print"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(26,26,46,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 16,
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dashboard-completion-print-title"
        >
          <div style={{ width: 'min(400px,100%)', background: T.surface, borderRadius: 14, border: `1px solid ${T.hairline}`, padding: 18, boxShadow: '0 12px 40px rgba(26,26,46,0.15)' }}>
            <div id="dashboard-completion-print-title" style={{ fontSize: 16, fontWeight: 800, color: T.text, marginBottom: 12 }}>
              Print Completion Drawing
            </div>
            <p style={{ fontSize: 12, color: T.muted, margin: '0 0 12px', lineHeight: 1.45 }}>
              Drawing: <strong>{drawingLabel}</strong>
              <br />
              Scope: <strong>{drawingTabLabel(scopeTab)}</strong>
              <br />
              As of: <strong>{asOfDate}</strong>
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.muted }}>
                Paper
                <select
                  value={printOpts.paper}
                  onChange={(e) => setPrintOpts((o) => ({ ...o, paper: e.target.value }))}
                  style={{ ...S.input, display: 'block', marginTop: 4, width: '100%', fontSize: 12, padding: '6px 10px' }}
                >
                  <option value="A3">A3</option>
                  <option value="A4">A4</option>
                </select>
              </label>
              <label style={{ fontSize: 11, fontWeight: 600, color: T.muted }}>
                Orientation
                <select
                  value={printOpts.orientation}
                  onChange={(e) => setPrintOpts((o) => ({ ...o, orientation: e.target.value }))}
                  style={{ ...S.input, display: 'block', marginTop: 4, width: '100%', fontSize: 12, padding: '6px 10px' }}
                >
                  <option value="landscape">Landscape</option>
                  <option value="portrait">Portrait</option>
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setPrintOpen(false)} style={{ ...S.btn, padding: '10px 16px' }}>
                Cancel
              </button>
              <button type="button" onClick={runCompletionPrint} style={{ ...S.btn, ...S.btnPrimary, padding: '10px 16px' }}>
                Print
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Dashboard — Module Completion: read-only picture of module handover stages on the plan. */
function DashboardModuleSection(){
  const [drawings,setDrawings]=useState([]);
  const [drawingId,setDrawingId]=useState('');
  const [drawing,setDrawing]=useState(null);
  const [zones,setZones]=useState([]);
  const [coarse,setCoarse]=useState(false);

  useEffect(()=>{
    const mq=window.matchMedia('(pointer: coarse)');
    const fn=()=>setCoarse(!!mq.matches);
    fn();mq.addEventListener('change',fn);
    return()=>mq.removeEventListener('change',fn);
  },[]);

  useEffect(()=>{
    let cancelled=false;
    api.getDrawings().then((d)=>{
      if(cancelled)return;
      const rank=(n)=>{const s=String(n||'').toLowerCase();if(s.includes('basement'))return -1;if(s.includes('ground')||/\bgf\b/.test(s))return 0;const m=s.match(/(\d+)\s*(?:st|nd|rd|th)?\s*floor/)||s.match(/floor\s*(\d+)/)||s.match(/(\d+)/);return m?parseInt(m[1],10):999;};
      const list=(Array.isArray(d)?d:[]).filter((x)=>String(x.tab)===MODULE_HANDOVER_TAB)
        .sort((a,b)=>{const ra=rank(a.name),rb=rank(b.name);return ra!==rb?ra-rb:String(a.name||'').localeCompare(String(b.name||''),undefined,{numeric:true});});
      setDrawings(list);
    }).catch(()=>{if(!cancelled)setDrawings([]);});
    return()=>{cancelled=true;};
  },[]);

  useEffect(()=>{
    setDrawingId((prev)=>{
      if(prev&&drawings.some((d)=>Number(d.id)===Number(prev)))return prev;
      return drawings[0]?.id?String(drawings[0].id):'';
    });
  },[drawings]);

  useEffect(()=>{
    if(!drawingId){setDrawing(null);setZones([]);return undefined;}
    let cancelled=false;
    Promise.all([api.getDrawing(drawingId),api.getZonesForDrawing(drawingId)]).then(([d,z])=>{
      if(cancelled)return;
      setDrawing(d||null);
      setZones(Array.isArray(z)?z:[]);
    }).catch(()=>{if(!cancelled){setDrawing(null);setZones([]);}});
    return()=>{cancelled=true;};
  },[drawingId]);

  // Aggregate every floor's modules for an all-floors total.
  const [allZones,setAllZones]=useState([]);
  useEffect(()=>{
    if(!drawings.length){setAllZones([]);return undefined;}
    let cancelled=false;
    Promise.all(drawings.map((d)=>api.getZonesForDrawing(d.id).then((z)=>Array.isArray(z)?z:[]).catch(()=>[])))
      .then((lists)=>{if(!cancelled)setAllZones(lists.flat());});
    return()=>{cancelled=true;};
  },[drawings]);

  const summary=useMemo(()=>moduleCompletionSummary(zones),[zones]);
  const totalSummary=useMemo(()=>moduleCompletionSummary(allZones),[allZones]);

  if(!drawings.length){
    return(
      <section style={{padding:18,background:grad.cardSurface,borderRadius:16,border:'1px solid rgba(26,26,46,0.06)',boxShadow:shadowCard,marginTop:16}}>
        <div style={{fontSize:16,fontWeight:800,color:T.text,marginBottom:6}}>Module completion</div>
        <div style={{fontSize:13,color:T.muted}}>No module floor plans are set up yet. Drawings added in the Modules tab will appear here.</div>
      </section>
    );
  }

  const legend=(
    <div style={{display:'flex',flexWrap:'wrap',gap:10,padding:'10px 12px',background:T.surface,border:`1px solid ${T.hairline}`,borderRadius:10,marginTop:10}}>
      <span style={{fontSize:11,fontWeight:800,color:T.muted,textTransform:'uppercase',letterSpacing:'0.06em'}}>Stages</span>
      {MODULE_STAGES.map((s)=>(
        <span key={s.key} style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12,color:T.text,fontWeight:600}}>
          <span style={{width:14,height:14,borderRadius:3,background:s.swatch,border:`1px solid ${s.stroke}`}}/>
          {s.label} <span style={{color:T.muted}}>({summary.byStage[s.key]||0})</span>
        </span>
      ))}
    </div>
  );

  return(
    <section style={{padding:18,background:grad.cardSurface,borderRadius:16,border:'1px solid rgba(26,26,46,0.06)',boxShadow:shadowCard,marginTop:16}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap',marginBottom:10}}>
        <div>
          <div style={{fontSize:16,fontWeight:800,color:T.text}}>Module completion</div>
          <div style={{fontSize:13,color:T.muted}}>
            <strong style={{color:T.text}}>All floors:</strong> {totalSummary.handed} of {totalSummary.total} modules handed over · {totalSummary.pct}%
          </div>
          {drawings.length>1&&(
            <div style={{fontSize:12,color:T.faint,marginTop:2}}>
              This floor: {summary.handed} of {summary.total} · {summary.pct}%
            </div>
          )}
        </div>
        {drawings.length>1&&(
          <select value={drawingId} onChange={(e)=>setDrawingId(e.target.value)} style={{...S.input,padding:'7px 10px',fontSize:13,minWidth:170}}>
            {drawings.map((d)=>(<option key={d.id} value={String(d.id)}>{d.name}</option>))}
          </select>
        )}
      </div>
      <div style={{borderRadius:12,overflow:'hidden',border:`1px solid ${T.hairline}`}}>
        <ZoneDrawingCanvas
          drawing={drawing}
          zones={zones}
          enableZoomPan
          coarsePointer={coarse}
          minHeight="min(60vh, 520px)"
          styleForZone={(z)=>{const m=moduleStageMeta(z.handover_stage);return{fill:m.fill,stroke:m.stroke,strokeW:0.85};}}
          labelForZone={(z)=>String(z.name||'').trim()}
          labelActiveForZone={()=>true}
          emptyMessage="No module drawing yet."
        />
      </div>
      {legend}
    </section>
  );
}

function DashPage({gw,int_s,project_s,comp,isAdmin,isBoardViewer,userTabs,onActivate,liveDataErr}){
  const today=new Date();
  const[metricPlanRows,setMetricPlanRows]=useState([]);
  const[milestones,setMilestones]=useState([]);
  const[planRows,setPlanRows]=useState([]);
  const[mLoadErr,setMLoadErr]=useState('');
  const[mBusy,setMBusy]=useState(false);
  const[refreshing,setRefreshing]=useState(false);
  const[manualDate,setManualDate]=useState(()=>dateKey(today));
  const[manualLabel,setManualLabel]=useState('');
  const[manualStatus,setManualStatus]=useState('planned');
  const[manualCompletion,setManualCompletion]=useState(0);
  const[pickFilter,setPickFilter]=useState('');
  const[pickSelId,setPickSelId]=useState('');
  const[pickDateEdge,setPickDateEdge]=useState('end');/* start | end */
  const[pickStatus,setPickStatus]=useState('planned');

  const refreshMilestones=useCallback(async({silent=false}={})=>{
    if(!silent)setMLoadErr('');
    try{
      const m=await api.getMilestones();
      setMilestones(Array.isArray(m)?m:[]);
    }catch(e){
      if(!silent){
        setMLoadErr(e?.message||'Failed to load milestones');
        setMilestones([]);
      }
    }
  },[]);

  const refreshPlanMetrics=useCallback(async({silent=false}={})=>{
    try{
      let raw;
      if(isAdmin){
        raw=await api.getPlanProgrammeFullExport();
        if(!Array.isArray(raw)||isApiErrorPayload(raw))raw=await api.getPlanProgramme();
      }else{
        raw=await api.getPlanProgramme();
      }
      setMetricPlanRows(Array.isArray(raw)&&!isApiErrorPayload(raw)?raw:[]);
    }catch(_){
      if(!silent)setMetricPlanRows([]);
    }
  },[isAdmin]);

  const silentRefresh=useCallback(()=>{
    void onActivate?.({silent:true});
    void refreshMilestones({silent:true});
    void refreshPlanMetrics({silent:true});
  },[onActivate,refreshMilestones,refreshPlanMetrics]);

  /** Manual Refresh button — pull every dashboard data source, not just the parent live data. */
  const manualRefresh=useCallback(async()=>{
    setRefreshing(true);
    try{
      await Promise.all([
        Promise.resolve(onActivate?.()),
        refreshMilestones(),
        refreshPlanMetrics(),
      ]);
    }finally{
      setRefreshing(false);
    }
  },[onActivate,refreshMilestones,refreshPlanMetrics]);

  useRefreshOnFocus(silentRefresh);

  const compSig=useMemo(()=>JSON.stringify(comp||{}),[comp]);
  useEffect(()=>{void refreshMilestones()},[refreshMilestones,compSig]);

  useEffect(()=>{
    void onActivate?.();
  },[onActivate]);

  useEffect(()=>{
    void refreshPlanMetrics();
  },[refreshPlanMetrics,onActivate]);

  useEffect(()=>{
    if(!isAdmin)return;
    let cancelled=false;
    (async()=>{
      try{
        const rows=await api.getPlanProgrammeFullExport();
        if(!cancelled)setPlanRows(Array.isArray(rows)?rows:[]);
      }catch(_){
        const rows=await api.getPlanProgramme();
        if(!cancelled)setPlanRows(Array.isArray(rows)?rows:[]);
      }
    })();
    return()=>{cancelled=true};
  },[isAdmin]);

  const pickOptions=useMemo(()=>buildProgrammeMilestonePicklist(planRows),[planRows]);
  const pickFiltered=useMemo(()=>{
    const q=String(pickFilter||'').trim().toLowerCase();
    if(!q)return pickOptions;
    return pickOptions.filter(o=>o.searchHaystack.includes(q));
  },[pickOptions,pickFilter]);

  useEffect(()=>{
    if(!pickSelId)return;
    const ok=pickFiltered.some(o=>String(o.programmeItemId)===String(pickSelId));
    if(!ok)setPickSelId('');
  },[pickFiltered,pickSelId]);

  async function addMilestoneRow(date,label,status,completionPct,programmeItemId=null){
    setMBusy(true);
    try{
      const p=Math.max(0,Math.min(100,Math.round(Number(completionPct)||0)));
      const res=await api.addMilestone(date,label,status||'planned',p,programmeItemId);
      if(res&&res.error){window.alert(String(res.error));return;}
      await refreshMilestones();
    }finally{setMBusy(false);}
  }

  async function patchMilestoneCompletion(id,pct){
    const p=Math.max(0,Math.min(100,Math.round(Number(pct)||0)));
    setMBusy(true);
    try{
      const res=await api.patchMilestone(id,{completion_pct:p});
      if(res&&res.error){window.alert(String(res.error));return;}
      await refreshMilestones();
    }finally{setMBusy(false);}
  }

  async function removeMilestone(id){
    if(!window.confirm('Remove this milestone?'))return;
    setMBusy(true);
    try{
      const res=await api.deleteMilestone(id);
      if(res&&res.error){window.alert(String(res.error));return;}
      await refreshMilestones();
    }finally{setMBusy(false);}
  }

  async function updateMilestoneStatus(id,status){
    setMBusy(true);
    try{
      const res=await api.patchMilestone(id,{status});
      if(res&&res.error){window.alert(String(res.error));return;}
      await refreshMilestones();
    }finally{setMBusy(false);}
  }

  async function unlinkMilestoneProgramme(id){
    setMBusy(true);
    try{
      const res=await api.patchMilestone(id,{programme_item_id:null});
      if(res&&res.error){window.alert(String(res.error));return;}
      await refreshMilestones();
    }finally{setMBusy(false);}
  }
  const ov=useMemo(
    ()=>overallActivityCompletion(metricPlanRows,comp),
    [metricPlanRows,comp]
  );
  const gwRem=Math.max(0,ov.gw.total-ov.gw.done);
  const intRem=Math.max(0,ov.int.total-ov.int.done);
  const projRem=Math.max(0,ov.project.total-ov.project.done);
  const modRem=Math.max(0,ov.module.total-ov.module.done);

  const riskList=useMemo(()=>{
    const tk=dateKey(new Date());
    const todayOrd=milestoneDayOrd(tk);
    if(todayOrd==null)return[];
    const out=[];
    for(const r of metricPlanRows){
      const statusLower=String(r.status||'').toLowerCase();
      const statusNorm=statusLower.replace(/-/g,'_');
      if(statusLower==='done')continue;
      const endK=String(r.end_date||'').trim();
      if(!endK)continue;
      const endOrd=milestoneDayOrd(endK);
      if(endOrd==null)continue;
      const complete=isProgrammeRowFullyDone(r,comp);
      const daysUntil=endOrd-todayOrd;
      let severity=null;
      let kind='';
      let dayLabel='';
      if(endOrd<todayOrd&&!complete){
        severity='critical';
        kind='Overdue';
        dayLabel=`${todayOrd-endOrd}d overdue`;
      }else if(!complete&&daysUntil>=1&&daysUntil<=3){
        severity='warning';
        kind='Urgent';
        dayLabel=daysUntil===1?'1 day left':`${daysUntil} days left`;
      }else if(statusNorm==='at_risk'){
        severity='warning';
        kind='At risk';
        if(endOrd<todayOrd)dayLabel=`${todayOrd-endOrd}d overdue`;
        else if(daysUntil===0)dayLabel='Due today';
        else dayLabel=`${daysUntil}d to due`;
      }else continue;
      const tw=String(r.tower||'').trim();
      const zn=String(r.zone_name||'').trim();
      out.push({
        key:String(r.id??`${tw}|${zn}|${endK}|${kind}`),
        tower:tw,
        zone:zn,
        activity:String(r.activity_name||'').trim(),
        tab:String(r.drawing_tab||''),
        due:endK,
        severity,
        kind,
        dayLabel,
        endOrd,
      });
    }
    out.sort((a,b)=>{
      const rank=(s)=>(s==='critical'?0:1);
      const c=rank(a.severity)-rank(b.severity);
      if(c!==0)return c;
      return a.endOrd-b.endOrd;
    });
    return out;
  },[metricPlanRows,comp]);

  const gwPct = ov.gw.total > 0 ? Math.round((ov.gw.done / ov.gw.total) * 100) : 0;
  const intPct = ov.int.total > 0 ? Math.round((ov.int.done / ov.int.total) * 100) : 0;
  const projPct = ov.project.total > 0 ? Math.round((ov.project.done / ov.project.total) * 100) : 0;
  const modPct = ov.module.total > 0 ? Math.round((ov.module.done / ov.module.total) * 100) : 0;

  const sectionPace = useMemo(() => {
    const todayK = dateKey(new Date());
    function calcPaceDrawingTab(tab) {
      let expectedDone = 0, actualDone = 0;
      for (const r of metricPlanRows) {
        if (String(r.drawing_tab || '') !== tab) continue;
        const tw = String(r.tower || '').trim();
        const zn = String(r.zone_name || '').trim();
        const act = String(r.activity_name || '').trim();
        if (!tw || !zn || !act) continue;
        const endK = String(r.end_date || '').trim();
        if (!endK || endK > todayK) continue;
        expectedDone++;
        if (isProgrammeRowFullyDone(r, comp)) actualDone++;
      }
      const delta = actualDone - expectedDone;
      return { expectedDone, actualDone, delta };
    }
    function calcPaceScope(scopeTab) {
      let expectedDone = 0, actualDone = 0;
      for (const r of metricPlanRows) {
        if (scopeForRow(r) !== scopeTab) continue;
        const tw = String(r.tower || '').trim();
        const zn = String(r.zone_name || '').trim();
        const act = String(r.activity_name || '').trim();
        if (!tw || !zn || !act) continue;
        const endK = String(r.end_date || '').trim();
        if (!endK || endK > todayK) continue;
        expectedDone++;
        if (isProgrammeRowFullyDone(r, comp)) actualDone++;
      }
      const delta = actualDone - expectedDone;
      return { expectedDone, actualDone, delta };
    }
    return {
      gw: calcPaceDrawingTab('groundworks'),
      int: calcPaceDrawingTab('internals'),
      project: calcPaceDrawingTab(PROJECT_PROGRAMME_TAB),
      module: calcPaceScope(MODULE_PROGRAMME_TAB),
    };
  }, [metricPlanRows, comp]);

  const sectionBreakdowns = useMemo(
    () => [
      {
        key: 'gw',
        label: 'Groundworks',
        accent: '66,133,244',
        ...programmeCompletionBreakdown(metricPlanRows, comp, (r) => String(r.drawing_tab || '') === 'groundworks'),
      },
      {
        key: 'int',
        label: 'Internals',
        accent: '142,68,173',
        ...programmeCompletionBreakdown(metricPlanRows, comp, (r) => String(r.drawing_tab || '') === 'internals'),
      },
    ],
    [metricPlanRows, comp]
  );

  const metrics=[
    {k:'gw',glyph:'◇',label:'Groundworks (remaining)',sub:`${ov.gw.done} of ${ov.gw.total} GW activities ticked · ${gwPct}% complete`,value:String(gwRem),accent:'66,133,244',bg:'rgba(66,133,244,0.06)'},
    {k:'int',glyph:'◆',label:'Internals (remaining)',sub:`${ov.int.done} of ${ov.int.total} INT activities ticked · ${intPct}% complete`,value:String(intRem),accent:'142,68,173',bg:'rgba(142,68,173,0.07)'},
    {k:'proj',glyph:'▣',label:'Project programme (remaining)',sub:`${ov.project.done} of ${ov.project.total} project activities ticked · ${projPct}% complete`,value:String(projRem),accent:'230,126,34',bg:'rgba(230,126,34,0.07)'},
    {k:'mod',glyph:'▦',label:'Modules (remaining)',sub:`${ov.module.done} of ${ov.module.total} module activities ticked · ${modPct}% complete`,value:String(modRem),accent:'46,178,96',bg:'rgba(46,178,96,0.07)'},
  ];
  return<div className="dashboard-page-root" style={{
    flex:1,
    overflow:'hidden',
    background:`linear-gradient(165deg,rgba(235,238,245,0.85) 0%,${T.bg} 22%,${T.bg} 100%)`,
    display:'flex',
    flexDirection:'column',
    minHeight:0,
  }}>
    <PageHeader
      title="Dashboard"
      actions={
        <>
          <div style={{
            padding:'10px 14px',
            borderRadius:12,
            background:grad.cardSurface,
            border:'1px solid rgba(26,26,46,0.06)',
            boxShadow:shadowCard,
          }}>
            <div style={{fontSize:9,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.12em',marginBottom:4}}>Today</div>
            <div style={{fontSize:13,fontWeight:700,color:T.text,lineHeight:1.35}}>{formatDate(today)}</div>
          </div>
          <button type="button" disabled={refreshing} onClick={()=>void manualRefresh()} style={{...S.btn,padding:'8px 14px',fontSize:12,opacity:refreshing?0.6:1}}>
            {refreshing?'Refreshing…':'Refresh'}
          </button>
        </>
      }
    />
    <div className="dashboard-page-content" style={{flex:1,minHeight:0,overflowY:'auto',maxWidth:760,margin:'0 auto',padding:'22px 18px 12px',width:'100%'}}>
      {liveDataErr&&(
        <div style={{
          marginBottom:14,
          padding:'12px 14px',
          borderRadius:12,
          border:'1px solid rgba(192,57,43,0.35)',
          background:'rgba(192,57,43,0.08)',
          fontSize:12,
          color:'#922b21',
          lineHeight:1.45,
        }}>
          <strong style={{display:'block',marginBottom:4}}>Could not refresh live programme data</strong>
          {liveDataErr}
          <div style={{marginTop:8}}>
            <button type="button" disabled={refreshing} onClick={()=>void manualRefresh()} style={{...S.btn,padding:'6px 12px',fontSize:11}}>
              Retry
            </button>
          </div>
        </div>
      )}
      <section style={{
        padding:'22px 22px 24px',
        background:grad.cardSurface,
        borderRadius:20,
        border:'1px solid rgba(26,26,46,0.06)',
        boxShadow:shadowCard,
        marginBottom:16,
        position:'relative',
        overflow:'hidden',
      }}>
        <div style={{
          position:'absolute',
          top:0,
          right:0,
          width:'42%',
          height:'100%',
          background:'radial-gradient(ellipse at 100% 0%, rgba(66,133,244,0.07) 0%, transparent 55%)',
          pointerEvents:'none',
        }}/>
        <div style={{position:'relative'}}>
          <CompletionRing pct={ov.pct} done={ov.done} total={ov.total}/>
        </div>
      </section>

      <div style={{
        display:'grid',
        gridTemplateColumns:'repeat(auto-fit, minmax(156px, 1fr))',
        gap:12,
        marginBottom:18,
      }}>
        {metrics.map((s)=><div key={s.k} style={{
          position:'relative',
          padding:'16px 16px 16px 18px',
          background:grad.cardSurface,
          borderRadius:16,
          border:`1px solid rgba(${s.accent},0.14)`,
          boxShadow:shadowCard,
          overflow:'hidden',
        }}>
          <div style={{
            position:'absolute',
            left:0,
            top:12,
            bottom:12,
            width:4,
            borderRadius:'0 4px 4px 0',
            background:`linear-gradient(180deg, rgba(${s.accent},0.85), rgba(${s.accent},0.35))`,
          }}/>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
            <span style={{
              width:32,
              height:32,
              borderRadius:10,
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              fontSize:14,
              background:s.bg,
              color:`rgba(${s.accent},0.92)`,
              fontWeight:700,
            }} aria-hidden>{s.glyph}</span>
            <div style={{minWidth:0}}>
              <div style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.1em'}}>{s.label}</div>
              <div style={{fontSize:11,color:T.muted,marginTop:2,lineHeight:1.3}}>{s.sub}</div>
            </div>
          </div>
          <div style={{fontSize:22,fontWeight:800,color:`rgba(${s.accent},0.96)`,letterSpacing:'-0.02em',lineHeight:1.2}}>{s.value}</div>
        </div>)}
      </div>

      <section style={{
        marginBottom:18,
        padding:'16px 18px 14px',
        borderRadius:16,
        background:grad.cardSurface,
        border:'1px solid rgba(26,26,46,0.06)',
        boxShadow:shadowCard,
      }}>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.16em',marginBottom:4}}>Section progress</div>
          <div style={{fontSize:14,fontWeight:700,color:T.text}}>Completion by section</div>
        </div>
        {[
          {key:'gw',label:'Groundworks',pct:gwPct,done:ov.gw.done,total:ov.gw.total,pace:sectionPace.gw,accent:'66,133,244'},
          {key:'int',label:'Internals',pct:intPct,done:ov.int.done,total:ov.int.total,pace:sectionPace.int,accent:'142,68,173'},
          {key:'proj',label:'Project programme',pct:projPct,done:ov.project.done,total:ov.project.total,pace:sectionPace.project,accent:'230,126,34'},
          {key:'mod',label:'Modules',pct:modPct,done:ov.module.done,total:ov.module.total,pace:sectionPace.module,accent:'46,178,96'},
        ].map((sec)=>{
          const {delta,expectedDone,actualDone}=sec.pace;
          const paceLabel=expectedDone===0?null:delta<0?`${Math.abs(delta)} behind plan`:delta>0?`${delta} ahead of plan`:'On plan';
          const paceColor=delta<0?'rgba(192,57,43,0.9)':delta>0?'rgba(39,174,96,0.9)':'rgba(46,178,96,0.9)';
          return(
            <div key={sec.key} style={{marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:5}}>
                <span style={{fontSize:12,fontWeight:700,color:T.text}}>{sec.label}</span>
                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                  {paceLabel&&(
                    <span style={{fontSize:10,fontWeight:700,color:paceColor}}>{paceLabel}</span>
                  )}
                  <span style={{fontSize:12,fontWeight:800,color:`rgba(${sec.accent},0.95)`}}>{sec.pct}%</span>
                  <span style={{fontSize:10,color:T.muted}}>{sec.done}/{sec.total}</span>
                </div>
              </div>
              <div style={{height:6,borderRadius:3,background:'rgba(26,26,46,0.07)',overflow:'hidden'}}>
                <div style={{height:'100%',borderRadius:3,width:`${sec.pct}%`,background:`rgba(${sec.accent},0.75)`,transition:'width 0.4s ease'}}/>
              </div>
              {expectedDone>0&&(
                <div style={{fontSize:10,color:T.muted,marginTop:3}}>{actualDone} of {expectedDone} tasks due by today ticked</div>
              )}
            </div>
          );
        })}
      </section>

      <section style={{
        marginBottom:18,
        padding:'16px 18px 14px',
        borderRadius:16,
        background:grad.cardSurface,
        border:'1px solid rgba(26,26,46,0.06)',
        boxShadow:shadowCard,
      }}>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.16em',marginBottom:4}}>By tower &amp; level</div>
          <div style={{fontSize:14,fontWeight:700,color:T.text}}>Completion by tower</div>
          <div style={{fontSize:11,color:T.muted,marginTop:4,lineHeight:1.45}}>
            Each tower shows floors from ground up (GF, 1st, 2nd, …). Floor progress rolls up all zones on that level (e.g. T1 A/B/C on floor 1). 100% when every activity on the level is ticked; the finish date is the last programme tick on that level.
          </div>
        </div>
        {sectionBreakdowns.map((sec, idx)=>(
          <div key={sec.key} style={{marginBottom:idx<sectionBreakdowns.length-1?18:0,paddingBottom:idx<sectionBreakdowns.length-1?14:0,borderBottom:idx<sectionBreakdowns.length-1?`1px solid rgba(26,26,46,0.07)`:'none'}}>
            <div style={{fontSize:11,fontWeight:800,color:`rgba(${sec.accent},0.92)`,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:10}}>{sec.label}</div>
            <DashboardTowerBreakdown towerGroups={sec.towerGroups} accent={sec.accent} showFinishedDate/>
          </div>
        ))}
      </section>

      {!isBoardViewer && (
      <section style={{
        marginBottom:18,
        padding:'16px 18px 14px',
        borderRadius:16,
        background:grad.cardSurface,
        border:'1px solid rgba(26,26,46,0.06)',
        boxShadow:shadowCard,
      }}>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.16em',marginBottom:4}}>Risk</div>
          <div style={{fontSize:14,fontWeight:700,color:T.text}}>Programme flags</div>
          <div style={{fontSize:11,color:T.muted,marginTop:4,lineHeight:1.45}}>
            Overdue (past due, not fully ticked), urgent (due in 1–3 working days with gaps), and rows marked at risk.
          </div>
        </div>
        {riskList.length===0?(
          <p style={{margin:0,fontSize:12,color:T.muted,lineHeight:1.5}}>No programme risks flagged for your scope.</p>
        ):(
          <div style={{maxHeight:320,overflowY:'auto',paddingRight:4,display:'flex',flexDirection:'column',gap:10}}>
            {riskList.map((item)=>{
              const isCrit=item.severity==='critical';
              const borderRgb=isCrit?'192,57,43':'230,126,34';
              const badgeBg=isCrit?'rgba(192,57,43,0.12)':'rgba(230,126,34,0.12)';
              const badgeFg=isCrit?'#922b21':'#a0520d';
              return(
                <div
                  key={item.key}
                  style={{
                    padding:'12px 14px 12px 16px',
                    borderRadius:12,
                    border:`1px solid rgba(26,26,46,0.06)`,
                    background:'rgba(26,26,46,0.02)',
                    borderLeft:`4px solid rgb(${borderRgb})`,
                    boxShadow:'0 1px 3px rgba(26,26,46,0.04)',
                  }}
                >
                  <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:8,marginBottom:6}}>
                    <span style={{
                      fontSize:9,
                      fontWeight:800,
                      letterSpacing:'0.06em',
                      textTransform:'uppercase',
                      padding:'4px 8px',
                      borderRadius:6,
                      background:badgeBg,
                      color:badgeFg,
                    }}>{item.kind}</span>
                    <span style={{fontSize:11,fontWeight:700,color:T.muted}}>{item.dayLabel}</span>
                  </div>
                  <div style={{fontSize:13,fontWeight:700,color:T.text,lineHeight:1.35}}>
                    {[item.tower,item.zone].filter(Boolean).join(' · ')||item.zone}
                  </div>
                  <div style={{fontSize:12,color:T.muted,marginTop:2}}>{item.activity}</div>
                  <div style={{fontSize:10,color:T.faint,marginTop:6}}>
                    Due {item.due}
                    {item.tab?` · ${drawingTabLabel(item.tab)}`:''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}

      {!isBoardViewer && (
      <section style={{
        padding:'18px 20px',
        borderRadius:16,
        background:grad.cardSurface,
        border:'1px solid rgba(26,26,46,0.06)',
        boxShadow:shadowCard,
      }}>
        <div style={{display:'flex',flexWrap:'wrap',alignItems:'baseline',justifyContent:'space-between',gap:10,marginBottom:12}}>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.16em',marginBottom:6}}>Milestones</div>
            <div style={{fontSize:14,fontWeight:700,color:T.text}}>Milestone health</div>
            <div style={{fontSize:11,color:T.muted,marginTop:4,lineHeight:1.45}}>Milestone, date due, completion %, and colour band for on track vs risk. Rows linked from the programme picklist take % from daily Update ticks on those scheduled activity days.</div>
          </div>
          {isAdmin&&<button type="button" disabled={mBusy} onClick={()=>void refreshMilestones()} style={{...S.btn,padding:'6px 12px',fontSize:11}}>Refresh</button>}
        </div>
        {milestones.length>0&&<div style={{display:'flex',flexWrap:'wrap',gap:12,fontSize:10,color:T.faint,marginBottom:12,lineHeight:1.5}}>
          <span style={{display:'flex',alignItems:'center',gap:6}}><span style={{width:10,height:10,borderRadius:3,background:'rgb(39,174,96)',flexShrink:0}}/> On track</span>
          <span style={{display:'flex',alignItems:'center',gap:6}}><span style={{width:10,height:10,borderRadius:3,background:'rgb(230,126,34)',flexShrink:0}}/> Watch</span>
          <span style={{display:'flex',alignItems:'center',gap:6}}><span style={{width:10,height:10,borderRadius:3,background:'rgb(231,76,60)',flexShrink:0}}/> At risk</span>
          <span style={{display:'flex',alignItems:'center',gap:6}}><span style={{width:10,height:10,borderRadius:3,background:'rgb(46,178,96)',flexShrink:0}}/> Complete (100%)</span>
        </div>}
        {mLoadErr&&<div style={{fontSize:12,color:'#c0392b',marginBottom:10}}>{mLoadErr}</div>}
        {milestones.length===0&&!mLoadErr&&<p style={{margin:0,fontSize:12,color:T.muted,lineHeight:1.5}}>No milestones yet.{isAdmin?' Add significant dates below or pull one from the programme picker.':''}</p>}
        {milestones.length>0&&<div style={{display:'flex',flexDirection:'column',gap:10,marginBottom:isAdmin?16:0}}>
          {milestones.map(m=>{
            const d=new Date(String(m.date)+'T12:00:00');
            const pct=Math.max(0,Math.min(100,Math.round(Number(m.completion_pct)||0)));
            const health=milestoneHealthVisual(m);
            const du=daysUntilMilestoneDue(m.date);
            const duePhrase=du==null?'Due date':du===0?'Due today':du>0?`Due in ${du}d`:`${Math.abs(du)}d overdue`;
            return<div key={m.id} style={{
              display:'flex',
              borderRadius:12,
              overflow:'hidden',
              border:'1px solid rgba(26,26,46,0.06)',
              background:health.tint,
              boxShadow:`inset 3px 0 0 rgba(37,99,235,0.22), ${shadowCard}`,
            }}>
              <div style={{width:5,flexShrink:0,background:`rgb(${health.rgb})`}} aria-hidden/>
              <div style={{flex:1,minWidth:0,padding:'12px 14px'}}>
                <div style={{display:'flex',flexWrap:'wrap',alignItems:'flex-start',justifyContent:'space-between',gap:10,marginBottom:8}}>
                  <div style={{flex:'1 1 200px',minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:700,color:T.text,lineHeight:1.35}}>{m.label}</div>
                    <div style={{fontSize:11,color:T.muted,marginTop:4}}>
                      <span style={{fontWeight:600,color:T.text}}>Date due:</span>{' '}{formatShort(d)} {d.getFullYear()} · {duePhrase}
                    </div>
                    {m.tracks_live&&<div style={{fontSize:10,color:T.faint,marginTop:6,lineHeight:1.45}}>
                      {m.live_ticks_total>0
                        ?<>Progress from Update: <strong style={{color:T.muted,fontWeight:600}}>{m.live_ticks_done}</strong> / {m.live_ticks_total} scheduled day-slots ticked</>
                        :<>Linked to programme — no matching schedule rows yet; completion stays at 0% until Plan days exist.</>}
                    </div>}
                  </div>
                  <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8}}>
                    <span style={{
                      fontSize:10,
                      fontWeight:800,
                      letterSpacing:'0.04em',
                      textTransform:'uppercase',
                      padding:'5px 10px',
                      borderRadius:999,
                      background:`rgba(${health.rgb},0.22)`,
                      color:health.badgeFg,
                      border:`1px solid rgba(${health.rgb},0.35)`,
                    }}>{health.label}</span>
                    <span style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase'}}>{m.status||'planned'}</span>
                  </div>
                </div>
                <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:12}}>
                  <div style={{flex:'1 1 160px',minWidth:120,height:10,borderRadius:6,background:'rgba(26,26,46,0.07)',overflow:'hidden'}}>
                    <div style={{
                      width:`${pct}%`,
                      height:'100%',
                      borderRadius:6,
                      background:`linear-gradient(90deg,rgba(${health.rgb},0.95),rgba(${health.rgb},0.65))`,
                      transition:'width 0.25s ease',
                    }}/>
                  </div>
                  <span style={{fontSize:14,fontWeight:800,color:T.text,minWidth:44}}>{pct}%</span>
                  {isAdmin&&!m.tracks_live&&<>
                    <label style={{fontSize:10,color:T.faint,display:'flex',alignItems:'center',gap:6}}>
                      <span>Edit %</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        defaultValue={pct}
                        key={`mc-${m.id}-${pct}`}
                        disabled={mBusy}
                        onBlur={(e)=>{
                          const v=Math.max(0,Math.min(100,Math.round(Number(e.target.value)||0)));
                          if(v!==pct)void patchMilestoneCompletion(m.id,v);
                        }}
                        onKeyDown={(e)=>{if(e.key==='Enter')e.target.blur();}}
                        style={{...S.input,width:52,fontSize:12,padding:'4px 8px'}}
                      />
                    </label>
                  </>}
                </div>
                {isAdmin&&<div style={{display:'flex',flexWrap:'wrap',gap:8,marginTop:10,alignItems:'center'}}>
                  <select value={m.status||'planned'} disabled={mBusy} onChange={(e)=>void updateMilestoneStatus(m.id,e.target.value)} style={{...S.input,width:'auto',fontSize:11,padding:'4px 8px'}}>
                    {MILESTONE_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  {m.programme_item_id!=null&&<button type="button" disabled={mBusy} onClick={()=>void unlinkMilestoneProgramme(m.id)} style={{...S.btn,padding:'4px 10px',fontSize:11}} title="Stop using Update ticks for this row; you can then edit % manually">Unlink programme</button>}
                  <button type="button" disabled={mBusy} onClick={()=>void removeMilestone(m.id)} style={{...S.btn,...S.btnDanger,padding:'4px 10px',fontSize:11}}>Remove</button>
                </div>}
              </div>
            </div>;
          })}
        </div>}

        {isAdmin&&<>
          <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:'uppercase',letterSpacing:'0.1em',margin:'14px 0 8px'}}>Add manually</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center',marginBottom:14}}>
            <input type="date" value={toHtmlDateInputValue(manualDate)} onChange={(e)=>setManualDate(e.target.value)} style={{...S.input,width:'auto',fontSize:12,padding:'6px 10px'}}/>
            <input value={manualLabel} onChange={(e)=>setManualLabel(e.target.value)} placeholder="e.g. Tower 1 GF complete · Commission · 278 target" style={{...S.input,flex:1,minWidth:200,fontSize:12,padding:'6px 10px'}}/>
            <label style={{fontSize:11,color:T.muted,display:'flex',alignItems:'center',gap:6}}>
              % done
              <input type="number" min={0} max={100} value={manualCompletion} onChange={(e)=>setManualCompletion(Math.max(0,Math.min(100,Math.round(Number(e.target.value)||0))))} style={{...S.input,width:56,fontSize:12,padding:'6px 8px'}}/>
            </label>
            <select value={manualStatus} onChange={(e)=>setManualStatus(e.target.value)} style={{...S.input,width:'auto',fontSize:12,padding:'6px 10px'}}>
              {MILESTONE_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" disabled={mBusy||!manualLabel.trim()} onClick={()=>void addMilestoneRow(manualDate,manualLabel.trim(),manualStatus,manualCompletion).then(()=>{setManualLabel('');setManualCompletion(0);})} style={{...S.btn,...S.btnPrimary,padding:'8px 14px',fontSize:11}}>Add milestone</button>
          </div>

          <div style={{fontSize:11,fontWeight:700,color:T.muted,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:6}}>From programme (pick one)</div>
          <p style={{margin:'0 0 10px',fontSize:11,color:T.faint,lineHeight:1.5}}>
            Use this only when a scheduled programme line represents a <strong style={{fontWeight:600,color:T.muted}}>major</strong> date — handovers, commission, level completes, module landings, master targets (for example “278 target”). Search, select a row, choose whether the milestone date is the activity start or end, then add.
          </p>
          <input value={pickFilter} onChange={(e)=>setPickFilter(e.target.value)} placeholder="Search drawing, tower, zone, activity…" style={{...S.input,width:'100%',maxWidth:420,fontSize:12,padding:'8px 10px',marginBottom:8,boxSizing:'border-box'}}/>
          <select size={Math.min(8,Math.max(3,pickFiltered.length||3))} value={pickSelId} onChange={(e)=>setPickSelId(e.target.value)} style={{...S.input,width:'100%',maxWidth:520,fontSize:11,padding:6,marginBottom:8,fontFamily:'inherit'}}>
            <option value="">{pickOptions.length===0?'No programme rows loaded — check Programme / drawings':'— Choose a programme line —'}</option>
            {pickFiltered.map((o)=><option key={String(o.programmeItemId)} value={String(o.programmeItemId)}>{formatShort(new Date(o.end_date+'T12:00:00'))} · {o.label}</option>)}
          </select>
          <div style={{display:'flex',flexWrap:'wrap',gap:10,alignItems:'center',marginBottom:10}}>
            <span style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase'}}>Date</span>
            <label style={{fontSize:11,color:T.text,display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
              <input type="radio" name="msedge" checked={pickDateEdge==='end'} onChange={()=>setPickDateEdge('end')}/> End (typical for “complete”)
            </label>
            <label style={{fontSize:11,color:T.text,display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
              <input type="radio" name="msedge" checked={pickDateEdge==='start'} onChange={()=>setPickDateEdge('start')}/> Start
            </label>
            <select value={pickStatus} onChange={(e)=>setPickStatus(e.target.value)} style={{...S.input,width:'auto',fontSize:11,padding:'4px 8px'}}>
              {MILESTONE_STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
            </select>
            <button type="button" disabled={mBusy||!pickSelId} onClick={()=>{
              const o=pickOptions.find(x=>String(x.programmeItemId)===String(pickSelId));
              if(!o)return;
              const d=pickDateEdge==='start'?o.start_date:o.end_date;
              void addMilestoneRow(d,o.label,pickStatus,0,o.programmeItemId);
            }} style={{...S.btn,...S.btnPrimary,padding:'8px 14px',fontSize:11}}>Add selected</button>
          </div>
        </>}
      </section>
      )}

      <DashboardCompletionSection
        userTabs={userTabs}
        isAdmin={isAdmin}
        planRows={metricPlanRows}
        comp={comp}
      />

      <DashboardModuleSection />
    </div>
    <PageFooterHint>Programme snapshot — completion across Groundworks, Internals, Project programme, and Modules.</PageFooterHint>
  </div>;
}

function csvEscape(v){if(v==null||v===undefined)return'';const s=String(v);return/[",\r\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function downloadCsv(filename,rows){
  const lines=rows.map(r=>r.map(csvEscape).join(','));
  const blob=new Blob(['\uFEFF'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}

function scheduleSliceForLookaheadTab(gw,int_s,project_s,tab,dk){
  if(tab==='groundworks')return gw[dk];
  if(tab===PROJECT_PROGRAMME_TAB)return project_s?.[dk];
  return int_s[dk];
}

/** Tower + zone label from completion prefix (matches Update keys). */
function towerZoneFromPfx(pfx){
  const s=String(pfx||'');
  if(!s.includes('|'))return{tower:s||'—',zone:'—'};
  const i=s.indexOf('|');
  return{tower:s.slice(0,i)||'—',zone:s.slice(i+1)||'—'};
}

/** Rolling window of 21 scheduleable days (skips Saturdays, Sundays, and England & Wales bank holidays). */
function lookaheadWorkingDays(anchorDate) {
  const out = [];
  const d = new Date(anchorDate);
  let added = 0;
  let steps = 0;
  const MAX_STEPS = 120;
  while (added < 21 && steps < MAX_STEPS) {
    steps++;
    const dk = dateKey(d);
    if (!isNonWorkingPlanDayKey(dk)) {
      out.push(new Date(d));
      added++;
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** One CSV row per scheduled activity; includes ISO date and Update tick status. */
function buildLookAheadExportRows(planRows, comp, anchorDate, tab) {
  const scope = drawingTabLabel(tab);
  const header = [
    'Date_ISO',
    'Date_display',
    'Weekday',
    'Week_chunk',
    'Tower',
    'Zone',
    'Activity',
    'Completion_key',
    'Done',
    'Completed_by',
    'Completed_at',
    'Scope',
  ];
  const rows = [header];
  const days = lookaheadWorkingDays(anchorDate);
  days.forEach((d, idx) => {
    const dk = dateKey(d);
    const { sections } = buildUpdateSectionsFromPlanRows(planRows, dk, [tab]);
    const weekChunk = Math.floor(idx / 7) + 1;
    const wd = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const display = `${formatShort(d)} ${d.getFullYear()}`;
    sections.forEach((sec) => {
      sec.acts.forEach((act) => {
        const ck = `${sec.pfx}|${act}`;
        const cm = comp[dk]?.[ck];
        const done = cm ? 'Yes' : 'No';
        const { tower, zone } = towerZoneFromPfx(sec.pfx);
        rows.push([
          dk,
          display,
          wd,
          String(weekChunk),
          tower,
          zone,
          act,
          ck,
          done,
          cm?.by || '',
          cm?.at || '',
          scope,
        ]);
      });
    });
  });
  return rows;
}

const SELECTED_TABS_KEY = '119hs_selected_tabs';

function readStoredSelectedTabs() {
  try {
    const raw = localStorage.getItem(SELECTED_TABS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return Array.isArray(p) ? normalizeProgrammeScopeTabs(p.map(String)) : null;
  } catch (_) {
    return null;
  }
}

function UpdPage({ date, comp, userTabs, isAdmin, canTick, userName, onSubmitted, onRefreshLiveData, selectedTabs, onSelectedTabsChange, scopeLocked = false }) {
  const k = dateKey(date);
  const nonWorkingDay = isNonWorkingPlanDayKey(k);
  const [planRows, setPlanRows] = useState([]);
  const [loadErr, setLoadErr] = useState('');

  const reloadPlan = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoadErr('');
    try {
      let data;
      if (isAdmin) {
        data = await api.getPlanProgrammeFullExport();
        if (!Array.isArray(data)) data = await api.getPlanProgramme();
      } else {
        data = await api.getPlanProgramme();
      }
      setPlanRows(Array.isArray(data) ? data : []);
    } catch (e) {
      if (!silent) {
        setLoadErr(e?.message || 'Failed to load programme');
        setPlanRows([]);
      }
    }
  }, [isAdmin]);

  const silentRefresh = useCallback(() => {
    void reloadPlan({ silent: true });
    void onRefreshLiveData?.({ silent: true });
  }, [reloadPlan, onRefreshLiveData]);

  useRefreshOnFocus(silentRefresh);

  useEffect(() => {
    void reloadPlan();
  }, [reloadPlan]);

  const permittedTabs = useMemo(
    () => buildPermittedScopeTabs({ userTabs, planRows, isAdmin }),
    [isAdmin, userTabs, planRows]
  );

  useEffect(() => {
    if (scopeLocked) {
      onSelectedTabsChange([MODULE_PROGRAMME_TAB]);
      return;
    }
    if (!permittedTabs.length) return;
    onSelectedTabsChange((prev) => {
      const normPrev = normalizeProgrammeScopeTabs(prev);
      const kept = normPrev.filter((t) => permittedTabs.includes(t));
      if (kept.length) return permittedTabs.filter((t) => kept.includes(t));
      return [...permittedTabs];
    });
  }, [permittedTabs, onSelectedTabsChange, scopeLocked]);

  const selectedSet = useMemo(() => new Set(selectedTabs), [selectedTabs]);

  const { sections, metaByCk } = useMemo(
    () => buildUpdateSectionsFromPlanRows(planRows, k, selectedTabs),
    [planRows, k, selectedTabs]
  );

  const compSnap = comp[k] ? JSON.stringify(comp[k]) : '';
  const [draft, setDraft] = useState(() => (comp[k] ? JSON.parse(JSON.stringify(comp[k])) : {}));
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => {
    setDraft(comp[k] ? JSON.parse(JSON.stringify(comp[k])) : {});
  }, [k, compSnap]);

  const dc = draft;
  let tot = 0,
    done = 0;
  sections.forEach((s) => {
    tot += s.acts.length;
    s.acts.forEach((a) => {
      if (dc[`${s.pfx}|${a}`]) done++;
    });
  });
  const pct = tot > 0 ? Math.round((done / tot) * 100) : 0;
  const baseline = comp[k] ? JSON.parse(JSON.stringify(comp[k])) : {};
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(dc)]);
  let dirty = false;
  for (const ck of allKeys) {
    if (!!baseline[ck] !== !!dc[ck]) {
      dirty = true;
      break;
    }
  }

  function toggleProgrammeTab(t) {
    onSelectedTabsChange((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        next.delete(t);
        if (next.size === 0) return [t];
      } else {
        next.add(t);
      }
      return permittedTabs.filter((x) => next.has(x));
    });
  }

  function selectAllProgrammeTabs() {
    onSelectedTabsChange([...permittedTabs]);
  }

  function toggleDraft(ck) {
    if (!canTick) return;
    setDraft((p) => {
      const n = { ...p };
      if (n[ck]) delete n[ck];
      else n[ck] = { by: userName, at: '…' };
      return n;
    });
  }

  async function submitDay() {
    if (!canTick || submitting || !dirty) return;
    setSubmitting(true);
    setToast('');
    try {
      const fresh = await api.getCompletions();
      if (!fresh) return;
      const cur = fresh[k] || {};
      const want = dc;
      const keys = new Set([...Object.keys(cur), ...Object.keys(want)]);
      for (const ck of keys) {
        const w = !!want[ck],
          h = !!cur[ck];
        if (w !== h) await api.toggleCompletion(k, ck, userName);
      }

      const newTicks = [];
      for (const ck of keys) {
        if (want[ck] && !cur[ck]) newTicks.push(ck);
      }
      const zoneToMeta = new Map();
      for (const ck of newTicks) {
        const m = metaByCk.get(ck);
        if (!m) continue;
        const zid = Number(m.zone_id);
        if (!Number.isFinite(zid)) continue;
        if (!zoneToMeta.has(zid)) zoneToMeta.set(zid, []);
        zoneToMeta.get(zid).push(m);
      }
      const patchById = new Map();
      for (const [zid, metas] of zoneToMeta) {
        const maxEnd = metas.reduce((mx, m) => (String(m.end_date) > mx ? String(m.end_date) : mx), '');
        let savedMax = 0;
        for (const m of metas) {
          if (String(m.end_date) <= k) continue;
          savedMax = Math.max(savedMax, dayOrdKey(m.end_date) - dayOrdKey(k));
        }
        if (savedMax <= 0 || !maxEnd) continue;
        for (const r of planRows) {
          if (Number(r.zone_id) !== zid) continue;
          if (String(r.status || '').toLowerCase() === 'done') continue;
          if (String(r.start_date) <= maxEnd) continue;
          patchById.set(Number(r.id), {
            start_date: addCalendarDays(r.start_date, -savedMax),
            end_date: addCalendarDays(r.end_date, -savedMax),
          });
        }
      }
      if (patchById.size) {
        const msg = `${patchById.size} later planned row(s) in the same zone(s) can move earlier by the calendar days you saved. Apply this pull to the programme?`;
        if (window.confirm(msg)) {
          for (const [id, patch] of patchById) {
            const out = await api.updateProgrammeItem(id, patch);
            if (out && out.error) {
              window.alert(String(out.error));
              break;
            }
          }
        }
      }

      if (onSubmitted) await onSubmitted();
      await reloadPlan();
      setToast('Locked in — programme updated for everyone');
      setTimeout(() => setToast(''), 2800);
    } catch (_) {
      setToast('Submit failed — try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ overflow: 'hidden', flex: 1, background: T.bg, display: 'flex', flexDirection: 'column', minHeight: 0, paddingBottom: canTick && dirty ? 80 : 0 }}>
      <PageHeader
        title="Update"
        collapsible
        collapsibleSummary={selectedTabs.map((t) => drawingTabLabel(t))}
        actions={
          <button type="button" onClick={() => void reloadPlan()} style={{ ...S.btn, padding: '8px 14px', fontSize: 12 }}>
            Refresh
          </button>
        }
        filters={
          permittedTabs.length > 0 ? (
            scopeLocked ? (
              <>
                <span className="page-header__filter-label">Scope</span>
                <span style={{ ...S.btn, ...S.btnAct, padding: '6px 12px', fontSize: 11, cursor: 'default' }}>
                  {drawingTabLabel(MODULE_PROGRAMME_TAB)}
                </span>
              </>
            ) : (
            <>
              <span className="page-header__filter-label">Show tabs</span>
              {permittedTabs.length > 1 && (
                <button type="button" onClick={selectAllProgrammeTabs} style={{ ...S.btn, padding: '5px 10px', fontSize: 10 }}>
                  All tabs
                </button>
              )}
              {permittedTabs.map((t) => {
                const on = selectedSet.has(t);
                const id = `upd-tab-${t}`;
                return (
                  <label
                    key={t}
                    htmlFor={id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: on ? T.text : T.muted,
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleProgrammeTab(t)}
                      style={{ width: 16, height: 16, accentColor: 'rgba(66,133,244,0.95)', cursor: 'pointer' }}
                    />
                    {drawingTabLabel(t)}
                  </label>
                );
              })}
            </>
            )
          ) : null
        }
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      {loadErr && (
        <div style={{ margin: '10px 12px', fontSize: 12, color: '#c0392b' }}>
          {loadErr}{' '}
          <button type="button" onClick={() => void reloadPlan()} style={{ ...S.btn, padding: '4px 10px', fontSize: 11 }}>
            Retry
          </button>
        </div>
      )}
      {nonWorkingDay && !loadErr && (
        <div
          style={{
            margin: '10px 12px',
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid rgba(100,100,120,0.25)',
            background: 'rgba(26,26,46,0.04)',
            fontSize: 12,
            color: T.muted,
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: T.text }}>Non-working day</strong> — Saturdays, Sundays, and England and Wales bank holidays are not used for site programme or
          updates. Nothing to tick today; choose another date in the header.
        </div>
      )}
      {tot > 0 && (
        <div
          style={{
            margin: 12,
            padding: '14px 16px',
            background: 'linear-gradient(135deg,rgba(66,133,244,0.1),rgba(46,178,96,0.06))',
            borderRadius: 14,
            border: '1px solid rgba(66,133,244,0.18)',
            boxShadow: '0 2px 8px rgba(26,26,46,0.04)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Today&apos;s Progress</span>
            <span style={{ fontSize: 28, fontWeight: 800, color: pct === 100 ? 'rgba(46,178,96,1)' : 'rgba(66,133,244,1)' }}>{pct}%</span>
          </div>
          <div style={{ height: 6, background: 'rgba(26,26,46,0.08)', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${pct}%`,
                background: pct === 100 ? 'rgba(46,178,96,0.85)' : 'rgba(66,133,244,0.85)',
                borderRadius: 3,
                transition: 'width 0.4s',
              }}
            />
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
            {done}/{tot} activities
          </div>
        </div>
      )}
      {sections.length > 0 && (
        <div
          style={{
            margin: '0 12px 12px',
            padding: '16px 18px',
            background: T.surface,
            borderRadius: 14,
            border: `1px solid ${T.hairline}`,
            boxShadow: '0 2px 10px rgba(26,26,46,0.05)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>Lock in for the team</div>
          <p style={{ fontSize: 11, color: T.muted, margin: '0 0 14px', lineHeight: 1.5, maxWidth: '42em' }}>
            Tick scheduled activities on this screen, then submit. Your completions are saved on the server and feed overall programme completion for everyone (dashboard, lookahead, exports).
          </p>
          {canTick ? (
            <>
              <button
                type="button"
                onClick={submitDay}
                disabled={!dirty || submitting}
                style={{
                  width: '100%',
                  ...S.btn,
                  ...(dirty && !submitting ? S.btnPrimary : {}),
                  padding: '14px 18px',
                  fontSize: 14,
                  fontWeight: 700,
                  opacity: !dirty || submitting ? 0.5 : 1,
                  cursor: !dirty || submitting ? 'default' : 'pointer',
                }}
              >
                {submitting ? 'Saving…' : dirty ? 'Submit & lock in day’s progress' : 'No changes to submit yet'}
              </button>
              {dirty && !submitting && (
                <div style={{ fontSize: 10, color: 'rgba(244,165,26,0.95)', marginTop: 10, fontWeight: 600 }}>Unsaved ticks — submit to sync the programme.</div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.45 }}>Viewer access: you can see progress but cannot submit updates.</div>
          )}
        </div>
      )}
      {sections.map((sec) => {
        const sd = sec.acts.filter((a) => !!dc[`${sec.pfx}|${a}`]).length;
        const seq = seqForDrawingTab(sec.drawing_tab);
        const zSub = zoneSubtitleForSection(sec, seq, sec.drawing_tab);
        return (
          <div
            key={sec.label}
            style={{
              margin: '8px 12px',
              borderRadius: 14,
              overflow: 'hidden',
              border: `1px solid ${T.hairline}`,
              background: T.surface,
              boxShadow: '0 1px 4px rgba(26,26,46,0.04)',
            }}
          >
            <div style={{ padding: '12px 16px', background: 'rgba(26,26,46,0.03)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{sec.label}</div>
                <div style={{ fontSize: 10, color: T.faint, marginTop: 2 }}>{drawingTabLabel(sec.drawing_tab)}</div>
                {zSub && (
                  <div style={{ fontSize: 11, color: T.muted, marginTop: 4, lineHeight: 1.4 }}>{zSub}</div>
                )}
              </div>
              <span style={{ fontSize: 11, color: sd === sec.acts.length ? 'rgba(46,178,96,0.85)' : T.muted, fontWeight: 600, flexShrink: 0 }}>
                {sd}/{sec.acts.length}
              </span>
            </div>
            {sec.acts.map((act, ai) => {
              const ck = `${sec.pfx}|${act}`,
                cm = dc[ck],
                dn = !!cm,
                si = seq.indexOf(act);
              return (
                <div
                  key={`${act}-${ai}`}
                  onClick={() => toggleDraft(ck)}
                  style={{
                    padding: '14px 16px',
                    borderTop: `1px solid ${T.hairline}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    cursor: canTick ? 'pointer' : 'default',
                    background: dn ? 'rgba(46,178,96,0.06)' : 'transparent',
                    minHeight: 56,
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      flexShrink: 0,
                      border: `2.5px solid ${dn ? 'rgba(46,178,96,0.65)' : 'rgba(26,26,46,0.12)'}`,
                      background: dn ? 'rgba(46,178,96,0.14)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 18,
                      color: dn ? 'rgba(46,178,96,0.95)' : 'transparent',
                    }}
                  >
                    {dn ? '✓' : ''}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: actColor(act, 0.9), flexShrink: 0 }} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: dn ? 'rgba(46,178,96,0.85)' : T.text, textDecoration: dn ? 'line-through' : 'none' }}>{act}</span>
                    </div>
                    {si >= 0 && seq.length > 0 && (
                      <div style={{ fontSize: 9, color: T.faint, marginLeft: 14 }}>
                        Step {si + 1}/{seq.length}
                        {si > 0 ? ` — after ${seq[si - 1]}` : ''}
                      </div>
                    )}
                    {dn && cm && cm.at !== '…' && (
                      <div style={{ fontSize: 9, color: T.faint, marginLeft: 14, marginTop: 1 }}>
                        {cm.by} at {cm.at}
                      </div>
                    )}
                    {dn && cm && cm.at === '…' && (
                      <div style={{ fontSize: 9, color: T.muted, marginLeft: 14, marginTop: 1 }}>
                        Pending submit
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {sections.length === 0 && !loadErr && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: T.faint }}>
          {nonWorkingDay ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Non-working day</div>
              <div style={{ fontSize: 12, marginTop: 8, color: T.muted, maxWidth: 400, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 }}>
                No programme ticks on Saturdays, Sundays, or England and Wales bank holidays. Use the date control above to pick a scheduleable day.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 15, fontWeight: 600 }}>No activities scheduled</div>
              <div style={{ fontSize: 12, marginTop: 8, color: T.muted, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 }}>
                For this date, no programme rows match your selected tabs. Widen scope above or add dates on the Programme page.
              </div>
            </>
          )}
        </div>
      )}
      </div>
      {canTick && dirty && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 56,
            padding: '10px 14px',
            background: T.surface,
            borderTop: `1px solid ${T.hairline}`,
            boxShadow: '0 -4px 20px rgba(26,26,46,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            zIndex: 20,
            maxWidth: 560,
            margin: '0 auto',
          }}
        >
          <span style={{ fontSize: 11, color: T.muted, flex: 1 }}>Lock in to save today’s ticks and refresh overall programme completion.</span>
          <button type="button" onClick={submitDay} disabled={!dirty || submitting} style={{ ...S.btn, ...S.btnPrimary, padding: '12px 22px', whiteSpace: 'nowrap', opacity: !dirty || submitting ? 0.45 : 1 }}>
            {submitting ? 'Saving…' : 'Submit & lock in'}
          </button>
        </div>
      )}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 130,
            left: '50%',
            transform: 'translateX(-50%)',
            background: toast.includes('failed') ? 'rgba(231,76,60,0.95)' : 'rgba(46,178,96,0.95)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 600,
            zIndex: 25,
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          }}
        >
          {toast}
        </div>
      )}
      <PageFooterHint>Tick scheduled activities for the selected day, then submit to lock in progress for the whole team.</PageFooterHint>
    </div>
  );
}

function LAPage({ planRows, comp, date, tab, onRefreshLiveData }) {
  useRefreshOnFocus(() => { void onRefreshLiveData?.({ silent: true }); });
  const todayKey = dateKey(new Date());
  const days = useMemo(() => lookaheadWorkingDays(date), [date]);
  const weeks = useMemo(() => {
    const chunks = [];
    for (let i = 0; i < days.length; i += 7) chunks.push(days.slice(i, i + 7));
    return chunks;
  }, [days]);
  const stats = useMemo(() => {
    let total = 0;
    let done = 0;
    days.forEach((d) => {
      const dk = dateKey(d);
      const { sections } = buildUpdateSectionsFromPlanRows(planRows, dk, [tab]);
      sections.forEach((sec) => {
        sec.acts.forEach((act) => {
          total++;
          if (comp[dk]?.[`${sec.pfx}|${act}`]) done++;
        });
      });
    });
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
  }, [days, planRows, tab, comp]);

  function exportCsv() {
    const rows = buildLookAheadExportRows(planRows, comp, date, tab);
    const fn = `119hs-lookahead-detail-${tab}-${dateKey(date)}.csv`;
    downloadCsv(fn, rows);
  }

  function renderDayCard(d) {
    const k = dateKey(d);
    const { sections } = buildUpdateSectionsFromPlanRows(planRows, k, [tab]);
    const isToday = k === todayKey;
    const weekday=d.toLocaleDateString('en-GB',{weekday:'long'});
    const lines=[];
    sections.forEach((sec)=>{
      const {tower,zone}=towerZoneFromPfx(sec.pfx);
      const locLabel=zone&&zone!=='—'?`${tower} · ${zone}`:tower;
      sec.acts.forEach((act)=>lines.push({sec,act,locLabel}));
    });
    return<div key={k} style={{
      borderRadius:14,
      border:`1px solid ${T.hairline}`,
      background:T.surface,
      overflow:'hidden',
      marginBottom:10,
      boxShadow:'0 2px 10px rgba(26,26,46,0.04)',
    }}>
      <div style={{
        display:'flex',
        flexWrap:'wrap',
        alignItems:'baseline',
        justifyContent:'space-between',
        gap:8,
        padding:'12px 14px',
        background:isToday?'rgba(66,133,244,0.10)':'rgba(26,26,46,0.03)',
        borderBottom:`1px solid ${T.hairline}`,
      }}>
        <div style={{display:'flex',flexWrap:'wrap',alignItems:'baseline',gap:10}}>
          <span style={{fontSize:15,fontWeight:800,color:T.text,letterSpacing:'-0.02em'}}>{weekday}</span>
          <span style={{fontSize:13,color:T.muted}}>{formatShort(d)} {d.getFullYear()}</span>
          {isToday&&<span style={{
            fontSize:9,
            fontWeight:800,
            textTransform:'uppercase',
            letterSpacing:'0.08em',
            padding:'3px 8px',
            borderRadius:999,
            background:'rgba(66,133,244,0.20)',
            color:'rgba(36,68,140,0.95)',
          }}>Today</span>}
        </div>
        <span style={{fontSize:11,color:T.faint,fontFamily:'monospace'}}>{k}</span>
      </div>
      <div style={{padding:'4px 14px 14px'}}>
        {lines.length===0&&<p style={{margin:'14px 0 6px',fontSize:13,color:T.muted,lineHeight:1.5}}>No activities scheduled for this scope.</p>}
        {lines.map(({sec,act,locLabel},li)=>{
          const ck=`${sec.pfx}|${act}`;
          const cm=comp[k]?.[ck];
          const ticked=!!cm;
          return<div key={`${k}-${sec.pfx}-${act}-${li}`} style={{
            display:'flex',
            alignItems:'flex-start',
            gap:12,
            padding:'12px 0',
            borderBottom:li<lines.length-1?`1px solid rgba(26,26,46,0.07)`:'none',
          }}>
            <div style={{
              width:28,
              height:28,
              borderRadius:8,
              flexShrink:0,
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              fontSize:14,
              fontWeight:800,
              color:ticked?'rgba(46,178,96,0.95)':'rgba(26,26,46,0.22)',
              background:ticked?'rgba(46,178,96,0.12)':'rgba(26,26,46,0.05)',
              border:`1px solid ${ticked?'rgba(46,178,96,0.35)':'rgba(26,26,46,0.08)'}`,
            }} aria-hidden>{ticked?'✓':'·'}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:11,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:4}}>{locLabel}</div>
              <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:8}}>
                <span style={{width:8,height:8,borderRadius:2,background:actColor(act,0.88),flexShrink:0}} aria-hidden/>
                <span style={{fontSize:14,fontWeight:600,color:ticked?'rgba(46,178,96,0.88)':T.text,lineHeight:1.35}}>{act}</span>
                <span style={{fontSize:10,color:ticked?'rgba(46,178,96,0.75)':'rgba(230,126,34,0.9)',fontWeight:700}}>{ticked?'Done':'Open'}</span>
              </div>
              {ticked&&cm?.by&&cm?.at&&cm.at!=='…'&&<div style={{fontSize:10,color:T.faint,marginTop:6}}>{cm.by} · {cm.at}</div>}
            </div>
          </div>;
        })}
      </div>
    </div>;
  }

  return<div style={{overflow:'hidden',flex:1,background:T.bg,display:'flex',flexDirection:'column',minHeight:0}}>
    <PageHeader
      title="Look ahead"
      actions={
        <button type="button" onClick={exportCsv} style={{...S.btn,...S.btnPrimary,padding:'8px 14px',fontSize:12,fontWeight:700,whiteSpace:'nowrap'}}>Export CSV</button>
      }
    />
    <div style={{flex:1,minHeight:0,overflowY:'auto',maxWidth:640,margin:'0 auto',padding:'0 14px 12px',width:'100%'}}>
      {stats.total>0?<div style={{
        marginBottom:18,
        padding:'14px 16px',
        borderRadius:14,
        border:`1px solid rgba(66,133,244,0.20)`,
        background:'linear-gradient(135deg,rgba(66,133,244,0.08),rgba(46,178,96,0.05))',
      }}>
        <div style={{fontSize:10,fontWeight:700,color:T.faint,textTransform:'uppercase',letterSpacing:'0.12em',marginBottom:6}}>Window summary</div>
        <div style={{fontSize:16,fontWeight:800,color:T.text}}>{stats.done} / {stats.total} complete <span style={{fontSize:13,fontWeight:700,color:T.muted}}>({stats.pct}%)</span></div>
        <div style={{fontSize:11,color:T.muted,marginTop:6,lineHeight:1.45}}>All scheduled slots in this window; ✓ matches locked-in Update ticks.</div>
      </div>:<div style={{
        marginBottom:18,
        padding:'14px 16px',
        borderRadius:14,
        border:`1px dashed ${T.hairline}`,
        background:'rgba(26,26,46,0.02)',
      }}>
        <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:4}}>Nothing scheduled in this window</div>
        <div style={{fontSize:11,color:T.muted,lineHeight:1.45}}>Try moving the date with ← → above, or switch Groundworks / Internals / Project programme in the header.</div>
      </div>}

      {weeks.map((chunk,wi)=>{
        const label=chunk.length>=2
          ?`${formatShort(chunk[0])} – ${formatShort(chunk[chunk.length-1])}`
          :chunk.length===1?formatShort(chunk[0]):'';
        return<div key={wi} style={{marginBottom:8}}>
          <div style={{
            fontSize:10,
            fontWeight:800,
            color:T.faint,
            textTransform:'uppercase',
            letterSpacing:'0.14em',
            marginBottom:10,
            paddingLeft:2,
          }}>Week {wi+1}{label?` · ${label}`:''}</div>
          {chunk.map(renderDayCard)}
        </div>;
      })}
    </div>
    <PageFooterHint>
      Three-week window from the date above (Saturdays, Sundays, and bank holidays skipped). Matches the {drawingTabLabel(tab)} scope. Export is one row per activity with tick status for Excel or reports.
    </PageFooterHint>
  </div>;
}

function MainApp({user,onLogout,onUserUpdate}){
  const[gw,setGw]=useState({});const[int_s,setInt]=useState({});const[project_s,setProjectSched]=useState({});const[comp,setComp]=useState({});const[planRows,setPlanRows]=useState([]);const[loading,setLoading]=useState(true);
  const[liveDataErr,setLiveDataErr]=useState('');

  useEffect(()=>{
    let cancelled=false;
    api.getMe().then((d)=>{
      if(cancelled||!d?.user||d.error)return;
      localStorage.setItem('119hs-user',JSON.stringify(d.user));
      onUserUpdate?.(d.user);
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[]);
  const[tab,setTab]=useState(()=>{
    if(roleIsModulesEditor(user.role))return MODULE_PROGRAMME_TAB;
    return pickInitialScopeTab(user.tabs);
  });
  const[page,setPage]=useState(()=>bottomNavItemsForRole(user.role)[0]?.id||'plan');const[date,setDate]=useState(()=>new Date());
  const[selectedScopeTabs,setSelectedScopeTabs]=useState(()=>{
    if(roleIsModulesEditor(user.role))return [MODULE_PROGRAMME_TAB];
    const base=normalizeProgrammeScopeTabs(Array.isArray(user.tabs)&&user.tabs.length?user.tabs:['groundworks','internals']);
    const stored=readStoredSelectedTabs();
    if(stored?.length){
      const kept=stored.filter((t)=>base.includes(t));
      if(kept.length)return base.filter((t)=>kept.includes(t));
      return normalizeProgrammeScopeTabs(stored);
    }
    return [...base];
  });
  const allowedPageIds=useMemo(()=>allowedPageIdsForRole(user.role),[user.role]);
  const loadData=useCallback(async(opts)=>{
    const silent=opts?.silent===true;
    let tabs=Array.isArray(user.tabs)?[...user.tabs].filter(Boolean):[];
    if(!tabs.length&&(roleIsAdmin(user.role)||roleIsSiteEditor(user.role)||roleIsBoardViewer(user.role)||roleIsProgrammeViewer(user.role)))tabs=[...MAIN_HEADER_TAB_ORDER];
    if(!silent)setLiveDataErr('');
    try{
      const planPromise = roleIsAdmin(user.role)
        ? api.getPlanProgrammeFullExport().then((d) => (Array.isArray(d) && !isApiErrorPayload(d) ? d : api.getPlanProgramme()))
        : api.getPlanProgramme();
      const[g,i,c,p,planRaw]=await Promise.all([
        tabs.includes('groundworks')?api.getSchedule('groundworks'):Promise.resolve({}),
        tabs.includes('internals')?api.getSchedule('internals'):Promise.resolve({}),
        api.getCompletions(),
        tabs.includes(PROJECT_PROGRAMME_TAB)?api.getSchedule(PROJECT_PROGRAMME_TAB):Promise.resolve({}),
        planPromise,
      ]);
      const errMsgs=[];
      if(isApiErrorPayload(g))errMsgs.push(`Groundworks schedule: ${g.error}`);
      if(isApiErrorPayload(i))errMsgs.push(`Internals schedule: ${i.error}`);
      if(isApiErrorPayload(p))errMsgs.push(`Project programme schedule: ${p.error}`);
      if(isApiErrorPayload(c))errMsgs.push(`Completions: ${c.error}`);
      if(isApiErrorPayload(planRaw))errMsgs.push(`Plan programme: ${planRaw.error}`);
      if(!silent){
        setLiveDataErr(errMsgs.join(' · '));
      }else if(errMsgs.length){
        console.warn('[119HS] silent live-data refresh failed:',errMsgs.join(' · '));
      }
      if(!isApiErrorPayload(g))setGw(asScheduleMap(g));
      if(!isApiErrorPayload(i))setInt(asScheduleMap(i));
      if(!isApiErrorPayload(p))setProjectSched(asScheduleMap(p));
      if(!isApiErrorPayload(c))setComp(asCompletionsMap(c));
      if(!isApiErrorPayload(planRaw))setPlanRows(Array.isArray(planRaw)?planRaw:[]);
    }catch(e){
      console.error(e);
      if(!silent){
        setLiveDataErr(e?.message||'Failed to load programme data');
        setGw({});setInt({});setProjectSched({});setComp({});setPlanRows({});
      }
    }finally{
      if(!silent)setLoading(false);
    }
  },[user.tabs,user.role]);
  useEffect(()=>{void loadData()},[loadData]);
  useEffect(()=>{void loadData()},[page,loadData]);
  useEffect(()=>{
    if(!selectedScopeTabs.length)return;
    if(roleIsModulesEditor(user.role))return;
    try{
      localStorage.setItem(SELECTED_TABS_KEY,JSON.stringify(normalizeProgrammeScopeTabs(selectedScopeTabs)));
    }catch(_){}
  },[selectedScopeTabs,user.role]);
  useEffect(()=>{
    if(!roleIsModulesEditor(user.role))return;
    setTab(MODULE_PROGRAMME_TAB);
    setSelectedScopeTabs([MODULE_PROGRAMME_TAB]);
  },[user.role]);
  const handleSelectedScopeTabsChange=useCallback((next)=>{
    if(roleIsModulesEditor(user.role))return;
    setSelectedScopeTabs(next);
  },[user.role]);
  const navItems=useMemo(()=>bottomNavItemsForRole(user.role),[user.role]);
  useEffect(()=>{
    if(!allowedPageIds.has(page)){
      const fallback=navItems[0]?.id||'plan';
      if(fallback!==page)setPage(fallback);
    }
  },[page,allowedPageIds,navItems]);
  useEffect(()=>{const onKey=e=>{if(['dashboard','zones','programme','templates','settings','plan'].includes(page))return;if(e.key==='ArrowLeft')setDate(d=>{const n=new Date(d);n.setDate(n.getDate()-1);if(n.getDay()===0)n.setDate(n.getDate()-1);return n});if(e.key==='ArrowRight')setDate(d=>{const n=new Date(d);n.setDate(n.getDate()+1);if(n.getDay()===0)n.setDate(n.getDate()+1);return n})};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[page]);
  function nav(dir){setDate(d=>{const n=new Date(d);n.setDate(n.getDate()+dir);if(n.getDay()===0)n.setDate(n.getDate()+dir);return n})}
  if(loading)return<div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:T.bg,color:T.muted,fontFamily:'monospace'}}>Loading...</div>;
  const userTabsSafe=normalizeProgrammeScopeTabs(user.tabs);
  const canSee=t=>userTabsSafe.includes(t);
  const isAdmin=roleIsAdmin(user.role);
  const isModulesEditor=roleIsModulesEditor(user.role);
  const scopeLocked=roleIsScopeLocked(user.role);
  const canEditPlan=roleCanEditPlan(user.role);
  const canTick=roleCanTick(user.role);
  const canEditZp=canEditZonesProgramme(user.role);
  const showDateNav=['update','lookahead'].includes(page);
  const sched=tab==='groundworks'?gw:tab==='internals'?int_s:tab===PROJECT_PROGRAMME_TAB?project_s:{};

  return<div className="app-root-shell">
    <div className="app-header-bar">
      <div style={{display:'flex',alignItems:'center',gap:10}}><Wordmark119HS variant="nav"/>
        {page!=='plan'&&!isModulesEditor&&<div style={{display:'flex',gap:2,background:'rgba(26,26,46,0.05)',borderRadius:8,padding:3,flexWrap:'wrap'}}>{MAIN_HEADER_TAB_ORDER.filter(canSee).map(t=><button key={t} onClick={()=>setTab(t)} style={{...S.btn,...(tab===t?S.btnAct:{}),padding:'6px 14px',fontSize:12}}>{drawingTabLabel(t)}</button>)}</div>}
        {page!=='plan'&&isModulesEditor&&<div style={{display:'flex',gap:2,background:'rgba(26,26,46,0.05)',borderRadius:8,padding:3}}><span style={{...S.btn,...S.btnAct,padding:'6px 14px',fontSize:12,cursor:'default'}}>{drawingTabLabel(MODULE_PROGRAMME_TAB)}</span></div>}</div>
      <div style={{display:'flex',alignItems:'center',gap:6}}><span style={{fontSize:10,color:T.faint}}>{user.name}</span><button onClick={onLogout} style={{...S.btn,fontSize:10,padding:'4px 10px'}}>Logout</button></div>
    </div>
    {showDateNav&&<div className="app-date-nav">
      <button onClick={()=>nav(-1)} style={{...S.btn,fontSize:16,padding:'8px 18px'}}>←</button><div style={{fontSize:15,fontWeight:700,color:T.text}}>{formatDate(date)}</div><button onClick={()=>nav(1)} style={{...S.btn,fontSize:16,padding:'8px 18px'}}>→</button>
    </div>}
    <div className="app-main-content">
      {page==='dashboard'&&<DashPage gw={gw} int_s={int_s} project_s={project_s} comp={comp} isAdmin={isAdmin} isBoardViewer={roleIsBoardViewer(user.role)} userTabs={user.tabs} onActivate={loadData} liveDataErr={liveDataErr}/>}
      {page==='update'&&!roleIsBoardViewer(user.role)&&canTick&&<UpdPage date={date} comp={comp} userTabs={user.tabs} isAdmin={isAdmin} canTick={canTick} userName={user.name} onSubmitted={loadData} onRefreshLiveData={loadData} selectedTabs={selectedScopeTabs} onSelectedTabsChange={handleSelectedScopeTabsChange} scopeLocked={scopeLocked}/>}
      {page==='lookahead'&&!roleIsBoardViewer(user.role)&&<LAPage planRows={planRows} comp={comp} date={date} tab={tab} onRefreshLiveData={loadData}/>}
      {page==='plan'&&<PlanPage tab={tab} userTabs={user.tabs} isAdmin={isAdmin} canEditPlan={canEditPlan} scopeLocked={scopeLocked} canTick={canTick} userName={user.name} selectedTabs={selectedScopeTabs} onSelectedTabsChange={handleSelectedScopeTabsChange}/>}
      {page==='zones'&&<ZoneSetupPage tab={tab} canEdit={canEditZp} isAdmin={isAdmin} isBoardViewer={roleIsBoardViewer(user.role)}/>}
      {page==='modhandover'&&allowedPageIds.has('modhandover')&&<ModuleHandoverPage canManage={roleCanManageModules(user.role)}/>}
      {page==='programme'&&allowedPageIds.has('programme')&&<ProgrammePage tab={tab} canEdit={canEditZp} isAdmin={isAdmin} onScheduleChanged={loadData} zoneSetupAvailable={canEditZp} onGoToZoneSetup={()=>setPage('zones')}/>}
      {page==='templates'&&isAdmin&&<TemplatePage tab={tab} isAdmin={isAdmin} onReload={loadData}/>}
      {page==='settings'&&isAdmin&&<SettingsPage/>}
    </div>
    <nav className="app-bottom-nav" aria-label="Main navigation">
      <div className="app-bottom-nav__track">
        {navItems.map((p)=>(<button key={p.id} type="button" className={`app-bottom-nav__btn${page===p.id?' app-bottom-nav__btn--active':''}`} onClick={()=>setPage(p.id)} aria-current={page===p.id?'page':undefined}><span className="app-bottom-nav__icon" aria-hidden>{p.icon}</span><span className="app-bottom-nav__label">{p.label}</span></button>))}
      </div>
    </nav>
  </div>;
}

export default function App(){
  const[user,setUser]=useState(()=>api.getStoredUser());
  return<AppErrorBoundary>
    {!user?<LoginPage onLogin={setUser}/>:<MainApp user={user} onUserUpdate={setUser} onLogout={()=>{api.logout();setUser(null)}}/>}
  </AppErrorBoundary>;
}
