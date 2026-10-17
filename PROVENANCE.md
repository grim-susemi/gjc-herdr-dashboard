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

L1 이후 복사한 파일마다 {원본@SHA, 기준선 상태, 유지/적응/제외}를 이 아래에 추가한다.
