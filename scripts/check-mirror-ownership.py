#!/usr/bin/env python3
"""Validate the current claim.sh multiline status contract before mirroring."""
import re
import sys
from pathlib import Path


def owned(text: str, host: str, session: str) -> bool:
    if not host or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', session):
        return False
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines or not re.fullmatch(r'\[repo\] effective=ACTIVE observed_at=.+', lines[0]):
        return False
    fields = {}
    for line in lines[1:]:
        if '=' not in line:
            return False
        key, value = line.split('=', 1)
        if not re.fullmatch(r'[a-z_]+', key) or key in fields:
            return False
        fields[key] = value
    return (fields.get('resource') == 'repo' and fields.get('state') == 'ACTIVE'
            and fields.get('host') == host and fields.get('session_uuid') == session)


if __name__ == '__main__':
    if len(sys.argv) != 4 or not owned(Path(sys.argv[1]).read_text(), sys.argv[2], sys.argv[3]):
        print('mirror-github: Cannot verify active repo ownership by this host and session; inspect claim.sh status.', file=sys.stderr)
        sys.exit(1)
