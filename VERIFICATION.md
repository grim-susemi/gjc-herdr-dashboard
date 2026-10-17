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
| G3 | main/sub의 kind·hasUI·isTTY | main(interactive): hasUI=true, isTTY=true. `-p` 모드: main kind=main depth=0 hasUI=false isTTY=false. 서브에이전트(`task`, executor)는 `sessionMetadata.kind="sub"`, `taskDepth=1`, `currentAgentType="executor"`, hasUI=false, isTTY=false이고 같은 프로세스에서 factory가 세션마다 한 번씩 호출됨(인스턴스 3개: main 1 + sub 2). `ctx.mode`는 없음. 대화형 main 아래의 sub는 락 문제로 실측하지 못했다(아래 한계) | PASS(`kind`와 hasUI로 판별 가능, 대화형 sub는 미실측) | `probe-g3-g5-fg.jsonl` |
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
| G5 | foreground 1 + background 1 서브에이전트 | main bus(`pi.events`)에서 `task:subagent:lifecycle`(keys: agent, agentSource, description, id, index, sessionFile, status; `status:"started"`), `task:subagent:progress`, `task:subagent:event`를 수신(2개 병렬 실행에서 205건). `tool_execution_update`(task)의 `details.async.state`는 running -> completed이고 `details.progress[]`가 pending -> running -> completed로 바뀐다. `ctx.getJobs()`는 `{running:[{id,label,type:"task",status,startTime,endTime,metadata}], recent, delivery}`. `task`는 기본 async(background job)이고 `subagent await`로 기다려도 같은 경로로 관측된다. 별도의 foreground 전용 경로는 이 빌드에서 확인되지 않았다 | PASS(main bus 이벤트 + `getJobs`) | `probe-g3-g5-fg.jsonl`, `probe-g5-bg-await.jsonl` |
| G8 | production 형태 shim, R4의 두 트리 | (i) dev 트리 `.sandbox/g8-tree-dev/`와 (ii) 세대 트리 `.sandbox/case-probe-gen/.gjc/herdr-dashboard/generation-000001/`를 각각 절대 URL 재수출 shim으로 gjc가 로드. 둘 다 entry `import.meta.url`이 실경로(`gjc-legacy-pi-file` mirror 아님), `ROOT_URL=new URL("./", import.meta.url)`, `locale/ko.json` 읽기·파싱 성공, `src/viewers/common.mjs` R_OK 성공. Node로 직접 실행한 probe viewer가 `new URL("../../", import.meta.url)` ROOT의 locale(`locale-ko-ok`)을 출력. (ii)의 state dir 규칙(`generation-\d{6}` + 부모 `herdr-dashboard`)은 `…/herdr-dashboard/state`로 계산되고 (i)은 null | PASS | `probe-g8-dev.jsonl`, `probe-g8-gen.jsonl` |
| M1 | todo 숨김 설정 | 없음. `todo.enabled`(도구 활성), `todo.reminders*`, `todo.eager`만 있고 위젯을 숨기는 설정은 없다 | 폐기 유지 | `settings-schema.ts:2766-2800` |
| K1 | 서브에이전트 cost 변화 | `details.progress[].cost`는 모든 시점에서 0이고 `tokens`만 0 -> 약 13.7k로 증가한다(구독 모델이라 비용이 보고되지 않음). 따라서 cost 0은 "알 수 없음"으로 표시해야 한다(계획의 실패 경로 확정) | 확정(0 = 알 수 없음) | `probe-g3-g5-fg.jsonl` |
| SR1-SR9 | 정적 규칙 | `test/unit/static-rules.test.mjs` 생성. 제품 소스가 아직 없어 위반 0, 각 규칙이 심은 위반을 실제로 잡는지 자체 검증 포함. `node scripts/test.mjs`: 21 tests, 21 pass | PASS | 명령 출력 |
| F1 | `typeof ctx.getProjectProgress` | interactive에서 `undefined`(FAIL 예상대로). print 모드 ctx에는 함수가 있으나 대화형 main에는 없음 | 3번째 pane 생략 + 목표 1줄 | probe jsonl |

### 남은 항목 / 한계
- **G12** `/resume`, `/fork`, reload 이벤트 순서: `/new`만 실측했다(`session_before_switch` -> `session_switch`, reason `new`, factory 재호출 없음). `SessionSwitchEvent.reason`은 `"new"|"resume"|"fork"`로 선언돼 있다. 대화형 `gjc`를 다시 띄우려 했으나 공용 SDK 인덱스 락(`~/.gjc/agent/sdk/sessions/index.jsonl.lock`, 09:49 생성)이 `acquire_timeout`으로 새 대화형 세션을 막았다. 그 락은 이 작업의 프로세스 소유가 아니어서 건드리지 않았다. §7.1③는 "같은 sessionId + 같은 moduleUrl이면 교체" 규칙이 reload를 덮으므로 분기 선택은 /new와 같은 `session_switch` 처리로 두고 L4에서 실측한다.
- **G9** switch 이후 보관 ctx 사용: 타이머는 switch 이전에만 실측했다. `session_switch` 후에는 이벤트로 갱신한다는 계획의 실패 경로를 기본으로 삼는다.
- **G3** 대화형 main 아래의 sub는 실측하지 못했다(위와 같은 락). print 모드의 sub 판별은 확인했다.
- B1/B2 baseline 실패 13개 중 유지 기능 테스트의 적응은 L1 이후.
- 소유자 Go는 아직 받지 않았다.

### 프로브 중 발생한 사고
G12 확인용 `/new` 입력 뒤 같은 pane에 `/reload`를 보냈는데, 그것은 slash 명령이 아니라 모델에게 보내는 일반 메시지가 되어 모델 호출(질문 도구 포함)이 한 번 일어났다. 소유자 자원에는 영향이 없고 harness 소유 pane에서만 일어났다. 이후 pane을 닫았다.

### L0 종료 처리
- `spike/`는 삭제했다(사본은 git 밖 `.evidence/L0/spike-src/`).
- harness가 만든 Herdr session `gjcdash-probe`는 workspace 2개를 닫고 `herdr session stop`으로 중지했다. 기존 session(`default`, `piomo`, `gen10qa` 등)과 소유자 pane `w1:pT5`는 건드리지 않았다.
- 이 L0 기록은 소유자 Go를 받기 전의 **권고용 기록**이다. L1 구현은 시작하지 않았다.
