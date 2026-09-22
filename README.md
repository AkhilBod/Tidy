# tidy

Keeps a Mac organized. Deterministic rules decide everything they can; [Jev](https://docs.typesafe.ai) (TypeSafe AI's decision model) judges only what rules can't, and only from filenames and metadata. File contents never leave the machine.

Tidy never deletes. Anything it thinks is junk, duplicate, or unclear lands in a visible holding folder under `~/Tidy` for you to review. Every move is journaled and `tidy undo` puts it back.

## Install

```bash
git clone https://github.com/<you>/tidy && cd tidy
npm install
echo 'TYPESAFE_API_KEY=...' > ~/.config/tidy/env && chmod 600 ~/.config/tidy/env
bin/tidy init          # inspects your Mac, proposes a config, moves nothing
bin/tidy plan          # dry run
bin/tidy apply         # do it
bin/tidy agent install # keep it running (launchd)
bin/tidy ui            # the app: review the plan, undo, edit rules
```

Node 22.6+ (runs the TypeScript directly). macOS only. Put `bin/` on your PATH or `npm link`.

## What it does

| Clutter | Goes to |
|---|---|
| `Screenshot 2026-06-13….png`, screen recordings | `~/Pictures/Screenshots/2026-06`, `~/Movies/Recordings/2026-06` |
| Resumes, offer letters, cover letters, application exports | `~/Documents/Career/{Resumes,Offers,Cover Letters,Applications}` |
| Coursework: `CS1555_HW3.pdf`, `lab3-report.docx`, `Assignment 4.pdf` | `~/Documents/School/<Institution>/<Course>/Homework/HW3/` (code-heavy work under `~/Code/school/<Course>/`) |
| Lease, tax, bank, insurance paperwork | `~/Documents/Finance-Legal` |
| Datasets, installers, mail/Takeout exports | `~/Archive/{Datasets,Installers,Exports}` |
| Git repos and project folders | `~/Code/{personal,school,work,research,experiments,archive}/<slug>` |
| Exact duplicates (`file (1).pdf`, same hash) | `~/Tidy/Duplicates/<origin>/` |
| Installers for apps already installed, extracted zips, `__MACOSX`, empty folders, junk | `~/Tidy/Trash/<reason>/` |
| Low-confidence files from the inbox (Downloads) | `~/Tidy/Unsure/<origin>/` and `~/Tidy/Review.md` |

Different content with the same stem (`HW3.pdf` / `HW3-final.pdf`) is never touched: both go to review.

Thresholds: move at Jev confidence ≥ 0.8, park in Trash at ≥ 0.9, otherwise review. Everything is configurable.

## Commands

```
tidy init [--dry-run] [--force]   discover folders, repos, courses; write config + classes
tidy plan [--root DIR]...         dry run (--all shows skipped items)
tidy apply [--root DIR]...        move, journal
tidy undo [--last N|--since ISO|--all]
tidy repos [--apply]              project folders -> ~/Code buckets; --only PATH --bucket NAME --allow-dirty --no-symlink
tidy clean [--apply]              reclaimable storage report; --apply parks the safe tier in ~/Tidy/Trash/Reclaim
tidy ui [--port 4848]             local web app: plan + apply, activity + undo, rules, classes, structure, storage
tidy holding [--open]             sizes of Trash / Duplicates / Unsure
tidy links [--remove]             symlinks left at old repo paths
tidy resolve PATH --course CS1555 --type homework --assignment HW4 [--learn-prefix] [--learn-folder]
tidy class list|add|edit|remove|alias
tidy report                       weekly markdown report
tidy agent install|uninstall|status
tidy config
```

## Configuration

`~/.config/tidy/config.json` (created by `init`, merged over defaults in `src/config.ts`):

```json
{
  "roots": ["~/Desktop", "~/Downloads", "~/Documents", "~/Pictures", "~/Movies"],
  "inbox": { "roots": ["~/Downloads"], "graceDays": 0 },
  "destinations": { "code": "~/Code", "school": "~/Documents/School", "screenshots": "~/Pictures/Screenshots", "trash": "~/Tidy/Trash" },
  "thresholds": { "move": 0.8, "hold": 0.9 },
  "categories": { "career_resume": { "destination": "{career}/Resumes" } },
  "code": { "buckets": ["personal", "school", "work"], "containers": { "personal projects": "personal" } },
  "school": {
    "docsTemplate": "{school}/{institution}/{course}/{typeDir}/{assignment}",
    "codeTemplate": "{code}/school/{course}",
    "typeDirs": { "homework": "Homework", "lab": "Labs" }
  }
}
```

Templates use `{destinationKey}`, `{yyyy}`, `{mm}`, `{project}`, `{institution}`, `{course}`, `{typeDir}`, `{assignment}`. Empty variables collapse. Set a category's `destination` to `null` or `"enabled": false` to keep Tidy away from it. Add a folder name to `protected` and Tidy never enters or moves it.

## School

`~/.config/tidy/classes.json` is the course registry:

```json
{ "CS1555": { "institution": "University of Pittsburgh", "name": "Database Management Systems", "aliases": ["CS 1555", "database management systems"] } }
```

`init` proposes courses whose codes recur in your filenames (`CS1555`, `15-213`, `6.006`, `BIO101`…). Routing only ever targets registered courses, so a stray `IMG_1555.jpg` is never mistaken for a class.

A file is pinned to a course by, in order: its own name, its parent folder, agreement among its neighbours (`HW3.pdf` next to `cs1555-lecture7.pdf` and `CS 1555 schema.sql`), a learned rule, then Jev. Type (`homework`, `lab`, `lecture`, `exam`, `syllabus`, …) and assignment (`HW3`, `Lab4`, `Midterm`) come from the name. Files of one assignment from one folder stay together; an assignment folder moves whole.

When Tidy gets it wrong, teach it once:

```bash
tidy resolve ~/Tidy/Unsure/Downloads/hw4.pdf --course CS1555 --type homework --assignment HW4 --learn-prefix
```

The rule goes to `~/.config/tidy/learned.json` and beats every heuristic next time.

## Safety

- Top-level items only; Tidy never reaches inside folders except to summarize them.
- Skips: `~/Library`, `.app` bundles, Photos libraries, hidden dirs, `protected` names, files modified in the last 10 minutes, partial downloads, files another process has open.
- Repos move only when no process has its cwd inside, and (unless `--allow-dirty`) the tree is clean. HEAD is checked after the move, a symlink is left at the old path, files that spell out the old absolute path are reported, and `~/.claude/projects` memory follows the repo.
- `clean` reports `node_modules`, `.next`, `dist`, `.venv`, caches and stale archives with size, date and reason. Only regenerable folders in dormant, idle projects are "safe"; `--apply` parks those in `~/Tidy/Trash/Reclaim`. Caches are report-only.
- Jev sees `{filename, extension, size bucket, age, folder name, sibling names}`; never contents. The only host contacted is `api.typesafe.ai`.

## Layout

```
src/config.ts     defaults, config merge, template resolution
src/scan.ts       facts about top-level items
src/rules.ts      deterministic pass: dupes, revisions, screenshots, installers
src/classes.ts    course registry + code matching
src/school.ts     coursework type, assignment id, course inference, destinations
src/learned.ts    corrections that override heuristics
src/questions.ts  what Jev is asked
src/plan.ts       facts -> actions
src/act.ts        journaled moves;  src/undo.ts
src/repos.ts      project folder moves
src/clean.ts      reclaimable storage
src/init.ts       discovery + bootstrap
src/agent.ts      launchd
```

`npm test` runs the fixture suite (no network).
