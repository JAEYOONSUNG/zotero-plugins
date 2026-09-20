# Working in this worktree

@zotero-style-custom/AGENTS.md

Two rules the user has had to repeat. They apply to every session in this
worktree, including parallel ones.

- **Never open Zotero's Run JavaScript window** (도구 → 개발자 → Run JavaScript),
  and never drive Zotero with AppleScript, `osascript`, `orca computer` or any
  other tool that activates the app, clicks its menus or types into it. The
  user works in Zotero while agents run. The only sanctioned way to execute
  code inside Zotero is the plugin's own self-check (`src/selfcheck.js`, run
  by setting `extensions.style-custom.selfCheck` in prefs.js with Zotero
  stopped), which writes a JSON report and opens nothing.
- **Never put a window on the user's screen.** An install relaunches Zotero:
  do it with `open -gj -a Zotero` (background and hidden), batch installs
  rather than reinstalling after every change, and make sure nothing the
  self-check presses opens a window (`data-opens` on such buttons; a test
  enforces it).
