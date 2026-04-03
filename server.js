const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));
if (require.main === module) {
  app.use(express.static(path.join(__dirname, ".")));
}

// ── Simple token-based auth ──
const activeSessions = new Set();

app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.LOGIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password." });
  }
  const token = crypto.randomBytes(32).toString("hex");
  activeSessions.add(token);
  res.json({ token });
});

// Auth middleware — protect all /api/* routes except /api/login
app.use("/api", (req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Read API keys from environment variables (POSTMARK_KEY_<Label>=<token>)
function getApiKeys() {
  const keys = [];
  for (const [envKey, envVal] of Object.entries(process.env)) {
    if (envKey.startsWith("POSTMARK_KEY_") && envVal) {
      const label = envKey.replace("POSTMARK_KEY_", "");
      keys.push({ id: label, name: label, maskedToken: envVal.slice(0, 8) + "..." });
    }
  }
  return keys;
}

function resolveApiToken(keyId) {
  return process.env[`POSTMARK_KEY_${keyId}`] || null;
}

// GET /api/keys — return available API key names (no secrets)
app.get("/api/keys", (req, res) => {
  res.json(getApiKeys());
});

// Build HTML email from campaign content
function buildHtmlEmail(content) {
  const { imageUrl, headline, body, ctaText, ctaUrl } = content;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headline}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:600px;width:100%;">
          
          ${imageUrl ? `
          <tr>
            <td style="padding:0;">
              <img src="${imageUrl}" alt="${headline}" width="600" style="width:100%;max-width:600px;height:auto;display:block;" />
            </td>
          </tr>` : ""}

          <tr>
            <td style="padding:40px 48px 32px;">
              <h1 style="margin:0 0 16px;font-size:28px;font-weight:700;color:#111827;line-height:1.3;">${headline}</h1>
              <div style="font-size:16px;line-height:1.7;color:#374151;white-space:pre-line;">${body}</div>
            </td>
          </tr>

          ${ctaText && ctaUrl ? `
          <tr>
            <td style="padding:0 48px 48px;">
              <a href="${ctaUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 32px;border-radius:8px;letter-spacing:0.3px;">${ctaText}</a>
            </td>
          </tr>` : ""}

          <tr>
            <td style="padding:24px 48px;border-top:1px solid #f3f4f6;">
              <p style="margin:0;font-size:13px;color:#9ca3af;">You're receiving this because you signed up for our updates. <a href="#" style="color:#6b7280;">Unsubscribe</a></p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Build HTML email from raw HTML content (with optional banner image)
function buildHtmlEmailFromRaw(content) {
  const { imageUrl, htmlBody } = content;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);max-width:600px;width:100%;">

          ${imageUrl ? `
          <tr>
            <td style="padding:0;">
              <img src="${imageUrl}" alt="Banner" width="600" style="width:100%;max-width:600px;height:auto;display:block;" />
            </td>
          </tr>` : ""}

          <tr>
            <td style="padding:40px 48px 32px;">
              ${htmlBody}
            </td>
          </tr>

          <tr>
            <td style="padding:24px 48px;border-top:1px solid #f3f4f6;">
              <p style="margin:0;font-size:13px;color:#9ca3af;">You're receiving this because you signed up for our updates. <a href="#" style="color:#6b7280;">Unsubscribe</a></p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Replace {{first_name}} placeholder in a string
function personalize(text, firstName, fallback) {
  if (!text) return text;
  if (firstName) {
    return text.replace(/\{\{first_name\}\}/g, firstName);
  }
  // If no firstName, remove the placeholder entirely (leave text as-is without placeholder)
  return text.replace(/\{\{first_name\}\}/g, fallback || "");
}

// POST /api/send — main send endpoint
app.post("/api/send", async (req, res) => {
  const { apiKeyId, apiToken: rawToken, fromEmail, fromName, subject, emails, content, messageStream, bodyType } = req.body;

  const apiToken = (apiKeyId ? resolveApiToken(apiKeyId) : rawToken) || "";
  if (!apiToken || !fromEmail || !subject || !emails?.length || !content) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const stream = messageStream || "broadcast";

  // Normalize emails: support both string[] and {email, firstName}[] formats
  const normalizedEmails = emails.map((e) => {
    if (typeof e === "string") {
      return { email: e.trim(), firstName: "" };
    }
    return { email: (e.email || "").trim(), firstName: e.firstName || "" };
  });

  // Deduplicate by email
  const seenEmails = new Set();
  const uniqueRecipients = normalizedEmails.filter((r) => {
    if (!r.email || seenEmails.has(r.email)) return false;
    seenEmails.add(r.email);
    return true;
  });

  // Split into batches of 500
  const BATCH_SIZE = 500;
  const results = [];

  for (let i = 0; i < uniqueRecipients.length; i += BATCH_SIZE) {
    const batch = uniqueRecipients.slice(i, i + BATCH_SIZE).map((recipient) => {
      const pSubject = personalize(subject, recipient.firstName, recipient.email);

      let htmlEmail, textBody;

      if (bodyType === 'html') {
        const pHtmlBody = personalize(content.htmlBody, recipient.firstName, recipient.email);
        htmlEmail = buildHtmlEmailFromRaw({ imageUrl: content.imageUrl, htmlBody: pHtmlBody });
        // Strip HTML tags for text fallback
        textBody = pHtmlBody.replace(/<[^>]*>/g, '');
      } else {
        const pHeadline = personalize(content.headline, recipient.firstName, recipient.email);
        const pBody = personalize(content.body, recipient.firstName, recipient.email);
        const personalizedContent = { ...content, headline: pHeadline, body: pBody };
        htmlEmail = buildHtmlEmail(personalizedContent);
        textBody = `${pHeadline}\n\n${pBody}${content.ctaText ? `\n\n${content.ctaText}: ${content.ctaUrl}` : ""}`;
      }

      return {
        From: from,
        To: recipient.email,
        Subject: pSubject,
        HtmlBody: htmlEmail,
        TextBody: textBody,
        MessageStream: stream,
      };
    });

    try {
      const response = await axios.post(
        "https://api.postmarkapp.com/email/batch",
        batch,
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Postmark-Server-Token": apiToken,
          },
        }
      );
      results.push(...response.data);
    } catch (err) {
      const errorData = err.response?.data;
      return res.status(err.response?.status || 500).json({
        error: errorData?.Message || "Postmark API error.",
        details: errorData,
      });
    }
  }

  const sent = results.filter((r) => r.ErrorCode === 0).length;
  const failed = results.filter((r) => r.ErrorCode !== 0);

  res.json({
    total: uniqueRecipients.length,
    sent,
    failed: failed.length,
    failures: failed.slice(0, 20), // return first 20 failures for inspection
  });
});

// POST /api/send-test — send a single test email
app.post("/api/send-test", async (req, res) => {
  const { apiKeyId, apiToken: rawToken, fromEmail, fromName, subject, testTo, content, messageStream, bodyType } = req.body;

  const apiToken = (apiKeyId ? resolveApiToken(apiKeyId) : rawToken) || "";
  if (!apiToken || !fromEmail || !subject || !testTo || !content) {
    return res.status(400).json({ error: "Missing required fields for test email." });
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const stream = messageStream || "broadcast";

  const pSubject = personalize(`[TEST] ${subject}`, "Alex", testTo);

  let htmlBody, textBody;

  if (bodyType === 'html') {
    const pHtmlBody = personalize(content.htmlBody, "Alex", testTo);
    htmlBody = buildHtmlEmailFromRaw({ imageUrl: content.imageUrl, htmlBody: pHtmlBody });
    textBody = pHtmlBody.replace(/<[^>]*>/g, '');
  } else {
    const pHeadline = personalize(content.headline, "Alex", testTo);
    const pBody = personalize(content.body, "Alex", testTo);
    const personalizedContent = { ...content, headline: pHeadline, body: pBody };
    htmlBody = buildHtmlEmail(personalizedContent);
    textBody = `${pHeadline}\n\n${pBody}${content.ctaText ? `\n\n${content.ctaText}: ${content.ctaUrl}` : ""}`;
  }

  try {
    const response = await axios.post(
      "https://api.postmarkapp.com/email/batch",
      [
        {
          From: from,
          To: testTo,
          Subject: pSubject,
          HtmlBody: htmlBody,
          TextBody: textBody,
          MessageStream: stream,
        },
      ],
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": apiToken,
        },
      }
    );

    const result = response.data[0];
    if (result.ErrorCode === 0) {
      res.json({ success: true, message: `Test email sent to ${testTo}` });
    } else {
      res.status(400).json({ error: result.Message || "Postmark rejected the test email." });
    }
  } catch (err) {
    const errorData = err.response?.data;
    res.status(err.response?.status || 500).json({
      error: errorData?.Message || "Failed to send test email.",
      details: errorData,
    });
  }
});

// POST /api/validate — test API token
app.post("/api/validate", async (req, res) => {
  const { apiKeyId, apiToken: rawToken } = req.body;
  const apiToken = (apiKeyId ? resolveApiToken(apiKeyId) : rawToken) || "";
  try {
    await axios.get("https://api.postmarkapp.com/server", {
      headers: {
        Accept: "application/json",
        "X-Postmark-Server-Token": apiToken,
      },
    });
    res.json({ valid: true });
  } catch (err) {
    res.json({ valid: false, message: err.response?.data?.Message || "Invalid token" });
  }
});

// Export the Express app for serverless platforms (e.g., Vercel)
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`MailBlast running on http://localhost:${PORT}`));
}
module.exports = app;