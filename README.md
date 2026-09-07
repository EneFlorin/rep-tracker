# Rep Tracker

A shared workout tracker for you and your friends: everyone picks a name on
first visit (no password), logs reps against shared workouts, and a group
leaderboard ranks yesterday/this week/this month. Whoever's name is listed in
`data/admins.txt` can add, rename, or delete workouts; everyone else can only
log their own reps.

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Edit `data/admins.txt` to control who gets
admin rights (one name per line, case-insensitive).

## Put it online (so it works over mobile data, not just your Wi-Fi)

This needs a real host, since it's a live server, not a static page.
[Render](https://render.com) has a free tier that works well for this:

1. **Create a GitHub repo** (github.com &rarr; New repository) and push this
   project to it:
   ```bash
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```
2. **Sign up at [render.com](https://render.com)** (free) and connect your
   GitHub account.
3. **New + &rarr; Web Service**, pick this repo. Render should auto-detect the
   settings from `render.yaml`; otherwise set:
   - Build command: `npm install`
   - Start command: `npm start`
4. Under **Environment**, set `ADMIN_NAMES` to your own name (comma-separate
   for more than one admin). This is the deployed equivalent of editing
   `data/admins.txt` directly &mdash; useful since you won't have easy file
   access on the live server.
5. Deploy. Render gives you a public URL like
   `https://rep-tracker.onrender.com` &mdash; that's the link to share with
   friends, works from any network including mobile data.

### A real limitation to know about

Render's **free** tier has no persistent disk: the `data/` folder (your
workouts, logs, to-dos) resets whenever the service redeploys or spins back up
after being idle. Fine for kicking the tires; if you want data that reliably
sticks around, the options are a small paid disk (~$7/mo on Render's Starter
plan) or swapping the storage layer to a free hosted database &mdash; ask if
you want help with either once you know this is worth keeping.
