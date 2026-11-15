# Deploying Doughnut

Doughnut is a single Node.js app: one process serves the web pages and the game over WebSockets, and stores accounts and games in MySQL.

## What you need

- **Node.js 18.17 or newer** (20 or 22 recommended).
- **A MySQL or MariaDB database:** an empty database, plus a user with full rights on it. The app creates and upgrades its own tables.
- **An email account for sending** (SMTP), e.g. `no-reply@yourdomain`. It's used for sign-up confirmations and password resets.
- **HTTPS on your domain**, so passwords are encrypted in transit. Most hosts provide a free certificate.
- **One long-running app process with WebSockets allowed.** Don't run several copies (clustering): games live in the process's memory.

## 1. Make the release

On your computer, in the project folder:

```sh
npm ci
npm run package
```

This creates `release/doughnut-<version>.zip`, which contains:

```
app.js           start file
package.json     no dependencies: nothing to install
dist/server.cjs  the server (MySQL, email, WebSockets all built in)
dist/public/     the web pages
models/          the AI model
.env.example     settings template
DEPLOY.md        this file
```

## 2a. cPanel ("Setup Node.js App")

1. **Database:** in *MySQL Databases*, create a database and a user, then add the user to the database with **All Privileges**. Note the names: cPanel prefixes them, e.g. `acct_doughnut`.
2. **Email:** in *Email Accounts*, create `no-reply@yourdomain`. Its *Connect Devices* page shows the SMTP server and port.
3. **Upload:** in *File Manager*, upload the zip to your home folder and **Extract** it. You get a `doughnut` folder.
4. **Create the app:** in *Setup Node.js App*, choose **Create Application**:
   - **Node.js version:** 20 or newer
   - **Application mode:** Production
   - **Application root:** `doughnut`
   - **Application URL:** your domain or subdomain
   - **Application startup file:** `app.js`
5. **Settings:** add these as **Environment variables** on the same page, or copy `.env.example` to `.env` in the `doughnut` folder and fill it in:

   ```
   PUBLIC_URL=https://yourdomain
   DATABASE_URL=mysql://acct_user:password@localhost:3306/acct_doughnut
   SMTP_HOST=mail.yourdomain
   SMTP_PORT=587
   SMTP_USER=no-reply@yourdomain
   SMTP_PASS=...
   MAIL_FROM=Doughnut <no-reply@yourdomain>
   ```

   If the password contains `@ : / ? #`, use the separate `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_DATABASE` settings instead of `DATABASE_URL`.
6. **Start:** click **Start** (or **Restart**). There's no need for "Run NPM Install": there's nothing to install.
7. **HTTPS:** turn on *SSL/TLS Status* → AutoSSL for the domain, if it isn't already.

## 2b. Your own server (VPS)

Unzip to e.g. `/srv/doughnut`, create `/srv/doughnut/.env` from `.env.example`, then run it as a service.

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
2. Upload and extract the new release over the old folder. Your `.env` isn't in the zip, so it's kept.
3. Restart the app. Database changes are applied automatically on start.

Games in progress end when the app restarts, so update when it's quiet.

## Settings reference

| Setting | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | `http://localhost:PORT` | Your site's address, used in email links |
| `PORT` | 3000 | Usually set by the host |
| `DATABASE_URL` | none | `mysql://user:pass@host:3306/db`. Without a database, accounts last only until a restart |
| `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DATABASE` | none | Instead of `DATABASE_URL` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_FROM` | none | Outgoing email. Without them, emails go to the app log |
| `SMTP_SECURE` | true on port 465 | Set `true` for TLS from the start, `false` for STARTTLS |
| `APP_ROOT`, `PUBLIC_DIR`, `MODEL_PATH` | the app folder | Only if you move things around |

Settings in the environment take priority over `.env`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads but says "reconnecting…" | WebSockets are blocked by the host or proxy. Ask the host to allow them, or check the nginx `Upgrade` lines |
| `/health` shows `MemoryRepo` | Wrong database settings, or the user lacks rights. The log shows the MySQL error |
| No confirmation emails | Check the log for SMTP errors. Try port 465 with `SMTP_SECURE=true`. Check spam, SPF and DKIM |
| Email links point to localhost | `PUBLIC_URL` isn't set |
| Login warns about HTTPS | The site is on `http://`. Turn on SSL for the domain |
