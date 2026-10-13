// Marks for the integrations catalogue. Field has no licensed vendor logos,
// so each integration gets a neutral tile with its initial, in Field's own
// colours. A licensed mark can replace a tile later without other changes.
export function MonogramMark({ letter, label }: { letter: string; label: string }) {
  return (
    <span className="fx-intmark" role="img" aria-label={`${label} logo`}>
      <span aria-hidden>{letter}</span>
    </span>
  );
}

export function XeroMark() {
  return <MonogramMark letter="X" label="Xero" />;
}
