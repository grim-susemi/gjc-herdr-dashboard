# VERIFICATION

증거는 `.evidence/` 아래에 있고 git에서 제외된다. 아래 기록은 실제로 실행한 명령의 결과만 적는다.

## 2026-10-20 Dashboard polish (owner test findings)

owner 테스트에서 나온 아래 항목을 고쳤다. 아래 당시 기록은 고치지 않고 새 변경만 추가한다.

- **Todo follow-pin**: follow ON이면 진행 중 작업이 있는 phase(없으면 첫 열린 phase, 모두 닫혔으면 마지막 phase)의 구분선 행이 body 첫 줄에 고정된다. 끝난 phase는 위로 밀려 화면 밖으로 나가며 지워지지 않는다(휠/`j`/`k`로 follow OFF 후 다시 보임). follow ON 프레임은 body 끝을 넘는 scroll을 가질 수 있어 viewer는 저장할 때 `maxScrollOf()`로 다시 자른다.
- **Todo 구분선과 트리**: phase 행은 `── II. 워커 실행  0/3 ────` 구분선 행이고, 작업 행은 `├─`/`└─` 트리이며 왼쪽 들여쓰기 없이 column 0에서 시작한다(`taskIndent` 빈 문자열, `taskInset` 6칸). 이어지는 줄은 `│` 레일 또는 공백.
- **Todo 색**: 대기 항목 dimShell(대비 부족) → mutedShell, 완료 항목은 kelp 취소선 제거, 취소(dropped)만 취소선 유지, phase 제목은 굵게(진행 중 claw, 열림 coral, 닫힘 mutedShell).
- **Workers 정렬**: 실행/대기/일시정지 카드가 위, failed/aborted가 중간, completed가 아래에 쌓인다. 같은 구간 안에서는 기존 최신순을 유지하며 `selectable`(Tab/`n`/`p`)도 같은 순서를 따른다. 완료 카드가 마지막 행이 되므로 기존 테스트의 `\t` 이동은 `p`로 바꿨다.
- **Workers 클릭 즉시 반영**: `commit()`/`key()`/`onFocus()`가 `draw()` 뒤 `writeFrame()`을 바로 호출한다(이전에는 1 s 타이머 또는 spinner 틱을 기다려 약 1초 지연). 같은 프레임은 다시 쓰지 않고(`lastWritten`), 드래그 모션은 즉시 그리되 prefs 저장은 놓을 때 한 번만 한다.
- **패널 테두리 왼쪽 위 빈칸**: 원인은 Herdr `pane_border_title`이 라벨을 `" " + label + " "`로 그려서 제로폭 라벨(U+200B/C/D)에도 양쪽 공백이 남는 것이었다(`src/ui/panes.rs`, v0.9.5). 공백만 있는 라벨은 trim되어 "라벨 없음"이 되므로 보이지 않는 라벨은 존재할 수 없다. 그래서 `pane rename` 호출과 `PANE_LABELS`/`labelOf`를 제거했고 pane 식별은 `paneId + tabId`(+ shell pid)이다. `launch.mjs`의 fp3(rename 직후)와 `failed:herdr-rename` 코드·번역 키도 삭제했다. 이미 떠 있는 기존 pane에는 예전 라벨이 남아 있으므로 새 generation에서 pane을 다시 열어야 빈칸이 사라진다.

검증: 전체 `node scripts/test.mjs` **728/728** 통과(fail 0, skipped 0). 렌더 확인은 follow ON/OFF Todo 프레임과 Workers 정렬 프레임을 `color:false`로 출력해 눈으로 확인했다. 설치: `node scripts/install.mjs`로 `generation-000009`(이전 `generation-000008` 유지)를 설치했고 `--doctor`는 mismatches 0, exit 0이다. 실제 Herdr 화면에서 테두리 빈칸이 사라지는지는 아직 확인하지 않았다(새 세션에서 pane을 다시 열어야 한다).

## 2026-10-20 Final-wave follow-up (rows 11-17)

F4/F1/F3 final-wave 지적 중 rows 11, 12, 13, 17, 16을 고쳤다. 이 절은 아래의 당시 기록을 고치지 않고 새 변경만 추가한다.

- **row 11**: Todo EMPTY footer를 OMO Todo `packages/todo/src/render.mjs:230,236`과 같이 cyan `36`으로 바꿨다. WAITING/OFFLINE/SOURCE ERROR는 yellow `33`을 유지하고, Workers EMPTY도 cyan `36`이다. GRAMMAR G3를 고치고 `todo-footer` deviation 행을 삭제했다(Deviations 17행). goal row가 inset을 두 번 빼 한 칸을 잃던 문제도 고쳐 24/26/34/52/54에서 쓸 수 있는 폭 전체를 쓴다.
- **row 12**: 34열 mixed header에서 secondary tally를 fold segment보다 먼저 떨어뜨려 `run 1 · done 1 ▸/▾`를 유지한다. 우선순위는 paused → aborted → failed이고 fold segment는 마지막이며, 24열은 OMO처럼 `…`로 clipping한다(GRAMMAR G1/G9).
- **row 13**: 연속으로 그려진 Workers card 사이에 dim full-width divider를 넣었다(OMO `packages/dag/src/render.mjs:568-579`, 특히 `:575`). 첫 card 앞과 마지막 card 뒤에는 없다. selectable/click 범위, scroll 최대치, row budget, completed folding은 divider를 card range 밖에 두어 유지한다(GRAMMAR G7).
- **row 17**: `c`로 보인 completed card에 OMO의 per-card chevron을 붙여 ` ✓ ▸ done one · ⧖ 12s`로 그린다(OMO `:402`). column-0 선택 marker와 색은 그대로다(GRAMMAR G7/G9). 이후 owner 요청으로 column-0 선택 marker와 예약된 왼쪽 칸은 제거됐으므로(GRAMMAR G12, 커밋 `33c5e9d`·`18d3aa7`) marker 부분은 현재 레이아웃에 적용되지 않는다. 색 처리는 그대로다.
- **row 16 (#259)**: 긴 agent/role identity를 ellipsis로 자르지 않고 다음 행에 이어 쓴다. 첫 행은 `[agent`, continuation은 badge 아래 두 칸 들여쓰기와 같은 bar column, 마지막 행은 `]`로 닫는다. `background`는 마지막 identity 행에 붙거나 별도 dim 들여쓰기 행으로 남는다. 최대 6 continuation 행을 그리며, 그를 넘으면 마지막 행이 `…]`로 끝난다. fixture `architect-role-` + `long-role-name-`×6 + `TAIL`은 24/34/54에서 TAIL을 보인다(GRAMMAR G7/G11/truncation/j).

단위 테스트: 관련 targeted 159/159, 전체 `node scripts/test.mjs`는 global lock wrapper로 **685/685** 통과했다(기준선 683 + 새 테스트 2, fail 0). frame/probe 증거는 `task-fix-frames-before.txt`, `task-fix-frames-after.txt`, `task-fix-unit.txt`, `task-fix-probe.txt`다.

검증자 지적 2건을 반영했다. `5897fbe`는 identity wrap 경계에서 첫 행이 agent 전체를 소비해 닫는 `]`가 빠지던 문제를 닫는 continuation 행으로 고치고, 4개 폭 × background on/off × 7개 agent 길이의 56개 경계 grid 회귀 테스트를 추가했으며 GRAMMAR G7의 "세 행" 문구를 continuation 행과 일치시켰다. `7159676`은 divider 도입 뒤 약해진 두 단언을 복원했다: 12장/11 divider geometry에서 drag 목적지는 18행(`c4.start 16` + `bodyStart 2` + 1 = 19행에서 1행까지)이고, 10장/9 divider의 maxScroll 15에서는 첫 스크롤 행이 card 9 위 divider, 다음 행이 card 9, 이어 divider와 card 10이다. 전체 단위 테스트는 **686/686** 통과했다(기존 685 + G7 경계 회귀 1, fail 0). 증거는 `task-fix2-unit.txt`, `task-fix2-boundaries.txt`, `task-fix2-mutation.txt`다.

F2 2차 검토의 H1(배지 분리)을 `4d22a30`에서 고쳤다. 24열 background card에서 `[librarian]`이 `[librarian` + `] background`로 갈라지던 회귀를 재현했고, 이제 `[agent]`가 identity 행에 들어가면 통째로 그리고 ` background`만 두 칸 들여쓰기 dim 행으로 내린다. 긴 agent는 마지막 grapheme을 `]`와 함께 continuation 행에 붙여 `]`만 있는 행을 없앴다(단, columns-1 아래에서 agent text가 `]`와 함께 들어가지 않는 degenerate 폭은 예외다). explicit 4폭 × background on/off × agent 길이 1..columns-3 테스트와 56-case grid의 `]`-only/whole-badge 단언을 추가했고, mutation 3종(whole-badge 분기 제거, trailing-grapheme 이동 제거, 둘 다 복원)에서 새 테스트가 실패함을 확인했다. targeted 182/182, 전체 **687/687** 통과(기존 686 + explicit 1, fail 0). 증거는 `task-fix3-repro.txt`, `task-fix3-unit.txt`, `task-fix3-fuzz.txt`, `task-fix3-mutation.txt`다.

3차 검증의 H1(continuation 행을 정확히 채우는 길이에서 닫는 `]`가 빠짐)과 M1(그 경계 회귀 누락)을 `c3a9ff5`에서 고쳤다. ad-hoc 소비 loop를 버리고 `[`+agent+`]` 전체를 grapheme 단위 chunk로 나눠 마지막 chunk가 항상 `]`를 포함하게 했으며, 마지막 chunk가 `]` 하나뿐인 경우에만 앞 chunk의 마지막 grapheme을 내려 `  a]`로 닫는다(continuation room >= 3; badge 행을 그리는 17열 이상에서 항상 성립). 17/18/24/26/34/54/80열 × background on/off × ASCII 1..7×columns 및 CJK/combining/emoji/ZWJ 1..5×columns의 모든 길이를 검사하는 속성 테스트를 추가했고 기존 단언은 그대로 두었다. targeted 43/43, 전체 **688/688** 통과(fail 0). 10,000-frame fuzz(0 failures)와 mutation 3종(81701c4 renderer 복원, lone-`]` 후처리 제거, cap `…]` 제거)이 모두 의도한 테스트에서 실패함을 확인했다. 증거는 `task-fix4-repro.txt`, `task-fix4-unit.txt`, `task-fix4-fuzz.txt`, `task-fix4-mutation.txt`다.

사용자 스코프의 generation-000002는 이 수정들보다 먼저 설치되었다. 따라서 그 pane은 rows 11-17 수정을 포함하지 않는다. 이후 owner 승인 아래 rows 11-17을 포함한 generation-000003을 설치했고, generation-000001과 generation-000002 rollback은 그대로 유지된다(아래 `사용자 범위 설치 (generation-000003)`).

## 2026-10-20 OMO grammar alignment

pane 문법을 omo `3242ad4`에 맞췄다. 규칙과 의도된 차이는 `GRAMMAR.md`(G1..G13, Deviations 18행)에 있다. 아래 기존 절들은 당시 사실 기록이라 고치지 않았다.

수정된 계약:

- **AC-F4** (GRAMMAR.md 그대로): at 24 columns the title keeps at least one cell and the status indicator survives: the glyph for running and done, glyph plus word for the other states. Running and done show the glyph only. (Owner decision Q3=A, 2026-10-20)
- **L5b**: goal 행은 Todo pane 2행, 헤더 구분선 바로 아래에 있다(전에는 0행). 예: ` ◎ align the todo pane~ · active · 12K tok · ⧖ 5m 3s`. 헤더 위에는 아무것도 없다.
- PLAN-NOTE: 24열에서 Todo·Workers footer `Follow ON · SOURCE ERROR`는 24셀이라 쓸 수 있는 23셀을 넘는다. 이름 붙인 예외다(`task-4-workers-frames.txt`의 `footer-exception` 줄).
- PLAN-NOTE: "옛 정규식은 아무것도 맞히지 않는다"는 교체된 옛 chrome 판정식에만 적용된다.

단위 테스트 수(기준선 593, 실패 이름은 기준선과 같음 = 없음):

| 단계 | 테스트 수 |
|---|---|
| 기준선 | 593 |
| todo 2 | 595 |
| todo 4 | 601 |
| todo 5 | 608 |
| todo 3 (테스트 21개 포함) | 629 |
| todo 4b | 633 |
| todo 6 | 683 |

라이브 결과(todo 7). 네 스크립트는 shim을 뗀 guarded window 두 번에서 모두 PASS였다.

| 스크립트 | window 1 (00:21:12Z..00:28:10Z) | window 2 (00:41:02Z..00:48:11Z) |
|---|---|---|
| l1-behaviour | PASS 170672 ms | PASS 156182 ms |
| l2-width | PASS 20338 ms | PASS 22190 ms |
| l2-workers | PASS 143889 ms | PASS 167343 ms |
| l5-goal | PASS 81972 ms | PASS 82925 ms |

- window 1의 omo-protected 수령증은 샌드박스 HOME에서 찍혀 경로가 MISSING이다. **유효한 증거가 아니다.**
- window 2는 `HOME=USERPROFILE=C:/Users/USER`로 omo-protected를 찍었고 전후가 바이트 동일하다: wrapper `25c376b0...`, pointer `5d6c0120...`, main `d8836c7b...`.
- 두 window 모두 GJC `current.json` `950a9d67...`, shim `07acd7cc...`가 전후 바이트 동일하고 `--doctor`는 ok, `generation-000001`이다.
- 갱신했지만 라이브로 다시 돌리지 않은 스크립트: l3-pointer, l4-adopt, l6-drills, l6-userscope(계획상 todo 7에서 `--confirm-user-scope` 금지), kill-recovery, lt3-delay.

증거(`C:/Users/USER/orca/projects/기타 작업/.omo/evidence/gjc-dashboard-omo-align/`): `task-3-todo-frames.txt`, `task-4-workers-frames.txt`, `task-7-live-pass.txt`, `task-7-rerun-live-pass.txt`, `task-8-docs-review.txt`, `task-8-docs-before.txt`.

### 사용자 범위 설치 (generation-000002)

소유자 승인 Q2=A에 따라 Release step A를 실행했다. push와 merge는 하지 않았다.

- 단위: `node scripts/test.mjs` -> 683 tests, 683 pass, 0 fail, 0 skipped, 0 todo (`task-9-unit.txt`).
- 패키지 스모크: scratch agent dir에 `--lang ko` 설치 exit 0; `scripts/verify-package.mjs` exit 0, `pass:true`, 28 required files, `importOk:true`, `defaultExport:"function"`, `localeHeader:"ext gen-000001"`, shim `targetMatches:true`/`envDefaults:false`/`failpointPlumbing:false` (`task-9-package-install.json`, `task-9-package-verify.json`).
- 실제 설치: `--dry-run` exit 0 -> `generation-000002`, `previous: generation-000001`; 설치 exit 0; 설치된 트리 verify-package exit 0, `pass:true`, `localeHeader:"ext gen-000002"` (`task-9-install.json`, `task-9-verify-installed.json`).
- l6-userscope: `--confirm-user-scope` PASS (exit 0, 110188 ms). notify `ext gen-000002 · Todo 열림 · Workers 열림`; frame-todo row 0 ` Todo [0/0]  done:0 · drop:0`, row 1 구분선, footer ` Follow ON · EMPTY`; frame-workers row 0 ` Workers [0/0]  run 0`, row 1 구분선, footer ` Follow ON · EMPTY`; AC6.3에서 shim 제거 시 ext notify 없음. outer finally의 `--select generation-000002` exit 0, current/shim은 설치 직후 기록과 바이트 동일 (`task-9-l6-frames.txt`, `task-9-l6-guard.json`).
- doctor: 설치 전 `generation-000001` 하나(selected, usable) -> 설치 후 두 개(`generation-000002` selected, `generation-000001` usable), mismatches 없음. 정확히 한 세대만 추가되고 제거된 세대는 없다 (`task-9-doctor-diff.txt`).
- 롤백 명령: `node scripts/install.mjs --agent-dir C:/Users/USER/.gjc/agent --select generation-000001` (이번 단계에서는 실행하지 않음).
- OMO protected는 전후 바이트 동일: wrapper `25c376b0...`, pointer `5d6c0120...`, main `d8836c7b...`.
- 증거: `task-9-release.txt` 및 위 파일들.

해시 표 (sha256; 트리는 정렬된 `<sha256>  <path>` manifest의 sha256):

| 항목 | 설치 전 | 설치 후 | l6 이후 |
|---|---|---|---|
| current.json | `950a9d67...` | `42689392...` | `42689392...` |
| shim | `07acd7cc...` | `75a25c93...` | `75a25c93...` |
| generation-000001 tree | `a9adb2c0...` | `a9adb2c0...` | `a9adb2c0...` |
| generation-000002 tree | - | `b29388d6...` | `b29388d6...` |
| models.yml | `29747daa...` | `29747daa...` | `29747daa...` |

gjc sessions that are already open keep generation-000001 until they are restarted (PROVENANCE.md:238); restart them to see the new panes.

### 사용자 범위 설치 (generation-000003)

소유자 승인 Q2=A에 따라 rows 11-17 수정 뒤의 소스를 generation-000003으로 설치했다. push와 merge는 하지 않았다. 첫 l6 시도는 로그를 남기지 못한 채 중단되었고(0-byte `task-9b-l6-userscope.log.txt`, harness pid 53608, orphan herdr 74964 -> gjc 4852), orchestrator가 identity 확인 뒤 그 트리를 종료했다. 남은 slot `b3bb2c3900a490a040f7a2e4`(owner pid 4852)는 baseline에 없고 pid가 죽은 것을 확인한 뒤 그 slot만 제거했다(`task-9c-state-before.txt`, `task-9c-state-after-cleanup.txt`). 아래 수치는 재실행 결과다.

- 단위: `node scripts/test.mjs` -> 686 tests, 686 pass, 0 fail, 0 skipped, 0 todo; 실패 이름은 기준선(593 pass, 0 fail)과 같다 = 없음 (`task-9b-unit.txt`, `task-0-baseline-failing.txt`).
- 패키지 스모크: scratch agent dir에 `--lang ko` 설치 exit 0; `scripts/verify-package.mjs` exit 0, `pass:true`, 28 required files, `importOk:true`, `defaultExport:"function"`, `localeHeader:"ext gen-000001"`, shim `targetMatches:true`/`envDefaults:false`/`failpointPlumbing:false` (`task-9c-package-install.json`, `task-9c-package-verify.json`).
- 실제 설치: `--dry-run` exit 0 -> `generation-000003`, `previous: generation-000002`; 설치 exit 0 (29 files); 설치된 트리 verify-package exit 0, `pass:true`, `localeHeader:"ext gen-000003"` (`task-9b-install-dry-run.json`, `task-9b-install.json`, `task-9b-verify-installed.json`).
- l6-userscope: `--confirm-user-scope` PASS (exit 0, 103572 ms). notify `ext gen-000003 · Todo 열림 · Workers 열림`; frame-todo row 0 ` Todo [0/0]  done:0 · drop:0`, row 1 구분선, footer ` Follow ON · EMPTY`; frame-workers row 0 ` Workers [0/0]  run 0`, row 1 구분선, footer ` Follow ON · EMPTY`; AC6.3에서 shim 제거 시 ext notify 없음. outer finally의 `--select generation-000003` exit 0, current/shim은 설치 직후 기록과 바이트 동일 (`task-9c-l6-userscope.log.txt`, `task-9c-l6-guard.json`, `task-9c-l6-frames.txt`).
- doctor: 설치 전 두 세대(`generation-000002` selected, `generation-000001` usable) -> 설치 후 세 세대(`generation-000003` selected, `generation-000001`/`generation-000002` usable), mismatches 없음. 정확히 한 세대만 추가되고 제거된 세대는 없다 (`task-9b-doctor-diff.txt`, `task-9c-doctor-post.json`, `task-9c-doctor-check.json`).
- state: l6가 만든 slot `d63e48d0...`과 data `5433373b...`는 l6가 스스로 제거했고, 종료 후 state는 baseline과 같다. l6/guard 프로세스와 `gjcdash-userscope` 세션은 남지 않았다 (`task-9c-state-compare.json`, `task-9c-l6-state-cleanup.json`, `task-9c-processes-after.txt`).
- 설치된 generation-000003 트리는 eaf4553의 repo 파일과 28/28 해시 동일하다 (`task-9c-installed-vs-repo.json`).
- 롤백 명령: `node scripts/install.mjs --agent-dir C:/Users/USER/.gjc/agent --select generation-000002` (또는 `generation-000001`; 이번 단계에서는 실행하지 않음).
- OMO protected는 전후 바이트 동일: wrapper `2ae22897...`, pointer `685978bb...`, main `6690857a...`, status 0 (`task-9c-protected-before.txt`, `task-9c-protected-after.txt`, `task-9c-protected-diff.txt`).
- 증거: `task-9c-release.txt` 및 위 파일들.

해시 표 (sha256; 트리는 정렬된 `<sha256>  <path>` manifest의 sha256):

| 항목 | 설치 전 (gen-2) | 설치 후 (gen-3) | l6 이후 |
|---|---|---|---|
| current.json | `42689392...` | `aa747c89...` | `aa747c89...` |
| shim | `75a25c93...` | `0dfaf4bb...` | `0dfaf4bb...` |
| generation-000001 tree | `a9adb2c0...` | `a9adb2c0...` | `a9adb2c0...` |
| generation-000002 tree | `b29388d6...` | `b29388d6...` | `b29388d6...` |
| generation-000003 tree | - | `6a165014...` | `6a165014...` |
| models.yml | `29747daa...` | `29747daa...` | `29747daa...` |

gjc sessions that are already open keep generation-000002 (or generation-000001) until they are restarted (PROVENANCE.md:238); restart them to see the new panes.

### 사용자 범위 설치 (generation-000004)

소유자 승인(answer #299 "A · 세대 4 설치 후 재촬영·F1~F4 재검토")에 따라 generation-000004를 설치했다. push와 merge는 하지 않았다.

- 단위: `node scripts/test.mjs` -> 688 tests, 688 pass, 0 fail, 0 skipped, 0 todo; 실패 이름은 기준선(593 pass, 0 fail)과 같다 = 없음 (`task-9d-unit.txt`, `task-0-baseline-failing.txt`).
- 패키지 스모크: scratch agent dir에 `--lang ko` 설치 exit 0 (`generation-000001`, 29 files); `scripts/verify-package.mjs` exit 0, `pass:true`, 28 required files, `importOk:true`, `defaultExport:"function"`, `localeHeader:"ext gen-000001"`, shim `targetMatches:true` (`task-9d-package-install.json`, `task-9d-package-verify.json`).
- 실제 설치: `--dry-run` exit 0 -> `generation-000004`, `previous: generation-000003`; 설치 exit 0 (29 files); 설치된 트리 verify-package exit 0, `pass:true`, `localeHeader:"ext gen-000004"` (`task-9d-install-dry-run.json`, `task-9d-install.json`, `task-9d-verify-installed.json`).
- l6-userscope: `--confirm-user-scope` PASS (exit 0, 124074 ms). notify `ext gen-000004 · Todo 열림 · Workers 열림`; frame-todo row 0 ` Todo [0/0]  done:0 · drop:0`, row 1 구분선, footer ` Follow ON · EMPTY`; frame-workers row 0 ` Workers [0/0]  run 0`, row 1 구분선, footer ` Follow ON · EMPTY`; AC6.3에서 shim 제거 시 ext notify 없음. outer finally의 `--select generation-000004` exit 0, current/shim은 설치 직후 기록과 바이트 동일 (`task-9d-l6-userscope.log.txt`, `task-9d-l6-guard.json`, `task-9d-l6-frames.txt`).
- doctor: 설치 전 세 세대(`generation-000003` selected, `generation-000001`/`generation-000002` usable) -> 설치 후 네 세대(`generation-000004` selected, 나머지 usable), mismatches 없음. 정확히 한 세대만 추가되고 제거된 세대는 없다 (`task-9d-doctor-pre.json`, `task-9d-doctor-post-install.json`, `task-9d-install-diff.json`).
- state: l6가 만든 slot `d63e48d0...`과 data `0b10dff9...`는 l6가 스스로 제거했고, 종료 후 state는 baseline과 같다. l6/guard 프로세스와 `gjcdash-userscope` 세션은 남지 않았다 (`task-9d-state-compare.json`, `task-9d-l6-state-cleanup.json`, `task-9d-processes-after.txt`).
- 설치된 generation-000004 트리는 ebff37d의 repo 파일과 28/28 해시 동일하다 (`task-9d-installed-vs-repo.json`).
- 롤백 명령: `node scripts/install.mjs --agent-dir C:/Users/USER/.gjc/agent --select generation-000003` (또는 `generation-000002`/`generation-000001`; 이번 단계에서는 실행하지 않음).
- OMO protected는 전후 바이트 동일: wrapper `2ae22897...`, pointer `685978bb...`, main `6690857a...`, status 0 (`task-9d-protected-before.txt`, `task-9d-protected-after.txt`, `task-9d-protected-diff.txt`).
- 증거: `task-9d-release.txt` 및 위 파일들.

해시 표 (sha256; 트리는 정렬된 `<sha256>  <path>` manifest의 sha256):

| 항목 | 설치 전 (gen-3) | 설치 후 (gen-4) | l6 이후 |
|---|---|---|---|
| current.json | `aa747c89...` | `d3beac1b...` | `d3beac1b...` |
| shim | `0dfaf4bb...` | `f56d09b5...` | `f56d09b5...` |
| generation-000001 tree | `a9adb2c0...` | `a9adb2c0...` | `a9adb2c0...` |
| generation-000002 tree | `b29388d6...` | `b29388d6...` | `b29388d6...` |
| generation-000003 tree | `6a165014...` | `6a165014...` | `6a165014...` |
| generation-000004 tree | - | `12ab1141...` | `12ab1141...` |
| models.yml | `29747daa...` | `29747daa...` | `29747daa...` |

gjc sessions that are already open keep generation-000003 until they are restarted (PROVENANCE.md:238); restart them to see the new panes.

## L0

실행 환경: Windows, Node v24.12.0, Herdr 0.9.3, gjc 0.18.11. 라이브 프로브는 harness가 만든 별도 Herdr session `gjcdash-probe`에서만 실행했다. 소유자 pane에는 입력하지 않았다.

| Gate | 기대값 | 실측 | 판정 | 증거 |
|---|---|---|---|---|
| G0 | `repositoryBinding` = sibling | no-op executor의 git toplevel = `C:/Users/USER/orca/projects/gjc-herdr-dashboard` | PASS | `.evidence/L0/G0-binding.txt` |
| B1·B2 | 기록 | B1 759개 중 746 pass, 13 fail. 계획 기대(746/758, 12 fail)와 다르므로 `B1-isolated`. B2 파일 34개 | 기록됨 | `baseline-omo.json`, `b1-report.txt` |
| G1 | 0.18.11이 project-scope 절대 URL `.js` shim을 로드, factory 1회 | 로드됨. factory 1회. `import.meta.url`은 실제 `spike/probe-ext.mjs` 경로. 프로세스 cwd = case 디렉터리(project dir = cwd) | PASS | `probe-g1-headless.jsonl`, `probe-g2-interactive.jsonl` |
| G2 | `send-text /dashboard` + `send-keys enter` 후 프레임에 notify | 슬래시 자동완성 때문에 `/dashboard` 전체를 한 번에 보내면 Enter가 입력되지 않았다. `/dash` 입력 후 자동완성이 열린 상태에서 `board`를 추가하고 Enter를 보내면 핸들러가 실행되고 프레임에 `PROBE-DASHBOARD-OK`가 보였다 | PASS (입력 절차 주의) | `G2-frame2.txt`, `probe-g2-interactive.jsonl` |
| G3 | main/sub의 kind·hasUI·isTTY | **대화형 main**: `sessionMetadata.kind="main"`, `taskDepth=0`, hasUI=true, isTTY=true. **대화형 main 아래의 서브에이전트(`task`, executor)**: `kind="sub"`, `taskDepth=1`, `currentAgentType="executor"`, **hasUI=false**, isTTY=true(대화형은 sub도 같은 터미널의 stdout을 공유하므로 isTTY만으로는 구분할 수 없다). print 모드: main hasUI=false, sub hasUI=false/isTTY=false. 세션마다 factory가 한 번씩 호출됨(인스턴스: main 1 + sub 1). `ctx.mode`는 없음. 판별 기준은 `sessionMetadata.kind`와 hasUI이고 isTTY는 쓰지 않는다 | PASS | `probe-interactive-no-session.jsonl`, `probe-g3-g5-fg.jsonl` |
| G6 | split/rename/run/list/layout/process-info/read/close, viewer `HERDR_PANE_ID` | split(`--no-focus`), rename, layout(`--pane`), process-info(`--pane`), run, wait-output, read, close 모두 성공. viewer에서 `HERDR_PANE_ID=w2:p2`와 HERDR_* 9개 키 확인. 부모 포커스 불변은 아래 "G6 포커스" 행 | PASS | `probe.jsonl` |
| G7 | 사용할 명령이 존재 | `pane list/layout/process-info/read/rename/split/close/send-text/send-keys/wait-output/run`, `tab create/get/focus/rename/close`, `session list/attach/stop/delete`, `workspace create/...` 존재 | PASS | `G7-*.txt` |
| G9 | 보관한 ctx로 1s 타이머 `getLeafId`, switch 뒤 `getSessionId` | 시작 시 보관한 ctx로 2s 간격 호출(`G9-interval`)을 `/new` 전후로 계속 실행했다. `/new`(`session_switch`) 뒤에도 보관 ctx의 `sessionManager.getSessionId()`/`getLeafId()`는 예외 없이 string을 반환했다(전환 후 호출 7회 이상). 단 보관 ctx가 새 sessionId를 보는지 옛 것을 보는지는 값 비교를 하지 않아 모른다(타입만 기록). `/resume`·`/fork` 뒤는 미측정 | 부분(예외 없음은 확인, 값의 신선도는 모름 -> 계획의 실패 경로 "이벤트로 갱신"을 기본으로 채택) | `probe-interactive-no-session.jsonl` |
| G10 | `process.kill(pid,0)`: 자기/죽은/타 사용자 | Bun 1.4.0과 Node 모두 자기=true, 존재하지 않는 pid=ESRCH, 시스템 pid 4=EPERM | PASS | `.sandbox/g10.mjs` 실행 출력 |
| G11 | `pi.on` 반환값 | undefined. `ctx.mode` 없음 | PASS(기록) | probe jsonl |
| G12 | `/reload`·`/new`·`/resume`·`/fork` 이벤트 순서, reload 때 이전 인스턴스가 shutdown을 받는지 | `/new`(대화형, `--no-session`): main에서 `session_before_switch`(reason=new) -> `session_switch`(reason=new)이고 factory 재호출 없음, 같은 프로세스. `session_shutdown`은 sub 세션 종료에서만 관측됨. `/fork`는 `--no-session`에서 `Error: Fork requires a persisted session`으로 불가. `/resume`은 저장된 세션이 있어야 하는데 이 환경에서 persisted 대화형 시작이 공용 SDK 인덱스 락(`~/.gjc/agent/sdk/sessions/index.jsonl.lock`)에 막혀 측정하지 못했다. `/reload`는 slash 명령이 아니라서 측정하지 못했다. `SessionSwitchEvent.reason`은 `"new"|"resume"|"fork"`로 선언돼 있다 | 부분(`/new`만 실측; 나머지는 §7.1③의 동일 sessionId+동일 moduleUrl 교체 규칙이 reload를 덮는다) | `probe-interactive-no-session.jsonl`, `probe-g12-new.jsonl` |
| U9 | split/close 20회 | 20회 성공, id 목록 기록. id는 재사용되지 않고 증가 | PASS | `probe.jsonl` |
| U10 | 새 pane에서 `exit` | pane이 list에서 사라짐 | PASS | `probe.jsonl` |
| U12 | split 직접 명령·label 옵션 | split 옵션: `--pane --current --direction --ratio --cwd --env --right-click --focus --no-focus`. 직접 명령/label 옵션은 없음 | 기록 | `probe.jsonl` |
| G13 | `GJC_CODING_AGENT_DIR`로 바꾼 agent-dir의 `extensions/*.js`를 project-scope에서 로드(드릴용) | **정정: user-scope 로드는 확인하지 못했다.** 앞선 PASS는 같은 case 디렉터리의 project-scope shim(`work/.gjc/extensions/`)이 남아 있어서 생긴 오판이었다. project-scope shim을 제거하고 다시 돌리면 `GJC_CODING_AGENT_DIR`로 지정한 agent-dir의 `extensions/`는 로드되지 않았다(`probe-g13v` 재현). 같은 환경변수로 실행한 `gjc config path`도 `C:\Users\USER\.gjc\agent`를 출력했고, 대화형 시작은 여전히 `C:\Users\USER\.gjc\agent\sdk\sessions\index.jsonl.lock`을 잡으려 했다. 즉 이 0.18.11 바이너리는 이 환경에서 `GJC_CODING_AGENT_DIR`를 따르지 않는다(원인은 미확인) | FAIL(user-scope 드릴 불가) -> 계획 경로: 드릴은 dev shim 경로로만 하고 L6 사용자 범위 드릴은 소유자 승인 아래에서 | `.sandbox/probe-g13v` 재현 명령 |
| U7 | socket `events.subscribe` -> `pane_focused` | Windows에서 `\\.\pipe\<HERDR_SOCKET_PATH 전체>` 형태로 연결(omo와 동일). subscribe ack 후 `pane_focused`, `tab_focused`, `workspace_focused` 수신 | PASS | `probe.jsonl` |
| G6 포커스 | `split --no-focus` 전후 focused 집합 불변 | `[w1:p1]` -> `[w1:p1]` | PASS | `probe.jsonl` |
| U11 | 셸 종류, trailer, 한글·공백 인용 | 셸은 Windows PowerShell(5.1). `pane run`으로 한글·공백 경로와 따옴표 인자가 그대로 전달됨 | PASS | 명령 출력 |
| U13 | 별도 Herdr session 생성 | `herdr --session <name> server`를 detached로 띄우면 별도 session이 생성됨(`gjcdash-probe`). `workspace create`는 기본이 focus 아님 | PASS | 명령 출력 |
| G4 | `/todo` 추가 + `todo_write` 1회 후 branch에서 phases 발견 | `ctx.getTodoState()`가 `[{name, tasks:[{content, status}]}]`를 반환(print 모드, `turn_end`/`agent_end`에서 호출). `/todo` 슬래시 편집은 이벤트가 없어 실측하지 않음(계획 E11) | PASS(대체 경로 `getTodoState()`) | `probe-g4-todo.jsonl` |
| G5 | foreground 1 + background 1 서브에이전트 | main bus(`pi.events`)에서 `task:subagent:lifecycle`(keys: agent, agentSource, description, id, index, sessionFile, status; `status:"started"`), `task:subagent:progress`, `task:subagent:event`를 수신(2개 병렬 실행에서 205건). `tool_execution_update`(task)의 `details.async.state`는 running -> completed이고 `details.progress[]`가 pending -> running -> completed로 바뀐다. `ctx.getJobs()`는 `{running:[{id,label,type:"task",status,startTime,endTime,metadata}], recent, delivery}`. `task`는 기본 async(background job)이고 `subagent await`로 기다려도 같은 경로로 관측된다. 별도의 foreground 전용 경로는 이 빌드에서 확인되지 않았다 | PASS(main bus 이벤트 + `getJobs`) | `probe-g3-g5-fg.jsonl`, `probe-g5-bg-await.jsonl` |
| G8 | production 형태 shim, R4의 두 트리 | (i) dev 트리 `.sandbox/g8-tree-dev/`와 (ii) 세대 트리 `.sandbox/case-probe-gen/.gjc/herdr-dashboard/generation-000001/`를 각각 절대 URL 재수출 shim으로 gjc가 로드. 둘 다 entry `import.meta.url`이 실경로(`gjc-legacy-pi-file` mirror 아님), `ROOT_URL=new URL("./", import.meta.url)`, `locale/ko.json` 읽기·파싱 성공, `src/viewers/common.mjs` R_OK 성공. Node로 직접 실행한 probe viewer가 `new URL("../../", import.meta.url)` ROOT의 locale(`locale-ko-ok`)을 출력. (ii)의 state dir 규칙(`generation-\d{6}` + 부모 `herdr-dashboard`)은 `…/herdr-dashboard/state`로 계산되고 (i)은 null | PASS | `probe-g8-dev.jsonl`, `probe-g8-gen.jsonl`, `probe-g8-viewer.txt` (두 트리에서 `node src/viewers/todo/viewer.mjs` 직접 실행: 둘 다 exit 0, `VIEWER-ROOT file:///…/g8-tree-dev/` 및 `…/generation-000001/` 출력 + `locale-ko-ok`) |
| M1 | todo 숨김 설정 | 없음. `todo.enabled`(도구 활성), `todo.reminders*`, `todo.eager`만 있고 위젯을 숨기는 설정은 없다 | 폐기 유지 | `settings-schema.ts:2766-2800` |
| K1 | 서브에이전트 cost 변화 | `details.progress[].cost`는 모든 시점에서 0이고 `tokens`만 0 -> 약 13.7k로 증가한다(구독 모델이라 비용이 보고되지 않음). 따라서 cost 0은 "알 수 없음"으로 표시해야 한다(계획의 실패 경로 확정) | 확정(0 = 알 수 없음) | `probe-g3-g5-fg.jsonl` |
| SR1-SR9 | 정적 규칙 | `test/unit/static-rules.test.mjs` 생성. 제품 소스가 아직 없어 위반 0, 각 규칙이 심은 위반을 실제로 잡는지 자체 검증 포함. `node scripts/test.mjs`: 21 tests, 21 pass | PASS | 명령 출력 |
| F1 | `typeof ctx.getProjectProgress` | interactive에서 `undefined`(FAIL 예상대로). print 모드 ctx에는 함수가 있으나 대화형 main에는 없음 | 3번째 pane 생략 + 목표 1줄 | probe jsonl |

### 남은 항목 / 한계
- **G12** `/resume`·`/fork`·reload: 위 표. persisted 대화형 시작은 공용 SDK 인덱스 락(09:49 KST에 생긴 owner 기록 없는 빈 디렉터리)에 막힌다. `--no-session` 대화형은 락을 피해 시작되지만 fork/resume이 불가능하다. 이 락은 이 작업의 소유가 아니고 `file-lock.ts`가 소유 증명이 없는 락은 지우지 않으므로 건드리지 않았다. 환경변수로 agent-dir를 바꾸는 우회는 G13 정정대로 이 바이너리에서 따라지지 않았다.
- **G9** 전환 후 보관 ctx는 예외가 없음만 확인(값의 신선도는 미확인).
- **G13** user-scope 설치 드릴 불가(위 표). L6 드릴은 dev shim 경로 + 소유자 승인 아래의 사용자 범위 드릴로 진행한다.
- **G5** foreground 전용 경로는 이 빌드에서 확인되지 않았다(`task`는 기본 async).
- B1/B2 baseline 실패 13개 중 유지 기능 테스트의 적응은 L1 이후.
- **소유자 Go**: 2026-10-17 10:35 KST 소유자 지시 "멈추지 말고 완성해"로 L0 Go를 받음. Go는 위 부분/FAIL 항목(G9 값 신선도, G12 resume/fork/reload, G13 user-scope 드릴)을 한계로 인지한 채 L1 진행을 허가한다. 대응: 모든 ctx 사용은 이벤트로 갱신(G9), 이중 교체 규칙(G12), L6 사용자 범위 설치는 별도 소유자 승인(G13).

### 프로브 중 발생한 사고
G12 확인용 `/new` 입력 뒤 같은 pane에 `/reload`를 보냈는데, 그것은 slash 명령이 아니라 모델에게 보내는 일반 메시지가 되어 모델 호출(질문 도구 포함)이 한 번 일어났다. 소유자 자원에는 영향이 없고 harness 소유 pane에서만 일어났다. 이후 pane을 닫았다.

### L0 종료 처리
- `spike/`는 삭제했다(사본은 git 밖 `.evidence/L0/spike-src/`).
- harness가 만든 Herdr session `gjcdash-probe`는 workspace 2개를 닫고 `herdr session stop`으로 중지했다. 기존 session(`default`, `piomo`, `gen10qa` 등)과 소유자 pane `w1:pT5`는 건드리지 않았다.
- 소유자 Go(2026-10-17 10:35 KST)를 받은 뒤 이 기록을 확정했다. 보강 증거: `g10-output.txt`(G10 bun/node 단독 실행; gjc 프로세스 안에서의 실행은 아님), `g13-config-path.txt`(`gjc config path`가 환경변수 격리와 무관하게 `C:\Users\USER\.gjc\agent`를 출력). 아키텍트 비차단 지적(SR 자체검증 분기 보강, SR9 FAILPOINT/INSTALL 범위, SR5 verify-package import, G12 reload 실측 또는 AC4.7 축소, 제품 스캔 0개 가드, SR8 우회)은 L1 이월 항목이다.

## L1 (Todo pane, instance lifecycle and lock)

Unit: `node scripts/test.mjs` 357 tests, 357 pass (LT-1..LT-8 incl. LT-4 matrix, LT-6 clauses 1-3, A-29..A-32 obligations, SR1-SR9, R3 heartbeat-tick and viewer-failpoint argv). Reconciler stress: 15 repeated runs, 0 failures after replacing a timer-based wait with a deterministic gate. `live-wrapper.test.mjs` once failed a single full-suite run (`delay-run-25s` detach test, since deleted) and passed 6/6 isolated re-runs; the flag no longer exists.

Live (harness-owned Herdr session `gjcdash-l1`, interactive `gjc --no-session --no-title` in `.sandbox/case-lv1`, dev shim, GJC 0.18.11; session stopped and workspace closed afterwards; owner pane `w1:pT5` and all other sessions untouched):

| Item | Observed | Result | Evidence |
|---|---|---|---|
| AC1.1 open | `/dash` + `board` -> notify `ext dev · Todo 열림`; exactly one `GJC Todo · bbf6636f` pane right of the parent; parent stays focused | PASS | `.evidence/L1/LV-1/list-after-x3.json`, `layout.json` |
| AC1.4 `/dashboard` x3 | pane count stays 1, notify `정상`, parent focus unchanged | PASS | `LV-1/list-after-x3.json` |
| AC1.2 todo_write | a model-driven `todo_write`: `projection.updatedAt` (host clock right after the tool finished) -> row on disk 247 ms -> row visible on the viewer screen (pane read) 1166 ms (the file `.evidence/L1/LV-13b/ac1-2-todo-write.txt` was overwritten by a later re-run; the first L1 run measured 215/515 ms, the later one 247/1166 ms; the L4 re-run in `.evidence/L4/LV-13b/` measured 256/816 ms and 309/1153 ms in earlier L4 re-runs and 314 ms to disk / 1188 ms to the viewer screen in the run the file now holds; both inside the 2 s gate on disk and the 2 s screen span allowing the viewer's 1 s repaint); gate 2 s on the screen span; sampling 250 ms. `/todo append` emits no event (README 4.5); it was reflected after ~2.5 s through the 1 s leaf poll (recorded, not gated: G9 value freshness was never measured) | PASS (todo_write); recorded (/todo) | `.evidence/L1/LV-13b/{ac1-2-todo-write.txt,ac1-2-todo-append.txt}` |
| AC1.3 reopen | `f` -> `자동 추적 OFF`; `q` -> pane closes itself; `/dashboard` reopens with `자동 추적 ON`; the Setup phase is shown | PASS (after fix 2 below) | `LV-1/reopen-frame.txt` |
| AC1.7 external close | `kill-recovery.mjs`: the harness closed the viewer pane with `pane close`; the pane was gone; the next `/dashboard` answered `열림` (T4) and exactly one role pane existed again | PASS | `.evidence/L1/LV-7b/{external-close-reply.json,notify-after-external-close.txt}` |
| AC1.7 viewer kill | `node test/live/kill-recovery.mjs`: `taskkill` of the viewer pid from `roles/todo.ready.json`; the pane disappeared (U10, shell trailer `; exit`); the next `/dashboard` took T4 (`열림`, new pane, new viewer pid, exactly one role pane) | PASS | `.evidence/L1/LV-7b/` |
| AC1.9 disconnect (exit) | `l1-behaviour.mjs`: `/exit` -> the viewer showed `연결 끊김` 0.8 s after Enter in the retained L1 file (first run 0.9 s; the L4 re-runs 0.4-1.4 s, see `## L4`), asserted <= 5 s; the pane stayed | PASS | `.evidence/L1/LV-13b/{ac1-9-exit.txt,viewer-after-exit.txt}` |
| AC1.9 owner kill | `kill-recovery.mjs`: `taskkill` of the owner gjc without `/exit` (no `stoppedAt`); the viewer (default `pidAlive` probe) showed `연결 끊김` 10.1 s after the kill in the retained L1 file (`killToLabelMs` 10078; the first run measured 6.5 s, the L4 re-runs 8.9 s, 10.1 s, 9.3 s and 8.4 s; the file now holds the last run, `killToLabelMs` 8352), asserted <= 20 s measured from the kill (plan AC1.9). Product rule: a dead owner pid + heartbeat >= 10 s old (two missed 5 s beats) => disconnected (changed from 20 s after the first live run measured 20.2 s, which was inside no margin); a live pid is never disconnected by heartbeat age alone | PASS | `.evidence/L1/LV-7b/{ac1-9-timing.json,viewer-after-owner-kill.txt}` |
| AC1.10 / LV-13 | a prompt (`sleep 15` via bash) was sent with the dashboard open: parent `agent_status` sampled every 2 s read `idle,working x9,idle` (idle before, working during, idle after) and the role pane count stayed 1 throughout; no reporter verbs in product code (SR2) | PASS | `.evidence/L1/LV-13b/agent-status-samples.json` |
| AC1.11 / LV-11 | `/new` changed `scopeKey` (`99481bb1...` -> `18bfe5a5...` in the retained file; an earlier run showed `f62d...` -> `4068...`) and `scopeEpoch` 1 -> 2 in `slot.json`; the viewer pane id stayed `w1:p2` (`lv11.json`). `/resume` not measured (no persisted session under the shared SDK lock) | PASS for `/new` only | `.evidence/L1/LV-13b/lv11.json` |
| AC-G1 | before/after sha256 of the two protected omo files and the omo repo `main`/`status --porcelain`, around all five L1 live scripts (`node scripts/omo-protected.mjs`): identical (`ebe79288...`, `cdfb4d00...`, `main=fffed31f...`, 0 status lines) | PASS | `.evidence/L1/AC-G1-before.txt`, `AC-G1-after.txt` |
| AC1.13 (L1 exit) | LT-7 (a)-(h) pass in unit tests (`test/unit/reconciler.test.mjs` LT-7 a-h; the lock file protocol and its unlink audit in `test/unit/slot.test.mjs`); the busy notify carries the lock path and generation (instance test `busy` rows); the README documents manual recovery M1-M5 with preconditions and exact file behavior (`README.md` recovery section) | PASS (fakes; cross-process contention not live) | `test/unit/reconciler.test.mjs`, `test/unit/slot.test.mjs`, `README.md` |
| AC1.5 / LV-4 | gjc started without `HERDR_*`: notify `ineligible: outside-herdr`; no state dir created | PASS | `LV-4-outside-herdr.txt` |
| AC1.6 / LV-6 | one `task` subagent run: 0 Herdr mutations (no split/run/close/rename) in the wrapper log, 0 new state files besides lock/owner/ready/slot/data. Every Herdr call in the window (read-only `pane list` / `pane process-info` from the automatic pass) carries the main gjc pid (`ppid`). A GJC subagent runs inside that same process, so the live log cannot attribute calls to the sub session; that attribution (sub session makes 0 calls, no `/dashboard` effect) is proven by unit test LT-6 with fakes and by the sub-session gating code, not by this live row | PASS (mutations/files live; per-session attribution by LT-6 only) | `.evidence/L1/LV-13b/{lv6.json,lv6-calls-by-caller.json}` |

Defects found live and fixed (both missed by unit tests; regression tests added in `test/unit/viewer.test.mjs`):
1. The viewer repainted its first frame forever (the 1 s timer only redrew the cached frame), so a Todo written after the first paint never appeared. `paint()` now calls `refresh()`.
2. The viewer had no default Herdr client, so `q` never closed its own pane in a real run. It now uses the argv vector recorded in `slot.json.herdr`.
Also fixed from unit work: a throwing binding seam in `arm()` produced zero notifies (now one `failed:internal`).

Critic round 1 (`19-FinalCriticL1`, ITERATE) asked for live timing and protected-file evidence; the live rows above were re-measured accordingly (LV-13/LV-6/LV-11/AC1.2/AC1.9 in `test/live/l1-behaviour.mjs`, AC1.7 external close in `kill-recovery.mjs`, AC-G1 via `scripts/omo-protected.mjs`).
Not run live in L1: LV-5 adopt (L4), `/resume` (no persisted session under the shared SDK lock), cross-process lock contention (unit tests LT-7 a-d with fakes), G9 value freshness, G12 resume/fork/reload.
L1 architect re-review (HEAD b52655f): B1-B8 PASS, no HIGH blocker, APPROVE. Non-blocking items carried to L2+: the heartbeat tick checks only `roles.todo` (iterate ROLES when the workers role lands); the tick reuses the retained ctx without an in-flight guard; an in-flight pass or heartbeat can outlive `session_shutdown` (`writeOwner`/`markStopped` are not queued, pre-existing); `early-frame.txt` of LV-3 is empty because the pane label appears only after the first pass (the 5 s samples carry the no-row-before-25 s proof). Fixed after the review: a `q` during the failpoint delay now stops the viewer from starting timers/ready/heartbeat (unit test added).

Lock directory growth: one generation file pair per pass; four files remained after a long session, so the existing GC keeps it bounded.

### L1 live fault scripts (re-run by the caller; each script also self-cleans and records `verifiedAbsent`)

Harness: `test/live/{herdr-wrapper,fixture,case}.mjs` (wrapper logs every Herdr call and injects faults only through flag files; the fixture refuses input to any pane it did not create). Unit tests for the wrapper: `test/unit/live-wrapper.test.mjs`. The wrapper has exactly two fault flags (`fail-split-once`, `fail-list`); it never delays or edits a call (stage-05 R3 l.153).

| LV | Script | Observed | Result | Evidence |
|---|---|---|---|---|
| LV-2 | `node test/live/lt1-fault.mjs` | `fail-split-once` + `/dashboard` x2: first notify `실패(pane split: herdr-split)` with zero panes, second `ext dev · Todo 열림` with exactly one `GJC Todo` pane | PASS | `.evidence/L1/LV-2/` |
| LV-3 | `node test/live/lt3-delay.mjs` | dev shim `--viewer-failpoint ready-delay-25s`; a launch message made the model call `todo_write` (one pending row), then ONE `/dashboard` (a keystroke batch the input popup swallowed is re-sent, batch #2 here, harness race recorded in `notify-latency.txt`): first notify `열림` 2.5 s after the accepted batch (gate 15 s; R3 text says `pending`, the first call answers `opened` per T1/R5); wrapper log: 1 split, 1 run (49 ms and 53 ms, <5 s); 5 s `pane list` samples: 1 role pane, slot role `pending` and no data row until +25.6 s, slot role `ready` (T13) at +30.7 s; the frame then shows `lv3-row-alpha` and `자동 추적 ON · 실시간`; no second `/dashboard` notify in a 10 s quiet window | PASS | `.evidence/L1/LV-3/{samples.json,wrapper.log.jsonl,viewer-frame.txt,notify-latency.txt}` |
| AC1.7 / AC1.9 kills | `node test/live/kill-recovery.mjs` (see the rows above) | PASS | `.evidence/L1/LV-7b/` |
| LV-10 | `node test/live/l4-lock.mjs` | superseded by the L4 row below: the retained L1 file shows the second `/dashboard` was NOT delivered (`notify-second.txt` = `(no second notify)`), so it exercised only one call | not exercised (see L4) | `.evidence/L1/LV-10/` |

Reviewer round 1 (architect, HEAD `496c33f`) found three defects that the unit tests and the first LV-3 run had hidden; all are fixed and covered:
1. B1 `heartbeat-tick`: the host never ran the automatic pass on the 5 s tick, so a late viewer (T13) was never promoted without another `/dashboard`. Fixed in `instance.mjs` (pass runs only while the todo record is `pending`); instance test `R3: the 5 s heartbeat tick runs ...`.
2. B2 viewer failpoint: the launcher passed `--failpoint ready-delay-25s` but the viewer rejected the flag (exit 2, pane dropped) and read an unplanned env var instead. The flag is now parsed in `src/viewers/common.mjs` (SR9), the env var is gone, and the delay gates the ready write, the heartbeat, the repaint timer and the slot watcher. Tests feed the real `viewerArgs()` output to `parseViewerArgs` and run the interactive late viewer.
3. B3 owner probe: the viewer never probed the owner pid (`ownerAlive=null` meant always alive). It now uses `core/liveness.mjs#pidAlive` (only ESRCH is dead); unit test without an injected `alive`, plus the live owner-kill row above.
The earlier LV-3 PASS used a wrapper `delay-run-25s` flag that the plan deleted (R3 l.153) and never observed T13; that run and flag were removed and LV-3 was redone through the product failpoint.


## L2 (Workers pane and the two-role band)

Unit: `node scripts/test.mjs` 530 tests, 0 fail (report `.evidence/L2/test-report.txt`). New modules: `src/host/sources/workers.mjs`, `src/core/layout.mjs`, `src/viewers/workers/{render,viewer}.mjs`; changed: `launch.mjs` (anchor, direction, ratio), `reconciler.mjs` (two-role loop, planner, shape check), `instance.mjs` (ROLES, bus wiring, per-role tick). L1 tests changed because the band opens two panes: AC1.4 (2 splits then 0), AC1.2 (two projections per publish), LT-5 (foreign sibling now `partial:shape`, was `opened`).

| Item | What was run and observed | Verdict | Evidence |
|---|---|---|---|
| AC2.1 band | `l2-workers.mjs`: first `/dashboard` -> notify `Todo 열림 · Workers 열림`; `pane layout`: parent 60x40 at x=0, Todo 60x14 at (60,0), Workers 60x26 at (60,14); Todo holds 0.35 of the rows; floors hold; focus stays on the parent; `/dashboard` x3 leaves one Todo and one Workers pane (AC1.4) | PASS | `.evidence/L2/LV-7/{layout.json,list-after-open.json,notify-open-*.txt}` |
| AC2.2 parallel | two parallel `task` subagents (the prompt asked each to run a bash sleep; the model chose the commands, so the durations are what `workers-frames.json` records): the Workers frame showed both cards `실행 중` at the same time (not marked background), then both `완료`, auto-folded to one line; `c` expands them; failed/aborted have different glyphs and words (render and `l2-width.mjs` fixture) | PASS | `.evidence/L2/LV-7/{workers-frame-running,workers-frame-done,workers-frame-c}.txt`, `.evidence/L2/LV-7w/` |
| AC2.3 cost | host cost is 0 for this subscription model (K1); cards carry `cost: null`, the frame prints `비용 ?` | PASS | `workers.json.snapshot.json`, `workers-frame-c.txt` |
| AC2.5 assignment | the prompt asked the model to put the sentinel `SENTINEL-ASSIGNMENT-7c1` in each assignment (whether the model did is not independently recorded); it is in no Workers frame and in no state file (scan result asserted in `l2-workers.mjs`, not stored separately); the projection boundary itself (assignment never copied into a card) is pinned by `workers-source.test.mjs` | PASS | `LV-7/workers-frame-done.txt` and the file scan in `l2-workers.mjs` |
| AC2.6 background | a `task` run in the background showed as a card (`lvwbg 실행 중`, tool `bash`); depth > 1 is not shown (README limitation) | PASS | `LV-7/workers-frame-background.txt` |
| AC2.7 bus fault | unit only: a throwing bus handler -> `sourceError`, no throw into the host, Todo and `/dashboard` unaffected | PASS (unit) | `test/unit/band-pass.test.mjs` |
| AC2.8 foreign sibling | unit only (fake Herdr): `partial:shape`, foreign pane byte-identical, no mutation aimed at it. Not run live | PASS (unit) | `test/unit/band-pass.test.mjs`, `reconciler.test.mjs` LT-5 |
| AC-F4 width | the real Workers viewer process with `--width 24` and `--width 40` in Herdr panes (`l2-width.mjs`): all three card title lines and every status word (Running/Failed/Aborted) visible; at 24 columns titles are cut with `~` and the status stays; no line is wider than the width. The width is the viewer's own override, because the harness PTY does not follow the pane rect (see the L3 limit) | PASS | `.evidence/L2/LV-7w/{workers-24col,workers-40col}.txt` |
| Bus-fed cards are not background | live LV-7 first marked every card `[백그라운드]` because ctx.getJobs() lists the same runs; the bus now names the card and clears the job-only flag; unit test pinned | fixed | `workers-source.test.mjs` |
| L1 live scripts under the band | lt1-fault, lt3-delay (2 splits, 2 runs, each < 5 s), l4-lock (<= 2 splits, <= 1 pane per role), kill-recovery, l1-behaviour all PASS again | PASS | `.sandbox/run-*.txt` outputs of the final run |
| AC-G1 | protected omo files and the omo repo ref/status identical before/after the L2+L3 live run | PASS | `.evidence/L2/AC-G1-{before,after}.txt` |

## L3 (pointer and focus)

Unit: viewers route stdin through `terminalInput` (SGR pointer, DEC 1004 focus) and subscribe with `watchHerdrFocus`; `test/unit/pointer-todo.test.mjs` and `pointer-workers.test.mjs` cover wheel +-3 with clamping, click select (Workers: second click folds), drag, release, blur (follow ON, detail closed, drag ended), subscription failure (one notice, viewer keeps working), dispose, fragmented reports, and that mouse bytes no longer reach `key()`.

LV-8 (`node test/live/l3-pointer.mjs`, 19 observations, SGR reports sent with `pane send-text` only to the adopted role pane):

| Role | Observation | Verdict |
|---|---|---|
| Todo | follow starts ON; two wheel-down steps move the body by 6 lines and turn follow OFF; wheel up moves 3 back, stays OFF; the Workers pane's follow is untouched; moving focus to another pane and back returns follow ON (AC3.2); click turns follow OFF; drag keeps follow OFF and changes the visible body; a pane resize leaves the viewer alive (a redraw caused by the resize is NOT shown by this run; see the harness limit) | PASS |
| Workers | follow starts ON; wheel down turns follow OFF; wheel up keeps it OFF; the Todo pane's follow is untouched; blur returns follow ON; click and drag turn follow OFF; resize leaves the viewer alive (no resize-triggered redraw observed) | PASS |

Evidence: `.evidence/L3/LV-8/{observations.json,todo-*.txt,workers-*.txt,pty-size.txt}`.

**Harness limit (measured, recorded honestly).** The harness Herdr server is detached with no client attached; every pane PTY stays at the terminal size (120x40) after splits and resizes (`pane get` `viewport_rows` 40 for a 14-row pane rect; a node process reads `process.stdout` as 120x40 at all times). Consequences: (1) the Todo body overflows the PTY (60 rows), so wheel distance and drag scrolling were observed on Todo; the Workers body fits the PTY, so Workers wheel/drag distance is only unit-tested, and live it checks the follow flag; (2) the viewer's redraw-on-resize cannot be triggered by a pane resize here (unit-tested); (3) AC-F4 widths use the viewer's `--width`. In a user's attached Herdr window the PTY follows the pane, so these paths are exercised there. AC3.3 (subscription failure) is unit-tested; live the real subscription was established without a failure notice.

## G003 gaps carried forward
Not measured live: AC2.8 and AC2.7 (unit only), depth > 1 workers, `/resume` and reload with two roles (L4), Workers wheel distance and resize redraw in an attached window (harness limit above), cross-process lock with two roles (L4), user-scope install (L6).

Critic round 1 on G003 (`29-22-FinalCriticL3`, ITERATE) found: (1) wheel/drag/click used the stored `prefs.scroll` instead of the drawn `frame.scroll` after blur/resize/shrink; (2) a Herdr focus subscription that closed after it had started was silent; (3) the viewers resumed stdin but never paused it on close; (4) three claims stronger than their evidence (softened above; `pty-size.txt` records one pane rect and `viewport_rows` only, the 120x40 stdout size comes from the separate probes `probe-size*.mjs` in the sandbox, not an evidence receipt). Fixed in `src/viewers/{todo,workers}/viewer.mjs` and `src/terminal-input.mjs` with regression tests that fail on the previous source (`pointer-todo`, `pointer-workers`, `terminal-input` tests).


## L4 (restart adopt, coexistence, retention, corruption, lock)

Unit: `node scripts/test.mjs` 546 tests, 0 fail (two consecutive runs on the final source) (report `.evidence/L4/test-report.txt`, SR1-SR9 pass). Live evidence of every script was re-written under `.evidence/L4/<LV>/` (`GJC_LIVE_EVIDENCE_LEVEL=L4`, see `test/live/case.mjs`), so an L4 re-run no longer overwrites the files the L1-L3 rows cite. Before that switch the first L4 re-run did overwrite `.evidence/L1/*` for the scripts it re-ran; the L1 rows above quote the numbers those files now hold and the earlier numbers where they differed.

What changed in L4 (all with regression tests that fail on the previous source):
1. `reconciler.writeOwner` and `markStopped` touch only an absent or own owner record (a record in phase `reload`, same pid and the registry names the successor, is claimed by `writeOwner`); a foreign or corrupt record is left alone. `markStopped` is final: a heartbeat after it (or racing it) cannot erase the `stoppedAt` stamp (mutation-checked).
2. `instance.runAutoPass` asks `reconciler.ownerPhase` first and does nothing (no rebind, no data write, no slot write) unless the phase is `me`: after a restart the previous owner's last picture stays until an explicit `/dashboard` adopts the slot (R1; architect finding #1).
3. `heartbeatAt` moves only when the owner write really happened (#4).
4. `session_switch` is handled, and the poll also fires on a sessionId change; the session counted as followed advances only after a successful rebind, so a busy or failed rebind is retried by the next trigger (#7, mutation-checked).
5. Auto passes are coalesced (one running plus at most one trailing). Found live: while a subagent ran, hundreds of bus events per second queued 1,491 auto passes in front of the reconciler, so a `/new` rebound about 190 s late and `/exit` stamped `stoppedAt` late (the viewer showed `연결 끊김` 7.2 s after Enter, over the 5 s gate). The trigger sequence is kept with the fold (`ctxSeq`/`installedSeq`), so a folded trigger can never install an older context over a newer one, and a folded POLL pass keeps the poll's own error policy (`strict`) instead of being recorded as an ordinary auto error. `markStopped` is also no longer queued behind passes.
6. Critic round (`34-CriticL4Fixes`, ITERATE) found four HIGH races on this same commit; all are fixed with regression tests that fail on the previous source (each verified by deleting the guard and watching the test fail):
   * the explicit pass's own owner claim now runs inside the same short owner-IO section as the heartbeat and the shutdown stamp, so a pass suspended across `session_shutdown` cannot write a fresh record over the release it just stamped (`reconciler.test.mjs` "critic #1", hook seam `beforeOwnerWrite`);
   * `registryOwnerInstanceId` reports the LIVE registry entry, and `decideOwnerPhase` treats a record as a cooperative `reload` only when the registry names THIS instance, so a retired predecessor cannot reclaim its successor's record (`instance.test.mjs` "a retired instance cannot reclaim the successor's owner record");
   * the bus/`task`-triggered workers publish is owner-gated exactly like the automatic pass, so a bus event after a restart cannot write over the previous owner's Workers projection before `/dashboard` adopts (`band-pass.test.mjs` "critic #3");
   * a pass that was overtaken by a newer trigger abandons its rebind instead of moving the slot back to the obsolete session (`instance.test.mjs` "critic #5").
7. Teardown correctness instead of retrying deletes: `dispose()` returns the drain of every projection write the instance scheduled (`dataWriter.flush`), and both viewers return their pending preference-save chain from `stop()`. With that, the four test files no longer need `maxRetries` on `rm` (removed and re-verified: six consecutive runs of `instance`+`reconciler`+`latch`+`band-pass` are green, and the pointer/viewer pair is green six times in a row).

| Item | What was run and observed | Verdict | Evidence |
|---|---|---|---|
| AC4.1 / LV-5 restart adopt | two roles open, `/exit` (viewers show `연결 끊김`, owner has `stoppedAt`), gjc started again in the same pane, `/dashboard` -> notify `Todo 인계 · Workers 인계`; pane ids unchanged (todo w1:p2, workers w1:p3), tab still has 3 panes, both viewers drop `연결 끊김`, owner.json names the new pid without `stoppedAt`, slot names the same panes | PASS | `.evidence/L4/LV-5/` |
| AC4.6 retention | a 30 day old and a 1 day old inactive scope seeded before the restart: the 30 day scope (data + prefs) is gone after arm, the 1 day scope and the current scopes stay, `slots/` listing identical | PASS | `.evidence/L4/LV-5/result.json` |
| AC4.4 / T18 corruption | slot file overwritten with invalid JSON: next `/dashboard` -> `Todo 열림 · Workers 열림`, `slot.json.corrupt-<ts>` exists, new role panes created, old viewer panes gone, one pane per role, next `/dashboard` -> `정상` | PASS | `.evidence/L4/LV-5/` |
| AC4.5 / LV-9 coexistence | three plain shell panes named `DAG · x`, `OmO DAG`, `OmO Todo · x` (no omo process): (a) each in its own tab -> `Todo 열림 · Workers 열림`; (b) all in the parent tab -> `Todo 부분 완료(배치 모양: shape) · Workers 부분 완료(공간 부족: size)`; id, label, tab and process info of the foreign panes identical before/after, every created pane is `GJC Todo/Workers` | PASS | `.evidence/L4/LV-9/` |
| AC4.3 / LV-10 lock | `l4-lock.mjs` types the two `/dashboard` commands back to back and counts the notify lines each PAIR produced (`attempts.json`: `notifiesBefore`, `pairNotifies`, `pairLines`). The TUI can swallow a keystroke, so a pair that produced fewer than two lines is re-sent as a pair; only the last pair's own lines count, so lines from an earlier attempt never complete a later pair. In the final run attempt 1 produced 1 line (a keystroke was lost) and attempt 2 produced 2 (`Todo 정상 · Workers 정상` twice, 2 splits in total = one band, one pane per role). The variant AC4.3 asks for - both calls overlapping while the band does NOT exist yet - was not produced by a single pair in this run: the overlapping pair that did land met an already open band (the existing-band case). Cross-process lock contention stays unit-only (LT-7 a-d with fakes) | PASS (live: same process, one pair delivered on an open band; AC4.3 first-open overlap and cross-process NOT exercised live) | `.evidence/L4/LV-10/{attempts.json,delivered.json,notices.json,wrapper.log.jsonl}` |
| AC4.7 reload | `/reload` is not a slash command in this build: typed in the 0.18.11 TUI it is sent to the model as an ordinary prompt (the model started an autoresearch intake; `.evidence/L4/LV-14/reload-typed-as-prompt.txt`, an ad-hoc probe whose own run ended `FAIL live-not-idle`; the probe script was deleted, not committed). Covered by unit tests only: LT-6 (same session + same module replaces the instance; now asserts `owner.json` names the successor), LT-4, `transitions` phase `reload` | PASS (unit), live NOT run | `instance.test.mjs` LT-6/LT-4 |
| L1-L3 scripts re-run on the final source | l4-adopt, l4-coexist, l4-lock, kill-recovery, l1-behaviour, lt1-fault, lt3-delay, l2-workers, l2-width, l3-pointer: all PASS in one pass; `l1-behaviour` 5 further consecutive runs PASS (`/exit` -> `연결 끊김` 0.5, 1.4, 0.8, 1.1, 0.5 s after Enter; gate 5 s). Owner kill (kill-recovery) showed `연결 끊김` 8.9 s after the kill (gate 20 s) | PASS | `.evidence/L4/*` |
| AC-G1 | protected omo files and omo ref/status identical before/after the final L4 live set | PASS | `.evidence/L4/AC-G1-{before,after}.txt` |

`l1-behaviour` flake history, all runs (the `/new` assertion): before the `session_switch` handler 4 of 7 runs failed; with it 5 of 5 passed, then 2 of 11 later runs failed (1 of 3, then 1 of 6, with the script loosened in between: retries 3 -> 6, idle wait, 20 s window) - the cause was the auto-pass queue backlog above, not input loss (the frame showed `New session started` while the slot still named the old session). With coalescing: 8 of 8 PASS, then the full set and 5 further runs PASS.

Defects found by L4 live runs and fixed: (1) the restarted process's first heartbeat overwrote the previous owner record so `/dashboard` reported `ready` instead of `adopted`; (2) a `/new` rebound late; (3) the auto-pass queue grew without bound while a subagent was publishing progress; (4) the unit teardown `rm` of the temp state directory raced a late write and failed `ENOTEMPTY` intermittently (now fixed at the source: `dispose()` and `viewer.stop()` return their pending writes).

Final L4 run on the committed source (architect round 3, `7c81a7d`): `node scripts/test.mjs` 546/546 (two consecutive runs, report `.evidence/L4/test-report.txt`), all ten live scripts PASS on the first attempt, AC-G1 before/after identical. The run before it (`5f2c264`, same product code except the arm re-check) had one harness-precondition failure: `kill-recovery` `live-not-idle` (the parent pane was not idle within 120 s at launch, before any assertion), which passed on the immediate re-run. `l3-pointer` had failed three times with `the parent returned to idle`; the same failure reproduced on `a082df4` and `ee6b165`, so it predates the critic round. This build reports `done` (not `idle`) for a finished turn on some prompts and the helper only accepted `idle`; the gate now means what it is used for - the turn ended (`status !== working`) - and records the samples in `.evidence/L4/LV-8/idle-*.json` (`working` x5 then `done`). The AC1.10 working -> idle sampling in `l1-behaviour` is unchanged and strict.

Architect round 3 (`35-34-ArchitectL4R3`, 0 HIGH, REQUEST CHANGES on two items) changed: (1) the explicit `/dashboard` no longer rebinds the slot before the pass's owner step and publishes only for a slot it owns after the pass, so `busy:other-owner` mutates nothing (`instance.test.mjs` "B1", mutation-checked: restoring the pre-pass rebind fails it); (2) `drain()` now waits for every fire-and-forget task (timer ticks, scheduled workers publishes, explicit passes) and loops until nothing is pending; (3) a folded trigger's `strict` is sticky; (4) the viewer heartbeat's in-flight write is returned by `stop()`; (5) the LV-10 accounting above; (6) the README reload sentence and two code comments now say that a same-process reload is handed over at arm time by the heartbeat.

L4 gaps: AC4.7 live reload; cross-process lock contention live; `/resume` and fork (no persisted interactive session under the shared SDK lock); foreign panes created by a real omo; a write that is already queued on the reconciler when `session_shutdown` lands can still reach disk after the owner stamp (the stamp itself is protected and `drain()` waits for it in tests); `arm()` re-checks `armed`/`disposed` after its first heartbeat await (the later `pruneOnce` await is not re-checked); `rebind()` takes the lock in `explicit` mode even for automatic triggers (retries on EEXIST instead of skipping, baseline behaviour, not changed).

## L5 (goal line, third pane omitted)

- F1 re-measure (GJC 0.18.11, interactive main): `typeof ctx.getProjectProgress === 'undefined'`, so no native Progress source exists and the third pane stays omitted; the band remains two roles. Evidence: `C:/Users/USER/orca/projects/gjc-herdr-dashboard/.evidence/L5/goalsurface/summary.json` (read-only main-checkout measurement; `f1-remeasure.json` and `probe-f1-rerun.jsonl` alongside).
- L5b source: `src/host/sources/goal.mjs` projects `{objective, status, tokensUsed, timeUsedSeconds}` from `ctx.getGoalState()` (primary) and the `goal_updated` payload (fallback); id, provenance, createdAt and updatedAt never cross. Unit tests: `test/unit/goal-source.test.mjs`.
- Host: every explicit/automatic pass publishes `data/<scopeKey>/goal.json` only after the owner-phase gate; the automatic path is the existing coalesced pass (one running + one trailing) and the 200 ms writer merge. `goal_updated` is the trigger; `dispose()`/`drain()` still flush the write. Unit tests: `test/unit/instance.test.mjs` "L5b: ..." (4 tests, including a foreign-owner no-write case and a 30-event burst).
- Render: one goal row at the top of the Todo pane (`◎ <objective> · <status> · <tokens> · <elapsed>`), only the objective is fitted; no goal means no row and no blank. Matrix 34/52 x ko/en/zh-cn: `test/unit/goal-render.test.mjs` (footer content and width asserted). Viewer read/clear: `test/unit/viewer.test.mjs` "L5b: ...".
- Units: `node scripts/test.mjs` -> 575 tests, 575 pass, 0 fail (includes SR1-SR9). The locale test's ROOT check was made worktree-safe (it used to require the checkout basename `gjc-herdr-dashboard`; the `ROOT/locale/<lang>.json` contract is unchanged).
- Live: `node test/live/l5-goal.mjs` with `HERDR_BIN_PATH=C:\Users\USER\AppData\Local\Programs\Herdr\bin\herdr.exe` -> PASS. `frame-before` had no `◎`; after `/goal reply with the single word ok and stop` the gjc status line showed `🎯 Goal`, and the Todo pane showed the row 440 ms later (gate 2000 ms): `◎ reply with the single word ok and stop · 진행 · 0 토큰 · 0초`; footer `자동 추적 ON · 원본 비어 있음`. Cleanup verified the session, workspace and tab absent. Evidence: `.evidence/L5/LV-goal/{result.json,frame-before.txt,gjc-goal-status.txt,frame-goal.txt,layout-parent.json,layout-todo.json,notify-open.txt,cleanup.json}`.
- Live limitation: this host's GJC profile `m1` has no `openai-codex` credentials (`profile unavailable: m1` in the parent frame), so the goal's model turn did not run and `tokensUsed`/`timeUsedSeconds` stayed 0. The goal-mode status line and the Todo row were still produced; the compact `215K` format is covered by the unit matrix.
- L5 gaps: no live run with a non-zero goal token/time counter (blocked by the missing model credentials); the third pane remains omitted by design.

## L6 (generation packaging, installer, package verification, D1-D4)

L6 adds `scripts/build.mjs` (strict runtime file set + `config.json`), `scripts/install.mjs`
(`--agent-dir`, `--lang`, `--dry-run`, `--select`, `--remove`, `--doctor`, the four D3 failpoints) and
`scripts/verify-package.mjs` (required files, marker, config, locale header, absolute-URL import smoke,
optional shim check). The installed generation's language is wired into the instance: an unset
`GJC_HERDR_DASHBOARD_LANG` now falls back to the generation's own `config.json.lang` (AC-F2); an
invalid env value still wins and reaches the viewer for its one-time notice.

Unit/static (final source): `node scripts/test.mjs` -> **563 tests, 563 pass, 0 fail, 0 skipped**.
`test/unit/install.test.mjs` covers fresh install, second install + shim switch, select, remove,
foreign-shim refusal, dry-run (nothing written), invalid `--lang`, every failpoint state and the
`--select` repair, plus build/verify failures (missing file, marker, config, non-function export,
shim env/failpoint). `test/unit/instance.test.mjs` has the config-language row. SR1-SR9 pass; SR5 now
permits only explicit absolute-URL dynamic imports and SR9 allows the install failpoint in
`scripts/install.mjs` only. `test/unit/i18n.test.mjs` was generalized from a literal checkout-folder
name to the real invariant (ROOT_URL = repo root); the old assertion failed only because this
worktree is named `l6-install`.

Package verification (sandbox generation, `.evidence/L6/verify-package.json`):
`node scripts/verify-package.mjs .sandbox/install-smoke/.gjc/herdr-dashboard/generation-000001` ->
`pass:true`, 27 required files, `importOk:true`, `defaultExport:"function"`,
`localeHeader:"ext gen-000001"`, no errors. A managed shim checked in the same path had
`targetMatches:true`, `envDefaults:false` and `failpointPlumbing:false`. The build CLI produced
`generation-000001` with 27 runtime files plus `config.json` for `--lang zh-cn`.

Live drills: `node test/live/l6-drills.mjs` -> `l6-drills (D1-D4): PASS` (exit 0, one clean run
without input). Session `gjcdash-l6drill`, cwd and `--agent-dir` both
`<repo>/.sandbox/case-drill/.gjc`; every install used that agent dir, never the user scope.

| Drill | Observed | Evidence |
|---|---|---|
| D1 | install A (`--lang ko`) -> `ext gen-000001 · Todo 열림 · Workers 열림`; install B (`--lang en`) -> fresh gjc `ext gen-000002 · Todo adopted · Workers adopted` (A's viewers survive `/exit`, so R5's adopt keeps them); `--doctor` ok, shim `generation-000002` == `current.json` | `.evidence/L6/D1/` (`notify-a.txt`, `notify-b.txt`, `doctor.json`, `result.json`, frames) |
| D2 | `--select generation-000001` -> fresh gjc `ext gen-000001 · Todo 인계 · Workers 인계`; same `slot` schema `gjc-herdr-dashboard/slot/1`, same `layoutKey`, 3 data scopes in the same state dir; doctor ok | `.evidence/L6/D2/` |
| D3 | `after-gen-copy`, `after-shim-tmp`, `before-shim-rename`: install exits 2 and a fresh gjc still runs `gen-000001`, doctor ok. `after-shim-rename-before-current`: fresh gjc runs the new `gen-000006`, doctor exits non-zero with `selection-mismatch: shim generation-000006 != current.json generation-000001`; `--select generation-000001` repairs, doctor ok, fresh gjc back to `gen-000001` | `.evidence/L6/D3/` |
| D4 | `--remove` deletes only the managed shim; generations 000001-000006, `current.json` and `state/{data,slots}` stay. A fresh gjc's `/dashboard` produced **no** `ext ` notify (`notify-lines.json` = `[]`) and no `ineligible:`/`failed:` extension frame; `--doctor` reports not installed | `.evidence/L6/D4/` |

Cleanup: `.evidence/L6/cleanup.json` records the owned workspace, tab and session as
`verifiedAbsent:true`; no foreign pane was touched. Aggregate drill result:
`.evidence/L6/result.json`.

Not run: user-scope install (AC6.2/AC6.3) - it needs owner approval and this task is restricted to
sandbox/temp agent dirs; D1's second-session viewer generation replacement was not exercised because
the surviving A viewers are adopted by design (R5).
