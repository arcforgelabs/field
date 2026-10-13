// The integrations Settings, Integrations lists. Each is one entry: an id, a
// name, a one-line description, a logo, where its status comes from, and what
// opens when someone picks it. A later integration is one more entry.
//
// The status is only whether it is connected (for the card's check) and
// whether this person may connect it (for the "+"). Never a credential or a
// key: those belong to the integration's own screen.
import type { ComponentType } from "react";
import { api } from "@/lib/api";
import { XeroMark } from "./integration-marks";
import { XeroPanel } from "./xero-panel";

export interface IntegrationStatus {
  connected: boolean;
  /** Whether this person may connect and configure it (owners). */
  canManage: boolean;
}

export interface IntegrationEntry {
  id: string;
  name: string;
  description: string;
  Logo: ComponentType;
  /** Where its status comes from. */
  loadStatus: () => Promise<IntegrationStatus>;
  /** What opens from its card: the connect wizard or its detail view. */
  View: ComponentType<{ onBack: () => void }>;
}

export const INTEGRATIONS: IntegrationEntry[] = [
  {
    id: "xero",
    name: "Xero",
    description: "Create a matching invoice in your Xero organisation for every invoice Field issues.",
    Logo: XeroMark,
    loadStatus: async () => {
      const status = await api.xeroIntegration();
      return { connected: status.connection.status === "connected", canManage: status.canManage };
    },
    View: XeroPanel,
  },
];
