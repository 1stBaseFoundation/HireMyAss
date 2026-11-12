# HireMyAss — Job Prospect Pooler

Local-first, private job-board aggregator for Windows. Next.js 16 + built-in `node:sqlite`
+ two `llama-server` instances on CUDA. Nothing leaves the machine except job-board reads.

Status: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Environment (verified, not assumed)

| Item | Value |
|---|---|
| Node | 26.13.0 — `node:sqlite` 3.54.0 built in, **no native compile needed** |
| npm | 11.20.0 (no pnpm/yarn) |
| GPU | 2× RTX 3060 12 GB, compute 8.6 |
| Driver | 621.14 / CUDA UMD 13.5 |
| Runtime | `K:\HireMyAss\llama\llama-server.exe` (build b11982, CUDA 13.4) |
| Models | `K:\HireMyAss\Models\` |
| Workspace | `K:\HireMyAss` (48 GB free) |

## Model roster

| Port | Card | Role | Files | Key flags |
|---|---|---|---|---|
| 8081 | CUDA0 | Coordinator — chat→filters, résumé→JSON, `refine_profile` | `Qwen3.5-4B-IQ4_XS.gguf` (2.31 GB) | `--jinja`, ctx 16384 |
| 8082 | CUDA1 | Vision / OCR — scanned PDFs, images | `Qwen2.5-Omni-7B-Q4_K_M.gguf` (4.36 GB) + `Qwen2.5-Omni-7B-mmproj-Q8_0.gguf` (1.44 GB) | `--mmproj`, `--image-min-tokens 1024`, ctx 12288 |
| — | — | Deterministic extractor (0 GPU, always on) | skills lexicon + heuristics | n/a |

Retired: `qwen3-vl-4b-heretic.safetensors` — wrong container (llama.cpp loads GGUF only) and
Qwen3-VL is absent from llama.cpp's documented mtmd support list. Not used.

## Data sources (response shapes captured live during planning)

Arbeitnow · Remotive · Jobicy · RemoteOK · Himalayas · Greenhouse (+ Lever/Ashby/Workable/SmartRecruiters shape).
Deliberately excluded: LinkedIn, Indeed, Glassdoor, Monster — ToS-prohibited and actively defended.

---

## Phase 0 — Scaffold & runtime validation  ✅ COMPLETE
- [x] `git init`, `.gitignore` (`Models/`, `llama/`, `data/`, `node_modules/`, `.env*`)
- [x] `package.json`, `tsconfig.json` (strict), `next.config.ts`, `postcss.config.mjs` (Tailwind v4)
- [x] `app/layout.tsx`, `app/globals.css`, placeholder `app/page.tsx`
- [x] `lib/env.ts` — typed env (ports, model paths, data dir) with sane defaults
- [x] `scripts/preflight.mjs` — Node version, GGUF discovery + sizes, llama-server presence, `/health` of 8081 & 8082
- [x] `scripts/servers.ps1` — launches both instances in the house style (`--load-mode none`, q8_0 KV cache, `--jinja`, `--flash-attn on`) with `--split-mode none` pinned to one card each
- [x] **GATE 0** — `npm run build` clean · preflight finds both models · **`qwen3.5` arch loads on b11982** (tiny-ctx load test) · both `/health` → 200 · one image OCR round-trip returns text

### Phase 0 findings (things that were not true until tested)
- `qwen3.5-4B` **does** load on b11982 — no llama.cpp upgrade needed. Vision + mmproj load too.
- **Turbopack bug avoided:** `next build` panicked (`os error 1450`) because it constant-folded
  `path.join(modelsDir, "...gguf")` into a real path and tried to hash a 2.3 GB model. Fix: `lib/env.ts`
  holds no model paths at all — the app only speaks HTTP. Confirmed by rebuild.
- `--device CUDA1` filters the device list to one entry, so `--main-gpu` must be **0** for both
  instances. Passing `1` fails with `invalid value for main_gpu: 1 (available devices: 1)`.
- PowerShell 5.1 mis-decodes UTF-8 non-ASCII in `.ps1` (broke the script on an em dash). Scripts are
  now ASCII-only and the npm script uses `pwsh`.
- Measured VRAM: GPU0 **3.2 GB**, GPU1 **7.9 GB**.
- OCR smoke test transcribed a generated image verbatim in 4.7 s.

## Phase 1 — Data layer  ✅ COMPLETE
- [x] `lib/db/schema.sql` → **`lib/db/schema.ts`** (embedded SQL so it never depends on fs/bundler asset tracing)
- [x] `lib/db/index.ts` — `node:sqlite` `DatabaseSync` singleton, WAL, idempotent migrations, `transaction()`, `parseJson()`
- [x] Repos: `lib/db/jobs.ts`, `lib/db/profile.ts`, `lib/db/sources.ts`
- [x] **GATE 1** — schema applies twice idempotently · job upsert · fingerprint uniqueness enforced → **14/14 vitest green**

### Phase 1 findings
- `node:sqlite` refuses JS booleans as bound values (throws). All 0/1 crosses through `bool.to/from`.
- Cross-source identity needed **two** keys: strict `fingerprintJob` (company+title+location, the UNIQUE
  constraint) and `looseFingerprint` (company+title) for spotting the same posting on several boards —
  boards disagree wildly on the location string ("Remote", "Remote, US", "", "Anywhere").
- Upserts must never let an `unknown` value overwrite a known one, or the 3rd source to report a job
  silently erases the fields the 1st source got right.

## Phase 2 — Résumé ingest  ✅ COMPLETE
- [x] `lib/extract/text.ts` — `.docx` via mammoth, `.pdf` via unpdf, **magic-byte sniffing** (a `.pdf` that is really a `.docx` happens)
- [x] `lib/extract/raster.ts` — pdfjs-dist + `@napi-rs/canvas` → PNG pages, 2200 px edge cap, `maxPages` guard
- [x] `lib/extract/skills.json` + `lib/extract/lexicon.ts` — **157 skills / 383 aliases** across 13 categories
- [x] `lib/extract/deterministic.ts` — sectioning, titles, years, seniority, locations, weighted keywords
- [x] `lib/llm/client.ts` — OpenAI-compatible wrapper: JSON-schema constrained, health probe, timeouts, `extractJson`
- [x] `lib/extract/ocr.ts` — VLM OCR against :8082
- [x] `lib/extract/llm-extract.ts` — gap-fill only, zod-validated, never overwrites evidence
- [x] `lib/extract/pipeline.ts` — orchestration with `allowLlm` / `allowOcr` switches for hermetic tests
- [x] `app/api/resume/route.ts` — GET / POST / DELETE, 25 MB cap, extension + magic validation
- [x] **GATE 2** — parses the real PDF · 24 keywords extracted · scanned path exercised live on GPU (10.7 s) · **identical result with the model stopped** → **39 tests green + 1 live GPU test**

### Phase 2 findings (bugs that only showed up against a real CV)
- **Qwen3.5-4B is a reasoning model.** First production run returned `content: ""` with
  `finish_reason: "length"` — it had spent the whole budget inside `reasoning_content`. Fix:
  `chat_template_kwargs: { enable_thinking: false }` (verified: `finish=stop`, clean JSON).
  `reasoning_budget: 0` is **not** supported by b11982 — silently ignored.
- **Naive year math invents experience.** "Microsoft Office 2010, 2013, 2016, 2019" and
  "Windows 7/8/10" produced a bogus 10-year span. Now only `Month YYYY` / `YYYY–YYYY` ranges count,
  and "present" resolves to the current year. Real answer: **9 years**.
- **Title extraction needs shape filters**, not just keywords: "with tasks assigned by manager using a
  ticketing system" matched because it contained "manager". Now requires a capitalised start, ≤5 words,
  no `&`.
- pdf.js v6 teardown lives on the **loading task** (`loadingTask.destroy()`), not the document proxy.
- Uploaded bytes are **not persisted** — only extracted text + structured facts land in SQLite.

## Phase 3 — Source adapters
- [ ] `lib/sources/types.ts` — `JobSource` interface, `NormalizedJob`, capability flags
- [ ] `lib/sources/normalize.ts` — remote_mode / employment_type / region / posted_at coercion
- [ ] Adapters: `arbeitnow`, `remotive`, `jobicy`, `remoteok`, `himalayas`, `greenhouse`, `lever`, `ashby`
- [ ] `lib/sources/registry.ts` + TTL cache backed by `source_runs` (Remotive ≥ 6 h — 4 req/day cap)
- [ ] **GATE 3** — per-adapter fixture tests (the live JSON saved during planning) → normalized shape; zero network in tests

## Phase 4 — Search, rank, dedupe
- [ ] `lib/match/fingerprint.ts` — `sha256(company|title|location)`, cross-source dedupe
- [ ] `lib/match/score.ts` — IDF keyword overlap (title ×3) + recency decay + location/type fit, emits reasons
- [ ] `app/api/jobs/search/route.ts` — filters: type / region / remote-mode / posted-within
- [ ] **GATE 4** — same job from 3 sources = 1 row · 24h/3d/7d windows correct · reasons reconcile with score

## Phase 5 — UI
- [ ] `/` filter chip bar + job cards (score ring, reason chips, source credit link, checkbox, Apply →)
- [ ] `/profile` — uploaded file, editable keyword chips, chat review panel
- [ ] `/applications` — applied log + CSV export
- [ ] `/settings` — sources on/off, model endpoints, strict-mode toggle
- [ ] **GATE 5** — `npm run build` clean, manual click-through of every route

## Phase 6 — Applied / seen state machine
- [ ] `app/api/jobs/[id]/status/route.ts` — `new|seen|applied|dismissed|rejected`
- [ ] `applied`/`dismissed` hidden permanently · `seen` badged + sunk · strict mode hides `seen` too
- [ ] **GATE 6** — unit tests over full transition matrix; an applied job never resurfaces

## Phase 7 — LLM coordination
- [ ] `lib/llm/tools.ts` — `search_jobs`, `refine_profile`, `explain_match`, `mark_applied`, `ocr_resume`
- [ ] `app/api/chat/route.ts` — tool loop, zod validation, one retry, deterministic NL→filter fallback
- [ ] `lib/llm/sidecar.ts` — lazy spawn / idle-kill of the 8082 vision server
- [ ] **GATE 7** — "contract React in Berlin this week, not ones I applied to" → correct filter object · chat still functional with 8081 down

## Phase 8 — Hardening
- [ ] Per-source failure isolation, timeouts, retries, graceful empty-cache UX
- [ ] `README.md` — run instructions, model setup, source attribution
- [ ] **GATE 8** — full `npm test` + `npm run build` green from a clean install

---

## Open risks
1. **`qwen3.5` architecture support in b11982 is unverified.** First action inside Gate 0. If it fails, pin `Agents-A1-4B` (known-good Qwen2 lineage) as coordinator rather than updating llama.cpp — per instruction, no runtime updates.
2. 4B tool-calling accuracy — mitigated by constrained decoding, zod validation, and a deterministic NL→filter parser.
3. Remotive caps at ~4 requests/day and delays data 24 h — TTL cache, never fetched on page load.
4. `D:\` has 6.9 GB free. Nothing new gets written there.
5. `Models/` lives inside the repo (6.7 GB) — gitignored; the app only ever reads paths from env.
