# Homepage dashboard

The signed-in workspace opens on **My progress**, using the existing MannSathi appearance with mint, lilac, cream and rose accents. Teachers see **Class overview**. Chat, Tasks, Smart Calendar, Focus Room and Settings remain available in the sidebar, which can collapse to an icon rail on desktop and reopen from the top bar.

The dashboard reads the current account's saved data:

- Up to four active Focus Room subjects, with this week's recorded minutes compared with each optional weekly time goal. A goal ring measures recorded effort, not mastery; a subject without a goal shows a dash.
- Total recorded study hours and a chart of the last seven local dates. Empty dates are zero; failed requests show an unavailable state.
- Tasks grouped by completed, in progress and to do, plus the next three unfinished tasks sorted by deadline. Teachers see the completion of their assigned tasks across recipients.
- Up to four weekly subject goals, or teacher assignments with student completion counts.
- Personal calendar examinations and teacher-assigned exams over the next 30 days. Other calendar event categories stay in Calendar. The teacher **Schedule an exam** button opens Calendar's assignment form.

The dashboard requires no additional data tables of its own. Focus data requires the existing migration 004. Shared teacher exams require migration 005 and the same verified teacher/class permissions as assignments; see the exam setup notes in the Calendar guide.

Every source loads separately, so a failed study, task or exam request leaves the other sections usable. Retry refreshes the overview. Identity changes immediately clear rendered private data, and responses started under an earlier account are ignored. Opening the dashboard or returning to the tab refreshes its saved overview. Calendar writes also refresh a visible overview through the `mannsathi:calendar-changed` event.

Run `node tests/dashboard-browser.cjs` for isolated local fixtures that exercise the production workspace. The test checks real-shaped subject/task/exam data, request-range limits, source failures and retry, account changes, teacher and guest access, safe text, sidebar collapse and responsive dark/light layouts. Screenshots are saved under `.preview/dashboard-screenshots/` and are not committed.
