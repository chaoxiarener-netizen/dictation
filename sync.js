/* DictationSync client - pure vanilla JS, zero dependencies, works on file:// and PWA offline. */
(function(root){
'use strict';

const ENDPOINT = 'https://dictation-sync.chaoxiarener.workers.dev';
const STORAGE_KEY = 'sync_token';

let currentStatus = 'local'; // 'local' | 'pending' | 'synced' | 'syncing' | 'error'
let lastSyncedAt = null;
let lastError = null;

function getToken(){
 try{
  return (localStorage.getItem(STORAGE_KEY)||'').trim();
 }catch{
  return '';
 }
}

function setToken(token){
 try{
  const t=(token||'').trim();
  if(t)localStorage.setItem(STORAGE_KEY, t);
  else localStorage.removeItem(STORAGE_KEY);
  currentStatus = t ? 'pending' : 'local';
  lastError = null;
 }catch(e){
  console.warn('LocalStorage error:', e);
 }
}

function clearToken(){
 setToken('');
}

async function fetchWithTimeout(url, options={}, timeoutMs=15000){
 const controller = new AbortController();
 const timer = setTimeout(()=>controller.abort(), timeoutMs);
 try{
  const res = await fetch(url, {...options, credentials:'omit', signal:controller.signal});
  clearTimeout(timer);
  return res;
 }catch(err){
  clearTimeout(timer);
  throw err;
 }
}

/**
 * 带一次重试的请求。国内到 workers.dev 偶发超时，重试一次能救回大部分情况。401 不重试。
 */
async function requestWithRetry(url, options={}, {timeoutMs=15000, retries=1}={}){
 let lastErr;
 for(let attempt=0; attempt<=retries; attempt++){
  try{
   const res = await fetchWithTimeout(url, options, timeoutMs);
   if(res.status === 401) return res; // 401 立即返回，不浪费重试
   if(!res.ok && attempt < retries){
    await new Promise(r=>setTimeout(r, 800));
    continue;
   }
   return res;
  }catch(err){
   lastErr = err;
   if(attempt < retries) await new Promise(r=>setTimeout(r, 800));
  }
 }
 throw lastErr;
}

async function signup(label=''){
 const res = await requestWithRetry(`${ENDPOINT}/api/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ label: label || 'Web Client' })
 });
 if(!res.ok){
  const txt = await res.text();
  throw new Error(`注册失败: ${res.status} ${txt}`);
 }
 const data = await res.json();
 if(!data || !data.token) throw new Error('服务端未返回同步码');
 setToken(data.token);
 return data;
}

async function pull(){
 const token = getToken();
 if(!token){
  currentStatus = 'local';
  return null;
 }
 currentStatus = 'syncing';
 try{
  const res = await requestWithRetry(`${ENDPOINT}/api/sync`, {
   method: 'GET',
   headers: {
    'Authorization': `Bearer ${token}`
   }
  });
  if(res.status === 401){
   currentStatus = 'error';
   lastError = '同步码无效或已被清除 (401)';
   const err = new Error(lastError);
   err.status = 401;
   throw err;
  }
  if(!res.ok){
   const txt = await res.text();
   currentStatus = 'error';
   lastError = `拉取失败 (${res.status})`;
   throw new Error(lastError);
  }
  const body = await res.json();
  currentStatus = 'synced';
  lastSyncedAt = body.updatedAt ? new Date(body.updatedAt) : new Date();
  lastError = null;
  return body.payload || { records: {}, srs: {} };
 }catch(err){
  currentStatus = 'error';
  lastError = err.name === 'AbortError' ? '网络连接超时 (15s)' : (err.message || '网络连接失败');
  throw err;
 }
}

async function push(payload){
 const token = getToken();
 if(!token){
  currentStatus = 'local';
  return null;
 }
 currentStatus = 'syncing';
 try{
  const res = await requestWithRetry(`${ENDPOINT}/api/sync`, {
   method: 'POST',
   headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
   },
   body: JSON.stringify({ payload: { records: payload.records || {}, srs: payload.srs || {} } })
  });
  if(res.status === 401){
   currentStatus = 'error';
   lastError = '同步码无效 (401)';
   const err = new Error(lastError);
   err.status = 401;
   throw err;
  }
  if(!res.ok){
   const txt = await res.text();
   currentStatus = 'error';
   lastError = `推送失败 (${res.status})`;
   throw new Error(lastError);
  }
  const body = await res.json();
  currentStatus = 'synced';
  lastSyncedAt = body.updatedAt ? new Date(body.updatedAt) : new Date();
  lastError = null;
  return body.payload || { records: {}, srs: {} };
 }catch(err){
  currentStatus = 'error';
  lastError = err.name === 'AbortError' ? '网络连接超时 (15s)' : (err.message || '网络连接失败');
  throw err;
 }
}

function pickLaterDate(d1, d2){
 if(!d1 && !d2) return null;
 if(!d1) return d2;
 if(!d2) return d1;
 return Math.max(new Date(d1).getTime() || 0, new Date(d2).getTime() || 0);
}

function pickLaterDateStr(s1, s2){
 if(!s1 && !s2) return '';
 if(!s1) return s2;
 if(!s2) return s1;
 return s1 > s2 ? s1 : s2;
}

function mergeIntoLocal(localData, remotePayload){
 if(!localData || !remotePayload) return false;
 let changed = false;

 // 1. 合并 records (attempts=max, correct=max, lastWrongAt=较晚, streak=max)
 localData.records = localData.records || {};
 const remRecords = remotePayload.records || {};
 for(const [k, r] of Object.entries(remRecords)){
  const loc = localData.records[k];
  if(!loc){
   localData.records[k] = { ...r };
   changed = true;
   continue;
  }
  const newAttempts = Math.max(loc.attempts || 0, r.attempts || 0);
  const newCorrect = Math.max(loc.correct || 0, r.correct || 0);
  const newLastWrong = pickLaterDate(loc.lastWrongAt, r.lastWrongAt);
  const newStreak = Math.max(loc.streak || 0, r.streak || 0);
  if(newAttempts !== loc.attempts || newCorrect !== loc.correct || newLastWrong !== loc.lastWrongAt || newStreak !== loc.streak){
   localData.records[k] = {
    attempts: newAttempts,
    correct: newCorrect,
    lastWrongAt: newLastWrong,
    streak: newStreak
   };
   changed = true;
  }
 }

 // 2. 合并 srs (step=max, right=max, wrong=max, due=较晚, lastDay=较晚)
 localData.srs = localData.srs || {};
 const remSRS = remotePayload.srs || {};
 for(const [k, r] of Object.entries(remSRS)){
  const loc = localData.srs[k];
  if(!loc){
   localData.srs[k] = { ...r };
   changed = true;
   continue;
  }
  const newStep = Math.max(loc.step || 0, r.step || 0);
  const newRight = Math.max(loc.right || 0, r.right || 0);
  const newWrong = Math.max(loc.wrong || 0, r.wrong || 0);
  const newDue = pickLaterDateStr(loc.due, r.due);
  const newLastDay = pickLaterDateStr(loc.lastDay, r.lastDay);
  if(newStep !== loc.step || newRight !== loc.right || newWrong !== loc.wrong || newDue !== loc.due || newLastDay !== loc.lastDay){
   localData.srs[k] = {
    step: newStep,
    right: newRight,
    wrong: newWrong,
    due: newDue,
    lastDay: newLastDay
   };
   changed = true;
  }
 }

 return changed;
}

function status(){
 if(!getToken()) return 'local';
 return currentStatus;
}

function getLastSyncedAt(){
 return lastSyncedAt;
}

function getLastError(){
 return lastError;
}

const api = {
 ENDPOINT,
 getToken,
 setToken,
 clearToken,
 signup,
 pull,
 push,
 mergeIntoLocal,
 status,
 getLastSyncedAt,
 getLastError,
 pickLaterDate,
 pickLaterDateStr
};

if(typeof module !== 'undefined') module.exports = api;
else root.DictationSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
