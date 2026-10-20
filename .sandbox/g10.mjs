const t = (pid) => { try { return String(process.kill(pid, 0)); } catch (e) { return e.code; } };
console.log(JSON.stringify({ runtime: typeof Bun !== "undefined" ? "bun" : "node", self: t(process.pid), dead: t(999999), system4: t(4), pid1: t(1) }));
