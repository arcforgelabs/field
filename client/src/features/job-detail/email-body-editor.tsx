// The email body: plain rich text only. Bold, italic, underline, bulleted
// and numbered lists, and links (owner's decision 6, 2026-10-13: no font
// family or size pickers; the business's identity is on the document).
// Pasted text keeps only those, because the editor knows no other marks.
//
// Merge fields are a mark (`<span data-merge="amountDue">$7,920.00</span>`):
// shown with a dotted underline while composing, filled again by the server
// with its own values when the email is built, and plain in the sent email.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Mark, mergeAttributes, type Editor } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Braces, Italic, Link as LinkIcon, List, ListOrdered, Signature, Underline as UnderlineIcon } from "lucide-react";
import { Menu } from "@/components/shell/menu";

export type EmailTemplateOption = { id: string; name: string; description?: string };
export type MergeFieldOption = { key: string; label: string; value: string | null };

const MergeField = Mark.create({
  name: "mergeField",
  inclusive: false,
  addAttributes() {
    return {
      key: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-merge"),
        renderHTML: (attributes) => (attributes.key ? { "data-merge": attributes.key } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-merge]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
});

export function normalizeLinkUrl(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
  return `https://${raw}`;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export type EmailBodyEditorHandle = {
  focus: () => void;
  insertHtml: (html: string) => void;
};

export const EmailBodyEditor = forwardRef<EmailBodyEditorHandle, {
  content: string;
  onChange: (html: string) => void;
  templates: EmailTemplateOption[];
  templateId: string;
  onTemplateSelect: (id: string) => void;
  mergeFields: MergeFieldOption[];
  onInsertSignature: () => void;
  /** Extra controls at the end of the toolbar (the phone's attach button). */
  toolbarEnd?: ReactNode;
}>(function EmailBodyEditor({ content, onChange, templates, templateId, onTemplateSelect, mergeFields, onInsertSignature, toolbarEnd }, ref) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const linkRange = useRef<{ from: number; to: number } | null>(null);
  const openLinkRef = useRef<(editor: Editor) => void>(() => {});
  const extensions = useMemo(() => [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      blockquote: false,
      horizontalRule: false,
      code: false,
      strike: false,
      link: false,
      underline: false,
    }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto", "tel"] }),
    MergeField,
    Placeholder.configure({ placeholder: "Write the message…" }),
    // Ctrl/⌘ K opens the link box.
    Mark.create({
      name: "linkShortcut",
      addKeyboardShortcuts() {
        return { "Mod-k": () => { openLinkRef.current(this.editor); return true; } };
      },
    }),
  ], []);

  const editor = useEditor({
    extensions,
    content,
    editorProps: { attributes: { class: "fx-body__doc", "aria-label": "Message", role: "textbox", "aria-multiline": "true" } },
    onUpdate: ({ editor: current }) => onChange(current.getHTML()),
  });

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === content) return;
    editor.commands.setContent(content, { emitUpdate: false });
  }, [editor, content]);

  openLinkRef.current = (current: Editor) => {
    const { from, to } = current.state.selection;
    linkRange.current = { from, to };
    setLinkUrl(current.getAttributes("link").href || "");
    setLinkOpen(true);
  };

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    insertHtml: (html: string) => { editor?.chain().focus().insertContent(html).run(); },
  }), [editor]);

  function applyLink(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const url = normalizeLinkUrl(linkUrl);
    let chain = editor.chain().focus();
    if (linkRange.current) chain = chain.setTextSelection(linkRange.current);
    if (!url) chain.extendMarkRange("link").unsetLink().run();
    else chain.extendMarkRange("link").setLink({ href: url }).run();
    setLinkOpen(false);
  }

  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const tool = (label: string, shortcut: string, active: boolean, run: () => void, icon: ReactNode) => (
    <button type="button" className="fx-body__tool" aria-label={label} aria-pressed={active} title={`${label} (${shortcut})`} onMouseDown={(event) => event.preventDefault()} onClick={run}>
      {icon}
    </button>
  );

  return (
    <div className="fx-body">
      <div className="fx-body__bar" role="toolbar" aria-label="Formatting">
        {templates.length ? (
          <select className="fx-select fx-body__template" aria-label="Template" value={templateId} onChange={(event) => onTemplateSelect(event.target.value)}>
            {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
          </select>
        ) : null}
        {mergeFields.length ? (
          <Menu
            label="Insert field"
            align="start"
            items={mergeFields.map((field) => ({
              label: field.value ? `${field.label} · ${field.value}` : `${field.label} · filled when sent`,
              onSelect: () => editor?.chain().focus()
                .insertContent(`<span data-merge="${escapeHtml(field.key)}">${escapeHtml(field.value || `[${field.label}]`)}</span> `)
                .run(),
            }))}
            trigger={(props) => (
              <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" {...props}><Braces aria-hidden />Insert field</button>
            )}
          />
        ) : null}
        <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={onInsertSignature}><Signature aria-hidden />Signature</button>
        <span className="fx-body__sep" aria-hidden />
        {tool("Bold", `${mod}B`, Boolean(editor?.isActive("bold")), () => editor?.chain().focus().toggleBold().run(), <Bold aria-hidden />)}
        {tool("Italic", `${mod}I`, Boolean(editor?.isActive("italic")), () => editor?.chain().focus().toggleItalic().run(), <Italic aria-hidden />)}
        {tool("Underline", `${mod}U`, Boolean(editor?.isActive("underline")), () => editor?.chain().focus().toggleUnderline().run(), <UnderlineIcon aria-hidden />)}
        {tool("Bulleted list", `${mod}Shift+8`, Boolean(editor?.isActive("bulletList")), () => editor?.chain().focus().toggleBulletList().run(), <List aria-hidden />)}
        {tool("Numbered list", `${mod}Shift+7`, Boolean(editor?.isActive("orderedList")), () => editor?.chain().focus().toggleOrderedList().run(), <ListOrdered aria-hidden />)}
        {tool("Link", `${mod}K`, Boolean(editor?.isActive("link")), () => editor && openLinkRef.current(editor), <LinkIcon aria-hidden />)}
        {toolbarEnd}
      </div>
      {linkOpen ? (
        <form className="fx-body__link" onSubmit={applyLink} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setLinkOpen(false); editor?.commands.focus(); } }}>
          <input className="fx-input" aria-label="Link address" placeholder="https://" autoFocus value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} />
          <button type="submit" className="fx-btn fx-btn--sm">{linkUrl.trim() ? "Apply" : "Remove link"}</button>
          <button type="button" className="fx-btn fx-btn--ghost fx-btn--sm" onClick={() => setLinkOpen(false)}>Cancel</button>
        </form>
      ) : null}
      <EditorContent editor={editor} className="fx-body__content" />
    </div>
  );
});
