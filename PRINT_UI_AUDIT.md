# Member printing UI/UX audit

Date: 9 October 2026. Scope: member editor, print action and generated A4 form. Method: Impeccable technical audit, source review, and one bounded visual comparison of synthetic two-page and three-page PDFs against the supplied references. This is not a full accessibility certification or a live database test.

## Audit health

| Dimension | Score / 4 | Evidence |
| --- | ---: | --- |
| Accessibility | 3 | The editor uses labelled fields and a native modal; mobile print-row actions now have 44 px targets. A live keyboard and screen-reader pass remains useful. |
| Performance | 3 | PDF generation is capped at two concurrent Chromium jobs; the print layout uses one table and an embedded logo. Chromium still starts per request. |
| Responsive design | 3 | The drawer and field grid adapt at mobile widths; the records table has a scroll container. The family editor has not been checked against every device and text scale. |
| Theming | 4 | New editor styling uses existing color tokens. The printed form deliberately follows the supplied light PDF layout. |
| Implementation integrity | 3 | The print form maps saved fields to reference labels and repeats its title on later pages. PDF file-name rows are plain text because no document file is stored or linked for them. |
| **Total** | **16 / 20** | **Good, within the audited scope** |

The print flow has a coherent, task-specific system: the saved member record is the source, the editor exposes data required by the form, and the printed layout follows the reference hierarchy. Impeccable's mechanical detector returned no findings for the changed React and CSS files.

## Verified findings and changes

| Severity | Finding and impact | Resolution |
| --- | --- | --- |
| P1 | Family data existed in the database but could not be edited or saved; the three-page family form could not be generated through the current UI. | Added family-member editor fields, validation, persistence and variable-length PDF rows. |
| P1 | The document rows previously showed a hyphen when no choice was saved, which did not match the requested form. | Both document rows now show “Other identity documents” for the member and each family member, as requested. |
| P2 | Print layout had a fixed second page and omitted optional phone, photo and family rows. | Rebuilt it as an A4 table with a repeating title. Synthetic short and family examples render to two and three pages respectively. |
| P2 | The title's card box and date header were empty. | Strip the `MRO-` prefix from the saved card number for the right box; print only the Kuala Lumpur date as `mm/dd/yyyy` at the upper left. |
| P2 | Member row icon buttons were 31 × 31 px on phones. | Set them to 44 × 44 px under 620 px. |
| P2 | The drawer's preview action could suggest it included unsaved edits. | Renamed it “Preview saved form” and clarified its tooltip. |

## Remaining limitations

- The supplied PDFs show clickable uploaded-document links. The registry stores a member photo, but it has no general document storage for the other rows; entered document file names therefore print as text. No link to a nonexistent file is fabricated.
- The end-to-end PostgreSQL API suites require an explicit disposable `MRO_TEST_DATABASE_URL` and were skipped in this environment. Source-level tests, the production build, and local Chromium PDF renders passed.

## Verification

- `npm test`: 23 passed, 0 failed, 2 database suites skipped.
- `npm run build`: passed.
- `git diff --check`: passed.
- Impeccable detector on changed React and CSS: `[]`.
- Chromium render: A4, two pages for the short case and three pages for the family case; date, card number, repeated title, and final consent block visually inspected.
