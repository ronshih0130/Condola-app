# B-002 actual move-out UI scoped evidence

- OFF browser tests at 390/1280 confirm no card and no move-out update.
- ON browser tests at both widths use the real server action: admin records an actual date, manager corrects it, and the database audit records each authenticated actor, note and old/new date. The synthetic open-ended lease's contract end remains null; the corrected date produces the tested 90-day eligibility date.
- An accountant sees no edit card; another organization's admin receives the expected 404 and no card. Existing service tests separately exercise exact org/environment/active-membership checks, invalid dates and default-OFF behavior. The card has synchronous same-page duplicate-submit protection.
- The screenshots were inspected at phone and desktop widths. No unexpected page errors, console errors or 5xx were seen; the intentional cross-org 404 was checked separately.
- This is scoped UI evidence, not proof of production purge, expired-token HTTP denial, external delivery, rollback, full move-out journey or staging behavior.
