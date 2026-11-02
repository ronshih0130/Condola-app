export type RenewalInput = { startDate:string; endMode:string; endDate:string; rent:string; frequency:string; dueDay:string; deposit:string };
export type RenewalTerms = { startDate:string; endDate:string|null; rentMinor:string; frequency:string; dueDay:number; depositMinor:string; currency:string; minorUnit:number };
const MAX=BigInt("9223372036854775807");
export function validRenewalDate(s:string):boolean {
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if(!m)return false;
  const y=Number(m[1]), month=Number(m[2]), day=Number(m[3]); if(y<1||month<1||month>12||day<1)return false;
  const leap=y%4===0&&(y%100!==0||y%400===0); return day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}
export function renewalMinor(raw:string,unit:number):string|null {
  if(!Number.isInteger(unit)||unit<0||unit>4||typeof raw!=="string"||raw.length>32||!/^\d+(?:\.\d+)?$/.test(raw))return null;
  const [whole,fraction=""]=raw.split("."); if(fraction.length>unit)return null;
  const amount=BigInt(whole)*BigInt(10)**BigInt(unit)+BigInt((fraction+"0".repeat(unit)).slice(0,unit)||"0"); return amount<=MAX?amount.toString():null;
}
export function renewalMajor(minor:string,unit:number):string {
  if(!/^\d+$/.test(minor)||!Number.isInteger(unit)||unit<0||unit>4)throw new Error("Invalid amount");
  const digits=BigInt(minor).toString().padStart(unit+1,"0");return unit?`${digits.slice(0,-unit)}.${digits.slice(-unit)}`:digits;
}
export function parseRenewalInput(raw:RenewalInput,current:RenewalTerms):RenewalTerms|null {
  if(!raw||typeof raw!=="object"||![raw.startDate,raw.endMode,raw.endDate,raw.rent,raw.frequency,raw.dueDay,raw.deposit].every(v=>typeof v==="string"))return null;
  if(!validRenewalDate(raw.startDate)||!['date','open_ended'].includes(raw.endMode)||(raw.endMode==='date'&&(!validRenewalDate(raw.endDate)||raw.endDate<raw.startDate))||(raw.endMode==='open_ended'&&raw.endDate!=='')||!["monthly","quarterly","yearly"].includes(raw.frequency)||!/^([1-9]|[12]\d|3[01])$/.test(raw.dueDay))return null;
  const rent=renewalMinor(raw.rent,current.minorUnit),deposit=renewalMinor(raw.deposit,current.minorUnit);if(rent===null||deposit===null)return null;
  return {startDate:raw.startDate,endDate:raw.endMode==='open_ended'?null:raw.endDate,rentMinor:rent,frequency:raw.frequency,dueDay:Number(raw.dueDay),depositMinor:deposit,currency:current.currency,minorUnit:current.minorUnit};
}
export function renewalDiff(before:RenewalTerms,after:RenewalTerms) {
  return {startDate:before.startDate!==after.startDate,endDate:before.endDate!==after.endDate,rent:before.rentMinor!==after.rentMinor,frequency:before.frequency!==after.frequency,dueDay:before.dueDay!==after.dueDay,deposit:before.depositMinor!==after.depositMinor};
}
