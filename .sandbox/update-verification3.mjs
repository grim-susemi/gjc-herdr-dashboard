import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("VERIFICATION.md", "utf8");
const sub = (re, to) => {
  if (!re.test(s)) throw new Error("nomatch " + re);
  s = s.replace(re, () => to);
};
sub(/\| G3 \|[^\n]*\n/, "| G3 | main/sub의 kind·hasUI·isTTY | **대화형 main**: `sessionMetadata.kind=\"main\"`, `taskDepth=0`, hasUI=true, isTTY=true. **대화형 main 아래의 서브에이전트(`task`, executor)**: `kind=\"sub\"`, `taskDepth=1`, `currentAgentType=\"executor\"`, **hasUI=false**, isTTY=true(대화형은 sub도 같은 터미널의 stdout을 공유하므로 isTTY만으로는 구분할 수 없다). print 모드: main hasUI=false, sub hasUI=false/isTTY=false. 세션마다 factory가 한 번씩 호출됨(인스턴스: main 1 + sub 1). `ctx.mode`는 없음. 판별 기준은 `sessionMetadata.kind`와 hasUI이고 isTTY는 쓰지 않는다 | PASS | `probe-interactive-no-session.jsonl`, `probe-g3-g5-fg.jsonl` |\n");
sub(/\| G9 \|[^\n]*\n/, "| G9 | 보관한 ctx로 1s 타이머 `getLeafId`, switch 뒤 `getSessionId` | 시작 시 보관한 ctx로 2s 간격 호출(`G9-interval`)을 `/new` 전후로 계속 실행했다. `/new`(`session_switch`) 뒤에도 보관 ctx의 `sessionManager.getSessionId()`/`getLeafId()`는 예외 없이 string을 반환했다(전환 후 호출 7회 이상). 단 보관 ctx가 새 sessionId를 보는지 옛 것을 보는지는 값 비교를 하지 않아 모른다(타입만 기록). `/resume`·`/fork` 뒤는 미측정 | 부분(예외 없음은 확인, 값의 신선도는 모름 -> 계획의 실패 경로 \"이벤트로 갱신\"을 기본으로 채택) | `probe-interactive-no-session.jsonl` |\n");
sub(/\| G12 \|[^\n]*\n/, "| G12 | `/reload`·`/new`·`/resume`·`/fork` 이벤트 순서, reload 때 이전 인스턴스가 shutdown을 받는지 | `/new`(대화형, `--no-session`): main에서 `session_before_switch`(reason=new) -> `session_switch`(reason=new)이고 factory 재호출 없음, 같은 프로세스. `session_shutdown`은 sub 세션 종료에서만 관측됨. `/fork`는 `--no-session`에서 `Error: Fork requires a persisted session`으로 불가. `/resume`은 저장된 세션이 있어야 하는데 이 환경에서 persisted 대화형 시작이 공용 SDK 인덱스 락(`~/.gjc/agent/sdk/sessions/index.jsonl.lock`)에 막혀 측정하지 못했다. `/reload`는 slash 명령이 아니라서 측정하지 못했다. `SessionSwitchEvent.reason`은 `\"new\"|\"resume\"|\"fork\"`로 선언돼 있다 | 부분(`/new`만 실측; 나머지는 §7.1③의 동일 sessionId+동일 moduleUrl 교체 규칙이 reload를 덮는다) | `probe-interactive-no-session.jsonl`, `probe-g12-new.jsonl` |\n");
sub(/### 남은 항목 \/ 한계[\s\S]*?\n\n### 프로브/, `### 남은 항목 / 한계
- **G12** \`/resume\`·\`/fork\`·reload: 위 표. persisted 대화형 시작은 공용 SDK 인덱스 락(09:49 KST에 생긴 owner 기록 없는 빈 디렉터리)에 막힌다. \`--no-session\` 대화형은 락을 피해 시작되지만 fork/resume이 불가능하다. 이 락은 이 작업의 소유가 아니고 \`file-lock.ts\`가 소유 증명이 없는 락은 지우지 않으므로 건드리지 않았다. 환경변수로 agent-dir를 바꾸는 우회는 G13 정정대로 이 바이너리에서 따라지지 않았다.
- **G9** 전환 후 보관 ctx는 예외가 없음만 확인(값의 신선도는 미확인).
- **G13** user-scope 설치 드릴 불가(위 표). L6 드릴은 dev shim 경로 + 소유자 승인 아래의 사용자 범위 드릴로 진행한다.
- **G5** foreground 전용 경로는 이 빌드에서 확인되지 않았다(\`task\`는 기본 async).
- B1/B2 baseline 실패 13개 중 유지 기능 테스트의 적응은 L1 이후.
- 소유자 Go는 아직 받지 않았다.

### 프로브`);
writeFileSync("VERIFICATION.md", s);
console.log("updated");
