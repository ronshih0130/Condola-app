"use client";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { archiveV2Pending,assertV2Pending,hasLegacyStatementPending,listV2Pending,persistV2Pending,retainV2Pending,type V2Pending,type V2Scope } from "./settlement-v2-storage";
import { v2PayloadDigest } from "./settlement-v2-payload";
import type { SettlementPreviewInput } from "@/server/settlement-preview";

type Terminal={state:"unresolved"|"busy"|"closed"}|{state:"recorded";id:string};
type Entry={record:V2Pending;terminal:Terminal|null};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function terminal(leaseId:string,requestId:string,mode:"status"|"close"):Promise<Terminal> {
 const response=await fetch("/api/settlement/draft-command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mode,leaseId,requestId})});if(!response.ok)throw new Error("Unavailable");const data:unknown=await response.json();
 if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("Unavailable");const value=data as Record<string,unknown>;
 if(value.ok!==true)throw new Error("Unavailable");if(value.state==="recorded"&&typeof value.id==="string"&&UUID.test(value.id)&&Object.keys(value).sort().join(",")==="id,ok,state")return {state:"recorded",id:value.id};
 if((value.state==="closed"||value.state==="busy"||value.state==="unresolved")&&Object.keys(value).sort().join(",")==="ok,state")return {state:value.state};throw new Error("Unavailable");
}
/** The caller owns capture/edit-generation validation; this hook never clears an uncertain request. */
export function useV2SettlementCommand(incoming:V2Scope) {
 const scope=useMemo(()=>({actorId:incoming.actorId,orgId:incoming.orgId,liveOrgId:incoming.liveOrgId,environment:incoming.environment,leaseId:incoming.leaseId}),[incoming.actorId,incoming.orgId,incoming.liveOrgId,incoming.environment,incoming.leaseId]);
 const scopeKey=JSON.stringify(scope),active=useRef(""),generation=useRef(0),entriesRef=useRef<Entry[]>([]),[entries,setEntries]=useState<Entry[]>([]),[legacyPending,setLegacyPending]=useState(false),[state,setState]=useState<"checking"|"ready"|"unavailable">("checking");
 const updateEntries=useCallback((next:Entry[])=>{entriesRef.current=next;setEntries(next);},[]);
 const matches=useCallback((record:V2Pending)=>entriesRef.current.some(entry=>JSON.stringify(entry.record)===JSON.stringify(record)),[]);
 const verifyKnown=useCallback(()=>{const found=listV2Pending(sessionStorage,scope),known=entriesRef.current.map(entry=>entry.record);retainV2Pending(known,found);retainV2Pending(found,known);},[scope]);
 const refresh=useCallback(async()=>{
  if(active.current!==scopeKey)return;const token=++generation.current;setState("checking");
  try{const legacy=hasLegacyStatementPending(sessionStorage,scope),records=listV2Pending(sessionStorage,scope),next:Entry[]=[];retainV2Pending(entriesRef.current.map(entry=>entry.record),records);for(const record of records){assertV2Pending(sessionStorage,record);const result=await terminal(scope.leaseId,record.requestId,"status");if(active.current!==scopeKey||generation.current!==token)return;assertV2Pending(sessionStorage,record);next.push({record,terminal:result});}if(active.current!==scopeKey||generation.current!==token)return;const final=listV2Pending(sessionStorage,scope);retainV2Pending(records,final);retainV2Pending(final,records);if(hasLegacyStatementPending(sessionStorage,scope)!==legacy)throw new Error("Unavailable");setLegacyPending(legacy);updateEntries(next);setState("ready");}catch{if(active.current===scopeKey&&generation.current===token)setState("unavailable");}
 },[scopeKey,scope,updateEntries]);
 useEffect(()=>{const counter=generation;active.current=scopeKey;counter.current++;updateEntries([]);void refresh();return()=>{active.current="";counter.current++;};},[scopeKey,refresh,updateEntries]);
 const begin=useCallback(async(input:SettlementPreviewInput,fingerprint:string,expectedVersion:string|null)=>{
  if(active.current!==scopeKey||state!=="ready"||entriesRef.current.length)throw new Error("Unavailable");const token=++generation.current;try{if(hasLegacyStatementPending(sessionStorage,scope))throw new Error("Unavailable");const requestId=crypto.randomUUID(),digest=await v2PayloadDigest(requestId,scope,input,fingerprint,expectedVersion);if(active.current!==scopeKey||generation.current!==token||hasLegacyStatementPending(sessionStorage,scope))throw new Error("Unavailable");const record:V2Pending={version:1,scope,requestId,fingerprint,expectedVersion,digest};persistV2Pending(sessionStorage,record);assertV2Pending(sessionStorage,record);updateEntries([{record,terminal:null}]);return {record,token};}catch{if(active.current===scopeKey&&generation.current===token)setState("unavailable");throw new Error("Unavailable");}
 },[scopeKey,scope,state,updateEntries]);
 const canRetry=useCallback(async(record:V2Pending,input:SettlementPreviewInput)=>{
  if(active.current!==scopeKey||!matches(record)) return null;const entry=entriesRef.current.find(item=>item.record.requestId===record.requestId);if(entry?.terminal?.state==="recorded"||entry?.terminal?.state==="closed")return null;const token=++generation.current;try{if(hasLegacyStatementPending(sessionStorage,scope))return null;verifyKnown();assertV2Pending(sessionStorage,record);const digest=await v2PayloadDigest(record.requestId,scope,input,record.fingerprint,record.expectedVersion);if(active.current!==scopeKey||generation.current!==token)return null;if(hasLegacyStatementPending(sessionStorage,scope))return null;verifyKnown();assertV2Pending(sessionStorage,record);return digest===record.digest?token:null;}catch{return null;}
 },[scopeKey,scope,matches,verifyKnown]);
 const close=useCallback(async(record:V2Pending)=>{
  if(active.current!==scopeKey||!matches(record))throw new Error("Unavailable");const token=++generation.current;try{verifyKnown();assertV2Pending(sessionStorage,record);const result=await terminal(scope.leaseId,record.requestId,"close");if(active.current!==scopeKey||generation.current!==token)throw new Error("Unavailable");verifyKnown();assertV2Pending(sessionStorage,record);updateEntries(entriesRef.current.map(entry=>entry.record.requestId===record.requestId?{record,terminal:result}:entry));return result;}catch{if(active.current===scopeKey&&generation.current===token)setState("unavailable");throw new Error("Unavailable");}
 },[scopeKey,scope,matches,updateEntries,verifyKnown]);
 const verify=useCallback((record:V2Pending,token:number)=>{if(active.current!==scopeKey||generation.current!==token||!matches(record))return false;try{if(hasLegacyStatementPending(sessionStorage,scope))return false;verifyKnown();assertV2Pending(sessionStorage,record);return true;}catch{setState("unavailable");return false;}},[scopeKey,scope,matches,verifyKnown]);
 const completed=useCallback((record:V2Pending,id:string,token:number)=>{
  if(active.current!==scopeKey||generation.current!==token||!matches(record)||typeof id!=="string"||!UUID.test(id))return;try{verifyKnown();assertV2Pending(sessionStorage,record);generation.current++;updateEntries(entriesRef.current.map(entry=>entry.record.requestId===record.requestId?{record,terminal:{state:"recorded",id}}:entry));}catch{setState("unavailable");}
 },[scopeKey,matches,updateEntries,verifyKnown]);
 const archive=useCallback((entry:Entry)=>{
  if(active.current!==scopeKey||!entriesRef.current.includes(entry)||!(entry.terminal?.state==="recorded"||entry.terminal?.state==="closed"))throw new Error("Unavailable");try{verifyKnown();archiveV2Pending(sessionStorage,entry.record,entry.terminal.state);generation.current++;updateEntries(entriesRef.current.filter(e=>e.record.requestId!==entry.record.requestId));}catch{setState("unavailable");throw new Error("Unavailable");}
 },[scopeKey,updateEntries,verifyKnown]);
 const open=useCallback((entry:Entry)=>{if(active.current!==scopeKey||!entriesRef.current.includes(entry)||entry.terminal?.state!=="recorded")throw new Error("Unavailable");try{verifyKnown();assertV2Pending(sessionStorage,entry.record);return entry.terminal.id;}catch{setState("unavailable");throw new Error("Unavailable");}},[scopeKey,verifyKnown]);
 return {entries,state,legacyPending,refresh,begin,canRetry,verify,close,completed,archive,open};
}
