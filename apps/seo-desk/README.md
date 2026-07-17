# ASAP Dashboard

A centralized, web-based script execution dashboard for managing SEO automation across 600+ global supplier and distributor websites. Built for a team of 30+ members to run Python scripts without touching a terminal.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Scripts Reference](#scripts-reference)
- [User Roles](#user-roles)
- [Google API Setup](#google-api-setup)
- [Adding a New Script](#adding-a-new-script)
- [Deployment](#deployment)
- [Contributing](#contributing)

---

## Overview

The ASAP Dashboard replaces manual terminal-based script execution with a clean, GUI-driven interface. Team members log in, pick a script, fill in the required inputs, and hit **Run** — with live output streamed directly to their browser.

The project covers 600+ websites across four technical niches:
- ✈️ Aviation & Aerospace Parts
- 🔌 Electronic Components & Semiconductors
- 💻 IT Hardware & Networking
- 🪖 Military & Defense Parts

---

## Features

- 🔐 **Secure Authentication** — Email/password login with role-based access control
- ▶️ **One-Click Script Execution** — Run any script via a form-based UI, no terminal needed
- 📡 **Live Terminal Output** — Real-time stdout/stderr streaming via Server-Sent Events
- 📋 **Execution Logs** — Full audit trail of every script run, filterable by user, script, date, and status
- 👥 **User Management** — Admins can invite, deactivate, and manage team member roles
- ⚙️ **Settings & Credentials** — Securely manage Google API service account keys and property lists
- 📥 **CSV Exports** — Download URL lists and execution logs as CSV files

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), Tailwind CSS, shadcn/ui |
| Backend | Next.js API Routes |
| Script Runtime | Python 3 via `subprocess` |
| Database | MongoDB (Mongoose) |
| Authentication | NextAuth.js (JWT) |
| Real-time Output | Server-Sent Events (SSE) |
| Deployment | Vercel (frontend) + any VPS for Python runtime |

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.9+
- A [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (or local MongoDB instance)
- Google Cloud service account with required API access (see [Google API Setup](#google-api-setup))

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-org/asap-dashboard.git
cd asap-dashboard

# 2. Install Node dependencies
npm install

# 3. Install Python dependencies
pip install -r scripts/requirements.txt

# 4. Set up environment variables
cp .env.example .env.local
# Fill in your values in .env.local

# 5. Start the development server
npm run dev
```

The app will be available at `http://localhost:3000`.

---

## Environment Variables

Copy `.env.example` to `.env.local` and fill in all values before running the project.

```env
# MongoDB
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/asap-dashboard

# NextAuth
NEXTAUTH_SECRET=your_nextauth_secret
NEXTAUTH_URL=http://localhost:3000

# Google APIs
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json

# Python
PYTHON_EXECUTABLE=python3
```

> ⚠️ Never commit `.env.local` or your `service-account.json` to version control. Both are listed in `.gitignore`.

---

## Project Structure

```
asap-dashboard/
├── app/
│   ├── (auth)/
│   │   └── login/              # Login page
│   └── (dashboard)/
│       ├── page.tsx             # Home — overview & quick launch
│       ├── scripts/
│       │   ├── page.tsx         # All scripts listing
│       │   └── [slug]/          # Individual script execution page
│       ├── logs/
│       │   └── page.tsx         # Execution logs
│       ├── users/
│       │   └── page.tsx         # User management (Admin only)
│       └── settings/
│           └── page.tsx         # API credentials & property config
├── components/                  # Reusable UI components
│   ├── terminal-output.tsx      # Live streaming terminal panel
│   ├── script-card.tsx          # Script listing card
│   └── ...
├── lib/
│   ├── mongodb/                 # MongoDB client & Mongoose models
│   └── utils.ts
├── scripts/                     # Python scripts
│   ├── sitemap_scraper.py
│   ├── url_extractor.py
│   ├── url_indexer.py
│   ├── indexing_checker.py
│   ├── gsc_sitemap_submitter.py
│   ├── lastmod_updater.py
│   ├── sitemap_deleter.py
│   ├── ga4_reporter.py
│   └── requirements.txt
├── .env.example
├── .gitignore
└── README.md
```

---

## Scripts Reference

| # | Script | Input | Output |
|---|--------|-------|--------|
| 1 | **Sitemap Scraper** | Parent sitemap URL | List of child sitemap URLs |
| 2 | **URL Extractor** | Sitemap URL | Downloadable CSV of all page URLs |
| 3 | **URL Indexer** | CSV file or URL list | Submission status per URL via Google Indexing API |
| 4 | **Indexing Checker** | CSV file or URL list | Verdict + last crawl date per URL from GSC |
| 5 | **GSC Sitemap Submitter** | Sitemap URLs + GSC property | Bulk submission confirmation |
| 6 | **Lastmod Updater** | Sitemap URL or file path | Updated XML sitemap with today's `<lastmod>` |
| 7 | **Sitemap Deleter** | GSC property + sitemap list | Deletion confirmation per sitemap |
| 8 | **GA4 Reporter** | Date range + property list | Traffic data logged to Google Sheet |

### Swapping in Your Real Scripts

The `/scripts` directory ships with placeholder `.py` files that match the expected interface. To use your real scripts:

1. Replace the placeholder file with your actual script.
2. Ensure it uses `argparse` for inputs and prints output to `stdout`.
3. Exit with code `0` on success and a non-zero code on failure.
4. No other changes to the dashboard are needed.

---

## User Roles

| Permission | Member | Admin |
|---|---|---|
| Log in | ✅ | ✅ |
| Run scripts | ✅ | ✅ |
| View own execution logs | ✅ | ✅ |
| View all team logs | ❌ | ✅ |
| Manage users | ❌ | ✅ |
| Manage Google credentials | ❌ | ✅ |
| Manage GSC / GA4 properties | ❌ | ✅ |

---

## Google API Setup

Several scripts require access to Google APIs. Follow these steps:

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a project.
2. Enable the following APIs:
   - Google Indexing API
   - Google Search Console API
   - Google Analytics Data API (GA4)
   - Google Sheets API
3. Create a **Service Account** and download the `credentials.json` key file.
4. Grant the service account access to each GSC property and GA4 property it needs to read/write.
5. In the dashboard, go to **Settings → Google Credentials** and upload the JSON file (Admins only).

---

## Adding a New Script

1. Add your `.py` file to the `/scripts` directory with `argparse`-based inputs.
2. Register the script in `lib/scripts-config.ts` with its name, description, slug, and input schema.
3. The dashboard will automatically generate the input form and execution page.

---

## Deployment

### Frontend (Vercel)

```bash
# Push to GitHub, then connect your repo to Vercel
# Add all environment variables in the Vercel project settings
```

### Python Runtime

The Python scripts must run on a server with Python 3.9+ installed. If deploying to Vercel (serverless), you will need a separate lightweight server (e.g., a VPS, Railway, or Render instance) to handle script execution, with the Next.js API routes proxying execution requests to it.

A `docker-compose.yml` is included for running both services locally or on a VPS.

---

## Contributing

1. Create a new branch: `git checkout -b feature/your-feature-name`
2. Make your changes and commit: `git commit -m "feat: description"`
3. Push and open a Pull Request against `main`
4. Request review from an Admin before merging

---

> Built for the ASAP project — managing 600+ websites, millions of pages, one click at a time.
