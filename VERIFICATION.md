# VERIFICATION

증거는 `.evidence/` 아래에 있고 git에서 제외된다. 아래 기록은 실제로 실행한 명령의 결과만 적는다.

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
| AC1.2 todo_write | a model-driven `todo_write`: `projection.updatedAt` (host clock right after the tool finished) -> row on disk 215 ms -> row visible on the viewer screen (pane read) 515 ms; gate 2 s on the screen span; sampling 250 ms. `/todo append` emits no event (README 4.5); it was reflected after ~2.4 s through the 1 s leaf poll (recorded, not gated: G9 value freshness was never measured) | PASS (todo_write); recorded (/todo) | `.evidence/L1/LV-13b/{ac1-2-todo-write.txt,ac1-2-todo-append.txt}` |
| AC1.3 reopen | `f` -> `자동 추적 OFF`; `q` -> pane closes itself; `/dashboard` reopens with `자동 추적 ON`; the Setup phase is shown | PASS (after fix 2 below) | `LV-1/reopen-frame.txt` |
| AC1.7 external close | `kill-recovery.mjs`: the harness closed the viewer pane with `pane close`; the pane was gone; the next `/dashboard` answered `열림` (T4) and exactly one role pane existed again | PASS | `.evidence/L1/LV-7b/{external-close-reply.json,notify-after-external-close.txt}` |
| AC1.7 viewer kill | `node test/live/kill-recovery.mjs`: `taskkill` of the viewer pid from `roles/todo.ready.json`; the pane disappeared (U10, shell trailer `; exit`); the next `/dashboard` took T4 (`열림`, new pane, new viewer pid, exactly one role pane) | PASS | `.evidence/L1/LV-7b/` |
| AC1.9 disconnect (exit) | `l1-behaviour.mjs`: `/exit` -> the viewer showed `연결 끊김` 0.9 s after Enter, asserted <= 5 s; the pane stayed | PASS | `.evidence/L1/LV-13b/{ac1-9-exit.txt,viewer-after-exit.txt}` |
| AC1.9 owner kill | `kill-recovery.mjs`: `taskkill` of the owner gjc without `/exit` (no `stoppedAt`); the viewer (default `pidAlive` probe) showed `연결 끊김` 6.5 s after the kill, asserted <= 20 s measured from the kill (plan AC1.9). Product rule: a dead owner pid + heartbeat >= 10 s old (two missed 5 s beats) => disconnected (changed from 20 s after the first live run measured 20.2 s, which was inside no margin); a live pid is never disconnected by heartbeat age alone | PASS | `.evidence/L1/LV-7b/{ac1-9-timing.json,viewer-after-owner-kill.txt}` |
| AC1.10 / LV-13 | a prompt (`sleep 15` via bash) was sent with the dashboard open: parent `agent_status` sampled every 2 s read `idle,working x8,idle` (idle before, working during, idle after) and the role pane count stayed 1 throughout; no reporter verbs in product code (SR2) | PASS | `.evidence/L1/LV-13b/agent-status-samples.json` |
| AC1.11 / LV-11 | `/new` changed `scopeKey` (`64b7...` -> `cabc...`) and `scopeEpoch` 1 -> 2 in `slot.json`; the viewer pane id stayed `w1:p2` (`lv11.json`). `/resume` not measured (no persisted session under the shared SDK lock) | PASS for `/new` only | `.evidence/L1/LV-13b/lv11.json` |
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
| LV-10 | `node test/live/l4-lock.mjs` | two `/dashboard` sent back to back in one parent: at most one split and one viewer pane, no lock/busy notify | PASS (single-parent only; true cross-process contention is covered by unit tests LT-7 a-d with fakes, not live) | `.evidence/L1/LV-10/` |

Reviewer round 1 (architect, HEAD `496c33f`) found three defects that the unit tests and the first LV-3 run had hidden; all are fixed and covered:
1. B1 `heartbeat-tick`: the host never ran the automatic pass on the 5 s tick, so a late viewer (T13) was never promoted without another `/dashboard`. Fixed in `instance.mjs` (pass runs only while the todo record is `pending`); instance test `R3: the 5 s heartbeat tick runs ...`.
2. B2 viewer failpoint: the launcher passed `--failpoint ready-delay-25s` but the viewer rejected the flag (exit 2, pane dropped) and read an unplanned env var instead. The flag is now parsed in `src/viewers/common.mjs` (SR9), the env var is gone, and the delay gates the ready write, the heartbeat, the repaint timer and the slot watcher. Tests feed the real `viewerArgs()` output to `parseViewerArgs` and run the interactive late viewer.
3. B3 owner probe: the viewer never probed the owner pid (`ownerAlive=null` meant always alive). It now uses `core/liveness.mjs#pidAlive` (only ESRCH is dead); unit test without an injected `alive`, plus the live owner-kill row above.
The earlier LV-3 PASS used a wrapper `delay-run-25s` flag that the plan deleted (R3 l.153) and never observed T13; that run and flag were removed and LV-3 was redone through the product failpoint.
