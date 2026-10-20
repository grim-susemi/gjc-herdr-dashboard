import { readFileSync, writeFileSync } from "node:fs";
let s = readFileSync("VERIFICATION.md", "utf8");
const sub = (re, to) => {
  if (!re.test(s)) throw new Error("nomatch " + re);
  s = s.replace(re, () => to);
};
sub(/\| G3 \|[^\n]*\n/, "| G3 | main/sub의 kind·hasUI·isTTY | main(interactive): hasUI=true, isTTY=true. `-p` 모드: main kind=main depth=0 hasUI=false isTTY=false. 서브에이전트(`task`, executor)는 `sessionMetadata.kind=\"sub\"`, `taskDepth=1`, `currentAgentType=\"executor\"`, hasUI=false, isTTY=false이고 같은 프로세스에서 factory가 세션마다 한 번씩 호출됨(인스턴스 3개: main 1 + sub 2). `ctx.mode`는 없음. 대화형 main 아래의 sub는 락 문제로 실측하지 못했다(아래 한계) | PASS(`kind`와 hasUI로 판별 가능, 대화형 sub는 미실측) | `probe-g3-g5-fg.jsonl` |\n");
sub(/\| G5 \|[^\n]*\n/, "| G5 | foreground 1 + background 1 서브에이전트 | main bus(`pi.events`)에서 `task:subagent:lifecycle`(keys: agent, agentSource, description, id, index, sessionFile, status; `status:\"started\"`), `task:subagent:progress`, `task:subagent:event`를 수신(2개 병렬 실행에서 205건). `tool_execution_update`(task)의 `details.async.state`는 running -> completed이고 `details.progress[]`가 pending -> running -> completed로 바뀐다. `ctx.getJobs()`는 `{running:[{id,label,type:\"task\",status,startTime,endTime,metadata}], recent, delivery}`. `task`는 기본 async(background job)이고 `subagent await`로 기다려도 같은 경로로 관측된다. 별도의 foreground 전용 경로는 이 빌드에서 확인되지 않았다 | PASS(main bus 이벤트 + `getJobs`) | `probe-g3-g5-fg.jsonl`, `probe-g5-bg-await.jsonl` |\n");
sub(/\| G8 \|[^\n]*\n/, "| G8 | production 형태 shim, R4의 두 트리 | (i) dev 트리 `.sandbox/g8-tree-dev/`와 (ii) 세대 트리 `.sandbox/case-probe-gen/.gjc/herdr-dashboard/generation-000001/`를 각각 절대 URL 재수출 shim으로 gjc가 로드. 둘 다 entry `import.meta.url`이 실경로(`gjc-legacy-pi-file` mirror 아님), `ROOT_URL=new URL(\"./\", import.meta.url)`, `locale/ko.json` 읽기·파싱 성공, `src/viewers/common.mjs` R_OK 성공. Node로 직접 실행한 probe viewer가 `new URL(\"../../\", import.meta.url)` ROOT의 locale(`locale-ko-ok`)을 출력. (ii)의 state dir 규칙(`generation-\\d{6}` + 부모 `herdr-dashboard`)은 `…/herdr-dashboard/state`로 계산되고 (i)은 null | PASS | `probe-g8-dev.jsonl`, `probe-g8-gen.jsonl` |\n");
sub(/\| K1 \|[^\n]*\n/, "| K1 | 서브에이전트 cost 변화 | `details.progress[].cost`는 모든 시점에서 0이고 `tokens`만 0 -> 약 13.7k로 증가한다(구독 모델이라 비용이 보고되지 않음). 따라서 cost 0은 \"알 수 없음\"으로 표시해야 한다(계획의 실패 경로 확정) | 확정(0 = 알 수 없음) | `probe-g3-g5-fg.jsonl` |\n");
sub(/### 남은 항목 \/ 한계[\s\S]*?\n\n### 프로브/, `### 남은 항목 / 한계
- **G12** \`/resume\`, \`/fork\`, reload 이벤트 순서: \`/new\`만 실측했다(\`session_before_switch\` -> \`session_switch\`, reason \`new\`, factory 재호출 없음). \`SessionSwitchEvent.reason\`은 \`"new"|"resume"|"fork"\`로 선언돼 있다. 대화형 \`gjc\`를 다시 띄우려 했으나 공용 SDK 인덱스 락(\`~/.gjc/agent/sdk/sessions/index.jsonl.lock\`, 09:49 생성)이 \`acquire_timeout\`으로 새 대화형 세션을 막았다. 그 락은 이 작업의 프로세스 소유가 아니어서 건드리지 않았다. §7.1③는 "같은 sessionId + 같은 moduleUrl이면 교체" 규칙이 reload를 덮으므로 분기 선택은 /new와 같은 \`session_switch\` 처리로 두고 L4에서 실측한다.
- **G9** switch 이후 보관 ctx 사용: 타이머는 switch 이전에만 실측했다. \`session_switch\` 후에는 이벤트로 갱신한다는 계획의 실패 경로를 기본으로 삼는다.
- **G3** 대화형 main 아래의 sub는 실측하지 못했다(위와 같은 락). print 모드의 sub 판별은 확인했다.
- B1/B2 baseline 실패 13개 중 유지 기능 테스트의 적응은 L1 이후.
- 소유자 Go는 아직 받지 않았다.

### 프로브`);
writeFileSync("VERIFICATION.md", s);
console.log("updated");
