#!/bin/sh
# Install the Claude Code skill for this checkout: substitutes the repo path
# into the skill template and copies it to ~/.claude/skills/whatsapp/.
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills/whatsapp"
mkdir -p "$DEST"
if [ -f "$DEST/SKILL.md" ]; then
  cp "$DEST/SKILL.md" "$DEST/SKILL.md.bak"
  echo "backed up existing skill to $DEST/SKILL.md.bak"
fi
sed "s|{{WA_DIR}}|$DIR|g" "$DIR/skills/whatsapp/SKILL.md" > "$DEST/SKILL.md"
echo "installed: $DEST/SKILL.md (wa at $DIR/bin/wa)"
