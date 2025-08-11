import { Actor } from 'apify';
import { chromium } from 'playwright';

function prevMonthKey(tz = 'America/Argentina/Buenos_Aires') {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11
  // previous month relative to UTC; close enough, we also pass tz label downstream
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
  let textCandidate = await container.locator('xpath=.//*[contains(text(),"$") or contains(text(),"US$")]').first().innerText().catch(() => '');
  if (!textCandidate) {
    textCandidate = await page.locator('text=/\d[\d\.,]*\s*(US\$|\$)/').first().innerText().catch(() => '');
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
  selectors = {}
} = input;

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

const targetMonth = prevMonthKey(timezone);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const results = []; // { owner, nickname, month, ownerRevenue }

try {
  // 1) Login

await page.goto(loginUrl, { waitUntil: 'networkidle' });

  const emailSel = 'input[type="email"], input[name="email"], input[name="username"]';
  const passSel = 'input[type="password"], input[name="password"]';

if (await page.locator(emailSel).count() > 0) {
  await page.fill(emailSel, email, { timeout: 30000 });
}
if (await page.locator(passSel).count() > 0) {
  await page.fill(passSel, password, { timeout: 30000 });
}


  // click submit
  const submitBtn = 'button:has-text("Ingresar"), button:has-text("Login"), button[type="submit"]';
  await Promise.all([
    page.locator(submitBtn).first().click({ timeout: 30000 }).catch(() => {}),
    page.waitForLoadState('networkidle').catch(() => {})
  ]);
  // some tenants redirect w/o explicit click if already logged in
  await page.waitForTimeout(1500);

  // 2) Go to owners list
  await page.goto(ownersUrl, { waitUntil: 'networkidle' });

  // Scroll to load all owners (handles infinite list)
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

  for (let i = 0; i < ownerCount; i++) {
    const row = ownerRows.nth(i);
    let ownerName = await row.locator(sel.ownerNameCell).first().innerText().catch(() => '');
    ownerName = (ownerName || '').trim();

    // clicking "vista previa" should open a popup
    const [preview] = await Promise.all([
      page.waitForEvent('popup'),
      row.locator(sel.ownerPreviewBtn).first().click({ timeout: 15000 })
    ]);
    await preview.waitForLoadState('domcontentloaded');

    // Make sure we are on "Mis propiedades" tab
    await preview.getByRole('link', { name: /mis propiedades/i }).click({ timeout: 5000 }).catch(() => {});

    // Ensure target month (previous month)
    await ensureMonth(preview, targetMonth, sel).catch(() => {});

    // Iterate properties
    const props = preview.locator(sel.propertyRow);
    const pCount = await props.count();
    for (let p = 0; p < pCount; p++) {
      const propRow = props.nth(p);
      await propRow.click().catch(() => {});

      // nickname
      let nickname = await propRow.locator(sel.propertyNickname).first().innerText().catch(() => '');
      if (!nickname) {
        nickname = (await propRow.innerText().catch(() => '')).split('\n')[0].trim();
      }

      // re-ensure month (some UIs reset on click)
      await ensureMonth(preview, targetMonth, sel).catch(() => {});

      const ownerRevenue = await extractOwnerRevenueOnProperty(preview, sel);

      results.push({ owner: ownerName, nickname, month: targetMonth, ownerRevenue });
    }

    await preview.close().catch(() => {});
  }

  // 3) Send to n8n
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
