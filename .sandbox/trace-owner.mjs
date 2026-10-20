import { decideOwnerPhase } from '../src/core/transitions.mjs';
const owner = { schema: 'x', pid: 4244, instanceId: 'inst-1', sessionId: 's-1', heartbeatAt: 1, stoppedAt: 2 };
console.log(JSON.stringify(decideOwnerPhase({ owner, instanceId: 'inst-2', pid: 4244, registryOwnerInstanceId: 'inst-2', pidAlive: () => true, now: 3 })));
console.log(JSON.stringify(decideOwnerPhase({ owner, instanceId: 'inst-2', pid: 4244, registryOwnerInstanceId: undefined, pidAlive: () => true, now: 3 })));
