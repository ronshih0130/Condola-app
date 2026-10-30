import assert from "node:assert/strict";
import test from "node:test";
import { afterBusyMark, notificationMarkResult, vendorTokenFromNotificationPath } from "./notification-mark-rules";

test("only exact mark responses can report busy or committed success",()=>{
 assert.equal(notificationMarkResult(true,{status:"busy"}),"busy");
 assert.equal(notificationMarkResult(true,{status:"marked"}),"marked");
 for(const value of [null,[],{}, {status:"marked",extra:true}, {status:"other"}, {status:1}]) assert.equal(notificationMarkResult(true,value),"unknown");
 assert.equal(notificationMarkResult(false,{status:"marked"}),"unknown");
});
test("vendor token extraction accepts only a single exact notification path",()=>{
 const token="A".repeat(43);
 assert.equal(vendorTokenFromNotificationPath(`/v/${token}/notifications`),token);
 assert.equal(vendorTokenFromNotificationPath(`/v/%41${"A".repeat(42)}/notifications`),token);
 for(const path of [`/v/${token}/notifications/`,`/v/${token}/notifications/extra`,`/v/${token}%2Fother/notifications`,`/v/${token}/other`,`/v/%2541${"A".repeat(42)}/notifications`,`/v/%ZZ/notifications`,`/v/${token}?x=1/notifications`]) assert.equal(vendorTokenFromNotificationPath(path),null);
});

test("busy preserves an earlier uncertain mark outcome",()=>{
 assert.equal(afterBusyMark("idle"),"busy");
 assert.equal(afterBusyMark("busy"),"busy");
 assert.equal(afterBusyMark("unknown"),"unknownBusy");
 assert.equal(afterBusyMark("unknownBusy"),"unknownBusy");
});
