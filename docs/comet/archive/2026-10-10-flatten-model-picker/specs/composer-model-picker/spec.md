# Composer model selection

English | [中文](spec.zh.md)

## Trigger and panel

Ordinary sessions that permit model selection show a composer toolbar control containing the Host-reported model name and applicable reasoning effort. Opening it shows the model list directly in one panel. Unavailable and locked controls continue to respect their session’s existing constraints.

## Model list

Models are grouped by provider in directory order. Each option has an accessible name and checked state; a checkmark identifies the current model. Long lists scroll and long names do not overflow the viewport. This interface adds neither model search nor recommendations.

## Reasoning effort

When the current model supplies reasoning metadata, its advertised efforts appear below the model list with a separator and Effort label. Options come only from that model’s provider metadata, preserving default semantics; the existing Default option remains when the provider has no configured default effort. Models without reasoning metadata omit the section. The effort section and model list share one panel without a second navigation level.

## Selection and feedback

Choosing another model or effort uses the existing Host API. Successful selection updates the trigger, closes the panel, and restores trigger focus; selecting the current value only closes. Pending selections prevent duplicate submissions. Rejections retain the previous selection and provide the existing recoverable feedback. Persistence scope, default-model settings, and running-request semantics remain unchanged. `/model` keeps its interactions and shares the same directory.

## Loading and recovery

Opening the panel refreshes the directory and displays loading feedback in place. Catalog errors offer Retry; partial provider failures display their cause without hiding usable providers. An empty catalog shows an empty state. A missing catalog entry alone does not change the existing routability decision.

## Keyboard and layout

Arrow keys move among actionable options; Enter, Space, and the existing Tab gesture select. Escape, Shift+Tab, or an outside click closes the panel; keyboard dismissal restores trigger focus. Model and effort groups have accessible names, and checked states match the Host selection. The panel inherits light and dark themes and supports Chinese and English. Width constraints, scrolling, and wrapping keep options actionable at a 390px viewport.

## Verification and demonstration

Acceptance items live in the [brief](../../brief.md). Component tests cover selection and errors; browser regressions cover real Host selection and corresponding UI snapshots. Demonstrate this change’s actual build and provide a date-stamped GIF. Another checkout’s running instance or a static prototype cannot substitute for implementation evidence.
