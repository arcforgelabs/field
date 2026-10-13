// The Connect Xero wizard's data and rules, apart from its components.
//
// SECRET_HOSTS: where FIELD_SECRETS_KEY goes, per host (step 3). A small
// list, so another host is one more entry: an id, a label, an icon, the path
// through its screens, the steps, and a prompt an assistant can follow. A
// prompt names the secret, never its value: the owner pastes the key
// themselves. No vendor logos: the repository has no licensed mark for them,
// so each host gets a neutral icon and its name.
import { Cloud, Server, type LucideIcon } from "lucide-react";
import type { XeroIntegration } from "@/lib/types";

export const SECRET_NAME = "FIELD_SECRETS_KEY";

/** Set on <html> while a key is on screen: hides Sentry's "Report a problem" button (its screenshot could show the key). */
export const SECRET_ON_SCREEN = "data-field-secret-on-screen";

export type WizardStep = 1 | 2 | 3 | 4;

export interface SecretHost {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** The screens to open, in order, drawn as a light path. */
  path?: string[];
  /** Numbered steps. `{name}` shows the secret's name with a Copy button. */
  steps: string[];
  /** What "Copy setup prompt" copies. Never the key. */
  prompt: string;
}

const NO_VALUE = "I will paste its value myself. Do not make up, generate or print a value.";

export const SECRET_HOSTS: SecretHost[] = [
  {
    id: "replit",
    label: "Replit",
    Icon: Cloud,
    path: ["Publishing", "Adjust settings", "Production app secrets", "Add deployment secret"],
    steps: [
      "In Replit, open Publishing, then Adjust settings, then Production app secrets.",
      "Press Add deployment secret. Name: {name}",
      "Paste the key as its value.",
      "Press Republish.",
    ],
    prompt: `In this Replit project, add a production deployment secret named ${SECRET_NAME} (Publishing, Adjust settings, Production app secrets, Add deployment secret). ${NO_VALUE} Then republish the app.`,
  },
  {
    id: "other",
    label: "Other host",
    Icon: Server,
    steps: ["Save this as the environment variable {name} wherever your Field server keeps its secrets, then restart Field."],
    prompt: `On the server that runs Field, add an environment variable named ${SECRET_NAME} where Field's other secrets are kept. ${NO_VALUE} Then restart Field.`,
  },
];

/** Where the wizard resumes, from what the server says. */
export function resumeStep(data: XeroIntegration): WizardStep {
  const status = data.connection.status;
  if (status === "connected" || status === "choose_organisation") return 4;
  const setup = data.setup;
  if (setup?.pending) return 3;
  const keyReady = data.secretsKey.configured;
  if (data.credentials.source && keyReady) return 4;
  if (data.credentials.environmentOverride) return setup?.step ? (keyReady ? 4 : 3) : 1;
  if (setup?.step) return 2;
  return 1;
}
