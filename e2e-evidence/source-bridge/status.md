# Source-history bridge

Timestamp 2026-10-29T17:39:04.172619-07:00.
First parent: 79c33538d492c75326af82fa7593b18d343a600e; second parent: c011e91b051ca464f815b82bc0715ec54b0a3a69. Histories have no common ancestor. The second parent is a user-supplied current-production **source reference**, not live deployment verification. Both histories and all seven recovered refs are preserved. Main remains unchanged.

Application tree comes from supplied c011e91. Operating files come from the explicit bootstrap allowlist; no path collision with supplied tree. Existing legal documents remain bit-for-bit from supplied source; no new legal text authored. All32 shared migrations retain exact old Origin bytes;39 additional migrations retain exact supplied bytes.12 source differences are only a prepended Version comment, independently confirmed; hashes and choice are in migrations.json. No runtime staging/prod migration state is claimed.

Both files sharing20261025140000 are retained by full filename. No historical SQL rewrite or fabricated migration ledger. Shared staging schema changes are not performed.

Trial progress and import diagnostics will be replayed narrowly in child commits, preserving supplied consent gates and expanded package/test lists. Their old-candidate evidence does not transfer as a gate PASS here. Payee lane is separate and will be reconciled after B001. All tests/browser/build/staging acceptance for this combined tree remain pending.

## Expanded local80-file compatibility check 2026-10-29T20:56:47.406187-07:00

Fresh80 and the supported upgrade from the untouched old32+39 baseline plus9 additions have equal public/app logical catalogs across11categories: columns, constraints, indexes, functions/owners/ACLs, relations/RLS/ACLs, policies, triggers, enums, views, schema privileges and default privileges. Provider auth schema, physical column order, sequence counters and cluster-global role state are excluded. Synthetic counts2org/4property/5lease/1payment preserved.

The first expanded comparison failed on the ID refresh trigger: earlier named upgrade_pristine fixture had been altered by a historical test replay, which the earlier5-category comparison did not include. That failure is preserved in core80-catalog-comparison.json; it is not waived as product compatibility. Rebuilding from the untouched71-file baseline preserved the moved_out_on trigger and passed all11categories (core80-clean-upgrade-comparison.json). New historical tests use separate owned clones and do not mutate these fresh templates.
