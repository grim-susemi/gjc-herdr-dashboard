# gjc-herdr-dashboard 인수인계 (중단 시점)

## 상태
- 저장소: C:/Users/USER/orca/projects/gjc-herdr-dashboard, HEAD `dda646e`, 작업 트리 clean.
- ultragoal: G001–G003 완료, **G004(L4) active**, G005·G006 대기. 약 60%.
- 단위 546/546 (2회), 라이브 10종 첫 시도 PASS, AC-G1 동일.

## G004 남은 일 (이것만 하면 닫힘)
1. architect 재리뷰를 HEAD `dda646e`에서 받는다. 직전 리뷰(0b8d8be)는 HIGH 0건, REQUEST_CHANGES 2건(B1 explicit 경로 선-rebind, B2 문서 수치/LV-10)이었고 둘 다 수정·커밋됨. 재리뷰는 취소됐으니 새로 발주.
   - architect 모델: anthropic/claude-opus-5-5 (7일 한도 리셋 후 정상 동작 확인됨).
2. APPROVE면: `.sandbox/mkgate-g003.mjs`를 복제해 `mkgate-g004.mjs` 작성 → `gjc ultragoal quality-gate source-hash --json`(현재 sha256:4cef29ff…, 커밋 후 재계산) → `gjc ultragoal quality-gate validate --quality-gate-json … --goal-id G004` → `gjc ultragoal checkpoint --goal-id G004 --status complete --evidence … --quality-gate-json … --json`.
3. REQUEST_CHANGES면 지적 수정 → `node scripts/test.mjs` → 라이브 재실행(`GJC_LIVE_EVIDENCE_LEVEL=L4`) → 재리뷰.

## G005 (L5b) 사전 측정 완료
- F1 재측정: `typeof ctx.getProjectProgress === 'undefined'` → 3번째 pane 생략 확정. 증거 `.evidence/L5/goalsurface/`.
- 0.18.11 `ctx.getGoalState()` = goal 없으면 undefined, 있으면 `{enabled, mode, goal:{id,objective,status,tokensUsed,timeUsedSeconds,...}}`. `goal_updated` 이벤트 `{type, goal, state}` 약 1회/초. `/goal <text>`는 실제 slash 명령.
- 구현 미시작: `src/host/sources/goal.mjs`, `data/<scopeKey>/goal.json`, Todo 뷰어 머리줄, 34열 footer 확인, README 생략 근거.
- G004 체크포인트 전에는 src를 바꾸지 말 것(source hash가 달라져 architect 승인이 무효화됨).

## G006 (L6)
- scripts/{build,install,verify-package,dev-shim}.mjs, 드릴 D1–D4(샌드박스 agent-dir만), AC6.1·6.4, 최종 VERIFICATION/README.
- 사용자 범위 설치(`~/.gjc/agent/extensions/`)는 소유자 승인 필요 → 명령만 준비해 보고.

## 주의
- bash 파이프/heredoc 불안정: `write`/`edit` 또는 `node -e fs.writeFileSync`, 출력은 파일로 덤프 후 read.
- 미커밋 src 수정 후 `git checkout <file>`로 되돌리면 작업이 날아감(이번에 한 번 겪음).
- 라이브 테스트는 gjcdash-* 세션만. 소유자 pane w1:pT5 입력 금지. omo 경로 읽기 전용.
- goal pause는 시스템이 "해결 가능한 작업 있음"으로 거부함 → 사용자가 직접 세션을 종료하거나 새 세션에서 `goal resume`/계속.
