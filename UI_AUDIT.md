# UI/UX audit and reference lock

Date: 3 October 2026. Scope: existing MRO operations UI, staff accounts, roles, account recovery, modal accessibility, asynchronous feedback.

## Brief and reference lock

Improve the operations portal for staff handling confidential records. Keep the existing `design-system.md` as the dominant build target: Inter/system sans, MRO red for primary actions, neutral bordered panels, compact identity rows, existing status colors, 6–8px controls, and dark-mode tokens. Borrow interaction structure only from references. No new decorative imagery or animation is needed for account administration.

Refero style searches for enterprise SaaS, structured Linear, Linear, and SaaS returned `NO_RESULTS`. The existing visual system and the Refero skill's `craft-details.md` therefore supply the visual direction; live screen research supplies workflow evidence.

## References inspected

- [Refero: Fingerprint team settings](https://refero.design/pages/936c3653-4aaf-4219-b990-502d0f01644d): reviewed full screen metadata; name/email search, permission filters, identity rows, explicit member states.
- [Refero: Exa team role selector](https://refero.design/pages/15eb7dae-d40a-4b5a-9ccf-334da3a7878f): reviewed full screen metadata; explanations beside role choices and contextual warnings for ownership-sensitive actions.
- [Mobbin: Customer.io team members](https://mobbin.com/screens/06b14703-2bc0-40a8-8627-86bed102ce2f): visually inspected returned screenshot; search above the table, name/email identity cells, account/workspace scope, pending invitation state, clear row actions.
- [Mobbin: Runway members](https://mobbin.com/screens/d89465ab-84d5-4e6b-ac21-e25d4e16351d): visually inspected returned screenshot; adjacent search and role filter, count above rows, pending marker beside identity, compact access column.
- [Mobbin: Sprig team settings](https://mobbin.com/screens/039ad393-b295-403a-8a08-d8fc8c7015af): visually inspected returned screenshot; focused member filter, a clear add-member action, and contextual edit/recovery actions in the row menu.
- [React Bits Pro: Application UI](https://pro.reactbits.dev/docs/app-ui): reviewed public catalog descriptions for Data Table, Filtering, Settings Form, App Dialog, and Empty State. Applied the compositional principle of keeping table controls, forms, feedback and overlays coherent with one system. No premium source code was accessed or copied.
- [Mobbin: team administration](https://help.mobbin.com/en/articles/692352): reviewed role-specific administration documentation as supporting workflow context.

## Decision ledger

| Decision | Source and bounded role | Reason |
| --- | --- | --- |
| Keep existing colors, typography and panel hierarchy | `design-system.md`, visual foundation | Preserve staff familiarity and dark-mode consistency. |
| Search by name/email, filter by role and sign-in status, show match counts | Fingerprint; Customer.io; Runway | Find staff quickly and distinguish inactive accounts from pending password changes. |
| Show role summary and exact permissions before saving | Exa; server role metadata | Make access consequences visible and eliminate duplicated permission policy. |
| Explain disabled self/admin actions in context | Exa; existing backend protections | Prevent lockouts and explain why an action is unavailable. |
| Keep password recovery contextual to an account | Sprig row actions; security brief | Make recovery discoverable without mixing it into role editing. |
| Native modal focus containment, Escape, restoration, background inertness | Refero craft guidance; browser dialog semantics | Support keyboard users consistently and prevent interaction behind dialogs. |
| Busy states and persistent inline form errors | Refero craft guidance | Prevent duplicate submissions and keep corrections within the relevant form. |
| Neutral role details and compact table controls | React Bits Pro public catalog; existing tokens | Add utility without introducing motion or a second design system. |

## Bugs found and fixes

- Account creation and record editors allowed repeated submissions. Added in-flight guards, disabled submit/close controls and persistent inline errors for staff, finance, carding, HR, member and import workflows.
- Staff search, role filtering and sign-in-state filtering were missing. Added them with match counts, reset actions, empty states and mobile account rows.
- Role explanations and editable fields depended on duplicated client policy. User management now consumes server role metadata and per-account capabilities, shows permission previews and explains protected accounts. The personal profile also shares the permission label vocabulary.
- User deletion only checked the typed email in the browser. The request now sends confirmation to the server, which validates it independently.
- Recovery required an outside intervention. Added the administrator password-reset flow, identifying the target and explaining session revocation and mandatory password replacement.
- Modals claimed dialog semantics without keyboard containment or focus restoration. Converted account, import, member, finance, carding and HR overlays to native modal dialogs; title focus avoids opening mobile keyboards, Escape closes idle dialogs, and the browser makes background content inert.
- Closed mobile navigation remained keyboard-focusable. The sidebar is now inert when closed on mobile, traps focus while open, supports Escape and a visible close control, and restores focus on close. Removed the nonfunctional notifications button.
- Older member-search responses could overwrite newer results. Added request sequencing and unmount invalidation. General resource loading now keeps the requested path associated with its data so switching reporting periods cannot display a prior period's values under the new filter.
- Finance/carding defaults were fixed at module load using UTC. New records now receive the current Kuala Lumpur date when opened; carding month and attendance date use the office timezone.
- Attendance presented a team roster to every role. The panel now requires workforce-view permission to match the API.
- Mutations now carry the required same-origin request header. Session expiration redirects to sign-in; mandatory password-change responses route to the password form. Wrong-current-password errors remain in the form rather than ending an otherwise valid session.
- Failed sign-out requests previously cleared local identity despite leaving the server session active. The UI now keeps the session and reports failure unless sign-out succeeds.
- The workspace showed a hardcoded weekday and offered a second clock-in after completing the day's shift. Weekday now uses Kuala Lumpur time; dashboard and attendance controls show a disabled “Shift complete” state after clock-out.

## Verification

- `npm run build` passed after the frontend changes.
- `git diff --check` passed for the edited frontend files.
- Parent browser QA passed the desktop and mobile staff directory, search, add-user modal, Escape and focus restoration. Rendered evidence: `audit-artifacts/users-desktop.jpg` and `audit-artifacts/users-mobile.jpg`.
- Both rendered screenshots were inspected against the visual lock: existing red actions, navy sidebar, neutral panels and identity rows are preserved; mobile controls stack and account rows fit the viewport.
- The parent audit runs isolated integration checks; see its final audit report for those results. Reference colors were not imported, premium components were not installed, and no live staff accounts were changed by this frontend work.

## Design hook follow-up

The seven reported entries reduced to four distinct findings: `src/App.css` and `src/app.css` refer to the same filesystem inode.

- Fixed the coverage-bar implementation: a full-width bar now uses a left-origin `scaleX` transition instead of animating width. Duration, easing, clamped visual fill and reduced-motion behavior are retained; no measured-jank claim is made.
- Preserved Inter as the documented operations type stack, Arial in the retired server's PDF template, and the documented 3px red destructive-dialog border with rounded modal corners.
- Recorded specific font-value/file exceptions and a border-rule exception scoped to the stylesheet in `.impeccable/config.json`. No whole-file or project-wide rule suppression was added.
- Production build and whitespace checks passed after this follow-up.
