/* No network dependencies; classic scripts also work over file://. */
'use strict';
const $=id=>document.getElementById(id), C=DictationCore, Sync=window.DictationSync;
const defaults={showGloss:false,strict:false,rate:1,autoplay:true,autoNext:false,spaceReplay:false,retryUntilCorrect:true};
let db, data, words=[],byWord=new Map(), mode='main',active=false,graded=false,saving=false,timer,audio,audioEl=null,utterance,playToken=0;
let awaitingRetry=false, retryAttempt=false;
let composing=false,blockCompositionEnter=false,lastCompositionEnd=-Infinity,feedbackWord=null,settingsFocus=null,settingsSelection=null;
const day=()=>new Date().toLocaleDateString('sv-SE');
// 每台设备一个稳定 id：今天的练习量按设备分开记，合并时相加，正确率才准
const deviceId=(()=>{try{let d=localStorage.getItem('dictation_device');if(!d){d=Math.random().toString(36).slice(2,10);localStorage.setItem('dictation_device',d);}return d;}catch(e){return 'dev';}})();
function normDay(entry){
 if(!entry||typeof entry!=='object')return {devices:{}};
 if(entry.devices&&typeof entry.devices==='object')return entry;
 const legacy={words:Array.isArray(entry.words)?entry.words.slice():[],attempts:+entry.attempts||0,correct:+entry.correct||0,wrong:Array.isArray(entry.wrong)?entry.wrong.slice():[]};
 return {devices:{legacy}};
}
function dayTotals(date){
 const e=normDay((data.daily||{})[date]);
 let attempts=0,correct=0;const words=new Set(),wrong=new Set();
 for(const b of Object.values(e.devices||{})){
  attempts+=+b.attempts||0;correct+=+b.correct||0;
  for(const x of (b.words||[]))words.add(x);
  for(const x of (b.wrong||[]))wrong.add(x);
 }
 return {attempts,correct,words:[...words],wrong:[...wrong]};
}
const blank=()=>({settings:{...defaults},records:{},srs:{},sessions:{},daily:{}});
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('ielts-dictation',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
function load(){return new Promise((resolve,reject)=>{const r=db.transaction('state').objectStore('state').get('app');r.onsuccess=()=>resolve(r.result||blank());r.onerror=()=>reject(r.error);});}
function persist(){return new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(data,'app');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
function session(){return data.sessions[mode];}
function buildSession(){
 let list=words.map(w=>w.key);
 if(mode==='review'){
  list=C.buildReviewList(words,data.srs,day());
 }else if(mode==='wrong'){
  list=C.buildWrongList(words,data.records,data.srs,day());
 }else if(mode==='random'){
  for(let i=list.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[list[i],list[j]]=[list[j],list[i]];}
 }
 data.sessions[mode]={list,index:0,drafts:{}};
}
function current(){return graded&&feedbackWord?feedbackWord:byWord.get(session()?.list[session().index]);}
function getAudio(){
 if(!audioEl){audioEl=new Audio();audioEl.preload='auto';}
 return audioEl;
}
function stopAudio(){
 playToken++;
 if(audioEl){
  try{audioEl.pause();}catch(e){}
  try{audioEl.currentTime=0;}catch(e){}
 }
 if(window.speechSynthesis)speechSynthesis.cancel();
}
function speakFallback(word,token){
 if(token!==playToken)return;
 $('audioStatus').textContent='音频缺失或不可播放 · 使用浏览器语音';
 if(!window.speechSynthesis){$('audioStatus').textContent='此浏览器无语音支持；可看中文提示或跳过。';return;}
 utterance=new SpeechSynthesisUtterance(word);utterance.lang='en-GB';utterance.rate=data.settings.rate;
 utterance.onerror=()=>{if(token===playToken)$('audioStatus').textContent='浏览器语音不可用（离线需已安装英语语音）；可提示或跳过。';};
 speechSynthesis.speak(utterance);
}
async function play(){
 const w=current();if(!active||!w||$('settings').open)return;
 stopAudio();const token=playToken; $('audioStatus').textContent=`语速 ${data.settings.rate} ×`;
 if(!w.audio){speakFallback(w.word,token);return;}
 // 全局只用一个播放器：重听时倒回去重播，避免连续按键叠出多个音轨
 const a=getAudio();audio=a;
 const src='audio/'+encodeURIComponent(w.audio);
 if(a.getAttribute('src')!==src)a.setAttribute('src',src);
 try{a.currentTime=0;}catch(e){}
 a.playbackRate=data.settings.rate;
 let timeout=setTimeout(fallback,5000),fell=false;
 function fallback(){if(fell||token!==playToken)return;fell=true;clearTimeout(timeout);try{a.pause();}catch(e){}speakFallback(w.word,token);}
 a.onerror=fallback;a.onplaying=()=>clearTimeout(timeout);
 try{await a.play();if(token!==playToken){try{a.pause();}catch(e){}}}catch(e){clearTimeout(timeout);if(token!==playToken)return;if(e.name==='NotAllowedError')$('audioStatus').textContent='浏览器阻止自动播放，请点重听。';else fallback();}
}
function stats(){
 const entries=Object.values(data.records||{});
 const t=(typeof dayTotals==='function')?dayTotals(day()):{words:[],attempts:0,correct:0,wrong:[]};
 const dueCount=C.countDue(words,data.srs,day());
 $('stats').textContent=`已练 ${entries.filter(r=>r.attempts).length} / ${words.length}　·　待复习 ${dueCount} 个　·　今天练了 ${t.words.length} 个　·　正确率 ${t.attempts?Math.round(t.correct/t.attempts*100):0}%　·　错词 ${entries.filter(r=>r.lastWrongAt).length} 个`;
 $('coverage').max=words.length;$('coverage').value=entries.filter(r=>r.attempts).length;
 $('wrongList').textContent=t.wrong.join(' · ')||'暂无';
}
function focusAnswer(){if(active&&current()&&!$('settings').open&&document.hasFocus()&&!document.hidden)$('answer').focus();}
function showHint(){const w=current();$('hint').textContent=w?.gloss||'此词暂无中文释义';$('hint').hidden=false;focusAnswer();}
function renderFeedback(ok,skip,answer,w){
 const feedback=$('feedback');feedback.replaceChildren();
 feedback.className=ok?'feedback-card is-correct':skip?'feedback-card is-skipped':'feedback-card is-wrong';
 const header=document.createElement('div');header.className='fb-header';
 if(ok){
  const badge=document.createElement('span');badge.className='fb-badge badge-correct';badge.textContent='正确 ✓';
  const wordEl=document.createElement('strong');wordEl.className='fb-word';wordEl.textContent=w.word;
  header.append(badge,wordEl);feedback.append(header);
 }else if(skip){
  const badge=document.createElement('span');badge.className='fb-badge badge-skipped';badge.textContent='已跳过 · 计入错词';
  const right=document.createElement('div');right.className='fb-spelling-row';
  const label=document.createElement('span');label.className='fb-label';label.textContent='正确拼写：';
  const wordEl=document.createElement('strong');wordEl.className='fb-correct-word';wordEl.textContent=w.word;
  right.append(label,wordEl);header.append(badge);feedback.append(header,right);
 }else{
  const badge=document.createElement('span');badge.className='fb-badge badge-wrong';badge.textContent='再记一遍 ✕';header.append(badge);
  const compRow=document.createElement('div');compRow.className='fb-comp-row';
  const diffWrap=document.createElement('div');diffWrap.className='fb-diff-wrap';
  const diffLabel=document.createElement('span');diffLabel.className='fb-label';diffLabel.textContent='你的输入：';
  const diff=document.createElement('div');diff.className='spelling';
  for(const part of C.diff(answer,w.word,data.settings.strict)){
   const span=document.createElement('span');span.className=part.wrong?'wrong':'';span.textContent=part.text===' '?'␣':part.text;diff.append(span);
  }
  diffWrap.append(diffLabel,diff);
  const rightWrap=document.createElement('div');rightWrap.className='fb-right-wrap';
  const rightLabel=document.createElement('span');rightLabel.className='fb-label';rightLabel.textContent='正确拼写：';
  const targetWord=document.createElement('strong');targetWord.className='fb-correct-word';targetWord.textContent=w.word;
  rightWrap.append(rightLabel,targetWord);
  compRow.append(diffWrap,rightWrap);feedback.append(header,compRow);
 }
 const gloss=(w.gloss||'').trim();
 if(gloss){
  const glossEl=document.createElement('div');glossEl.className='fb-gloss';glossEl.textContent=gloss;feedback.append(glossEl);
 }else{
  const glossEl=document.createElement('div');glossEl.className='fb-gloss fb-gloss-empty';glossEl.textContent='释义待补';feedback.append(glossEl);
 }
}
function render(autoplay=true){
 clearTimeout(timer);stopAudio();$('audioStatus').textContent='';graded=false;feedbackWord=null;awaitingRetry=false;retryAttempt=false;const s=session(),w=current();stats();
 document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
 const modeLabels={main:'主线',review:'复习',wrong:'错词',random:'随机'};
 $('progress').textContent=w?`${modeLabels[mode]||'练习'} · 第 ${s.index+1} / ${s.list.length} 个`:'本轮已结束';
 $('start').hidden=active||!w;$('exercise').hidden=!active||!w;$('title').hidden=active&&!!w;$('subtitle').hidden=active&&!!w;
 if(mode==='review'&&!w){
  $('title').textContent='今天没有到期的词';
  $('subtitle').textContent='所有艾宾浩斯复习任务都已完成，随时去主线继续练习。';
  $('message').textContent='';
  $('toMain').hidden=false;
 }else if(mode==='wrong'&&!w){
  $('title').textContent='暂无错词';
  $('subtitle').textContent='太棒了，目前没有错词记录。';
  $('message').textContent='';
  $('toMain').hidden=false;
 }else{
  $('title').textContent=active?'本轮已练完。随时回来。':'听清楚，打出来。';
  $('message').textContent=active&&!w?'当前序列已练完，切换模式可继续。':'';
  $('toMain').hidden=true;
 }
 if(!w){stopAudio();return;}
 $('answer').value=s.drafts?.[s.index]||'';$('answer').readOnly=false;$('submit').disabled=false;$('submit').textContent='提交 · Enter';
 $('feedback').replaceChildren();$('feedback').className='feedback-empty';
 $('hint').textContent=w.gloss||'此词暂无中文释义';$('hint').hidden=!data.settings.showGloss;
 focusAnswer();if(active&&autoplay&&data.settings.autoplay)play();
}
async function start(){if(!data)return;active=true;render();await persist();}
async function submit(skip=false){
 if(saving)return;
 if(graded){
  // 跳过硬优先：Alt+→ 任何时候都能过，不会被"必须拼对"卡死
  if(skip){
   if(awaitingRetry){const s=session();s.drafts[s.index]='';s.index++;awaitingRetry=false;retryAttempt=false;await persist();}
   await advance();return;
  }
  if(!awaitingRetry){await advance();return;}
  startRetry();return;
 }
 const w=current();if(!w)return;
 saving=true;clearTimeout(timer);stopAudio();$('submit').disabled=true;
 const answer=$('answer').value;
 if(!skip&&!answer.trim()){saving=false;$('submit').disabled=false;$('message').textContent='先输入答案；要跳过请按 Alt+→。';return;}
 $('message').textContent='';const ok=!skip&&C.grade(answer,w.word,data.settings.strict),s=session();
 const old=structuredClone(data);
 // 重试轮的作答不再计入统计与艾宾浩斯，首次对错已经记过账
 if(!retryAttempt){
  data.records[w.key]=C.account(data.records[w.key],ok);
  data.srs[w.key]=C.updateSRS(data.srs[w.key],ok,day());
  const dateKey=day();
  const entry=data.daily[dateKey]=normDay(data.daily[dateKey]);
  const bucket=entry.devices[deviceId]||=( {words:[],attempts:0,correct:0,wrong:[]} );
  if(!bucket.words.includes(w.key))bucket.words.push(w.key);
  bucket.attempts++;if(ok)bucket.correct++;else if(!bucket.wrong.includes(w.word))bucket.wrong.push(w.word);
 }
 // 答错且开着「拼对才进下一个」：停在原词，不进下一题
 const mustRetry=!ok&&!skip&&!!data.settings.retryUntilCorrect;
 if(mustRetry){
  s.drafts[s.index]='';
 }else{
  s.drafts[s.index]=answer;s.index++;
  data.resume={key:w.key,at:Date.now()}; // 记住练到哪个词，换设备时接着来
 }
 try{await persist();}catch(e){data=old;$('message').textContent='保存失败，本题未计入。请检查浏览器存储后重试。';saving=false;$('submit').disabled=false;return;}
 saving=false;feedbackWord=w;graded=true;$('answer').readOnly=true;$('submit').disabled=false;
 if(mustRetry){
  awaitingRetry=true;
  $('submit').textContent='重来 · Enter';
  renderFeedback(false,false,answer,w);
  $('message').textContent='拼对才能进入下一个词';
 }else{
  awaitingRetry=false;retryAttempt=false;
  $('submit').textContent='下一题 · Enter';
  renderFeedback(ok,skip,answer,w);
 }
 stats();
 if(!retryAttempt&&Sync&&Sync.getToken()){
  syncWordCount++;
  clearTimeout(syncDebounceTimer);
  if(syncWordCount>=10){syncWordCount=0;triggerPush();}
  else{syncDebounceTimer=setTimeout(()=>{syncWordCount=0;triggerPush();},8000);}
 }
 if(data.settings.autoNext)timer=setTimeout(()=>render(),600);
}
function startRetry(){
 awaitingRetry=false;retryAttempt=true;graded=false;
 $('answer').value='';$('answer').readOnly=false;
 $('submit').textContent='提交 · Enter';
 $('message').textContent='拼对才能进入下一个词';
 // 开始重打时把正确答案藏起来，只留中文释义，避免照着抄
 const fb=$('feedback');if(fb){fb.classList.add('is-retrying');}
 const badge=fb&&fb.querySelector('.fb-badge');if(badge)badge.textContent='再拼一次';
 $('answer').focus();
 play();
}
async function advance(){clearTimeout(timer);render();}
async function previous(){if(saving)return;clearTimeout(timer);stopAudio();const s=session();s.index=Math.max(0,s.index-1);render();await persist();}
async function switchMode(next){if(saving)return;stopAudio();clearTimeout(timer);mode=next;if(!data.sessions[mode]||mode==='wrong'||mode==='review')buildSession();data.mode=mode;render();await persist();}
let syncWordCount=0, syncDebounceTimer=null;
function updateSyncUI(){
 if(!Sync)return;
 const st=Sync.status();
 const ind=$('syncIndicator'), label=$('syncIndicatorLabel');
 if(ind&&label){
  ind.className='sync-indicator';
  const dot=ind.querySelector('.sync-dot');
  if(dot)dot.className='sync-dot dot-'+st;
  if(st==='local'){label.textContent='本地';ind.title='未绑定同步码（纯本地）';}
  else if(st==='synced'){
   const t=Sync.getLastSyncedAt()?Sync.getLastSyncedAt().toLocaleTimeString('zh-CN',{hour12:false}):'';
   label.textContent='已同步';ind.title='已与云端同步'+(t?' · '+t:'');
  }
  else if(st==='syncing'){label.textContent='同步中…';ind.title='正在与云端同步…';}
  else if(st==='pending'){label.textContent='待同步';ind.title='已配置同步码，尚未完成首次同步';}
  else if(st==='error'){label.textContent='同步遇到问题';ind.title=Sync.getLastError()||'同步遇到问题，点击查看';}
 }
 const token=Sync.getToken();
 if($('syncUnboundArea')&&$('syncBoundArea')){
  $('syncUnboundArea').hidden=!!token;
  $('syncBoundArea').hidden=!token;
  if(token){
   if($('displaySyncToken'))$('displaySyncToken').textContent=token;
   if($('syncStatusDesc')){
    const timeStr=Sync.getLastSyncedAt()?Sync.getLastSyncedAt().toLocaleTimeString('zh-CN',{hour12:false}):'';
    $('syncStatusDesc').textContent='状态：'+(st==='synced'?'已同步 · '+timeStr:st==='syncing'?'正在同步…':st==='pending'?'待同步':'遇到问题 ('+(Sync.getLastError()||'')+')');
   }
  }
 }
}
async function triggerPush(immediate=false){
 if(!Sync||!Sync.getToken())return;
 updateSyncUI();
 try{
  const merged=await Sync.push(data);
  if(merged&&Sync.mergeIntoLocal(data,merged)){
   await persist();stats();if(inWordList)renderWordList();
  }
 }catch(e){
  console.warn('Sync push skipped:',e.message);
 }finally{
  updateSyncUI();
 }
}
function settings(){if(saving)return;settingsFocus=document.activeElement;settingsSelection=settingsFocus===$('answer')?[$('answer').selectionStart,$('answer').selectionEnd]:null;clearTimeout(timer);stopAudio();for(const key of Object.keys(defaults)){const el=$(key);if(el.type==='checkbox')el.checked=data.settings[key];else el.value=data.settings[key];}$('modeSelect').value=mode;updateSyncUI();if($('syncMsg')){$('syncMsg').className='sync-msg';$('syncMsg').textContent='';}$('settings').showModal();}
$('settings').addEventListener('close',async()=>{for(const key of Object.keys(defaults)){const el=$(key);data.settings[key]=el.type==='checkbox'?el.checked:key==='rate'?Number(el.value):el.value;}if($('modeSelect').value!==mode){await switchMode($('modeSelect').value);}else{await persist();$('hint').hidden=!data.settings.showGloss;if(settingsFocus?.isConnected&&document.hasFocus()){settingsFocus.focus();if(settingsSelection)$('answer').setSelectionRange(...settingsSelection);}}});
let inWordList=false, wlFilter='all', wlQuery='', wlSortBy='freq', wlExpandedWord=null;
function playWordPreview(item){
 if(!item)return;
 if(window.previewAudio){window.previewAudio.pause();window.previewAudio=null;}
 if(item.audio){
  const a=window.previewAudio=new Audio('audio/'+encodeURIComponent(item.audio));
  a.playbackRate=data.settings.rate||1;
  a.onerror=()=>{if(window.speechSynthesis)speechSynthesis.speak(new SpeechSynthesisUtterance(item.word));};
  a.play().catch(()=>{if(window.speechSynthesis)speechSynthesis.speak(new SpeechSynthesisUtterance(item.word));});
 }else if(window.speechSynthesis){
  speechSynthesis.speak(new SpeechSynthesisUtterance(item.word));
 }
}
function exportWordListCSV(){
 const items=C.filterAndSortWordList(words,data.records,data.srs,wlFilter,wlQuery,wlSortBy,day());
 const header=['单词','释义','状态','对','错','下次复习'];
 const escape=s=>'"'+String(s||'').replace(/"/g,'""')+'"';
 const rows=items.map(it=>[
  escape(it.word),
  escape(it.gloss),
  escape(it.status),
  it.right,
  it.wrong,
  escape(it.due)
 ].join(','));
 const csv='\uFEFF'+[header.join(','),...rows].join('\r\n');
 const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
 const url=URL.createObjectURL(blob);
 const a=document.createElement('a');
 a.href=url;a.download=`words-${day()}.csv`;
 document.body.appendChild(a);a.click();document.body.removeChild(a);
 URL.revokeObjectURL(url);
}
function renderWordList(){
 const summary=C.calculateSummary(words,data.records,data.srs,day());
 $('wlSummary').textContent=`已学 ${summary.learned} · 未学 ${summary.unlearned} · 错词 ${summary.wrong} · 待复习 ${summary.due}`;
 const items=C.filterAndSortWordList(words,data.records,data.srs,wlFilter,wlQuery,wlSortBy,day());
 const tbody=$('wlBody');
 tbody.replaceChildren();
 if(!items.length){
  $('wlTable').hidden=true;
  $('wlEmpty').hidden=false;
  return;
 }
 $('wlTable').hidden=false;
 $('wlEmpty').hidden=true;
 const frag=document.createDocumentFragment();
 for(const it of items){
  const tr=document.createElement('tr');
  tr.className='wl-row'+(wlExpandedWord===it.key?' is-expanded':'');
  tr.dataset.key=it.key;
  tr.onclick=()=>{
   wlExpandedWord=wlExpandedWord===it.key?null:it.key;
   renderWordList();
  };
  const tdWord=document.createElement('td');tdWord.className='wl-word-cell';
  tdWord.textContent=it.word;
  const tdGloss=document.createElement('td');tdGloss.className='wl-gloss-cell';
  tdGloss.textContent=it.gloss||'—';tdGloss.title=it.gloss||'';
  const tdStatus=document.createElement('td');tdStatus.className='wl-status-cell';
  const badge=document.createElement('span');
  badge.className='wl-badge badge-'+it.statusCode;
  badge.textContent=it.status;
  tdStatus.append(badge);
  const tdRight=document.createElement('td');tdRight.className='wl-num-cell';tdRight.textContent=it.right;tdRight.dataset.label='对';
  const tdWrong=document.createElement('td');tdWrong.className='wl-num-cell'+(it.wrong>0?' has-wrong':'');tdWrong.textContent=it.wrong;tdWrong.dataset.label='错';
  const tdDue=document.createElement('td');tdDue.className='wl-due-cell';tdDue.textContent=it.due;
  tr.append(tdWord,tdGloss,tdStatus,tdRight,tdWrong,tdDue);
  frag.append(tr);
  if(wlExpandedWord===it.key){
   const detailTr=document.createElement('tr');detailTr.className='wl-detail-row';
   const detailTd=document.createElement('td');detailTd.colSpan=6;
   const content=document.createElement('div');content.className='wl-expanded-content';
   const text=document.createElement('div');text.className='wl-expanded-text';
   text.textContent=it.gloss?`${it.word}：${it.gloss}`:`${it.word}（暂无释义）`;
   const listenBtn=document.createElement('button');listenBtn.className='wl-listen-btn';
   listenBtn.textContent='▷ 听一次';
   listenBtn.onclick=e=>{e.stopPropagation();playWordPreview(it);};
   content.append(text,listenBtn);detailTd.append(content);detailTr.append(detailTd);
   frag.append(detailTr);
  }
 }
 tbody.append(frag);
}
function openWordList(){
 if(saving)return;
 inWordList=true;clearTimeout(timer);stopAudio();
 $('practiceView').hidden=true;$('wordListView').hidden=false;
 renderWordList();
 $('closeWordListBtn').focus();
}
function closeWordList(){
 inWordList=false;
 $('wordListView').hidden=true;$('practiceView').hidden=false;
 focusAnswer();
}
$('settingsBtn').onclick=settings;$('start').onclick=start;$('replay').onclick=play;$('hintBtn').onclick=showHint;$('skip').onclick=()=>submit(true);$('previous').onclick=previous;$('toMain').onclick=()=>switchMode('main');
$('wordListBtn').onclick=openWordList;$('closeWordListBtn').onclick=closeWordList;$('exportCsvBtn').onclick=exportWordListCSV;
$('wlSearch').oninput=e=>{wlQuery=e.target.value;renderWordList();};
$('wlSort').onchange=e=>{wlSortBy=e.target.value;renderWordList();};
for(const chip of document.querySelectorAll('#wlChips .chip')){
 chip.onclick=()=>{
  for(const c of document.querySelectorAll('#wlChips .chip'))c.classList.toggle('active',c===chip);
  wlFilter=chip.dataset.filter;
  renderWordList();
 };
}
if($('bindSyncBtn'))$('bindSyncBtn').onclick=async()=>{
 const token=($('syncTokenInput').value||'').trim();
 if(!token){$('syncMsg').className='sync-msg is-error';$('syncMsg').textContent='请输入同步码';return;}
 $('syncMsg').className='sync-msg';$('syncMsg').textContent='正在验证同步码…';
 Sync.setToken(token);updateSyncUI();
 try{
  const remote=await Sync.pull();
  if(remote){Sync.mergeIntoLocal(data,remote);await persist();stats();if(inWordList)renderWordList();}
  const pushed=await Sync.push(data);
  if(pushed){Sync.mergeIntoLocal(data,pushed);await persist();stats();if(inWordList)renderWordList();}
  await alignAfterMerge();
  const timeStr=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  $('syncMsg').className='sync-msg is-success';$('syncMsg').textContent='同步完成 · '+timeStr;
  updateSyncUI();
 }catch(err){
  const detail=(err&&err.message)||Sync.getLastError()||'';
  const is401=/401/.test(detail)||(err&&err.status===401);
  if(is401){
   Sync.clearToken();
   $('syncMsg').className='sync-msg is-error';
   $('syncMsg').textContent='同步码无效 (401)，请检查后重新粘贴';
  }else{
   $('syncMsg').className='sync-msg is-error';
   $('syncMsg').textContent='网络问题，同步码已保留，稍后重试';
  }
  updateSyncUI();
 }
};
if($('createSyncBtn'))$('createSyncBtn').onclick=async()=>{
 $('syncMsg').className='sync-msg';$('syncMsg').textContent='正在创建新同步码…';
 try{
  const res=await Sync.signup('IELTS Dictation Web');
  updateSyncUI(); // 刚建完是 pending
  $('syncMsg').className='sync-msg is-success';$('syncMsg').textContent='正在推送初始进度…';
  await Sync.push(data);
  const timeStr=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  $('syncMsg').className='sync-msg is-success';$('syncMsg').textContent='同步完成 · '+timeStr;
  updateSyncUI();
 }catch(err){
  $('syncMsg').className='sync-msg is-error';$('syncMsg').textContent='创建或同步失败: '+(err.message||'网络错误');
  updateSyncUI();
 }
};
if($('copySyncBtn'))$('copySyncBtn').onclick=async()=>{
 const token=Sync.getToken();if(!token)return;
 try{
  await navigator.clipboard.writeText(token);
  $('syncMsg').className='sync-msg is-success';$('syncMsg').textContent='同步码已复制到剪贴板！发给另一台设备粘贴即可。';
 }catch{
  $('syncMsg').className='sync-msg';$('syncMsg').textContent='请长按或双击上方同步码手动复制。';
 }
};
if($('manualSyncBtn'))$('manualSyncBtn').onclick=async()=>{
 $('syncMsg').className='sync-msg';$('syncMsg').textContent='正在同步…';
 updateSyncUI();
 try{
  const remote=await Sync.pull();
  if(remote){Sync.mergeIntoLocal(data,remote);}
  const pushed=await Sync.push(data);
  if(pushed){Sync.mergeIntoLocal(data,pushed);}
  await persist();stats();if(inWordList)renderWordList();
  await alignAfterMerge();
  const timeStr=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  $('syncMsg').className='sync-msg is-success';$('syncMsg').textContent='同步完成 · '+timeStr;
 }catch(err){
  $('syncMsg').className='sync-msg is-error';$('syncMsg').textContent='同步失败: '+(err.message||'网络连接失败，请稍后重试');
 }finally{
  updateSyncUI();
 }
};
if($('unbindSyncBtn'))$('unbindSyncBtn').onclick=()=>{
 Sync.clearToken();
 $('syncTokenInput').value='';
 $('syncMsg').className='sync-msg';$('syncMsg').textContent='已解绑此设备，云端数据依然保留';
 updateSyncUI();
};
if($('syncIndicator'))$('syncIndicator').onclick=()=>settings();
// 进度导出 / 导入：换域名、换设备、同步不通时都能把进度搬过去
function exportProgress(){
 const payload={version:1,exportedAt:new Date().toISOString(),records:data.records||{},srs:data.srs||{},daily:data.daily||{}};
 const blob=new Blob([JSON.stringify(payload)],{type:'application/json'});
 const a=document.createElement('a');
 a.href=URL.createObjectURL(blob);
 a.download='听写进度-'+(new Date().toISOString().slice(0,10))+'.json';
 document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(a.href),4000);
 if($('syncMsg')){$('syncMsg').className='sync-msg is-success';$('syncMsg').textContent='已导出进度文件（含 '+Object.keys(payload.records).length+' 个词的记录）';}
}
async function importProgress(file){
 try{
  const text=await file.text();
  const payload=JSON.parse(text);
  if(!payload||typeof payload!=='object'||(!payload.records&&!payload.srs))throw new Error('文件格式不对');
  const before=Object.keys(data.records||{}).length;
  if(Sync&&Sync.mergeIntoLocal){Sync.mergeIntoLocal(data,{records:payload.records||{},srs:payload.srs||{}});}
  else{
   data.records=Object.assign({},payload.records||{},data.records||{});
   data.srs=Object.assign({},payload.srs||{},data.srs||{});
  }
  if(payload.daily){for(const [k,v] of Object.entries(payload.daily)){const cur=data.daily[k];if(!cur||((v.attempts||0)>(cur.attempts||0)))data.daily[k]=v;}}
  await persist();stats();if(inWordList)renderWordList();
  await alignAfterMerge();
  const after=Object.keys(data.records||{}).length;
  $('syncMsg').className='sync-msg is-success';
  $('syncMsg').textContent='导入完成：词条 '+before+' → '+after+' 个，已合并（不会覆盖已有的更优记录）';
 }catch(e){
  $('syncMsg').className='sync-msg is-error';
  $('syncMsg').textContent='导入失败：'+(e.message||'文件无法读取');
 }
}
if($('exportProgressBtn'))$('exportProgressBtn').onclick=exportProgress;
if($('jumpUnlearnedBtn'))$('jumpUnlearnedBtn').onclick=async()=>{
 const al=alignToFirstUnlearned(true);
 await persist();
 if($('settings').open)$('settings').close();
 render(false);
 $('message').textContent=al.allLearned?'主线里的词都练过了，建议切到「复习」或「错词」模式':(al.moved>0?`已跳到第 ${session().index+1} 个词（前面这些都练过）`:'已经在第一个还没练的词上了');
};if($('importProgressBtn')&&$('importProgressFile')){
 $('importProgressBtn').onclick=()=>$('importProgressFile').click();
 $('importProgressFile').onchange=e=>{const f=e.target.files&&e.target.files[0];if(f)importProgress(f);e.target.value='';};
}
let lastAutoPull=0;
document.addEventListener('visibilitychange',async()=>{
 if(document.visibilityState==='hidden'){triggerPush(true);return;}
 // 切回标签页时顺手拉一次，避免"另一台设备练了，这边开着不动"的错觉
 if(!Sync||!Sync.getToken())return;
 if(Date.now()-lastAutoPull<30000)return;
 lastAutoPull=Date.now();
 try{
  const remote=await Sync.pull();
  if(remote&&Sync.mergeIntoLocal(data,remote)){
   await persist();stats();if(inWordList)renderWordList();
  }
  updateSyncUI();
 }catch(e){/* 网络问题不打扰 */}
});
$('answerForm').onsubmit=e=>{e.preventDefault();if(!composing&&!blockCompositionEnter&&performance.now()-lastCompositionEnd>30)submit();};
$('answer').oninput=()=>{if(!graded&&session()){session().drafts[session().index]=$('answer').value;persist().catch(()=>{$('message').textContent='草稿保存失败';});}};
$('answer').addEventListener('compositionstart',()=>{composing=true;});
$('answer').addEventListener('compositionend',()=>{composing=false;lastCompositionEnd=performance.now();});
window.addEventListener('keyup',e=>{if(e.key==='Enter')blockCompositionEnter=false;});
for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>switchMode(b.dataset.mode);
window.addEventListener('keydown',e=>{
 if(e.defaultPrevented||!data)return;
 if(inWordList){
  if(e.key==='Escape'&&!e.altKey){
   e.preventDefault();
   closeWordList();
  }
  return;
 }
 if(composing||e.isComposing||e.keyCode===229){if(e.key==='Enter')blockCompositionEnter=true;return;}
 if(e.ctrlKey||e.metaKey||e.getModifierState('AltGraph'))return;
 if($('settings').open)return;
 const isReplayKey=(
  (e.key==='Tab'&&!e.altKey&&!e.ctrlKey&&!e.metaKey)||
  (e.key==='ArrowUp'&&!e.altKey&&!e.ctrlKey&&!e.metaKey)||
  (e.altKey&&e.key.toLowerCase()==='r')
 );
 if(isReplayKey&&active&&current()){
  e.preventDefault();
  if(!e.repeat&&!saving)play();
  return;
 }
 const command=e.key==='Enter'||e.key==='Escape'||(e.altKey&&['h','1','2','3','arrowright'].includes(e.key.toLowerCase()));
 if(e.repeat&&command){e.preventDefault();return;}
 if(e.key==='Enter'&&(blockCompositionEnter||performance.now()-lastCompositionEnd<=30)){e.preventDefault();return;}
 if(e.key==='Escape'&&!e.altKey){e.preventDefault();settings();return;}
 if(e.altKey){if(!active||saving)return;const key=e.key.toLowerCase();
  if(key==='arrowright'){e.preventDefault();submit(true);}
  else if(key==='h'){e.preventDefault();showHint();}
  else if(['1','2','3'].includes(key)){e.preventDefault();data.settings.rate={'1':0.75,'2':1,'3':1.25}[key];persist();play();}
  return;
 }
 if(!active||!current()){
  if(e.key==='Enter'){
   if($('toMain')&&!$('toMain').hidden){e.preventDefault();switchMode('main');}
   else if(!$('start').hidden&&e.target===document.body){e.preventDefault();start();}
  }
  return;
 }
 if(e.target!==$('answer'))return;
 if(e.key==='Enter'){e.preventDefault();if(!saving)submit();}
 else if(e.key==='Backspace'&&!$('answer').value&&!saving&&!e.repeat){e.preventDefault();previous();}
 else if(e.key===' '&&!$('answer').value&&data.settings.spaceReplay&&!saving){e.preventDefault();if(!e.repeat)play();}
});
// 同步只合并「每词结果」，不合并「练到第几个」。若本地没有位置但已有学习记录，
// 自动前进到第一个还没练过的词，避免同步完看起来像从头开始。
function alignToFirstUnlearned(force){
 const s=(typeof session==='function')?session():null;
 if(!s||!Array.isArray(s.list))return {moved:0,allLearned:false};
 const has=Object.values(data.records||{}).some(r=>r&&r.attempts>0);
 if(!has)return {moved:0,allLearned:false};
 // 1) 续上「上次练到的那个词」之后：只要对面更靠后就前进，比本地落后就不动
 const rp=data.resume;
 if(rp&&rp.key){
  const at=s.list.indexOf(rp.key);
  if(at>=0&&at+1>s.index){const m=at+1-s.index;s.index=at+1;s.drafts=s.drafts||{};return {moved:m,allLearned:false,via:'resume'};}
 }
 if(!force&&s.index!==0)return {moved:0,allLearned:false};
 let pos=-1;
 for(let i=0;i<s.list.length;i++){const r=data.records[s.list[i]];if(!r||!r.attempts){pos=i;break;}}
 if(pos<0)return {moved:0,allLearned:true};
 if(pos===s.index)return {moved:0,allLearned:false};
 const moved=Math.max(0,pos-s.index);
 s.drafts=s.drafts||{};s.index=pos;
 return {moved,allLearned:false};
}
 async function alignAfterMerge(){
  if(mode!=='main'||inWordList)return;
  const al=alignToFirstUnlearned(false);
  render(false);
  if(al.moved>0)$('message').textContent=`已按同步进度跳过 ${al.moved} 个学过的词，从第一个没练的接着来（Backspace 可回退）`;
  else if(al.allLearned)$('message').textContent='主线里的词都练过了，可以切到「复习」或「错词」模式继续。';
 }
 (async()=>{try{
  words=window.WORDS;if(!Array.isArray(words)||!words.length)throw Error('词表为空');
 const occurrences=new Map();words=words.filter(w=>w&&typeof w.word==='string').map(w=>{const n=occurrences.get(w.word)||0;occurrences.set(w.word,n+1);return {...w,key:w.word+'\u001f'+n};}).sort((a,b)=>b.freq-a.freq);byWord=new Map(words.map(w=>[w.key,w]));
 db=await openDB();data=await load();data.settings={...defaults,...data.settings};mode=data.mode||'main';
 data.records||={};data.srs||={};data.daily||={};
 updateSyncUI();
 if(Sync&&Sync.getToken()){
  try{
   const remote=await Sync.pull();
   if(remote&&Sync.mergeIntoLocal(data,remote)){
    await persist();
   }
  }catch(e){
   console.warn('Initial sync pull skipped:',e.message);
  }finally{
   updateSyncUI();
  }
 }
 // Reconcile imported tables without overwriting the main-line checkpoint.
 for(const key of Object.keys(data.sessions)){const s=data.sessions[key];const before=s.list.slice(0,s.index).filter(w=>byWord.has(w));const after=s.list.slice(s.index).filter(w=>byWord.has(w));if(key==='main')for(const w of words)if(!s.list.includes(w.key))after.push(w.key);s.list=before.concat(after);s.index=before.length;s.drafts||={};}
 if(!data.sessions[mode])buildSession();
 // 只有主线才做「跳过已学」对齐；复习/错词本身就是按规则选出来的队列
 let alignInfo={moved:0,allLearned:false};
 if(mode==='main')alignInfo=alignToFirstUnlearned(false);
 await persist();render(false);
 if(mode==='main'){
  if(alignInfo.moved>0)$('message').textContent=`已按同步进度跳过 ${alignInfo.moved} 个学过的词，从第一个没练的接着来（Backspace 可回退）`;
  else if(alignInfo.allLearned)$('message').textContent='主线里的词都练过了，可以切到「复习」或「错词」模式继续。';
 }
 if(location.protocol==='file:')$('offline').textContent='本地文件模式：可直接练习；安装 PWA 请使用 HTTPS 或 localhost。';
 else if('serviceWorker'in navigator){const reg=await navigator.serviceWorker.register('sw.js');await navigator.serviceWorker.ready;$('offline').textContent='离线核心已缓存；已存在音频正在后台缓存。';navigator.serviceWorker.addEventListener('message',e=>{if(e.data.type==='audio-cache')$('offline').textContent=`离线核心已就绪 · 已缓存音频 ${e.data.count} 个（缺失词使用系统语音）`;});if(reg.active)reg.active.postMessage({type:'cache-audio',files:words.map(w=>w.audio).filter(Boolean)});}
 }catch(e){$('message').textContent='无法初始化：'+e.message+'。请确认词表可用、浏览器允许 IndexedDB。';$('start').disabled=true;}})();
