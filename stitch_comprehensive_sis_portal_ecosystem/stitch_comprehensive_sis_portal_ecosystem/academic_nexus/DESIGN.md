---
name: Academic Nexus
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#45464d'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#76777d'
  outline-variant: '#c6c6cd'
  surface-tint: '#565e74'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#131b2e'
  on-primary-container: '#7c839b'
  inverse-primary: '#bec6e0'
  secondary: '#0051d5'
  on-secondary: '#ffffff'
  secondary-container: '#316bf3'
  on-secondary-container: '#fefcff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#191c1e'
  on-tertiary-container: '#818486'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dae2fd'
  primary-fixed-dim: '#bec6e0'
  on-primary-fixed: '#131b2e'
  on-primary-fixed-variant: '#3f465c'
  secondary-fixed: '#dbe1ff'
  secondary-fixed-dim: '#b4c5ff'
  on-secondary-fixed: '#00174b'
  on-secondary-fixed-variant: '#003ea8'
  tertiary-fixed: '#e0e3e5'
  tertiary-fixed-dim: '#c4c7c9'
  on-tertiary-fixed: '#191c1e'
  on-tertiary-fixed-variant: '#444749'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: '700'
    lineHeight: 44px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  headline-sm:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
  mono-sm:
    fontFamily: monospace
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  grid_columns: '12'
  gutter: 24px
  margin: 32px
---

## Brand & Style

This design system is engineered for the complex, multi-portal environment of a Student Information System. The brand personality is **authoritative, precise, and supportive**, bridging the gap between legacy institutional reliability and modern software efficiency. It targets three distinct user groups: administrators managing high-density data, educators tracking student progress, and students navigating their academic journey.

The design style is **Corporate / Modern** with a strong emphasis on **SaaS utility**. It prioritizes high information density without sacrificing clarity, using subtle tonal layering and a strict grid to maintain order across financial ledgers and academic logs. The emotional response should be one of "controlled transparency"—users should feel that even the most complex data is structured, secure, and actionable.

## Colors

The palette is anchored in **Deep Navy (#0F172A)** to convey institutional stability and "The Blue Chip" authority. **Professional Blue (#2563EB)** serves as the primary action color, providing a clear signal for interactive elements and primary workflows.

The neutral scale is expansive, moving from **Clean White** to **Slate Grays**, ensuring that data-heavy tables remain legible. Semantic colors are used with high intentionality: **Success Green** for cleared financial status or passing grades, **Warning Amber** for at-risk academic indicators, and **Danger Red** for critical alerts such as overdue payments or emergency holds. Background surfaces utilize the tertiary off-white to reduce eye strain during prolonged administrative sessions.

## Typography

The typography system utilizes **Inter** for its exceptional legibility in digital interfaces and technical data. The hierarchy is designed for "scanability." 

- **Headlines:** Use tighter letter spacing and semi-bold weights to ground dashboard sections.
- **Body Text:** Standardized at 14px for the majority of data entries to maximize vertical density without compromising readability.
- **Labels:** Small, uppercase, and slightly tracked-out for metadata and table headers.
- **Mono:** Reserved for financial transaction IDs, student ID numbers, and ledger entries to ensure character alignment.
- **Mobile Adaption:** For screens under 768px, `display-lg` scales down to 28px, and `headline-lg` scales to 22px to prevent awkward text wrapping on KPIs.

## Layout & Spacing

This design system employs a **Fluid Grid** model with strict breakpoints to accommodate the diverse range of user hardware, from massive administrative monitors to student smartphones.

- **Desktop (1440px+):** A 12-column grid with 24px gutters. Side navigation is persistent (240px width). Content is centered with 32px margins.
- **Tablet (768px - 1024px):** Grid collapses to 8 columns. Margins reduce to 24px. Side navigation collapses into an icon-only rail or a hamburger menu.
- **Mobile (<768px):** A 4-column grid with 16px margins. Data tables reflow into card-based stacks to ensure all horizontal data remains accessible via vertical scrolling.

Spacing follows a 4px baseline. Components like data tables use "Compact" (8px) vertical padding, while landing pages and dashboard summaries use "Relaxed" (16px) padding to provide visual breathing room.

## Elevation & Depth

Visual hierarchy is established through **Tonal Layering** and **Low-Contrast Outlines**. Because the system is data-heavy, traditional heavy shadows are avoided to prevent visual "muddiness."

- **Level 0 (Base):** The primary canvas (Off-white/Tertiary).
- **Level 1 (Cards):** White surfaces with a 1px border (#E2E8F0) and a very subtle 2px blur shadow with 2% opacity. This is the primary container for KPIs and ledger entries.
- **Level 2 (Modals/Popovers):** Higher elevation with a 12px blur, 8% opacity shadow to focus the user on specific workflows like "Add Grade" or "Process Payment."
- **Focus States:** Active inputs and selected cards use a 2px blue ring (#2563EB) to provide immediate feedback in complex forms.

## Shapes

The shape language is **Soft (0.25rem)**. This subtle rounding provides a modern, approachable feel while maintaining a professional, geometric discipline. 

- **Standard Elements:** Buttons, input fields, and chips use a 4px (0.25rem) radius.
- **Containers:** Dashboard cards and large modals use 8px (0.5rem) to differentiate them from smaller interactive elements.
- **Status Indicators:** Small chips for "Paid," "Pending," or "Enrolled" use a full pill-shape (999px) to distinguish them from functional buttons.

## Components

### Buttons
- **Primary:** Solid Professional Blue with white text. High-contrast for "Submit" or "Approve."
- **Secondary:** Transparent with a 1px slate border. Used for "Cancel" or "Save Draft."
- **Ghost:** No border or background. Used for navigation within tables or secondary actions.

### Data Tables
- **Headers:** Slate background with uppercase label-md typography. Sticky positioning for long lists.
- **Rows:** Alternate zebra-striping (Level 0 and Level 1 colors) to assist eye-tracking across wide financial rows.
- **Cells:** Vertical alignment is centered. Financial values are right-aligned to a monospaced font.

### KPI Cards
- **Structure:** Bold headline-md for the metric, label-md for the description, and a small sparkline or percentage indicator using semantic colors.
- **Interaction:** Cards are hoverable with a slight border-color change to indicate they can be "drilled down" for more detail.

### Inputs & Forms
- **Validation:** Clear semantic borders (Red for error, Blue for focus). 
- **Labels:** Always positioned above the field for maximum accessibility. Helper text is provided in body-sm.

### Navigation
- **Portal Switcher:** A prominent dropdown at the top of the sidebar allows admins to toggle between Student, Faculty, and Financial views.
- **Breadcrumbs:** Persistent on all sub-pages to maintain orientation within deep academic hierarchies.