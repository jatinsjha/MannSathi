# MannSathi — AI Student Well-being Companion

MannSathi is an AI-powered student well-being companion designed to help students navigate academic stress, assignment pressure, exam preparation, and everyday challenges.

Built with a simple web interface and the Google Gemini API, MannSathi encourages students to express what is on their mind and offers concise, practical suggestions to help them take the next step.

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

Create a `.env` file in the project root:

```dotenv
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.5-flash-lite
```

Replace the placeholder with your own API key.

**Never commit `.env`, `.env.local`, or API keys to GitHub.**

### 5. Run Locally

```bash
python local_test.py
```

Open http://127.0.0.1:8000 in your browser.

## Deployment

MannSathi is deployed on Vercel.

To deploy your own instance:

1. Import or deploy the repository through Vercel.
2. Configure `GEMINI_API_KEY` and `GEMINI_MODEL` in the project's Environment Variables.
3. Deploy the project and test both the homepage and `/api/chat`.

The exact Vercel configuration must match the files in this repository.

## Project Structure

```text
MannSathi/
├── api/
│   └── chat.py
├── index.html
├── style.css
├── script.js
├── local_test.py
├── requirements.txt
├── pyproject.toml
├── vercel.json
├── .python-version
├── .gitignore
└── README.md
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