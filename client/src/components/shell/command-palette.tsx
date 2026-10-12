// ⌘K: jump to any job by address, customer or reference, or run a command.
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, FileText, LayoutGrid, MapPin, Palette, Plus, Settings } from "lucide-react";
import { DIRECTIONS } from "@/lib/directions";
import type { RecordingMeta } from "@/lib/types";
import { JOB_STATUS_LABEL, jobCustomer, jobRef, jobStatus, jobTitle } from "@/lib/job-status";

type Option = { group: string; key: string; label: string; meta?: string; icon: ReactNode; run: () => void };

export function CommandPalette({ jobs, onClose, onNewQuote, onDirection }: {
  jobs: RecordingMeta[];
  onClose: () => void;
  onNewQuote: () => void;
  onDirection: (family: string) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const options = useMemo<Option[]>(() => {
    const go = (path: string) => () => { onClose(); navigate(path); };
    const commands: Option[] = [
      { group: "Commands", key: "new", label: "New quote", meta: "N", icon: <Plus />, run: onNewQuote },
      { group: "Commands", key: "jobs", label: "Go to jobs", icon: <LayoutGrid />, run: go("/jobs") },
      { group: "Commands", key: "invoices", label: "Go to invoices", icon: <FileText />, run: go("/invoices") },
      { group: "Commands", key: "catalogue", label: "Go to catalogue", icon: <BookOpen />, run: go("/pricing") },
      { group: "Commands", key: "settings", label: "Settings", icon: <Settings />, run: go("/settings") },
      ...DIRECTIONS.map((direction) => ({
        group: "Commands",
        key: `direction-${direction.family}`,
        label: `Switch look: ${direction.name}`,
        meta: direction.tag,
        icon: <Palette />,
        run: () => onDirection(direction.family),
      })),
    ];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text: string) => terms.every((term) => text.includes(term));
    const jobOptions: Option[] = jobs
      .filter((job) => matches([jobTitle(job), jobCustomer(job), jobRef(job), job.contactEmail, job.contactPhone].filter(Boolean).join(" ").toLowerCase()))
      .slice(0, terms.length ? 8 : 5)
      .map((job) => ({
        group: terms.length ? "Jobs" : "Recent jobs",
        key: job.id,
        label: jobTitle(job),
        meta: [jobRef(job), JOB_STATUS_LABEL[jobStatus(job)]].join(" · "),
        icon: <MapPin />,
        run: go(`/jobs/${job.id}`),
      }));
    return [...jobOptions, ...commands.filter((command) => matches(command.label.toLowerCase()))];
  }, [jobs, navigate, onClose, onNewQuote, onDirection, query]);

  const run = (option: Option | undefined) => option?.run();

  return (
    <div className="fx-scrim" onMouseDown={onClose}>
      <div className="fx-dialog fx-palette" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(event) => event.stopPropagation()} style={{ width: "min(600px, 100%)" }}>
        <input
          id="command-palette-query"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={options[active] ? `cp-${options[active].key}` : undefined}
          placeholder="Jump to a job, or type a command…"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            else if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, options.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); run(options[active]); }
          }}
        />
        <div className="fx-palette__res" id="command-palette-results" role="listbox">
          {options.map((option, index) => (
            <div key={option.key}>
              {(index === 0 || options[index - 1].group !== option.group) && <div className="fx-palette__g">{option.group}</div>}
              <button
                type="button"
                id={`cp-${option.key}`}
                role="option"
                aria-selected={index === active}
                className="fx-palette__opt"
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(option)}
              >
                {option.icon}
                <b>{option.label}</b>
                {option.meta && <small>{option.meta}</small>}
              </button>
            </div>
          ))}
          {options.length === 0 && <div className="fx-palette__g" style={{ padding: 16 }}>Nothing matches “{query}”.</div>}
        </div>
      </div>
    </div>
  );
}
