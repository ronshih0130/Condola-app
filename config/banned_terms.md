# Banned terms

Product Marketing owns this file. It is the only banned-word list.

`scripts/check-banned-terms.mjs` reads this file and nothing else. CI, `scripts/qa/smoke.sh`, and Playwright all call that script.

Check order:

1. Remove every allowlisted phrase, longest phrase first.
2. Fail if any banned term is still present.

`房東` is banned. It is allowed only inside the exact slogan `一起成為完美房東`.

## Banned

- 入帳
- 收租
- 收款
- 欠租
- 已收
- 代收
- 示範
- 測試模式
- 沙盒
- 房東

## Allow

- 一起成為完美房東
- 自動計入帳單
- 加入帳單
- 匯入帳戶末五碼
- 登入帳號
- 款項到帳
