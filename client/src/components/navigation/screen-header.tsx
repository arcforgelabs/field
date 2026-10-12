import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { FieldLogo } from "@/components/field";

interface ScreenHeaderProps {
  title: string;
  topLabel?: string;
  /** Show the Field logo in the top row (the app's home screen). */
  brand?: boolean;
  section?: string;
  backLabel?: string;
  backTo?: string;
  onBack?: () => void;
  backDisabled?: boolean;
  actions?: ReactNode;
  style?: CSSProperties;
}

export function ScreenHeader({
  title,
  topLabel,
  brand = false,
  section,
  backLabel,
  backTo,
  onBack,
  backDisabled = false,
  actions,
  style,
}: ScreenHeaderProps) {
  const navigate = useNavigate();
  const showBack = Boolean(backLabel && (backTo || onBack));

  function handleBack() {
    if (backDisabled) return;
    if (onBack) {
      onBack();
      return;
    }
    if (backTo) navigate(backTo);
  }

  // The app shell's page header: a breadcrumb back to the parent screen,
  // the title, and the page's actions on the right.
  return (
    <header className="fx-ph" style={style}>
      <div className="fx-ph__stack">
        {showBack ? (
          <nav className="fx-crumb" aria-label="Breadcrumb">
            <a
              href={backTo ? `#${backTo}` : undefined}
              onClick={(event) => { event.preventDefault(); handleBack(); }}
              aria-disabled={backDisabled || undefined}
            >
              {backLabel}
            </a>
            <span aria-hidden>/</span>
          </nav>
        ) : brand ? (
          <FieldLogo size={22} />
        ) : topLabel ? (
          <div className="fx-crumb">{topLabel}</div>
        ) : null}
        <div className="fx-ph__line">
          <h1 className="fx-ph__title">{title}</h1>
          {section ? <span className="fx-status fx-status--draft">{section}</span> : null}
        </div>
      </div>
      <div className="fx-spacer" />
      {actions}
    </header>
  );
}
