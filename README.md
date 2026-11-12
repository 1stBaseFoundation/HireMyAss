# HireMyAss

A job aggregator that runs entirely on your own machine. Drop in a résumé, get
one ranked list of openings pooled from eight public job APIs — deduplicated
across boards, scored against the terms you actually confirmed, and with every
number explainable.

No accounts, no cloud, no per-query cost. The résumé text never leaves the
machine: parsing, ranking and storage are all local. Two small models do the
fuzzy parts (gap-filling and OCR); everything else is deterministic code.

```
résumé ──▶ parse ──▶ review & confirm ──▶ fetch 8 sources ──▶ dedupe ──▶ rank ──▶ list
                              │
                              └── searching is blocked until you press Confirm
```

## Where it is

| Phase | Scope | State |
|---|---|---|
| 0–2 | Scaffold, SQLite data layer, résumé ingest (deterministic + LLM gap-fill + VLM OCR) | ✅ |
| 3 | Eight job-source adapters, TTL cache, per-source health | ✅ |
| 4 | Ranking, cross-source dedupe, filters, **confirmation gate** | ✅ |
| 3.5 | `/profile` review UI, per-field confidence, keyword priority | ⏳ next |
| 5–8 | Results/applications/settings UI, applied-seen state machine, chat→filters, hardening | ⏳ |

**74 tests green**, 9 more gated behind env flags because they need a GPU or the
network. Phase 4 was validated against 2,547 live postings.

## Principles

**Deterministic first, model second.** A 172-skill lexicon spread over 13
categories with 492 aliases extracts what the résumé literally says. The LLM is
only asked to fill fields the parser could not establish, and it is never allowed
to overwrite evidence found in the text. If both models are down, you still get a
usable profile.

**Claims, not facts.** Résumé parsing is guesswork, so every extracted value
carries provenance and confidence, and the review screen shows it *before* any
search runs. A model guess starts excluded; a field that was never found is
reported as missing rather than invented.

**Explainable numbers.** `score` and `reasons` are produced by the same loop, so
they cannot disagree. Ranking is arithmetic over SQLite, not a model call.

**Degrade, never fail.** A downed model, a 500 from a board, a scanned PDF with
no text layer — each produces a warning and a worse-but-working result.

## Requirements

| | |
|---|---|
| Node | **≥ 22.5** (uses the built-in `node:sqlite`; developed on v26.13.0) |
| OS | Windows (the launcher scripts are PowerShell); the app itself is portable |
| GPU | Optional. ~3.2 GB VRAM runs both models; without them parsing is deterministic-only |
| Disk | ~7 GB if you host the models locally (they are gitignored) |

## Quick start

```powershell
git clone https://github.com/1stBaseFoundation/HireMyAss.git
cd HireMyAss
npm install

Copy-Item .env.example .env.local   # then edit DATA_DIR / ports if needed
npm run preflight                   # checks node, sqlite, models, llama-server
npm run dev                         # http://localhost:3000
```

The app boots with **no models and no network** — it just parses more crudely and
finds nothing to rank. Every default in `lib/env.ts` is usable as-is.

### Models (optional)

`scripts/preflight.mjs` and `scripts/servers.ps1` own the `.gguf` paths. The app
only ever speaks HTTP, so it does not care where the files live:

```powershell
$env:MODELS_DIR = 'E:\Models'       # default: .\Models  (gitignored)
$env:LLAMA_DIR  = 'K:\HireMyAss\llama'

npm run servers                     # start both llama-server instances
node scripts/preflight.mjs --load-test   # also confirm each arch loads here
```

| Role | Port | Model | Job |
|---|---|---|---|
| coordinator | 8081 | `Qwen3.5-4B-IQ4_XS.gguf` | chat → filters, résumé gap-fill |
| vision | 8082 | `Qwen2.5-Omni-7B-Q4_K_M.gguf` + mmproj | OCR fallback for scanned PDFs |

## Architecture

```
app/
  api/resume/route.ts          POST a résumé, GET the parsed profile
  api/profile/confirm/route.ts the gate: confirm the reviewed snapshot
  api/jobs/search/route.ts     428 until confirmed, then ranked results
lib/
  env.ts                       server config — never builds model paths
  db/                          node:sqlite schema, jobs, profile, source runs
  extract/                     text → deterministic → LLM gap-fill → OCR
    text.ts                    PDF / DOCX / plain, with mojibake repair
    lexicon.ts + skills.json   172 skills, boundary-aware matching
    deterministic.ts           the accuracy baseline
    llm-extract.ts             fills gaps, never overwrites evidence
    raster.ts + ocr.ts         scanned PDFs via the vision model
    pipeline.ts                orchestration and degradation
  sources/                     eight adapters behind one interface
    types.ts                   JobSource, capabilities, TTL, SourceError
    boards.ts                  arbeitnow, remotive, jobicy, remoteok, himalayas
    ats.ts                     greenhouse, lever, ashby (per-company tokens)
    normalize.ts               salary, location, remote mode, employment type
    collect.ts                 TTL cache, concurrency, per-source health
  match/
    fingerprint.ts             strict (storage) + loose (cross-board) keys
    score.ts                   IDF overlap, recency, location, reasons
    dedupe.ts                  one row per real opening
    filters.ts                 type / region / mode / recency + visibility
    search.ts                  pure ranking over SQLite
scripts/                       preflight, servers, smoke, fixture fetch
tests/                         74 unit tests + 9 gated live tests
```

### Data flow

1. **Ingest** — bytes → text layer → deterministic extraction → LLM gap-fill →
   OCR only when there was no text layer. The uploaded file is not kept.
2. **Review** — provenance and confidence per field; search stays locked.
3. **Fetch** — eight adapters, TTL-cached per source (Remotive allows ~4
   requests/day), each failure recorded instead of thrown.
4. **Normalize** — one `NormalizedJob` shape; the strict fingerprint is the
   storage key, so re-ingesting is idempotent.
5. **Dedupe** — the loose fingerprint (company + title) collapses the same
   opening listed by several boards and unions every source reference.
6. **Rank** — keyword overlap weighted by IDF, title hits ×5, recency decay,
   location and seniority fit.

## Job sources

Five aggregators are always on. The three ATS adapters take a list of company
tokens, because *which companies you care about* is your decision, not a default.

| Source | Kind | Rows on a live run | Notes |
|---|---|---|---|
| `greenhouse` | ATS | 1,127 | per-company token, full descriptions |
| `ashby` | ATS | 943 | per-company token |
| `arbeitnow` | board | 287 | EU-heavy, reports employment type |
| `remoteok` | board | 98 | attribution required by their terms |
| `jobicy` | board | 48 | remote, region metadata |
| `himalayas` | board | 20 | paginated, low volume |
| `remotive` | board | 14 | **~4 requests/day** — hence the TTL cache |
| `lever` | ATS | 10 | per-company token |

**2,547 postings stored from 2,678 raw** — the gap is normalization and
in-batch duplicates. Every adapter records its outcome in `source_runs`, so a
silently broken board is visible on the settings screen rather than looking like
"there are no jobs today".

## How ranking works

```
keyword  = 1 − e^(−points / 8)          points = Σ idf(term) × (5 if in title else 1)
recency  = 0.5^(days / 7)               null date ⇒ 0.5
location = 1.0 city/country hit, 0.6 remote, 0.3 otherwise
seniority= 1.0 if the profile's level appears in the posting

score = 100 × (0.62·keyword + 0.14·recency + 0.14·location + 0.10·seniority)
```

- **IDF** over the candidate set, so `React` (in hundreds of postings) is worth
  less than `Solidity` (in three). Without it, whichever term is most common on
  the boards dominates every score.
- **The saturating curve** matters: dividing by the theoretical maximum (every
  keyword in every title) leaves realistic jobs near 8%, which reads as broken
  rather than strict. 8 points ≈ 63%, 16 ≈ 86%.
- **`reasons` are generated by the same loop as `score`**, so they cannot
  disagree. A result reads `React in title | Blockchain, JavaScript, Node.js |
  posted 2d ago | remote`.

### Known limitation

Keyword weighting is uniform, ordered only by how often a term appears in the
résumé. Soft skills like *Communication* therefore act as noise and match every
posting, which is why a QA role can outrank an exact React match. The fix is
**user-defined keyword priority in the review screen** — not more constants in
the scorer. It is scheduled as part of phase 3.5, deliberately.

## API

All routes are `nodejs` runtime and `force-dynamic`.

```powershell
# 1. ingest a résumé
curl.exe -s -X POST -F "file=@cv.pdf" http://localhost:3000/api/resume

# 2. search BEFORE confirming — this is the gate, and it is a 428
Invoke-WebRequest http://localhost:3000/api/jobs/search -Method POST `
  -ContentType 'application/json' -Body '{}' -SkipHttpErrorCheck
#   → 428 { "code": "PROFILE_NOT_CONFIRMED" }

# 3. confirm (optionally editing fields the review screen showed you)
Invoke-RestMethod http://localhost:3000/api/profile/confirm -Method POST `
  -ContentType 'application/json' -Body '{"keywords":["React","TypeScript","Node.js"]}'

# 4. search
Invoke-RestMethod http://localhost:3000/api/jobs/search -Method POST `
  -ContentType 'application/json' `
  -Body '{"filters":{"remoteModes":["remote"],"postedWithinDays":3},"limit":10}'
```

| Route | Method | Purpose |
|---|---|---|
| `/api/resume` | `GET` | current parsed profile (`null` if none) |
| `/api/resume` | `POST` | multipart `file`; pdf/docx/txt/md, ≤25 MB |
| `/api/profile/confirm` | `POST` | apply edits **and** confirm the snapshot |
| `/api/profile/confirm` | `DELETE` | withdraw confirmation |
| `/api/jobs/search` | `POST` | ranked jobs: `filters`, `strictMode`, `limit`, `minScore`, `refresh`, `sources` |
| `/api/jobs/search` | `GET` | per-source health from `source_runs` |

Search accepts `employmentTypes` (`full_time` / `part_time` / `contract`),
`remoteModes` (`remote` / `hybrid` / `onsite`), `location` (free text, matched
against location, remote mode and title), and `postedWithinDays` (`1` / `3` / `7`).

**Visibility rules.** `applied` and `dismissed` never appear again. `seen` stays
but sinks, because rendering a job once is not a decision — `strictMode: true`
collapses that to `new` only. Filters keep postings whose type or mode is
`unknown`, so a board that does not report a field does not silently lose its
entire catalogue.

## Data and privacy

- Everything lives in one SQLite file, `DATA_DIR/app.db` (default `./data`).
  Delete it and you have a clean install.
- **Uploaded files are not persisted.** Only extracted text and structured
  fields are stored.
- Outbound traffic is limited to the eight job APIs. The résumé is never sent to
  them: ranking is local, and keyword queries are only used where a board
  supports server-side search.
- The only non-local calls are to `127.0.0.1:8081` / `:8082`.

## Scripts

```powershell
npm run dev            # next dev on :3000
npm run build          # next build
npm start              # serve the build
npm test               # vitest run
npm run test:watch     # vitest
npm run preflight      # static checks + live /health probes
npm run servers        # launch both llama-server instances
```

Fixture and smoke helpers:

```powershell
node scripts/fetch-fixtures.mjs   # refresh tests/fixtures/sources/*.json
node scripts/smoke.mjs            # end-to-end poke at a running server
```

## Testing

**74 tests green across 10 files, ~1.8s.** No GPU and no network needed — the
source adapters are exercised against recorded fixtures.

```powershell
npm test

# gated: these hit the real boards / the real GPU
$env:LIVE_SOURCES = '1'; npm test     # 8 live adapter tests
$env:LIVE_VISION  = '1'; npm test     # vision model on a scanned page
```

Tests worth knowing about:

| File | Covers |
|---|---|
| `db.test.ts` | schema, idempotent upserts, status joins |
| `text.test.ts` | PDF/DOCX text, CP1252 mojibake repair, letter-spaced dates |
| `resume.test.ts` | lexicon matching, single-letter rejection, field extraction |
| `pipeline.test.ts` | the real CV end-to-end, fully offline |
| `llm-fallback.test.ts` | model down ⇒ deterministic-only profile, no crash |
| `sources.test.ts` | each adapter against its fixture |
| `collect.test.ts` | TTL cache, partial failure, per-source health |
| `match.test.ts` | scoring, dedupe, filters, visibility, the confirmation gate |

## Gotchas

Written down because each one cost real time:

- **Never build model paths in `lib/env.ts`.** Turbopack constant-folds
  `path.join()` of string literals, registers the result as a traced asset, and
  tries to hash a 2.3 GB `.gguf` during `next build` (`os error 1450`). The app
  talks HTTP; the scripts own the paths.
- **`node:sqlite` rejects JS booleans** as bound values. Use `0` / `1`.
- **Single-character skills are toxic.** `C` and `R` matched every stray letter
  until matching required ≥2 characters. `c language` still resolves.
- **Qwen3.5-4B is a reasoning model** — it returns empty `content` unless you
  send `chat_template_kwargs: { enable_thinking: false }`. `reasoning_budget` is
  ignored by llama.cpp b11982.
- **`--device CUDA1` filters the device list**, so `--main-gpu` must be `0` for
  both instances, with `--split-mode none`.
- **Résumés lie about their own encoding.** Canva exports letter-space dates
  (`D E C 2 0 2 2`) and PDFs emit CP1252 mojibake; both are normalised before
  extraction.
- **Boards disagree about locations.** Dedupe must key on company + title; the
  strict fingerprint is only for storage uniqueness.

## Roadmap

- **3.5** — `/profile` review UI: editable fields, confidence styling, gaps for
  missing values, keyword priority, chat refinement. Unblocks trustworthy search.
- **5** — UI: `/`, `/profile`, `/applications`, `/settings`.
- **6** — applied/seen state machine, strict-mode toggle.
- **7** — chat → filters tool calling, vision sidecar.
- **8** — hardening, attribution surfacing, docs.

`TODO.md` carries the full plan, including the review-stage contract and the
per-field confidence table.

## License

Private. Job data belongs to the boards that serve it — see each source's
`attribution` field and follow it if you redistribute results.

