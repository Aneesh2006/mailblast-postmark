# MailBlast — Postmark Campaign Sender

A simple, clean web app to send mass marketing emails via Postmark.

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:3000**

## How it works

1. **Configuration** — Enter your Postmark Server API Token, choose the `broadcast` message stream (required for marketing), and set your From name/email.
2. **Recipients** — Paste email addresses (one per line, or comma/semicolon separated). Duplicates are automatically removed.
3. **Campaign Content** — Add a banner image URL, headline, body text, and an optional CTA button with link. Live preview updates as you type.
4. **Review & Send** — See a summary and fire off the campaign. Results show how many sent vs. failed, with details on any failures.

## Notes

- Uses Postmark's `/email/batch` endpoint (up to 500 emails per API call — batching is handled automatically)
- Use the **`broadcast`** message stream for newsletters / marketing
- Your **From Email** must have a verified Sender Signature in Postmark
- Max 10 MB per email, 50 recipients per message
- Bounce data retained for 45 days in Postmark

## Stack

- **Backend**: Node.js + Express
- **Email API**: Postmark `/email/batch`
- **Frontend**: Vanilla HTML/CSS/JS (no dependencies)
