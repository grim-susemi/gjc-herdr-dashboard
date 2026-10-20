import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("VERIFICATION.md", "utf8");
const sub = (re, to) => {
  if (!re.test(s)) throw new Error("nomatch " + re);
  s = s.replace(re, () => to);
};
sub(/\| G9 \|[^\n]*\n/, "| G9 | 보관한 ctx로 1s 타이머 `getLeafId`, switch 뒤 `getSessionId` | 전환 이전: 타이머 호출에 예외 없음, `getLeafId`·`getSessionId`는 string 반환. **전환(`/new`, `/resume`, `/fork`) 이후 보관 ctx 사용은 미측정** | 부분(전환 전만 PASS, 전환 후 미측정 -> 계획의 실패 경로 \"이벤트로만 갱신\"을 기본으로 채택) | `probe-g1-headless.jsonl` |\n");
sub(/\| G13 \|[^\n]*\n/, "| G13 | `GJC_CODING_AGENT_DIR`로 바꾼 agent-dir의 `extensions/*.js`를 project-scope에서 로드(드릴용) | **정정: user-scope 로드는 확인하지 못했다.** 앞선 PASS는 같은 case 디렉터리의 project-scope shim(`work/.gjc/extensions/`)이 남아 있어서 생긴 오판이었다. project-scope shim을 제거하고 다시 돌리면 `GJC_CODING_AGENT_DIR`로 지정한 agent-dir의 `extensions/`는 로드되지 않았다(`probe-g13v` 재현). 같은 환경변수로 실행한 `gjc config path`도 `C:\\Users\\USER\\.gjc\\agent`를 출력했고, 대화형 시작은 여전히 `C:\\Users\\USER\\.gjc\\agent\\sdk\\sessions\\index.jsonl.lock`을 잡으려 했다. 즉 이 0.18.11 바이너리는 이 환경에서 `GJC_CODING_AGENT_DIR`를 따르지 않는다(원인은 미확인) | FAIL(user-scope 드릴 불가) -> 계획 경로: 드릴은 dev shim 경로로만 하고 L6 사용자 범위 드릴은 소유자 승인 아래에서 | `.sandbox/probe-g13v` 재현 명령 |\n");
sub(/### 남은 항목 \/ 한계[\s\S]*?\n\n### 프로브/, `### 남은 항목 / 한계
- **G12** \`/resume\`, \`/fork\`, reload 이벤트 순서: \`/new\`만 실측했다(\`session_before_switch\` -> \`session_switch\`, reason \`new\`, factory 재호출 없음). \`SessionSwitchEvent.reason\`은 \`"new"|"resume"|"fork"\`로 선언돼 있다. 대화형 \`gjc\`는 공용 SDK 인덱스 락(\`~/.gjc/agent/sdk/sessions/index.jsonl.lock\`, 09:49 KST에 생성된 빈 디렉터리, owner 기록 없음)에 막혀 \`acquire_timeout\`으로 종료한다. 이 락은 이 작업의 소유가 아니고 \`file-lock.ts\`가 소유 증명이 없는 락은 지우지 않으므로 건드리지 않았다. 격리 agent-dir로 우회하려 했으나 G13 정정대로 환경변수가 이 바이너리에서 따라지지 않아 같은 락을 다시 만났다. \`gjc -p --resume/--fork\`는 실행 중 전환 이벤트를 검증하지 못하므로 대체 수단이 아니다.
- **G9** 전환 후 보관 ctx 사용 미측정(위 표). **G3** 대화형 main 아래의 sub 미측정(print 모드의 sub 판별만 확인).
- **G13** user-scope 설치 드릴 불가(위 표). L6 드릴은 dev shim 경로 + 소유자 승인 아래의 사용자 범위 드릴로 진행한다.
- B1/B2 baseline 실패 13개 중 유지 기능 테스트의 적응은 L1 이후.
- 소유자 Go는 아직 받지 않았다.

### 프로브`);
writeFileSync("VERIFICATION.md", s);
console.log("updated");
