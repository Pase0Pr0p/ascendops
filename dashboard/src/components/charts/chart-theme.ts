/**
 * Agentic PM Dashboard - Chart theme configuration.
 * Brand blue/teal palette for all Recharts components.
 * (Constant names keep the historical CHART_GOLD_* identifiers to avoid churn
 *  across importers; their values are now the Agentic PM brand blues.)
 */

// -- Color palette --

export const CHART_GOLD = '#2b7bff';       // brand blue (primary accent)
export const CHART_GOLD_LIGHT = '#60a5fa'; // light blue
export const CHART_GOLD_DARK = '#1d4ed8';  // deep blue
export const CHART_GOLD_MUTED = 'rgba(43, 123, 255, 0.15)';

export const CHART_COLORS = [
  '#2b7bff', // brand blue (primary)
  '#1d4ed8', // deep blue
  '#0ea5e9', // sky
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#60a5fa', // light blue
] as const;

// -- Model-specific colors (for cost charts) --

export const MODEL_COLORS: Record<string, string> = {
  opus: '#2b7bff',
  sonnet: '#0ea5e9',
  haiku: '#14b8a6',
};

// -- Severity colors (semantic — status meaning, not brand palette) --

export const SEVERITY_COLORS: Record<string, string> = {
  info: '#2b7bff',
  warning: '#f59e0b',
  error: '#EF4444',
};

// -- Recharts default props --

export const AXIS_STYLE = {
  fontSize: 11,
  fill: 'hsl(var(--muted-foreground))',
  tickLine: false,
  axisLine: false,
} as const;

export const GRID_STYLE = {
  strokeDasharray: '3 3',
  stroke: 'hsl(var(--border))',
  strokeOpacity: 0.5,
} as const;

export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 12,
    padding: '8px 12px',
    color: 'hsl(var(--foreground))',
  },
  labelStyle: {
    color: 'hsl(var(--foreground))',
    fontSize: 11,
    fontWeight: 500,
    marginBottom: 4,
  },
  itemStyle: {
    color: 'hsl(var(--foreground))',
  },
} as const;

// -- Helper functions --

/** Get a color by index, cycling through CHART_COLORS */
export function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** Get a model color with fallback */
export function getModelColor(model: string): string {
  const key = model.toLowerCase();
  for (const [name, color] of Object.entries(MODEL_COLORS)) {
    if (key.includes(name)) return color;
  }
  return CHART_COLORS[0];
}

/** Generate a gradient ID for an area chart */
export function gradientId(prefix: string, index: number = 0): string {
  return `${prefix}-gradient-${index}`;
}
