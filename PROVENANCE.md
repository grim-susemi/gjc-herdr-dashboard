# PROVENANCE

복사 원천: omo-herdr-dashboard (읽기 전용, `git archive`로 풀어서 사용).

## 고정 SHA

| 항목 | 값 |
|---|---|
| 계획에 적힌 SHA | `26e60ca20a2152c7c00fa6a060c78f697f752ff4` |
| L0 시점 `main` | `4082c7509c4a2f8a53128b85bfd38acf017a52c3` |
| 고정한 SHA | `4082c7509c4a2f8a53128b85bfd38acf017a52c3` |
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
| `src/viewers/common.mjs` | `packages/todo/src/render.mjs`(텍스트 프리미티브), 그 밖에는 없음 | adapt + new | 7/20/13(render.test.mjs) | `clean`/`width`/`fit`/`wrap` 네 프리미티브는 omo `todo/src/render.mjs`에서 그대로 가져왔다(그 파일이 다시 `omo-herdr-dag-follow`에서 온 것이라 라이선스 고지를 유지했다). `clean`은 `stripVTControlCharacters`를 먼저 적용하도록 고쳤다 — omo의 정규식만으로는 `\x1b[2J` 같은 CSI가 남아 프레임에 살아남는다(테스트로 고정). 나머지(heartbeat, slot watch, token fence, owner liveness, footer, `q`)는 **신규**다: omo에는 대응물이 없고(presence/lease/custody, parent-slot sqlite) 계획 7.3⑥·7.9가 새로 정의한 동작이다. |
| `test/unit/common.test.mjs` | — | new | — | 공유 헬퍼 전용 테스트. omo에 대응 테스트가 없다. 라벨 5종 상호 구별(AC1.9), footer 토큰 순서와 legend 0, `generationOf`, `readyRecord` 필드, 5s heartbeat 타이머와 실패 표면화, fence 판정 8분기, watcher 1s 폴링·읽기 오류 보존, `ownerLiveness` 경계(stoppedAt 즉시 / 20000ms 경계 / 살아 있는 pid는 stale heartbeat에도 live), `closeOwnPane` 4분기. |
| `src/viewers/todo/render.mjs` | `packages/todo/src/render.mjs` | adapt | 7/20/13 | 프레임 렌더러를 공유 투영 계약(`phases[].tasks[]` 4상태)으로 다시 썼다. 유지: phase 그룹핑, 닫힌 phase 접기(`c`), 스크롤, 선택 마커와 범위, 34/52열 좁은 레이아웃, 한국어/CJK 셀 폭, footer를 자르지 않는 절단. 제거: ask 패널과 별도 스크롤, 65ms strike 애니메이션과 `STRIKE_*`, `native-todo`/`phaseSummaries`/`taskKeys` 결합, `runningTarget`의 omo 고유 타깃 상속, availability 어휘(`current`/`last-known`), 클릭 범위의 `closedRange`. 자동 접기는 **닫힌 phase에만** 적용한다: pending 작업을 자동으로 숨기면 todo 목록의 목적이 사라지므로(테스트로 반대 동작을 고정). |
| `test/unit/render.test.mjs` | `packages/todo/test/render.test.mjs` | adapt | 7/20/13 | 유지: 셀 폭/절단/줄바꿈 오라클, 레이아웃 행렬(80/52/40/34/24/12/1열), phase shell 접근성, 닫힌 phase 접기와 카운트, 적대적 제어 시퀀스, 읽기 오류 행 고정. 적응: 픽스처를 `projectNativeTodo`에서 공유 계약 객체로, `ask` 스크롤·strike 프레임·클릭 범위 테스트는 대응 기능이 없어 제거(아래 미복사 항목). 추가: 3언어 x 34/52열 footer 내용 단언(AC-F3), 라벨 4종 구별, 선택 폴백, 좁은 열에서 footer 무손실. |
| `src/viewers/todo/viewer.mjs` | `packages/todo/src/viewer.mjs` | adapt | 13/21/8 | CLI 형태(`--state/--layout/--role/--token/--pane/--once/--lang/--width`)와 `--once` 계약, prefs 원자 저장, `f`/`c`/`j`/`k`/`q` 키는 유지했다. 제거: presence/ACK 프로토콜, producer-custody·retirement 서버, `readViewerCache`/`createSnapshotStorage` 결합, `validateRoleBinding`의 omo role 스키마. 추가: 계획 7.3⑥ token fence, `<state>/data/<scopeKey>/todo.json` 투영 읽기, slot.json 변경 시 scope 재바인딩(AC1.11), prefs를 `<state>/prefs/<scopeKey>/todo.json`에 per-scopeKey로 저장(AC1.3: `follow`는 저장하지 않고 fold·선택만 복원), `GJC_HERDR_DASHBOARD_VIEWER_READY_DELAY_MS`(25s 지연), owner.json 생존 라벨. 뷰어가 쓰는 상태 파일은 자기 `roles/<role>.ready.json` 하나뿐이고 `slot.json`/`owner.json`은 읽기 전용이다. |
| `test/unit/viewer.test.mjs` | `packages/todo/test/viewer.test.mjs` | adapt | 13/21/8 | 유지: 인자 파싱, `--once` 프레임, 키 입력에 따른 프레임 변화, prefs가 재개봉을 넘어 복원되는 동작. 적응: presence 파이프 픽스처를 fake port + fake clock + fake herdr로 바꿔 실제 Herdr·실제 시계·소유자 HOME을 건드리지 않는다(이 저장소의 L1 제약). 추가: fence 3종(토큰 불일치/역할 없음/closed; 무효 slot은 은퇴 사유 아님), `HERDR_PANE_ID` 불일치 시 close 0, scope 전환, AC1.3 시퀀스, ready 지연 24999/25000ms 경계, owner 5s/20s 라벨, 잘못된 `--lang` 폴백 footer, prefs 손상 시 비치명, usage 오류 exit 2. |

### Lane A — core state (참조)

Lane A의 상세 행은 `.sandbox/provenance-A.md`에 있다(git 제외, 이 뷰어 레인이 만든 파일이 아니다).
Lane B가 실제로 의존하는 계약만 적는다.

| ours | omo path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/storage.mjs`(Lane A 소유) | `packages/dag/src/storage.mjs` | adapt | 3/3/0 | Lane B는 이 모듈을 **읽기 전용 의존**으로만 쓴다: prefs 저장과 `roles/<role>.ready.json` 쓰기에 `writeJson`을 그대로 부른다(중복 구현 없음, SR5 때문에 정적 import). 파일 자체는 수정하지 않았다. |

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

### Lane A rows

### Lane C rows

### Lane D rows
