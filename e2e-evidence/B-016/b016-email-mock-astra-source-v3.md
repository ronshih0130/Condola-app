# B016 email mock source review v3

**SOURCE_NO_GO.** The response-side changes close both v2 findings. One outgoing OTP boundary remains.

**P1 · Trusted mailbox selection.** The strict provider-address comparison is used on replies but not on the provider-owned state used to choose the outgoing verification mailbox. With pendingUnexpired true, state.pending equal to “new tag@example.test” and target equal to “new+tag@example.test”, verify repairs the space and proceeds to POST /auth/v1/verify for the plus address. A malformed current mailbox is likewise repaired when the current branch is selected. The verify endpoint consumes proof before any possible final UUID/target check; a first-leg partial response has no user at all. Current assess/begin can also report pending for that same stored mismatch. This is a source counterexample, not an observed real request.

Use strict canonical address decoding/comparison for trusted current and stored pending inputs; reserve form repair for a newly submitted target only. Treat inconsistent active pending state as invalid. Use the validated stored mailbox for verification. Add zero-transport mock assertions for malformed current/pending, both mailbox selectors, and an uppercase-plus canonical positive. Retain all existing response negatives and no-retry rules.

The two v2 response-side defects are closed. User email, owned identity_data.email, optional identity.email and PUT new_email use strict case-only canonical matching. VerifiedUser and grant/GET/PUT/final envelopes reject conflicting provider error markers. Only the pinned two-field partial response is accepted. Final evidence produces a candidate requiring trusted canonical reread.

The fixed origin, mandatory injected transport, fresh password grant, bearer-bound GET /user, email-only PUT, bounded transport/body timeout and no retry remain intact. Verified or ambiguous factors and explicit true/malformed SSO fields deny in the checked representation. The pinned provider version, actor projection, omission semantics and eventual canonical authorization are not deployed evidence.

All five current bindings and ten archived v2 bindings were rehashed. Only provider source and its mock tests changed from v2; the package retains exactly the two added test paths. Tests, compiler, lint, network, DB, browser and gate were not run. No broader source or feature verdict is supplied.
