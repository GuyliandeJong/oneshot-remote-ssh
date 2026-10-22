#!/usr/bin/env bash
# Installs OneShot Remote SSH into VSCodium and/or Code - OSS on Linux/macOS.
#
#   1. downloads the latest release VSIX (or uses the path you pass)
#   2. removes conflicting SSH extensions that claim the same
#      "ssh-remote" connections (jeanp413.open-remote-ssh,
#      ms-vscode-remote.remote-ssh)
#   3. adds the extension to "enable-proposed-api" in ~/.vscode-oss/argv.json
#      (required: it uses the proposed "resolvers" API)
#
# Usage:
#   ./install.sh [path/to/oneshot-remote-ssh.vsix] [--keep-others]
#
# Close the editor before running; argv.json is read at startup.

set -euo pipefail

EXT_ID="guyliandejong.oneshot-remote-ssh"
VSIX_URL="https://github.com/GuyliandeJong/oneshot-remote-ssh/releases/latest/download/oneshot-remote-ssh.vsix"
CONFLICTS=(jeanp413.open-remote-ssh ms-vscode-remote.remote-ssh)
ARGV="$HOME/.vscode-oss/argv.json"

VSIX="" KEEP_OTHERS=0
for arg in "$@"; do
    case "$arg" in
        --keep-others) KEEP_OTHERS=1 ;;
        -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
        -*) echo "unknown option: $arg" >&2; exit 2 ;;
        *) VSIX="$arg" ;;
    esac
done

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }

editors=()
for cli in codium code; do
    command -v "$cli" >/dev/null && editors+=("$cli")
done
(( ${#editors[@]} )) || { echo "Neither codium nor code found on PATH" >&2; exit 1; }
if [[ " ${editors[*]} " == *" code "* ]] && pacman -Q visual-studio-code-bin >/dev/null 2>&1; then
    warn "'code' is Microsoft VS Code (visual-studio-code-bin); this extension is for VSCodium / Code - OSS"
fi

tmp=""
cleanup() { [[ -n "$tmp" ]] && rm -rf "$tmp"; }
trap cleanup EXIT
if [[ -z "$VSIX" ]]; then
    tmp="$(mktemp -d)"
    VSIX="$tmp/oneshot-remote-ssh.vsix"
    step "Downloading latest release"
    curl -fL --retry 3 -o "$VSIX" "$VSIX_URL"
fi
[[ -f "$VSIX" ]] || { echo "VSIX not found: $VSIX" >&2; exit 1; }

for cli in "${editors[@]}"; do
    step "Installing into $cli"
    if [[ $KEEP_OTHERS -eq 0 ]]; then
        installed="$("$cli" --list-extensions 2>/dev/null || true)"
        for c in "${CONFLICTS[@]}"; do
            if grep -qix "$c" <<<"$installed"; then
                "$cli" --uninstall-extension "$c" >/dev/null 2>&1 && echo "    removed conflicting $c"
            fi
        done
    fi
    "$cli" --install-extension "$VSIX" --force >/dev/null 2>&1 && echo "    installed $EXT_ID"
done

step "Enabling proposed API in $ARGV"
mkdir -p "$(dirname "$ARGV")"
[[ -s "$ARGV" ]] || echo '{}' > "$ARGV"
if grep -q "$EXT_ID" "$ARGV"; then
    echo "    already enabled"
else
    cp "$ARGV" "$ARGV.bak-$(date +%Y%m%d-%H%M%S)"
    command -v python3 >/dev/null || { echo "python3 is required to edit argv.json; add \"enable-proposed-api\": [\"$EXT_ID\"] by hand" >&2; exit 1; }
    python3 -I - "$ARGV" "$EXT_ID" <<'PY'
import sys
path, ext = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()

def scan(text):
    """Yield (index, char) for significant chars, skipping strings and comments.
    Strings are yielded as a single '"' at their closing quote."""
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            yield j, '"', text[i:j + 1]
            i = j + 1
            continue
        if text.startswith("//", i):
            j = text.find("\n", i); i = n if j < 0 else j; continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if not c.isspace():
            yield i, c, c
        i += 1

tokens = list(scan(text))
# Existing "enable-proposed-api": [ ... ] -> insert as first element.
for k, (idx, c, tok) in enumerate(tokens):
    if tok == '"enable-proposed-api"' and k + 2 < len(tokens) and tokens[k + 1][1] == ":" and tokens[k + 2][1] == "[":
        open_idx = tokens[k + 2][0]
        empty = k + 3 < len(tokens) and tokens[k + 3][1] == "]"
        insert = f'"{ext}"' if empty else f'"{ext}", '
        text = text[:open_idx + 1] + insert + text[open_idx + 1:]
        break
else:
    depth, close, last = 0, -1, -1
    for idx, c, tok in tokens:
        if c in "{[": depth += 1
        elif c in "}]":
            depth -= 1
            if depth == 0 and c == "}":
                close = idx; break
        last = idx
    if close < 0:
        sys.exit(f"{path}: no closing brace found")
    entry = f'\n\t"enable-proposed-api": ["{ext}"]\n'
    if text[last] in "{,":
        text = text[:close].rstrip() + entry + text[close:]
    else:
        text = text[:last + 1] + "," + text[last + 1:close].rstrip() + entry + text[close:]
open(path, "w", encoding="utf-8").write(text)
PY
    echo "    added $EXT_ID"
fi

step "Done"
echo "    Restart the editor completely, then connect with 'OneShot SSH: Connect to Host...'."
echo "    For one MFA prompt per connection set, per host:"
echo '      "remote.SSH.remotePlatform": { "<host>": "linux" },'
echo '      "remote.SSH.remoteArch":     { "<host>": "x86_64" }'
