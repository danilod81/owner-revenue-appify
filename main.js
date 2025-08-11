import { Actor, log, KeyValueStore } from 'apify';
import { chromium } from 'playwright';

log.setLevel(log.LEVELS.INFO); // set DEBUG if you want super-verbose logs

function prevMonthKey(tz = 'America/Argentina/Buenos_Aires') {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const yy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

async function ensureMonth(page, targetYYYYMM, sel) {
  const parseHeader = async () => {
    const txt = await page.locator(sel.monthHeader).first().innerText().catch(() => '');
    if (!txt) return null;
    const lower = txt.toLowerCase();
    const yearMatch = lower.match(/20\d{2}/)?.[0];
    const months = {
      'ene':1,'enero':1,'feb':2,'febrero':2,'mar ':3,'marzo':3,'abr':4,'abril':4,
      'may':5,'mayo':5,'jun':6,'junio':6,'jul':7,'julio':7,'ago':8,'agosto':8,
      'sept':9,'set':9,'septiembre':9,'sep':9,'oct':10,'octubre':10,'nov':11,'noviembre':11,
      'dic':12,'diciembre':12,'jan':1,'january':1,'february':2,'march':3,'april':4,
      'june':6,'july':7,'aug':8,'august':8,'september':9,'october':10,'november':11,'december':12
    };
    let mm = null;
    for (const [k,v] of Object.entries(months)) {
      if (lower.includes(k)) { mm = String(v).padStart(2,'0'); break; }
    }
    if (!yearMatch || !mm) return null;
    return `${yearMatch}-${mm}`;
  };
  for (let i = 0; i < 18; i++) {
    const cur = await parseHeader();
    if (cur === targetYYYYMM) return true;
    await Promise.all([
      page.locator(sel.prevMonthBtn).first().click({ timeout: 8000 }).catch(() => {}),
      page.waitForLoadState('networkidle').catch(() => {}),
    ]);
    await page.waitForTimeout(300);
  }
  return false;
}

function parseMoneyToNumber(text) {
  if (!text) return 0;
  const cleaned = text.replace(/\s/g,'');
  const core = cleaned.replace(/[^0-9,\.\-]/g,'');
  if (core.length === 0) return 0;
  if (core.includes(',') && core.includes('.')) {
    return Number(core.replace(/\./g,'').replace(',','.')) || 0;
  }
  if (core.includes(',') && !core.includes('.')) {
    return Number(core.replace(',','.')) || 0;
  }
  return Number(core) || 0;
}

async function extractOwnerRevenueOnProperty(page, sel) {
  const label = page.locator(sel.ownerRevenueLabel).first();
  if (await label.count() === 0) return 0;
  const container = label.locator('xpath=..');
  let textCandidate = await container
    .locator('xpath=.//*[contains(text(),"$") or contains(text(),"US$")]')
    .first()
    .innerText()
    .catch(() => '');
  if (!textCandidate) {
    textCandidate = await page
      .locator('text=/\\d[\\d\\.,]*\\s*(US\\$|\\$)/')
      .first()
      .innerText()
      .catch(() => '');
  }
  return parseMoneyToNumber(textCandidate);
}

await Actor.init();
const input = await Actor.getInput();
const {
  loginUrl,
  ownersUrl,
  email,
  password,
  n8nWebhookUrl,
  timezone = 'America/Argentina/Buenos_Aires',
  selectors = {},
  useGoogleSSO = false,
  pauseFor2FASeconds = 120,
} = input || {};

if (!loginUrl || !ownersUrl || !email || !password || !n8nWebhookUrl) {
  log.error('Missing required input(s). Provided flags — loginUrl:%s ownersUrl:%s email:%s n8n:%s',
            !!loginUrl, !!ownersUrl, !!email, !!n8nWebhookUrl);
  await Actor.exit(); process.exit(1);
}

const sel = {
  ownerRow: "xpath=//tr[.//button[contains(translate(., 'VISTA PREVIA', 'vista previa'),'vista previa')]]",
  ownerPreviewBtn: "xpath=.//button[contains(translate(., 'VISTA PREVIA', 'vista previa'),'vista previa')]",
  ownerNameCell: "xpath=.//td[1]",
  propertyRow: "css=[data-testid='property-row'], .property-card",
  propertyNickname: "css=.nickname, [data-testid='nickname']",
  monthHeader: "css=[data-testid='month-label'], header .month-label, .calendar-header",
  prevMonthBtn: "css=button[aria-label*='Anterior'], button[aria-label*='Previous'], .btn-prev",
  ownerRevenueLabel: "text=Ingresos estimados del propietario",
  ...selectors,
};

// ---- session reuse via KV store ----
const sessionStore = await KeyValueStore.open('SESSION');
const savedState = await sessionStore.getValue('storageState');

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext(savedState ? { storageState: savedState } : undefined);
const page = await ctx.newPage();

const results = []; // { owner, nickname, month, ownerRevenue }
const targetMonth = prevMonthKey(timezone);
log.info('Starting. Target month: %s', targetMonth);

async function doPasswordLogin() {
  log.info('Password login at %s', loginUrl);
  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  const emailSel = 'input[type="email"], input[name="email"], input[name="username"]';
  const passSel  = 'input[type="password"], input[name="password"]';
  if (await page.locator(emailSel).count() > 0) {
    await page.fill(emailSel, email, { timeout: 30000 });
  }
  if (await page.locator(passSel).count() > 0) {
    await page.fill(passSel, password, { timeout: 30000 });
  }
  const submitBtn = 'button:has-text("Ingresar"), button:has-text("Login"), button[type="submit"]';
  await Promise.all([
    page.locator(submitBtn).first().click({ timeout: 30000 }).catch(() => {}),
    page.waitForLoadState('networkidle').catch(() => {}),
  ]);
  await page.waitForTimeout(1500);
}

async function doGoogleLogin() {
  log.info('Google SSO login at %s', loginUrl);
  await page.goto(loginUrl, { waitUntil: 'networkidle' });

  // Click "Continue with Google" button or link if present
  const googleBtn = page.getByRole('button', { name: /google|continuar con google|continue with google/i });
  if (await googleBtn.isVisible().catch(() => false)) {
    await googleBtn.click().catch(() => {});
  } else {
    // fallback: link
    await page.locator('text=/google/i').first().click({ timeout: 15000 }).catch(() => {});
  }

  // Google auth flow
  await page.waitForURL(/accounts\.google\.com/i, { timeout: 30000 });

  // email
  await page.locator('input[type="email"]').fill(email, { timeout: 30000 });
  await page.keyboard.press('Enter');

  // password
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.locator('input[type="password"]').fill(password, { timeout: 30000 });
  await page.keyboard.press('Enter');

  // give time for 2FA approval if enforced
  if (pauseFor2FASeconds > 0) {
    log.info('Waiting up to %ds for Google 2FA approval…', pauseFor2FASeconds);
    await page.waitForNavigation({ timeout: pauseFor2FASeconds * 1000 }).catch(() => {});
  }

  // back to Guesty
  await page.waitForURL(/app\.guesty\.com/i, { timeout: 90000 });
  log.info('Google SSO completed.');
}

try {
  if (!savedState) {
    if (useGoogleSSO) await doGoogleLogin();
    else await doPasswordLogin();

    // save session for future runs
    const state = await ctx.storageState();
    await sessionStore.setValue('storageState', state);
    log.info('Saved session state for reuse.');
  } else {
    log.info('Loaded saved session state.');
  }

  // Go to owners list
  log.info('Goto owners: %s', ownersUrl);
  await page.goto(ownersUrl, { waitUntil: 'networkidle' });

  // simple guard: if we got bounced to login again, ask to re-login next run
  const url = page.url();
  if (/accounts\.google\.com|login/i.test(url)) {
    log.warning('Session expired (redirected to login). Re-run with useGoogleSSO=true to refresh.');
    await Actor.exit(); process.exit(1);
  }

  // Scroll to load all owners (infinite lists)
  let prevHeight = 0;
  for (let s = 0; s < 20; s++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(400);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === prevHeight) break;
    prevHeight = h;
  }

  const ownerRows = page.locator(sel.ownerRow);
  const ownerCount = await ownerRows.count();
  log.info('Found %d owners.', ownerCount);

  for (let i = 0; i < ownerCount; i++) {
    const row = ownerRows.nth(i);
    let ownerName = await row.locator(sel.ownerNameCell).first().innerText().catch(() => '');
    ownerName = (ownerName || '').trim();

    // Some tenants open preview in a popup, others in same tab.
    // Try popup first, fallback to same-tab.
    let preview;
    const click = row.locator(sel.ownerPreviewBtn).first();
    const popupPromise = page.waitForEvent('popup', { timeout: 6000 }).catch(() => null);
    await click.click({ timeout: 15000 }).catch(() => {});
    const maybePopup = await popupPromise;
    preview = maybePopup || page;
    await preview.waitForLoadState('domcontentloaded');

    // Make sure we are on "Mis propiedades"
    await preview.getByRole('link', { name: /mis propiedades/i }).click({ timeout: 5000 }).catch(() => {});

    // Ensure previous month
    await ensureMonth(preview, targetMonth, sel).catch(() => {});

    // Iterate properties
    const props = preview.locator(sel.propertyRow);
    const pCount = await props.count();
    log.info('Owner "%s": %d properties.', ownerName, pCount);

    for (let p = 0; p < pCount; p++) {
      const propRow = props.nth(p);
      await propRow.click().catch(() => {});

      let nickname = await propRow.locator(sel.propertyNickname).first().innerText().catch(() => '');
      if (!nickname) nickname = (await propRow.innerText().catch(() => '')).split('\n')[0].trim();

      await ensureMonth(preview, targetMonth, sel).catch(() => {});
      const ownerRevenue = await extractOwnerRevenueOnProperty(preview, sel);

      results.push({ owner: ownerName, nickname, month: targetMonth, ownerRevenue });
    }

    if (maybePopup) await preview.close().catch(() => {});
  }

  // Send to n8n
  log.info('Posting %d items to n8n…', results.length);
  await page.request.post(n8nWebhookUrl, {
    data: { items: results },
    headers: { 'content-type': 'application/json' },
    timeout: 60000
  });

  console.log(JSON.stringify({ sent: results.length, sample: results.slice(0, 3) }, null, 2));
} finally {
  await browser.close();
  await Actor.exit();
}
