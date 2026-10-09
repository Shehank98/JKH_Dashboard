/**
 * Ogilvy Orbit Chub mailer: sends the 6-digit sign-in and password reset codes.
 *
 * Setup (about 5 minutes):
 * 1. Sign in to Google with the account that should send the emails, open https://script.google.com and click New project.
 * 2. Replace the code with this file. Click Save.
 * 3. Project Settings (gear icon) > Script properties > Add script property:
 *      MAIL_SECRET = a long random string (the same value goes in APPS_SCRIPT_SECRET on Railway)
 * 4. Deploy > New deployment > type "Web app":
 *      Execute as: Me
 *      Who has access: Anyone
 *    Click Deploy, approve the permissions, and copy the Web app URL (ends in /exec).
 * 5. On Railway, add the variables:
 *      APPS_SCRIPT_URL    = the Web app URL
 *      APPS_SCRIPT_SECRET = the same MAIL_SECRET value
 *
 * After editing this script, use Deploy > Manage deployments > Edit > Version: New version, so the URL stays the same.
 * Daily limits: about 100 emails a day on a free Gmail account, 1,500 on Google Workspace.
 */
function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('MAIL_SECRET');
    if (!secret || req.secret !== secret) return reply({ ok: false, error: 'unauthorised' });
    if (!req.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.to)) return reply({ ok: false, error: 'bad recipient' });
    MailApp.sendEmail({
      to: req.to,
      subject: String(req.subject || 'Your code').slice(0, 200),
      body: String(req.text || ''),
      htmlBody: req.html ? String(req.html) : undefined,
      name: req.name || 'Ogilvy Orbit Chub',
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// Lets you open the /exec URL in a browser to check the deployment is live.
function doGet() {
  return reply({ ok: true, service: 'Ogilvy Orbit Chub mailer', quotaLeftToday: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
