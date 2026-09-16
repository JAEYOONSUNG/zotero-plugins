# Style Custom 0.7.0: research reading desk

The workspace serves a researcher locating papers, reading evidence and acting on an explicit selection. A compact frame keeps search, current section and selection visible; the document list carries the visual identity through reading-status rails, restrained title typography and aligned citation/IF metadata. There is no decorative dashboard, remote imagery or downloaded font.

The frontend-design skill informed the critique. The supplied indigo direction was retained: the only prominent accents encode current navigation, keyboard focus, reading state and selection. Controls stay quieter than titles.

## Semantic color tokens

| Role | Token | Light | Dark |
|---|---|---|---|
| Canvas | `--sc-bg` | `#F5F7FC` | `#171E2F` |
| Surface | `--sc-surface` | `#FFFFFF` | `#222C42` |
| Secondary surface | `--sc-surface-alt` | `#EDF1F9` | `#29354E` |
| Main text | `--sc-text` | `#202D46` | `#E5ECF7` |
| Metadata | `--sc-muted` | `#56647B` | `#A9B7CF` |
| Active function/focus | `--sc-accent` | `#5654D8` | `#AAA4FF` |
| Active background | `--sc-accent-soft` | `#ECEBFF` | `#343456` |
| Explicit selection | `--sc-selection` | `#DFAC52` | `#F0BB62` |
| Reading rail | `--sc-reading` | `#98661D` | `#F0BB62` |
| Completed rail | `--sc-done` | `#28705C` | `#74CDB1` |

Main and muted text exceed 4.5:1 on canvas, surface and secondary surface in both themes. Representative measured ratios: light body 13.77:1; light metadata 5.59:1; light selected navigation 4.90:1; dark body 11.73:1; dark metadata 6.05:1; dark selected navigation 5.34:1. Error text exceeds 4.5:1; the focus accent exceeds 3:1 against the surface. These checks cover shipped tokens, not arbitrary user-selected override colors.

Canvas cards retain their user-selected outer color. Their text and controls use opaque neutral inner surfaces with dark ink, so even a black saved card remains readable under either theme. The reading heatmap uses a white backing surface and dark labels; the JavaScript-generated blue overlay now caps opacity at 0.60 in the actual workbench DOM generator; this preserves readable dark labels on the white backing.

## Type and spacing

- Body: 13px/1.5 system UI with Apple SD Gothic Neo fallback.
- Paper titles: 14px/1.5, weight 600, Avenir Next / Apple SD Gothic Neo.
- Section titles: 18px/1.4, weight 650, same restrained display stack.
- Metric strip: 11px/1.6 SFMono-Regular / Menlo / Consolas.
- Base spacing unit: 4px. Surface corners: 8–12px.
- Comfortable: 32px controls, 16px cards, 20px content padding, 164px navigation.
- Compact: 28px controls, 10px cards, 12px content padding, 148px navigation. Compact mode never removes commands.

## Layout and component coverage

The fixed, resizable panel establishes the named `sc-workbench` size container. Header, search, filters, context and selection footer form a stable frame; `.sc-body` and navigation own their scrolling. The selection footer changes emphasis only when `data-selected=true`. Selected paper cards gain a soft indigo surface and outline without replacing their reading-status rail. Busy buttons use a static inset progress accent and `cursor:progress`; no animation is required.

At container widths below 720px, grouped navigation becomes a horizontally scrollable row; below 440px, controls wrap and metadata occupies its own line. At container heights below 460px, frame spacing contracts and overflowing filters/footer scroll. A viewport-height fallback below 480px makes the whole panel scrollable, so short windows cannot strand controls outside the viewport. The viewport-width fallback supports engines without container queries.

All existing scientific views retain scoped rules: graph labels/edges/nodes, canvas connections and editable cards, sticky comparison-matrix headers, page heatmap, native attachment preview, AI result editor and nested tags. New grouped navigation, filter chips, paper hierarchy, command palette and explicit selection hooks are styled without removing any tab.

Hidden panels/dialogs use `[hidden] { display:none !important }`. Keyboard focus is explicit. Reduced-motion and forced-color preferences have dedicated adjustments. No unscoped selectors, remote assets or `@font-face` declarations are present.

## Verification and limits

Run `node --test zotero-style-custom/test/styles.test.mjs`.

CSSOM 0.5 cannot parse `@container` and was tested to confirm that limitation. The test validates each named width/height condition against the supported grammar, substitutes only the outer grouping keyword with `@media`, and parses the identical inner declarations/selectors. This checks stylesheet structure, selector isolation and component coverage; it does not claim native container-query execution or pixel-perfect rendering. The suite separately checks contrast arithmetic, density behavior, scroll escape, hidden states, focus and canvas readability.

No browser or Zotero instance was launched, no user interface was manipulated, and no user profile was changed. Root integration supplies the actual-DOM offline preview and verifies JavaScript-generated styles and controls.
