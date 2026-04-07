# QuestBot Setup Guide

A Discord bot that verifies NowPayments donations and automatically provisions
FTP/SFTP slots on your Ultra.cc server for donors.

---

## Files

| File | Purpose |
|------|---------|
| `bot.py` | The Discord bot (runs on Koyeb) |
| `proftpd_donors.conf` | ProFTPD config snippet for your server |
| `quota_check.py` | Quota enforcement script (runs as cron on your server) |
| `requirements.txt` | Python dependencies |

---

## Step 1 — Create your Discord Bot

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "QuestBot" (or whatever)
3. Go to **Bot** tab → click **Add Bot**
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent**
5. Click **Reset Token** → copy the token (you'll need this)
6. The bot is DM-only so you don't need to add it to a server —
   users just DM it directly after finding it via your donation page

---

## Step 2 — Get your NowPayments SECRET API Key

1. Log into https://nowpayments.io
2. Go to **Settings** → **API Keys**
3. Copy the **Secret key** (NOT the public donation link key)
   - The public key is what's in your donation page URL — that's fine public
   - The secret key is what the bot uses to verify payments via the API

---

## Step 3 — Set up the server side (SSH into botanic.usbx.me)

```bash
# Create the folder structure
mkdir -p ~/donor_slots
mkdir -p ~/.config/proftpd/quotas

# Upload quota_check.py to your server
# (do this from your Mac terminal)
scp quota_check.py jepp@botanic.usbx.me:~/quota_check.py

# Set up the cron job for quota enforcement (runs every 15 min)
crontab -e
# Add this line:
# */15 * * * * python3 /home/jepp/quota_check.py >> /home/jepp/.config/proftpd/quota.log 2>&1
```

### ProFTPD virtual users config

This is the trickiest part on Ultra.cc. You have two options:

**Option A — Ask Ultra.cc support:**
> "Hi, I'd like to add virtual FTP users chrooted to subdirectories of
> ~/donor_slots, using an AuthUserFile at ~/.config/proftpd/passwd.
> Can you help me include a custom proftpd config?"

They're usually helpful. Attach `proftpd_donors.conf`.

**Option B — Check if you can self-include:**
```bash
# See if there's a user-includeable config dir
ls /etc/proftpd/conf.d/
# Or check what's in the main config
grep -i "include" /etc/proftpd/proftpd.conf
```

If there's a `conf.d/` directory you can write to:
```bash
cp proftpd_donors.conf /etc/proftpd/conf.d/donors.conf
```

Then test:
```bash
proftpd --configtest
```

---

## Step 4 — Deploy on Koyeb

1. Go to https://koyeb.com → create a free account
2. Create a new **Service** → choose **GitHub** or **Docker**

### If using GitHub:
1. Push this project to a GitHub repo
2. In Koyeb: connect your GitHub repo
3. Set **Run command**: `python bot.py`
4. Set **Build command**: `pip install -r requirements.txt`

### Environment Variables (add these in Koyeb → Service → Environment):

| Variable | Value |
|----------|-------|
| `DISCORD_TOKEN` | Your bot token from Step 1 |
| `NP_API_KEY` | Your NowPayments secret key from Step 2 |
| `SSH_HOST` | `botanic.usbx.me` |
| `SSH_PORT` | `22` |
| `SSH_USER` | `jepp` |
| `SSH_PASS` | `bbyNP4b7Vbff` (your server password) |
| `MIN_USD` | `11` |
| `SLOT_DAYS` | `30` |
| `WARN_DAYS_BEFORE` | `3` |
| `QUOTA_GB` | `500` |

> ⚠️ **Never commit these values to GitHub.** Always use Koyeb environment variables.

---

## Step 5 — How donors use it

1. Donor goes to your NowPayments donation page and pays $11+ USDT
2. They get a **Payment ID** in their NowPayments receipt email
3. They DM your Discord bot — any message triggers the welcome instructions
4. They paste their Payment ID
5. Bot verifies it against NowPayments API
6. If confirmed: bot SSHes into your server, creates their slot, DMs them credentials
7. After 30 days: bot warns them 3 days before expiry, then deletes the slot

---

## How the slot works for donors

Each donor gets:
- FTP access on port 21 to `botanic.usbx.me`
- SFTP access on port 22 (same credentials)
- A chrooted directory — they can ONLY see their own folder
- Inside their folder: a symlink called `Quest_Games` pointing to your Quest Games library
- Read-only access (no upload, delete, rename)
- 500 GB download quota (enforced by `quota_check.py`)

Their rclone command to sync:
```
rclone copy questarchive:Quest_Games /local/folder --progress
```

---

## Troubleshooting

**Bot doesn't respond to DMs**
- Make sure Message Content Intent is enabled in Discord dev portal
- Make sure the bot is running (check Koyeb logs)

**Payment verification fails**
- Double-check your NowPayments SECRET key (not the public one)
- Check if payment status is "finished" — NowPayments crypto payments can take 10-30 min to confirm

**ftpasswd not found on server**
- ProFTPD ships with `ftpasswd`. Check: `which ftpasswd`
- If missing: `sudo apt install proftpd-basic` (ask Ultra.cc support)

**Quota not enforcing**
- Check cron is running: `crontab -l`
- Check quota log: `tail -f ~/.config/proftpd/quota.log`
- Check transfer log exists: `ls ~/.config/proftpd/transfer.log`
