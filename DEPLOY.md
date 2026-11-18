# Deploying Doughnut

Doughnut is a Node.js app that runs the game over WebSockets and stores accounts and games in MySQL. Its web pages are plain static files: either your web server serves them from your public folder, or the Node app serves them too.

## What you need

- **Node.js 18.17 or newer** (20 or 22 recommended).
- **A MySQL or MariaDB database:** an empty database, plus a user with full rights on it. The app creates and upgrades its own tables.
- **An email account for sending** (SMTP), e.g. `no-reply@yourdomain`. It's used for sign-up confirmations and password resets.
- **HTTPS on your domain**, so passwords are encrypted in transit. Most hosts provide a free certificate.
- **One long-running app process with WebSockets allowed.** Don't run several copies (clustering): games live in the process's memory.

## Two ways to host it

- **B. Node serves everything (simplest).** Upload one folder; the Node app serves the pages and runs the game at one address. There's no server address to set and no `.htaccess`. Use your domain, or a subdomain such as `play.yourdomain.com` if the domain already has a website. See 2a′.
- **A. Pages in your public folder, game in Node.** Your web server (Apache/cPanel) serves the game's pages from `public_html`, like any website, and the Node app only runs the game. The page connects to the Node app at an address you choose, e.g. `https://yourdomain.com/doughnut-server`.

## 1. Make the release

On your computer, in the project folder:

```sh
npm ci
npm run package                                                          # setup B: just app/
npm run package -- --server-url=https://yourdomain.com/doughnut-server   # setup A: public_html/ + app/
```

This creates `release/doughnut-<version>.zip`, which contains:

```
public_html/      only with --server-url (setup A): the game's pages, for your public folder
  index.html        contains the game server address (<meta name="doughnut-server">)
  doughnut-client.js, styles.css, models/
  .htaccess         security and caching headers for Apache
app/              the Node app (game server); it can also serve the pages (setup B)
  app.js            start file
  package.json      no dependencies: nothing to install
  dist/server.cjs   the server (MySQL, email, WebSockets all built in)
  models/           the AI model
  .env.example      settings template
DEPLOY.md         this file
```

If the game server's address changes later, edit the `content="…"` of `<meta name="doughnut-server">` in `public_html/index.html`. You don't need to rebuild.

## 2a. cPanel, setup A (pages in public_html, game in "Setup Node.js App")

1. **Database:** in *MySQL Databases*, create a database and a user, then add the user to the database with **All Privileges**. Note the names: cPanel prefixes them, e.g. `acct_doughnut`.
2. **Email:** in *Email Accounts*, create `no-reply@yourdomain`. Its *Connect Devices* page shows the SMTP server and port.
3. **Pages:** in *File Manager*, upload the zip and **Extract** it outside `public_html`, e.g. in your home folder.
   - Copy everything inside `doughnut/public_html/` into `public_html/`. If your site already has an `index.html`, use a subfolder such as `public_html/doughnut/` instead.
   - Turn on *Show Hidden Files* so `.htaccess` comes along.
4. **Game server:** in *Setup Node.js App*, choose **Create Application**:
   - **Node.js version:** 20 or newer
   - **Application mode:** Production
   - **Application root:** the extracted `doughnut/app` folder
   - **Application URL:** your domain + `doughnut-server`. This must match the `--server-url` you packaged with.
   - **Application startup file:** `app.js`
5. **Settings:** add these as **Environment variables** on the same page, or copy `.env.example` to `.env` in the app folder and fill it in:

   ```
   PUBLIC_URL=https://yourdomain.com          (where players open the game: the page in public_html)
   DATABASE_URL=mysql://acct_user:password@localhost:3306/acct_doughnut
   SMTP_HOST=mail.yourdomain.com
   SMTP_PORT=587
   SMTP_USER=no-reply@yourdomain.com
   SMTP_PASS=...
   MAIL_FROM=Doughnut <no-reply@yourdomain.com>
   ```

   - If the pages are in a subfolder, include it: `PUBLIC_URL=https://yourdomain.com/doughnut`.
   - If the password contains `@ : / ? #`, use the separate `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_DATABASE` settings instead of `DATABASE_URL`.
6. **Start:** click **Start** (or **Restart**). There's no need for "Run NPM Install": there's nothing to install.
7. **HTTPS:** turn on *SSL/TLS Status* → AutoSSL for the domain, if it isn't already.

**Check:**
- Opening `https://yourdomain.com/doughnut-server/health` should show `{"ok":true,…,"store":"MySqlRepo"}`.
- Opening `https://yourdomain.com/` should show the game. Its pages connect to the game server for play, sign-in and the leaderboard.

**Game server on a different address** (another subdomain such as `game.yourdomain.com`, or a different port): that works too. Package with that address. The site in `PUBLIC_URL` is always allowed to connect; list any other sites that host the pages in `ALLOWED_ORIGINS`, comma-separated. Pages from any other website are refused, which stops other sites from connecting players to your game server.

## 2a′. cPanel, setup B (Node serves everything; simplest)

Package with plain `npm run package`, then follow 2a with these differences:
- **Step 3:** upload and extract the zip, but there's nothing to copy into `public_html`.
- **Step 4:** set **Application root** to `doughnut/app`, and **Application URL** to the domain or subdomain players open (e.g. `play.yourdomain.com`, which you can create first under *Domains*).
- **Step 5:** set `PUBLIC_URL` to that same address, e.g. `https://play.yourdomain.com`.

To check, open `https://play.yourdomain.com/health`, then `https://play.yourdomain.com/`.

## 2b. Your own server (VPS)

Copy the release's `app/` folder to e.g. `/srv/doughnut`, create `/srv/doughnut/.env` from `.env.example`, then run it as a service. Either let it serve the pages (setup B, below), or serve `public_html/` with nginx and proxy only the game server's path to Node.

`/etc/systemd/system/doughnut.service`:

```ini
[Unit]
Description=Doughnut card game
After=network.target mysql.service

[Service]
WorkingDirectory=/srv/doughnut
ExecStart=/usr/bin/node app.js
Environment=PORT=3000
Restart=on-failure
User=doughnut

[Install]
WantedBy=multi-user.target
```

Then run `systemctl enable --now doughnut`, and put nginx in front with HTTPS (e.g. via certbot). The `Upgrade` lines are what let WebSockets through:

```nginx
server {
  server_name doughnut.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
  }
}
```

## 3. Check it works

- **Health:** `https://yourdomain/health` should show `{"ok":true,"version":"…","store":"MySqlRepo",…}`. If `store` is `MemoryRepo`, the app couldn't reach MySQL; the log says why.
- **Sign up:** sign up with your own email. The confirmation email should arrive. If it lands in spam, ask your host to set up **SPF and DKIM** for your domain (cPanel: *Email Deliverability*).
- **Play:** open a private table in two browsers (say, your phone and computer) and play a hand.

## Updating

1. Back up the database. cPanel: *phpMyAdmin* → Export.
2. Upload and extract the new release. Replace the app folder's contents (your `.env` isn't in the zip, so it's kept), and copy the new `public_html/` files over the old ones (setup A).
3. Restart the app. Database changes are applied automatically on start. Players' browsers pick up the new pages straight away: `index.html` isn't cached, and the other files are linked by version.

Games in progress end when the app restarts, so update when it's quiet.

## Settings reference

| Setting | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:PORT` | The address players open (the page), used in email links; that site may always connect |
| `ALLOWED_ORIGINS` | none | More websites allowed to connect, comma-separated (if the pages are hosted on several) |
| `PORT` | 3000 | Usually set by the host |
| `DATABASE_URL` | none | `mysql://user:pass@host:3306/db`. Without a database, accounts last only until a restart |
| `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DATABASE` | none | Instead of `DATABASE_URL` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | none | Outgoing email. Without them, emails go to the app log |
| `SMTP_SECURE` | true on port 465 | Set `true` for TLS from the start, `false` for STARTTLS |
| `BASE_PATH` | none (Passenger's `PASSENGER_BASE_URI` if set) | Only if the app is at a path such as `yourdomain.com/doughnut` **and** the page loads without its styling or script: set `BASE_PATH=/doughnut` |
| `APP_ROOT`, `PUBLIC_DIR`, `MODEL_PATH` | the app folder | Only if you move things around |

Settings in the environment take priority over `.env`.

## Troubleshooting

First, open `/health` on the app's address. It shows the app version, the Node.js version (`node`), whether the pages were found (`pages`), and the database (`store`). Also look at the app's log; in cPanel, `stderr.log` in the app folder, or the log link in *Setup Node.js App*.

| Symptom | Likely cause |
|---|---|
| A page saying the app "could not be started", or a log line "Doughnut needs Node.js 18.17 or newer" | The app is set to an old Node.js. In *Setup Node.js App*, choose 20 or newer, then restart |
| Plain, unstyled page, or "Still here? The game's script didn't load" | The app is at a path (e.g. `/doughnut`) and the host removes it before it reaches Node. Set `BASE_PATH=/doughnut` and restart. If `/health` shows `"pages":false`, the `dist/public` folder wasn't uploaded |
| A red "Something went wrong" box | An error in the game itself. Please send the text in the box |
| "Can't reach the game server" banner | The page can't open the game connection: see the next row |
| Page loads but says "reconnecting…" | Check, in order: the server address in `index.html` (`<meta name="doughnut-server">`) matches the Node app's URL; `PUBLIC_URL` is the address of the page; WebSockets aren't blocked by the host or proxy (for nginx, the `Upgrade` lines) |
| Leaderboard never appears | Same causes as "reconnecting…" |
| `/health` shows `MemoryRepo` | Wrong database settings, or the user lacks rights. The log shows the MySQL error |
| No confirmation emails | Open `/health` and look at `"email"`: `"mode":"log"` means SMTP isn't set (emails only go to the log); `"check":"failed"` / `"lastError"` give the mail server's reason with a hint; `"lastSentAt"` means it was sent, so check spam, then SPF and DKIM (cPanel: *Email Deliverability*). The app log has a line for every email sent, failed or skipped (at most one per address per minute). |
| Email links point to localhost | `PUBLIC_URL` isn't set |
| Login warns about HTTPS | The site is on `http://`. Turn on SSL for the domain |
