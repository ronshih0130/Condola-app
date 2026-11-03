# B-011 deposit attribution v3 independent source verdict

**GO for the closed design only.** Independently reviewed the exact inert handoff and SQL text at 2026-11-02T16:50:50-08:00 under coordinator 3099AC86-6AF0-4681-9944-304E930BFDC2. Astra/high requested, runtime model identity unobservable.

| Artifact | SHA-256 |
|---|---|
| v3 handoff | `f6ba25eb4480f99971cfd766ae69d188ae39ca1b0982d8a0cc19f067a9c15e2b` |
| v3 proposed SQL | `148d7e2063ef0da187cc7a73897ae78b3e034e976e1fb20817a61682de9691bf` |
| Pre-review status | `89a60e22e8eb0b5e3917d0e9dc40434b4ef5e6d28cba3628170faa42112116a7` |
| Original six-table handoff | `9ac0608d9e74baa32e65bf4385e528f894e806b624a2a81aba84834a38f16aa5` |
| Original six-table proposed SQL | `1b5a94893e8bad11a0b933d0abce1fce05197f1b014a0e80abe9371b9ba70abe` |

Both Downloads pairs and their repository copies are byte-identical. This separate verdict follows the pre-review status. The earlier drafts and their independent NO-GOs remain historical.

- Both prior P2 findings are closed within the stated source contract. Opaque external IDs are preserved exactly with deterministic C equality and a case-sensitive unique root index, while the namespace admits a stated lowercase ASCII grammar. The explicit Unicode escape lists in proposed SQL lines 21–22 and 45–46 represent Unicode White_Space and the storable C0/C1 control repertoire. The external ID rejects a control anywhere or whitespace at either edge. Provenance and reason must contain at least one character outside the combined set and remain limited to 2,000 actual stored characters. The checked lists cover tabs, CR/LF, NEL, NBSP and ideographic space U+3000. PostgreSQL text excludes NUL. Zero-width characters, provider-specific equivalences and cross-kind duplicates are expressly unresolved.
- The single private relation retains the original payment or external identity, org, lease and currency across an append-only revision chain, with one root per represented source within an org, one successor per prior and one amount per effective revision. The optional composite FK from a settlement source can reference an exact revision. Actual live payment status, source lease/currency match, independent exclusive use, latest-version authority and evidence access remain obligations of a future fixed gateway. No broader grant, financial mutation or cross-lease funds mechanism was added. The mixed-invoice example continues to distinguish invoice allocations from independent consumption.
- Target PG16/17 syntax/escape interpretation, collations and effective catalog/grants, old worker behavior, reset/replica allowlist, authorization, retention, backups and runtime concurrency need separately authorized verification. Test every declared character and both size limits under the actual target settings, including case-distinct keys and ordinary non-ASCII narrative. These checks, application gateways and source-consumption controls remain Codex work. PE owns later target/security validation and separately approved non-Mac application.

No SQL or parser was run, no database was contacted, and no product, deployment or B-011 acceptance is implied by this closed-design verdict.
