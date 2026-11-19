"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  ConfidenceField,
  ConfidenceLevel,
  ProfileConfidence,
} from "@/lib/extract/confidence";
import type { KeywordPriority } from "@/lib/match/priority";

type EditableField = ConfidenceField;

const FIELD_LABELS: Array<{ key: EditableField; label: string; placeholder: string }> = [
  { key: "fullName", label: "Name", placeholder: "not stated" },
  { key: "headline", label: "Headline", placeholder: "not stated" },
  { key: "email", label: "Email", placeholder: "not in the résumé — add it if you want it used" },
  { key: "phone", label: "Phone", placeholder: "not in the résumé — add it if you want it used" },
  { key: "location", label: "Location", placeholder: "not stated" },
  { key: "yearsExperience", label: "Years of experience", placeholder: "gap — fill it in" },
  { key: "seniority", label: "Seniority", placeholder: "gap — fill it in" },
];

const LEVEL_TONE: Record<ConfidenceLevel, string> = {
  high: "border-lime-400/40 bg-lime-400/10 text-lime-400",
  medium: "border-amber-400/40 bg-amber-400/10 text-amber-400",
  low: "border-rose-400/40 bg-rose-400/10 text-rose-400",
};

const PROVENANCE_LABEL: Record<string, string> = {
  "skills-section": "listed under Skills",
  prose: "mentioned in the text",
  explicit: "stated in the résumé",
  derived: "derived from date ranges",
  gazetteer: "place name in the résumé",
  "title-cue": "inferred from a role line",
  regex: "pattern match",
  model: "model suggestion",
  confirmed: "kept from your confirmed profile",
  missing: "not stated",
};

interface ProfilePayload {
  fullName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  yearsExperience: number | null;
  seniority: string | null;
  keywords: string[];
  titles: string[];
  locations: string[];
  sourceFile: string | null;
  parseMethod: string | null;
  confirmedAt: number | null;
  keywordPriority: Record<string, KeywordPriority>;
}

interface IngestNotes {
  notes?: string[];
  warnings?: string[];
}

function emptyDraft(profile: ProfilePayload): Record<EditableField, string> {
  return {
    fullName: profile.fullName ?? "",
    headline: profile.headline ?? "",
    email: profile.email ?? "",
    phone: profile.phone ?? "",
    location: profile.location ?? "",
    yearsExperience: profile.yearsExperience === null ? "" : String(profile.yearsExperience),
    seniority: profile.seniority ?? "",
  };
}

export default function ProfileReviewPage() {
  const [profile, setProfile] = useState<ProfilePayload | null>(null);
  const [confidence, setConfidence] = useState<ProfileConfidence | null>(null);
  const [draft, setDraft] = useState<Record<EditableField, string> | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<Record<string, KeywordPriority>>({});
  const [newKeyword, setNewKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [ingestNotes, setIngestNotes] = useState<string[]>([]);

  function adopt(payload: ProfilePayload, grade: ProfileConfidence | null) {
    setProfile(payload);
    setConfidence(grade);
    setDraft(emptyDraft(payload));
    setKeywords(payload.keywords);
    setPriorities(payload.keywordPriority ?? {});
    const lowConfidence = new Set(
      (grade?.keywords ?? []).filter((item) => !item.included).map((item) => item.keyword.toLowerCase()),
    );
    setExcluded(payload.keywords.filter((keyword) => lowConfidence.has(keyword.toLowerCase())));
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/profile", { cache: "no-store" });
      const body = (await response.json()) as {
        profile: ProfilePayload | null;
        confidence: ProfileConfidence | null;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "could not load the profile");
      if (body.profile) adopt(body.profile, body.confidence);
      else {
        setProfile(null);
        setConfidence(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const byKeyword = useMemo(() => {
    const map = new Map<string, ProfileConfidence["keywords"][number]>();
    for (const item of confidence?.keywords ?? []) map.set(item.keyword.toLowerCase(), item);
    return map;
  }, [confidence]);

  const includedKeywords = keywords.filter(
    (keyword) => !excluded.some((item) => item.toLowerCase() === keyword.toLowerCase()),
  );

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/resume", { method: "POST", body: form });
      const body = (await response.json()) as IngestNotes & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "upload failed");
      setIngestNotes([...(body.notes ?? []), ...(body.warnings ?? [])]);
      setMessage("Résumé parsed. Review the claims below before searching.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function toggleKeyword(keyword: string) {
    setExcluded((current) =>
      current.some((item) => item.toLowerCase() === keyword.toLowerCase())
        ? current.filter((item) => item.toLowerCase() !== keyword.toLowerCase())
        : [...current, keyword],
    );
  }

  function cyclePriority(keyword: string) {
    const order: KeywordPriority[] = ["normal", "pin", "soften"];
    const current = priorities[keyword] ?? "normal";
    const next = order[(order.indexOf(current) + 1) % order.length]!;
    setPriorities((map) => {
      const copy = { ...map };
      if (next === "normal") delete copy[keyword];
      else copy[keyword] = next;
      return copy;
    });
  }

  function addKeyword() {
    const clean = newKeyword.trim();
    if (!clean) return;
    if (!keywords.some((keyword) => keyword.toLowerCase() === clean.toLowerCase())) {
      setKeywords((current) => [...current, clean]);
    }
    setNewKeyword("");
  }

  async function confirm() {
    if (!draft || !profile) return;
    setBusy(true);
    setError(null);
    setMessage(null);

    const years = draft.yearsExperience.trim();
    const payload = {
      fullName: draft.fullName.trim() || null,
      headline: draft.headline.trim() || null,
      email: draft.email.trim() || null,
      phone: draft.phone.trim() || null,
      location: draft.location.trim() || null,
      yearsExperience: years === "" ? null : Number(years),
      seniority: draft.seniority.trim() || null,
      keywords: includedKeywords,
      titles: profile.titles,
      locations: profile.locations,
      keywordPriority: priorities,
    };

    try {
      const response = await fetch("/api/profile/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        profile?: ProfilePayload;
        error?: string;
        issues?: unknown;
      };
      if (!response.ok) throw new Error(body.error ?? "could not confirm the profile");
      if (body.profile) adopt(body.profile, confidence);
      setMessage("Profile confirmed. Search is unlocked.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/profile/confirm", { method: "DELETE" });
      if (!response.ok) throw new Error("could not withdraw confirmation");
      setMessage("Confirmation withdrawn — search is locked again.");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-6 py-16 text-sm text-ink-400">
        Loading profile…
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <Link href="/" className="font-mono text-xs uppercase tracking-[0.2em] text-ink-400 hover:text-ink-200">
          ← home
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Review your profile</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-200">
          Everything below is a <em>claim</em> read from your résumé, not a fact. Correct it,
          pin the terms that describe the job you actually want, then confirm. Nothing is
          searched until you do.
        </p>
      </header>

      {error && (
        <p className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-4 py-3 text-sm text-rose-400">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-lg border border-lime-400/40 bg-lime-400/10 px-4 py-3 text-sm text-lime-400">
          {message}
        </p>
      )}

      {!profile ? (
        <section className="rounded-xl border border-ink-700 bg-ink-900 p-6">
          <h2 className="text-sm font-medium uppercase tracking-wider text-ink-400">
            Upload a résumé
          </h2>
          <p className="mt-2 text-sm text-ink-200">
            PDF, DOCX or TXT. The file is parsed locally and never uploaded anywhere; only the
            extracted text and facts are stored.
          </p>
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
            className="mt-4 block w-full cursor-pointer rounded-lg border border-ink-700 bg-ink-850 p-3 text-sm file:mr-4 file:rounded-md file:border-0 file:bg-accent-600 file:px-3 file:py-1.5 file:text-sm file:text-ink-50"
          />
        </section>
      ) : (
        <>
          <section
            className={`rounded-xl border px-4 py-3 text-sm ${
              profile.confirmedAt
                ? "border-lime-400/40 bg-lime-400/10 text-lime-400"
                : "border-amber-400/40 bg-amber-400/10 text-amber-400"
            }`}
          >
            {profile.confirmedAt ? (
              <span>
                Confirmed {new Date(profile.confirmedAt).toLocaleString()}. Search runs against
                this snapshot.
              </span>
            ) : (
              <span>
                Draft: parsed from {profile.sourceFile ?? "your résumé"}
                {profile.parseMethod ? ` (${profile.parseMethod})` : ""}. Search stays locked
                until you confirm.
              </span>
            )}
          </section>

          {ingestNotes.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 font-mono text-xs text-ink-400">
              {ingestNotes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
          )}

          {draft && (
            <section className="rounded-xl border border-ink-700 bg-ink-900">
              <h2 className="border-b border-ink-700 px-4 py-3 text-sm font-medium uppercase tracking-wider text-ink-400">
                Facts
              </h2>
              <div className="divide-y divide-ink-800">
                {FIELD_LABELS.map(({ key, label, placeholder }) => {
                  const grade = confidence?.fields[key];
                  const missing = grade?.provenance === "missing";
                  return (
                    <div key={key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                      <label htmlFor={key} className="w-40 shrink-0 pt-1 text-xs font-medium uppercase tracking-wider text-ink-400">
                        {label}
                      </label>
                      <div className="flex flex-1 flex-col gap-1">
                        <input
                          id={key}
                          value={draft[key]}
                          placeholder={placeholder}
                          inputMode={key === "yearsExperience" ? "decimal" : undefined}
                          onChange={(event) =>
                            setDraft((current) =>
                              current ? { ...current, [key]: event.target.value } : current,
                            )
                          }
                          className={`w-full rounded-lg border bg-ink-850 px-3 py-2 text-sm text-ink-50 outline-none focus:border-accent-500 ${
                            missing ? "border-dashed border-ink-600" : "border-ink-700"
                          }`}
                        />
                        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-400">
                          {grade && (
                            <span className={`rounded-full border px-2 py-0.5 ${LEVEL_TONE[grade.confidence]}`}>
                              {grade.confidence} · {PROVENANCE_LABEL[grade.provenance] ?? grade.provenance}
                            </span>
                          )}
                          {grade?.note && <span>{grade.note}</span>}
                          {missing && <span>Shown as a gap, not an error — a CV may legitimately omit it.</span>}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="rounded-xl border border-ink-700 bg-ink-900">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700 px-4 py-3">
              <h2 className="text-sm font-medium uppercase tracking-wider text-ink-400">
                Keywords
              </h2>
              <p className="text-xs text-ink-400">
                Click a chip to include or exclude it · click the badge to pin or soften
              </p>
            </div>
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap gap-2">
                {keywords.map((keyword) => {
                  const grade = byKeyword.get(keyword.toLowerCase());
                  const isExcluded = excluded.some(
                    (item) => item.toLowerCase() === keyword.toLowerCase(),
                  );
                  const priority = priorities[keyword] ?? "normal";
                  return (
                    <span
                      key={keyword}
                      className={`flex items-center gap-1 rounded-full border text-sm ${
                        isExcluded
                          ? "border-dashed border-ink-600 bg-ink-850 text-ink-400"
                          : grade
                            ? LEVEL_TONE[grade.confidence]
                            : "border-ink-700 bg-ink-850 text-ink-50"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleKeyword(keyword)}
                        aria-pressed={!isExcluded}
                        title={
                          grade?.note ??
                          (isExcluded ? "Excluded from search — click to include" : "Click to exclude")
                        }
                        className={`rounded-l-full py-1 pl-3 pr-2 ${isExcluded ? "line-through" : ""}`}
                      >
                        {keyword}
                      </button>
                      <button
                        type="button"
                        onClick={() => cyclePriority(keyword)}
                        title="Cycle priority: normal → pin → soften"
                        className={`rounded-r-full border-l px-2 py-1 text-xs uppercase tracking-wide ${
                          priority === "pin"
                            ? "border-lime-400/40 text-lime-400"
                            : priority === "soften"
                              ? "border-ink-600 text-ink-400"
                              : "border-ink-700 text-ink-400"
                        }`}
                      >
                        {priority === "pin" ? "pin" : priority === "soften" ? "soft" : "·"}
                      </button>
                    </span>
                  );
                })}
                {keywords.length === 0 && (
                  <p className="text-sm text-ink-400">No keywords extracted — add your own below.</p>
                )}
              </div>

              <div className="flex gap-2">
                <input
                  value={newKeyword}
                  onChange={(event) => setNewKeyword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addKeyword();
                    }
                  }}
                  placeholder="Add a skill or term…"
                  className="flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm outline-none focus:border-accent-500"
                />
                <button
                  type="button"
                  onClick={addKeyword}
                  className="rounded-lg border border-ink-700 px-3 py-2 text-sm text-ink-200 hover:border-ink-600"
                >
                  Add
                </button>
              </div>

              <p className="text-xs text-ink-400">
                {includedKeywords.length} of {keywords.length} keywords will be used for ranking.
                Low-confidence terms start excluded.
              </p>
            </div>
          </section>

          <section className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !draft}
              onClick={() => void confirm()}
              className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-ink-50 hover:bg-accent-500 disabled:opacity-50"
            >
              {busy ? "Working…" : "Confirm profile"}
            </button>
            {profile.confirmedAt && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void withdraw()}
                className="rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 hover:border-ink-600 disabled:opacity-50"
              >
                Withdraw confirmation
              </button>
            )}
            <label className="ml-auto cursor-pointer rounded-lg border border-ink-700 px-4 py-2 text-sm text-ink-200 hover:border-ink-600">
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md"
                disabled={busy}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              Re-upload résumé
            </label>
          </section>

          <p className="text-xs text-ink-400">
            Chat-based refinement (&ldquo;drop Kubernetes, I only used it in 2021&rdquo;) arrives with
            the Phase 7 tool loop; for now, edit the chips directly.
          </p>
        </>
      )}
    </main>
  );
}
