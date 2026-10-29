/* Shared pure scoring, SRS spaced repetition and bookkeeping; also usable by Node tests. */
(function(root){
'use strict';
const normalize=(s,strict=false)=>strict?String(s):String(s).trim().replace(/\s+/g,' ').toLowerCase();
function grade(answer,word,strict=false){return normalize(answer,strict)===normalize(word,strict);}
function diff(answer,word,strict=false){
 const a=Array.from(normalize(answer,strict)), b=Array.from(normalize(word,strict));
 const d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
 for(let i=0;i<=a.length;i++)d[i][0]=i; for(let j=0;j<=b.length;j++)d[0][j]=j;
 for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
 let i=a.length,j=b.length,out=[];
 while(i||j){if(i&&j&&d[i][j]===d[i-1][j-1]+(a[i-1]===b[j-1]?0:1)){out.push({text:a[--i],wrong:a[i]!==b[--j]});}else if(i&&d[i][j]===d[i-1][j]+1){out.push({text:a[--i],wrong:true});}else{--j;out.push({text:'□',wrong:true});}}
 return out.reverse();
}
function account(prev,ok,now=Date.now()){
 const p=prev||{attempts:0,correct:0,lastWrongAt:null,streak:0};const streak=ok?p.streak+1:0;
 return {...p,attempts:p.attempts+1,correct:p.correct+(ok?1:0),lastWrongAt:ok?p.lastWrongAt:now,streak};
}

const LADDER=[1, 2, 4, 7, 15, 30, 60, 120];

function addDays(dateStr, n){
 const [y,m,d]=dateStr.split('-').map(Number);
 const dt=new Date(Date.UTC(y, m-1, d+n));
 return dt.toISOString().slice(0, 10);
}

function updateSRS(prev, ok, today){
 const cur=prev||{step:0, due:today, right:0, wrong:0, lastDay:null};
 if(ok){
  if(cur.lastDay===today){
   return {...cur, right:(cur.right||0)+1};
  }
  const nextStep=cur.lastDay===null?1:Math.min((cur.step||0)+1, 7);
  return {
   step: nextStep,
   due: addDays(today, LADDER[nextStep]),
   right: (cur.right||0)+1,
   wrong: cur.wrong||0,
   lastDay: today
  };
 }else{
  return {
   step: 0,
   due: addDays(today, 1),
   right: cur.right||0,
   wrong: (cur.wrong||0)+1,
   lastDay: cur.lastDay
  };
 }
}

function isDue(item, today){
 return !!(item && item.due && item.due<=today);
}

function buildReviewList(words, srs, today){
 if(!Array.isArray(words)||!srs)return [];
 const dueList=[];
 for(const w of words){
  const item=srs[w.key];
  if(item&&item.due&&item.due<=today){
   dueList.push(w);
  }
 }
 dueList.sort((a,b)=>{
  const sa=srs[a.key], sb=srs[b.key];
  if(sa.due!==sb.due)return sa.due.localeCompare(sb.due); // 逾期天数降序 -> due越早越先
  if((sb.wrong||0)!==(sa.wrong||0))return (sb.wrong||0)-(sa.wrong||0);
  return (b.freq||0)-(a.freq||0);
 });
 return dueList.map(w=>w.key);
}

function buildWrongList(words, records, srs, today){
 if(!Array.isArray(words)||!records)return [];
 const wrongItems=words.filter(w=>records[w.key]?.lastWrongAt);
 wrongItems.sort((a,b)=>{
  const sa=srs?.[a.key], sb=srs?.[b.key];
  const dueA=isDue(sa, today)?1:0, dueB=isDue(sb, today)?1:0;
  if(dueA!==dueB)return dueB-dueA; // 到期未复习排最前
  const ra=records[a.key], rb=records[b.key];
  const errRateA=(ra.attempts-ra.correct)/(ra.attempts||1);
  const errRateB=(rb.attempts-rb.correct)/(rb.attempts||1);
  if(Math.abs(errRateA-errRateB)>1e-5)return errRateB-errRateA;
  const netWrongA=ra.attempts-ra.correct, netWrongB=rb.attempts-rb.correct;
  if(netWrongA!==netWrongB)return netWrongB-netWrongA;
  return (b.freq||0)-(a.freq||0);
 });
 return wrongItems.map(w=>w.key);
}

function countDue(words, srs, today){
 if(!Array.isArray(words)||!srs)return 0;
 let count=0;
 for(const w of words){
  if(srs[w.key]?.due&&srs[w.key].due<=today)count++;
 }
 return count;
}

function getWordMeta(w, record, srsItem, today){
 const attempts=record?.attempts||0;
 const correct=record?.correct||0;
 const wrongFromRecord=attempts-correct;
 const wrongFromSrs=srsItem?.wrong||0;
 const wrong=Math.max(wrongFromRecord, wrongFromSrs);
 const right=correct;
 const isLearned=attempts>0;
 let status='未学', statusCode='unlearned';
 if(isLearned){
  if(wrong>0){
   status=`答错 ${wrong} 次`;
   statusCode='wrong';
  }else{
   status='已会';
   statusCode='mastered';
  }
 }
 const due=srsItem?.due||'—';
 const isDueToday=!!(srsItem?.due&&srsItem.due<=today);
 return {
  key: w.key,
  word: w.word,
  gloss: w.gloss||'',
  freq: w.freq||0,
  audio: w.audio,
  attempts,
  right,
  wrong,
  due,
  isDue: isDueToday,
  isLearned,
  status,
  statusCode,
  lastWrongAt: record?.lastWrongAt||0
 };
}

function filterAndSortWordList(words, records, srs, filterType='all', query='', sortBy='freq', today=''){
 if(!Array.isArray(words))return [];
 const r=records||{}, s=srs||{};
 const q=query.trim().toLowerCase();
 const list=[];
 for(const w of words){
  const meta=getWordMeta(w, r[w.key], s[w.key], today);
  // 筛选过滤
  if(filterType==='unlearned'&&meta.isLearned)continue;
  if(filterType==='learned'&&!meta.isLearned)continue;
  if(filterType==='correct'&&meta.right<=0)continue;
  if(filterType==='wrong'&&meta.wrong<=0)continue;
  if(filterType==='due'&&!meta.isDue)continue;
  // 搜索过滤
  if(q){
   const matchWord=meta.word.toLowerCase().includes(q);
   const matchGloss=meta.gloss.toLowerCase().includes(q);
   if(!matchWord&&!matchGloss)continue;
  }
  list.push(meta);
 }
 // 排序
 list.sort((a,b)=>{
  if(sortBy==='wrong'){
   if(b.wrong!==a.wrong)return b.wrong-a.wrong;
   return b.freq-a.freq;
  }else if(sortBy==='alpha'){
   return a.word.localeCompare(b.word);
  }else if(sortBy==='recent'){
   if(b.lastWrongAt!==a.lastWrongAt)return b.lastWrongAt-a.lastWrongAt;
   return b.attempts-a.attempts;
  }else{ // 'freq' 默认考频降序
   if(b.freq!==a.freq)return b.freq-a.freq;
   return a.word.localeCompare(b.word);
  }
 });
 return list;
}

function calculateSummary(words, records, srs, today){
 let learned=0, unlearned=0, wrongCount=0, dueCount=0;
 const r=records||{}, s=srs||{};
 for(const w of words){
  const rec=r[w.key];
  if(rec&&rec.attempts>0){
   learned++;
   if((rec.attempts-rec.correct)>0||rec.lastWrongAt)wrongCount++;
  }else{
   unlearned++;
  }
  if(s[w.key]?.due&&s[w.key].due<=today){
   dueCount++;
  }
 }
 return {
  total: words.length,
  learned,
  unlearned,
  wrong: wrongCount,
  due: dueCount
 };
}

const api={normalize,grade,diff,account,LADDER,addDays,updateSRS,isDue,buildReviewList,buildWrongList,countDue,getWordMeta,filterAndSortWordList,calculateSummary};
if(typeof module!=='undefined')module.exports=api;else root.DictationCore=api;
})(typeof window!=='undefined'?window:globalThis);
