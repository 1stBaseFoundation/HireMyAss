#!/usr/bin/env node
/**
 * Preflight: verifies the toolchain, model files, llama-server binary, and
 * (optionally) that each model actually loads on this build of llama.cpp.
 *
 *   node scripts/preflight.mjs             # static checks + live /health probes
 *   node scripts/preflight.mjs --load-test # also boots each model on a scratch
 *                                          # port and confirms the arch loads
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
try {
  process.loadEnvFile(path.join(ROOT, ".env.local"));
} catch {
  /* no .env.local yet — defaults below still work */
}

const LOAD_TEST = process.argv.includes("--load-test");

const cfg = {
  modelsDir: process.env.MODELS_DIR || path.join(ROOT, "Models"),
  llamaDir: process.env.LLAMA_DIR || path.join(ROOT, "llama"),
  coordinator: {
    url: process.env.COORDINATOR_URL || "http://127.0.0.1:8081",
    model: process.env.COORDINATOR_MODEL || "Qwen3.5-4B-IQ4_XS.gguf",
    mmproj: "",
  },
  vision: {
    url: process.env.VISION_URL || "http://127.0.0.1:8082",
    model: process.env.VISION_MODEL || "Qwen2.5-Omni-7B-Q4_K_M.gguf",
    mmproj: process.env.VISION_MMPROJ || "Qwen2.5-Omni-7B-mmproj-Q8_0.gguf",
  },
};

const results = [];
const add = (ok, label, detail = "") => results.push({ ok, label, detail });
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roles = () => Object.entries(cfg).filter(([k]) => k === "coordinator" || k === "vision");

// ---------------------------------------------------------------- node
const [major] = process.versions.node.split(".").map(Number);
add(major >= 22, `Node ${process.versions.node}`, major >= 22 ? "node:sqlite available" : "need >= 22");

// ---------------------------------------------------------------- files
let models = [];
if (existsSync(cfg.modelsDir)) {
  models = readdirSync(cfg.modelsDir)
    .filter((f) => /\.gguf$/i.test(f))
    .map((f) => ({ name: f, size: statSync(path.join(cfg.modelsDir, f)).size }));
  add(true, "Models dir", cfg.modelsDir);
} else {
  add(false, "Models dir", `missing: ${cfg.modelsDir}`);
}

const findModel = (name) => models.find((m) => m.name.toLowerCase() === name.toLowerCase());
for (const [role, c] of roles()) {
  const m = findModel(c.model);
  add(!!m, `${role} model`, m ? `${c.model} · ${gb(m.size)}` : `MISSING ${c.model}`);
  if (c.mmproj) {
    const p = findModel(c.mmproj);
    add(!!p, `${role} mmproj`, p ? `${c.mmproj} · ${gb(p.size)}` : `MISSING ${c.mmproj}`);
  }
}

const serverExe = path.join(cfg.llamaDir, "llama-server.exe");
add(existsSync(serverExe), "llama-server.exe", existsSync(serverExe) ? cfg.llamaDir : `missing in ${cfg.llamaDir}`);

// ---------------------------------------------------------------- health
async function health(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => ({}));
    return { reachable: true, ok: res.ok, status: body?.status ?? String(res.status) };
  } catch {
    return { reachable: false, ok: false, status: "unreachable" };
  }
}

for (const [role, c] of roles()) {
  const h = await health(c.url);
  add(
    h.ok,
    `${role} @ ${c.url}`,
    h.reachable ? `status=${h.status}` : "not running (use `npm run servers`)",
  );
}


// ---------------------------------------------------------------- load test
async function loadTest(args, port, timeoutMs = 180_000) {
  const child = spawn(serverExe, args, { cwd: cfg.llamaDir, windowsHide: true });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const deadline = Date.now() + timeoutMs;
  let loaded = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        loaded = true;
        break;
      }
    } catch {
      /* still starting */
    }
    await sleep(750);
  }
  child.kill("SIGKILL");
  await sleep(300);

  const failMatch = log.match(
    /(unknown model architecture|error loading model|failed to load model|unsupported model|not supported)[^\r\n]*/i,
  );
  return {
    loaded,
    detail: loaded ? "loaded OK" : (failMatch?.[0] ?? "did not become healthy").slice(0, 120),
  };
}

if (LOAD_TEST && existsSync(serverExe)) {
  const tests = [
    ["coordinator", path.join(cfg.modelsDir, cfg.coordinator.model), "", "8181"],
    [
      "vision",
      path.join(cfg.modelsDir, cfg.vision.model),
      path.join(cfg.modelsDir, cfg.vision.mmproj),
      "8182",
    ],
  ];
  for (const [label, model, mmproj, port] of tests) {
    if (!existsSync(model) || (mmproj && !existsSync(mmproj))) {
      add(false, `load-test ${label}`, "model file missing");
      continue;
    }
    const args = ["-m", model, "-c", "256", "-ngl", "0", "-t", "4", "--port", port, "--alias", label];
    if (mmproj) args.push("--mmproj", mmproj);
    process.stdout.write(`  ... loading ${label}\r`);
    const { loaded, detail } = await loadTest(args, Number(port));
    add(loaded, `load-test ${label}`, detail);
  }
}

// ---------------------------------------------------------------- report
console.log("\n  HireMyAss · preflight\n");
for (const r of results) {
  const mark = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${r.label.padEnd(26)} ${r.detail}`);
}
console.log("");

const blocking = results.filter((r) => !r.ok && !/not running/.test(r.detail));
if (blocking.length > 0) {
  console.log(`  ${blocking.length} blocking issue(s). See TODO.md → Phase 0.\n`);
  process.exit(1);
}
console.log("  no blocking issues\n");
process.exit(0);
