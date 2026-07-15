interface FilePickerProps {
  label: string;
  hint: string;
  accept: string;
  currentLabel: string;
  pendingFile?: File | null;
  previewUrl?: string;
  previewType?: "image" | "audio";
  previewAlt?: string;
  previewAspectRatio?: string;
  previewLoading?: boolean;
  previewError?: string;
  onPreviewRetry?: () => void;
  warning?: string;
  requiredNote?: string;
  error?: string;
  disabled?: boolean;
  onFile: (file: File | null) => void;
}

export default function FilePicker({
  label,
  hint,
  accept,
  currentLabel,
  pendingFile,
  previewUrl = "",
  previewType,
  previewAlt,
  previewAspectRatio = "1 / 1",
  previewLoading,
  previewError,
  onPreviewRetry,
  warning,
  requiredNote,
  error,
  disabled,
  onFile,
}: FilePickerProps) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
      <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{label}</p>
      {requiredNote && <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>{requiredNote}</p>}
      <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 10 }}>{hint}</p>
      {previewType === "image" && (
        <div style={{
          width: "min(180px, 100%)",
          aspectRatio: previewAspectRatio,
          border: "1px solid #d1d5db",
          borderRadius: 6,
          overflow: "hidden",
          background: "#f9fafb",
          display: "grid",
          placeItems: "center",
          marginBottom: 10,
        }}>
          {previewUrl ? (
            <img src={previewUrl} alt={previewAlt ?? label} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          ) : (
            <span style={{ fontSize: 12, color: "#9ca3af" }}>No preview</span>
          )}
        </div>
      )}
      {previewType === "audio" && (
        <div style={{ marginBottom: 10 }}>
          {previewLoading && <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>Loading audio preview...</p>}
          {previewUrl ? (
            <audio controls src={previewUrl} style={{ width: "100%", maxWidth: 360 }} />
          ) : (
            <p style={{ fontSize: 12, color: previewError ? "#b91c1c" : "#9ca3af" }}>
              {previewError || "No audio preview yet."}
            </p>
          )}
          {previewError && onPreviewRetry && (
            <button type="button" disabled={disabled || previewLoading} onClick={onPreviewRetry} style={{
              marginTop: 6,
              padding: "4px 9px",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              background: "#fff",
              color: "#374151",
              fontSize: 12,
              fontWeight: 600,
            }}>
              Retry preview
            </button>
          )}
        </div>
      )}
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={event => onFile(event.target.files?.[0] ?? null)}
      />
      <p style={{ fontSize: 12, color: pendingFile ? "#15803d" : "#6b7280", marginTop: 8 }}>
        {pendingFile ? `Selected: ${pendingFile.name}` : currentLabel || "No file uploaded yet."}
      </p>
      {error && <p style={{ fontSize: 12, color: "#b91c1c", marginTop: 6 }}>{error}</p>}
      {warning && <p style={{ fontSize: 12, color: "#b45309", marginTop: 6 }}>{warning}</p>}
    </div>
  );
}
