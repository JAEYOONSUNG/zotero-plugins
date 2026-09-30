# User workflow preference

The user explicitly requested background-only work and objected to repeated windows on 2026-09-13.

- Do not open Run JavaScript, installer, preferences, or other user-facing windows for routine agent work, and do not take focus or type into the user's live apps.
- Use background code changes, tests, logs, artifact checks and read-only saved-data inspection. Do not launch extra app instances if they can disturb the user's screen.
- Report built, installed and runtime-verified states accurately; a successful build alone does not establish installation.
- A later explicit user request for a particular UI interaction supersedes this workflow preference for that interaction.

# Visual preference (2026-10-01, supersedes 2026-09-15)

The user asked for a premium look like a modern SaaS dashboard (reference: a Permitly screenshot): light grey canvas, white cards with large soft radii, generous spacing, the active navigation item as a solid dark pill with its count, counts as small rounded badges, items grouped in soft rounded containers with a "Name · n" header, one sparing accent colour for positive status and one for attention, outline icons, clear type hierarchy.

Still never: a coloured bar along the edge of a rounded row or card (it reads as a painted fingernail), sparkle/nail icons, dotted backgrounds, purple/gold chrome or display fonts. Keep text at 4.5:1 contrast and at least 11px. Preserve meaningful ratings, reading progress, user tags and annotation colors; do not delete library data or functional indicators as decoration.

The earlier 2026-09-15 rule ("plain and neutral, small corners, no pills") is replaced by the above.
