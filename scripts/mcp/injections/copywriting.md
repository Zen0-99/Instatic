---
id: copywriting
title: Copywriting & Content
keywords: copy, text, content, headline, subtitle, cta, call to action, writing, words, messaging, tagline, brand
summary: Headline/subtitle/CTA voice, brevity, concrete vs. filler text.
---

# Copywriting Guidance

## Principles

1. **Concrete over generic.** "Schedule posts across 12 platforms in one click" beats "Powerful social media management".
2. **Short.** Headlines: 4–8 words. Subtitles: 1–2 sentences. CTAs: 2–4 words.
3. **One idea per line.** Don't stack multiple value propositions into a single headline.
4. **Active voice.** "Launch your site in minutes" not "Your site can be launched in minutes".
5. **No filler.** Avoid words like "powerful", "seamless", "comprehensive", "robust", "cutting-edge". They mean nothing.

## Headline Patterns

- **Benefit + specificity**: "Ship a landing page in under 5 minutes"
- **Question**: "Still hand-coding your portfolio?"
- **Direct command**: "Stop wrestling with CSS frameworks"
- **Concrete outcome**: "From idea to live site in one conversation"

## Subtitle Patterns

- One sentence that expands the headline with a concrete detail.
- Avoid restating the headline in different words.

**Bad**: "Build beautiful websites with our powerful platform"
**Good**: "Describe what you want. The AI writes the HTML, CSS, and content."

## CTA Patterns

- 2–4 words, action-oriented: "Get started", "Try it free", "See examples", "Read the docs"
- Avoid: "Learn more", "Click here", "Submit" (too generic)

## What to Avoid

- **SaaS clichés**: "Build faster", "Ship with confidence", "Scale effortlessly"
- **Feature lists**: "10 powerful features" — pick one and explain it
- **Vague claims**: "Next-generation platform" — say what it actually does
- **Superlatives without proof**: "The best website builder" — show, don't claim
- **Lorem ipsum**: Write real copy. If you don't know the product, ask or infer from context.

## Workflow

1. Understand what the site/page is for (ask `cms_get_site` for site name, check page titles).
2. Write copy that fits the specific purpose — not generic marketing.
3. Insert via `insertHtml` or `replaceNodeHtml` with the real text.
4. Keep it minimal. A landing page with 3 sentences of great copy beats one with 3 paragraphs of filler.
