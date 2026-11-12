import { env } from "@/lib/env";

const rows: Array<[string, string]> = [
  ["Coordinator", `${env.coordinator.url} · ${env.coordinator.label}`],
  ["Vision / OCR", `${env.vision.url} · ${env.vision.label}`],
  ["Database", env.dbPath],
  ["Uploads", env.uploadDir],
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-400">
          phase 0 — scaffold online
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          HireMyAss
          <span className="ml-2 text-base font-normal text-ink-400">
            job prospect pooler
          </span>
        </h1>
        <p className="max-w-xl text-sm leading-relaxed text-ink-200">
          Local-first. Your résumé never leaves this machine — the only outbound
          traffic is job-board reads, and every result is credited with a source
          link.
        </p>
      </header>

      <dl className="divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700 bg-ink-900">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
          >
            <dt className="w-32 shrink-0 text-xs font-medium uppercase tracking-wider text-ink-400">
              {label}
            </dt>
            <dd className="break-all font-mono text-xs text-ink-200">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-ink-400">
        Run{" "}
        <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono">
          npm run preflight
        </code>{" "}
        to verify the models and llama-server, then{" "}
        <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono">
          npm run servers
        </code>{" "}
        to bring both GPU instances up.
      </p>
    </main>
  );
}
