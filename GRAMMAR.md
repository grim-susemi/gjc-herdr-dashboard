# GRAMMAR

The shared pane grammar of the GJC Herdr dashboard. The Todo and Workers panes follow it so they read the same way as the omo-herdr-dashboard panes at commit `3242ad4`. Each rule gives the GJC string shape, its ANSI codes and the OMO source line it mirrors. OMO paths are relative to that repository and are read with `git show 3242ad4:<path>`. Where GJC keeps a different behaviour, the reason is a named GJC contract and it is listed under Deviations.

Colour codes used below are the GJC `red-claw` theme as 24-bit SGR bodies, usable directly as `\x1b[<body>m`: claw `38;2;255;106;61` (accent, live, in progress), coral `38;2;255;138;101` (badge, phase), kelp `38;2;110;231;183` (success, completed), dangerRed `38;2;255;77;94` (error, failed), sand `38;2;255;215;168` (time), warningAmber `38;2;245;184;75` (warning, offline, paused), mutedShell `38;2;185;143;134` (secondary text, pending Todo work), dimShell `38;2;111;71;67` (dividers, dim), seafoam `38;2;125;211;199` (info, model id). A `1;` prefix is bold, a `2;` prefix is dim, a `9;` prefix is strikethrough, and `0` resets. Both panes take their ink from this one table.

## G1. Header row

Row 0 of both panes: ` Name [done/total]  summary`, inset one column when the pane is wider than one column.

- Todo: ` Todo [closed/total]  done:n · drop:n`. `Todo` is bold in the connection colour (`1;` claw for live, waiting or empty, `1;` warningAmber offline or last known, `1;` dangerRed on source error), the tally is a bold coral badge (`1;38;2;255;138;101`), the summary is mutedShell. When the whole row doesn't fit, only the name and tally are kept, fitted to the room. Mirrors OMO `packages/todo/src/render.mjs:202` (name colour) and `:205-212` (header row), re-inked in the GJC palette.
- Workers: ` Workers [done/total]  run N · failed N · aborted N · paused N · done N ▸`. `Workers` is bold claw `1;38;2;255;106;61` in every state, the tally bold sand `1;38;2;255;215;168`, the summary dimShell `38;2;111;71;67`, fitted with `…`. `run N` is always shown, even at 0; other zero counts are left out. When the full summary does not fit, secondary tallies are dropped before the fold segment, in the order paused, aborted, failed, so `done N ▸/▾` survives as long as it fits; only then does the ordinary `…` fitting apply. At 34 columns a mixed `run 1 · failed 1 · done 1 ▸` header therefore reads `run 1 · done 1 ▸`, and at 24 columns it clips like OMO (`run 1 …`). Mirrors OMO `packages/dag/src/render.mjs:549-553` (headLine) and `:557-558` (the running count is always present).

## G2. Header divider

Row 1 of both panes is a full-width `─` divider directly under the header row. Each pane keeps the code of the OMO pane it mirrors:

- Todo: painted dimShell `38;2;111;71;67`. Mirrors OMO `packages/todo/src/render.mjs:207` (`paint('─'.repeat(columns), 'muted', color)`), re-inked in the GJC palette.
- Workers: painted dimShell `38;2;111;71;67`, the pane's `dim` token. Mirrors OMO `packages/dag/src/render.mjs:558` (`separator` after headLine, painted with the pane's `dim`), re-inked in the GJC palette.

## G3. Footer

The last two rows of both panes: the pane's own divider (dimShell on each pane, as in G2), then the footer ` Follow ON · <connection>` or ` Follow OFF · <connection>`. The colour depends on the connection only, never on the follow word, and each pane has its own rule:

- Workers: claw `38;2;255;106;61` for LIVE and EMPTY, sand `38;2;255;215;168` for WAITING, OFFLINE and SOURCE ERROR (GJC `src/viewers/workers/render.mjs`).
- Todo: claw `38;2;255;106;61` for LIVE and EMPTY, warningAmber `38;2;245;184;75` for WAITING, OFFLINE and SOURCE ERROR (GJC `src/viewers/todo/render.mjs`). This mirrors OMO, which paints one colour when the source is current or empty (`packages/todo/src/render.mjs:230,236`), re-inked in the GJC palette.

The footer gets the one-column inset only when `width(footer) + 1 <= columns`. It is never truncated and has no short form (see Deviations, AC-F1/AC-F3). Mirrors OMO `packages/todo/src/render.mjs:232-236`.

## G4. Connection labels

Five labels, in English in the ko and en catalogues and pairwise distinct: `LIVE`, `WAITING`, `EMPTY`, `OFFLINE HH:MM`, `SOURCE ERROR`. The follow word is shown with every one of them. OMO names the source state in the footer at `packages/todo/src/render.mjs:233` (`t(language, source)`); GJC keeps its own five-label set (AC1.9).

## G5. Todo body

GJC follows Gajae Code's own todo list (`#renderTodoList` / `#formatTodoLine` in `src/modes/interactive-mode.ts`, `phaseRomanNumeral` / `formatTodoLine` in `src/tools/todo-write.ts`) instead of the OMO marks. Each item states the OMO fact first, then what the GJC pane draws.

- Phase rows are divider rows: `── <ROMAN>. <name>  <closed>/<total>[ drop:n] ─────`, for example `── I. 준비  1/3 ─────────────`. The row is always exactly one body row: the leading `── ` and the trailing dashes are dimShell `38;2;111;71;67`, the title is painted separately, and the dashes fill the row to the usable `columns` after the title is fitted (the frame already reserves the last terminal cell, and CJK width counts as two cells). With no room left for dashes the row is just the title, and no phase row ever exceeds `columns` cells. The roman numeral is the phase's one-based position among ALL phases of the projection, spelled in ASCII (I, II, III, IV, …), and folding a closed phase never renumbers its neighbours. It is display-only: selection and preference keys never contain it. Title ink: a phase holding the in-progress task is bold claw `1;38;2;255;106;61`, any other open phase is bold coral `1;38;2;255;138;101`, a fully closed phase is mutedShell `38;2;185;143;134` and not bold. The ` drop:n` suffix is unchanged. OMO: divider rows `─ <name> …` at `packages/todo/src/render.mjs:153-160`, without the ` ▸` fold suffix in GJC.
- Task rows are a tree starting at column 0 without a leading indent: `├─ <checkbox> <content>` while the phase has a later task and `└─ <checkbox> <content>` on its last task, so the branch visibly closes and one phase can show both glyphs. The checkbox is `☐`, or `☑` when the task is done; a status outside the four draws `☐`. Wrapped continuation rows keep the text column: a non-last task continues on `│  ` plus blanks (rail under the branch) and the last task on blanks only, so every wrapped line starts under the task text. The widest prefix (`├─ ☐ `) is the body inset. OMO: `packages/todo/src/render.mjs:27` (`marks`) with a hook on the first row of a phase only.
- Task row colours: in progress bold claw `1;38;2;255;106;61`; done dim struck kelp `2;9;38;2;110;231;183` on `☑ <content>`, applied to every physical row a wrapped done task occupies (continuation rows, selected or not, carry the same dim strike ink and each row ends with `0`); dropped dangerRed struck through `9;38;2;255;77;94` on `☐ <content>`; pending mutedShell `38;2;185;143;134` (dimShell is too dark to read). There is no strike-reveal animation. OMO: in progress `36`, done `2;32` struck, dropped `2;31`, pending uncoloured (`:24-25`, `:31`, `:36-40`, `:177-180`).
- Follow pins the current phase. While follow is ON and the body has room, the window starts at the divider row of the phase holding the in-progress task; with no in-progress task it starts at the first drawn phase that still has pending work, and with none of those at the last drawn phase. A selection that would fall below the window raises it just enough, never past the selected task's first row. Finished phases above the anchor scroll out of view without being deleted, and a follow frame is not clamped to the end of the body (the rows below the body are padded blanks), so a short list still pins its phase. Wheel and j/k set follow OFF, which restores the ordinary reveal/clamp/sticky-title window and shows those phases again. OMO: the pinned phase in `packages/todo/src/render.mjs:217-229` at `3242ad4`.
- Folding. OMO picks the phases that hold in-progress work; when no task is in progress it picks the first open phase instead (`:141-143`). Every open phase outside that set folds to its phase row and ends its summary with ` ▸` (`:150,153`). So with two pending-only phases the first stays listed and highlighted while the second folds, and once a third phase holds in-progress work both pending phases fold. OMO also hides closed phases unless `c` expands them (`:149`). GJC never folds an open phase: every phase that still holds pending or in-progress work lists all its tasks. Only fully closed phases can be hidden: the viewer lists them by default so finished work stays on record until a new todo list replaces it, and `c` collapses them (`src/viewers/todo/render.mjs:92,146`, `src/viewers/todo/viewer.mjs` `collapsed`). A phase with no tasks shows the empty-phase line in both (OMO `:185`, GJC `:197`).

Rows longer than the room wrap or end with `~` (G11). Mirrors OMO `packages/todo/src/render.mjs:217-229` (body window and the pinned phase that holds the current work) at `3242ad4`.

## G6. Goal row

When a goal exists, row 2 of the Todo pane (directly under the header divider) reads ` ◎ <objective> · <status> · <NK tok> · ⧖ <elapsed>`, inset, bold coral `1;38;2;255;138;101`, fixed above the scrolling body. On a narrow pane the `tok` part goes first, then the `◎ ` marker. OMO has no goal row; it follows the header-first rule of `packages/todo/src/render.mjs:203-212` at `3242ad4`, so nothing sits above the header. This moves the row from row 0 (amended L5b, see Deviations).

## G7. Worker card rows

Cards are stably grouped for display: live work (running, pending, paused and unknown) first, failed/aborted next, completed last. Within each group the projection's newest-first order is preserved. Selection stepping and click ranges use this same displayed order.

A card has up to three base rows plus one alert row; a long agent identity adds continuation rows (row 2). Column 0 is the card bar `▌` on a multi-row card and a space on a folded one-row card; every row of a card keeps that column, so the card edge stays straight.

1. Row 1: bar, glyph, space, title, then ` · <word>` for failed, aborted, paused, pending and unknown, then ` · ⧖ <compact time>`. Example: `▌⠋ build docs · ⧖ 5m 0s`. A folded completed card inserts `▸ ` between the glyph and the title (`✓ ▸ done one`), mirroring OMO `:402`. The word and the time are reserved before the title is sized. If the title would keep fewer than 10 cells, the time moves to the front of row 3.
2. Row 2: `[agent]` in coral `38;2;255;138;101`, then ` <model>` in seafoam `38;2;125;211;199` when it fits on that row, plus ` background` in dimShell `38;2;111;71;67` when the worker runs in the background. Left out when there is neither agent nor background. The model is the card's `provider/modelId` with everything before the first `/` dropped (`openai/gpt-5.5` shows `gpt-5.5`); it only rides this row on the ordinary shortcut path, where the badge, the model and the background mark all fit. A card with no agent row, or one whose badge does not fit beside the model, leads row 3 with it instead. When the whole `[agent]` badge fits on one row it is drawn whole there, even when ` background` does not also fit. A long agent identity continues on following rows instead of being ellipsis-cut: the first row starts `[`, continuation rows are indented under the badge (two cells) and keep the same bar column, and the badge closes with exactly one `]` on the last identity row, sharing the last row that carries agent text whenever a trailing grapheme fits there. A row holding only `]` is drawn only where no agent text fits with it under columns-1. At most six continuation rows are drawn; beyond that the last one ends `…]` so the title and metrics stay reachable. The ` background` mark stays visible: it shares the last identity row when it fits and otherwise takes one dim indented row. Those continuation rows never carry the model. Mirrors OMO `packages/dag/src/render.mjs:395,399,445-447` (the role keeps its own row instead of being cut short to share one).
3. Row 3: `48K tok · 12 tools · ctx 41%` in mutedShell `38;2;185;143;134`. Each part is left out when its value is missing. A model that could not ride on row 2 leads the row (`gpt-5.5 · 48K tok · 12 tools · ctx 41%`), and a model alone is enough to make the row exist.
4. Alert row, only when a retry is pending: `↻ <attempt> · <delay>` in sand `38;2;255;215;168`.

Cost, the model in full host form, current tool, intent and last output live in the `d` detail view; a one-row collapsed completed card never shows the model. Mirrors OMO `packages/dag/src/render.mjs:375-445` (compactTaskLines: three rows, the 10-cell time rule at `:409-410`, the alert row at `:413-415`).

Consecutive drawn cards are separated by one dim full-width `─` row, and only between cards: never before the first card and never after the last. The divider is not part of either card's range, so selection, click and scroll offsets still point at card rows. Mirrors OMO `packages/dag/src/render.mjs:568-579` (the `cards++` separator before each card after the first, `:575`).

## G8. Glyphs and colours

| status | glyph | colour |
| --- | --- | --- |
| pending | `○` | dimShell `38;2;111;71;67` |
| running | spinner frame | claw `38;2;255;106;61` |
| completed | `✓` | kelp `38;2;110;231;183` |
| failed | `×` | dangerRed `38;2;255;77;94` |
| aborted | `⊘` | coral `38;2;255;138;101` |
| paused | `Ⅱ` | warningAmber `38;2;245;184;75` |
| unknown | `?` | dangerRed `38;2;255;77;94` |

The bar `▌` takes the status colour on every multi-row card; a one-row card gets a space instead. The title takes the status colour and is bold only on the selected card. The time is sand `38;2;255;215;168` while running and mutedShell `38;2;185;143;134` otherwise. Aborted stays a different colour from failed and paused (AC2.2). Mirrors OMO `packages/dag/src/render.mjs:76-80` (icons), `:86` (colours), `:434,442` (time colour, bold only when selected) and `:507-511` (barCard), re-inked in the GJC `red-claw` palette.

## G9. Completed fold

Completed worker cards are listed by default, folded to row 1 only, so a run leaves a record; the header summary ends `done N ▾`. The `c` key hides them and the mark turns `▸` (the choice persists as `hideCompleted`). A completed card that is still drawn (shown, explicitly expanded, or kept because it is selected) carries the per-card chevron after its glyph: ` ✓ ▸ done one · ⧖ 12s` while folded, and no chevron on its full expanded rows. Mirrors OMO `packages/dag/src/render.mjs:402` (`collapsed ? '▸ ' : ''`) and `:574` (a selected completed card stays drawn). The fold segment is the last one dropped when a narrow header cannot show every tally (G1), so a mixed 34-column pane still names the hidden group. Failed and aborted cards never fold. The card drawn as selected, explicit or implicit default, stays drawn after it completes until the selection moves, so Space never acts on a hidden card. OMO stores the default as `selectedTaskId` (`packages/dag/src/viewer.mjs:186`) and clears it on a session change (`:222`). GJC remembers the selection it last drew as `lastSelection` and passes `prefs.selection ?? lastSelection` to the renderer (`src/viewers/workers/viewer.mjs:255,299,305`), and drops that hint in `rebind()` on a scope switch (`:481`). One small difference: GJC keeps the implicit default out of persisted prefs, so the stored selection stays null until the user moves it. Mirrors OMO `packages/dag/src/render.mjs:565-566` (`▸`/`▾`) and `:574` (the selected card stays).

## G10. Empty states

- Workers, no workers: an empty row, `  ○  No workers yet`, an empty row, then `  Workers from this chat` and `  show here.` dim.
- Workers, waiting or source error: one `○` row (`Waiting for the Workers source.` or `Cannot read the Workers source.`).
- Todo: short English sentences: `Waiting for the Todo source.`, `The checklist is empty.`, `Cannot read the Todo source.`

These follow the OMO generation-32 empty panes at `3242ad4`. The Workers shape mirrors `packages/dag/src/render.mjs:612-616`: `''`, `  ○  <first>`, `''`, then `  <line1>` and `  <line2>` painted dim. In the worker view the words are `noWorkers: 'No workers yet'`, `noWorkersLine1: 'Workers from this chat'`, `noWorkersLine2: 'show here.'` (`packages/dag/src/i18n.mjs:23,70`).

## G11. Truncation mark

The Todo pane cuts with `~`, as OMO `packages/todo/src/render.mjs:70` does. The Workers pane cuts with `…`, as OMO `packages/dag/src/render.mjs:552` fits the DAG pane. The shared `fit` takes the mark as a parameter. A Workers agent identity is wrapped on continuation rows first (G7) and only ellipsized after the six-row cap or at a degenerate pane width.

## G12. Selection

Selection is state, not a column: neither pane draws a marker, and no row reserves a leading cell for one. Workers keeps its selected card's title bold (`1;38;2;255;106;61`, `src/viewers/workers/render.mjs`); Todo changes no ink when the selection moves, so a selected row looks exactly like an unselected row of the same status (`src/viewers/todo/render.mjs`). The selection still drives j/k/Tab, Space, `c` and pointer clicks, and the task or card key is carried in the frame (`selection`, `selectionIndex`/`selectable`). OMO marks Workers selection by bold title only (`packages/dag/src/render.mjs:442` at `3242ad4`) and Todo by a bold selected row when its status is coloured (`packages/todo/src/render.mjs:177-180`); removing the GJC column matches OMO's no-…

## G13. Spinner

A running worker's glyph cycles `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`, one frame per 125 ms tick. The timer exists only in an interactive viewer while at least one card runs. A tick redraws from cached inputs without reading any file, and writes `\x1b[H` plus rows joined by `\x1b[K\r\n` with a trailing `\x1b[K`, never a full-screen clear. Mirrors OMO `packages/dag/src/render.mjs:77-80` (frames), `packages/dag/src/viewer.mjs:62-63` (125 ms timer, stopped when nothing runs), `:172` (interactive only) and `:201` (the redraw write).

## Deviations

Every place where GJC differs from OMO `3242ad4` on purpose, with the contract behind it.

| id | GJC behaviour | OMO 3242ad4 | reason |
| --- | --- | --- | --- |
| AC-F1 | The footer is never truncated and the follow word shows in every state. At 24 and 26 columns `Follow OFF · OFFLINE 09:05` (26 cells) overflows on that row only. | Fits the footer to the pane (`packages/todo/src/render.mjs:236`). | GJC contract AC-F1. |
| AC-F3 | No short forms of the footer at any width. | Short follow labels below 40 columns (`packages/todo/src/render.mjs:232`). | GJC contract AC-F3. |
| AC1.9 | Five pairwise distinct connection labels (G4). | Source-state labels from its own catalogue. | GJC contract AC1.9. |
| AC2.2 | Failed `×` + `failed`; aborted `⊘` + `aborted`. | No aborted state (`packages/dag/src/render.mjs:76`). | GJC contract AC2.2. |
| AC-F4 | Amended: at 24 columns the title keeps at least one cell and the status indicator survives: the glyph for running and done, glyph plus word for the other states. | Running and done show the glyph only. | Owner decision Q3=A (2026-10-20) amends AC-F4. |
| data-absent | The card shows the model (row 2 when it fits, else the front of row 3) but still no turns or tok/s. | Shows all three (`packages/dag/src/render.mjs:387-411`). | The model is now in the GJC workers projection (`model`, from `task:subagent:event` and `modelOverride`); turns and tok/s are not. |
| truncation | Todo `~`, Workers `…` (G11). A Workers agent identity continues on up to six following rows before it is fitted with `…` (G7). | Same split per pane; OMO keeps the role on its own row (`packages/dag/src/render.mjs:395,399,445-447`). | Mirrors OMO per pane; owner #259 keeps existing identity text instead of cutting it. |
| zh-cn | zh-cn keeps its translated pane strings and only gains the new keys. | ko block is English. | Existing zh-cn values stay byte-identical. |
| L5b | Amended: the goal row sits under the header divider (row 2), not at row 0 (README.md:86, `test/unit/goal-render.test.mjs:1-3,35`, `test/live/l5-goal.mjs:1-2`). | No goal row. | Header-first grammar. |
| d | Failed, aborted, paused and pending cards show full rows by default. | Only running cards expand (`packages/dag/src/render.mjs:572-573`). | Problem cards stay readable without a key press. |
| g | The footer keeps the requested follow state, `Follow ON` or `Follow OFF`, in every connection state; the Workers footer gives EMPTY the live colour claw `38;2;255;106;61`. | Always shows a follow label, but forces `Follow OFF` when the source isn't live (`packages/todo/src/render.mjs:230,232-233`, labels at `packages/todo/src/i18n.mjs:11-12,27-28`). | AC-F1. |
| h | The source error row sits above the body. | Error lines go into the body (`packages/dag/src/render.mjs:561-562`). | Keeps the last good body in place. |
| i | No scroll range in the footer. | Footer may carry position text. | AC-F1 (footer never truncated, so it stays short). |
| j | `background` mark on card row 2, kept visible on a wrapped identity by sharing its last row or taking one dim indented row (G7). | No background mark. | GJC contract AC2.6; owner #259 continuation rows. |
| todo-body | Todo body follows Gajae Code's own list (G5): `── I. <name>  <closed>/<total> ────` phase divider rows (dimShell dashes, bold claw/coral/mutedShell title), `├─`/`└─` tree task rows with `☐`/`☑` checkboxes, done dim struck kelp `2;9;38;2;110;231;183`, dropped dangerRed struck, pending mutedShell, open phases never folded, follow pins the phase that holds the in-progress task to the top of the body, no ` ▸` fold suffix and no strike-reveal animation. | Done `2;32` struck, dropped `2;31`, strike reveal, open phases outside the in-progress set (or, with nothing in progress, every open phase after the first) folded with ` ▸` (`packages/todo/src/render.mjs:24-40,141-143,149-153`). | The pane reads as GJC's own todo list and uses the GJC `red-claw` palette; fold semantics stay GJC's (IS-7). |
| k | The en catalogue takes the same English wording as ko. | ko block is English (`packages/dag/src/i18n.mjs`). | One English chrome in ko and en. |

## 요약 (Korean summary)

이 문서는 GJC 대시보드의 Todo, Workers 패널이 OMO `3242ad4`와 같은 모양으로 읽히도록 정한 규칙입니다. G1부터 G13까지 머리줄, 구분선, 바닥줄, 연결 상태, 본문, 목표 줄, 작업자 카드, 기호와 색, 완료 접기, 빈 화면, 잘림 표시, 선택 상태, 스피너를 다루고, 규칙마다 따라 한 OMO 소스 줄을 적었습니다. Todo 본문은 G5대로 구분선 phase 행(`── I. 이름  1/3 ───`)과 `├─`/`└─` 트리 작업 행을 쓰고, follow가 켜져 있으면 진행 중 작업이 있는 phase를 본문 맨 위에 고정합니다. OMO와 다르게 남긴 부분은 Deviations 표에 GJC 계약(AC-F1, AC-F3, AC1.9, AC2.2, AC2.6, 수정된 AC-F4와 L5b)이나 IS-7과 함께 정리했습니다. 표에는 모두 16개 항목이 있습니다.
