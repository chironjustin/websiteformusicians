export function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function jitter(min, max) {
  return min + Math.random() * (max - min);
}

export function weightedDelayInWindow(windowSeconds) {
  const centerWeighted = (Math.random() + Math.random() + Math.random()) / 3;
  return centerWeighted * windowSeconds;
}

export function pickProfile(config, vu) {
  const bucket = deterministicUnit(vu);
  if (bucket < config.passivePct) return "passive";
  if (bucket < config.passivePct + config.lightPct) return "light";
  if (bucket < config.passivePct + config.lightPct + config.activePct) return "active";
  return "peak";
}

function deterministicUnit(seed) {
  const x = Math.sin(seed * 99991) * 10000;
  return x - Math.floor(x);
}

export function shouldSubmitForProfile(profile, iteration, elapsedSeconds) {
  if (profile === "passive") return false;
  if (profile === "light") return iteration > 0 && iteration % Math.round(jitter(100, 200)) === 0;
  if (profile === "active") return iteration > 0 && iteration % Math.round(jitter(40, 100)) === 0;
  if (profile === "peak") return iteration > 0 && iteration % Math.round(jitter(30, 80)) === 0;
  return false;
}

export function messageBody(runId, vu, iteration, label = "love this song") {
  const fanBits = ["love this song", "lets gooooooo", "this chorus is huge", "energy is wild", "that drop was insane"];
  const base = fanBits[(vu + iteration) % fanBits.length] || label;
  return `${base} ${runId} vu${vu} i${iteration} ${uuidv4().slice(0, 8)}`;
}
