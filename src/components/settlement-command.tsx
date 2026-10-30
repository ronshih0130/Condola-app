"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { settlementCommandStatusAction } from "@/server/settlement-actions";
import type { SettlementCommandKind } from "@/server/settlement-command-status";
import { settlementCopy } from "@/i18n/settlement";
export type CommandScope={actorId:string;orgId:string;leaseId:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function useSettlementCommand(scope:CommandScope,kind:SettlementCommandKind,versionId:string|null,slot:string) {
  const key=`condola:settlement:${scope.actorId}:${scope.orgId}:${scope.leaseId}:${kind}:${versionId??"none"}:${slot}`;
  const request=useRef(""), activeKey=useRef(""), generation=useRef(0), [state,setState]=useState<"checking"|"unknown"|"pending"|"recorded"|"unavailable">("checking"),[recordId,setRecordId]=useState<string|null>(null);
  const check=useCallback(async()=>{
    if(activeKey.current!==key)return;
    const id=request.current, token=++generation.current;
    if(!id){try {const stored=sessionStorage.getItem(key);if(stored)throw new Error("unavailable request");setRecordId(null);setState("unknown");}catch{setState("unavailable");}return;}
    setState("checking");
    try {const result=await settlementCommandStatusAction(scope.leaseId,versionId,kind,id);
      if(token!==generation.current || request.current!==id)return;
      if(!result.ok){setState("unavailable");return;}
      setState(result.status);setRecordId("id" in result ? result.id ?? null : null);
    } catch {if(token===generation.current && request.current===id)setState("unavailable");}
  },[scope.leaseId,versionId,kind,key]);
  useEffect(()=>{const counter=generation;counter.current++;activeKey.current=key;request.current="";setRecordId(null);setState("checking");try{const id=sessionStorage.getItem(key);if(id&&!UUID.test(id))throw new Error("invalid request");request.current=id??"";void check();}catch{setState("unavailable");}return ()=>{counter.current++;activeKey.current="";request.current="";};},[key,check]);
  const begin=()=>{if(activeKey.current!==key || state!=="unknown")return null;try{if(!request.current){const count=Array.from({length:sessionStorage.length},(_,i)=>sessionStorage.key(i)).filter(k=>k?.startsWith("condola:settlement:")).length;if(count>=100)throw new Error("storage full");const id=crypto.randomUUID();sessionStorage.setItem(key,id);request.current=id;}return request.current;}catch{setState("unavailable");return null;}};
  const completed=(id:string)=>{if(activeKey.current!==key || !id || request.current!==id)return;generation.current++;setState("recorded");};
  const next=()=>{if(activeKey.current!==key || state!=="recorded")return;try{sessionStorage.removeItem(key);generation.current++;request.current="";setRecordId(null);setState("unknown");}catch{setState("unavailable");}};
  return {state,recordId,begin,completed,next,check,requestId:()=>activeKey.current===key?request.current:""};
}
export function SettlementCommandNotice({state,locale,onNext,onCheck,onRecover}:{state:"checking"|"unknown"|"pending"|"recorded"|"unavailable";locale:string;onNext:()=>void;onCheck:()=>void;onRecover?:()=>void}) {
  const c=settlementCopy(locale);
  if(state==="unknown")return null;
  if(state==="checking")return <p className="small muted" role="status">{c.checking}</p>;
  if(state==="pending")return <p className="alert info" role="status">{c.pendingRequest}</p>;
  if(state==="unavailable")return <div className="alert bad" role="alert"><span>{c.failed}</span><button type="button" className="btn sm" onClick={onCheck}>{c.checkAgain}</button></div>;
  return <div className="alert ok" role="status"><span>{c.saved}</span>{onRecover&&<button type="button" className="btn sm" onClick={onRecover}>{c.recover}</button>}<button type="button" className="btn sm" onClick={onNext}>{c.newRequest}</button></div>;
}
