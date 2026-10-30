#!/usr/bin/env python3
"""Build a QA evidence deletion plan. Never deletes or modifies evidence."""
import argparse
import datetime as dt
import fnmatch
import os
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

KIB = 1024
MIB = KIB ** 2
GB = 1000 ** 3
GIB = 1024 ** 3
SMALL = 256 * KIB
PT = ZoneInfo("America/Los_Angeles")
IN_FLIGHT = (
    "end-auth-sessions", "errors-redact", "id-photo-90d", "esign", "e-sign",
    "privacy-ai", "react-418", "backup-acl", "brand-v2",
)
REGENERABLE_BUNDLES = {
    "node_modules", ".next", ".open-next", ".wrangler", ".cache",
    "dist", "out", "coverage",
}
BUNDLES = REGENERABLE_BUNDLES | {"playwright-report", "test-results"}
RECENT_STATUS = "old, recently active — PE confirm"
TEXT_EXTENSIONS = {
    ".md", ".txt", ".sh", ".mjs", ".js", ".ts", ".sql", ".py", ".json",
    ".patch", ".mbox", ".diff", ".out", ".log", ".yaml", ".yml", ".csv",
}
DISPOSABLE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".webm", ".mp4", ".zip",
    ".har", ".tgz", ".tar", ".pack", ".wasm", ".node", ".map",
}
KEEP_PATTERNS = (
    "verdict*.md", "status.md", "issue.md", "issues.md", "classb-draft*.md",
    "prod-plan*.md", "approvals*.md", "qa-*.md", "hashes.txt", "*.sha256",
    "artifacts.json",
)
CODE_EXTENSIONS = {".patch", ".diff", ".mbox", ".sql", ".bundle"}
CODE_ARCHIVE_MARKERS = ("tree", "rebased", "src", "bundle", "stage-", "final")
GIT_BUNDLE_SIGNATURES = (b"# v2 git bundle\n", b"# v3 git bundle\n")


@dataclass
class Node:
    path: Path
    kind: str
    apparent: int
    allocated: int
    mtime: float
    children: list = field(default_factory=list)
    files: int = 0
    inodes: int = 1
    newest_file: float = float("-inf")
    complete: bool = True
    always_keep: bool = False
    code_artifact: bool = False


def iso_time(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError("ISO timestamps must include a UTC offset")
    return parsed


def absolute(value):
    # Do not resolve symlinks.
    return Path(os.path.abspath(os.path.expanduser(value)))


def md(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(
        ">", "&gt;"
    ).replace("|", "&#124;").replace("`", "&#96;").replace(
        "\r", "&#13;"
    ).replace("\n", "&#10;")


def code(value):
    return "`" + md(value) + "`"


def named_code_artifact(path):
    name = path.name.lower()
    if path.suffix.lower() in CODE_EXTENSIONS:
        return True
    for suffix in (".tar.gz", ".tgz", ".tar"):
        if name.endswith(suffix):
            basename = name[:-len(suffix)]
            return any(marker in basename for marker in CODE_ARCHIVE_MARKERS)
    return False


def is_git_bundle(path):
    """Read only the signature, without following a final-component symlink."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)
    fd = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("file changed type while checking git bundle signature")
        with os.fdopen(fd, "rb") as handle:
            fd = None
            return handle.read(16).startswith(GIT_BUNDLE_SIGNATURES)
    finally:
        if fd is not None:
            os.close(fd)


def keep_file(path, size):
    name = path.name.lower()
    if any(fnmatch.fnmatchcase(name, pattern) for pattern in KEEP_PATTERNS):
        return True
    extension = path.suffix.lower()
    in_modules = "node_modules" in path.parts
    return (
        size < SMALL
        and extension in TEXT_EXTENSIONS
        and not (extension == ".js" and in_modules)
    )


def record_error(errors, path, exc):
    errors.append(f"{path}: {exc}")


def check_directory_path(path):
    """Reject symlinks in every component of an input directory path."""
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        mode = os.lstat(current).st_mode
        if stat.S_ISLNK(mode):
            raise ValueError(f"input directory contains a symlink: {current}")
        if not stat.S_ISDIR(mode):
            raise ValueError(f"not a directory: {current}")


def scan(path, errors):
    try:
        info = os.lstat(path)
    except OSError as exc:
        record_error(errors, path, exc)
        return Node(path, "unknown", 0, 0, 0, complete=False)

    allocated = getattr(info, "st_blocks", 0) * 512
    if stat.S_ISDIR(info.st_mode):
        kind = "dir"
    elif stat.S_ISREG(info.st_mode):
        kind = "file"
    elif stat.S_ISLNK(info.st_mode):
        kind = "symlink"
    else:
        kind = "special"
    node = Node(path, kind, info.st_size, allocated, info.st_mtime)
    if kind != "dir":
        node.files = 1
        if kind == "file":
            node.newest_file = info.st_mtime
            node.code_artifact = named_code_artifact(path)
            if not node.code_artifact:
                try:
                    node.code_artifact = is_git_bundle(path)
                except OSError as exc:
                    record_error(errors, path, exc)
                    node.complete = False
                    node.always_keep = True
            node.always_keep = (
                node.always_keep
                or node.code_artifact
                or keep_file(path, info.st_size)
            )
        else:
            node.always_keep = True
        return node

    try:
        with os.scandir(path) as entries:
            paths = sorted((path / entry.name for entry in entries), key=str)
    except OSError as exc:
        record_error(errors, path, exc)
        node.complete = False
        return node

    for child_path in paths:
        child = scan(child_path, errors)
        node.children.append(child)
        node.apparent += child.apparent
        node.allocated += child.allocated
        node.files += child.files
        node.inodes += child.inodes
        node.newest_file = max(node.newest_file, child.newest_file)
        node.complete = node.complete and child.complete
        node.always_keep = node.always_keep or child.always_keep
        node.code_artifact = node.code_artifact or child.code_artifact
    return node


def code_artifacts(node):
    if node.kind == "file" and node.code_artifact:
        yield node
    for child in node.children:
        yield from code_artifacts(child)


def latest_runs(lane):
    protected = set()

    def newest(nodes):
        if nodes:
            winner = max(
                nodes,
                key=lambda n: (
                    n.newest_file if n.newest_file != float("-inf") else n.mtime,
                    str(n.path),
                ),
            )
            protected.add(winner.path)

    direct = [n for n in lane.children if n.kind == "dir"]
    newest(direct)
    for parent in direct:
        newest([
            n for n in parent.children
            if n.kind == "dir" and n.path.name.lower().startswith("run-")
        ])
    return protected


def sort_items(items):
    return sorted(items, key=lambda item: (-item[0].apparent, str(item[0].path)))


def plan_lane(lane, protected):
    planned = []

    def intersects_protected(path):
        return any(path == p or path in p.parents for p in protected)

    def visit(node):
        if node.path in protected:
            return
        if node.kind == "dir":
            if (
                node.path.name in BUNDLES
                and node.complete
                and not node.always_keep
                and not node.code_artifact
                and not intersects_protected(node.path)
            ):
                planned.append((node, "dir-bundle"))
                return
            for child in node.children:
                visit(child)
        elif node.kind == "file" and not node.always_keep and not node.code_artifact:
            name = node.path.name.lower()
            if (
                node.apparent >= SMALL
                or node.path.suffix.lower() in DISPOSABLE_EXTENSIONS
                or name.endswith(".tar.gz")
            ):
                planned.append((node, "file"))

    for child in lane.children:
        visit(child)
    return sort_items(planned)


def optional_lane(lane, protected):
    optional = []

    def visit(node, inside=False):
        # A protected directory itself stays; only its descendants qualify.
        if node.kind != "dir":
            return
        if (
            inside
            and node.path.name in REGENERABLE_BUNDLES
            and node.complete
            and not node.always_keep
            and not node.code_artifact
            and not any(
                node.path == p or node.path in p.parents for p in protected
            )
        ):
            optional.append((node, "dir-bundle"))
            return
        inside = inside or node.path in protected
        for child in node.children:
            visit(child, inside)

    for child in lane.children:
        visit(child)
    return sort_items(optional)


def item_total(items, attribute="apparent"):
    return sum(getattr(node, attribute) for node, _ in items)


def loose_total(root, errors):
    apparent = allocated = count = 0
    try:
        check_directory_path(root)
        with os.scandir(root) as entries:
            for entry in entries:
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode):
                        continue
                    apparent += info.st_size
                    allocated += getattr(info, "st_blocks", 0) * 512
                    count += 1
                except OSError as exc:
                    record_error(errors, root / entry.name, exc)
    except (OSError, ValueError) as exc:
        record_error(errors, root, exc)
    return apparent, allocated, count


def validate_output(path):
    check_directory_path(path.parent)
    if os.path.lexists(path):
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"output must be a regular file, not a symlink: {path}")
        if info.st_nlink > 1:
            raise ValueError(f"refusing to overwrite a hard-linked output: {path}")


def write_output(path, content):
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    flags |= getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o666)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default="/workspace/e2e/results")
    parser.add_argument("--extra-root", action="append", default=[])
    parser.add_argument("--out", required=True, help="Markdown report file")
    parser.add_argument("--now-iso", type=iso_time)
    parser.add_argument(
        "--active-since", type=iso_time,
        default=iso_time("2026-10-26T00:00:00-07:00"),
    )
    parser.add_argument(
        "--inflight", metavar="NAME", action="append", default=[],
        help="Additional exact in-flight lane name, case-insensitive; repeatable",
    )
    parser.add_argument(
        "--emit-list",
        help="Optional explicitly authorized output: absolute planned paths, one per line",
    )
    parser.add_argument(
        "--emit-list-optional", metavar="PATH",
        help="Optional tier B paths, one absolute path per line; separate approval required",
    )
    args = parser.parse_args()
    root = absolute(args.root)
    out = absolute(args.out)
    emit = absolute(args.emit_list) if args.emit_list else None
    emit_optional = (
        absolute(args.emit_list_optional) if args.emit_list_optional else None
    )
    outputs = [out] + [p for p in (emit, emit_optional) if p is not None]
    errors = []

    try:
        check_directory_path(root)
        for index, destination in enumerate(outputs):
            validate_output(destination)
            for previous in outputs[:index]:
                if destination == previous or (
                    destination.exists()
                    and previous.exists()
                    and os.path.samefile(destination, previous)
                ):
                    raise ValueError("all output files must be distinct")
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    inflight_names = {name.casefold() for name in IN_FLIGHT}
    inflight_names.update(name.casefold() for name in args.inflight)
    tree = scan(root, errors)
    artifacts = sorted(
        code_artifacts(tree), key=lambda n: (-n.apparent, str(n.path))
    )
    rows = []
    for lane in (n for n in tree.children if n.kind == "dir"):
        protected = latest_runs(lane)
        name = lane.path.name.casefold()
        if name in inflight_names or "backup" in name or "restore" in name:
            status = "in-flight"
        elif lane.newest_file >= args.active_since.timestamp():
            status = RECENT_STATUS
        else:
            status = "old"
        eligible = status != "in-flight" and lane.complete
        planned = plan_lane(lane, protected) if eligible else []
        optional = optional_lane(lane, protected) if eligible else []
        rows.append((lane, status, protected, planned, optional))

    rows.sort(key=lambda r: (-item_total(r[3]), r[0].path.name))
    all_planned = [item for row in rows for item in row[3]]
    all_optional = [item for row in rows for item in row[4]]
    safe = [item for row in rows if row[1] == "old" for item in row[3]]
    recent = [
        item for row in rows if row[1] == RECENT_STATUS for item in row[3]
    ]
    planned_bytes = item_total(all_planned)
    planned_disk = item_total(all_planned, "allocated")
    optional_bytes = item_total(all_optional)
    optional_disk = item_total(all_optional, "allocated")
    planned_files = item_total(all_planned, "files")
    planned_inodes = item_total(all_planned, "inodes")
    bundles = sum(kind == "dir-bundle" for _, kind in all_planned)
    individual = len(all_planned) - bundles

    for node, _ in all_planned + all_optional:
        for destination in outputs:
            if destination == node.path or node.path in destination.parents:
                parser.error(f"output falls inside a deletion candidate: {destination}")
    for destination, items in ((emit, all_planned), (emit_optional, all_optional)):
        if destination and any(
            "\n" in str(n.path) or "\r" in str(n.path) for n, _ in items
        ):
            parser.error("cannot emit a line-based list containing newline characters in paths")

    generated = (args.now_iso or dt.datetime.now(PT)).astimezone(PT)
    lines = [
        "# QA evidence deletion plan",
        "",
        f"Generated: {generated.isoformat(timespec='seconds')} PT (America/Los_Angeles)",
        f"Root: {code(root)}",
        "",
        "**PLAN ONLY — nothing deleted**",
        "",
        "- Keep in-flight lanes: exact case-insensitive configured names, plus names containing backup or restore.",
        "- Include candidates in recently active lanes in the main plan, flagged for PE confirmation.",
        "- ALWAYS KEEP code artifacts (keep until Origin push is verified): .patch, .diff, .mbox, .sql, .bundle, any git bundle, and .tgz/.tar/.tar.gz archives whose basename contains tree, rebased, src, bundle, stage-, or final, at any size.",
        "- Never plan a dir-bundle containing code artifacts; descend and consider its other contents.",
        "- Keep named records and text-like files under 256 KiB; .js inside node_modules is excluded from the small-text rule.",
        "- Keep the newest direct subdirectory per lane and newest nested run-* per parent in the main plan.",
        "- Report eligible regenerable build bundles inside kept latest runs only as optional tier B, requiring separate approval.",
        "- Plan disposable bundles, media/archive/build files, and other files ≥256 KiB only outside protected content.",
        "- Never follow symlinks; preserve unreadable lanes. Sizes include directory metadata; hard links are counted per path.",
        "",
        f"Recent activity cutoff: {code(args.active_since.isoformat())}. "
        "MB means MiB (1,048,576 bytes); GB means 1,000,000,000 bytes; "
        "GiB means 1,073,741,824 bytes (1024^3). "
        "On-disk sizes use st_blocks × 512. Totals are observed sizes where access failed.",
        "",
        "| Metric | Apparent GB | Apparent GiB | On-disk GB | On-disk GiB | Count |",
        "|---|---:|---:|---:|---:|---:|",
        f"| Total root | {tree.apparent / GB:.2f} | {tree.apparent / GIB:.2f} | {tree.allocated / GB:.2f} | {tree.allocated / GIB:.2f} | — |",
        f"| Planned deletion | {planned_bytes / GB:.2f} | {planned_bytes / GIB:.2f} | {planned_disk / GB:.2f} | {planned_disk / GIB:.2f} | {len(all_planned)} items |",
        f"| planned in lanes inactive since cutoff (safe) | {item_total(safe) / GB:.2f} | {item_total(safe) / GIB:.2f} | {item_total(safe, 'allocated') / GB:.2f} | {item_total(safe, 'allocated') / GIB:.2f} | {len(safe)} items |",
        f"| planned in recently-active lanes (needs PE confirm) | {item_total(recent) / GB:.2f} | {item_total(recent) / GIB:.2f} | {item_total(recent, 'allocated') / GB:.2f} | {item_total(recent, 'allocated') / GIB:.2f} | {len(recent)} items |",
        f"| Optional tier B (separate approval) | {optional_bytes / GB:.2f} | {optional_bytes / GIB:.2f} | {optional_disk / GB:.2f} | {optional_disk / GIB:.2f} | {len(all_optional)} dir-bundles |",
        f"| kept after plan (+ after optional B) | {(tree.apparent - planned_bytes) / GB:.2f} (+ {(tree.apparent - planned_bytes - optional_bytes) / GB:.2f}) | {(tree.apparent - planned_bytes) / GIB:.2f} (+ {(tree.apparent - planned_bytes - optional_bytes) / GIB:.2f}) | {(tree.allocated - planned_disk) / GB:.2f} (+ {(tree.allocated - planned_disk - optional_disk) / GB:.2f}) | {(tree.allocated - planned_disk) / GIB:.2f} (+ {(tree.allocated - planned_disk - optional_disk) / GIB:.2f}) | — |",
        f"| Planned files / dir-bundles | — | — | — | — | {individual} / {bundles} |",
        f"| Files inside planned items | — | — | — | — | {planned_files} |",
        f"| Inode entries potentially reclaimed, including directories | — | — | — | — | {planned_inodes} |",
        "",
        "Safe and PE-confirm subtotals partition the main plan. Optional tier B "
        "is excluded from the main plan. Parenthesized kept values show the "
        "remaining size if optional tier B is also approved.",
        "",
        "Hard-linked files may retain their inode and blocks through other links; "
        "allocated totals are not a guarantee of freed space. Root-level loose files are kept.",
        "",
        "## Code artifacts kept (total MB, count, top 10 paths)",
        "",
        "Code artifacts (keep until Origin push is verified).",
        "",
        "tarball-only changes may exist (INVENTORY.md); revisit after the Origin push",
        "",
        f"Total: {sum(n.apparent for n in artifacts) / MIB:.2f} MB apparent; "
        f"{len(artifacts)} files.",
        "",
    ]
    if artifacts:
        lines += ["| Relative path | MB |", "|---|---:|"]
        lines += [
            f"| {code(n.path.relative_to(root))} | {n.apparent / MIB:.2f} |"
            for n in artifacts[:10]
        ]
    else:
        lines.append("None.")
    lines += [
        "",
        "## Lanes",
        "",
        "| Lane | Status | Lane MB | Planned MB | Optional B MB | Kept latest run | Top 3 planned paths with MB |",
        "|---|---|---:|---:|---:|---|---|",
    ]
    hidden = []
    for lane, status, protected, planned, optional in rows:
        if max(item_total(planned), item_total(optional)) <= 0.5 * MIB:
            hidden.append((lane, status, protected, planned, optional))
            continue
        latest = "<br>".join(code(p.relative_to(root)) for p in sorted(protected)) or "—"
        top = "<br>".join(
            f"{code(n.path.relative_to(root))} ({n.apparent / MIB:.2f})"
            for n, _ in planned[:3]
        ) or "—"
        lines.append(
            f"| {md(lane.path.name)} | {status} | {lane.apparent / MIB:.2f} | "
            f"{item_total(planned) / MIB:.2f} | {item_total(optional) / MIB:.2f} | "
            f"{latest} | {top} |"
        )
    lines.append(
        f"| Remaining {len(hidden)} lanes | Each planned and optional ≤0.5 MB | "
        f"{sum(r[0].apparent for r in hidden) / MIB:.2f} | "
        f"{sum(item_total(r[3]) for r in hidden) / MIB:.2f} | "
        f"{sum(item_total(r[4]) for r in hidden) / MIB:.2f} | — | — |"
    )

    for heading, wanted in (
        ("Kept in-flight lanes", "in-flight"),
        ("Recently active, candidates planned, please confirm", RECENT_STATUS),
    ):
        lines += ["", f"## {heading}", ""]
        selected = [r for r in rows if r[1] == wanted]
        lines += [
            f"- {code(r[0].path.name)}: {r[0].apparent / MIB:.2f} MB apparent, "
            f"{r[0].allocated / MIB:.2f} MB on-disk; "
            f"{item_total(r[3]) / MIB:.2f} MB planned."
            for r in selected
        ] or ["None."]

    lines += [
        "",
        "## Why each recently-active lane is listed as PE confirm",
        "",
        "Each lane below has a newest regular-file mtime at or after the "
        "recent activity cutoff.",
        "",
    ]
    lines += [
        f"- {code(lane.path.name)}: newest mtime "
        f"{dt.datetime.fromtimestamp(lane.newest_file, PT).isoformat(timespec='microseconds')} "
        "PT (America/Los_Angeles)."
        for lane, status, _, _, _ in rows
        if status == RECENT_STATUS
    ] or ["None."]

    lines += ["", "## Planned deletion entries", "",
              "Entries below 1 MiB are summarized per lane. "
              "Dir-bundles include their descendants and appear once."]
    for lane, _, _, planned, _ in rows:
        if not planned:
            continue
        lines += ["", f"### {md(lane.path.name)}", "",
                  "| Relative path | Type | MB |", "|---|---|---:|"]
        smaller = []
        for node, kind in planned:
            if node.apparent < MIB:
                smaller.append(node)
            else:
                lines.append(
                    f"| {code(node.path.relative_to(root))} | {kind} | {node.apparent / MIB:.2f} |"
                )
        lines += ["", f"{len(smaller)} smaller items, "
                  f"{sum(n.apparent for n in smaller) / MIB:.2f} MB."]
    if not all_planned:
        lines += ["", "None."]

    lines += [
        "",
        "## Optional tier B (regenerable build output inside kept latest runs, needs separate approval)",
        "",
        f"Total: {optional_bytes / GB:.2f} GB ({optional_bytes / GIB:.2f} GiB) apparent, "
        f"{optional_disk / GB:.2f} GB ({optional_disk / GIB:.2f} GiB) on-disk; "
        f"{len(all_optional)} dir-bundles. Excluded from the main plan.",
    ]
    for lane, _, _, _, optional in rows:
        if not optional:
            continue
        lines += [
            "", f"### {md(lane.path.name)}", "",
            f"{item_total(optional) / GB:.2f} GB "
            f"({item_total(optional) / GIB:.2f} GiB) apparent, "
            f"{item_total(optional, 'allocated') / GB:.2f} GB "
            f"({item_total(optional, 'allocated') / GIB:.2f} GiB) on-disk.",
            "",
            "| Relative path | Type | MB |",
            "|---|---|---:|",
        ]
        for node, kind in optional:
            lines.append(
                f"| {code(node.path.relative_to(root))} | {kind} | {node.apparent / MIB:.2f} |"
            )
    if not all_optional:
        lines += ["", "None."]

    lines += ["", "## Extra roots", ""]
    if args.extra_root:
        for value in args.extra_root:
            extra = absolute(value)
            apparent, disk, count = loose_total(extra, errors)
            lines.append(
                f"- {code(extra)}: loose files only, {count} entries, "
                f"{apparent / MIB:.2f} MB apparent, {disk / MIB:.2f} MB on-disk; "
                "not in plan. Symlinks count only their own metadata size."
            )
    else:
        lines.append("None supplied.")

    lines += ["", "## Access errors and incomplete scans", ""]
    lines += [f"- {code(error)}" for error in errors] or ["None."]
    incomplete = [r[0].path for r in rows if not r[0].complete]
    if incomplete:
        lines += ["", "These lanes were kept entirely because their scans were incomplete:"]
        lines += [f"- {code(p)}" for p in incomplete]

    lines += [
        "",
        "## How to execute later (after Ron/CEO approval)",
        "",
        "Regenerate this plan immediately before execution using the same roots, "
        "in-flight names, and activity cutoff. Use this script's "
        "`--emit-list <path>` option to write every main-plan item, including "
        "smaller items, as one absolute path per line. Recently active lanes "
        "require PE confirmation. Use `--emit-list-optional <path>` for the "
        "separate optional tier B list, which requires separate approval. "
        "These explicitly requested list files are the only permitted writes "
        "besides `--out`.",
        "",
        "Review the regenerated report and the complete list files, obtain Ron/CEO "
        "approval and any required PE confirmation or separate tier B approval, "
        "and delete exactly the approved listed paths using "
        "`rm -rf -- <path>`. Quote each path literally; do not use globs, eval, "
        "or unquoted shell expansion. Verify that the evidence has not changed "
        "between review and execution.",
        "",
        "The script performs no deletion. Scanning is not an atomic snapshot.",
    ]
    if emit:
        lines += ["", f"Complete planned-path list: {code(emit)}."]
    if emit_optional:
        lines += ["", f"Separate optional tier B path list: {code(emit_optional)}."]
    try:
        write_output(out, "\n".join(lines) + "\n")
        if emit:
            write_output(emit, "".join(str(n.path) + "\n" for n, _ in all_planned))
        if emit_optional:
            write_output(
                emit_optional,
                "".join(str(n.path) + "\n" for n, _ in all_optional),
            )
    except OSError as exc:
        print(f"Output error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
