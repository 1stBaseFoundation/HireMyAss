#!/usr/bin/env node
/**
 * Phase 0 smoke test: proves both model endpoints answer, and that the vision
 * model can actually read text out of a raster image.
 *
 *   node scripts/smoke.mjs [path/to/image.png]
 */
import { readFileSync, existsSync } from "node:fs";

const COORD = process.env.COORDINATOR_URL || "http://127.0.0.1:8081";
const VLM = process.env.VISION_URL || "http://127.0.0.1:8082";
const imagePath = process.argv[2];

async function chat(url, model, messages, extra = {}) {
  const started = Date.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 512, ...extra }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content ?? "";
  return { text: String(text).trim(), ms: Date.now() - started };
}

const results = [];
async function step(name, fn) {
  process.stdout.write(`  ... ${name}\r`);
  try {
    const out = await fn();
    results.push({ name, ok: true, out });
  } catch (error) {
    results.push({ name, ok: false, out: error.message });
  }
}

await step("coordinator text", async () => {
  const { text, ms } = await chat(COORD, "coordinator", [
    { role: "user", content: "Reply with exactly the word: OK" },
  ]);
  if (!/ok/i.test(text)) throw new Error(`unexpected reply: ${text.slice(0, 120)}`);
  return `${ms} ms -> ${text.slice(0, 40)}`;
});

if (imagePath) {
  if (!existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
  const b64 = readFileSync(imagePath).toString("base64");
  await step("vision OCR", async () => {
    const { text, ms } = await chat(VLM, "vlm", [
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe every word in this image exactly. No commentary." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ]);
    if (text.length < 5) throw new Error(`empty transcription: ${JSON.stringify(text)}`);
    return `${ms} ms -> ${text.replace(/\s+/g, " ").slice(0, 160)}`;
  });
}

console.log("\n  smoke test\n");
for (const r of results) {
  console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name.padEnd(20)} ${r.out}`);
}
console.log("");
process.exit(results.every((r) => r.ok) ? 0 : 1);
