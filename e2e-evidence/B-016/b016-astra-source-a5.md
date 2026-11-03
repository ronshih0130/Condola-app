# B-016 independent source review A5

**SOURCE_GO for the bounded DB target.** One bounded DB target on the approved frozen working bytes, then EN390 focus only after the DB target passes. No A5 runtime evidence, full browser, build, gate or release verdict is implied. A4 remains failed with 10 passes and one org_members_check fixture error.

Only the role-change subcase selects the seeded non-billing manager, changes that membership to accountant during the existing paused save, and restores the manager role. Expiry, revocation and organization opt-out subcases still use the administrator. The wait, unavailable result, unchanged own profile and no new audit assertions remain. The billing-owner constraint, production service and all other source-map paths are unchanged.

Independently verified all nine source-map blobs, sizes and SHA-256s, all 1,012 working source blobs, three v4 helpers, the pinned Playwright core bundle and 24 preserved A4 failure bindings. The freeze identifies working bytes over base HEAD `f1be31ee77dff48d132ce71040af1c3d13e28d62`.

- A5 map SHA-256 `61d5f210da3e33cc718a53fd7813616ad47f53c0378a815e954ad5541f9327f4`
- A5 freeze SHA-256 `8925348f521944982110ed7a5548b4611cc9d2626c1418cec06e1c4ea85a8b18`
- Corrected integration fixture Git blob `f233653a71d9a59275cc220242f0d01eb43fef1c`
- A4 failure manifest SHA-256 `797d195607d686555bf4c17f99aff0d625ff05cd19c08883efc5f39aeccff3e0`
