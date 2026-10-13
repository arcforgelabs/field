// Test fixtures for milestone rules (#29). Synthetic: never a customer's rules.

// The example the owner gave (docs/PRICING_ENGINE.md, "Invoices and
// payments"), entered as data: a deposit of at most $1,000 under a $20,000
// contract value, and at most 5 % from $20,000, both hard caps.
export const SA_RULES = [
  {
    name: "SA domestic, under $20,000",
    country: "AU",
    region: "SA",
    maxValue: 20000,
    note: "Building Work Contractors Regulations: deposit cap",
    milestones: [{ label: "Deposit", percentage: 5 }, { label: "Progress payment", percentage: 35 }, { label: "Final payment", percentage: 60 }],
    caps: [{ kind: "deposit", maxAmount: 1000, mode: "hard" }],
  },
  {
    name: "SA domestic, from $20,000",
    country: "AU",
    region: "SA",
    minValue: 20000,
    milestones: [{ label: "Deposit", percentage: 5 }, { label: "Progress payment", percentage: 35 }, { label: "Final payment", percentage: 60 }],
    caps: [{ kind: "deposit", maxPercent: 5, mode: "hard" }],
  },
];
