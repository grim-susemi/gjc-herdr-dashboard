omo를 읽기만 했고 실행하지 않았다).

### 4.8 reload는 실측하지 않았다 (G12)

`/new`는 실측했다(`session_before_switch` → `session_switch`, factory 재호출 없음, 같은 프로세스).
`/resume`·`/fork`·`/reload`는 이 환경에서 측정하지 못했다(persisted 세션 시작이 공용 SDK 인덱스
락에 막힘, `/reload`는 slash 명령이 아님). 대응: 같은 sessionId + 같은 moduleUrl이면 인스턴스를
교체하고, sessionId가 같고 moduleUrl만 다르면 교체하지 않고 delegate + `warn:duplicate-install`
1회로 처리한다.

### 4.9 스키마가 바뀌면 다음 `/dashboard`에서 새 slot이 된다

같은 slot schema **major**끼리만 호환된다. 모르는 schema는 T18로 격리하고 새로 시작한다.
마이그레이션 계층은 없다.

### 4.10 수동 lock/owner 복구 경계 (M1–M5)

일반적인 래치는 R1 설계로 제거되었으므로 **평소에는 수동 개입이 필요 없다.**
