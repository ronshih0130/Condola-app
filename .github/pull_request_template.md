## Summary
<!-- What changes and why, in one to three lines. -->

## Story / AC
<!-- Story ID and the acceptance criteria this PR covers, or n/a. -->

## File ownership & merge order (RULES 7)
<!-- Files this PR shares with another open PR, and which one merges first. Write "No overlap" if none. -->

## Spec-Change (R2)
<!-- Only when this PR changes an existing test assertion: add a line that starts with Spec-Change: followed by the hub spec path or commit. Otherwise delete this section. -->

## Verification
<!-- Required: scripts/check-pr-rules.mjs R4 fails the PR without it.
Exact commands, each in a fenced block with "$ " before the command and its pasted output under it. Placeholders do not count.
1. npm run gate:pr -- --pr-body-file <this body> goes first. gate:pr checks this section, so draft it with your other runs, run gate:pr against the draft, then paste its output here.
2. Bug fixes (a fix: title, a Fix: line, or a Red-On-Base line): add a line that reads Red-On-Base: PASS and paste the run of node scripts/red-on-base.mjs --test <regression test> --expect '<text only the failure prints>' (--expect is required for a PASS). Its last line must read RED-ON-BASE: PASS.
An INCONCLUSIVE verdict anywhere in this section fails the check; it is not a PASS. -->

```
$ npm run gate:pr -- --pr-body-file <path>
<paste output>
```

## Review
- Author family:
- Reviewer:
- Verdict:
