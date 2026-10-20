# gjc-herdr-dashboard 재개 방향 (2026-10-20, OMO ulw-loop 세션 01a1555d)

## 실측한 현재 상태
- HEAD `dda646e` (main = origin/main), 작업 트리 clean. `node scripts/test.mjs` 546/546 PASS (2026-10-20 재실행, `.sandbox/omo-baseline-test.txt`).
- 기능: Todo pane(L1), Workers pane + 2역할 band(L2), 마우스·포커스(L3), 재시작 adopt·손상 격리·retention·공존·잠금(L4) 구현과 라이브 10종 PASS 기록이 있다.
- 남은 것: G004 마감 리뷰, G005 L5b(목표 1줄 머리줄), G006 설치 CLI·세대·드릴 D1–D4·문서, 사용자 범위 설치(소유자 승인).

## 멈춘 원인 (기록 대조)
1. 검토 루프: L4 하나에 architect 4라운드 + critic 1라운드(2026-10-18 03:34 → 10-19 00:43, 약 21시간). 라운드마다 새 경쟁 조건을 찾아 범위가 계속 늘었다.
2. source-hash 결합: gjc ultragoal 품질 게이트가 src 해시에 승인을 묶어서, 리뷰가 끝날 때까지 다음 계층(src 변경)을 시작할 수 없었다 → 완전 직렬.
3. 라이브 흔들림: TUI 키 유실·idle 판정 때문에 같은 라이브 스크립트를 여러 번 재실행.

## 새 방향 (끝내기 우선)
1. G004는 **델타 리뷰 1회**로 닫는다: `0b8d8be..dda646e`에서 B1·B2 수정이 맞는지만 본다. 델타 안의 HIGH 결함만 막고, 나머지는 후속 목록으로 넘긴다. 추가 라운드 없음.
2. G005(L5b)와 G006(설치·드릴)은 서로 파일이 겹치지 않으므로 **별도 worktree에서 병렬** 구현한다. src 해시 결합은 쓰지 않는다(리뷰는 커밋 범위로 고정).
3. 검증은 델타 방식: 변경분 단위 테스트 + 새 라이브 스크립트 1회 + 통합 뒤 전체 단위 1회 + 대표 라이브 회귀 1회.
4. 최종 리뷰는 G005+G006 통합 델타에 **1회**, 수정 라운드 최대 1회.
5. 사용자 범위 설치(`C:/Users/USER/.gjc/agent/extensions/`)는 소유자 결정 1건으로 묻고, 승인되면 AC6.2/AC6.3을 실측한다.
6. gjc ultragoal 장부(G004 active, G005·G006 pending)는 손대지 않는다(2026-10-20 결정): 체크포인트에 원래 gjc 세션 id와 source-hash·품질 게이트 JSON이 필요하고, 다른 하네스가 그 장부를 대신 쓰면 gjc의 lease/succession 상태와 충돌할 수 있다. 이번 완료 기록의 정본은 OMO ulw-loop(.omo/ulw-loop/01a1555d-…)과 VERIFICATION.md다. gjc에서 이 저장소를 다시 열어 ultragoal이 G004를 이어가려 하면 그 세션에서 완료/대체(superseded) 처리한다.
