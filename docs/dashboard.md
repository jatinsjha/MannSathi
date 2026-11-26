# Homepage dashboard

The signed-in workspace opens on **My progress**, using quiet neutral surfaces and a restrained teal accent drawn from the existing MannSathi logo. Teachers see **Class overview**. Chat, Tasks, Smart Calendar, Focus Room and Settings remain available in the sidebar, which can collapse to an icon rail on desktop and reopen from the top bar.

The dashboard reads the current account's saved data:

- Up to four active Focus Room subjects, with this week's recorded minutes compared with each optional weekly time goal. A goal ring measures recorded effort, not mastery; a subject without a goal shows a dash.
- Total recorded study hours and a chart of the last seven local dates, with visible daily minute values. Empty dates are zero; failed requests show an unavailable state.
- Tasks grouped by completed, in progress and to do, plus the next three unfinished tasks sorted by deadline. Teachers see the completion of their assigned tasks across recipients.
- Up to four weekly subject goals, or teacher assignments with student completion counts.
- Personal calendar examinations and teacher-assigned exams over the next 30 days. Other calendar event categories stay in Calendar. The teacher **Schedule an exam** button opens Calendar's assignment form.

The dashboard requires no additional data tables of its own. Focus data requires the existing migration 004. Shared teacher exams require migration 005 and the same verified teacher/class permissions as assignments; see the exam setup notes in the Calendar guide.

Every source loads separately, so a failed study, task or exam request leaves the other sections usable. Retry refreshes the overview. Identity changes immediately clear rendered private data, and responses started under an earlier account are ignored. Opening the dashboard or returning to the tab refreshes its saved overview. Calendar writes also refresh a visible overview through the `mannsathi:calendar-changed` event.

Run `node tests/dashboard-browser.cjs` for isolated local fixtures that exercise the production workspace. The test checks real-shaped subject/task/exam data, request-range limits, source failures and retry, account changes, teacher and guest access, safe text, sidebar collapse and responsive dark/light layouts. Screenshots are saved under `.preview/dashboard-screenshots/` and are not committed.

## Dashboard UI review

The existing dashboard had competing pastel surfaces and background washes, supporting text as small as 7–10px, inconsistent spacing and corner radii, and viewport breakpoints that repeatedly changed the same grid. The approved direction is calm, thoughtful and reassuring: a student's study desk with neutral surfaces, actual progress carrying the color, and teal marking meaningful effort. The logo, DM Sans, feature names, section order and saved-data behavior are retained.

The Unslop passes were applied to the existing components:

1. **Spacing:** Consistent 12/16/20/24/32px spacing, compact subject cards, aligned goal and task rows.
2. **Color:** Scoped workspace neutrals in both themes, a restrained teal accent, stronger supporting-text and progress-graphic contrast.
3. **Icons:** Reused the existing line-icon set; removed decorative icon tiles and replaced the large exam illustration with the Calendar symbol. Refresh now has a refresh symbol.
4. **Copy:** Kept personal context and feature labels, shortened the greeting, removed punctuation from short headings, and clarified weekly goal markers.
5. **Type:** Retained DM Sans; raised body and metadata sizes, used size rather than heavy weight for hierarchy, and aligned tabular figures.
6. **Layout:** Container queries follow usable workspace width, including sidebar collapse. Date and task statuses remain visible on mobile, and long saved names wrap.
7. **Details:** Consistent 8px control and 12px card radii, quiet borders, thinner progress rings, daily chart values and readable task legends.
8. **Visuals:** Kept real subject goals, recorded study time and task completion as the visual emphasis. No generated images or new decorative assets.
9. **Motion:** Subtle palette transitions, visible keyboard focus, reduced-motion support and no animation of sidebar grid width.

Validation includes the dashboard and sidebar browser contracts, dark/light layouts from 320 to 1440px, expanded/collapsed navigation, keyboard focus, and long subject, task and profile names. Backend APIs, schemas, authentication and business logic are unchanged; JavaScript edits are confined to rendered text, icons and chart labels.

Remaining UI work: the inner Chat, Calendar, Tasks, Focus Room and Settings screens retain their existing component styles. Some still use small text, gradients or older control shapes. This pass improves their shared shell but does not redesign those screens. Mobile keeps all dashboard sections and therefore requires vertical scrolling.

Design process: **Unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0**.
