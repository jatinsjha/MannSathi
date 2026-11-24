# MannSathi — AI Student Well-being Companion

MannSathi is an AI-powered student well-being companion designed to help students navigate academic stress, assignment pressure, exam preparation, and everyday challenges.

Built with a simple web interface and the Google Gemini API, MannSathi encourages students to express what is on their mind and offers concise, practical suggestions to help them take the next step.

The full-screen student workspace includes Smart Calendar and Task Manager, independently of Gemini. Task Manager supports personal tasks, teacher assignments to a class or individual student, private completion tracking and persistent assignment notifications. Students and teachers have separate sign-in pages with backend role verification. See [the Task Manager deployment and onboarding guide](docs/task-manager.md) and [the Calendar guide](docs/smart-calendar.md). Focus Room and Student Progress remain future modules.

Students can now save name, roll number, 25CS class and division A/B/C in Settings. Teachers review enrollment requests and assign work to all 25CS, one division or one student. The empty-roster error is explained and prevented. Existing installations need only migration 003 for this update; see [the student/division upgrade guide](docs/student-divisions.md).

**Live Demo:** https://mannsathi.vercel.app

## Features

- **AI-powered conversations:** Interact with an AI companion using the Gemini API.
- **Academic stress support:** Get practical suggestions for managing exam anxiety and study pressure.
- **Study guidance:** Break overwhelming tasks into smaller, manageable steps.
- **Concise responses:** Designed to provide simple, actionable suggestions.
- **English and Hinglish support:** Communicate naturally in English or Hinglish.
- **Responsive interface:** A clean, student-focused chat experience.
- **Conversation controls:** Start fresh and clear the current chat.
- **Safety-aware responses:** Encourages trusted human support when needed.

## Tech Stack

**Frontend**
- HTML5
- CSS3
- JavaScript

**Backend**
- Python
- Google GenAI Python SDK
- Google Gemini API

**Deployment**
- Vercel

## How It Works

1. A student enters a message in the chat interface.
2. The frontend sends the conversation to the Python backend.
3. The backend validates the request and sends it to the Gemini API.
4. Gemini generates a response based on MannSathi's instructions.
5. The backend returns the response to the frontend for display.

## Getting Started

### Prerequisites

- Python 3.12
- Node.js and npm are not required for the current static frontend.
- A Google Gemini API key
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/MannSathi.git
cd MannSathi
```

### 2. Create a Virtual Environment

**Windows PowerShell**

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
```

**Linux**

```bash
python3.12 -m venv .venv
source .venv/bin/activate
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure Environment Variables

Copy `.env.example` to `.env` in the project root and fill it in:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_publishable_or_anon_key
```

Replace the placeholder with your own API key.

Use only a Supabase publishable or legacy anon key as `SUPABASE_KEY`; `/api/config` rejects secret/service-role keys. Review the read-only schema findings and approve the proposed `database/migrations/000_profile_privileges.sql` (profile grants) and `database/migrations/001_smart_calendar.sql` (calendar) before applying them in that order. Rerun `database/inspect_calendar_schema.sql` if your schema has changed. See the calendar guide for constraints, policies, and two-account verification.

For this workspace the user confirmed 000/001 are already applied; do not rerun them. Task Manager needs the new `database/migrations/002_tasks_and_teachers.sql`, followed by administrator provisioning of the intended teachers and approved students. Public signup cannot grant teacher access. Add `/teacher-login.html` to Supabase Auth's allowed password-reset redirects. Migration 002 has been tested in a local ephemeral PostgreSQL engine and has not been applied to live Supabase by the agent.

**Never commit `.env`, `.env.local`, or API keys to GitHub.**

### 5. Run Locally

```bash
python local_test.py
```

Open http://127.0.0.1:8000 in your browser.

## Deployment

MannSathi is deployed on Vercel.

To deploy your own instance:

1. Import the repository through Vercel and keep the Root Directory set to the repository root.
2. Configure `GEMINI_API_KEY`, `GEMINI_MODEL`, `SUPABASE_URL`, and a publishable/anon `SUPABASE_KEY` in the project's Environment Variables.
3. Review/apply required migrations and provision the intended teacher/class memberships. Deploy role-checked login and `/api/tasks` together with migration 002. Test the homepage, `/teacher-login.html`, `/app.html`, `POST /api/chat`, and authenticated Calendar/Task CRUD.

Vercel serves the static pages and files directly and deploys the Python handlers at `/api/chat`, `/api/config`, `/api/calendar`, and `/api/tasks`; no frontend build or rewrite rules are introduced. Install the Python requirements, including IANA timezone data. Teacher and student login still use the same Supabase Auth service; database permissions determine access.

## Project Structure

```text
MannSathi/
├── api/
│   └── chat.py          # Gemini backend (Vercel Python function)
├── css/
│   ├── style.css        # chat app styles
│   ├── login.css
│   └── signup.css
├── js/
│   ├── app.js           # chat app logic
│   ├── login.js
│   └── signup.js
├── index.html           # login page (home)
├── signup.html
├── app.html             # chat app
├── local_test.py        # local dev server
├── requirements.txt
├── pyproject.toml
├── vercel.json
├── .env.example
├── .python-version
└── .gitignore
```

## Responsible Use

MannSathi is an AI support tool, not a therapist, doctor, or emergency service.

AI-generated responses may be inaccurate. Students experiencing persistent distress should consider contacting a trusted person or qualified professional. In India, emergency services can be reached at **112**.

Do not use MannSathi as a substitute for professional mental health care.

## Limitations

- Responses depend on the availability and performance of the Gemini API.
- API quotas and rate limits may affect availability.
- Internet connectivity is required for AI responses.
- Generated advice should be evaluated using personal judgment.

## Future Improvements

- Improve response latency and error handling.
- Add better loading and retry states.
- Introduce optional study-planning tools.
- Improve accessibility and mobile usability.
- Add automated tests for API and frontend behavior.

## License

This project is available under the MIT License. See [LICENSE](LICENSE) for details, if the license file is included.

## Author

**Jatin Jha**

GitHub: https://github.com/YOUR_GITHUB_USERNAME

Live Project: https://mannsathi.vercel.app

---

Built to make student support feel a little more approachable, one step at a time.
