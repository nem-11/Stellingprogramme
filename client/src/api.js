/** Build-time: set REACT_APP_API_URL to the API origin if the SPA is hosted separately. Leave unset when the API serves the built client (same origin): requests use relative `/api/...` URLs. */
const RAW_BASE = process.env.REACT_APP_API_URL || '';
const BASE = String(RAW_BASE).replace(/\/+$/, '');
/** Same-origin path or full URL for static assets served by the API (e.g. /uploads/...). */
export function absoluteUrl(path) {
  if (!path) return '';
  const p = path.startsWith('/') ? path : `/${path}`;
  return BASE ? `${BASE}${p}` : p;
}
function getToken(){return localStorage.getItem('119hs-token')}
async function api(method,path,body){
  const url = BASE ? `${BASE}${path}` : path;
  const opts={method,headers:{'Content-Type':'application/json'}};
  const token=getToken();if(token)opts.headers['Authorization']='Bearer '+token;
  if(body)opts.body=JSON.stringify(body);
  let res;
  try{
    res=await fetch(url,opts);
  }catch(e){
    const msg=e&&e.message?String(e.message):'Network error';
    const hint = BASE
      ? `Cannot reach API at ${BASE}. Check REACT_APP_API_URL and that the server is running.`
      : 'Cannot reach API (same-origin: ensure the server is running and serving the app, or set REACT_APP_API_URL for a separate API host.)';
    const err=new Error(
      msg==='Failed to fetch'||/network|load failed|fetch/i.test(msg)
        ? hint
        :msg
    );
    err.cause=e;
    throw err;
  }
  if(res.status===401&&path!=='/api/login'){
    localStorage.removeItem('119hs-token');
    window.location.reload();
    return null;
  }
  let data;
  try{
    data=await res.json();
  }catch(_){
    data={};
  }
  if(!res.ok){
    if(!data||typeof data!=='object')data={};
    if(!data.error)data.error=`HTTP ${res.status} ${res.statusText||''}`.trim();
    return data;
  }
  return data;
}
export async function login(u,p){const d=await api('POST','/api/login',{username:u,password:p});if(d?.token){localStorage.setItem('119hs-token',d.token);localStorage.setItem('119hs-user',JSON.stringify(d.user))}return d}
export async function getSitePhoto(){
  const url=BASE?`${BASE}/api/site-photo`:'/api/site-photo';
  const res=await fetch(url);
  return res.json();
}
export async function uploadSitePhoto(file){
  const fd=new FormData();
  fd.append('photo',file);
  const url=BASE?`${BASE}/api/admin/site-photo`:'/api/admin/site-photo';
  const token=getToken();
  const headers={};
  if(token)headers.Authorization='Bearer '+token;
  const res=await fetch(url,{method:'POST',headers,body:fd});
  let data={};
  try{data=await res.json()}catch(_){}
  if(!res.ok){
    if(!data.error)data.error=`HTTP ${res.status}`;
    return data;
  }
  return data;
}
export function logout(){localStorage.removeItem('119hs-token');localStorage.removeItem('119hs-user')}
export function getStoredUser(){const t=getToken(),u=localStorage.getItem('119hs-user');return t&&u?JSON.parse(u):null}
export const getMe=()=>api('GET','/api/me');
export const getActivities=()=>api('GET','/api/activities');
export const createActivity=(name,type)=>api('POST','/api/activities',{name,type});
export const renameActivity=(id,name)=>api('PUT',`/api/activities/${id}`,{name});
export const deleteActivity=(id)=>api('DELETE',`/api/activities/${id}`);
export const getSchedule=(tab)=>api('GET',`/api/schedule/${tab}`);
export const updateScheduleDay=(tab,date,data)=>api('PUT',`/api/schedule/${tab}/${date}`,{data});
export const addScheduleActivity=(tab,date,tower,zone_name,activity)=>api('POST','/api/schedule/activity',{tab,date,tower,zone_name,activity});
export const removeScheduleActivity=(tab,date,tower,zone_name,activity)=>api('DELETE','/api/schedule/activity',{tab,date,tower,zone_name,activity});
export const getCompletions=()=>api('GET','/api/completions');
export const toggleCompletion=(date,key,by)=>api('POST','/api/completions',{date,key,by});
export const getMilestones=()=>api('GET','/api/milestones');
export const addMilestone=(date,label,status,completion_pct,programme_item_id)=>api('POST','/api/milestones',{date,label,status:status||'planned',completion_pct:completion_pct!=null?completion_pct:0,programme_item_id:programme_item_id!=null&&programme_item_id!==''?programme_item_id:null});
export const patchMilestone=(id,patch)=>api('PATCH',`/api/milestones/${id}`,patch);
export const deleteMilestone=(id)=>api('DELETE',`/api/milestones/${id}`);
export const getUsers=()=>api('GET','/api/users');
export const addUser=(user)=>api('POST','/api/users',user);
export const deleteUser=(id)=>api('DELETE',`/api/users/${id}`);
export const getDrawings=()=>api('GET','/api/drawings');
export const getDrawing=(id)=>api('GET',`/api/drawings/${id}`);
export const uploadDrawing=(name,tab,floor,image_data,width,height,file_url)=>api('POST','/api/drawings',{name,tab,floor,image_data,width,height,file_url:file_url||null});
export const renameDrawing=(id,name)=>api('PATCH',`/api/drawings/${id}`,{name});
export const deleteDrawing=(id)=>api('DELETE',`/api/drawings/${id}`);
export const getZonesForDrawing=(id)=>api('GET',`/api/zones/${id}`);
export const addZone=(drawing_id,name,tower,geometry,activities)=>api('POST','/api/zones',{drawing_id,name,tower,geometry,activities:activities&&activities.length?activities:undefined});
export const updateZone=(id,patch)=>api('PUT',`/api/zones/${id}`,patch);
export const scheduleZoneFromTarget=(zoneId,body)=>api('POST',`/api/zones/${zoneId}/schedule-from-target`,body);
export const previewProgrammeCommand=(command)=>api('POST','/api/admin/programme-command/preview',{command});
export const applyProgrammeCommand=(command,action)=>api('POST','/api/admin/programme-command/apply',{command,action});
export const deleteZone=(id)=>api('DELETE',`/api/zones/${id}`);
export const addZoneActivity=(zoneId,payload)=>api('POST',`/api/zones/${zoneId}/activities`,payload);
export const deleteZoneActivity=(zoneId,activityId)=>api('DELETE',`/api/zones/${zoneId}/activities/${activityId}`);
export const putZoneActivities=(zoneId,activities)=>api('PUT',`/api/zones/${zoneId}/activities`,{activities});
// Module Handover — tab-locked (admin + site set up, board views)
export const createModuleDrawing=(name,floor,image_data,width,height,file_url)=>api('POST','/api/module-handover/drawings',{name,floor:floor||'modules',image_data,width,height,file_url:file_url||null});
export const renameModuleDrawing=(id,name)=>api('PATCH',`/api/module-handover/drawings/${id}`,{name});
export const deleteModuleDrawing=(id)=>api('DELETE',`/api/module-handover/drawings/${id}`);
export const addModuleZone=(drawing_id,name,tower,geometry)=>api('POST','/api/module-handover/zones',{drawing_id,name,tower,geometry});
export const updateModuleZone=(id,patch)=>api('PUT',`/api/module-handover/zones/${id}`,patch);
export const deleteModuleZone=(id)=>api('DELETE',`/api/module-handover/zones/${id}`);
export const setModuleStage=(id,stage)=>api('PATCH',`/api/module-handover/zones/${id}/stage`,{stage});
export const getModuleCompletionProgress=(today)=>api('GET',`/api/module-handover/completion-progress${today?`?today=${encodeURIComponent(today)}`:''}`);
export const getModuleBulkSchedulePreview=(opts={})=>{
  const q=new URLSearchParams();
  if(opts.startDate)q.set('startDate',opts.startDate);
  if(opts.modulesPerDay!=null)q.set('modulesPerDay',String(opts.modulesPerDay));
  const qs=q.toString();
  return api('GET',`/api/admin/modules/bulk-schedule-preview${qs?`?${qs}`:''}`);
};
export const applyModuleBulkSchedule=(body)=>api('POST','/api/admin/modules/bulk-schedule-apply',body||{});
export const previewModuleL1L5Order=(body={})=>api('POST','/api/admin/modules/apply-l1-l5-order',{...body,dryRun:true});
export const applyModuleL1L5Order=(body={})=>api('POST','/api/admin/modules/apply-l1-l5-order',body);
export const previewModuleAirSound=()=>api('GET','/api/admin/modules/air-sound-preview');
export const applyModuleAirSound=(body={})=>api('POST','/api/admin/modules/apply-air-sound',body);
export const scheduleZoneFromTemplateStart=(zoneId,body)=>api('POST',`/api/zones/${zoneId}/schedule-from-template-start`,body);
export const getPlanProgramme=()=>api('GET','/api/plan/programme');
export const getPlanProgrammeFullExport=()=>api('GET','/api/plan/programme?full=1');
export const replacePlanZoneItems=(zoneId,rows)=>api('PUT',`/api/plan/admin/zone/${zoneId}/items`,{rows});
export const deletePlanZone=(zoneId)=>api('DELETE',`/api/plan/admin/zone/${zoneId}`);
export const restorePlanZone=(snapshot)=>api('POST','/api/plan/admin/restore-zone',{snapshot});
export const resetProgrammeData=()=>api('POST','/api/admin/reset-programme-data');
export const clearProgrammeKeepZones=()=>api('POST','/api/admin/clear-programme-keep-zones');
/** Wipes programme_items, zone_activities, completions, schedule; keeps zones, drawings, templates, activities, milestones. Body: `{ confirmation: 'RESET PROGRAMME' }`. */
export const resetProgramme=(body)=>api('POST','/api/admin/reset-programme',body);
export const resequenceAllZones=()=>api('POST','/api/admin/resequence-all-zones');
export const setZoneAnchors=(entries)=>api('POST','/api/admin/set-zone-anchors',{entries});
export const getProgrammeItemsByDrawing=(drawingId)=>api('GET',`/api/programme-items/drawing/${drawingId}`);
export const getProgrammeItemsByZone=(zoneId)=>api('GET',`/api/programme-items/zone/${zoneId}`);
export const createProgrammeItem=(zone_id,activity_id,start_date,end_date,status,notes,shift)=>api('POST','/api/programme-items',{zone_id,activity_id,start_date,end_date,status,notes,shift});
export const updateProgrammeItem=(id,patch)=>api('PUT',`/api/programme-items/${id}`,patch);
export const deleteProgrammeItem=(id)=>api('DELETE',`/api/programme-items/${id}`);
export const getDependencies=(itemType,itemId)=>{
  if(itemType!=null&&itemId!=null){
    const q=new URLSearchParams({item_type:itemType,item_id:String(itemId)});
    return api('GET',`/api/dependencies?${q}`);
  }
  return api('GET','/api/dependencies');
};
export const createDependency=(body)=>api('POST','/api/dependencies',body);
export const deleteDependency=(id)=>api('DELETE',`/api/dependencies/${id}`);
export const getTemplates=()=>api('GET','/api/templates');
export const createTemplate=(name,tab,tower,zone_name,sequence,durations)=>api('POST','/api/templates',{name,tab,tower,zone_name,sequence,durations});
export const deleteTemplate=(id)=>api('DELETE',`/api/templates/${id}`);
export const updateTemplate=(id,body)=>api('PUT',`/api/templates/${id}`,body);
export const applyTemplate=(tab,tower,zone_name,sequence,durations,startDate)=>api('POST','/api/templates/apply',{tab,tower,zone_name,sequence,durations,startDate});

export async function uploadProjectProgrammeXml(file){
  const fd=new FormData();
  fd.append('file',file);
  const url=BASE?`${BASE}/api/project-programme/import-xml`:'/api/project-programme/import-xml';
  const token=getToken();
  const headers={};
  if(token)headers.Authorization='Bearer '+token;
  const res=await fetch(url,{method:'POST',headers,body:fd});
  let data={};
  try{data=await res.json()}catch(_){}
  if(!res.ok){
    if(!data.error)data.error=`HTTP ${res.status}`;
    return data;
  }
  return data;
}

export const confirmProjectProgrammeImport=(items)=>api('POST','/api/project-programme/confirm-import',{items});
export const getProjectProgrammeItems=()=>api('GET','/api/project-programme/items');
