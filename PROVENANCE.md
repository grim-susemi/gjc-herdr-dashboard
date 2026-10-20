# PROVENANCE

복사 원천: omo-herdr-dashboard (읽기 전용, `git archive`로 풀어서 사용).

## 고정 SHA

| 항목 | 값 |
|---|---|
| 계획에 적힌 SHA | `26e60ca20a2152c7c00fa6a060c78f697f752ff4` |
| L0 시점 `main` | `4082c7509c4a2f8a53128b85bfd38acf017a52c3` |
| 고정한 SHA | `4082c7509c4a2f8a53128b85bfd38acf017a52c3` (초기 이식) |
| 재정렬 SHA (2026-10-20) | `3242ad43561e10bc66b3f28b6345420962b4df99` (`3242ad4`, see the re-alignment section below and GRAMMAR.md) |
| 변경 파일 (26e60ca2..4082c750) | `README.md`, `VERIFICATION.md`, `packages/dag/src/render.mjs`, `packages/dag/test/dashboard-b.test.mjs` |
| 변경 커밋 | `4082c75 fix(workers): flatten child cards while retaining group context` |
| omo `status --porcelain` | 비어 있음 (L0 시점) |

SHA가 계획과 달라서 계획 15.1 규칙대로 새 SHA로 고정했다. 바뀐 파일은 workers 카드 렌더링(`render.mjs`)과 그 테스트라서 Todo 쪽 복사 원천에는 영향이 없다. Workers 렌더링은 L2에서 새 SHA 기준으로 복사한다.

## 기준선 (B1-isolated)

- 실행: `node scripts/baseline-omo.mjs`, 격리 env(`HERDR_*`, `OMO_*` 제거, HOME/USERPROFILE 임시), Node v24.12.0.
- B1 (`test/*.test.mjs`, 11개 파일): total 759, pass 746, fail 13, skipped 0.
- 계획 기대값 746/758, 실패 12와 다르다. 새 SHA에서 테스트가 1개 늘었고 실패가 1개 늘었다. 그래서 `B1-isolated`로 따로 기록한다.
- 실패 13개 전체 이름과 B2 파일별 결과는 `.evidence/L0/b1-report.txt`, `.evidence/L0/baseline-omo.json`(git 제외)에 있다.
- 새 실패를 자동으로 면책하지 않는다. 유지하는 기능의 실패 테스트는 적응해서 통과시킨다.

## 복사 매핑

### Lane B — 뷰어·i18n (L1)

기준선은 `.evidence/L0/baseline-omo.json`의 `b2.<파일>` 값이다(파일별 `node --test`, 격리 env).
`total/pass/fail`로 적는다.

| ours | omo path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/i18n.mjs` | `packages/todo/src/i18n.mjs` | adapt | — | 문자열은 인라인 객체에서 `locale/<lang>.json`으로 옮겼고 ROOT URL 기준으로 읽는다(단계-05 R4: dev 트리와 `generation-NNNNNN/` 트리가 같은 상대 배치). 기본 언어를 en에서 **ko**로 바꿨다(AC-F2). `languageOf`의 잘못된 값은 ko로 떨어지고 `decision()`이 그 값을 함께 돌려줘 footer 1회 표시에 쓴다. `t()`는 모르는 키에 throw(omo와 동일). `dag/src/i18n.mjs`는 **가져오지 않았다**: 그 표의 키(workers/DAG 노드 상태, metrics, 설치 안내)는 Todo 뷰어가 쓰지 않는다. 동적 import 없음(SR5): `fs.readFileSync`로 읽는다. |
| `locale/ko.json`, `locale/en.json`, `locale/zh-cn.json` | `packages/todo/src/i18n.mjs`(en/ko/zh-cn 표) | adapt | — | omo의 Todo 표에서 `controls`/`controlsNarrow`/`position`/`current`/`ask`/`noAsk`/`now`/`idle`/`closedPhases`/`invalidBinding`/`cacheError`/`registrationError`/`waiting`/`last-known`/`error` 키를 **뺐다**. 뺀 이유: `controls`·`controlsNarrow`·`position`은 AC-F1이 금지하는 keyboard legend이고, 나머지는 omo 전용 개념(ask 패널, CLI 바인딩, 파생 캐시, 소유권 등록, availability 어휘)이라 대응 기능이 없다. 대신 추가한 키: `live`/`waiting`/`empty`/`disconnectedAt`/`sourceError`(AC1.9의 상호 구별 라벨 5종), `prefsError`, `slotMissing`, `invalidLanguage`. 세 파일의 키 집합과 보간 파라미터가 동일함을 테스트가 단언한다. |
| `src/terminal-input.mjs` | `packages/todo/src/terminal-input.mjs` | copy | — | omo에서 `packages/todo/src/terminal-input.mjs`와 `packages/dag/src/terminal-input.mjs`가 바이트 단위로 동일했다(`diff` 확인). 코드는 그대로이고 헤더 주석만 우리 저장소용으로 바꿨다. `watchHerdrFocus`/`terminalInput`/`enablePointer`/`disablePointer` 네 개가 그대로 남았다. |
| `test/unit/terminal-input.test.mjs` | — | new | — | omo는 이 모듈의 단위 테스트를 두지 않았고 pty 뷰어 테스트로만 간접 검증했다(그 뷰어 테스트는 L1 범위 밖). 디코더를 직접 테스트한다: DECSET 바이트, pointer press/drag/wheel/release, 조각난 report 버퍼링, focus in/out, ESC 보류, dispose 후 무수신, Herdr 벡터 불일치 시 no-op, 도달 불가 소켓의 실패 보고. |
| `src/viewers/common.mjs` | `packages/todo/src/render.mjs`(텍스트 프리미티브), 그 밖에는 없음 | adapt + new | 7/20/13(render.test.mjs) | `clean`/`width`/`fit`/`wrap` 네 프리미티브는 omo `todo/src/render.mjs`에서 그대로 가져왔다(그 파일이 다시 `omo-herdr-dag-follow`에서 온 것이라 라이선스 고지를 유지했다). `clean`은 `stripVTControlCharacters`를 먼저 적용하도록 고쳤다 — omo의 정규식만으로는 `\x1b[2J` 같은 CSI가 남아 프레임에 살아남는다(테스트로 고정). 나머지(heartbeat, slot watch, token fence, owner liveness, footer, `q`)는 **신규**다: omo에는 대응물이 없고(presence/lease/custody, parent-slot sqlite) 계획 7.3⑥·7.9가 새로 정의한 동작이다. 2026-10-20: omo `3242ad4` 문법에 다시 맞췄다(`GRAMMAR.md`). |
| `test/unit/common.test.mjs` | — | new | — | 공유 헬퍼 전용 테스트. omo에 대응 테스트가 없다. 라벨 5종 상호 구별(AC1.9), footer 토큰 순서와 legend 0, `generationOf`, `readyRecord` 필드, 5s heartbeat 타이머와 실패 표면화, fence 판정 8분기, watcher 1s 폴링·읽기 오류 보존, `ownerLiveness` 경계(stoppedAt 즉시 / 20000ms 경계 / 살아 있는 pid는 stale heartbeat에도 live), `closeOwnPane` 4분기. |
| `src/viewers/todo/render.mjs` | `packages/todo/src/render.mjs` | adapt | 7/20/13 | 프레임 렌더러를 공유 투영 계약(`phases[].tasks[]` 4상태)으로 다시 썼다. 유지: phase 그룹핑, 닫힌 phase 접기(`c`), 스크롤, 선택 마커와 범위, 34/52열 좁은 레이아웃, 한국어/CJK 셀 폭, footer를 자르지 않는 절단. 제거: ask 패널과 별도 스크롤, 65ms strike 애니메이션과 `STRIKE_*`, `native-todo`/`phaseSummaries`/`taskKeys` 결합, `runningTarget`의 omo 고유 타깃 상속, availability 어휘(`current`/`last-known`), 클릭 범위의 `closedRange`. 자동 접기는 **닫힌 phase에만** 적용한다: pending 작업을 자동으로 숨기면 todo 목록의 목적이 사라지므로(테스트로 반대 동작을 고정). 2026-10-20: omo `3242ad4` 문법에 다시 맞췄다(`GRAMMAR.md`). |
| `test/unit/render.test.mjs` | `packages/todo/test/render.test.mjs` | adapt | 7/20/13 | 유지: 셀 폭/절단/줄바꿈 오라클, 레이아웃 행렬(80/52/40/34/24/12/1열), phase shell 접근성, 닫힌 phase 접기와 카운트, 적대적 제어 시퀀스, 읽기 오류 행 고정. 적응: 픽스처를 `projectNativeTodo`에서 공유 계약 객체로, `ask` 스크롤·strike 프레임·클릭 범위 테스트는 대응 기능이 없어 제거(아래 미복사 항목). 추가: 3언어 x 34/52열 footer 내용 단언(AC-F3), 라벨 4종 구별, 선택 폴백, 좁은 열에서 footer 무손실. |
| `src/viewers/todo/viewer.mjs` | `packages/todo/src/viewer.mjs` | adapt | 13/21/8 | CLI 형태(`--state/--layout/--role/--token/--pane/--once/--lang/--width`)와 `--once` 계약, prefs 원자 저장, `f`/`c`/`j`/`k`/`q` 키는 유지했다. 제거: presence/ACK 프로토콜, producer-custody·retirement 서버, `readViewerCache`/`createSnapshotStorage` 결합, `validateRoleBinding`의 omo role 스키마. 추가: 계획 7.3⑥ token fence, `<state>/data/<scopeKey>/todo.json` 투영 읽기, slot.json 변경 시 scope 재바인딩(AC1.11), prefs를 `<state>/prefs/<scopeKey>/todo.json`에 per-scopeKey로 저장(AC1.3: `follow`는 저장하지 않고 fold·선택만 복원), `GJC_HERDR_DASHBOARD_VIEWER_READY_DELAY_MS`(25s 지연), owner.json 생존 라벨. 뷰어가 쓰는 상태 파일은 자기 `roles/<role>.ready.json` 하나뿐이고 `slot.json`/`owner.json`은 읽기 전용이다. |
| `test/unit/viewer.test.mjs` | `packages/todo/test/viewer.test.mjs` | adapt | 13/21/8 | 유지: 인자 파싱, `--once` 프레임, 키 입력에 따른 프레임 변화, prefs가 재개봉을 넘어 복원되는 동작. 적응: presence 파이프 픽스처를 fake port + fake clock + fake herdr로 바꿔 실제 Herdr·실제 시계·소유자 HOME을 건드리지 않는다(이 저장소의 L1 제약). 추가: fence 3종(토큰 불일치/역할 없음/closed; 무효 slot은 은퇴 사유 아님), `HERDR_PANE_ID` 불일치 시 close 0, scope 전환, AC1.3 시퀀스, ready 지연 24999/25000ms 경계, owner 5s/20s 라벨, 잘못된 `--lang` 폴백 footer, prefs 손상 시 비치명, usage 오류 exit 2. |

### Lane A — core state (L1)

Pinned copy source: `C:/Users/USER/AppData/Local/Temp/omo-herdr-dashboard-4082c750/` (archive extract of
omo-herdr-dashboard at SHA `4082c7509c4a2f8a53128b85bfd38acf017a52c3`). Read-only; nothing was built or
executed from that tree.

Baseline for each copy source file is the `B2` record in `.evidence/L0/baseline-omo.json` (per-file
`node --test` run under the isolated env), reproduced in the "baseline" column below as
`total/pass/fail`.

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/storage.mjs` | `packages/dag/src/storage.mjs` | adapt | 3/3/0 (`packages/dag/test/storage.test.mjs`, not copied) | Kept `readJson` (null on ENOENT), temp+rename `writeJson`, and the win32 EPERM/EACCES/EBUSY retry. Added `readJsonOr` for callers that want a default, and split the rename retry into `replaceFile` / `retryOnWindowsSharing` so `src/core/slot.mjs` reuses one retry implementation instead of a second copy. The temp file name uses `randomUUID()`; mode 0600/0700. |
| `test/unit/storage.test.mjs` | `packages/dag/test/storage.test.mjs` | adapt | 3/3/0 | All three original cases survive (transient win32 retry, permanent-failure preservation, cleanup-cause preservation). Adapted: `t.mock.method` replaced by direct fs assignment + restore with `syncBuiltinESMExports()`, because `t.mock.method` on the `node:fs/promises` namespace does not take effect on this host (probe: `.sandbox` run showed the mock was never called). Added `readJson`'s absent-vs-real-error contract, a Korean-path round trip, and the `replaceFile` wrapper. |
| `src/herdr.mjs` | `packages/dag/src/herdr.mjs` | adapt | 6/2/4 (`packages/dag/test/herdr.test.mjs`) | Kept `quote`, `shellCommand` (win32 PowerShell `& 'x'` form), the shell-free `execFile` call, `{}` for empty stdout, and `.code` preservation from the structured `{error:{code,message}}` body. Replaced `resolveHerdrBin`/`herdrSession` with `resolveHerdrVector(env, platform)` returning an argv array with plan 7.10 precedence (`GJC_HERDR_DASHBOARD_HERDR` JSON argv -> `HERDR_BIN_PATH` -> `herdr`/`herdr.exe` on PATH), and `createHerdr({vector, env, timeoutMs, execute})` where the vector is a pure argv prefix. The omo `herdrSession`/`HERDR_BIN_PATH`-deleted fallbacks were dropped: their whole purpose was the omo session probe, which plan 7.10 replaces, and SR2/SR8 forbid the reporter surface that went with it. `timeoutMs` is 5000 per R1's per-Herdr-call budget. |
| `test/unit/herdr.test.mjs` | `packages/dag/test/herdr.test.mjs` | adapt | 6/2/4 | Ported: the POSIX quoting round-trip and the "real child process receives the caller argv" test. Adapted for host portability (both adaptations are required by measured host facts, not preference): (1) the quoting round-trip runs `sh` instead of `bash` because this host's `bash` on PATH is the WSL launcher and exits 1 for `printf` (omo's own baseline fails this test for the same reason); (2) the real-child test passes `[process.execPath, script]` as the vector instead of an extensionless shebang stub, which win32 cannot `execFile`. Extended for the vector precedence, the `herdr-vector`/`herdr-missing` coded failures, and the structured-error/empty-body branches. |
| `src/runtime.mjs` | `packages/dag/src/runtime.mjs` | adapt | 5/5/0 | Kept the JSON `--eval` probe, the `>= 24` major check, the Bun rejection, the `isAbsolute` requirement, and the override-never-falls-back rule. Renamed the env to `GJC_HERDR_DASHBOARD_NODE`. The i18n dependency was removed: the failure text is injected as `message(language)`, defaulting to an in-module English string plus an exported `nodeUnavailableText` map for ko/en/zh-cn, so this module does not import `src/i18n.mjs` (lane B owns it). The probe sentinel is `gjc-herdr-dashboard-node`. |
| `test/unit/runtime.test.mjs` | `packages/dag/test/runtime.test.mjs` | adapt | 5/5/0 | All five original cases survive with the renamed env and sentinel. Added: `node.exe` on win32, a `24.0` (two-component) version rejection, the real Node probe, and the injected-message assertion that no i18n module is touched. |
| `src/retention.mjs` | `packages/dag/src/retention.mjs` | adapt | 6/6/0 (`packages/dag/test/retention.test.mjs`) | Kept the env parsing contract exactly (default 14, blank -> 14, non-numeric/<=0 -> 0 disables) with the env renamed to `GJC_HERDR_DASHBOARD_RETENTION_DAYS`. The pruning unit changed from omo's per-session file families to plan 6 row R's scope directories: `pruneExpiredSnapshots` -> `pruneExpiredScopes(stateDir, {activeScopeKeys, now, days, notify})`, which removes only `data/<scopeKey>` and `prefs/<scopeKey>` whose newest mtime is older than the cutoff and whose scopeKey is not active. `slots/` is never read or written. |
| `test/unit/retention.test.mjs` | `packages/dag/test/retention.test.mjs` | adapt | 6/6/0 | Kept the two env-parsing tests and the "failed removal is reported and other items still prune" test (adapted to `notify(message, {scopeKey, directory})`). Replaced the file-family and controller-`start()` tests with scope-directory tests: per-kind independence for one scopeKey, newest-entry-decides lifetime, A-15 (a disconnected viewer whose slot still exists keeps its scope), a missing state dir, and a `slots/`-untouched assertion. The omo `start()`/`DagPane` integration test is not portable: it drives omo's controller, which plan 6 row C replaces with the Reconciler; its observable intent (keep the current session, prune the rest) is covered by the active-set tests. |
| `src/core/slot.mjs` | — | new | — | No omo counterpart: plan 6 row S marks parent-slot as a redesign and stage-05 R1 replaces base 7.5's single `slot.lock` + 30 s heartbeat takeover + `fence()` with generation files under `slots/<layoutKey>/lock/`. `wx` exclusive creation is the only atomic primitive. Contains the key derivation (`sha256(JSON(tuple))[0..24]`), plan 7.9 paths, slot/owner/intent read-write, T18 quarantine, and the R1 acquire/release/re-check. Header comment records the R1-over-7.5 choice. |
| `test/unit/slot.test.mjs` | — | new | — | Real temporary filesystem, injected process table and clock, and an unlink-auditing fs wrapper that asserts exactly which files a pass creates and deletes (R1's safety argument as observable behaviour): live holder never displaced at +31 s and +600 s, dead holder recovered, unknowable holder busy, two recoverers racing -> one holder, stale recoverer deletes only its own file, GC limited to `<= own-2`, automatic pass never retries. |
| `src/core/liveness.mjs` | — | new | — | New module (plan 8 definitions, amended by R2). `pidAlive` encodes the measured L0 G10 outcomes (self and EPERM -> alive, ESRCH -> dead) plus an explicit `null` for "unknowable", which R1 fails closed to busy. `viewerState` implements R2's first-match V order with the exact 15000 ms boundary. `isO`/`isOPlus` implement plan 8's ownership predicates. |
| `test/unit/liveness.test.mjs` | — | new | — | Fake process tables for all three G10 outcomes plus the unknowable case, real-process self/dead-pid probes, future-timestamp clamping, every V branch and boundary, and the full O/O+ label/pane/tab/shell matrix including the shell-less pane. |
| `src/core/transitions.mjs` | — | new | — | New module: plan 8's table as amended by R2 and the A-29/C-14 delta, as one pure function. Automatic T20 is zero action; `closed` is written only by T3 and by explicit T20 (both branches); automatic passes never create, close, notify, or surface a failure code. `decideOwnerPhase` implements R1's owner steps with heartbeat as display information only. |
| `test/unit/transitions.test.mjs` | — | new | — | One named test per table row with its documented notify, a totality test over all 25600 enumerated input combinations, an automatic-pass invariant test, the closed-writer set assertion, the age/heartbeat boundaries (19.999 s / 20 s / 119.999 s / 120 s and the A-31 closing-q-past-15 s pin), and the owner-phase matrix. |

Lane B 접점: Lane B는 `src/storage.mjs`를 **읽기 전용 의존**으로만 쓴다 — prefs 저장과
`roles/<role>.ready.json` 쓰기에 `writeJson`을 그대로 부른다(중복 구현 없음, SR5 때문에 정적
import). 파일 자체는 수정하지 않았다.

#### Lane A — 복사하지 않은 것 (deliberate)

- omo `packages/dag/src/i18n.mjs`, `controller.mjs`, `viewer.mjs`, `render.mjs`, `model.mjs`,
  `view-state.mjs`, `terminal-input.mjs`, `task-data.mjs`, `stream-tap.mjs`: other lanes/phases own
  these (`i18n.mjs` is lane B's; the rest are L2-L5).
- omo `packages/todo/src/*`: L1 viewer/render work belongs to lane B; the Todo projection contract
  this lane must honour is fixed by the task text, not copied from omo.
- omo baseline failures are not inherited as exemptions: the four `packages/dag/test/herdr.test.mjs`
  failures were caused by the `bash`-on-PATH and shebang-stub issues above, and the copied tests
  were adapted until they pass.

## 복사하지 않은 omo 테스트 (AC-G2 감사용)

AC-G2는 “생략으로 100%를 만들지 않는다”고 규정한다. 아래는 **의도적으로 이월하지 않은** omo 테스트와 그 이유다. 뺀 기능에 속하므로 면책이 아니라 범위 결정이다.

| omo test | 처리 | 이유 |
|---|---|---|
| `packages/todo/test/render.test.mjs`의 `ask has its own bounded scroll ...` | 기능 제거 | ask 패널은 네이티브 호스트(`native-todo`)에서 온 개념이고 계획 6의 범위 밖이다. 공유 투영 계약에 `ask` 필드가 없다. |
| 같은 파일의 strike/reveal 관련 단언(`completion transition animates ...`, `retained native target drives marker and reveal`) | 기능 제거 | 65ms strike 애니메이션은 omo 위젯 패리티용이고 계획 11에 없다. 렌더러에서 `STRIKE_*` 를 제거했으므로 대응 테스트도 제거했다. |
| 같은 파일의 `reference hierarchy ... body-relative click ranges` | 후속 계층 | 클릭 범위는 L3(마우스)이다. L1에서 좌표를 만들지 않으므로 L1에서 단언할 대상이 없다. |
| 같은 파일의 `native terminal controls cannot clear ...` 중 `snapshot.ask.text` 부분 | 기능 제거 | ask 필드가 없다. 같은 테스트의 제어 시퀀스 부분은 **유지**했고 강화했다(`clean` 수정 포함). |
| `packages/todo/test/viewer.test.mjs`의 presence/ACK 8건(`mouse inspection is local and blur ...`, `actual helper registration and real pipe baseline ACK ...`, `failed stdout callback cannot ACK ...`, `queued old message cannot ACK ...`, `new scope discards old client/cache/message ...`, `late offers connect without restart ...`, `a changed control offer registers ...`, `follow keeps reveal transient ...`) | 기능 제거 | presence named pipe·10s lease·painted ACK(E4)는 계획에서 폐기됐다. 우리 뷰어는 소켓 서버를 열지 않는다. 같은 테스트들이 지키던 관측 가능한 의도 중 유지되는 것은 prefs 복원(AC1.3)과 scope 전환이며 새 `viewer.test.mjs`가 그것을 담당한다. |
| `packages/todo/test/{controller,display-bridge,native-todo,presence,slot-publish-retry,managed-warnings,install*.test}.mjs` | 다른 계층/기능 제거 | 호스트 코디네이터·display bridge·네이티브 todo·presence·parent-slot은 L1 뷰어 범위가 아니거나 계획에서 폐기됐다. |
| `packages/dag/test/i18n.test.mjs`의 2건(`English is the default ...`, `Korean and Simplified Chinese remain available ...`) | 적응해 대체 | baseline에서 이미 2/3 실패다(모듈이 `render`/`model`/`fixtures`에 묶여 있다). 언어 정책 자체(3언어 키·파라미터 동등성)는 새 `test/unit/i18n.test.mjs`가 담당한다. |
| `packages/dag/test/viewer.test.mjs`, `fixed-view.test.mjs`, `dashboard-b.test.mjs`, `model.test.mjs`, `follow.test.mjs` | 후속 계층 | workers/DAG 뷰·follow·마우스는 L2–L5다. |

L1 이후 복사한 파일마다 {원본@SHA, 기준선 상태, 유지/적응/제외}를 이 아래에 추가한다.

### Lane C — L1 core lifecycle (launch / reconciler / data)

Pinned copy source: `C:/Users/USER/AppData/Local/Temp/omo-herdr-dashboard-4082c750/` (archive extract of
omo-herdr-dashboard at SHA `4082c7509c4a2f8a53128b85bfd38acf017a52c3`). Read-only; nothing was built or
executed from that tree.

Authority for this lane: stage-03 §7 (host contract, launch sequence, pass order), §8 (row table),
§9 (LT-1..LT-8), §13 (files); stage-05 R1 (lock protocol), R2 (row table amendments), R3 (failpoints
and viewer args), R4, R6; `herdr-dash-a29-fix-01/stage-01-planner.md` (A-29/C-14) and its
`pending-approval.md` §4 (A-30/A-31/A-32 executor obligations).

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/core/launch.mjs` | `packages/dag/src/controller.mjs` (`ensure`, L458-503), `packages/todo/src/controller.mjs` (`launchTodo` region, L2540-2600) | adapt | `test/dashboard-dag-b.test.mjs`, `test/dashboard-todo-b.test.mjs` in B1 (13 failures, none in these paths) | The launch sequence (`split --direction right --no-focus` -> `process-info` -> record -> `rename` -> `run (shellCommand)`) is the omo order, with three plan-driven changes: (1) U12's measured flag set has no combined split+run, so these stay separate calls; the omo `--ratio 0.65` is dropped because L1 has no band placement (L2 owns it) and the plan's L1 step list does not include it; (2) the omo `--close-pane` viewer argument is replaced by the plan's `--state/--layout/--role/--token/--pane` contract, which lane B's viewer already parses; (3) a durable `intent.json` is written before the split and deleted after the record (T19), which omo does not have — omo instead writes `{attempted:true}`/`{paneId,ready:false}` to a per-role record file. `shellCommand`/quoting are reused from this repo's `src/herdr.mjs` (lane A's port of omo `packages/dag/src/herdr.mjs`). FAILPOINT (FP1-FP4, SR9) is new: omo simulates crashes only through its test helpers. |
| `src/core/reconciler.mjs` | `packages/dag/src/controller.mjs` (`DagPane.enqueue`, `closePane`, `closeDagPanes`, `ensure`, `restorePlacementFocus` L1990-2035), `packages/todo/src/controller.mjs` (`mutate`/`verifyInputPane`/`launchTodo`) | adapt | see above | Reused patterns: the per-instance serial queue (`enqueue(job, {force})`), the "close only after a re-read proves the pane is ours" rule (omo `canCleanupPane` + `membership` before `close`), the neighbour-walk focus restoration (`neighbor --pane X --direction D` then `focus --pane X --direction D`, max 3 steps in omo, 4 here), and the `layout-waiting` refusal shape (which the plan replaces with a coded terminal result — LT-5 forbids a waiting state, so every refusal becomes `partial:*`/`failed:*`). Replaced: omo's single `slot.json` + heartbeat + `fence()` with the R1 generation-file protocol from this repo's `slot.mjs`; omo's `BLOCKED` phase with `busy`/`busy:other-owner`; omo's per-role `roleFile` JSON with the plan 7.9 `slots/<layoutKey>/{slot,owner,intent,roles/*.ready}.json` set. New: the budget/deadline guard, the A-32 read-only automatic-pass restriction, and the T19 interrupted-launch row. |
| `src/core/data.mjs` | `packages/dag/src/controller.mjs` (`receiveStream` coalescing, L368-392; `save`) | adapt | see above | The 200 ms merge is the plan's number for the plan 7.9 `data/<scopeKey>/<kind>.json` file family; omo's nearest equivalent is the 250 ms `streamDelay` coalescing of streamed tokens, whose structure is reused (`setTimeout` + a promise that settles after the coalesced write, `unref()` so a pending merge never holds the process open). Changed: this writer stores a caller-computed projection verbatim (the plan's writer/store split) instead of omo's in-memory `streams` map, and adds the caller's `shouldWrite` gate and a `flush()` that drains in-flight writes — both are consequences of the plan's host contract, which omo has no counterpart for. |
| `test/unit/launch.test.mjs` | — | new | — | No direct omo test counterpart: the omo launch order is exercised indirectly through `test/dashboard-*-b.test.mjs`, which drive the whole controller. This file tests the launch primitive directly (preflight coded failures with zero panes; the §7.3 call order; FP1-FP5 leftovers; quoting with a Korean path containing spaces; focus restore only when the focused pane moved; LT-1's split-failure-then-open; LT-8's run-target provenance). |
| `test/unit/reconciler.test.mjs` | — | new | — | One test per lifecycle row (LT-2 r1-r7), the A-29/C-14 observation sequences S1, S2, S3, S5, S6a-S6d, the A-30 close-error matrix, the A-31 automatic-event drivers, the A-32 verb audit, LT-3's age boundaries and the FP1-FP5 window, LT-5's no-waiting-state cases, LT-7's lock races and LT-8's run-target check. |
| `test/unit/latch.test.mjs` | — | new | — | The E1-E5 latch-defect suite: end-to-end sequences proving no silent pass, no permanent latch after a coded failure, no inherited record, and window convergence. |
| `test/unit/data.test.mjs` | `packages/dag/test/controller.test.mjs` (coalescing assertions) | adapt | B1: `test/dashboard-dag-b.test.mjs` passed; `controller.test.mjs` not in B1 | The coalescing test's intent (two rapid publishes produce one write, the newest value wins) is reused; the remaining cases (the `shouldWrite` gate, `flush` draining a slow write, `flush` rethrowing a failed write, malformed target rejection, array/`null` projections stored verbatim) are new, because the plan's writer contract has no omo counterpart. |
| `test/unit/fake-herdr.mjs` | `test/helpers/split-tree-herdr.mjs` (copy source) | adapt | B1: `test/split-tree-herdr.test.mjs` (13 B1 failures include this family) | **Not in the declared lane-C file list; added deliberately.** The split-tree fixture is the only omo file that models Herdr pane state, so it is the closest copy source, but it is a `dag`-test helper with geometry calibrated for omo's band layout. This fixture keeps the calibrated split behaviour (the source pane keeps the first child, the new pane takes the second child, so a `right` split puts the new pane to the right — verified against `.evidence/L0/g2-split.json` and `u11-split.json`), the close-gives-the-sibling-the-space rule, and the `neighbor` semantics of `pane focus --pane X --direction D`. Added: the A-32 call tracer, failure injection (`{code}`, `{times}`, `{skip}`, `{hang}`, `{remove}`), the fake process table and the fake clock. It lives under `test/unit/` rather than in production code so no test seam enters `src/`. |

#### Lane C — 복사하지 않은 것 / 기준선 정직성

- The 13 B1 failures recorded in `.evidence/L0/baseline-omo.json` are omo's own pre-existing failures
  (band geometry, split-tree helper, install guards). None of them is inherited as an exemption here:
  every case this lane copies was re-derived from the plan's contract and made to pass on this host.
- No file in this lane was executed or imported from the archive tree; the archive is read-only.

#### Lane C — 이 레인의 테스트 수 (isolated `node --test --test-isolation=none`)

| file | tests | pass | fail |
|---|---|---|---|
| `test/unit/launch.test.mjs` | 12 | 12 | 0 |
| `test/unit/reconciler.test.mjs` | 41 | 41 | 0 |
| `test/unit/latch.test.mjs` | 17 | 17 | 0 |
| `test/unit/data.test.mjs` | 6 | 6 | 0 |
| total | 76 | 76 | 0 |

`test/unit/static-rules.test.mjs` (phase 1, unmodified) is green with these files present: 21/21.

#### Lane C — 계획에서 벗어난 결정 (부모에 보고됨)

1. `failed:fenced` is reported as `busy` + `fence:true`, because stage-05 R1 deletes base 7.5's
   `fence()`/`failed:fenced` and replaces it with the generation re-check.
2. LT-7 (a)/(d) follow R1: a frozen live holder yields `busy`/`busy:other-owner`, never a takeover at
   31 s; a superseded recoverer deletes only its own generation file and reports `busy`.
3. `--failpoint` parsing lives in `src/core/launch.mjs` (allowed by SR9) for the launch-side
   FP1-FP4 crash points; the viewer-side FP5 value is passed through as `--failpoint ready-delay-25s`.
4. Preflight (node/viewer/herdr checks) runs eagerly for explicit passes and is skipped entirely for
   automatic passes, because A-32 forbids `checkNode`'s process spawn in an automatic pass.
5. `test/unit/fake-herdr.mjs` is an added fixture file inside the lane's own test tree.
6. `input.failpoint` is an added optional pass-input field (test seam for R3's FP1-FP5); production
   callers never set it, and the field is documented in the module header.
7. A launch that fails **after** it wrote the pending record now hands that slot snapshot back to
   the pass (`launchRole` returns `slot`/`record` on the post-record failure paths), so a later
   role in the same pass cannot write its stale pre-launch snapshot over the record. Found by the
   `fp2`/`failed:herdr-rename`/`failed:herdr-run` tests; see `test/unit/reconciler.test.mjs`.
8. A `pane split` that exceeds the per-call limit is `partial:timeout`, not `failed:herdr-split`:
   the pane may exist, so the intent is kept and the next pass reports the T19 row. A coded split
   refusal (nothing created) clears the intent and is `failed:herdr-split`, which is what LT-1's
   "split failure then opened" sequence measures. Same rule for a per-call timeout raised anywhere
   else in the pass: the aggregate becomes `partial:timeout`, never `failed:internal`, and every
   role row is filled with that code so the caller's single notify can never see a `null` row.
9. `herdr` calls are wrapped in a per-call timeout (`herdrTimeoutMs`, 5000 ms by default) inside
   the reconciler; the launch primitive relies on the caller's wrapper (`call`) for the same limit.
10. The pass order keeps the contract's `placement` step as a documented no-op: band placement
    (plan 7.8) is L2's `src/core/layout.mjs`, so this lane has no geometry work between the role
    rows and the focus step. The only geometry read here is the pre-split parent-size guard
    (`partial:size`), which exists so LT-5 can never report a waiting state.
11. Cross-module note (not changed by this lane): the committed phase-1 `transitions.mjs` gives an
    automatic pass `[discard-record]` for T5/T4. The task text's "record cleanups T3/T4/T13 only"
    does not name T5, so an automatic T5 discards a record whose pane it deliberately never
    touches. The reconciler only applies the decided actions, and lane A's table is the authority;
    this is flagged for the parent rather than silently amended.

#### Lane C — 다른 레인을 위한 통합 노트

- **`partial:interrupted-launch` (T19) needs notify wording.** My reconciler emits it for a
  leftover `intent.json`, and it is in the plan's table (`stage-05 R2` row 2: `partial`), but it is
  absent from the emitted-code list in `test/unit/adapter.test.mjs` (lane D, `src/host/gjc-adapter.mjs`).
  It currently renders as the generic `부분 완료(why: interrupted-launch)` fallback in ko/en/zh-cn
  instead of a real sentence. Lane D was offline when this was found; their
  "every lane-C code has wording" test passes only because the code is not in their list, so the
  list needs one more entry plus three locale keys. Every other code I emit
  (`failed:herdr-split|-close|-process-info|-record|-rename|-run`, `failed:failpoint`,
  `partial:size`, `partial:timeout`, `partial:ownership-unproven`, `replaced:stalled|dead`,
  `busy`, `busy:other-owner`, `opened`, `adopted`, `ready`, `pending`, `pending-slow`,
  `unresponsive`) is already covered there.
- The reconciler's automatic-pass `code` set is closed: `none | closed | discarded | ready |
  pending | pending-slow | unresponsive | quarantined | busy:other-owner`. The adapter never has to
  format a notify for an automatic pass, and it must not.
- A `busy`/`busy:other-owner` result always carries `lock:{generation,dir}` and an
  `ownerDetail`/`detail` string, which is exactly what `notifyText`'s `pid <P|unknown> · g<N> ·
  <path>` line is built from.

### Lane D — host adapter / Todo source / dev shim / README

Pinned copy source: `C:/Users/USER/AppData/Local/Temp/omo-herdr-dashboard-4082c750/` (extract of
omo-herdr-dashboard at SHA `4082c7509c4a2f8a53128b85bfd38acf017a52c3`). Read-only: nothing in that
tree was built, installed or executed for this lane. The only omo file that informed code here is
`packages/todo/src/native-todo.mjs`, read for the *shape* of the phase payload and the
`cancelled -> abandoned` rule; no line was copied.

Authority for this lane: `stage-03-revision.md` §7.2 (eligibility, keys, notify) and §7.6 (Todo
source), `stage-05-revision.md` R1 (nested), R3 (viewer failpoint), R4 (ROOT URL, mirror detection,
state dir), R5 (generation token), R6 (arming entry points), and the L0 measurements recorded in
`VERIFICATION.md` (G3 `sessionMetadata.kind`, G4 `getTodoState()` shape, G8 two-tree layout,
G10 pid liveness).

Two places where the lane assignment's shorthand was deliberately read through the plan text:

1. **Mirror assets.** The task text says "missing sibling `locale/` and `viewers/` dirs".
   `stage-05 R4` is narrower and is what this lane implements: `locale/{ko,en,zh-cn}.json` must be
   readable (**and `ko.json` must parse**), `src/viewers/common.mjs` must be readable, and every
   released role's viewer entry (`src/viewers/<role>/viewer.mjs`) must be readable. The dev tree and
   the `generation-NNNNNN/` tree have the same relative layout, so one rule covers both, and there
   is no fallback path (R4's "대체·호환·탐색 fallback 경로는 없다").
2. **State dir.** Implemented as R4's three-step rule, not as the shorthand: env override (trimmed,
   resolved) -> `basename(root) === 'generation-\d{6}'` and its parent's basename is
   `herdr-dashboard`, giving `<parent>/state` -> otherwise `null`, which the caller reports as
   `ineligible:state-dir`. A dev tree therefore derives no state dir, which is why the dev shim
   writes one.

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/host/gjc-adapter.mjs` | — | new | — | No omo counterpart: omo's install/session probe lived in `packages/dag/src/controller.mjs` + `runtime.mjs` and was replaced wholesale by plan §7.2's ordered eligibility gate, §7.2's `layoutKey`/`scopeKey` binding, and §7.4+R5's single notify line. Contains `checkEligibility` (the eight reasons in plan order, LT-4's notify matrix), `bindingOf` (env + `ctx.sessionManager.getSessionId()`, never throwing), `notifyText` (all 13 documented result codes plus every eligibility reason, partial/replaced why and failed code; the machine token is kept verbatim beside its localized description), and the R4 mirror/state-dir helpers. `notifyText` degrades to a raw line when the catalogue is unreadable so a pass still produces exactly one message (LT-4). |
| `test/unit/adapter.test.mjs` | — | new | — | Covers the eligibility matrix one input at a time (13 single-failure cases plus the ordering test that proves an earlier failure hides a later one), the R1 nested rule (dead pid only, unknown/junk is nested), mirror detection (tmpdir comparison with case-insensitive real paths, each shipped asset required individually, malformed `ko.json` rejected), the state-dir rules, `bindingOf` degradation, and every notify code × 3 languages × 2 generation forms, plus the LT-4 degradation matrix (a `null` ctx/env/deps, a bad or non-file module URL, a null module URL falling back to the package root). All paths are scratch directories under `.sandbox/adapter-test-*` inside the repo, created at module load and removed in a single `after` hook; `isTTY`, `pidAlive`, `tmpdir`, `access`, `readFile` and `stateDirResolver` are all injected, so no real temp dir, home, Herdr or owner file is touched. |
| `src/host/sources/todo.mjs` | `packages/todo/src/native-todo.mjs` | adapt (shape only) | 15/15/0 (`packages/todo/test/native-todo.test.mjs`, not copied) | Kept from that file: the phase payload reading (`phases[]` with `name`+`tasks[]`), the `cancelled -> abandoned` mapping, and the rule that a malformed payload is rejected rather than half-converted. Changed with the product and the measured host: the primary source is `ctx.getTodoState()` (L0 G4 returned `[{name,tasks:[{content,status}]}]`), the transcript replay scans for the newest custom `user_todo_edit` entry (`data.phases`) or the newest successful `todo_write` tool result (`details.phases`), matching the binary's own `getLatestTodoPhasesFromEntries` order. Dropped from omo: the `ask` panel payload, phase/task occurrence keys (the renderer derives its own), the scheduler and native task ids. Added: `sourceError` instead of throwing, and a privacy filter (no notes, ids, assignment text or transcript bodies ever leave this module). |
| `test/unit/todo-source.test.mjs` | `packages/todo/test/native-todo.test.mjs` | adapt | 15/15/0 | Kept: the newest-eligible-payload rule, the failed-tool-result exclusion, and the status vocabulary. Adapted: the primary-source behaviour of this product (`getTodoState` first), the round trip through the viewer's own `readProjection` (one contract, not two), and the privacy assertion that notes/ids/assignee never reach the projection. Added: the throwing-accessor fallback, a newer broken payload reported instead of silently falling back to an older "valid" one, and the legacy `{todos:[…]}`/bare `{phases:[…]}` shapes. |
| `scripts/dev-shim.mjs` | `scripts/install.mjs` (shim write only) | adapt | — | Kept: the absolute re-export form `export { default } from '<absolute URL>';` (stage-05 R4, §7.7) and the `case-<id>/.gjc/extensions/gjc-herdr-dashboard.js` location. Changed: this is the *dev* shim, so it also writes three `??=` defaults (`GJC_HERDR_DASHBOARD_STATE_DIR`, `GJC_HERDR_DASHBOARD_HERDR`, optional `GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT` from R3/SR9) and it never touches an existing value. The installer (L6) writes the production shim with env assignments and FAILPOINTs at 0. Header comment records the ESM ordering caveat and proves it is observed, not assumed, by `test/unit/dev-shim.test.mjs`. SR9 places the `FAILPOINT` allowance for this file with `src/core/launch.mjs`; the file itself contains no `FAILPOINT` literal, and the flag is spelled `--viewer-failpoint`. |
| `test/unit/dev-shim.test.mjs` | `test/install.test.mjs` (shim assertions only) | adapt | 6/6/0 (`packages/todo/test/install.test.mjs`, not copied) | Kept: "the shim re-exports by absolute URL, never by relative path" and "the target exists before anything is written". Adapted to the dev shim: the scratch repo and sandbox root live under `.sandbox/dev-shim-test-*` (created in a scratch dir, removed in `after`), and the generated file is imported for real with a cache-busting `?v=` per case, so the ESM ordering claim is observed rather than asserted from text: the entry records what it saw at import time (no defaults yet) and what the factory sees afterwards (defaults applied). Added: the Korean+space case id, `--herdr` JSON validation, `--state` override, and `main`'s exit codes and stderr messages. |
| `locale/{ko,en,zh-cn}.json` (`notify.*` keys) | `packages/dag/src/i18n.mjs` (key naming) | new keys | 1/3/2 (`packages/dag/test/i18n.test.mjs`) | The three catalogues are lane B's file; this lane added the `notify.*` namespace only, which is 47 of the current 65 keys. All three files carry an identical key set with identical interpolation parameters, which lane B's parity test checks generically and `test/unit/adapter.test.mjs` pins for the notify subset. The keys were cross-checked against every code lane C's `src/core/reconciler.mjs` and `src/core/launch.mjs` actually emit, including `partial:ownership-unproven` and `failed:{herdr-split,herdr-process-info,herdr-record,herdr-rename,herdr-run,herdr-close,internal,lock-io,failpoint}`, and a test fails if any of those ever renders its raw token instead of a sentence. omo's baseline i18n test fails two of three assertions in this archive, so it was a naming reference, not a test source. |
| `README.md` | `README.md` | new (Korean) | — | Written for the owner, not copied. Every limitation is traceable: duplicate widget + `alt+shift+t` (AC1.12, E11, A-20), depth-1 workers (§7.6), cost 0 = unknown (K1), no third pane (F1 FAIL, §10), `/todo` G9-conditional reflection (partial L0 G9), restart after a generation change (R5), omo `foreignWaiting` (§7.10), `/reload` unmeasured (G12), schema-major slot reuse (§16), and the M1–M5 manual recovery boundary with R1's exact file operations and the explicit warning that breaking the precondition can produce double ownership. No behaviour is claimed beyond what the tests in this lane and the L0 record support. |

#### Lane D — 복사하지 않은 것 (deliberate)

- omo `packages/todo/src/{controller,presence,native-host,display-bridge,parent-slot,workspace}.mjs`:
  the omo session/custody/presence machinery is what plan §7 replaces; only the phase payload shape
  survived (above).
- omo `packages/dag/src/{controller,viewer,render,model,view-state,terminal-input}.mjs` and
  `packages/dag/test/*`: L2–L5 lanes own these.
- `src/host/instance.mjs`, `extension.mjs`, `src/core/{reconciler,launch,data}.mjs`: other lanes.

#### Lane D — 이 레인이 의존하는 호스트 실측 사실

| fact | source | use here |
|---|---|---|
| `ctx.sessionMetadata.kind === 'main'`, `hasUI===true` for the interactive main; sub has `hasUI===false` | `VERIFICATION.md` G3 | eligibility steps 1–2 |
| `ctx.getTodoState()` returns `[{name, tasks:[{content, status}]}]` | `VERIFICATION.md` G4, `.sandbox/probe-g4.jsonl` | `projectTodo` primary source |
| `todo_write` `tool_execution_end` carries `details.phases`; `/todo` edits append a `user_todo_edit` custom entry and emit no event | `VERIFICATION.md` G4 plus the 0.18.11 bundle's own replay helper (`getLatestTodoPhasesFromEntries` and the `user_todo_edit` reader next to it), read out of the binary in this session | replay order, G9 limitation in README |
| `process.kill(pid,0)` -> success / ESRCH / EPERM | `VERIFICATION.md` G10 | `isNested`, and `pidAlive`'s `null` for "unknowable" |
| two-tree ROOT layout (dev tree, `generation-NNNNNN/`) and the `generation-\d{6}` state rule | `VERIFICATION.md` G8, stage-05 R4 | mirror detection, `defaultStateDirResolver` |
| a tree under `os.tmpdir()` or missing `locale/`/`src/viewers/` is a mirror, `ineligible:mirrored-install` | stage-05 R4 | `isMirrored` |

### Lane E — `extension.mjs` + `src/host/instance.mjs` 단위 테스트

Authority for this lane: stage-03-revision §7.1 (instance rules: one factory per session, arm-time
registry, no factory side effects), §7.2 (eligibility, `layoutKey`/`scopeKey`, L1 rebinding with
`/new`+`/resume`), §7.4 (explicit pass = exactly one notify, automatic pass = no notify, no pane
mutation), §7.5 (R1 lock/owner/nested), §9 LT-4 (the no-silent-no-op matrix) and LT-6 (per-session
factory), §14 AC1.2/AC1.4/AC1.5/AC1.6/AC1.10/AC1.11, and stage-05 R1/R4/R6.

Scope: tests only. `extension.mjs` and `src/host/instance.mjs` are the subject under test and were
not modified by this lane; nothing under `src/` was edited. Every path a test writes lives in a
`mkdtemp` directory removed in `t.after`; no test loads a live Herdr, a live GJC, or the owner's home.

| ours | copy source | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `test/unit/instance.test.mjs` | — (no omo counterpart: omo's lifecycle lived behind `packages/{dag,todo}/src/controller.mjs` and had no per-session factory/registry split to test) | new | — | 33 tests. The **real** modules provide the behaviour: `createInstance` (the subject), `checkEligibility`/`bindingOf`/`notifyText` (`src/host/gjc-adapter.mjs`), `createReconciler` (`src/core/reconciler.mjs`), `createDataWriter` (`src/core/data.mjs`), `layoutKeyOf`/`scopeKeyOf`/`slotPaths`/`dataPaths` (`src/core/slot.mjs`), `projectTodo` (`src/host/sources/todo.mjs`) and `readSlot`'s real validator (so a test slot must be a *valid* slot, not a stub shape). Only the seams the module documents as injectable are replaced: the shared stateful fake Herdr/clock/process table plus its pass tracer (`test/unit/fake-herdr.mjs`), an instrumented `Map` that records `set`/`delete` (LT-6's "zero registry writes"), a hand-written timer rig (no real clock), an injected `nodeResolver` (no process spawn) and, where the 200 ms merge window would make an assertion time-dependent, a `createDataWriter` with `delayMs: 0` and a recording `io.writeJson`. Coverage: LT-4's whole matrix — session-kind, no-ui, tty, outside-herdr, disabled, nested, mirrored-install, state-dir, busy, busy:other-owner, herdr missing, node missing, list failure, `partial:size`, `partial:timeout`, normal `opened`, duplicate `warn:duplicate-install` — each asserting **exactly one** `ctx.ui.notify` carrying the code token the plan names, plus the negative side of every row (zero registry writes, zero Herdr calls, zero files, zero splits, zero closes, and the holder snapshot `pid … · g… · …` for both busy rows); LT-6 (main then sub in one process, sub bus + sub `session_shutdown` leaving main armed with both timers alive and 0 registry writes / 0 Herdr calls / 0 new files; main `session_shutdown` closing 0 panes, keeping the record and stamping `stoppedAt`; `/reload` replace handover with a stray `/dashboard` delegating to the new owner; a different module URL delegating and warning once); AC1.4 (three `/dashboard` calls → one `GJC Todo · <key8>` pane and one split); AC1.5 (outside-herdr token); AC1.10 (the fake's verb log never contains `report-agent`/`report-metadata`/`release-agent`/`send-text`/`send-keys`, driven through every trigger); AC1.11 (a session id changed between handler calls leaves paneId unchanged, moves `slot.scope.scopeKey`, bumps `scopeEpoch` and writes the projection under the new scopeKey); AC1.2 (`todo_write` publishes inside the call, a non-todo tool publishes nothing); the §7.1 item 5 data gate opening and closing; the G9 poll fallback (`state().pollMode === 'event-only'` after a throwing retained ctx, heartbeat timer intact, event triggers still running passes); and the trigger set (turn_end / agent_end / todo_write-only / goal_updated / three bus channels). **One test fails on purpose**: `FAILS-ON-PURPOSE binding-seam-fault` pins the real defect at `src/host/instance.mjs:442` (see the report below). |
| `test/unit/extension.test.mjs` | — | new | — | 5 tests, factory purity only (§7.1 items 1/2/3). The factory body is observed rather than inspected: wrapped `node:fs`/`node:fs/promises` writers republished to already-imported ESM consumers with `syncBuiltinESMExports()`, replaced `globalThis.setInterval`/`clearInterval`, and `process` property descriptors that *record* every read of `env`/`pid`/`platform`/`stdout`/`execPath`/`argv` for the duration of the call. A recording getter is used instead of a throwing one on purpose: Node's own internals read `process.env` for colour detection, and a throw would be attributed to the wrong actor (measured in `.sandbox/probe-trap*.mjs` during this lane). Asserted: no env/platform/pid/stdout read, no timer, no fs write, **no registry map created** (`Object.hasOwn(globalThis, REGISTRY_KEY) === false`), the handle is exactly `{armed, dispose, state}` with `armed:false`, `pollMode:'event-only'`, `instanceId:null` (no id is minted at factory time) and a plain-JSON snapshot; the exact registration list (six `pi.on` handlers, three `pi.events.on` channels, one `registerCommand('dashboard')` with the adapter's description); that the entry point passes this very module's `import.meta.url` as a value (SR5: no dynamic import); a non-vacuity test proving the same accessors ARE recorded once an ineligible handler runs (`process.stdout` for `isTTY`, `process.env` for `HERDR_*`); and two independent factories sharing nothing but the lazy registry. |

#### Lane E — `src/host/instance.mjs`에서 발견한 결함 (보고만, 우회하지 않음)

`/dashboard` can escape the handler with **zero** notifies, which is exactly the E1 defect LT-4
(§9/§14 AC1.5) forbids.

- Location: `src/host/instance.mjs:442` — `const local = bindingOfCtx()(ctx, environment);` inside
  `arm()`. The call is outside any `try`/`catch`, and `arm()` is awaited at
  `src/host/instance.mjs:772` (`const outcome = armed ? { kind: 'owner' } : await arm(ctx, eligibility);`)
  *before* the `try { return await runExplicit(ctx); } catch` block that begins at `:800` and whose
  own comment at `:802` claims to be "the last resort for a fault in the steps before it (binding,
  rebind)".
- Trigger: any `deps.bindingOf` that throws (a documented injectable seam), or a seam that returns
  `undefined` — the same fault class as a host whose `sessionManager` accessor throws. Measured in
  `.sandbox/probe-instance-adversarial.mjs`: `bindingOf: () => { throw … }` → 0 notifies and the
  error propagates to the caller; `bindingOf: () => undefined` → `TypeError: Cannot read properties
  of undefined (reading 'socket')`, also 0 notifies.
- Failing test name (left in place): **`FAILS-ON-PURPOSE binding-seam-fault: a throwing binding seam
  still owes one notify`** in `test/unit/instance.test.mjs`.
- Impact: the real `bindingOf` never throws and always returns an object, so the shipped product is
  not broken today; the gap is between the module's stated contract (`deps` are all injectable; the
  handler never throws and always notifies once) and its code. Suggested fix (not applied, src is
  out of scope for this lane): move the `await arm(...)` inside the existing `try`, or wrap the
  `bindingOfCtx()(...)` call in `arm()` with the `record()` + `{ kind: 'invalid' }` path that already
  exists for a bad binding.

#### Lane E — 그 밖의 관찰 (코드 변경 없음, 테스트 수준)

1. The `busy`/`busy:other-owner` notify carries the pass's own lock view (`pid unknown · g<N> · <lock dir>`),
   not the foreign holder's pid, because `runExplicit` → `notify(ctx, result, …)` passes a result whose
   `lock` is the pass's own and `detail` is a string. The adapter renders unknown rather than guessing,
   which matches its documented rule, so the test pins the actual rendering.
2. Arming writes the owner record itself before the first pass, so the "foreign live owner" row is
   reachable only after arming (or by another process); the test models exactly that.
3. `state()` reports `moduleUrl` from `deps.moduleUrl`, so a factory test can prove the entry point
   passes `import.meta.url` as a value.

#### Lane E — 이 레인의 테스트 수 (isolated `node --test --test-isolation=none`)

| file | tests | pass | fail |
|---|---|---|---|
| `test/unit/instance.test.mjs` | 33 | 32 | 1 (the intentional bug pin above) |
| `test/unit/extension.test.mjs` | 5 | 5 | 0 |
| total | 38 | 37 | 1 |

### Lane A/C/D/E 이외 — 아직 매핑하지 않은 파일

아래 파일은 위 레인 표에 아직 행이 없다. 레인 문서가 없는 파일이므로 여기서 한 줄씩만 기록한다
(다음 레인이 자기 행을 추가한다).

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `extension.mjs` | — | new | — | 진입점은 `src/host/instance.mjs`의 factory만 등록한다(Lane E가 테스트만 담당; `extension.mjs` 자체는 수정 없음). |
| `src/host/instance.mjs` | — | new | — | arming·레지스트리·delegate·nested/mirror/state 판정. Lane E가 `test/unit/instance.test.mjs`로 관측하며, `:442` 결함은 위 Lane E 보고 참고. |
| `test/unit/common.test.mjs`, `test/unit/i18n.test.mjs`, `test/unit/render.test.mjs`, `test/unit/terminal-input.test.mjs`, `test/unit/viewer.test.mjs` | (Lane B 표 참고) | adapt/new | — | Lane B 표에 이미 행이 있다. |
| `test/unit/static-rules.test.mjs` | — | new | — | phase 1의 정적 규칙 테스트(SR1-SR9), 21/21. Lane C가 green 확인. |
| `test/unit/live-wrapper.test.mjs` | — | new | — | `test/live/{herdr-wrapper,fixture,case}.mjs` 래퍼의 단위 테스트(14). 라이브 재현 절차는 L1–L6 예정(`README.md` 표). |
| `test/live/*.mjs` | — | new | — | 실 Herdr 없이 돌릴 수 없는 라이브 재현 절차. 결과는 `VERIFICATION.md`의 LV 표에 있다. |
| `scripts/{baseline-omo,test}.mjs` | — | new | — | omo 기준선 실행기와 테스트 러너(우리 도구, 복사 원천 아님). |

### Lane F — Workers 렌더러 (L2)

기준선은 `.evidence/L0/baseline-omo.json`의 `b2.<파일>` 값이다(파일별 `node --test`, 격리 env).

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/viewers/workers/render.mjs` | `packages/dag/src/render.mjs` | adapt | 15/7/8(`dashboard-b.test.mjs`) | omo의 DAG 카드에서 **카드 골격만** 가져왔다: 상태 글리프 + 제목 1행, 문맥 2행(도구·의도·마지막 출력), 지표 3행, 그리고 "그려진 모든 행은 pane 폭을 넘지 않는다" 규칙. 뺀 것: DAG 그래프와 run 선택기, 모델/effort 배지, 상자 그리기, 하위 작업 들여쓰기, omo 자체 투영에만 있는 지표 어휘(`metricUnknown`·`cost_status`·`tokens_per_second` 등). 프레임 골격(헤더 → 본문 → 구분선 → 호출자가 준 footer)과 스크롤·선택 계약은 `src/viewers/todo/render.mjs`를 따랐다. omo의 `compactDuration`(`{count}h/{count}m/{count}s`)은 어휘를 그대로 쓰되 키를 `workers.compact*`로 분리했다. **footer는 이 모듈이 만들지 않는다**: 호출자가 이미 완성한 줄 배열을 받아 그대로 마지막 행으로 붙이고, 자르지도 감싸지도 않는다(AC-F1·AC-F3의 내용 단언은 호출자 몫). `color`는 이미 크기가 정해진 run만 SGR로 감싸므로 폭을 바꿀 수 없다(테스트로 고정). 2026-10-20: omo `3242ad4` 문법에 다시 맞췄다(`GRAMMAR.md`). |
| `test/unit/workers-render.test.mjs` | `packages/dag/test/dashboard-b.test.mjs` | adapt + new | — | omo 테스트에서 "카드 한 장을 여러 폭에서 검사한다"는 발상만 가져왔고, 단언은 우리 계약으로 새로 썼다. 상태 6종 × 24/40/54열 × ko/en 스냅샷(폭이 아니라 내용을 단언), 완료 카드 자동 접힘과 `c`/카드별 펼침, 실패와 중단의 글리프·단어 구분(AC2.2), 24열에서 제목과 상태가 함께 남는지(AC-F4), 선택 이동과 양 끝 클램프, `d` 상세 보기, 스크롤 클램프와 follow, 알 수 없는 비용·컨텍스트의 `?` 표기(K1; 0도 알 수 없음), 호출자 footer의 무손실 통과, 색상이 폭을 바꾸지 않는지, 적대적 제목의 제어문자 제거. 33/33. 2026-10-20: omo `3242ad4` 문법에 다시 맞췄다(`GRAMMAR.md`). |
| `test/unit/grammar.test.mjs` | — | new | — | 2026-10-20: omo `3242ad4`에 다시 맞춘 pane 문법 규칙(G1..G13)의 rule-id 검사. `GRAMMAR.md` 참고. |
| `locale/{ko,en,zh-cn}.json` | `packages/dag/src/i18n.mjs`(workers 어휘) | adapt | — | `workers.` 접두사 키 29개(상태 7·지표 5·압축 기간 3·상세 필드 7·본문 4·제목/미상/백그라운드 3)를 추가했다. omo 표에서 `metricUnknown`·`cost`·`compactHours/Minutes/Seconds`에 대응하는 어휘를 가져왔지만 omo의 지표 키(`input_tokens` 등)는 우리 투영에 없어 넣지 않았다. 실패(`workers.status.failed`)와 중단(`workers.status.aborted`)은 세 언어 모두 다른 단어다. 세 파일은 키·보간 파라미터가 동일하다(`test/unit/i18n.test.mjs`가 단언). |

## Re-alignment with omo-herdr-dashboard 3242ad4 (2026-10-20)

The pane grammar was re-aligned with omo-herdr-dashboard at `3242ad43561e10bc66b3f28b6345420962b4df99`. The rules and their OMO source lines are in GRAMMAR.md; nothing was vendored, the grammar is ported by hand. Files re-aligned:

- `src/viewers/common.mjs`
- `src/viewers/todo/render.mjs`
- `src/viewers/workers/render.mjs`
- `src/viewers/workers/viewer.mjs`
- `locale/*.json`
