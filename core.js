/* Shared pure scoring and bookkeeping; also usable by Node tests. */
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
const api={normalize,grade,diff,account}; if(typeof module!=='undefined')module.exports=api;else root.DictationCore=api;
})(typeof window!=='undefined'?window:globalThis);
