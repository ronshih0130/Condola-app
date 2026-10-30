import type {Locale} from '../index';
import {ownerRepairCopy} from './repair-owner-policy';
const words={
 'zh-TW':{title:'物件修繕門檻',entry:'設定物件個別門檻',back:'返回個人預設',note:'物件個別門檻會優先於個人與地區預設。',newVersions:'這裡會儲存物件門檻。估價核准功能尚未開放。',edit:'編輯物件門檻',set:'設定物件個別門檻',clear:'清除物件個別門檻',clearNote:'清除目前物件的個別門檻後，使用適用的個人或地區預設；沒有適用設定時會保留待確認。',changed:'物件修繕門檻已更新。'},
 en:{title:'Property repair threshold',entry:'Set property override',back:'Back to personal default',note:'A property override takes precedence over personal and regional defaults.',newVersions:'This page saves the property threshold. Estimate approval is not yet available.',edit:'Edit property threshold',set:'Set property override',clear:'Clear property override',clearNote:'Clearing the current property override uses the applicable personal or regional default. Without an applicable configuration, it remains unconfirmed.',changed:'Property repair threshold updated.'},
} satisfies Record<Locale,Record<string,string>>;
export function ownerRepairOverrideCopy(locale:Locale){return {...ownerRepairCopy(locale),...words[locale]};}
