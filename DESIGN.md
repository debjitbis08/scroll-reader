# Design System: High-End Editorial

## 1. Overview & Creative North Star

This design system serves both a dark and light mode, each with its own creative identity but sharing core principles. Both modes reject the frantic, dopamine-heavy patterns of modern social feeds in favor of the rhythmic, deliberate experience of a private library.

### Dark Mode — "The Digital Curator"
Built for the "focused intellect." It blends the prestige of high-end print editorial with the fluidity of modern web technology. Deep, ink-like charcoals form the environment while warm, organic parchment tones drive interaction.

### Light Mode — "The Scholarly Paper"
Moves beyond the "app" aesthetic to embrace the quiet authority of a high-end editorial publication. Inspired by the tactile quality of heavy-weight vellum, the precision of hot-metal typesetting, and the thoughtful white space of a literary journal.

### Shared Principles
The system breaks the "standard template" look through **Intentional Asymmetry**. Hero sections utilize wide-set headlines paired with tightly-focused body copy, creating a visual tension that demands attention. Elements should feel "placed" on the page rather than "slotted" into a framework. We treat whitespace not as empty room, but as a luxury material that gives the text room to breathe and settle.

## 2. Colors & Tonal Architecture

### Dark Mode — "Midnight Study"
Our palette is rooted in a high-contrast, ink-like aesthetic. We use deep charcoals for the environment and warm, organic parchment tones for interaction.

*   **Primary (`#c8c8b0` / `primary`):** A warm, desaturated parchment. Use for primary CTAs and key highlights to mimic the look of high-quality book paper.
*   **Surface (`#0e0e0e`):** The foundational ink black.

### Light Mode — "Ink & Vellum"
The palette is rooted in a creamy, paper-like foundation, using tonal shifts rather than lines to define structure.

*   **Primary (`#4d6328`):** A muted olive that conveys growth and stability. Use for high-impact actions.
*   **Secondary (`#5f5e5e`):** A sophisticated charcoal that serves as the "ink" of the system.
*   **Tertiary (`#70499e`):** A dusty plum used sparingly for highlights or intellectual "asides."
*   **Surface (`#fbfbe2`):** The creamy base canvas.

### Shared Color Rules

#### The "No-Line" Rule
Sectioning must never be achieved through 1px solid borders. Instead, define boundaries using background shifts. A `surface-container-low` section sitting on a `surface` background creates a sophisticated, architectural transition that feels more premium than a hard line.

#### Surface Hierarchy & Nesting
Treat the UI as a series of stacked sheets. Use the `surface-container` tiers (Lowest to Highest) to create "nested" depth.

*   **Dark example:** Place a `surface-container-highest` card within a `surface-container-low` feed. This creates a tactile, layered effect reminiscent of stacked documents.
*   **Light example:** Use `surface-container-lowest` (`#ffffff`) cards on a `surface-container-low` (`#f5f5dc`) section to create a soft lift.

#### Signature Textures
For primary CTAs, use a subtle linear gradient from `primary` to `primary-container`. This provides a "physical" quality to the button that a flat hex code cannot achieve — mimicking the way ink sits slightly unevenly on a textured surface.

*   **Dark:** Gradient from `primary` (`#c8c8b0`) to `primary-container` (`#474836`).
*   **Light:** Gradient from `primary` (`#4d6328`) to `primary-container` (`#657c3e`).

#### The "Glass & Gradient" Rule
To move beyond flat design, utilize Glassmorphism for floating UI (bottom navigation, upload modals, floating headers). Apply a semi-transparent surface color with a `backdrop-blur` effect to allow the content underneath to bleed through subtly.

## 3. Typography

The typography is the soul of this system. It is a dialogue between the traditional authority of the serif and the modern efficiency of the sans-serif.

*   **Display & Headlines (Newsreader):** Our serif face is used for high-level storytelling. It is elegant, slightly condensed, and carries the weight of a printed manuscript.
    *   *Usage:* Use `display-lg` (3.5rem) for hero statements and `headline-md` (1.75rem) for article titles. Increase letter-spacing slightly for display sizes to enhance the "luxury" feel.
*   **Body & UI (Inter):** Our sans-serif face is built for utility and legibility. It provides a clean, modern contrast to the expressive serifs.
    *   *Usage:* All functional UI — buttons, labels, navigation — should use `body-md` or `body-lg`. Use `label-md` (0.75rem) for technical data, chips, and small captions.
*   **Hierarchy as Identity:** Always lead with Newsreader for content-heavy sections. Inter should be reserved for the "machinery" of the site. By over-scaling headlines against modest body text, we create an authoritative, editorial "magazine" feel.

## 4. Elevation & Depth

We eschew traditional "box-shadows" in favor of **Tonal Layering**.

*   **The Layering Principle:** Depth is achieved by "stacking" surface tokens. A `surface-container-lowest` card on a `surface-container-low` background creates a soft, natural lift.
*   **Ambient Shadows:** If a floating element (context menu, dropdown, modal) requires a shadow, it must be extra-diffused.
    *   *Spec:* Blur: 24px–40px, Opacity: 6% of `on-surface`. The shadow color must be a tinted version of `on-surface` — never pure black — to mimic natural ambient light.
*   **The "Ghost Border" Fallback:** If a border is required for accessibility, use the `outline-variant` token at **20% opacity**. 100% opaque, high-contrast borders are strictly forbidden.
*   **Glassmorphism:** For top-level navigation and floating elements, use semi-transparent backgrounds with a heavy blur. This softens the edges of the UI and integrates it into the background.

## 5. Components

### Buttons
*   **Primary:** Background: `primary`, Text: `on-primary`. Roundedness: `DEFAULT` (0.25rem).
    *   *Dark:* `#c8c8b0` background, `#404130` text.
    *   *Light:* `#4d6328` background, `on-primary` text.
*   **Secondary/Ghost:** No background. `primary` text label with a ghost border that only appears on hover. On hover, apply a `surface-variant` background at 10% opacity.
*   **Tertiary:** Newsreader Italic text. This feels like a scholarly footnote and works beautifully for "Read More" or "Cancel."
*   **The Hosted Version CTA:** When emphasizing the web-hosted version, use a "glass" style button with a `primary` ghost border.

### Cards & Content Snippets
*   **Rule:** Forbid the use of divider lines between cards.
*   **Structure:** Use `spacing-8` (2.75rem) to separate cards in a feed. Each card should use `surface-container-high` to distinguish it from the `surface` background.
*   **Typography in Cards:** The card header should use `label-md` in `primary` color to categorize the content (e.g., "FLASHCARD" or "CONTRAST").
*   **Selection (Light):** For selected list items, shift the background to `primary-fixed` (`#d2eca2`) rather than adding a checkmark.

### Input Fields
*   **Style:** Minimalist. Only a bottom border using `outline-variant` at 40% opacity. When focused, the border transforms into a 1px solid `primary` line. Do not use four-sided boxes.
*   **Labels:** Use `label-sm` (Inter) consistently. Input text itself should be `body-lg` (Inter) for maximum clarity.

### Chips (Filters)
*   **Selected:** `primary-container` background with `on-primary-container` text.
*   **Unselected:** `surface-container-highest` background. No border.

### Specialized Component: The Marginalia (Light Mode)
Create a "Marginalia" component for side-notes or citations. Use `label-sm` in `secondary` color, positioned in the right-hand gutter, mimicking the notes a scholar would write in the margins of a manuscript.

## 6. Do's and Don'ts

### Do
*   **Do** use asymmetrical layouts. Align headlines to the left while keeping body text centered or offset to create visual interest.
*   **Do** use the full spacing scale. Generous margins (e.g., `spacing-12` or `spacing-16`) are essential for the "Premium Library" feel.
*   **Do** emphasize the "Web-Hosted" indicator using a `surface-bright` container with a subtle `primary` tint.
*   **Do** embrace Newsreader — let the serif font do the heavy lifting for the brand identity.
*   **Do** layer surfaces using the `surface-container` tiers to create hierarchy.

### Don't
*   **Don't** use standard "tech" gradients (blue to purple). If a gradient is used, it must be tonal (e.g., `surface` to `surface-container`).
*   **Don't** use pure white text (dark) or pure black text (light). Use `on-surface` — `#e7e5e5` in dark, `#1b1d0e` in light — to reduce eye strain and maintain the aged paper aesthetic.
*   **Don't** use sharp corners. Stick to `DEFAULT` (0.25rem) or `md` (0.375rem) roundedness. Avoid corners larger than 1rem — they feel too "bubbly" and tech-focused for this editorial system.
*   **Don't** use 1px solid borders for sectioning. It breaks the editorial illusion and makes the UI look like a generic dashboard.
