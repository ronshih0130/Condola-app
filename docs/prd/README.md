# Per-feature PRD index
Destination files below are planned migrations, not claims that files already exist.
Source root: `/workspace/pm-saas/design/`.
“Spec” means a source is listed; it does not establish deployment or flag exposure.
“Yes” requires an explicit acceptance heading in the supplied heading extract; otherwise TODO.
For entries marked “spec”, TODO(owner): establish live/in-flight status from current verdicts.

| Feature/source under source root | Destination | Status | Flag | Acceptance section present? |
| --- | --- | --- | --- | --- |
| `e-sign/spec.md` | `docs/prd/e-sign.md` | in-flight per Q8 | TODO(owner): name/state | TODO |
| `lease-renewal-moveout/spec.md` | `docs/prd/lease-renewal-moveout.md` | spec | TODO(owner): establish | TODO |
| `line-notify/spec.md` | `docs/prd/line-notify.md` | spec | TODO(owner): establish | TODO |
| `payment-settlement/spec.md` | `docs/prd/payment-settlement.md` | spec; core records live in older inventory | TODO(owner): establish | TODO |
| `plan-selector/spec.md` | `docs/prd/plan-selector.md` | spec | TODO(owner): establish | TODO |
| `repair/spec.md` | `docs/prd/repair.md` | spec; partial live in older inventory | TODO(owner): establish | TODO |
| `tenant-portal/spec.md` | `docs/prd/tenant-portal.md` | spec; portal live in older inventory | TODO(owner): establish | TODO |
| `vendor-receipt/spec.md` | `docs/prd/vendor-receipt.md` | spec | no flag by app decision; TODO(owner): reconcile delivery state | yes |
| `contractor-app/flow_spec_v1.md` | `docs/prd/contractor-app.md` | spec | TODO(owner): establish | TODO |
| `tenant-app/flow_spec_v1.md` | `docs/prd/tenant-app.md` | spec | TODO(owner): establish | TODO |
| `contractor-app/job_types_v1.md` | `docs/prd/contractor-job-types.md` | spec | TODO(owner): establish | yes |
| `privacy-ai/draft-v2.md` | `docs/prd/privacy-ai.md` | in-flight per Q8 | TODO(owner): establish | TODO |
| `qa/design_gap_v1.md` | `docs/prd/design-gap.md` | spec/supporting gap list | TODO(owner): applicability | TODO |
| `e-sign/legal_research.md` | `docs/prd/e-sign-legal-research.md` | spec/supporting research | TODO(owner): applicability | TODO |

All entries from `spec-headings.txt` are included, including supporting research and gap documents.
TODO(owner): migrate each source, preserve provenance, and add numbered acceptance criteria and test mapping.
TODO(owner): confirm whether supporting documents remain separate from their feature PRD.
Use [_TEMPLATE.md](_TEMPLATE.md) for new features.
Acceptance belongs in the feature PRD; [QA_PLAN.md](../QA_PLAN.md) defines shared release checks.

Sources: `spec-headings.txt`; `decisions.md` Q8/Q9; `app_decisions.md`; `/workspace/pm-saas/live_features.md`.
