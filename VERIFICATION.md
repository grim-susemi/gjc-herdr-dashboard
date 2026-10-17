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
| G3 | main/sub의 hasUI·isTTY | main(interactive): hasUI=true, isTTY=true. print 모드(`-p`): hasUI=false, isTTY=false. `ctx.mode`는 없음. 서브에이전트(`task` 도구) 실행 시 같은 프로세스(pid 동일)에서 factory가 한 번 더 호출되고, 그 ctx는 hasUI=false, isTTY=false다. 즉 sub는 hasUI=false로 판별된다 | PASS | `probe-g5-task-events.jsonl` |
| G6 | split/rename/run/list/layout/process-info/read/close, viewer `HERDR_PANE_ID` | split(`--no-focus`), rename, layout(`--pane`), process-info(`--pane`), run, wait-output, read, close 모두 성공. viewer에서 `HERDR_PANE_ID=w2:p2`와 HERDR_* 9개 키 확인. 부모 포커스 불변은 아래 "G6 포커스" 행 | PASS | `probe.jsonl` |
| G7 | 사용할 명령이 존재 | `pane list/layout/process-info/read/rename/split/close/send-text/send-keys/wait-output/run`, `tab create/get/focus/rename/close`, `session list/attach/stop/delete`, `workspace create/...` 존재 | PASS | `G7-*.txt` |
| G9 | 보관한 ctx로 1s 타이머 | 예외 없음. `getLeafId`, `getSessionId`는 string 반환 | PASS | probe jsonl |
| G10 | `process.kill(pid,0)`: 자기/죽은/타 사용자 | Bun 1.4.0과 Node 모두 자기=true, 존재하지 않는 pid=ESRCH, 시스템 pid 4=EPERM | PASS | `.sandbox/g10.mjs` 실행 출력 |
| G11 | `pi.on` 반환값 | undefined. `ctx.mode` 없음 | PASS(기록) | probe jsonl |
| G12 | `/new`·`/resume`·`/fork`·reload 이벤트 순서 | `/new`: `session_before_switch` -> `session_switch`. 같은 프로세스가 유지됨(pid 동일, factory 재호출 없음). `session_switch.reason`은 `"new"\|"resume"\|"fork"` 타입이다(`shared-events.ts`). `/reload`는 slash 명령이 아니라 확인하지 못했다. `/fork`는 메시지가 확정되지 않은 상태에서는 `No messages to branch from`이라 이벤트가 없고, `/resume`과 함께 실측하지 못했다 | 부분 | `probe-g12-new.jsonl` |
| U9 | split/close 20회 | 20회 성공, id 목록 기록. id는 재사용되지 않고 증가 | PASS | `probe.jsonl` |
| U10 | 새 pane에서 `exit` | pane이 list에서 사라짐 | PASS | `probe.jsonl` |
| U12 | split 직접 명령·label 옵션 | split 옵션: `--pane --current --direction --ratio --cwd --env --right-click --focus --no-focus`. 직접 명령/label 옵션은 없음 | 기록 | `probe.jsonl` |
| G13 | `GJC_CODING_AGENT_DIR=<case>/.gjc/agent`로 project-scope 밖 user-scope shim 로드 | `<dir>/extensions/*.js`가 로드됨(factory 실행, `import.meta.url`은 절대 URL 대상). 첫 시도는 `<dir>`을 `.gjc` 상위로 잘못 줘서 실패. `--agent-dir`은 CLI 플래그가 아니라 환경변수만 있음 | PASS | `.sandbox/probe-g13*.jsonl` |
| U7 | socket `events.subscribe` -> `pane_focused` | Windows에서 `\\.\pipe\<HERDR_SOCKET_PATH 전체>` 형태로 연결(omo와 동일). subscribe ack 후 `pane_focused`, `tab_focused`, `workspace_focused` 수신 | PASS | `probe.jsonl` |
| G6 포커스 | `split --no-focus` 전후 focused 집합 불변 | `[w1:p1]` -> `[w1:p1]` | PASS | `probe.jsonl` |
| U11 | 셸 종류, trailer, 한글·공백 인용 | 셸은 Windows PowerShell(5.1). `pane run`으로 한글·공백 경로와 따옴표 인자가 그대로 전달됨 | PASS | 명령 출력 |
| U13 | 별도 Herdr session 생성 | `herdr --session <name> server`를 detached로 띄우면 별도 session이 생성됨(`gjcdash-probe`). `workspace create`는 기본이 focus 아님 | PASS | 명령 출력 |
| G4 | `/todo` 추가 + `todo_write` 1회 후 branch에서 phases 발견 | `ctx.getTodoState()`가 `[{name, tasks:[{content, status}]}]`를 반환(print 모드, `turn_end`/`agent_end`에서 호출). `/todo` 슬래시 편집은 이벤트가 없어 실측하지 않음(계획 E11) | PASS(대체 경로 `getTodoState()`) | `probe-g4-todo.jsonl` |
| G5 | foreground 1 + background 1 서브에이전트 | `task` 도구는 기본 async다. `tool_execution_update`가 `details.progress[]`(id, agent, status pending→running→completed, tokens, cost, durationMs, recentTools 등)와 `details.async={state,jobId,type}`를 낸다. `ctx.getJobs()`는 `{delivery,recent,running}` 객체. foreground/background 구분 실측은 안 함 | PASS(`tool_execution_update`(task) + `getJobs`) | `probe-g5-task-events.jsonl` |
| G8 | production 형태 shim(세대 디렉터리 + 재수출) | `import.meta.url`이 실제 세대 경로, `new URL("../", import.meta.url)`로 상대 asset(locales) 읽기 성공 | PASS | `probe-g8.jsonl` |
| M1 | todo 숨김 설정 | 없음. `todo.enabled`(도구 활성), `todo.reminders*`, `todo.eager`만 있고 위젯을 숨기는 설정은 없다 | 폐기 유지 | `settings-schema.ts:2766-2800` |
| K1 | 서브에이전트 cost 변화 | `progress[].cost` 필드가 존재한다. 이번 프로브에서는 값의 증가 여부를 확인하지 못함 | 부분(0은 "알 수 없음") | `probe-g5-task-events.jsonl` |
| SR1-SR9 | 정적 규칙 | `test/unit/static-rules.test.mjs` 생성. 제품 소스가 아직 없어 위반 0, 각 규칙이 심은 위반을 실제로 잡는지 자체 검증 포함. `node scripts/test.mjs`: 21 tests, 21 pass | PASS | 명령 출력 |
| F1 | `typeof ctx.getProjectProgress` | interactive에서 `undefined`(FAIL 예상대로). print 모드 ctx에는 함수가 있으나 대화형 main에는 없음 | 3번째 pane 생략 + 목표 1줄 | probe jsonl |

### 남은 항목 / 한계
- G12 `/resume`·`/fork`·reload 이벤트 순서(`/new`만 실측). §7.1③의 분기 선택에 필요하므로 L1 시작 전 소유자 판단이 필요하다.
- G5 foreground/background 구분, K1 cost 증가 값.
- G3 대화형 모드에서의 서브에이전트 ctx(print 모드로만 실측).
- B1/B2 baseline 실패 13개 중 유지 기능 테스트의 적응은 L1 이후.
- `spike/` 삭제와 소유자 Go는 아직 하지 않았다.

### 프로브 중 발생한 사고
G12 확인용 `/new` 입력 뒤 같은 pane에 `/reload`를 보냈는데, 그것은 slash 명령이 아니라 모델에게 보내는 일반 메시지가 되어 모델 호출(질문 도구 포함)이 한 번 일어났다. 소유자 자원에는 영향이 없고 harness 소유 pane에서만 일어났다. 이후 pane을 닫았다.

### L0 종료 처리
- `spike/`는 삭제했다(사본은 git 밖 `.evidence/L0/spike-src/`).
- harness가 만든 Herdr session `gjcdash-probe`는 workspace 2개를 닫고 `herdr session stop`으로 중지했다. 기존 session(`default`, `piomo`, `gen10qa` 등)과 소유자 pane `w1:pT5`는 건드리지 않았다.
- 이 L0 기록은 소유자 Go를 받기 전의 **권고용 기록**이다. L1 구현은 시작하지 않았다.
