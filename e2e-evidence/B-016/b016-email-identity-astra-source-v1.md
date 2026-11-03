# B016 Canonical session email review v1

**SOURCE_GO**

The baseline preferred profiles.email over Auth email. The checked-in schema grants authenticated users UPDATE and profiles_self permits their own row. The admin page and three pricing/partner actions trust the normalized nonempty session email allowlist. This is a conditional source-level privilege issue. Hosted grants, identities and exploitability were not tested.

Both actual readSessionOn identity queries now return only auth.users.email when email_confirmed_at exists. Confirmed nonempty Auth email can still qualify through the unchanged allowlist. The existing null-to-empty mapper and empty deny remain. Byte comparison shows exactly two expression replacements. Display name, UUID, validity, membership, role, organization, environment, consent and touch behavior retain their prior source.

The new test executes the two literals extracted from their hash-parameter call sites in a disposable clone. It requires the authenticated self write to affect one row, the foreign write zero, the stored Auth identity unchanged by spoofing, and tests verified normal/admin, wrong profile, unconfirmed, empty, null and missing-profile cases. Registration appends just this test. Full HTTP loading and dispatch of the missing-consent fallback are separate evidence.

Root final typecheck receipt and its log hash match this map. Source GO permits a scoped local target after an approved execution lock. No database, browser, provider, full gate or hosted exploit was tested by this review. This corrects reliance on mutable profile data. It does not establish how an email was originally confirmed or deliver the verified-email change workflow.
