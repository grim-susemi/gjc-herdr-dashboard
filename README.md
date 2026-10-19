# gjc-herdr-dashboard

GJC(Gajae Code)용 Herdr 대시보드 확장. omo의 herdr-dashboard가 제공하던 Todo·workers 패널을
GJC 네이티브 원천으로 다시 만들어, Herdr pane 안에서 현재 세션의 작업 상태를 본다.

- 상태: **L1 Todo + 수명주기 코어 진행 중.** 이 문서는 계획(`stage-03-revision` + `stage-05-revision`
  + A-29/C-14 delta)에 적힌 동작과 **실측된 L0 사실**만 적는다. 아직 검증하지 않은 동작은
  "미검증"이라고 표시한다.
- 증거: `.evidence/` (git 제외) · 실측 기록: `VERIFICATION.md` · 복사 출처: `PROVENANCE.md`
- 샌드박스: `.sandbox/` (git 제외)
- 테스트: `npm test` (= `node scripts/test.mjs`). `HERDR_*`를 지우고 `HOME`·`USERPROFILE`을
  임시 폴더로 바꿔 실행하므로 실제 Herdr나 사용자 홈을 건드리지 않는다.

## 1. 무엇을 하는가 (계획 기준)

아래는 계획과 `extension.mjs`·viewer 코드가 구현한 동작이다. 라이브 프레임·타이밍은 §4.12처럼
아직 검증 전이다.

- `/dashboard` 슬래시 명령 하나로 이 세션의 대시보드 pane을 연다. 계획상 다시 부르면 새 pane을
  만들지 않고 기존 pane을 다시 쓴다(T2/T6/T13, `adopted`·`ready`).
- 첫 역할은 **Todo**다. 계획상 `GJC Todo · <key8>` 제목의 pane이 부모 pane 오른쪽에 생기고,
  부모 pane의 포커스는 그대로 남는다(`pane split --no-focus`, L0 G6에서 focused 집합 불변을 실측).
- 데이터는 `<state>/data/<scopeKey>/todo.json`에 있고 viewer가 그 파일을 읽어 그린다. 상태 파일과
  데이터 파일의 위치·스키마는 `src/core/slot.mjs`가 정한다.
- Todo 투영(`gjc-herdr-dashboard/todo/1`)은 `ctx.getTodoState()`를 먼저 쓰고, 그 호스트 표면이
  없거나 깨졌을 때만 branch를 역순으로 되짚는다(§4.5).
- 세대 트리(`generation-NNNNNN/`)와 개발 트리(저장소 루트)는 **같은 상대 배치**를 쓴다. 자산은
  항상 진입 모듈의 ROOT URL 기준으로만 찾는다(`locale/<lang>.json`, `src/viewers/<role>/viewer.mjs`,
  `config.json`). 대체 경로나 탐색 fallback은 없다.

## 2. 요구 사항

| 항목 | 값 | 비고 |
|---|---|---|
| GJC | **0.18.11** | L0에서 실측한 버전. 다른 버전은 미검증 |
| Herdr | 필요 | `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`가 있어야 자격을 통과한다 |
| Node | **>= 24** | viewer 프로세스와 preflight가 `node --version`으로 확인한다 |
| OS | Windows에서 실측 | PowerShell 5.1 셸 기준으로 인용·trailer를 맞췄다. 다른 셸은 미검증 |

## 3. 자격 조건 (왜 안 열리는가)

`/dashboard`는 아래를 **순서대로** 검사하고, 처음 걸리는 이유 하나를 notify로 정확히 한 번 알린다
(`ineligible:<이유>`). `session_start`에서는 조용히 넘어간다.

| 순서 | 조건 | 실패 이유 |
|---|---|---|
| 1 | `ctx.sessionMetadata.kind === 'main'` | `session-kind` |
| 2 | `ctx.hasUI === true` | `no-ui` |
| 3 | stdout이 TTY | `tty` |
| 4 | `HERDR_ENV=1` + pane id + socket 경로 | `outside-herdr` |
| 5 | `GJC_HERDR_DASHBOARD !== '0'` | `disabled` |
| 6 | 중첩 호스트가 아님(`GJC_HERDR_DASHBOARD_HOST`) | `nested` |
| 7 | 설치 트리가 정상(임시 폴더 아님, 자산 존재) | `mirrored-install` |
| 8 | state 경로 해석 가능 | `state-dir` |

- 하위(sub) 세션은 1번에서 실패한다. 그래서 sub는 레지스트리·파일·Herdr에 아무것도 하지 않는다.
- state 경로는 `GJC_HERDR_DASHBOARD_STATE_DIR` → 모듈이 `<root>/herdr-dashboard/generation-*/`
  아래면 `<root>/herdr-dashboard/state` → 그 밖이면 없음(= `state-dir`) 순으로 정한다.
- `GJC_HERDR_DASHBOARD=0`이면 확장이 스스로 물러난다. 이 값은 GJC나 다른 확장이 설정할 수 있다.

## 4. 한계 (계획에 근거가 있는 것만)

### 4.1 위젯 중복은 피할 수 없다 (AC1.12)

GJC 0.18.11에는 Todo 위젯을 끄는 설정이 없다. 그래서 대시보드 pane을 열면 화면에 Todo가 두 번
보인다(GJC 자체 위젯 + 이 확장의 pane). **이 중복은 숨길 수 없다.**

- `alt+shift+t`: GJC 위젯의 **펼침/접힘만** 바꾼다. 위젯 자체를 없애지 못한다.
- 확장이 GJC 위젯을 마스킹하거나 대신 그리는 방법은 없다. 계획에서 폐기했다(seam이 없음).
- 이건 upstream 요청 사항이고, 이 저장소의 후속 과제가 아니다.

### 4.2 workers는 깊이 1까지만 보인다

깊이 2 이상의 서브에이전트는 다른 하위 세션의 bus로 emit되어 이 대시보드에 잡히지 않는다.
background 작업은 `ctx.getJobs()`로 보완한다(둘 다 L2 범위).

### 4.3 비용 0은 "알 수 없음"이다

K1 실측: 구독 모델이라 서브에이전트 `cost`가 모든 시점에서 0으로 보고된다. 그래서 0을 "무료"로
표시하지 않고 **알 수 없음**으로 표시한다.

### 4.4 세 번째 pane(Progress)은 없다

F1 실측: GJC 0.18.11의 대화형 main ctx에서 `typeof ctx.getProjectProgress === 'undefined'`다.
검증된 네이티브 원천이 없으므로 Progress pane(세 번째 pane)을 만들지 않는다. 2역할 band가 최종이다.
가짜 DAG도, gjc CLI 폴링도 없다. 대신 Todo pane 맨 위에 목표 1줄을 넣는다(L5b).

- 원천은 `ctx.getGoalState()`와 `goal_updated`뿐이다. `data/<scopeKey>/goal.json`에는 objective·status·
  tokensUsed·timeUsedSeconds만 쓴다(id·provenance는 경계 밖).
- goal이 있을 때만 `◎ <objective> · <상태> · <토큰(예: 215K)> · <경과 시간>` 한 줄을 그린다.
  objective만 pane 폭에 맞춰 자르고(`~`), goal이 없으면 줄도 빈 행도 없다. `goal_updated` 뒤 2초
  안에 갱신된다.
- `goal_updated`는 초당 1회 정도 오므로 자동 pass의 병합(실행 1 + 대기 1)과 200ms writer 병합을
  그대로 탄다. 소유자 phase가 `me`일 때만 쓰고, Todo record가 closed면 쓰지 않는다.

### 4.5 `/todo` 편집이 반영되는 조건 (G9)

`todo_write` 도구 호출은 `tool_execution_end` 이벤트를 내므로 2초 안에 반영된다. 반면 **`/todo`
슬래시 편집은 이벤트를 내지 않는다.**

- G9 실측은 부분 통과다. 전환 후 보관한 ctx로 `getLeafId()`·`getSessionId()`를 호출해도 예외는
  없었지만, **값이 새 세션을 보는지는 확인하지 않았다**.
- 그래서 계획의 실패 경로를 택했다: 보관 ctx는 **이벤트가 올 때만** 갱신한다. `/todo` 편집은
  다음 이벤트(또는 다음 `/dashboard`) 때 반영된다. 1초 폴링은 실제 값 신선도를 실측할 때만 켠다.

### 4.6 세대를 바꾼 뒤에는 재시작을 권장한다

| 구분 | 결정하는 것 |
|---|---|
| 설치 선택 | shim이 가리키는 대상. `--doctor`가 보고한다 |
| ext gen | 실행 중 GJC가 import한 ROOT의 `config.json.generation`(없으면 `dev`) |
| viewer gen | viewer가 자기 ROOT에서 읽고 `ready.json`·헤더 토큰에 적는다 |

ext gen은 **이미 시작한 GJC 프로세스에서 바뀌지 않는다.** 세대를 설치한 뒤 화면에 새 세대를
보려면 GJC를 재시작하고 `/dashboard`를 다시 부른다. adopt는 기존 viewer를 자동 업그레이드하지
않는다(세대가 다르면 "q 후 `/dashboard`" 안내만 붙는다).

### 4.7 omo와 같은 탭에 있을 때 (`foreignWaiting`)

이름 공간은 분리되어 있다(label `GJC …`, 상태 경로, 환경변수, `Symbol.for('gjc.herdr.dashboard/1')`).
제품 코드에는 omo 경로 리터럴(`.omo`, `omo-stable`, `OMO_`)이 0개이고, reporter 명령
(`report-agent`·`report-metadata`·`release-agent`)도 쓰지 않는다(SR2·SR3).

같은 탭에 omo band pane이 있으면 **omo 쪽이 비파괴적인 `foreignWaiting` 상태가 된다.** 어느 쪽도
상대 pane을 닫거나 입력하지 않는다. 실제 omo 교차 실행은 소유자 승인 아래에서만 한다(이 저장소는
omo를 읽기만 했고 실행하지 않았다).

### 4.8 reload는 실측하지 않았다 (G12)

`/new`는 실측했다(`session_before_switch` → `session_switch`, factory 재호출 없음, 같은 프로세스). 확장은 `session_switch`를 받아 즉시 scope를 새 세션으로 옮기고, 1초 poll도 sessionId 변화를 본다(L4에서 `/new` 직후 scope가 늦게 바뀌던 간헐 실패로 발견·수정). 하위 에이전트가 진행 이벤트를 초당 수백 개 보낼 때도 자동 pass는 한 번에 하나만 돌고 그동안 온 트리거는 마지막 하나로 합쳐진다(합치지 않으면 pass 대기열이 수천 개로 쌓여 `/new`·`/exit`가 수 분 늦었다). 다른 프로세스에서 재시작한 직후에는 `/dashboard`가 슬롯을 인계하기 전까지 자동 pass가 아무것도 쓰지 않는다(이전 소유자의 마지막 화면이 그대로 남음). 같은 프로세스의 reload(같은 pid, registry가 이 인스턴스를 가리킴)는 arm 때의 heartbeat가 협조적 인계로 즉시 소유 기록을 가져간다(단위 LT-6; 라이브 미측정). `/dashboard`는 owner 단계 전에 슬롯을 건드리지 않으므로 `busy:other-owner` 응답은 슬롯과 데이터를 바꾸지 않는다.
`/resume`·`/fork`·`/reload`는 이 환경에서 측정하지 못했다(persisted 세션 시작이 공용 SDK 인덱스
락에 막힘, `/reload`는 slash 명령이 아님). 대응: 같은 sessionId + 같은 moduleUrl이면 인스턴스를
교체하고, sessionId가 같고 moduleUrl만 다르면 교체하지 않고 delegate + `warn:duplicate-install`
1회로 처리한다.

### 4.9 스키마가 바뀌면 다음 `/dashboard`에서 새 slot이 된다

같은 slot schema **major**끼리만 호환된다. 모르는 schema는 T18로 격리하고 새로 시작한다.
마이그레이션 계층은 없다.

### 4.10 수동 lock/owner 복구 경계 (M1–M5)

일반적인 래치는 R1 설계로 제거되었으므로 **평소에는 수동 개입이 필요 없다.**

- 살아 있지만 멈춘 GJC가 lock·owner를 쥐고 있으면 **그 GJC를 끝내면 된다.** 다음 pass가
  ESRCH(사망)나 `stoppedAt`을 보고 자동으로 회수한다.
- 자동 회수가 불가능한 경우는 **사망을 증명할 수 없는** 다음 다섯 가지뿐이다.
  - **M1**: lock 보유자가 crash한 뒤 그 pid가 다른 프로세스에 재사용됨
  - **M2**: `wx` 생성과 내용 쓰기 사이의 crash(빈 lock 파일), 또는 쓰기와 자기 해제가 둘 다 실패
  - **M3**: G10 pid 판정 불가(`process.kill(pid, 0)`이 ESRCH/EPERM 외의 결과)
  - **M4**: owner가 `stoppedAt` 없이 kill된 뒤 pid가 재사용됨
  - **M5**: `owner.json` 손상
- 이때 busy notify에는 항상 `pid <P|미확인> · g<N> · <절대경로>`가 들어간다.
- **복구 절차** (`<state>/slots/<layoutKey>/`)
  1. notify에 찍힌 pid가 **이 부모 pane의 GJC가 아님**을 확인한다.
  2. lock: 표시된 세대의 **빈 `lock/g<N>.released` 파일만** 만든다. **lock 파일 삭제는 금지다.**
     owner: `owner.json`만 지운다(`slots/`의 다른 파일은 건드리지 않는다).
  3. 다음 `/dashboard`가 진행한다.
- 제품은 이 절차를 자동화하지 않는다. 복구 전용 CLI도 없다(`src/host/gjc-cli.mjs` 없음). 설치 CLI의
  `--remove`는 관리 shim만 지우고 세대·state는 보존한다(D4).
  **전제를 어기면(살아 있는 다른 GJC의 lock을 released로 만들면) 이중 보유가 생길 수 있다.**
- 참고: 이 드릴은 dev shim 경로로만 한다. G13 실측 결과 이 0.18.11 바이너리는
  `GJC_CODING_AGENT_DIR`를 따르지 않아 **user-scope 설치 드릴은 이 환경에서 불가**하다.

### 4.12 아직 검증되지 않은 것

- 위 한계들은 **계획과 L0 실측**에 근거한다. 이 저장소의 단위 테스트는 자격·투영·shim·문구처럼
  가짜 호스트로 결정할 수 있는 것만 단언한다.
- L1(Todo pane)의 라이브 프레임·타이밍은 `VERIFICATION.md` `## L1`에 하네스 소유 Herdr 세션 실측으로
  기록돼 있다(`/resume`, 교차 프로세스 락, Todo 값 신선도는 제외). L2–L6(workers pane, band 배치,
  마우스·포커스, adopt·retention, 세대 설치)은 아직 구현·검증 전이므로 여기서 동작을 주장하지 않는다.
- `npm test`는 `test/unit/`만 돌린다. `test/live/`는 소유자 승인 아래 별도로 실행한다.

## 5. 개발용 shim

샌드박스 case 하나를 실제 GJC 세션에 물릴 때는 `scripts/dev-shim.mjs`가 만든 shim을 쓴다.

```
node scripts/dev-shim.mjs --case <id> [--state <dir>] [--herdr <json argv>] [--viewer-failpoint <값>]
```

- 출력: `.sandbox/case-<id>/.gjc/extensions/gjc-herdr-dashboard.js`
- 내용: 진입 모듈의 **절대 file URL**을 재수출하고, factory 호출 전에 case 전용 기본값을 `??=`로
  넣는다(`GJC_HERDR_DASHBOARD_STATE_DIR`, `GJC_HERDR_DASHBOARD_HERDR`, 선택적
  `GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT`). 이미 설정된 값은 덮어쓰지 않는다.
- ESM 순서 주의: 정적 import/재수출은 import한 모듈의 본문보다 먼저 평가된다. 즉 `??=` 줄은 항상
  `extension.mjs` 평가 **뒤**에 실행된다. 이게 안전한 이유는 진입 모듈이 import 시점에 환경변수를
  읽지 않고 factory 안에서만 읽기 때문이다. 만약 진입 모듈이 import 시점에 env를 읽게 되면 정적
  재수출로는 순서를 보장할 수 없고, 절대 URL `await import()` 래퍼가 필요하다(SR5는 상대 경로 동적
  import를 금지하고 절대 URL은 허용한다).
- case id는 한글과 공백을 포함해도 된다(`.sandbox/한글 공백 케이스/`).

## 설치

세대를 설치하면 `<agent-dir>/extensions/gjc-herdr-dashboard.js` shim과
`<agent-dir>/herdr-dashboard/generation-NNNNNN/` 트리가 생긴다. shim이 실제 선택이고,
`<agent-dir>/herdr-dashboard/current.json`은 그 기록이다. `<agent-dir>/herdr-dashboard/state/`는
런타임 소유이므로 installer가 건드리지 않는다.

```powershell
node scripts/install.mjs --agent-dir <agent-dir> --lang ko
node scripts/install.mjs --agent-dir <agent-dir> --select generation-000001
node scripts/install.mjs --agent-dir <agent-dir> --remove
node scripts/install.mjs --agent-dir <agent-dir> --doctor
```

- `--lang ko|en|zh-cn`(기본 `ko`)은 세대의 `config.json`에 기록되고, 새 GJC 세션의 알림·viewer
  문구가 그 언어를 따른다. 잘못된 값은 설치 자체가 실패한다.
- `--dry-run`은 설치 계획만 출력하고 아무것도 쓰지 않는다.
- `--doctor`는 shim 대상·`current.json`·세대 목록을 보고하고, 불일치가 있으면 0이 아닌 코드로
  끝난다. `--select`로 정정한다.
- `--remove`는 관리 shim만 지운다. 세대와 `state/`는 보존된다. 관리 마커가 없는 shim은
  덮어쓰지도 지우지도 않는다.
- 사용자 범위 설치는 소유자 승인 아래
  `node scripts/install.mjs --agent-dir C:/Users/USER/.gjc/agent --lang ko`로 실행한다.

## 6. 알림 문구 (notify)

`/dashboard`는 자격과 무관하게 항상 등록되고, 매번 자격을 다시 평가한다. 명시 pass는 결과 하나를
**정확히 한 번** 알린다. 문구는 `ext <gen> · <역할> <코드>` 꼴이고(세대 토큰 포함), `viewer <세대>`
또는 `viewer 대기`, 부분 결과에는 지키기로 한 pane id가 붙는다.

| 코드 | 뜻 |
|---|---|
| `opened` | 이번 pass에서 pane을 만들고 viewer를 띄웠다 |
| `adopted` | 기존 pane·viewer를 그대로 쓴다 |
| `ready` | 이미 정상 동작 중이다 |
| `pending` / `pending-slow` | pane은 있고 viewer가 아직 준비 중이다 |
| `partial:<why>` | 일부만 했다(`size`·`shape`·`timeout`·`ownership-unproven`) |
| `busy` / `busy:other-owner` | 다른 pass·다른 owner가 잡고 있다. `pid · g<N> · 경로`가 함께 온다 |
| `unresponsive` | viewer가 응답하지 않는다 |
| `replaced:<why>` | 오래된 pane을 닫고 새로 만들었다(`dead`·`stalled`) |
| `ineligible:<이유>` | §3의 자격 실패 |
| `failed:<code>` | 만들기·이름·실행·닫기·잠금·Node·viewer·herdr 중 하나가 실패했다 |
| `warn:duplicate-install` | 같은 세션에 두 번째 설치가 로드됐다 |

문구는 `locale/{ko,en,zh-cn}.json`의 `notify.*` 키에서 온다. 기계 토큰(`state-dir`, `herdr-split`
등)은 번역문 옆에 그대로 남으므로 드릴이 grep할 수 있다. 키 집합은 세 언어가 동일하다.

## 7. 저장소 구조

| 경로 | 내용 | 상태 |
|---|---|---|
| `extension.mjs` | factory(등록만). ROOT_URL 계산 | L1 |
| `src/host/gjc-adapter.mjs` | 자격, 바인딩, 결과 → notify 문구 | L1 |
| `src/host/sources/todo.mjs` | 네이티브 Todo → 투영 (`gjc-herdr-dashboard/todo/1`) | L1 |
| `src/core/*.mjs` | slot·lock·owner, liveness, 전이표, reconciler, launch, 데이터 writer | L1 |
| `src/viewers/**` | 역할별 viewer와 render (omo 복사·적응) | L1(Todo) |
| `locale/{ko,en,zh-cn}.json` | 고정 문자열. 기본 언어는 ko | L1 |
| `scripts/dev-shim.mjs` | 샌드박스 case별 절대 URL shim 생성 | L1 |
| `test/unit/*.test.mjs` | 단위 테스트 (`node:test`) | L1 |
| `src/host/instance.mjs` | arming, 레지스트리, delegate, nested·mirror·state 판정 | L1(다른 레인) |
| `test/live/*.mjs` | 라이브 재현 절차(L1–L6) | 예정 |
| `scripts/{build,install,verify-package}.mjs` | 세대 설치·롤백 | L6 |
| `PROVENANCE.md` | 레인별 복사·적응 매핑(Lane A/C/D/E + 미매핑 파일) | 완료 |
| `VERIFICATION.md` | L0 실측 기록 | 완료 |
