interface FilePickerProps {
  label: string;
  hint: string;
  accept: string;
  currentLabel: string;
  pendingFile?: File | null;
  disabled?: boolean;
  onFile: (file: File | null) => void;
}

export default function FilePicker({ label, hint, accept, currentLabel, pendingFile, disabled, onFile }: FilePickerProps) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
      <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{label}</p>
      <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 10 }}>{hint}</p>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={event => onFile(event.target.files?.[0] ?? null)}
      />
      <p style={{ fontSize: 12, color: pendingFile ? "#15803d" : "#6b7280", marginTop: 8 }}>
        {pendingFile ? `Selected: ${pendingFile.name}` : currentLabel || "No file uploaded yet."}
      </p>
    </div>
  );
}
