# B017 authority core stage one v2

**SOURCE_GO_STAGE_ONE_FRAGMENT_ONLY.** The v1 selected-scope P1 is closed in source. All three v2 inputs and the preserved v1 inputs match their hashes. Only the resolver’s initial admission predicate changed in executable SQL.

The resolver compares the existing transaction-local app.active_org_id and app.env pins with the supplied canonical organization UUID text and allowed environment before reading authority state. Missing or empty settings produce NULL and fail the null-safe comparison; malformed or unequal text fails without a UUID cast. A valid dual member pinned to A cannot request B, and a live-pinned request cannot resolve its sandbox. The existing authenticated user, unrevoked/unexpired SID, selected org/live-parent and active member checks still apply. The trusted adapter must authenticate the cookie and establish those pins; the settings alone grant no authority.

The documented positive/negative vectors, owner privileges, FORCE-RLS behavior and actual target semantics remain unexecuted. The 17-key checksum identifies the catalog only. Role/invite governance, sticky enrollment, last-Admin protection, policy-safe readers, vendor/reset operations and the 47 supported call groups belong to subsequent stages. This verdict permits continued inactive source authoring, with no SQL parsing, application, runtime or enrollment approval.
