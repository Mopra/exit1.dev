# exit1.dev — Design Manual

A short, practical guide for creating emails, ads, and other branded material.

---

## 1. Brand essentials

| | |
|---|---|
| **Name** | `exit1.dev` (always lowercase, always with `.dev`) |
| **Product** | Website & API uptime monitoring |
| **Audience** | Developers, DevOps, SaaS teams, agencies |
| **Positioning** | Fast, reliable, developer-first monitoring. No fluff. |
| **One-liner** | *Know the moment something goes wrong.* |
| **Tagline (CTA)** | *Stop discovering outages from your customers.* |

**Writing the name**
- ✅ `exit1.dev`, `exit1`
- ❌ `Exit1.dev`, `EXIT1`, `Exit One`, `exit-1.dev`

---

## 2. Logo

The logo is a white rounded square with a black `e_` mark (the `_` evokes a terminal cursor — developer feel).

**Files:** `public/e_.svg` (favicon/logomark).

**Usage rules**
- Keep clear space around the mark = 25% of its height.
- Never stretch, rotate, recolor, or add effects.
- On dark backgrounds → use the default white-square mark.
- On light backgrounds → use an inverted (black square / white mark) version when contrast drops.
- Minimum size: 24×24 px digital, 10 mm print.

---

## 3. Colors

The brand is **dark-only** in the app — `:root` light tokens exist in `src/style.css` but are dead code. Marketing material may use light, but treat the dark canvas as the default surface.

All colors are defined as CSS tokens in [src/style.css](src/style.css) under `:root` (light, unused) and `.dark` (active). Edit values there to re-skin the entire app — components reference tokens via Tailwind utilities (`bg-primary`, `bg-success`, `bg-tier-nano`, `bg-folder-blue`, `bg-stage-tls`, etc.).

### Primary palette

| Role | Token | OKLCH (dark) | Hex ≈ | Use |
|---|---|---|---|---|
| **Canvas** | `--background` / `--sidebar` | `oklch(0.20 0.014 285)` | `#15151B` | Page background. Subtle blue-violet tint. |
| **Foreground** | `--foreground` | `oklch(0.985 0 0)` | `#FAFAFA` | Body text on canvas |
| **Primary** (brand accent) | `--primary` / `--ring` | `oklch(0.585 0.102 167)` | `#3F9081` | CTAs, focus rings, links, scrollbars |
| **Primary FG** | `--primary-foreground` | `oklch(0 0 0)` | `#000000` | Text on primary fills |

The brand accent is a desaturated **muted teal-green** (hue 167). It replaces the prior Sky Blue. There is no longer a separate light-mode accent — `--primary` is shared across both palettes.

### Surface elevation

Surfaces are stacked by lightness around the canvas. The deltas are deliberate — keep them when introducing new surfaces.

| Token | OKLCH | Purpose |
|---|---|---|
| `--popover` / `--surface-dark` | `oklch(0.155 0.014 285)` | Recessed: popovers, tooltip wells (≈ −0.045 from canvas) |
| `--background` | `oklch(0.20 0.014 285)` | Canvas (baseline) |
| `--card` / `--secondary` / `--sidebar` | `oklch(0.235 0.014 285)` | Elevated panels (+0.035) |
| `--muted` | `oklch(0.278 0.014 285)` | Subtle wells inside cards (+0.078) |
| `--accent` | `oklch(0.3715 0 0)` | Hover surface, selected nav row |
| `--border` | `oklch(0.2768 0 0)` | All hairlines |

Use the theme's `--shadow-sm/md/lg/xl/2xl` tokens to model elevation — never invent custom shadows. Decorative glows are forbidden (see §5).

### Semantic status

| Token | Hue | Use |
|---|---|---|
| `--success` | green 152 | Healthy / up |
| `--warning` | amber 80 | Degraded / SSL expiring |
| `--destructive` | red 22 | Down / errors / urgent |
| `--info` (= `--primary`) | teal-green 167 | Neutral info |

Status colors are reserved for status. Never use them as decoration.

### Categorical accents

These exist as full token sets for specific consumers — don't reuse them outside their intended slot.

- **Tier accents** (`--tier-nano` violet, `--tier-pro` amber, `--tier-agency` teal-green): subscription badges and the founders glow.
- **Folder colors** (`--folder-blue`, `-emerald`, `-amber`, `-rose`, `-violet`, `-slate`): user-assigned folder accents.
- **HTTP timing stages** (`--stage-dns`, `-connect`, `-tls`, `-ttfb`): Logs page request-timing labels.
- **Pixel-card variants** (`--pixel-{default|blue|yellow|pink}-{1|2|3}`): three-stop fills for marketing/empty-state pixel art.
- **Aurora** (`--aurora-{1..4}`, `-glow`, `-ring-{outer|inner}`): premium glow card hues. Currently disabled by flat-mode (§5).

### Usage rules

- **One accent per layout.** Don't pair `--primary` with a folder/tier/stage color as co-heroes.
- **Body text contrast** must hit WCAG AA (4.5:1). `--foreground` on `--background` ✅. Avoid mid-grey on canvas.
- **Charts** use `--chart-1..5` (a blue ramp for series) — not status or folder tokens.

---

## 4. Typography

| Family | Token | Use |
|---|---|---|
| **Albert Sans** | `--font-sans` | All UI and body copy. Loaded in [index.html](index.html) at weights 400/500/600/700. |
| **DM Serif Display** | `--font-serif` | Display / hero headlines only. Use sparingly. |
| **System monospace** | `--font-mono` | Code, IDs, request timing |

Inter is preloaded for legacy/marketing material but is **not** the app typeface anymore.

### Scale

| Use | Weight | Size (email/web) |
|---|---|---|
| Hero / H1 | 700 Bold (Albert Sans) or DM Serif Display | 32–48 px |
| Section / H2 | 600 Semibold | 22–28 px |
| Subhead / H3 | 500 Medium | 16–18 px |
| Body | 400 Regular | 15–16 px |
| Small / caption | 400 Regular | 12–13 px |
| Code / mono | system mono | inline snippets only |

### Rules

- **Letter spacing** is `-0.01em` globally (`--tracking-normal`). Tighter than browser default — preserves the "compact" feel. Don't override per element.
- **Line height:** 1.5 for body, 1.2 for headlines.
- **Spacing scale** is `0.26rem` (`--spacing`), slightly tighter than Tailwind's default 0.25. New components inherit this — don't hard-code px gaps.
- **Radius** is `0.5rem` (`--radius`). Tailwind utilities `rounded-sm/md/lg/xl` resolve to `radius − 4 / − 2 / radius / + 4`. Don't introduce arbitrary radii.
- Never use more than 2 weights in one piece of material.
- Never italicize body copy for emphasis — use **bold** instead.

---

## 4a. Flat-mode philosophy

The app ships with **flat-mode overrides** at the bottom of [src/style.css](src/style.css) that strip every gradient, glow, halo, ping ripple, blur halo, and aurora effect — without touching component code. Elevation is communicated through surface lightness deltas + shadow tokens, never through colored glow.

When designing new components:
- **Do not** add `bg-gradient-*`, `bg-radial-*`, custom `box-shadow: 0 0 …` halos, `animate-ping`, `blur-2xl` decorative spots, or inline gradient `style` attrs. The override block will silently kill them.
- **Do** use `bg-card` / `bg-secondary` / `bg-muted` to elevate, `border` for hairlines, and the preset `shadow-sm/md/lg` utilities for depth.
- Aurora effects exist in CSS but are hidden — comment out the flat-mode block in `src/style.css` to bring them back for marketing screenshots.

This is a deliberate design choice: the product reads as a **calm, instrument-panel UI**, not a glowing dashboard demo.

---

## 5. Voice & tone

We talk like a senior engineer who respects your time.

**Voice traits**
- Direct. Short sentences.
- Confident, never cocky.
- Technical when it adds precision — never as jargon theater.
- Slightly dry. Zero hype.

**Tone shifts by context**

| Context | Tone |
|---|---|
| Outage alert email | Urgent, factual, minimal |
| Feature announcement | Clear, benefit-first |
| Ad / social | Sharp, one idea, one CTA |
| Onboarding / welcome | Warm but brief |
| Status page copy | Neutral, transparent |

### Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| "Your API is down." | "We are currently experiencing service interruptions affecting your API endpoint." |
| "Know in 15 seconds." | "Industry-leading detection speeds." |
| "Set up in 2 minutes." | "Seamless, streamlined onboarding experience." |
| "SSL expires in 7 days." | "Your certificate is about to reach the end of its validity period." |

**Banned words:** *seamless, cutting-edge, revolutionary, game-changing, world-class, synergy, leverage, unlock, empower, best-in-class.*

---

## 6. Messaging pillars

Pick ONE per asset. Don't stack them.

1. **Speed** — "Detect outages in 15 seconds."
2. **Breadth** — "HTTP, API, SSL, domain, ping — one platform."
3. **Signal, not noise** — "Smart re-checks kill false alarms."
4. **Developer-first** — "REST API, MCP server, webhooks. Build on it."
5. **Transparency** — "Public status pages. Custom domain. Free tier."

---

## 7. Email guidelines

**Subject lines**
- Under 50 characters.
- Front-load the what: `🔴 example.com is down`, `SSL expires in 7 days — example.com`.
- No clickbait, no emoji spam (one status emoji max for alerts).

**Structure**
1. Single clear H1 (what happened / what's new).
2. One short paragraph (2–3 sentences).
3. One primary CTA button (Sky Blue).
4. Optional: one supporting detail block.
5. Footer: logo, unsubscribe, `exit1.dev`.

**Width:** 600 px max. **Background:** `#15151B` (canvas) or `#000000` (pure-black for legacy clients that mishandle near-black). **Body text:** `#FAFAFA`. **Accent/CTA:** `#3F9081` (the muted teal-green primary).

**Don't:** multi-column layouts, stock hero photography, drop shadows, decorative gradients or glows. Status pills (success/warning/destructive) are the only acceptable color accents beyond `--primary`.

---

## 8. Ad guidelines

**Formats:** LinkedIn, X, Google Display, developer newsletters.

**Rules**
- One headline. One sub. One CTA.
- Headline ≤ 8 words. Sub ≤ 15 words.
- Always include the logo + `exit1.dev`.
- Dark backgrounds outperform light in our category — default to black.
- Show the product (dashboard screenshot, status graph) when space allows — more effective than illustrations.

**Example**
> **Know before your customers do.**
> Uptime monitoring with 15-second detection.
> → **Start free at exit1.dev**

---

## 9. Imagery & graphics

- **Screenshots:** the real product, dark theme, no fake data that looks fake. Blur or anonymize customer URLs.
- **Illustrations:** minimal line art in brand colors. No 3D, no gradients, no emoji mascots.
- **Photography:** rarely. If used: muted, moody, infrastructure/server room feel. Never stock office handshakes.
- **Icons:** [Lucide](https://lucide.dev) icon set only (matches the app). 1.5 px stroke.
- **Charts:** use the `--chart-1..5` token ramp (a blue-leaning sequence) for series, in token order. Status charts use `--success` / `--warning` / `--destructive` for healthy / degraded / down respectively.

---

## 10. Legal / footer boilerplate

```
exit1.dev — Uptime monitoring for teams that ship.
© [year] exit1.dev. All rights reserved.
```

Links to include in emails: `Dashboard` · `Docs` · `Status` · `Unsubscribe`.

**URLs**
- App: `app.exit1.dev`
- Docs: `docs.exit1.dev`
- Marketing: `exit1.dev`

---

## 11. Quick checklist before sending

- [ ] Brand name lowercase (`exit1.dev`)
- [ ] Only theme tokens used — no off-palette colors, no decorative glows or gradients
- [ ] Albert Sans for UI/body; DM Serif Display only for hero display (max 2 weights per piece)
- [ ] One CTA, one message
- [ ] Copy reads aloud in under 20 seconds
- [ ] No banned words
- [ ] Dark canvas (`#15151B`) unless there's a specific reason to go light
- [ ] Status colors used only for status, never decoration
- [ ] Logo has clear space
- [ ] Footer + unsubscribe present (for email)
