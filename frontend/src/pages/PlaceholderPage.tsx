/**
 * PlaceholderPage — enterprise "coming soon" treatment.
 * Intentionally compact; avoids oversized empty-state heroes.
 * Used by PlaceholderFromNav for every not-yet-built route.
 */
interface PlaceholderPageProps {
  title:       string;
  description: string;
}

export default function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="flex flex-col gap-4">

      {/* Primary card */}
      <div className="max-w-xl rounded-xl border border-dashed border-zinc-200 bg-white px-6 py-6 shadow-sm">
        <div className="flex items-start gap-4">
          {/* Status pip */}
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50">
            <span className="block h-2 w-2 rounded-full bg-zinc-300" />
          </div>
          <div>
            <h2 className="text-[13.5px] font-semibold text-zinc-900">{title}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">{description}</p>
          </div>
        </div>

        <div className="mt-5 border-t border-zinc-100 pt-4">
          <p className="text-[11.5px] font-medium uppercase tracking-wide text-zinc-400">
            Status
          </p>
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-[11px] font-medium text-zinc-500">
              <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
              Not yet available
            </span>
          </div>
        </div>
      </div>

    </div>
  );
}
