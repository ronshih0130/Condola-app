#!/usr/bin/env bash
set -uo pipefail

# Validate existing build artifacts only. This script never deploys.
if (( $# > 1 )) || { (( $# == 1 )) && [[ -z $1 ]]; }; then
    printf 'Usage: %s [worktree]\n' "${0##*/}" >&2
    exit 2
fi

if (( $# == 1 )); then
    target=$1
else
    script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P) || {
        printf 'PREFLIGHT FAIL: cannot determine script directory\n' >&2
        exit 1
    }
    target=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) ||
        target=$script_dir/..
fi

sha=$(git -C "$target" rev-parse --short HEAD 2>/dev/null) || sha=unknown
printf '%s\n' "$sha"

failures=0
fail() {
    printf 'PREFLIGHT FAIL: %s\n' "$1"
    failures=$((failures + 1))
}

case $target in
    /*) absolute=$target ;;
    *)  absolute=$PWD/$target ;;
esac

# Inspect every component before performing lexical normalization.
prefix=
remaining=$absolute
while [[ -n $remaining ]]; do
    component=${remaining%%/*}
    if [[ $remaining == */* ]]; then
        remaining=${remaining#*/}
    else
        remaining=
    fi
    [[ -z $component ]] && continue
    prefix=$prefix/$component
    if [[ -L $prefix ]]; then
        fail "worktree path contains symlink: $prefix"
    fi
done

# Normalize dots and repeated slashes without resolving symlinks.
parts=()
remaining=$absolute
while [[ -n $remaining ]]; do
    component=${remaining%%/*}
    if [[ $remaining == */* ]]; then
        remaining=${remaining#*/}
    else
        remaining=
    fi
    case $component in
        ''|.) ;;
        ..)
            if (( ${#parts[@]} > 0 )); then
                unset 'parts[${#parts[@]}-1]'
            fi
            ;;
        *) parts+=("$component") ;;
    esac
done

wt=
if (( ${#parts[@]} > 0 )); then
    for component in "${parts[@]}"; do
        wt=$wt/$component
    done
fi
wt=${wt:-/}
base=${wt%/}
modules=$base/node_modules
handler=$base/.open-next/server-functions/default/handler.mjs
worker=$base/.open-next/worker.js

if [[ ! -d $wt ]]; then
    fail "worktree directory does not exist: $wt"
fi

if [[ -L $modules ]]; then
    fail "node_modules is a symlink: $modules"
elif [[ ! -d $modules ]]; then
    fail "node_modules is missing or is not a directory: $modules"
fi

for dependency in "$modules/next" "$modules/@opennextjs/cloudflare"; do
    if [[ -L $dependency ]]; then
        fail "dependency is a symlink: $dependency"
    fi
done

if [[ ! -f $handler ]]; then
    fail "handler.mjs is missing or is not a regular file: $handler"
elif [[ ! -r $handler ]]; then
    fail "handler.mjs is not readable: $handler"
else
    if grep -Fq -- 'getMiddlewareManifest(){return this.minimalMode?null:require(' "$handler"; then
        fail "handler.mjs is unpatched"
    fi

    if ! grep -Fq -- 'getMiddlewareManifest(){return null}' "$handler"; then
        fail "handler.mjs is missing the OpenNext middleware-manifest patch marker"
    fi

    # Scan quoted and unquoted absolute POSIX paths without assuming a
    # particular build-machine directory. Quoted paths may contain spaces.
    matches=$(LC_ALL=C awk '
        function emit_paths(text, allow_spaces, pattern, candidate, previous) {
            if (allow_spaces) {
                pattern = "/[^\"'\''`<>|]*node_modules"
            } else {
                pattern = "/[^[:space:]\"'\''`<>|(){}\\[\\],;:=]*node_modules"
            }

            while (match(text, pattern)) {
                candidate = substr(text, RSTART, RLENGTH)
                previous = RSTART > 1 ? substr(text, RSTART - 1, 1) : ""

                # Only absolute paths, rather than the slash in ./ or ../.
                if (previous != "." &&
                    candidate ~ /\/node_modules$/) {
                    print candidate
                }
                text = substr(text, RSTART + RLENGTH)
            }
        }

        {
            text = $0
            unquoted = ""
            quote = ""
            quoted = ""
            escaped = 0

            for (i = 1; i <= length(text); i++) {
                character = substr(text, i, 1)

                if (quote != "") {
                    if (escaped) {
                        quoted = quoted "\\" character
                        escaped = 0
                    } else if (character == "\\") {
                        escaped = 1
                    } else if (character == quote) {
                        emit_paths(quoted, 1)
                        quote = ""
                        quoted = ""
                        unquoted = unquoted " "
                    } else {
                        quoted = quoted character
                    }
                } else if (character == "\"" ||
                           character == "'\''" ||
                           character == "`") {
                    quote = character
                } else {
                    unquoted = unquoted character
                }
            }

            # Also inspect unterminated fragments, such as multiline strings.
            if (quote != "") {
                emit_paths(quoted, 1)
            }
            emit_paths(unquoted, 0)
        }
    ' "$handler" | LC_ALL=C sort -u)
    scan_status=$?

    if (( scan_status != 0 )); then
        fail "could not scan handler.mjs for absolute node_modules paths"
    elif [[ -n $matches ]]; then
        while IFS= read -r match; do
            if [[ $match != "$modules" ]]; then
                fail "handler.mjs references foreign node_modules: $match"
            fi
        done <<< "$matches"
    fi
fi

if [[ ! -f $worker ]]; then
    fail ".open-next/worker.js is missing or is not a regular file: $worker"
fi

if (( failures > 0 )); then
    exit 1
fi

printf 'PREFLIGHT PASS\n'
exit 0
