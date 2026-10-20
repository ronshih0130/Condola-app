export function SampleTag({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <span className="chip warn" data-testid="sample-tag">
      {label}
    </span>
  );
}
