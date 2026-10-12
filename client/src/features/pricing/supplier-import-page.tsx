import { useEffect, useState, type FormEvent } from "react";
import { FileUp, Plus } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { Button } from "@/components/ui/button";
import { ImportReview } from "./import-review";
import {
  errorMessage,
  priceBookApi,
  type ColumnField,
  type ColumnMap,
  type InspectResult,
  type PriceImport,
  type Supplier,
} from "./price-book-api";
import { controlStyle, dataControlStyle, labelStyle, noticeStyle, panelStyle, tdStyle, thStyle } from "./price-book-styles";

const FIELDS: Array<{ key: ColumnField; label: string; hint: string }> = [
  { key: "supplier_code", label: "Supplier code", hint: "The supplier's SKU or part number" },
  { key: "item_code", label: "Field code", hint: "Field's own item code, if the file has it" },
  { key: "name", label: "Name", hint: "Matches an item by exact name when no code matches; names new items" },
  { key: "unit", label: "Unit", hint: "Price per this unit; converted to the item's unit" },
  { key: "cost", label: "Cost (required)", hint: "The supplier's price to you" },
  { key: "sell", label: "Sell", hint: "Only used for items with a fixed sell price" },
];

function todayInput(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Today means "now"; a later date is local midnight on that day. */
function effectiveFromInput(value: string): string | null {
  if (!value || value <= todayInput()) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

function SupplierPicker({ suppliers, value, onChange, onCreated }: {
  suppliers: Supplier[];
  value: string;
  onChange: (uid: string) => void;
  onCreated: (supplier: Supplier) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [markup, setMarkup] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const supplier = await priceBookApi.createSupplier({ name: name.trim(), default_markup_pct: markup.trim() === "" ? null : Number(markup) });
      onCreated(supplier);
      setAdding(false);
      setName("");
      setMarkup("");
    } catch (err) {
      setError(errorMessage(err, "Could not add the supplier"));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelStyle}>SUPPLIER</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <select aria-label="Supplier" value={value} onChange={(event) => onChange(event.target.value)} style={{ ...controlStyle, flex: "1 1 220px" }}>
          <option value="">Choose a supplier…</option>
          {suppliers.map((supplier) => <option key={supplier.uid} value={supplier.uid}>{supplier.name}{supplier.item_count ? ` (${supplier.item_count} items)` : ""}</option>)}
        </select>
        <Button type="button" variant="ghost" className="border border-[var(--t-brd)] rounded-[4px]" size="sm" onClick={() => setAdding((open) => !open)}><Plus size={14} />New supplier</Button>
      </div>
      {adding ? (
        <form onSubmit={create} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input aria-label="New supplier name" placeholder="Supplier name" value={name} onChange={(event) => setName(event.target.value)} style={{ ...controlStyle, flex: "1 1 200px" }} />
          <input aria-label="Default markup %" placeholder="Default markup %" value={markup} onChange={(event) => setMarkup(event.target.value)} inputMode="decimal" style={{ ...dataControlStyle, width: 150 }} />
          <Button type="submit" variant="accent" size="sm" disabled={!name.trim()}>Add</Button>
        </form>
      ) : null}
      {error ? <div role="alert" style={noticeStyle("danger")}>{error}</div> : null}
    </div>
  );
}

function NewImport({ onStaged }: { onStaged: (record: PriceImport) => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierUid, setSupplierUid] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [inspected, setInspected] = useState<InspectResult | null>(null);
  const [columnMap, setColumnMap] = useState<ColumnMap>({});
  const [effective, setEffective] = useState(todayInput());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    priceBookApi.suppliers().then(setSuppliers).catch((err) => setError(errorMessage(err, "Could not load suppliers")));
  }, []);

  async function inspect(nextFile: File | null, nextSupplier: string) {
    setInspected(null);
    if (!nextFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await priceBookApi.inspect(nextFile, nextSupplier || null);
      setInspected(result);
      setColumnMap(result.columnMap);
    } catch (err) {
      setError(errorMessage(err, "Could not read the file"));
    } finally {
      setBusy(false);
    }
  }

  async function stage() {
    if (!file || !supplierUid) return;
    setBusy(true);
    setError(null);
    try {
      onStaged(await priceBookApi.stage(file, supplierUid, columnMap, effectiveFromInput(effective)));
    } catch (err) {
      setError(errorMessage(err, "Could not stage the price list"));
      setBusy(false);
    }
  }

  const ready = Boolean(file && supplierUid && inspected && columnMap.cost && (columnMap.supplier_code || columnMap.item_code || columnMap.name));

  return (
    <section aria-label="New import" style={{ ...panelStyle, padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
      <SupplierPicker
        suppliers={suppliers}
        value={supplierUid}
        onChange={(uid) => { setSupplierUid(uid); void inspect(file, uid); }}
        onCreated={(supplier) => { setSuppliers((list) => [...list, supplier].sort((a, b) => a.name.localeCompare(b.name))); setSupplierUid(supplier.uid); }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={labelStyle}>PRICE LIST (CSV)</span>
        <label style={{ ...controlStyle, position: "relative", display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", width: "fit-content", maxWidth: "100%" }}>
          <FileUp size={14} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : "Choose a .csv file"}</span>
          <input
            aria-label="Price list file"
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={(event) => { const next = event.target.files?.[0] || null; setFile(next); void inspect(next, supplierUid); }}
            style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
          />
        </label>
        <span style={{ fontSize: 12, color: "var(--t-dim)" }}>Excel files: save as CSV first. Up to 10 MB.</span>
      </div>

      {inspected ? (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={labelStyle}>COLUMNS {inspected.columnMapSource === "supplier" ? "· saved for this supplier" : "· guessed"}</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
              {FIELDS.map((field) => (
                <label key={field.key} style={{ display: "flex", flexDirection: "column", gap: 4 }} title={field.hint}>
                  <span style={{ fontSize: 12, color: "var(--t-dim)" }}>{field.label}</span>
                  <select
                    aria-label={`Column for ${field.label}`}
                    value={columnMap[field.key] || ""}
                    onChange={(event) => setColumnMap((map) => ({ ...map, [field.key]: event.target.value || undefined }))}
                    style={controlStyle}
                  >
                    <option value="">—</option>
                    {inspected.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <div style={{ overflowX: "auto", border: "1px solid var(--t-brd)", borderRadius: 4 }}>
            <table aria-label="File preview" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead><tr>{inspected.headers.map((header) => <th key={header} style={thStyle}>{header}</th>)}</tr></thead>
              <tbody>
                {inspected.sampleRows.map((row, index) => (
                  <tr key={index}>{inspected.headers.map((header, i) => <td key={header} style={{ ...tdStyle, padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap" }}>{row[i]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontFamily: "var(--t-data)", fontSize: 12, color: "var(--t-dim)" }}>{inspected.rowCount} rows</div>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, width: "fit-content" }}>
            <span style={labelStyle}>PRICES TAKE EFFECT</span>
            <input aria-label="Effective date" type="date" min={todayInput()} value={effective} onChange={(event) => setEffective(event.target.value)} style={dataControlStyle} />
          </label>
        </>
      ) : null}

      {error ? <div role="alert" style={noticeStyle("danger")}>{error}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="button" variant="accent" size="sm" disabled={!ready || busy} onClick={() => void stage()}>
          {busy ? "Working…" : "Compare with the catalogue"}
        </Button>
      </div>
    </section>
  );
}

function RecentImports({ imports, onOpen }: { imports: PriceImport[]; onOpen: (uid: string) => void }) {
  if (!imports.length) return null;
  return (
    <section aria-label="Recent imports" style={{ ...panelStyle }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--t-brd)", ...labelStyle }}>RECENT IMPORTS</div>
      {imports.map((record) => (
        <button
          key={record.uid}
          type="button"
          onClick={() => onOpen(record.uid)}
          style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 8, padding: "8px 14px", background: "none", border: "none", borderBottom: "1px solid var(--t-brd)", color: "var(--t-text)", textAlign: "left", cursor: "pointer" }}
        >
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <strong style={{ fontSize: 13 }}>{record.supplier_name || "Supplier"}</strong>
            <span style={{ fontSize: 12, color: "var(--t-dim)" }}> · {record.file_name || record.uid}</span>
          </span>
          <span style={{ fontFamily: "var(--t-data)", fontSize: 11, color: record.status === "staged" ? "var(--t-accent)" : "var(--t-dim)", whiteSpace: "nowrap" }}>
            {record.status} · {record.created_at ? new Date(record.created_at).toLocaleDateString("en-AU") : ""}
          </span>
        </button>
      ))}
    </section>
  );
}

export function SupplierImportPage() {
  const navigate = useNavigate();
  const { importUid } = useParams();
  const [record, setRecord] = useState<PriceImport | null>(null);
  const [imports, setImports] = useState<PriceImport[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (importUid) {
      priceBookApi.getImport(importUid)
        .then((next) => { if (!cancelled) setRecord(next); })
        .catch((err) => { if (!cancelled) setError(errorMessage(err, "Could not load the import")); });
    } else {
      priceBookApi.imports()
        .then((list) => { if (!cancelled) setImports(list); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [importUid]);

  const shown = importUid && record?.uid === importUid ? record : null;

  return (
    <div style={{ color: "var(--t-text)", fontFamily: "var(--t-body)" }}>
      <ScreenHeader
          backLabel={importUid ? "Imports" : "Catalogue"}
          backTo={importUid ? "/pricing/import" : "/pricing"}
          title="Supplier price list"
          section={shown ? shown.status : "Import"}
        />
      <div style={{ maxWidth: 1100, padding: "20px 28px 40px", display: "flex", flexDirection: "column", gap: 16 }}>
        
        {error ? <div role="alert" style={noticeStyle("danger")}>{error}</div> : null}
        {importUid ? (
          shown ? <ImportReview key={`${shown.uid}:${shown.status}`} record={shown} onChanged={setRecord} /> : (!error ? <div style={{ color: "var(--t-dim)" }}>Loading…</div> : null)
        ) : (
          <>
            <NewImport onStaged={(staged) => { setRecord(staged); navigate(`/pricing/import/${staged.uid}`); }} />
            <RecentImports imports={imports} onOpen={(uid) => navigate(`/pricing/import/${uid}`)} />
          </>
        )}
      </div>
    </div>
  );
}
