// The lead design directions and Field's original look: each a theme family
// with its own sidebar, elevation and corners (components/shell/ui.css, "Directions").
// Settings › Appearance lists them first (with their tag and sidebar in the
// preview) and ⌘K can switch between them.
export interface Direction {
  family: string;
  name: string;
  tag: string;
  blurb: string;
  /** Sidebar, canvas and accent, for the picker's preview. */
  swatch: [string, string, string];
}

export const DIRECTIONS: Direction[] = [
  { family: "beacon", name: "Beacon", tag: "Maximum contrast", blurb: "White or black, amber accent, AAA contrast, Atkinson Hyperlegible", swatch: ["#ffffff", "#ffffff", "#6e4a00"] },
  { family: "claw", name: "Claw", tag: "OpenClaw default", blurb: "Graphite sidebar, warm red, Instrument Sans", swatch: ["#12141a", "#faf9f7", "#bd4531"] },
  { family: "tide", name: "Tide", tag: "Calm", blurb: "White surfaces, slate type, teal-blue, IBM Plex Sans", swatch: ["#f7f9fb", "#ffffff", "#1f6f8f"] },
  { family: "knot", name: "Knot", tag: "Precision", blurb: "Hairlines, no shadows, black and red, Geist", swatch: ["#ffffff", "#f9f9fb", "#c41e30"] },
  { family: "dash", name: "Dash", tag: "Earth", blurb: "Clay sidebar, sand canvas, soft cards, DM Sans", swatch: ["#2b1f17", "#f7f2ec", "#8a512c"] },
  { family: "field", name: "Site", tag: "Original", blurb: "Field's original look: paper, ink and yellow, square corners", swatch: ["#11110d", "#f5f3eb", "#f4c518"] },
];
