import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Mark, mergeAttributes } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  ChevronDown,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Paperclip,
  Signature,
  Underline as UnderlineIcon,
  X,
} from "lucide-react";

export type QuoteEmailTemplate = {
  id: string;
  name: string;
  description: string;
  subject?: string;
  html: string;
};

type QuoteEmailEditorProps = {
  initialContent: string;
  templates?: QuoteEmailTemplate[];
  selectedTemplateId?: string;
  onTemplateSelect?: (templateId: string) => void;
  onChange: (html: string) => void;
  attachments?: File[];
  onAttachmentsChange?: (attachments: File[]) => void;
  fullPage?: boolean;
  /** The business name the signature button signs with. */
  signatureName?: string;
};

const FONT_SIZES = ["13px", "14px", "16px", "18px", "20px", "24px"];
const THEME_FONT_VALUE = "var(--t-body)";

const FontSize = Mark.create({
  name: "fontSize",

  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: (element) => element.style.fontSize || null,
        renderHTML: (attributes) => {
          if (!attributes.size) return {};
          return { style: `font-size: ${attributes.size}` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[style]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
});

const FontFamily = Mark.create({
  name: "fontFamily",

  addAttributes() {
    return {
      family: {
        default: null,
        parseHTML: (element) => element.style.fontFamily || null,
        renderHTML: (attributes) => {
          if (!attributes.family) return {};
          return { style: `font-family: ${attributes.family}` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[style]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
});

export function QuoteEmailEditor({
  initialContent,
  templates = [],
  selectedTemplateId,
  onTemplateSelect,
  onChange,
  attachments = [],
  onAttachmentsChange,
  fullPage = false,
  signatureName = "",
}: QuoteEmailEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [themeFontName, setThemeFontName] = useState("App font");
  const [selectedFontSize, setSelectedFontSize] = useState("14px");
  const [selectedFontFamily, setSelectedFontFamily] = useState(THEME_FONT_VALUE);
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkRangeRef = useRef<{ from: number; to: number } | null>(null);
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        code: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto", "tel"],
      }),
      FontSize,
      FontFamily,
      Placeholder.configure({ placeholder: "Write the email message..." }),
    ],
    [],
  );
  const fontFamilies = useMemo(
    () => [
      { label: themeFontName, value: THEME_FONT_VALUE },
      { label: "Arial", value: "Arial, Helvetica, sans-serif" },
      { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
      { label: "Geist Mono", value: "'Geist Mono Variable', 'JetBrains Mono', monospace" },
    ],
    [themeFontName],
  );

  const editor = useEditor({
    extensions,
    content: initialContent,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === initialContent) return;
    editor.commands.setContent(initialContent);
  }, [editor, initialContent]);

  useEffect(() => {
    const computed = getComputedStyle(document.documentElement).getPropertyValue("--t-body").trim();
    if (computed) setThemeFontName(formatFontName(computed));
  }, []);

  function applyFontSize(size: string) {
    setSelectedFontSize(size);
    editor?.chain().focus().setMark("fontSize", { size }).run();
  }

  function applyFontFamily(family: string) {
    setSelectedFontFamily(family);
    editor?.chain().focus().setMark("fontFamily", { family }).run();
  }

  function insertLink() {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const { from, to } = editor.state.selection;
    linkRangeRef.current = { from, to };
    setLinkUrl(previousUrl || "");
    setLinkEditorOpen(true);
  }

  function applyLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const url = normalizeLinkUrl(linkUrl);
    const range = linkRangeRef.current;
    let chain = editor.chain().focus();
    if (range) chain = chain.setTextSelection(range);
    if (!url) {
      chain.extendMarkRange("link").unsetLink().run();
      setLinkEditorOpen(false);
      return;
    }
    chain.extendMarkRange("link").setLink({ href: url }).run();
    setLinkEditorOpen(false);
  }

  function insertSignature() {
    const name = signatureName.trim()
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    editor?.chain().focus().insertContent(`<p>Regards,<br/>${name}</p>`).run();
  }

  function handleAttachFiles(files: FileList | null) {
    if (!files?.length || !onAttachmentsChange) return;
    onAttachmentsChange([...attachments, ...Array.from(files)]);
  }

  function removeAttachment(index: number) {
    if (!onAttachmentsChange) return;
    onAttachmentsChange(attachments.filter((_file, fileIndex) => fileIndex !== index));
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    handleAttachFiles(event.dataTransfer.files);
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  return (
    <div
      onDragEnter={onAttachmentsChange ? handleDragEnter : undefined}
      onDragOver={onAttachmentsChange ? handleDragOver : undefined}
      onDragLeave={onAttachmentsChange ? handleDragLeave : undefined}
      onDrop={onAttachmentsChange ? handleDrop : undefined}
      style={{
        minHeight: fullPage ? "100%" : undefined,
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr) auto",
        border: "1px solid var(--t-brd)",
        borderRadius: "var(--t-radius)",
        overflow: "hidden",
        background: "var(--t-bg)",
        outline: dragActive ? "2px dashed var(--t-accent)" : "none",
        outlineOffset: dragActive ? -7 : 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          padding: fullPage ? "12px 14px" : "8px 10px",
          borderBottom: "1px solid var(--t-brd)",
          background: "color-mix(in srgb, var(--t-s1) 75%, var(--t-bg))",
        }}
      >
        {templates.length ? (
          <EditorDropdown
            label="Email template"
            value={selectedTemplateId || ""}
            options={templates.map((template) => ({ label: template.name, value: template.id }))}
            onChange={(value) => onTemplateSelect?.(value)}
            width={168}
          />
        ) : null}
        <ToolbarButton label="Bold" active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <Bold size={15} />
        </ToolbarButton>
        <ToolbarButton label="Italic" active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <Italic size={15} />
        </ToolbarButton>
        <ToolbarButton label="Underline" active={editor?.isActive("underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon size={15} />
        </ToolbarButton>
        <EditorDropdown
          label="Font size"
          value={selectedFontSize}
          options={FONT_SIZES.map((size) => ({ label: size, value: size }))}
          onChange={applyFontSize}
          width={92}
        />
        <EditorDropdown
          label="Font family"
          value={selectedFontFamily}
          options={fontFamilies}
          onChange={applyFontFamily}
          width={132}
        />
        <ToolbarButton label="Bullet list" active={editor?.isActive("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          <List size={15} />
        </ToolbarButton>
        <ToolbarButton label="Numbered list" active={editor?.isActive("orderedList")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          <ListOrdered size={15} />
        </ToolbarButton>
        <div style={{ position: "relative" }}>
          <ToolbarButton label="Link" active={editor?.isActive("link") || linkEditorOpen} onClick={insertLink}>
            <LinkIcon size={15} />
          </ToolbarButton>
          {linkEditorOpen ? (
            <form
              onSubmit={applyLink}
              style={{
                position: "absolute",
                zIndex: 25,
                top: "calc(100% + 8px)",
                left: 0,
                width: 286,
                padding: 10,
                border: "1px solid var(--t-brd)",
                borderRadius: "var(--t-radius)",
                background: "var(--t-bg)",
                boxShadow: "0 16px 35px rgba(0,0,0,.22)",
                display: "grid",
                gap: 8,
              }}
            >
              <label style={{ fontFamily: "var(--t-data)", fontSize: 11, fontWeight: 800, color: "var(--t-mute)", textTransform: "uppercase", letterSpacing: ".1em" }}>
                Link URL
              </label>
              <input
                autoFocus
                type="text"
                inputMode="url"
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                placeholder="https://example.com"
                style={{
                  width: "100%",
                  border: "1px solid var(--t-brd)",
                  borderRadius: "var(--t-radius)",
                  background: "var(--t-s1)",
                  color: "var(--t-text)",
                  fontFamily: "var(--t-body)",
                  fontSize: 13,
                  padding: "10px 11px",
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
                <button type="button" onClick={() => setLinkEditorOpen(false)} style={miniButtonStyle}>
                  Cancel
                </button>
                <button type="submit" style={{ ...miniButtonStyle, background: "var(--t-accent)", color: "var(--t-bg)", borderColor: "var(--t-accent)" }}>
                  Apply
                </button>
              </div>
            </form>
          ) : null}
        </div>
        <ToolbarButton label="Signature" onClick={insertSignature}>
          <Signature size={15} />
        </ToolbarButton>
        <ToolbarButton label="Attach images" onClick={() => imageInputRef.current?.click()}>
          <ImageIcon size={15} />
        </ToolbarButton>
        {onAttachmentsChange ? (
          <>
            {fullPage ? <span aria-hidden="true" style={{ flexBasis: "100%", height: 0 }} /> : null}
            <ToolbarButton label="Attach files" onClick={() => fileInputRef.current?.click()}>
              <Paperclip size={15} />
            </ToolbarButton>
          </>
        ) : null}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => {
            handleAttachFiles(event.target.files);
            event.target.value = "";
          }}
          style={{ display: "none" }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(event) => {
            handleAttachFiles(event.target.files);
            event.target.value = "";
          }}
          style={{ display: "none" }}
        />
      </div>

      <style>{`
        .quote-editor .ProseMirror {
          outline: none;
          min-height: ${fullPage ? "394px" : "160px"};
          padding: ${fullPage ? "22px 24px" : "12px 14px"};
          font-family: var(--t-body);
          font-size: 14px;
          color: var(--t-text);
          line-height: 1.65;
        }
        .quote-editor .ProseMirror p {
          margin: 0 0 12px;
        }
        .quote-editor .ProseMirror ul,
        .quote-editor .ProseMirror ol {
          padding-left: 24px;
          margin: 0 0 12px;
        }
        .quote-editor .ProseMirror a {
          color: var(--t-accent);
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .quote-editor .ProseMirror p:last-child {
          margin-bottom: 0;
        }
        .quote-editor .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--t-mute);
          pointer-events: none;
          height: 0;
        }
      `}</style>
      <div className="quote-editor" style={{ overflow: "auto" }}>
        <EditorContent editor={editor} />
      </div>

      {onAttachmentsChange && attachments.length ? (
        <div
          style={{
            padding: "12px 14px",
            borderTop: "1px solid var(--t-brd)",
            display: "grid",
            gap: 10,
            background: dragActive
              ? "color-mix(in srgb, var(--t-accent) 12%, var(--t-bg))"
              : "color-mix(in srgb, var(--t-s1) 60%, var(--t-bg))",
            outline: dragActive ? "1px dashed var(--t-accent)" : "none",
            outlineOffset: -6,
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))", gap: 10 }}>
            {attachments.map((file, index) => (
              <AttachmentTile
                key={`${file.name}:${file.size}:${index}`}
                file={file}
                onRemove={() => removeAttachment(index)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

type EditorDropdownOption = {
  label: string;
  value: string;
};

function EditorDropdown({
  label,
  value,
  options,
  onChange,
  width,
}: {
  label: string;
  value: string;
  options: EditorDropdownOption[];
  onChange: (value: string) => void;
  width: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (ref.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", width, flex: "0 0 auto" }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onMouseDown={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
        style={{
          width: "100%",
          height: 34,
          borderRadius: "var(--t-radius)",
          border: open ? "1px solid var(--t-accent)" : "1px solid var(--t-brd)",
          background: "var(--t-bg)",
          color: "var(--t-text)",
          fontFamily: "var(--t-body)",
          fontSize: 13,
          fontWeight: 700,
          padding: "0 8px 0 10px",
          outline: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          cursor: "pointer",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label || label}
        </span>
        <ChevronDown size={14} style={{ flex: "0 0 auto", transform: open ? "rotate(180deg)" : undefined }} />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label={label}
          style={{
            position: "absolute",
            zIndex: 20,
            top: "calc(100% + 6px)",
            left: 0,
            width: Math.max(width, 140),
            padding: 5,
            border: "1px solid var(--t-brd)",
            borderRadius: "var(--t-radius)",
            background: "var(--t-bg)",
            boxShadow: "0 16px 35px rgba(0,0,0,.2)",
            display: "grid",
            gap: 3,
          }}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{
                  border: "none",
                  borderRadius: "var(--t-radius)",
                  background: active ? "color-mix(in srgb, var(--t-accent) 17%, transparent)" : "transparent",
                  color: active ? "var(--t-accent)" : "var(--t-text)",
                  fontFamily: "var(--t-body)",
                  fontSize: 13,
                  fontWeight: active ? 800 : 650,
                  padding: "8px 9px",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentTile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/");
  const previewUrl = useMemo(() => isImage ? URL.createObjectURL(file) : null, [file, isImage]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  return (
    <div
      style={{
        position: "relative",
        minHeight: 92,
        borderRadius: "var(--t-radius)",
        border: "1px solid var(--t-brd)",
        background: "var(--t-bg)",
        overflow: "hidden",
      }}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          style={{
            width: "100%",
            height: 92,
            display: "block",
            objectFit: "cover",
          }}
        />
      ) : (
        <div
          style={{
            height: 92,
            display: "grid",
            placeItems: "center",
            padding: 10,
            color: "var(--t-dim)",
            fontSize: 12,
            fontWeight: 800,
            textAlign: "center",
            wordBreak: "break-word",
          }}
        >
          {file.name}
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        title="Remove attachment"
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 24,
          height: 24,
          borderRadius: "50%",
          border: "1px solid rgba(0,0,0,.2)",
          background: "color-mix(in srgb, var(--t-bg) 92%, transparent)",
          color: "var(--t-text)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,.25)",
        }}
      >
        <X size={14} />
      </button>
      {previewUrl ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "16px 7px 7px",
            background: "linear-gradient(to top, rgba(0,0,0,.72), transparent)",
            color: "white",
            fontSize: 11,
            fontWeight: 700,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={file.name}
        >
          {file.name}
        </div>
      ) : null}
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      style={{
        width: 34,
        height: 34,
        borderRadius: "var(--t-radius)",
        border: active ? "1px solid var(--t-accent)" : "1px solid var(--t-brd)",
        background: active ? "color-mix(in srgb, var(--t-accent) 18%, transparent)" : "var(--t-bg)",
        color: active ? "var(--t-accent)" : "var(--t-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function dragHasFiles(event: React.DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types || []).includes("Files");
}

function normalizeLinkUrl(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
  return `https://${raw}`;
}

export function formatFontName(value: string) {
  const firstFamily = String(value || "")
    .split(",")[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+Variable$/i, "")
    .trim();
  return firstFamily || "App font";
}

const miniButtonStyle = {
  minHeight: 32,
  border: "1px solid var(--t-brd)",
  borderRadius: "var(--t-radius)",
  background: "var(--t-s1)",
  color: "var(--t-text)",
  fontFamily: "var(--t-body)",
  fontSize: 12,
  fontWeight: 800,
  padding: "7px 10px",
  cursor: "pointer",
};
