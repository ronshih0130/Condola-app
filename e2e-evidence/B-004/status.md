# B-004 paper delivery checkpoint

Updated: 2026-10-29T20:13:09.845466-07:00; branch mode-b-build; Ron/Codex.

New100204 scopes direct tenant PDF reads to organization/environment pins, preserving unpinned live compatibility. Current/history labels follow the authoritative lease document pointer with the existing fallback. A new guard denies direct ordinary-role version updates/deletions, allowing genuine parent cascades after checking parent disappearance. Existing upload code appends versions and remains compatible. Download audit commits before delivery; audit failure returns private503 without bytes or attachment header and logs only a fixed sanitized error. No contract wording changed.

Focused synthetic DB test1/1, download units6/6, type/lint PASS. Highest independent native static scope PASS on blobs in checks.json. No new feature activation: paper constantOFF; tenant app gate retains existing value while database global/org rollout stays controlled.

STOP POINT: local implementation prepared; next: actual protected-route browser/HTTP checks, combined candidate gate and staging; owner: Ron/Codex.
