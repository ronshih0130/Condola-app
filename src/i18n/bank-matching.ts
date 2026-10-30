const strings = {
 en:{title:"Bank matching", account:"Account", csv:"Bank CSV file", encoding:"File encoding", dateFormat:"Date format", upload:"Import", rows:"Unmatched bank lines", overlap:"Similar line exists; review for overlap", noRows:"No unmatched bank lines", match:"Match payment", reject:"Reject suggestion", reason:"Reason", choose:"Choose a payment", suggestions:"Suggestions", manual:"Manual selection", noAccounts:"Add an account before importing", positive:"Only matching positive amounts and currency can be selected."},
 "zh-TW":{title:"銀行配對",account:"帳戶",csv:"銀行 CSV 檔案",encoding:"檔案編碼",dateFormat:"日期格式",upload:"匯入",rows:"未配對銀行明細",overlap:"有相似明細，請確認是否重複",noRows:"沒有未配對銀行明細",match:"配對款項",reject:"拒絕建議",reason:"原因",choose:"選擇款項",suggestions:"配對建議",manual:"手動選擇",noAccounts:"請先新增帳戶",positive:"只能選擇金額及幣別相同的正數款項。"},
} as const;
export function bankMatchingStrings(locale: string) { return locale === "zh-TW" ? strings["zh-TW"] : strings.en; }
