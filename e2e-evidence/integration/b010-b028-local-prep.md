# B010/B028 local candidate — PARTIAL / NO-GO

Base: 0e49bd0169557eec51e96a449db5a873a4b19e5b. Local capture only; rollout defaults OFF. No external messages or provider calls.

Validation before this checkpoint: scoped integration run 37/37; separate concurrency 5/5; payment flow 5/5; payment guard 3/3; schedule 3/3; legacy OFF 14/14; typecheck, scoped lint, and copy guard 6/6. These are coder-run results, not release gates. Mixed-identity, timezone and reversal SQL had scoped independent static review.

Pending: browser execution; final independent review on exact candidate; full unit/RLS/build/release gates; notification center and other B028 channels; production retention and provider/cutover decisions; no staging or production activation. This checkpoint does not establish whole B010 or B028 PASS.

## Native Git blob manifest (source and tests)

- `8d32f70fd7e667de432dc5584e6fcf248163a06e`  `e2e/b010-payment-request.spec.ts`
- `c2f1d12116dcfa936a7b7b9670ed986be146b43f`  `e2e/b010-reminder-local.spec.ts`
- `1444aa12885b40d402fda69d067d059845582470`  `src/app/api/cron/reminders/route.ts`
- `dd125f1145b89c1d9b341bf872b16d1c49dfd58c`  `src/app/api/payments/request-status/route.ts`
- `dfd604a9dff1285281e4445f9d38c62c630e3907`  `src/app/m/leases/[id]/page.tsx`
- `da3c10264505c322114f376c5b7dee2a9773d954`  `src/app/m/rent/page.tsx`
- `bc1e0cc8b64858509ae4cf7ec3e3646c83cb1cae`  `src/app/m/rent/remind/[id]/page.tsx`
- `1bf1a99b4b109758344574dd3886e96ff977aa3d`  `src/app/t/page.tsx`
- `08ca08087e1c23e01963c87fdece2098b3486454`  `src/app/t/reminders/[id]/page.tsx`
- `898a840c27170f20b00a25bd4b4976f83afc0475`  `src/components/dialogs.tsx`
- `7ac1c271f687269bff3f576c16e985f8b6bef468`  `src/i18n/lanes/reminders.ts`
- `458e48f3c0884ae537a691321ec59427db7acf96`  `src/server/actions.ts`
- `bb35ffdcf69860d492f8ad53e8ca9beb0b5d9f6c`  `src/server/bank-matching.ts`
- `efcc8035589489b1a04b11a88594d1252c23c988`  `src/server/domain.ts`
- `7adef11fb268f1763ce797701daf53900d600c1c`  `src/server/local-reminder-capture.ts`
- `3228c2851abb5f0abe4bb38484ae65b4377defe3`  `src/server/local-rent-reminders.ts`
- `3dff4b308f8024eb75b21482b8d69cdf64f03824`  `src/server/manual-reminders.ts`
- `0eee36f710a57e55febb8ae6be9e77ba6c485d34`  `src/server/overdue-schedule.integration.test.ts`
- `9422513553e20688e3a1d0bff059d34bdd0778e5`  `src/server/payment-request-status.ts`
- `87160a8f95bf9094ea3a3bc7fe823c4ba12e50c3`  `src/server/payment-result-events.ts`
- `0495b9434e8da2a4e6a8b17d2450fb15e6c7546f`  `src/server/payment-result-flow.integration.test.ts`
- `ff7b1e535538ea69e8521ccc89acc05178236c66`  `src/server/payment-result-guard.integration.test.ts`
- `909c58e376b8dbae2044d50e3c6b94777be13d8a`  `src/server/payment-result-utility-locks.integration.test.ts`
- `cf5e588e5fedeb3c54ec21484c43eb8f02355323`  `src/server/reminder-actions.ts`
- `94a1c3f4978e0fb81731851139064f06c2037ee2`  `src/server/reminder-foundation.integration.test.ts`
- `88770e5058e3c0d1521cb29c59e58ebd5c2f670f`  `src/server/reminder-foundation.test.ts`
- `22faff755071d384fff5ad6744bd24d7b88e2c3d`  `src/server/reminder-foundation.ts`
- `b947d915170fee745a1591c4df95bce9b900bf6e`  `src/server/reminder-seed.integration.test.ts`
- `4778bb0c5c68c5d875457e0719b95a9963fdacac`  `src/server/reminders.test.ts`
- `2c3558108bf9ae287e111045d700fbc619f350b8`  `src/server/reminders.ts`
- `1b874cfb69bb67522d8d67f0f7728d35cc75ca0d`  `src/server/seed.ts`
- `c52b0d24305660f62f8c52c4073fc5febda9be52`  `src/server/tenant-reminder-preferences.ts`
- `1bc00d2b73ec27429c66254435d354f252bbebb9`  `supabase/migrations/20261031100212_b010_b028_local_events.sql`
