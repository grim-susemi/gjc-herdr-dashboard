# GRAMMAR

The shared pane grammar of the GJC Herdr dashboard. The Todo and Workers panes follow it so they read the same way as the omo-herdr-dashboard panes at commit `3242ad4`. Each rule gives the GJC string shape, its ANSI codes and the OMO source line it mirrors. OMO paths are relative to that repository and are read with `git show 3242ad4:<path>`. Where GJC keeps a different behaviour, the reason is a named GJC contract and it is listed under Deviations.

Colour codes used below: `1;36` bold cyan, `1;33` bold yellow, `36` cyan, `33` yellow, `32` green, `31` red, `35` magenta, `90` grey (muted), `2` dim, `0` reset.

## G1. Header row

Row 0 of both panes: ` Name [done/total]  summary`, inset one column when the pane is wider than one column.

- Todo: ` Todo [closed/total]  done:n · drop:n`. `Todo` is bold in the connection colour (`1;36` live, waiting or empty, `1;33` offline or last known, `1;31` on source error), the tally is `1;33`, the summary is `90`. When the whole row doesn't fit, only the name and tally are kept, fitted to the room. Mirrors OMO `packages/todo/src/render.mjs:202` (name colour) and `:205-212` (header row).
- Workers: ` Workers [done/total]  run N · failed N · aborted N · paused N · done N ▸`. `Workers` is `1;36` in every state, the tally `1;33`, the summary dim `2`, fitted with `…`. `run N` is always shown, even at 0; other zero counts are left out. When the full summary does not fit, secondary tallies are dropped before the fold segment, in the order paused, aborted, failed, so `done N ▸/▾` survives as long as it fits; only then does the ordinary `…` fitting apply. At 34 columns a mixed `run 1 · failed 1 · done 1 ▸` header therefore reads `run 1 · done 1 ▸`, and at 24 columns it clips like OMO (`run 1 …`). Mirrors OMO `packages/dag/src/render.mjs:549-553` (headLine) and `:557-558` (the running count is always present).

## G2. Header divider

Row 1 of both panes is a full-width `─` divider directly under the header row. Each pane keeps the code of the OMO pane it mirrors:

- Todo: painted `90` (muted). Mirrors OMO `packages/todo/src/render.mjs:207` (`paint('─'.repeat(columns), 'muted', color)`) with `muted: '90'` at `:24`.
- Workers: painted dim `2`. Mirrors OMO `packages/dag/src/render.mjs:558` (`separator` after headLine), which paints with `dim` at `:529-531`, and `dim = '2'` at `:91`.

## G3. Footer

The last two rows of both panes: the pane's own divider (Todo `90`, Workers `2`, as in G2), then the footer ` Follow ON · <connection>` or ` Follow OFF · <connection>`. The colour depends on the connection only, never on the follow word, and each pane has its own rule:

- Workers: `36` for LIVE and EMPTY, `33` for WAITING, OFFLINE and SOURCE ERROR (GJC `src/viewers/workers/render.mjs:376`). This matches OMO, which paints `36` when the source is current or empty (`packages/todo/src/render.mjs:230,236`).
- Todo: `36` for LIVE and EMPTY, `33` for WAITING, OFFLINE and SOURCE ERROR (GJC `src/viewers/todo/render.mjs:245-246`). This matches OMO, which paints `36` when the source is current or empty (`packages/todo/src/render.mjs:230,236`).

The footer gets the one-column inset only when `width(footer) + 1 <= columns`. It is never truncated and has no short form (see Deviations, AC-F1/AC-F3). Mirrors OMO `packages/todo/src/render.mjs:232-236`.

## G4. Connection labels

Five labels, in English in the ko and en catalogues and pairwise distinct: `LIVE`, `WAITING`, `EMPTY`, `OFFLINE HH:MM`, `SOURCE ERROR`. The follow word is shown with every one of them. OMO names the source state in the footer at `packages/todo/src/render.mjs:233` (`t(language, source)`); GJC keeps its own five-label set (AC1.9).

## G5. Todo body

GJC keeps its own Todo body semantics (IS-7). Each item states the OMO fact first, then what the GJC pane draws.

- Task marks, each followed by one space: pending `[ ]`, in progress `[•]`, done `[✓]`, dropped `[×]`. OMO: `packages/todo/src/render.mjs:27` (`marks`, also `[×]` for cancelled). GJC: the same four marks (`src/viewers/todo/render.mjs:38`); a status outside the four draws ` ? `. The row prefix is the selection column (G12), the mark and a space.
- Task row colours. OMO: in progress `36`; done `2;32` struck through (`9;2;32`, with a strike reveal through `9m`/`29m` while the completion animates); dropped `2;31`; pending uncoloured; the target bold (`:24-25`, `:31`, `:36-40`, `:177-180`). GJC: in progress bold `1;36`; done and dropped both plain `90`, with no strike and no animation; pending uncoloured (`src/viewers/todo/render.mjs:35-36,40-41,117`).
- Phase rows are divider rows `─ <name> <closed>/<total>[ drop:n] ───`. A phase holding in-progress work paints `─ ` and the tail `90` and the label bold `1;33`; every other phase row is `90` whole. OMO: `:153-160`. GJC: the same colours, without the ` ▸` fold suffix (`src/viewers/todo/render.mjs:97-105`).
- Folding. OMO picks the phases that hold in-progress work; when no task is in progress it picks the first open phase instead (`:141-143`). Every open phase outside that set folds to its phase row and ends its summary with ` ▸` (`:150,153`). So with two pending-only phases the first stays listed and highlighted while the second folds, and once a third phase holds in-progress work both pending phases fold. OMO also hides closed phases unless `c` expands them (`:149`). GJC never folds an open phase: every phase that still holds pending or in-progress work lists all its tasks. Only fully closed phases are hidden until `c` (`src/viewers/todo/render.mjs:78-81,93-94`). A phase with no tasks shows the empty-phase line in both (OMO `:185`, GJC `:122`).

Rows longer than the room wrap or end with `~` (G11). Mirrors OMO `packages/todo/src/render.mjs:217-229` (body window and the pinned phase that holds the current work) at `3242ad4`.

## G6. Goal row

When a goal exists, row 2 of the Todo pane (directly under the header divider) reads ` ◎ <objective> · <status> · <NK tok> · ⧖ <elapsed>`, inset, magenta bold `1;35`, fixed above the scrolling body. On a narrow pane the `tok` part goes first, then the `◎ ` marker. OMO has no goal row; it follows the header-first rule of `packages/todo/src/render.mjs:203-212` at `3242ad4`, so nothing sits above the header. This moves the row from row 0 (amended L5b, see Deviations).

## G7. Worker card rows

A card has up to three base rows plus one alert row; a long agent identity adds continuation rows (row 2). Column 0 is the selection column (G12).

1. Row 1: bar, glyph, space, title, then ` · <word>` for failed, aborted, paused, pending and unknown, then ` · ⧖ <compact time>`. Example: `▌⠋ build docs · ⧖ 5m 0s`. A folded completed card inserts `▸ ` between the glyph and the title (`✓ ▸ done one`), mirroring OMO `:402`. The word and the time are reserved before the title is sized. If the title would keep fewer than 10 cells, the time moves to the front of row 3.
2. Row 2: `[agent]` in `35`, plus ` background` dim when the worker runs in the background. Left out when there is neither. A long agent identity continues on following rows instead of being ellipsis-cut: the first row starts `[`, continuation rows are indented under the badge (two cells) and keep the same bar column, and the closing `]` ends the last identity row. At most six continuation rows are drawn; beyond that the last one ends `…]` so the title and metrics stay reachable. The ` background` mark stays visible: it shares the last identity row when it fits and otherwise takes one dim indented row. Mirrors OMO `packages/dag/src/render.mjs:395,399,445-447` (the role keeps its own row instead of being cut short to share one).
3. Row 3: `48K tok · 12 tools · ctx 41%` in `90`. Each part is left out when its value is missing.
4. Alert row, only when a retry is pending: `↻ <attempt> · <delay>` in `33`.

Cost, current tool, intent and last output live in the `d` detail view. Mirrors OMO `packages/dag/src/render.mjs:375-445` (compactTaskLines: three rows, the 10-cell time rule at `:409-410`, the alert row at `:413-415`).

Consecutive drawn cards are separated by one dim full-width `─` row, and only between cards: never before the first card and never after the last. The divider is not part of either card's range, so selection, click and scroll offsets still point at card rows. Mirrors OMO `packages/dag/src/render.mjs:568-579` (the `cards++` separator before each card after the first, `:575`).

## G8. Glyphs and colours

| status | glyph | colour |
| --- | --- | --- |
| pending | `○` | `90` |
| running | spinner frame | `36` |
| completed | `✓` | `32` |
| failed | `×` | `31` |
| aborted | `⊘` | `35` |
| paused | `Ⅱ` | `33` |
| unknown | `?` | `31` |

The bar `▌` takes the status colour on every multi-row card; a one-row card gets a space instead. The title takes the status colour and is bold only on the selected card. The time is `33` while running and `90` otherwise. Mirrors OMO `packages/dag/src/render.mjs:76-80` (icons), `:86` (colours), `:434,442` (time colour, bold only when selected) and `:507-511` (barCard).

## G9. Completed fold

Completed worker cards are hidden; the header summary ends `done N ▸`. The `c` key shows them folded to row 1 only and the mark turns `▾`. A completed card that is still drawn (shown, explicitly expanded, or kept because it is selected) carries the per-card chevron after its glyph: ` ✓ ▸ done one · ⧖ 12s` while folded, and no chevron on its full expanded rows. Mirrors OMO `packages/dag/src/render.mjs:402` (`collapsed ? '▸ ' : ''`) and `:574` (a selected completed card stays drawn). The fold segment is the last one dropped when a narrow header cannot show every tally (G1), so a mixed 34-column pane still names the hidden group. Failed and aborted cards never fold. The card drawn as selected, explicit or implicit default, stays drawn after it completes until the selection moves, so Space never acts on a hidden card. OMO stores the default as `selectedTaskId` (`packages/dag/src/viewer.mjs:186`) and clears it on a session change (`:222`). GJC remembers the selection it last drew as `lastSelection` and passes `prefs.selection ?? lastSelection` to the renderer (`src/viewers/workers/viewer.mjs:255,299,305`), and drops that hint in `rebind()` on a scope switch (`:481`). One small difference: GJC keeps the implicit default out of persisted prefs, so the stored selection stays null until the user moves it. Mirrors OMO `packages/dag/src/render.mjs:565-566` (`▸`/`▾`) and `:574` (the selected card stays).

## G10. Empty states

- Workers, no workers: an empty row, `  ○  No workers yet`, an empty row, then `  Workers from this chat` and `  show here.` dim.
- Workers, waiting or source error: one `○` row (`Waiting for the Workers source.` or `Cannot read the Workers source.`).
- Todo: short English sentences: `Waiting for the Todo source.`, `The checklist is empty.`, `Cannot read the Todo source.`

These follow the OMO generation-32 empty panes at `3242ad4`. The Workers shape mirrors `packages/dag/src/render.mjs:612-616`: `''`, `  ○  <first>`, `''`, then `  <line1>` and `  <line2>` painted dim. In the worker view the words are `noWorkers: 'No workers yet'`, `noWorkersLine1: 'Workers from this chat'`, `noWorkersLine2: 'show here.'` (`packages/dag/src/i18n.mjs:23,70`).

## G11. Truncation mark

The Todo pane cuts with `~`, as OMO `packages/todo/src/render.mjs:70` does. The Workers pane cuts with `…`, as OMO `packages/dag/src/render.mjs:552` fits the DAG pane. The shared `fit` takes the mark as a parameter. A Workers agent identity is wrapped on continuation rows first (G7) and only ellipsized after the six-row cap or at a degenerate pane width.

## G12. Selection column

Column 0 of every selectable row holds `>` on the selected row and a space elsewhere, in both panes. Workers paints the marker bold `1;36` (`src/viewers/workers/render.mjs:230`). Todo puts the literal `>` inside the task row and paints the whole row by the task status, with no separate marker colour, so a selected pending task reads plain `>[ ] task` (`src/viewers/todo/render.mjs:113,117`). OMO marks selection by bold title only (`packages/dag/src/render.mjs:442` at `3242ad4`); GJC keeps the column for j/k/Tab (see Deviations).

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
| selection | Column-0 `>` marker (G12): bold `36` in Workers, styled with the task row in Todo. | Bold title only (`packages/dag/src/render.mjs:442`). | GJC j/k/Tab selection. |
| data-absent | No model, turns or tok/s on cards. | Shows them (`packages/dag/src/render.mjs:387-411`). | The data isn't in the GJC workers projection. |
| truncation | Todo `~`, Workers `…` (G11). A Workers agent identity continues on up to six following rows before it is fitted with `…` (G7). | Same split per pane; OMO keeps the role on its own row (`packages/dag/src/render.mjs:395,399,445-447`). | Mirrors OMO per pane; owner #259 keeps existing identity text instead of cutting it. |
| zh-cn | zh-cn keeps its translated pane strings and only gains the new keys. | ko block is English. | Existing zh-cn values stay byte-identical. |
| L5b | Amended: the goal row sits under the header divider (row 2), not at row 0 (README.md:86, `test/unit/goal-render.test.mjs:1-3,35`, `test/live/l5-goal.mjs:1-2`). | No goal row. | Header-first grammar. |
| d | Failed, aborted, paused and pending cards show full rows by default. | Only running cards expand (`packages/dag/src/render.mjs:572-573`). | Problem cards stay readable without a key press. |
| g | The footer keeps the requested follow state, `Follow ON` or `Follow OFF`, in every connection state; the Workers footer gives EMPTY the live colour `36`. | Always shows a follow label, but forces `Follow OFF` when the source isn't live (`packages/todo/src/render.mjs:230,232-233`, labels at `packages/todo/src/i18n.mjs:11-12,27-28`). | AC-F1. |
| h | The source error row sits above the body. | Error lines go into the body (`packages/dag/src/render.mjs:561-562`). | Keeps the last good body in place. |
| i | No scroll range in the footer. | Footer may carry position text. | AC-F1 (footer never truncated, so it stays short). |
| j | `background` mark on card row 2, kept visible on a wrapped identity by sharing its last row or taking one dim indented row (G7). | No background mark. | GJC contract AC2.6; owner #259 continuation rows. |
| todo-body | Todo body keeps GJC semantics (G5): done and dropped `90`, no strike or strike animation, open phases never folded, no ` ▸` fold suffix. | Done `2;32` struck, dropped `2;31`, strike reveal, open phases outside the in-progress set (or, with nothing in progress, every open phase after the first) folded with ` ▸` (`packages/todo/src/render.mjs:24-40,141-143,149-153`). | IS-7: Todo body and fold semantics are unchanged by this plan. |
| k | The en catalogue takes the same English wording as ko. | ko block is English (`packages/dag/src/i18n.mjs`). | One English chrome in ko and en. |

## 요약 (Korean summary)

이 문서는 GJC 대시보드의 Todo, Workers 패널이 OMO `3242ad4`와 같은 모양으로 읽히도록 정한 규칙입니다. G1부터 G13까지 머리줄, 구분선, 바닥줄, 연결 상태, 본문, 목표 줄, 작업자 카드, 기호와 색, 완료 접기, 빈 화면, 잘림 표시, 선택 열, 스피너를 다루고, 규칙마다 따라 한 OMO 소스 줄을 적었습니다. OMO와 다르게 남긴 부분은 Deviations 표에 GJC 계약(AC-F1, AC-F3, AC1.9, AC2.2, AC2.6, 수정된 AC-F4와 L5b)이나 IS-7과 함께 정리했습니다. 표에는 모두 17개 항목이 있습니다.
